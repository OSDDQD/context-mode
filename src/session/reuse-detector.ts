/**
 * session/reuse-detector — returns, and what they cost.
 *
 * A `ctx_search` / `ctx_execute_file` / `ctx_batch_execute` call that hands the
 * model a compressed view of source X only saved context if the model then
 * WORKED from that view. When the model turns around and `Read`s X whole a few
 * steps later, the compressed payload was not a saving at all: the full file
 * entered the window anyway AND the retrieval response entered it on top. That
 * is a net LOSS, and until this module existed it was booked as a WIN — the
 * kept-out bytes stayed in `bytes_avoided` and nothing ever subtracted them.
 *
 * Two products, from one pass over the session event stream:
 *
 *   1. {@link detectReuse} / {@link summarizeReuse} — the returned bytes, so
 *      `analytics.ts` can deduct them from the claimed savings BEFORE any
 *      token conversion (both sides of every ctx_stats ratio therefore stay on
 *      the one basis `session/tokenizer.ts` established — see ADR note below).
 *
 *   2. {@link shouldBypassCompression} — the feedback half. Above a reuse
 *      ratio (default 30%) compression is demonstrably not working for this
 *      scope, so the gateway should stop compressing and hand back the full
 *      text: paying for the full read once beats paying for a summary AND the
 *      full read. This module only decides; it never touches the gateway.
 *
 * ── Why a step window AND a time window ─────────────────────────────────────
 *
 * The behaviour being punished is "consulted the compressed view, then went
 * back to the source while still on the same thread of work". Step distance is
 * the semantically right measure of that — it counts tool turns, which is what
 * "still on the same thread" means — and it is also the only measure that can
 * ORDER events reliably: `session_events.created_at` is second-resolution UTC
 * text, and every event of one hook fire shares a timestamp, so time alone
 * cannot say which came first. Time is still needed as the second bound,
 * because step distance alone would happily pair a search with a read that
 * happened three hours and one coffee break later. Both must hold.
 *
 * ── Path normalization ──────────────────────────────────────────────────────
 *
 * The same file arrives in four shapes: absolute (`Read`'s `file_path` is
 * always absolute), relative (a `ctx_execute_file` path, a `grep` argument
 * inside a batch command), a `code:`-prefixed FTS5 source label (see
 * `code-index.ts`, which writes `code:${relative(projectDir, filePath)}`), and
 * Windows-separated. {@link normalizeSourceKey} folds all four the way
 * `project-attribution.ts` does — `normalize()`, forward slashes, resolve
 * relatives against the anchor — and matching additionally accepts a
 * segment-boundary suffix so an anchor-less relative still meets its absolute.
 *
 * Best-effort throughout: a malformed event, an unparseable params blob, or a
 * missing file yields "no detection", never a throw. ctx_stats must not be
 * crashable by a bad row.
 */

import { statSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";
import { tokensFromBytes } from "./tokenizer.js";

// ─────────────────────────────────────────────────────────
// Configuration — env switches, fork convention
// ─────────────────────────────────────────────────────────

/** Default share of covered sources that must be re-read before compression is judged useless. */
export const DEFAULT_REUSE_THRESHOLD = 0.30;
/** Default step window: tool turns between the covering call and the full read. */
export const DEFAULT_REUSE_STEP_WINDOW = 20;
/** Default time window: 15 minutes. */
export const DEFAULT_REUSE_WINDOW_MS = 15 * 60_000;
/** Default minimum covered sources before a ratio is allowed to trip the bypass. */
export const DEFAULT_REUSE_MIN_SAMPLES = 3;

function envFlagOff(raw: string | undefined): boolean {
  if (raw == null) return false;
  const v = raw.trim().toLowerCase();
  return v === "0" || v === "false" || v === "off" || v === "no";
}

/**
 * `CONTEXT_MODE_REUSE_DETECT=0|false|off|no` disables the detector entirely:
 * no pairs are found, nothing is deducted, and the bypass never fires. The
 * escape hatch for a user who suspects the join is mis-attributing.
 */
export function reuseDetectorEnabled(): boolean {
  return !envFlagOff(process.env.CONTEXT_MODE_REUSE_DETECT);
}

/**
 * `CONTEXT_MODE_REUSE_THRESHOLD` — accepted as a percentage (`30`) or as a
 * fraction (`0.3`); anything `> 1` is read as a percentage. Out-of-range or
 * unparseable values fall back to {@link DEFAULT_REUSE_THRESHOLD}.
 */
export function reuseThreshold(): number {
  const raw = process.env.CONTEXT_MODE_REUSE_THRESHOLD;
  if (!raw) return DEFAULT_REUSE_THRESHOLD;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_REUSE_THRESHOLD;
  const asFraction = parsed > 1 ? parsed / 100 : parsed;
  if (asFraction <= 0 || asFraction > 1) return DEFAULT_REUSE_THRESHOLD;
  return asFraction;
}

/** `CONTEXT_MODE_REUSE_STEP_WINDOW` — tool turns. Default 20. */
export function reuseStepWindow(): number {
  const raw = process.env.CONTEXT_MODE_REUSE_STEP_WINDOW;
  if (!raw) return DEFAULT_REUSE_STEP_WINDOW;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_REUSE_STEP_WINDOW;
  return parsed;
}

/** `CONTEXT_MODE_REUSE_WINDOW_MS` — wall-clock bound. Default 900000 (15 min). */
export function reuseWindowMs(): number {
  const raw = process.env.CONTEXT_MODE_REUSE_WINDOW_MS;
  if (!raw) return DEFAULT_REUSE_WINDOW_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_REUSE_WINDOW_MS;
  return parsed;
}

/** `CONTEXT_MODE_REUSE_MIN_SAMPLES` — covered sources needed before the bypass may fire. */
export function reuseMinSamples(): number {
  const raw = process.env.CONTEXT_MODE_REUSE_MIN_SAMPLES;
  if (!raw) return DEFAULT_REUSE_MIN_SAMPLES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_REUSE_MIN_SAMPLES;
  return parsed;
}

/**
 * `CONTEXT_MODE_REUSE_STAT_FILES=0` stops the detector from `stat`ing the
 * re-read file to price the return. With it off, a return is still DETECTED
 * (it counts toward the ratio) but prices at whatever `bytes_returned` the
 * event carried — usually 0, so nothing is deducted.
 */
export function reuseStatFilesEnabled(): boolean {
  return !envFlagOff(process.env.CONTEXT_MODE_REUSE_STAT_FILES);
}

// ─────────────────────────────────────────────────────────
// Event shapes
// ─────────────────────────────────────────────────────────

/**
 * The subset of a `session_events` row the detector reads. Structurally a
 * `StoredEvent` (db.ts) with everything optional that the detector can live
 * without, so callers may pass DB rows straight through and tests may pass
 * three-field literals.
 */
export interface ReuseCandidateEvent {
  /** `session_events.id` — the autoincrement, used as the intra-DB tiebreak. */
  id?: number;
  /** `session_events.type` — `mcp_tool_call`, `file_read`, … */
  type: string;
  /** `session_events.data` — a path for file events, a JSON blob for MCP calls. */
  data: string;
  /** `session_events.created_at` — SQLite `datetime('now')` text, or ISO. */
  created_at?: string;
  /** `session_events.project_dir` — the anchor for relative paths. */
  project_dir?: string;
  /** `session_events.bytes_returned` — the priced cost of the read, when known. */
  bytes_returned?: number;
}

/**
 * Event types the detector needs out of the DB. Anything else is noise for
 * this join; callers should narrow their `SELECT` with this list so a long
 * session does not drag 20k rows through JS.
 */
export const REUSE_EVENT_TYPES: readonly string[] = [
  // The covering side.
  "mcp_tool_call",
  // The returning side.
  "file_read",
  // Step-window ticks (they order the stream; their data is never matched).
  "file_write",
  "file_edit",
  "file_search",
  "file_glob",
  "bash_outcome",
  "error_tool",
];

/** Types that advance the step counter — one tool turn each. */
const STEP_TYPES = new Set(REUSE_EVENT_TYPES);

/** MCP tool-name suffixes whose payload is a COMPRESSED view of some source. */
const COMPRESSING_TOOL_SUFFIXES = [
  "ctx_search",
  "ctx_execute_file",
  "ctx_batch_execute",
  "ctx_gather",
  "ctx_execute",
  "ctx_index",
  "ctx_fetch_and_index",
];

/** Params keys whose value is, by contract, a single source reference. */
const SOURCE_KEYS = new Set([
  "path",
  "file_path",
  "filepath",
  "notebook_path",
  "source",
  "file",
]);

// ─────────────────────────────────────────────────────────
// Normalization
// ─────────────────────────────────────────────────────────

/** `code:`-style source-label prefixes (see code-index.ts) stripped before matching. */
const LABEL_PREFIXES = ["code:", "file:", "source:", "batch:", "execute:", "read:"];

/**
 * Fold one source reference — absolute path, relative path, `code:` source
 * label, Windows path — into the key the join compares.
 *
 * Mirrors `project-attribution.ts`'s private `normalizePath`: `normalize()`,
 * backslashes to forward slashes, trailing slash dropped; relatives are
 * resolved against `anchor` when one is known, and left relative when not (the
 * suffix rule in {@link sourcesMatch} covers that case). Returns `""` for
 * anything that is not a usable source reference — a URL, a glob, empty.
 */
export function normalizeSourceKey(raw: string, anchor?: string): string {
  if (!raw || typeof raw !== "string") return "";
  let s = raw.trim();
  if (!s) return "";

  // Source labels: `code:src/session/db.ts` → `src/session/db.ts`.
  for (const prefix of LABEL_PREFIXES) {
    if (s.toLowerCase().startsWith(prefix)) {
      s = s.slice(prefix.length).trim();
      break;
    }
  }
  if (!s) return "";

  // URLs are sources too, but nothing can `Read` one — never a return.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return "";
  // Globs address a set, not a file; the join would be guesswork.
  if (s.includes("*") || s.includes("?")) return "";

  const isWin = /^[A-Za-z]:[\\/]/.test(s);
  const abs = isAbsolute(s) || isWin;

  let out: string;
  if (abs) {
    out = normalize(s);
  } else if (anchor) {
    try {
      out = resolve(normalizeAnchor(anchor), s);
    } catch {
      out = normalize(s);
    }
  } else {
    out = normalize(s);
  }

  out = out.replace(/\\/g, "/");
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function normalizeAnchor(anchor: string): string {
  return normalize(anchor).replace(/\\/g, "/");
}

/**
 * True when two normalized keys name the same source.
 *
 * Exact match, or one is a segment-boundary suffix of the other — which is how
 * a relative `src/session/db.ts` (from a batch command, with no anchor) meets
 * the absolute `/home/u/proj/src/session/db.ts` a `Read` reports. A bare
 * filename is allowed to match on that rule: naming a file to a ctx tool and
 * then reading a same-named file within one step window is the behaviour being
 * measured, not a coincidence worth guarding against.
 */
export function sourcesMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length > b.length) return a.endsWith(`/${b}`);
  if (b.length > a.length) return b.endsWith(`/${a}`);
  return false;
}

