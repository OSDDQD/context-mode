/**
 * Closing the ranking-feedback loop across the MCP boundary.
 *
 * WHY THIS EXISTS — fff's ranking learns from `trackQuery(query, selectedFile)`:
 * "this query was answered by that file". The MCP protocol cannot supply the
 * second half. A tool call is a request and a response; nothing tells the
 * server what the caller did NEXT, and "what the caller did next" is the entire
 * training signal. So `ctx_find` would have shipped a ranker that could never
 * improve.
 *
 * The fix rides the rails `src/session/retrieval-marker.ts` already laid, in
 * the opposite direction. That module goes server → hook (the server writes
 * bytes, the next hook fire forwards them). This one is a round trip:
 *
 *   1. `ctx_find` writes the query and the candidate paths it showed
 *      (`context-mode-find-<db>.json`).
 *   2. The next PostToolUse fire sees an `Edit`/`Read`/`Write` whose file is
 *      one of those candidates and appends a selection line
 *      (`context-mode-find-selected-<db>.jsonl`).
 *   3. The next `ctx_find` call drains the selections and calls
 *      `finder.trackQuery(query, path)` for each.
 *
 * WHAT IS NOT REACHABLE FROM THE HOOK — step 3 is deliberately not done in the
 * hook. `trackQuery` needs the native fff addon, an acquired finder for the
 * project, and a lock-aware retry; a PostToolUse hook has a <20ms budget, no
 * bundle that carries `src/fff/**`, and no reason to hold a native index open.
 * So the hook records INTENT (a two-field append, no SQLite, no native code)
 * and the server, which already holds the finder, performs the write. The cost
 * is latency: a selection is learned at the next `ctx_find`, not instantly.
 * The benefit is that a hook can never fail a session over a ranking update.
 *
 * Both markers are keyed by the session DB *basename*, the one identifier the
 * server process and the hook process both resolve reliably — the same keying
 * decision, and for the same reason, as `retrievalMarkerPath`.
 *
 * The hook half re-derives these paths inline rather than importing this
 * module: hooks are separate bundles (see `package.json` → `bundle`) and
 * nothing under `src/search/` is bundled for them. That duplication is the
 * established pattern here — `hooks/posttooluse.mjs` already re-derives
 * `context-mode-retrieval-<db>.txt` by hand. Keep the two spellings in step.
 */

import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// ─────────────────────────────────────────────────────────
// Env
// ─────────────────────────────────────────────────────────

/** `CONTEXT_MODE_FIND_TRACK=0` turns the whole feedback loop off. */
export function findTrackingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CONTEXT_MODE_FIND_TRACK !== "0";
}

/**
 * How long a shown candidate stays eligible to be counted as "the answer".
 *
 * Long enough that reading three files before editing the right one still
 * trains, short enough that a file opened an hour later for unrelated reasons
 * does not get credited to a stale query. Default 15 minutes.
 */
export function findTrackingTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.CONTEXT_MODE_FIND_TRACK_TTL_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60_000;
}

/** Queries retained in the candidate marker. Older ones drop off the end. */
const MAX_TRACKED_QUERIES = 5;
/** Candidate paths retained per query. */
const MAX_TRACKED_PATHS = 25;
/** Selections drained in one go — a runaway appender cannot flood the server. */
const MAX_DRAINED_SELECTIONS = 50;

// ─────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────

/** One `ctx_find` response, as the hook needs to see it. */
export interface FindCandidateRecord {
  /** The query text, verbatim — it is what `trackQuery` is keyed by. */
  query: string;
  /** Absolute paths of the file candidates shown, best first. */
  paths: string[];
  /** ms epoch the response was rendered. */
  at: number;
}

/** One file the caller opened after a `ctx_find`, attributed to its query. */
export interface FindSelection {
  query: string;
  path: string;
  at: number;
}

// ─────────────────────────────────────────────────────────
// Server → hook: what was shown
// ─────────────────────────────────────────────────────────

/** Path of the "what ctx_find last showed" marker for a session DB. */
export function findCandidatesMarkerPath(
  sessionDbPath: string,
  tmpDir: string = tmpdir(),
): string {
  return join(tmpDir, `context-mode-find-${basename(sessionDbPath)}.json`);
}

/**
 * Publish the candidates one `ctx_find` response showed.
 *
 * Read-modify-write rather than append: this is a bounded window of recent
 * queries, not a ledger, and the hook must be able to parse it with one
 * `JSON.parse`. Newest first; both axes capped so a marker cannot grow without
 * bound between hook fires. Best-effort — never throws into the MCP response.
 */
