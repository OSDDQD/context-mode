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
 * Three products, from one pass over the session event stream:
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
 *   3. {@link detectReadWaste} / {@link summarizeReadWaste} — the sibling
 *      loss. A return is a file the model paid for TWICE; this is a file it
 *      paid for once and never used at all: read whole into the window, then
 *      never edited, never named by a later call, never mentioned in the
 *      answer. Pure waste, and invisible until this pass existed. Reported
 *      only — a `Read` was never booked as a saving, so there is nothing to
 *      deduct it from. Shares this module's event stream and its path
 *      normalization; see the "What counts as USED" block below for the rule
 *      and for why it errs on the side of calling a read USED.
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
import {
  boolKey,
  disableKeyOnOff,
  isOffValue,
  numberKey,
  readEnvFamily,
  type FamilySettings,
} from "../util/env-family.js";

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

/**
 * The whole detector, as one JSON flag: `CONTEXT_MODE_REUSE={"enabled":true,
 * "threshold":0.3,"stepWindow":20,"windowMs":900000,"minSamples":3,
 * "statFiles":true}`.
 *
 * Six variables for one feature was the worst offender in a ~135-flag surface,
 * and nobody could see them as one thing. Every original scalar still works and
 * still WINS over the JSON key it overlaps — see `src/util/env-family.ts` for
 * why that direction, and for why malformed JSON degrades to the scalars
 * instead of throwing. A non-JSON value on the head name
 * (`CONTEXT_MODE_REUSE=0`) reads as an off-switch for the whole family, the
 * same way `CONTEXT_MODE_REUSE_DETECT=0` always has.
 */
const REUSE_FAMILY_ENV = "CONTEXT_MODE_REUSE" as const;

/**
 * `threshold` is accepted as a percentage (`30`) or as a fraction (`0.3`);
 * anything `> 1` is read as a percentage. This is the one knob where the two
 * readings are both natural, so both are taken rather than making the operator
 * guess. Out-of-range values are rejected (→ next layer, then the default).
 */
function normalizeReuseThreshold(n: number): number | undefined {
  if (n <= 0) return undefined;
  const asFraction = n > 1 ? n / 100 : n;
  return asFraction > 0 && asFraction <= 1 ? asFraction : undefined;
}

/** Positive integer knobs: a zero window would disable the detector by accident. */
function positiveInt(n: number): number | undefined {
  const truncated = Math.trunc(n);
  return truncated > 0 ? truncated : undefined;
}

/** `minSamples` alone accepts 0 — "trip on the first covered source". */
function nonNegativeInt(n: number): number | undefined {
  const truncated = Math.trunc(n);
  return truncated >= 0 ? truncated : undefined;
}

const REUSE_SCHEMA = {
  enabled: boolKey("enabled", "CONTEXT_MODE_REUSE_DETECT", true),
  threshold: numberKey("threshold", "CONTEXT_MODE_REUSE_THRESHOLD", DEFAULT_REUSE_THRESHOLD, normalizeReuseThreshold),
  stepWindow: numberKey("stepWindow", "CONTEXT_MODE_REUSE_STEP_WINDOW", DEFAULT_REUSE_STEP_WINDOW, positiveInt),
  windowMs: numberKey("windowMs", "CONTEXT_MODE_REUSE_WINDOW_MS", DEFAULT_REUSE_WINDOW_MS, positiveInt),
  minSamples: numberKey("minSamples", "CONTEXT_MODE_REUSE_MIN_SAMPLES", DEFAULT_REUSE_MIN_SAMPLES, nonNegativeInt),
  statFiles: boolKey("statFiles", "CONTEXT_MODE_REUSE_STAT_FILES", true),
};

/** Resolved per call, never memoized — `ctx_stats` runs long after start-up,
 *  and the test suite flips these variables between cases. */
export function reuseSettings(): FamilySettings<typeof REUSE_SCHEMA> {
  return readEnvFamily(REUSE_FAMILY_ENV, REUSE_SCHEMA, process.env, {
    headScalar: disableKeyOnOff<typeof REUSE_SCHEMA>("enabled"),
  });
}

/**
 * `CONTEXT_MODE_REUSE_DETECT=0|false|off|no` — or `{"enabled":false}` — disables
 * the detector entirely: no pairs are found, nothing is deducted, and the
 * bypass never fires. The escape hatch for a user who suspects the join is
 * mis-attributing.
 */
export function reuseDetectorEnabled(): boolean {
  return reuseSettings().enabled;
}