// ─────────────────────────────────────────────────────────
// Cover extraction — which sources did this MCP call compress?
// ─────────────────────────────────────────────────────────

/**
 * Path-shaped tokens inside free text (a shell command, a code blob): at least
 * one separator and a dotted final segment, so `mcp__plugin_x__ctx_search` and
 * bare words never qualify.
 */
const PATH_TOKEN = /(?:^|[\s'"`=(,:[])((?:[A-Za-z]:[\\/])?[.]{0,2}[\\/]?(?:[\w.@+-]+[\\/])+[\w.@+-]*[\w@+-]\.[A-Za-z0-9]{1,8})/g;

/** Bare `name.ext` with no separator — accepted only from an explicit source key. */
const BARE_FILE = /^[\w.@+-]*[\w@+-]\.[A-Za-z0-9]{1,8}$/;

function collectFromText(text: string, into: Set<string>): void {
  if (!text) return;
  PATH_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = PATH_TOKEN.exec(text)) !== null) {
    if (++guard > 500) break;
    if (m[1]) into.add(m[1]);
  }
}

function walkParams(value: unknown, into: Set<string>, depth = 0): void {
  if (value == null || depth > 8) return;
  if (typeof value === "string") {
    collectFromText(value, into);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkParams(item, into, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" && SOURCE_KEYS.has(key.toLowerCase())) {
      // Contract-carrying key: take the whole value, even a bare filename.
      const trimmed = v.trim();
      if (trimmed && (BARE_FILE.test(trimmed) || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes(":"))) {
        into.add(trimmed);
      }
      collectFromText(v, into);
      continue;
    }
    walkParams(v, into, depth + 1);
  }
}

