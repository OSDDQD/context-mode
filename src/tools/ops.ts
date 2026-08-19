/**
 * `ctx_stats` — the session's context-consumption report.
 *
 * The operational tools were not moved as a group. Wave 2's rule was the same
 * one wave 1 used: a region travels only if the fork has actually rewritten
 * it, because a region upstream still owns turns into a delete/modify conflict
 * on every `sync-upstream` the moment it changes files. Against
 * `merge-base(HEAD, upstream/next)` the fork has five separate hunks inside
 * `ctx_stats` (the real-bytes fold, the cross-session project_dir lookup, the
 * semantic report line), so it moved. `ctx_doctor`,
 * `ctx_upgrade` and `ctx_insight` have none at all and stayed; `ctx_purge` has
 * a single four-line hunk, which does not pay for the move.
 *
 * `createMinimalDb` came along because nothing else calls it.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import {
  AnalyticsEngine,
  formatReport,
  getConversationStats,
  getContentBytesAllSessions,
  getLifetimeStats,
  getMultiAdapterLifetimeStats,
  getRealBytesStats,
} from "../session/analytics.js";
import { hashProjectDirCanonical, resolveSessionDbPath } from "../session/db.js";
import { loadDatabase } from "../db-base.js";
import { contentStoreUsage } from "../store.js";
import type { OpsToolDeps } from "./shared/deps.js";
import { sessionStats } from "./shared/state.js";

/** Register `ctx_stats` on the server carried by `deps`. */
export function registerOpsTools(deps: OpsToolDeps): void {
  const {
    getStore, getProjectDir, getSessionDir, getStorePath, trackResponse,
    VERSION, latestVersion, semanticIndexReport,
  } = deps;

  // `detectedAdapter` and `rollUpStaleStatsFiles` stay on OpsToolDeps but are
  // no longer read here. Both existed for the Pi byte-accounting patch, which
  // replaced the events × 256 lifetime heuristic with the real bytes recorded
  // in stats-*.json — and rolled up stale stats files on the way past. That
  // path was gated on the Pi adapter and left with it. Whether the rollup
  // should now run for every host is a product question, not a compile one:
  // it never ran for Claude Code or Codex, so not calling it preserves exactly
  // the behaviour those two have today.

  // ─────────────────────────────────────────────────────────
  // Tool: stats
  // ─────────────────────────────────────────────────────────

  /**
   * Create a minimal in-memory DB adapter for when the session DB is unavailable.
   * All queries return empty results so AnalyticsEngine.queryAll() still works.
   */
  function createMinimalDb(): import("../session/analytics.js").DatabaseAdapter {
    return {
      prepare: () => ({
        run: () => undefined,
        get: (..._args: unknown[]) => ({ cnt: 0, compact_count: 0, minutes: null, rate: 0, avg: 0, outcome: "exploratory" }),
        all: () => [],
      }),
    };
  }

  deps.server.registerTool(
    "ctx_stats",
    {
      title: "Session Statistics",
      // #846: read-only diagnostics. Was cancelled by Codex when unannotated.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "Returns context consumption statistics for the current session. " +
        "Shows total bytes returned to context, breakdown by tool, call counts, " +
        "estimated token usage, and context savings ratio.",
      inputSchema: z.object({}),
    },
    async () => {
      // ONE call, ONE source — AnalyticsEngine.queryAll()
      let text: string;
      try {
        const projectDir = getProjectDir();
        // Canonical hash + migration-aware path. The downstream
        // getConversationStats / getRealBytesStats reconstruct the DB
        // filename from worktreeHash; pass the SAME canonical hash that
        // resolveSessionDbPath used so they hit the same file.
        const dbHash = hashProjectDirCanonical(projectDir);
        const sessionDbPath = resolveSessionDbPath({
          projectDir,
          sessionsDir: getSessionDir(),
        });

        if (existsSync(sessionDbPath)) {
          const Database = loadDatabase();
          const sdb = new Database(sessionDbPath, { readonly: true });
          try {
            const engine = new AnalyticsEngine(sdb);
            const report = engine.queryAll(sessionStats);
            // MCP usage is read-only and cheap; only available when DB exists.
            const mcpUsage = engine.getMcpToolUsage();
            // Lifetime stats span every project's SessionDB + auto-memory dir
            // (Bugs #3/#4); failures are absorbed inside getLifetimeStats so a
            // corrupt sidecar can never break ctx_stats.
            // B3b Slice 3.1: scope to active adapter via getSessionDir() so
            // a non-Claude platform reads
            // from THEIR sessions dir — not the hardcoded ~/.claude/ default.
            // Mirrors the statusline contract in src/server.ts::persistStats.
            const lifetime = getLifetimeStats({ sessionsDir: getSessionDir() });
            // B3b Slices 3.2-3.6: cross-adapter aggregation so the renderer
            // can show "Where it came from" + the "across N AI tools"
            // headline. Best-effort — failures absorbed so a corrupt
            // sidecar in any adapter dir cannot break ctx_stats.
            let multiAdapter;
            try { multiAdapter = getMultiAdapterLifetimeStats(); } catch { /* never block ctx_stats */ }
            // F1: wire conversation + realBytes opts so formatReport renders the
            // narrative 5-section "kitap gibi" layout (timeline, ladder, receipt,
            // example cost, auto-memory). Without these, formatReport falls back
            // to the legacy active-session header. Best-effort — failures absorbed.
            // Resolve session_id: prefer env (CLAUDE_SESSION_ID), else most-recent
            // UUID session_id from session_events in this DB.
            let conversation;
            let realBytes;
            try {
              let sid = process.env.CLAUDE_SESSION_ID;
              if (!sid) {
                const row = sdb.prepare(
                  "SELECT session_id FROM session_events WHERE session_id LIKE '________-____-____-____-____________' ORDER BY created_at DESC LIMIT 1"
                ).get() as { session_id: string } | undefined;
                sid = row?.session_id;
              }
              if (sid) {
                conversation = getConversationStats({ sessionId: sid, sessionsDir: getSessionDir(), worktreeHash: dbHash });
                // v1.0.133 Slice 3: pass contentDbPath so getRealBytesStats can
                // join chunks WHERE session_id = sid and fold the indexed
                // content bytes into the per-conversation bar. Without this,
                // Mert's session showed ~200B (event metadata only) even with
                // 49 MB of indexed content sitting in the content DB.
                // Render-time read-only — no DB mutation, no backfill.
                const contentDbPath = getStorePath();
                // v1.0.148 Bug E+F: a conversation typically spans many
                // session_ids (resume cycles, /compact rebirths, PID
                // sub-process sessions launched by ctx_execute). Scoping
                // per-session loses sandbox-burst bytes_avoided that the
                // PID-sessions own. Look up THIS session's project_dir
                // from META and aggregate via META subquery so all
                // sibling sessions in the same cwd attribute together.
                // Fallback to sessionId scope if the META lookup fails
                // (best-effort — the original metric is still defensible).
                let convReal;
                try {
                  const Database = loadDatabase();
                  const dbFiles = (await import("node:fs"))
                    .readdirSync(getSessionDir())
                    .filter((f) => f.endsWith(".db") && (!dbHash || f.startsWith(dbHash)));
                  let projectDirForSid: string | undefined;
                  for (const file of dbFiles) {
                    try {
                      const sdb = new Database(
                        (await import("node:path")).join(getSessionDir(), file),
                        { readonly: true },
                      );
                      try {
                        const r = sdb
                          .prepare("SELECT project_dir FROM session_meta WHERE session_id = ?")
                          .get(sid) as { project_dir: string } | undefined;
                        if (r?.project_dir) {
                          projectDirForSid = r.project_dir;
                          break;
                        }
                      } finally {
                        sdb.close();
                      }
                    } catch { /* skip unreadable DB */ }
                  }
                  convReal = projectDirForSid
                    ? getRealBytesStats({ projectDir: projectDirForSid, sessionsDir: getSessionDir(), worktreeHash: dbHash, contentDbPath })
                    : getRealBytesStats({ sessionId: sid, sessionsDir: getSessionDir(), worktreeHash: dbHash, contentDbPath });
                } catch {
                  convReal = getRealBytesStats({ sessionId: sid, sessionsDir: getSessionDir(), worktreeHash: dbHash, contentDbPath });
                }
                const lifeRealBase = getRealBytesStats({ sessionsDir: getSessionDir() });
                // v1.0.134 SLICE C: lifetime tier sums ALL chunks (no
                // session_id filter). Without this fold, lifetime "kept out"
                // only counts session_events.bytes_avoided and ignores the
                // bulk of indexed payload across every prior conversation.
                const lifeContentBytes = getContentBytesAllSessions(contentDbPath);
                const lifeReal = {
                  ...lifeRealBase,
                  contentBytes: lifeRealBase.contentBytes + lifeContentBytes,
                  bytesAvoided: lifeRealBase.bytesAvoided + lifeContentBytes,
                  totalSavedTokens: Math.floor(
                    (lifeRealBase.eventDataBytes
                      + lifeRealBase.bytesAvoided
                      + lifeContentBytes
                      + lifeRealBase.snapshotBytes) / 4,
                  ),
                };
                realBytes = { conversation: convReal, lifetime: lifeReal };
              }
            } catch { /* never block ctx_stats */ }
            // v1.0.117: pass projectDir as cwd so the narrative renderer's
            // "started in <path>" line matches the user's actual project.
            // Snapshot the persistent store so the renderer can show
            // total_chunks / last_indexed_at without callers having to query
            // separately. Best-effort — getStore() is process-local and may
            // be unavailable on cold paths; failures are absorbed.
            let indexState;
            try { indexState = getStore().getIndexState(); } catch { /* never block ctx_stats */ }
            let storeUsage;
            try {
              const usage = contentStoreUsage(dirname(getStorePath()));
              storeUsage = { bytes: usage.totalBytes, stores: usage.stores.length };
            } catch { /* never block ctx_stats */ }
            text = formatReport(report, VERSION, latestVersion(), { lifetime, mcpUsage, multiAdapter, conversation, realBytes, indexState, storeUsage, cwd: projectDir });
          } finally {
            sdb.close();
          }
        } else {
          // No session DB — build a minimal report from runtime stats only.
          // Lifetime still meaningful (other projects, auto-memory) so include it.
          const engine = new AnalyticsEngine(createMinimalDb());
          const report = engine.queryAll(sessionStats);
          const lifetime = getLifetimeStats({ sessionsDir: getSessionDir() });
          let multiAdapter;
          try { multiAdapter = getMultiAdapterLifetimeStats(); } catch { /* never block ctx_stats */ }
          let indexState;
          try { indexState = getStore().getIndexState(); } catch { /* never block ctx_stats */ }
          text = formatReport(report, VERSION, latestVersion(), { lifetime, multiAdapter, indexState });
        }
      } catch {
        // Session DB not available or incompatible — build minimal report from runtime stats
        const engine = new AnalyticsEngine(createMinimalDb());
        const report = engine.queryAll(sessionStats);
        let lifetime;
        try { lifetime = getLifetimeStats({ sessionsDir: getSessionDir() }); } catch { /* never block ctx_stats */ }
        let multiAdapter;
        try { multiAdapter = getMultiAdapterLifetimeStats(); } catch { /* never block ctx_stats */ }
        text = formatReport(report, VERSION, latestVersion(), (lifetime || multiAdapter) ? { lifetime, multiAdapter } : undefined);
      }

      text += semanticIndexReport();

      return trackResponse("ctx_stats", {
        content: [{ type: "text" as const, text }],
      });
    },
  );
}