/**
 * `CONTEXT_MODE_REUSE_THRESHOLD` / `{"threshold":…}` — percentage or fraction.
 * Unparseable values fall back to {@link DEFAULT_REUSE_THRESHOLD}.
 */
export function reuseThreshold(): number {
  return reuseSettings().threshold;
}

/** `CONTEXT_MODE_REUSE_STEP_WINDOW` / `{"stepWindow":…}` — tool turns. Default 20. */
export function reuseStepWindow(): number {
  return reuseSettings().stepWindow;
}

/** `CONTEXT_MODE_REUSE_WINDOW_MS` / `{"windowMs":…}` — wall-clock bound. Default 900000 (15 min). */
export function reuseWindowMs(): number {
  return reuseSettings().windowMs;
}

/** `CONTEXT_MODE_REUSE_MIN_SAMPLES` / `{"minSamples":…}` — covered sources needed before the bypass may fire. */
export function reuseMinSamples(): number {
  return reuseSettings().minSamples;
}

/**
 * `CONTEXT_MODE_REUSE_STAT_FILES=0` (or `{"statFiles":false}`) stops the
 * detector from `stat`ing the re-read file to price the return. With it off, a
 * return is still DETECTED (it counts toward the ratio) but prices at whatever
 * `bytes_returned` the event carried — usually 0, so nothing is deducted.
 */