/** Result of reading one `mcp_tool_call` event's data blob. */
export interface CoverExtraction {
  /** Short tool name (`ctx_search`), host prefix stripped. Empty when unknown. */
  tool: string;
  /** Whether this tool hands back a compressed view worth measuring. */
  compressing: boolean;
  /** Raw source references named by the call, pre-normalization. */
  sources: string[];
}

/**
 * Read the sources one `mcp_tool_call` event covered.
 *
 * `extract.ts` writes the event data as
 * `{"tool_name":"…","params":{…}}`, or `{"tool_name":"…","params_raw":"…",
 * "truncated":true}` when the params blew the byte budget. Both shapes are
 * handled: the object is walked, the truncated string is scanned as text.
 */
export function extractCoveredSources(data: string): CoverExtraction {
  const empty: CoverExtraction = { tool: "", compressing: false, sources: [] };
  if (!data) return empty;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object") return empty;

  const rawName = String(parsed["tool_name"] ?? "");
  if (!rawName) return empty;
  const suffix = COMPRESSING_TOOL_SUFFIXES.find((s) => rawName.endsWith(s));
  if (!suffix) return { tool: shortToolName(rawName), compressing: false, sources: [] };

  const found = new Set<string>();
  if (parsed["params"] !== undefined) walkParams(parsed["params"], found);
  if (typeof parsed["params_raw"] === "string") collectFromText(parsed["params_raw"], found);

  return { tool: suffix, compressing: true, sources: [...found] };
}

function shortToolName(name: string): string {
  const idx = name.lastIndexOf("__");
  return idx >= 0 ? name.slice(idx + 2) : name;
}

// ─────────────────────────────────────────────────────────
// Detection
// ─────────────────────────────────────────────────────────

/** One "search compressed it, then the model read it whole anyway" pair. */
export interface ReuseDetection {
  /** Normalized key of the source that was covered and then re-read. */
  source: string;
  /** Path as the `file_read` event reported it. */
  readPath: string;
  /** Short name of the tool that produced the compressed view. */
  coverTool: string;
  /** `session_events.id` of the covering MCP call, when the row carried one. */
  coverEventId?: number;
  /** `session_events.id` of the full read. */
  readEventId?: number;
  /** Tool turns between cover and read (1 = the very next turn). */
  steps: number;
  /** Wall-clock gap in ms; 0 when neither row carried a parseable timestamp. */
  elapsedMs: number;
  /** What the full read cost — priced from `bytes_returned`, else from disk. */
  bytes: number;
}

/** Aggregate the renderer and the savings deduction consume. */
export interface ReuseSummary {
  /** Full reads that followed a compressed view of the same source. */
  returnedReads: number;
  /** Distinct sources a compressing call covered inside this event stream. */
  coveredSources: number;
  /** Distinct sources that were returned to. */
  returnedSources: number;
  /** Bytes the returns put into the window. */
  returnedBytes: number;
  /** {@link returnedBytes} on the honest tokenizer's basis. */
  returnedTokens: number;
  /** `returnedSources / coveredSources`, 0 when nothing was covered. */
  ratio: number;
  /** Whether the detector ran at all (false when the env switch is off). */
  enabled: boolean;
}

/** Everything one pass produced. */
export interface ReuseReport extends ReuseSummary {
  detections: ReuseDetection[];
}

/** Options for {@link detectReuse}. */
export interface DetectReuseOptions {
  /** Fallback anchor for relative paths when a row has no `project_dir`. */
  projectDir?: string;
  /** Step window override (tool turns). Defaults to {@link reuseStepWindow}. */
  stepWindow?: number;
  /** Time window override (ms). Defaults to {@link reuseWindowMs}. */
  windowMs?: number;
  /**
   * Price a full read whose event carried no `bytes_returned`. Defaults to a
   * `statSync` probe (disable with `CONTEXT_MODE_REUSE_STAT_FILES=0`).
   * Injected by the tests so no fixture has to touch the real filesystem.
   */
  sizeOf?: (absPath: string) => number;
  /** Force-enable/disable, bypassing the env switch. Tests and callers that already checked. */
  enabled?: boolean;
}