export function recordFindCandidates(
  sessionDbPath: string,
  record: FindCandidateRecord,
  tmpDir?: string,
): void {
  if (!record.query || record.paths.length === 0) return;
  const path = findCandidatesMarkerPath(sessionDbPath, tmpDir);
  try {
    const previous = readFindCandidates(sessionDbPath, tmpDir)
      .filter(r => r.query !== record.query);
    const next: FindCandidateRecord[] = [
      {
        query: record.query,
        paths: record.paths.slice(0, MAX_TRACKED_PATHS),
        at: record.at || Date.now(),
      },
      ...previous,
    ].slice(0, MAX_TRACKED_QUERIES);
    writeFileSync(path, JSON.stringify(next));
  } catch { /* best-effort — a missing marker just means "no learning" */ }
}

/**
 * Read the recent candidate windows, newest first.
 *
 * READ-ONLY, and expiry is applied here rather than by a sweeper: one
 * `ctx_find` can be followed by several file opens, so consuming the marker on
 * first read would train on the first file and ignore the rest.
 */
export function readFindCandidates(
  sessionDbPath: string,
  tmpDir?: string,
  now: number = Date.now(),
  ttlMs: number = findTrackingTtlMs(),
): FindCandidateRecord[] {
  try {
    const raw = readFileSync(findCandidatesMarkerPath(sessionDbPath, tmpDir), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r): r is FindCandidateRecord =>
        !!r && typeof r === "object"
        && typeof (r as FindCandidateRecord).query === "string"
        && Array.isArray((r as FindCandidateRecord).paths))
      .map(r => ({ query: r.query, paths: r.paths.map(String), at: Number(r.at) || 0 }))
      .filter(r => r.at > 0 && now - r.at <= ttlMs);
  } catch {
    return [];
  }
}

/** Drop the candidate marker — purge, or session end. Best-effort. */
export function clearFindCandidates(sessionDbPath: string, tmpDir?: string): void {
  try { rmSync(findCandidatesMarkerPath(sessionDbPath, tmpDir), { force: true }); } catch { /* ok */ }
}

/**
 * Which recorded query, if any, a just-touched file answers.
 *
 * Shared by both halves of the loop so the hook and the server agree on what
 * counts as a selection: newest query wins, and a path must have been SHOWN —
 * an unrelated file the agent happened to open trains nothing.
 *
 * @returns The matching query, or null.
 */
export function matchSelection(
  records: FindCandidateRecord[],
  filePath: string,
): FindCandidateRecord | null {
  if (!filePath) return null;
  for (const record of records) {
    if (record.paths.includes(filePath)) return record;
  }
  return null;
}

// ─────────────────────────────────────────────────────────
// Hook → server: what was chosen
// ─────────────────────────────────────────────────────────

/** Path of the "what the caller opened" marker for a session DB. */
export function findSelectionsMarkerPath(
  sessionDbPath: string,
  tmpDir: string = tmpdir(),
): string {
  return join(tmpDir, `context-mode-find-selected-${basename(sessionDbPath)}.jsonl`);
}

/**
 * Record that `filePath` was opened after a `ctx_find` that showed it.
 *
 * JSONL and append-only: several selections can accumulate between two server
 * calls, and an append cannot corrupt a concurrent reader's earlier lines the
 * way a rewrite could. This is the call the HOOK makes (in its own inline
 * spelling) and the one tests drive directly.
 */
export function appendFindSelection(
  sessionDbPath: string,
  selection: FindSelection,
  tmpDir?: string,
): void {
  if (!selection.query || !selection.path) return;
  try {
    appendFileSync(
      findSelectionsMarkerPath(sessionDbPath, tmpDir),
      `${JSON.stringify({
        query: selection.query,
        path: selection.path,
        at: selection.at || Date.now(),
      })}\n`,
    );
  } catch { /* best-effort — never block a hook */ }
}

/**
 * Drain every recorded selection and delete the marker.
 *
 * Consume-once: `trackQuery` is a counter, and replaying the same selection on
 * every subsequent `ctx_find` would let one file win the ranking forever.
 * Malformed lines are skipped rather than failing the drain — the file is
 * written by a hook that must never crash a session over it.
 */
export function consumeFindSelections(
  sessionDbPath: string,
  tmpDir?: string,
): FindSelection[] {
  const path = findSelectionsMarkerPath(sessionDbPath, tmpDir);
  const out: FindSelection[] = [];
  try {
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as Partial<FindSelection>;
        if (typeof parsed?.query === "string" && typeof parsed?.path === "string"
          && parsed.query && parsed.path) {
          out.push({ query: parsed.query, path: parsed.path, at: Number(parsed.at) || 0 });
        }
      } catch { /* one bad line does not spoil the drain */ }
      if (out.length >= MAX_DRAINED_SELECTIONS) break;
    }
  } catch { /* no marker — nothing was selected */ }
  try { rmSync(path, { force: true }); } catch { /* ok */ }
  return out;
}