export function reuseStatFilesEnabled(): boolean {
  return reuseSettings().statFiles;
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

/** One event in stream order, with its parsed timestamp and its input index. */
interface OrderedEvent {
  ev: ReuseCandidateEvent;
  ms: number;
  seq: number;
}

/**
 * Put an event array into the only order that survives the multi-DB scan
 * `analytics.ts` performs: `(created_at, id, input index)`.
 *
 * Shared by both passes so they cannot disagree about what "later" means —
 * and `created_at` is second-resolution text in which a whole hook fire shares
 * one value, so `id` and then the input index are what actually break the tie.
 */
function orderEvents(events: ReuseCandidateEvent[]): OrderedEvent[] {
  return [...events]
    .filter((e) => e && typeof e.type === "string")
    .map((e, i) => ({ ev: e, ms: parseMs(e.created_at), seq: i }))
    .sort((a, b) => {
      if (a.ms !== b.ms) return a.ms - b.ms;
      const ai = a.ev.id ?? a.seq;
      const bi = b.ev.id ?? b.seq;
      if (ai !== bi) return ai - bi;
      return a.seq - b.seq;
    });
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

  const ordered = orderEvents(events);

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
// Read but never used — the other half of the loss
// ─────────────────────────────────────────────────────────

/**
 * `CONTEXT_MODE_READ_WASTE=0|false|off|no` switches the read-but-never-used
 * metric off: the extra event types are not selected, no text is scanned, and
 * ctx_stats prints no waste line.
 *
 * Separate from `CONTEXT_MODE_REUSE_DETECT` on purpose. The reuse detector
 * CHANGES numbers (it deducts from `bytes_avoided`); this one only REPORTS, so
 * a user may reasonably want one without the other.
 */
export function readWasteDetectorEnabled(): boolean {
  return !isOffValue(process.env.CONTEXT_MODE_READ_WASTE);
}

/**
 * Tool turns that must have passed after a read before it may be called waste.
 *
 * The last few reads of a LIVE session have not had their chance yet: the model
 * may edit the file in its very next turn. Judging them would print waste that
 * the next tool call disproves a second later, and a metric that flip-flops is
 * a metric nobody believes.
 */
export const DEFAULT_READ_WASTE_TAIL_STEPS = 3;

/**
 * Event types whose `data` carries text that can MENTION a source after it was
 * read: the assistant's own answer (`turn_end.last_assistant_message`), a
 * sub-agent brief, a recorded decision or goal, the user's prompt.
 *
 * Deliberately EXCLUDES `read-redirected`, `missed_redirect` and
 * `file_read_metadata`. Those are emitted by the SAME hook fire as the
 * `file_read` they describe and repeat its path verbatim — counting them would
 * mark every read as "mentioned afterwards" and silently zero the metric.
 */
export const MENTION_EVENT_TYPES: readonly string[] = [
  "turn_end",
  "agent_finding",
  "decision",
  "decision_question",
  "user_prompt",
  "data",
  "goal",
  "intent",
  "blocker",
];

/**
 * The `type IN (…)` list a caller needs to serve BOTH passes from ONE SELECT.
 *
 * {@link detectReuse} ignores the extra rows — none of them is `mcp_tool_call`
 * or `file_read`, and none is in {@link REUSE_EVENT_TYPES}, so none advances
 * its step counter either. One query, one array, two products; that is the
 * whole reason this pass lives in this module instead of next to it.
 */
export const READ_WASTE_EVENT_TYPES: readonly string[] = [
  ...REUSE_EVENT_TYPES,
  ...MENTION_EVENT_TYPES,
];

/**
 * ── What counts as USED ─────────────────────────────────────────────────────
 *
 * A `file_read` is USED when ANY of these happens strictly after it:
 *
 *   1. an `file_edit` / `file_write` of the same path — the read fed a change;
 *   2. any later tool call naming it — another read, a grep, a glob, an
 *      `mcp_tool_call` whose params carry the path, an `error_tool` blob
 *      quoting it;
 *   3. a mention of the path, of its basename, or of its basename-without-
 *      extension in later text — the assistant's answer, a sub-agent brief, a
 *      decision, the user's next prompt.
 *
 * Everything else is WASTE: bytes that entered the window whole and were never
 * referred to again.
 *
 * The bias is deliberate and one-directional — WHEN IN DOUBT, USED.
 * Over-reporting waste would make the number untrustworthy the first time a
 * user recognised a file they know they worked from, and a loss metric nobody
 * believes is worse than no loss metric. Hence:
 *
 *   - the basename-without-extension needle. Matching "an identifier from the
 *     file" properly would mean opening the file and extracting its symbols —
 *     exactly the heavy pass this metric must not add. The module stem is the
 *     cheap proxy, and it is a LOOSE one: it marks reads used on a bare mention
 *     of `analytics`, which is the safe direction to be wrong in.
 *   - the tail grace ({@link DEFAULT_READ_WASTE_TAIL_STEPS}).
 *   - abstention on a truncated stream (see `truncated` below): a capped row
 *     set loses the END of the session, which is exactly where the exonerating
 *     mentions are.
 *   - a read whose path will not normalize (a URL, a glob) is not judged at all.
 *
 * Nothing here is deducted from `bytes_avoided`. A `Read` was never booked as a
 * saving in the first place — unlike the returns above, which were. This pass
 * reports a loss the savings arithmetic never claimed, and touching the ratio
 * with it would double-count in the other direction.
 */

/** Word-ish tokens: paths, filenames, bare identifiers. One linear scan per event. */
const MENTION_TOKEN = /[A-Za-z0-9_@+.\-/\\]{2,}/g;
/**
 * Per-event text budget — `data` / `user_prompt` rows run to tens of KB.
 *
 * Exported so the caller can apply the SAME cap in SQL (`substr(data, 1, N)`)
 * on the mention types and never move the discarded tail across the driver.
 * Lossless: this pass would slice it off here anyway, and no other consumer
 * parses those rows.
 */
export const MENTION_TEXT_CAP = 16_384;
/** Per-event token budget, so one pathological blob cannot own the pass. */
const MENTION_TOKEN_CAP = 4_000;

/** Prose punctuation that clings to a path: "…in `src/db.ts`, which…". */
const TRAILING_PUNCT = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}", "'", '"', "`"]);

/** The forms a read's path may be referred to by: full key, basename, stem. */
function readNeedles(key: string): string[] {
  const k = key.toLowerCase();
  const out = [k];
  const base = k.slice(k.lastIndexOf("/") + 1);
  if (base.length >= 2 && base !== k) out.push(base);
  const dot = base.lastIndexOf(".");
  if (dot >= 2) out.push(base.slice(0, dot));
  return out;
}

/**
 * Record which of the WANTED needles one text token matches.
 *
 * The inversion that keeps this pass cheap. The obvious shape — tokenize every
 * event into one big "everything mentioned" set — builds a few hundred thousand
 * entries out of a session's prose and spends most of its time growing and
 * rehashing that set. Nothing needs it: the only strings that can change an
 * answer are the needles of the files that were actually read, a few hundred at
 * most, and those are known before the walk starts. So the hot loop does
 * lookups against a small fixed table instead of insertions into a growing one.
 */
function recordNeedleHits(token: string, wanted: Set<string>, seen: Set<string>): void {
  let t = token.indexOf("\\") >= 0 ? token.replace(/\\/g, "/") : token;
  let end = t.length;
  while (end > 0 && TRAILING_PUNCT.has(t[end - 1])) end--;
  if (end < 2) return;
  if (end !== t.length) t = t.slice(0, end);
  t = t.toLowerCase();

  if (wanted.has(t)) seen.add(t);
  const slash = t.lastIndexOf("/");
  const base = slash >= 0 ? t.slice(slash + 1) : t;
  if (base !== t && base.length >= 2 && wanted.has(base)) seen.add(base);
  const dot = base.lastIndexOf(".");
  if (dot >= 2) {
    const stem = base.slice(0, dot);
    if (wanted.has(stem)) seen.add(stem);
  }
}

/** Scan one event's `data` for wanted needles. Capped; never throws. */
function scanMentions(text: string | undefined, wanted: Set<string>, seen: Set<string>): void {
  if (!text || typeof text !== "string") return;
  if (wanted.size === 0 || seen.size >= wanted.size) return;
  const slice = text.length > MENTION_TEXT_CAP ? text.slice(0, MENTION_TEXT_CAP) : text;
  MENTION_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = MENTION_TOKEN.exec(slice)) !== null) {
    if (++guard > MENTION_TOKEN_CAP) break;
    recordNeedleHits(m[0], wanted, seen);
  }
}

/** One file that entered the window through a read and was never referred to again. */
export interface ReadWasteDetection {
  /** Normalized key of the file that was read and dropped. */
  source: string;
  /** Path as the `file_read` event reported it. */
  readPath: string;
  /** `session_events.id` of the unused read. */
  readEventId?: number;
  /** What the read cost — priced from `bytes_returned`, else from disk. */
  bytes: number;
}

/** Aggregate the ctx_stats renderer consumes. Reported, never deducted. */
export interface ReadWasteSummary {
  /** Reads that were judged and found unused. */
  wastedReads: number;
  /** Distinct files behind {@link wastedReads}. */
  wastedSources: number;
  /** Reads old enough to judge — the honest denominator of {@link ratio}. */
  judgedReads: number;
  /** Distinct files behind {@link judgedReads}. */
  judgedSources: number;
  /** Bytes the unused reads put into the window. */
  wastedBytes: number;
  /** {@link wastedBytes} on the one tokenizer basis (ADR-0004). */
  wastedTokens: number;
  /** `wastedReads / judgedReads`, 0 when nothing was judged. */
  ratio: number;
  /** Heaviest offenders, descending by bytes. At most 3. */
  top: Array<{ path: string; bytes: number }>;
  /** Whether the pass ran at all (false when the env switch is off). */
  enabled: boolean;
  /** True when the row set was capped and the pass therefore abstained. */
  truncated: boolean;
}

/** Everything one pass produced. */
export interface ReadWasteReport extends ReadWasteSummary {
  detections: ReadWasteDetection[];
}

/** Options for {@link detectReadWaste}. */
export interface DetectReadWasteOptions {
  /** Fallback anchor for relative paths when a row has no `project_dir`. */
  projectDir?: string;
  /**
   * Price a read whose event carried no `bytes_returned`. Defaults to the same
   * `statSync` probe the reuse pass uses, so `CONTEXT_MODE_REUSE_STAT_FILES=0`
   * silences pricing here too (a read is still DETECTED, it just prices at 0).
   */
  sizeOf?: (absPath: string) => number;
  /** Force-enable/disable, bypassing the env switch. Tests and vetted callers. */
  enabled?: boolean;
  /**
   * Set when the caller's row budget was exhausted. A capped SELECT drops the
   * TAIL of the stream — precisely where the mentions that would exonerate a
   * read live — so the pass abstains rather than inventing waste.
   */
  truncated?: boolean;
  /** Tail-grace override. Defaults to {@link DEFAULT_READ_WASTE_TAIL_STEPS}. */
  tailSteps?: number;
}

const EMPTY_WASTE_REPORT: ReadWasteReport = {
  detections: [],
  wastedReads: 0,
  wastedSources: 0,
  judgedReads: 0,
  judgedSources: 0,
  wastedBytes: 0,
  wastedTokens: 0,
  ratio: 0,
  top: [],
  enabled: false,
  truncated: false,
};

/**
 * Find every file that entered the context window through a read and was never
 * referred to again. See the "What counts as USED" block above for the rule.
 *
 * One backward walk over the SAME ordered array {@link detectReuse} consumes.
 * Walking backwards is what makes it cheap: the set of needles already
 * mentioned is built once, in stream order, and at every read it already holds
 * exactly that read's future — no per-read rescan, no second query, no file
 * opened. See {@link recordNeedleHits} for the other half of the budget.
 *
 * The `pending` buffer holds events whose `(timestamp, step)` still ties the
 * event being judged. `created_at` is second-resolution and a whole hook fire
 * shares one value, so without that buffer a companion row emitted by the very
 * same `Read` would count as a mention OF that read. Only strictly-later events
 * are allowed into the mention set.
 */
export function detectReadWaste(
  events: ReuseCandidateEvent[],
  opts?: DetectReadWasteOptions,
): ReadWasteReport {
  const enabled = opts?.enabled ?? readWasteDetectorEnabled();
  if (!enabled) return { ...EMPTY_WASTE_REPORT, detections: [], top: [] };
  if (!Array.isArray(events) || events.length === 0) {
    return { ...EMPTY_WASTE_REPORT, detections: [], top: [], enabled: true };
  }
  if (opts?.truncated) {
    return { ...EMPTY_WASTE_REPORT, detections: [], top: [], enabled: true, truncated: true };
  }

  const tailSteps = opts?.tailSteps ?? DEFAULT_READ_WASTE_TAIL_STEPS;
  const sizeOf = opts?.sizeOf ?? defaultSizeOf;
  const ordered = orderEvents(events);

  // Forward pass: the step index of every event, and the stream's total.
  const stepAt = new Array<number>(ordered.length);
  let step = 0;
  for (let i = 0; i < ordered.length; i++) {
    if (STEP_TYPES.has(ordered[i].ev.type)) step++;
    stepAt[i] = step;
  }
  const totalSteps = step;

  // Every needle any read in this stream could be exonerated by. Built before
  // the walk so the mention scan has something small to look for.
  const wanted = new Set<string>();
  for (const item of ordered) {
    if (item.ev.type !== "file_read") continue;
    const key = normalizeSourceKey(item.ev.data, item.ev.project_dir || opts?.projectDir);
    if (key) for (const n of readNeedles(key)) wanted.add(n);
  }

  const mentioned = new Set<string>();
  const pending: Array<{ ms: number; step: number; text: string }> = [];
  const detections: ReadWasteDetection[] = [];
  const wastedKeys = new Set<string>();
  const judgedKeys = new Set<string>();
  let judgedReads = 0;

  for (let i = ordered.length - 1; i >= 0; i--) {
    const cur = ordered[i];
    const curStep = stepAt[i];

    // Promote everything strictly later than THIS event into the mention set.
    // Both coordinates are non-increasing as `i` falls, so a promoted event
    // stays strictly later for every event still to come.
    for (let p = pending.length - 1; p >= 0; p--) {
      const q = pending[p];
      if (q.ms > cur.ms || q.step > curStep) {
        scanMentions(q.text, wanted, mentioned);
        pending.splice(p, 1);
      }
    }

    if (cur.ev.type === "file_read") {
      const anchor = cur.ev.project_dir || opts?.projectDir;
      const key = normalizeSourceKey(cur.ev.data, anchor);
      // Unnormalizable (URL, glob, empty) — not a file, not judged.
      // Too close to the end of the stream — not judged yet, see tail grace.
      if (key && totalSteps - curStep >= tailSteps) {
        judgedReads++;
        judgedKeys.add(key);
        if (!readNeedles(key).some((n) => mentioned.has(n))) {
          const priced = Number(cur.ev.bytes_returned ?? 0);
          const bytes = Number.isFinite(priced) && priced > 0
            ? priced
            : Math.max(0, sizeOf(key));
          detections.push({
            source: key,
            readPath: cur.ev.data,
            readEventId: cur.ev.id,
            bytes,
          });
          wastedKeys.add(key);
        }
      }
    }

    // The read's own row goes in only AFTER it was judged: a file mentioned
    // solely by the read that pulled it in is waste, not use.
    pending.push({ ms: cur.ms, step: curStep, text: cur.ev.data });
  }

  const wastedBytes = detections.reduce((s, d) => s + d.bytes, 0);
  const perSource = new Map<string, number>();
  for (const d of detections) perSource.set(d.source, (perSource.get(d.source) ?? 0) + d.bytes);
  const top = [...perSource.entries()]
    .map(([path, bytes]) => ({ path, bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3);

  return {
    detections,
    wastedReads: detections.length,
    wastedSources: wastedKeys.size,
    judgedReads,
    judgedSources: judgedKeys.size,
    wastedBytes,
    wastedTokens: Math.round(tokensFromBytes(wastedBytes)),
    ratio: judgedReads > 0 ? detections.length / judgedReads : 0,
    top,
    enabled: true,
    truncated: false,
  };
}

/** Drop the per-read detail, keep the numbers the renderer uses. */
export function summarizeReadWaste(report: ReadWasteReport): ReadWasteSummary {
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