const EMPTY_REPORT: ReuseReport = {
  detections: [],
  returnedReads: 0,
  coveredSources: 0,
  returnedSources: 0,
  returnedBytes: 0,
  returnedTokens: 0,
  ratio: 0,
  enabled: false,
};

function parseMs(created: string | undefined): number {
  if (!created) return 0;
  // SQLite `datetime('now')` yields `YYYY-MM-DD HH:MM:SS` with an implicit UTC.
  const iso = created.includes("T") ? created : created.replace(" ", "T");
  const t = Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`);
  return Number.isFinite(t) ? t : 0;
}

function defaultSizeOf(absPath: string): number {
  if (!reuseStatFilesEnabled()) return 0;
  try {
    const st = statSync(absPath);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

/**
 * Find every "compressed view of X, then a full read of X" pair in one event
 * stream.
 *
 * Events may arrive in any order; they are sorted by `(created_at, id)` first,
 * which is the only ordering that survives the multi-DB scan `analytics.ts`
 * performs. A read pairs with the MOST RECENT covering call for its source
 * that is still inside both windows, and each read is counted at most once —
 * a file read three times after one search is three returns, not nine.
 */
export function detectReuse(
  events: ReuseCandidateEvent[],
  opts?: DetectReuseOptions,
): ReuseReport {
  const enabled = opts?.enabled ?? reuseDetectorEnabled();
  if (!enabled) return { ...EMPTY_REPORT, detections: [] };
  if (!Array.isArray(events) || events.length === 0) {
    return { ...EMPTY_REPORT, detections: [], enabled: true };
  }

  const stepWindow = opts?.stepWindow ?? reuseStepWindow();
  const windowMs = opts?.windowMs ?? reuseWindowMs();
  const sizeOf = opts?.sizeOf ?? defaultSizeOf;

  const ordered = [...events]
    .filter((e) => e && typeof e.type === "string")
    .map((e, i) => ({ ev: e, ms: parseMs(e.created_at), seq: i }))
    .sort((a, b) => {
      if (a.ms !== b.ms) return a.ms - b.ms;
      const ai = a.ev.id ?? a.seq;
      const bi = b.ev.id ?? b.seq;
      if (ai !== bi) return ai - bi;
      return a.seq - b.seq;
    });

  // Open covers, most recent last, keyed by normalized source.
  interface Cover {
    key: string;
    tool: string;
    eventId?: number;
    step: number;
    ms: number;
  }
  const covers: Cover[] = [];
  const coveredKeys = new Set<string>();
  const detections: ReuseDetection[] = [];
  const returnedKeys = new Set<string>();

  let step = 0;

  for (const item of ordered) {
    const ev = item.ev;
    if (STEP_TYPES.has(ev.type)) step++;

    if (ev.type === "mcp_tool_call") {
      const cover = extractCoveredSources(ev.data);
      if (!cover.compressing) continue;
      const anchor = ev.project_dir || opts?.projectDir;
      for (const raw of cover.sources) {
        const key = normalizeSourceKey(raw, anchor);
        if (!key) continue;
        coveredKeys.add(key);
        covers.push({ key, tool: cover.tool, eventId: ev.id, step, ms: item.ms });
      }
      continue;
    }

    if (ev.type !== "file_read") continue;

    const anchor = ev.project_dir || opts?.projectDir;
    const readKey = normalizeSourceKey(ev.data, anchor);
    if (!readKey) continue;

    // Most recent covering call for this source, still inside both windows.
    let match: Cover | undefined;
    for (let i = covers.length - 1; i >= 0; i--) {
      const c = covers[i];
      const steps = step - c.step;
      if (steps <= 0) continue;
      if (steps > stepWindow) continue;
      if (c.ms > 0 && item.ms > 0 && item.ms - c.ms > windowMs) continue;
      if (!sourcesMatch(c.key, readKey)) continue;
      match = c;
      break;
    }
    if (!match) continue;

    const priced = Number(ev.bytes_returned ?? 0);
    const bytes = Number.isFinite(priced) && priced > 0
      ? priced
      : Math.max(0, sizeOf(readKey));

    detections.push({
      source: match.key,
      readPath: ev.data,
      coverTool: match.tool,
      coverEventId: match.eventId,
      readEventId: ev.id,
      steps: step - match.step,
      elapsedMs: match.ms > 0 && item.ms > 0 ? item.ms - match.ms : 0,
      bytes,
    });
    returnedKeys.add(match.key);
  }

  const returnedBytes = detections.reduce((s, d) => s + d.bytes, 0);
  return {
    detections,
    returnedReads: detections.length,
    coveredSources: coveredKeys.size,
    returnedSources: returnedKeys.size,
    returnedBytes,
    returnedTokens: Math.round(tokensFromBytes(returnedBytes)),
    ratio: coveredKeys.size > 0 ? returnedKeys.size / coveredKeys.size : 0,
    enabled: true,
  };
}

/** Drop the per-pair detail, keep the numbers the renderer and the deduction use. */
export function summarizeReuse(report: ReuseReport): ReuseSummary {
  const { detections: _detections, ...summary } = report;
  return summary;
}

// ─────────────────────────────────────────────────────────
// Feedback policy — the gateway's half
// ─────────────────────────────────────────────────────────

/**
 * A scope the bypass decision can be asked about — a session, a project, one
 * source. Pass a ready `ratio`, or the raw counts, or a {@link ReuseSummary}
 * straight out of {@link detectReuse}.
 */
export interface ReuseScope {
  /** Reuse ratio, 0..1. Wins over `stats` and the raw counts when present. */
  ratio?: number;
  /** Distinct sources returned to. Used with `covered` when `ratio` is absent. */
  returned?: number;
  /** Distinct sources covered. Used with `returned` when `ratio` is absent. */
  covered?: number;
  /** A summary from {@link detectReuse} / the marker file. */
  stats?: Partial<ReuseSummary> | null;
  /** Threshold override, 0..1 (or a percentage `>1`). Defaults to the env value. */
  threshold?: number;
  /** Minimum covered sources before a ratio may fire. Defaults to the env value. */
  minSamples?: number;
}

/**
 * Should the gateway hand back FULL text instead of a compressed view?
 *
 * True once the measured reuse ratio for `scope` exceeds the threshold
 * (default 30%) on a large enough sample. Above that line compression is not
 * saving anything for this scope — the model re-reads the source anyway, so
 * the summary is pure overhead and the honest move is to skip it.
 *
 * Conservative by construction: disabled detector → false; no sample →
 * false; sample below `minSamples` → false; ratio exactly AT the threshold →
 * false (the contract is "above the threshold").
 */
export function shouldBypassCompression(scope?: ReuseScope | null): boolean {
  if (!scope) return false;
  if (!reuseDetectorEnabled()) return false;
  if (scope.stats && scope.stats.enabled === false) return false;

  const threshold = normalizeThreshold(scope.threshold) ?? reuseThreshold();
  const minSamples = Number.isFinite(scope.minSamples as number) && (scope.minSamples as number) >= 0
    ? (scope.minSamples as number)
    : reuseMinSamples();

  const covered = firstFinite(scope.covered, scope.stats?.coveredSources);
  const returned = firstFinite(scope.returned, scope.stats?.returnedSources);

  let ratio: number | undefined = normalizeThreshold(scope.ratio);
  if (ratio === undefined && scope.stats && Number.isFinite(scope.stats.ratio as number)) {
    ratio = scope.stats.ratio as number;
  }
  if (ratio === undefined && covered !== undefined && covered > 0 && returned !== undefined) {
    ratio = returned / covered;
  }
  if (ratio === undefined || !Number.isFinite(ratio)) return false;

  // A sample size is only enforced when we know one. An explicit `ratio` with
  // no counts is the caller asserting it already vetted the sample.
  if (covered !== undefined && covered < minSamples) return false;
  if (covered !== undefined && covered === 0) return false;

  return ratio > threshold;
}

function firstFinite(...values: Array<number | undefined>): number | undefined {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

function normalizeThreshold(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  const asFraction = value > 1 ? value / 100 : value;
  if (asFraction < 0 || asFraction > 1) return undefined;
  return asFraction;
}
