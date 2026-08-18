/**
 * persist-tool-calls — runtime glue between MCP server's in-memory
 * `sessionStats` and the on-disk `tool_calls` SessionDB table.
 *
 * Why this module exists
 * ──────────────────────
 * Commit 4742160 (May 2 16:58) added the SessionDB write path so the
 * statusline counters survived `npm update -g context-mode` and
 * `claude --continue`. Commit b392c2f (May 2 21:43) — the concurrency
 * refactor — silently dropped that wiring as collateral. Same-session
 * `/ctx-upgrade` flips the statusline back to `0 calls / $0.00`
 * because the new PID starts with an empty `sessionStats` and never
 * looks at the table the old PID was writing to.
 *
 * This module re-introduces the write path AND adds the read-side
 * restore that 4742160 never shipped — both pure helpers so the
 * server.ts wiring is a one-liner and the unit tests don't need to
 * boot the MCP server.
 */

import { existsSync } from "node:fs";
import { SessionDB } from "./db.js";
import { detectReuse, reuseDetectorEnabled } from "./reuse-detector.js";
import type { ReuseCandidateEvent } from "./reuse-detector.js";
import { writeReuseVerdict } from "./retrieval-marker.js";
import type { ReuseVerdict } from "./retrieval-marker.js";

/**
 * Shape returned by {@link restoreSessionStats}. Subset of the in-memory
 * `sessionStats` object the MCP server keeps — only the fields that can
 * be recovered from SessionDB.
 */
export interface RestoredSessionStats {
  /** Per-tool call counts. */
  calls: Record<string, number>;
  /** Per-tool returned bytes. */
  bytesReturned: Record<string, number>;
  /**
   * Epoch-ms for `session_meta.started_at` of the latest session, so the
   * statusline `uptime_ms` reflects the original session start instead of
   * resetting to `Date.now()` on every PID change.
   */
  sessionStart: number;
}

/**
 * Increment the persistent tool-call counter for `toolName` under whatever
 * session_id `session_meta` currently treats as the most recent. This is
 * called from {@link trackResponse} on every tool response and must be
 * cheap, non-throwing, and best-effort — a stats failure must never break
 * the MCP tool call.
 */
export function persistToolCallCounter(
  sessionDbPath: string,
  toolName: string,
  bytes: number,
): void {
  try {
    if (!existsSync(sessionDbPath)) return;
    const sdb = new SessionDB({ dbPath: sessionDbPath });
    try {
      const sid = sdb.getLatestSessionId();
      if (!sid) return;
      sdb.incrementToolCall(sid, toolName, bytes);
    } finally {
      sdb.close();
    }
  } catch {
    // Best-effort: counter must never throw and break the parent tool call.
  }
}

/**
 * Read the latest session's tool-call totals back out of SessionDB so the
 * MCP server can hydrate its in-memory `sessionStats` on startup. Returns
 * `null` when the DB is missing or empty so the caller can keep the
 * default zero-state without branching twice.
 *
 * Used during MCP server boot (BEFORE the heartbeat fires) so the
 * statusline doesn't briefly flash `0 calls / $0.00` after upgrade.
 */
export function restoreSessionStats(
  sessionDbPath: string,
): RestoredSessionStats | null {
  try {
    if (!existsSync(sessionDbPath)) return null;
    const sdb = new SessionDB({ dbPath: sessionDbPath });
    try {
      const sid = sdb.getLatestSessionId();
      if (!sid) return null;

      const stats = sdb.getToolCallStats(sid);
      const calls: Record<string, number> = {};
      const bytesReturned: Record<string, number> = {};
      for (const [tool, row] of Object.entries(stats.byTool)) {
        calls[tool] = row.calls;
        bytesReturned[tool] = row.bytesReturned;
      }

      // started_at is "YYYY-MM-DD HH:MM:SS" in UTC (SQLite datetime() default);
      // append "Z" so Date.parse interprets it as UTC, matching how the
      // session was actually persisted.
      let sessionStart = Date.now();
      try {
        const meta = sdb.getSessionStats(sid);
        if (meta?.started_at) {
          const parsed = Date.parse(`${meta.started_at}Z`);
          if (Number.isFinite(parsed) && parsed > 0) sessionStart = parsed;
        }
      } catch {
        // best-effort — keep `Date.now()` fallback
      }

      // Skip empty restores so callers can `if (restored)` and not stomp
      // their already-zero default with another zero.
      if (
        Object.keys(calls).length === 0 &&
        Object.keys(bytesReturned).length === 0
      ) {
        // Still useful to return sessionStart so uptime_ms doesn't reset
        // even when no tool calls were made — but only if we found a session.
        return { calls, bytesReturned, sessionStart };
      }

      return { calls, bytesReturned, sessionStart };
    } finally {
      sdb.close();
    }
  } catch {
    return null;
  }
}

/**
 * C-02 — recompute the reuse verdict for the latest session and publish it to
 * the tmp marker the gateway reads.
 *
 * The detector's input is the session event stream, which only the hook side
 * ever writes; the gateway that must act on the verdict lives in the MCP
 * server process. So the verdict travels the same way the retrieval byte
 * count travels, through a tmp file keyed by the session DB basename — except
 * in the opposite direction (hook → server) and as an overwritten state
 * rather than an appended ledger. See `retrieval-marker.ts`.
 *
 * Call this from the PostToolUse hook after the events for a fire are
 * inserted. Cheap enough for that path: one indexed read of the latest
 * session's events, capped, then one small write. Best-effort throughout —
 * a failure here means "no verdict", which means "do not bypass".
 *
 * Returns the published verdict, or `null` when nothing was published
 * (detector off, no DB, no session, no events).
 */
export function persistReuseVerdict(
  sessionDbPath: string,
  opts?: { tmpDir?: string; limit?: number },
): ReuseVerdict | null {
  if (!reuseDetectorEnabled()) return null;
  try {
    if (!existsSync(sessionDbPath)) return null;
    const sdb = new SessionDB({ dbPath: sessionDbPath });
    try {
      const sid = sdb.getLatestSessionId();
      if (!sid) return null;

      const rows = sdb.getEvents(sid, { limit: opts?.limit ?? 4000 });
      if (!rows || rows.length === 0) return null;

      const events: ReuseCandidateEvent[] = rows.map((r) => ({
        id: r.id,
        type: r.type,
        data: r.data,
        created_at: r.created_at,
        project_dir: r.project_dir,
        bytes_returned: r.bytes_returned,
      }));

      const report = detectReuse(events);
      if (report.coveredSources === 0) return null;

      const verdict: ReuseVerdict = {
        covered: report.coveredSources,
        returned: report.returnedSources,
        ratio: report.ratio,
        at: Date.now(),
      };
      writeReuseVerdict(sessionDbPath, verdict, opts?.tmpDir);
      return verdict;
    } finally {
      sdb.close();
    }
  } catch {
    // Best-effort: a stats failure must never break the hook that called it.
    return null;
  }
}
