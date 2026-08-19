/**
 * Pure routing logic for PreToolUse hooks.
 * Returns NORMALIZED decision objects (NOT platform-specific format).
 *
 * Decision types:
 * - { action: "deny", reason: string }
 * - { action: "ask" }
 * - { action: "modify", updatedInput: object }
 * - { action: "context", additionalContext: string }
 * - null (passthrough)
 */

import {
  ROUTING_BLOCK, READ_GUIDANCE, GREP_GUIDANCE, BASH_GUIDANCE, EXTERNAL_MCP_GUIDANCE,
  createRoutingBlock, createReadGuidance, createGrepGuidance, createBashGuidance,
  createExternalMcpGuidance,
} from "../routing-block.mjs";
import { createToolNamer } from "./tool-naming.mjs";
import { createHash } from "node:crypto";
import { isMCPReady } from "./mcp-ready.mjs";
import { existsSync, mkdirSync, rmSync, rmdirSync, readdirSync, unlinkSync, openSync, closeSync, readFileSync, writeFileSync, statSync, constants as fsConstants } from "node:fs";

/**
 * Guard for actions that redirect to MCP tools (#230).
 * If MCP server isn't ready, returns null (passthrough) instead of the
 * redirect action — prevents agent from getting stuck when MCP tools
 * are unavailable. Applies to deny and modify actions that mention MCP alternatives.
 */
function mcpRedirect(result, mcpToolsAvailable = true) {
  if (!mcpToolsAvailable) return null;
  if (!isMCPReady()) return null;
  return result;
}
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";

// Guidance throttle: show each advisory type at most once per session.
// Hybrid approach:
//   - In-memory Set for same-process callers (vitest)
//   - File-based markers with O_EXCL for cross-process atomicity
//     (Claude Code and Codex both spawn a fresh hook process per call)
//
// Session identity is resolved in this order:
//   1. sessionId passed in by the caller (stable across hook invocations)
//   2. process.ppid fallback (works on macOS/Linux — host PID is stable)
//
// The ppid fallback is unreliable on Windows + Git Bash, where each hook
// invocation spawns a fresh bash.exe with a different PID (#298). Callers
// that have a stable session identifier (e.g. from the hook payload) should
// pass it to routePreToolUse so the marker directory stays consistent across
// invocations of the same logical session.
const _guidanceShown = new Set();

// Periodic-guidance counters: how many times each (sessionId, type) pair has
// fired the periodic branch. Keyed by `${sessionId-or-ppid}::${type}`.
// File-backed for cross-process so hook invocations from the same logical
// session keep the counter coherent.
const _guidanceCounters = new Map();

// External-MCP nudge cadence — fire every N matching tool calls.
// Default 10: keeps the guidance fresh in long MCP-heavy sessions (e.g. a
// Jira/Slack/Notion run with 50+ tool calls — see #567 follow-up) without
// flooding context with repeat nudges. Bounds [1, 100]; invalid env values
// fall back to default. period=1 means "fire every call" (opt-in only).
const EXTERNAL_MCP_NUDGE_DEFAULT = 10;
const EXTERNAL_MCP_NUDGE_MIN = 1;
const EXTERNAL_MCP_NUDGE_MAX = 100;
const EXTERNAL_MCP_NUDGE_ENV = "CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY";

function getExternalMcpNudgeEvery() {
  const raw = process.env[EXTERNAL_MCP_NUDGE_ENV];
  if (raw == null || raw === "") return EXTERNAL_MCP_NUDGE_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < EXTERNAL_MCP_NUDGE_MIN || parsed > EXTERNAL_MCP_NUDGE_MAX) {
    return EXTERNAL_MCP_NUDGE_DEFAULT;
  }
  return parsed;
}

// #817: size threshold so small Bash calls skip the routing nudge.
//
// PreToolUse fires BEFORE the command runs, so the actual output size is
// unknowable here. The only deterministic pre-execution signal is the command
// string itself. The answer is a matcher that only fires on plausibly
// large-output calls, so lightweight ones pay no hook overhead: when
// CONTEXT_MODE_BASH_NUDGE_MIN_COMMAND_BYTES is set to
// N>0, an unbounded Bash command whose UTF-8 byte length is below N is treated
// as expected-lightweight and the generic routing nudge is suppressed.
//
// Default is 0 (unset) → CURRENT BEHAVIOR: every unbounded command is nudged.
// This preserves the context-saving guarantee for large outputs by default —
// the threshold is strictly opt-in. Bounds [0, 100000]; invalid/zero/negative
// values fall back to 0 (disabled). The threshold gates ONLY the generic Bash
// nudge — curl/wget, inline-HTTP, and build-tool redirects run earlier and are
// never relaxed, because those are deterministic floods regardless of command
// length.
const BASH_NUDGE_MIN_BYTES_ENV = "CONTEXT_MODE_BASH_NUDGE_MIN_COMMAND_BYTES";
const BASH_NUDGE_MIN_BYTES_MAX = 100_000;

function getBashNudgeMinCommandBytes() {
  const raw = process.env[BASH_NUDGE_MIN_BYTES_ENV];
  if (raw == null || raw === "") return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > BASH_NUDGE_MIN_BYTES_MAX) {
    return 0;
  }
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────
// Enforcement: deny where the loss is proven before the call and the
// replacement is mechanical.
//
// The only rules with full adherence today are the ones that deny and hand
// back a ready call: curl/wget, inline HTTP, WebFetch. Everything else is
// advice competing with habit, and habit wins. What follows extends the deny
// list — but only as far as the measurements support, and no further.
//
// Read is the clean case: statSync gives the size BEFORE the call, so the loss
// is not a guess, and ctx_execute_file answers the same question in 529 B where
// Read spends 34 KB (BENCHMARK.md Part 4). Named heavy Bash commands are the
// same shape.
//
// Grep and Glob are NOT that case, and the same measurements say so: ctx_find
// returns 2.6 KB against 0.7 KB for `rg -l` — four times worse on bytes for a
// single lookup, and ranked rather than exhaustive. Its win is replacing a
// SEQUENCE (locate, then read three files whole), which the hook cannot see
// from one call. So they escalate to `ask` for the plainly unbounded case and
// stay available: an exhaustive literal sweep is exactly what ctx_find does
// not do, and taking it away would remove a capability rather than route it.
// ─────────────────────────────────────────────────────────────────────────

const READ_DENY_BYTES_ENV = "CONTEXT_MODE_READ_DENY_BYTES";
/** Historical large-read threshold, kept as the default for both uses below. */
const READ_ACCOUNTING_DEFAULT_BYTES = 50_000;

/**
 * Marker type meaning "this call is already accounted for, and saved nothing".
 *
 * Exported so hooks/posttooluse.mjs recognises it without a second copy of the
 * string: PostToolUse treats a marker of this type as proof the call was
 * routed, and emits no savings event for it. Shared constant rather than two
 * literals, because a typo on either side silently restores the loop the
 * marker exists to break.
 */
export const READ_EDIT_EXEMPT_TYPE = "read-edit-exempt";
const READ_EDIT_WINDOW_ENV = "CONTEXT_MODE_READ_EDIT_WINDOW_MS";
const BASH_DENY_COMMANDS_ENV = "CONTEXT_MODE_BASH_DENY_COMMANDS";
const GREP_ASK_ENV = "CONTEXT_MODE_GREP_ASK";

/**
 * Size at or above which reading a whole file is refused.
 *
 * Defaults to the 50 000 bytes the large-read byte accounting has always used,
 * so the number the agent is refused at and the number ctx_stats reports as
 * avoided are one number. `0` disables the refusal and leaves the advisory.
 *
 * @param {Record<string, string | undefined>} [env]
 */
function readDenyBytes(env = process.env) {
  const raw = Number.parseInt(env[READ_DENY_BYTES_ENV] ?? "", 10);
  if (!Number.isFinite(raw) || raw < 0) return READ_ACCOUNTING_DEFAULT_BYTES;
  return raw;
}

/**
 * Size above which a read is recorded as a large one, whatever happened to it.
 *
 * This is where the promise above is actually kept. It used to be a literal
 * 50 000 in two branches, which made the two numbers one number only on the
 * default: with CONTEXT_MODE_READ_DENY_BYTES=10000 the refusal fired at 10 KB
 * while the accounting still started at 50 KB, so every file between them was
 * refused and never counted — the tool reported saving nothing on exactly the
 * reads the operator had asked it to be strictest about.
 *
 * The one case where they legitimately part: `0` turns the refusal off, and a
 * threshold of zero would then mark every read of any size as large. With no
 * refusal number to agree with, accounting keeps its own default.
 */
function readAccountingBytes(env = process.env) {
  return readDenyBytes(env) || READ_ACCOUNTING_DEFAULT_BYTES;
}

/**
 * How long after a refusal the same path may be read anyway.
 *
 * This window IS the edit escape hatch. Read-before-Edit has to keep working —
 * Edit matches against the exact bytes in the conversation, so a plugin that
 * refuses the read breaks the main job rather than routing it — and intent is
 * not visible in the call: a 60 KB file being read to edit and one being read
 * to summarise are the same request. So the refusal asks the caller to say
 * which it is, in the only vocabulary available to it: repeat the call.
 *
 * @param {Record<string, string | undefined>} [env]
 */
function readEditWindowMs(env = process.env) {
  const raw = Number.parseInt(env[READ_EDIT_WINDOW_ENV] ?? "", 10);
  if (!Number.isFinite(raw) || raw <= 0) return 120_000;
  return raw;
}

/** Marker path for one refused file, inside the per-session guidance dir. */
function readRetryMarker(sessionId, filePath) {
  const key = createHash("sha256").update(String(filePath)).digest("hex").slice(0, 32);
  return resolve(guidanceDirFor(sessionId), `read-retry-${key}`);
}

/** Record that this path was just refused, opening the retry window. */
function armReadRetry(sessionId, filePath) {
  try {
    const dir = guidanceDirFor(sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(readRetryMarker(sessionId, filePath), String(Date.now()), "utf8");
  } catch { /* a marker we cannot write costs the escape hatch a round trip */ }
}

/**
 * Is this path inside its retry window?
 *
 * The window grants the path, not one call: Read → Edit → Read again to check
 * the result is a normal shape, and re-refusing in the middle of it would be
 * the false positive this whole mechanism exists to avoid.
 */
function readRetryArmed(sessionId, filePath, env = process.env) {
  try {
    const at = Number.parseInt(readFileSync(readRetryMarker(sessionId, filePath), "utf8"), 10);
    if (!Number.isFinite(at)) return false;
    return Date.now() - at <= readEditWindowMs(env);
  } catch {
    return false;
  }
}

/** A read the caller already bounded (offset/limit) returns a slice, not the file. */
function isBoundedRead(toolInput) {
  const limit = toolInput?.limit ?? toolInput?.length ?? toolInput?.Limit;
  return typeof limit === "number" && limit > 0;
}

/**
 * Commands whose output is known to be large before they run.
 *
 * Deliberately four entries and not a taxonomy: every addition is a command
 * someone will legitimately want to run and watch, and the list only earns its
 * place while every entry is obviously right.
 *
 * Entries are case-insensitive regular expressions matched against the
 * quote-stripped command, so `echo "npm test"` does not trip it. Regex rather
 * than substring because the precision matters in exactly the case that
 * motivated the list: `find /` means a sweep of the root, while `find /etc
 * -name '*.conf'` is a small bounded search that happens to start with the
 * same eight characters. An entry that fails to compile is matched literally
 * instead, so a hand-written config never silently disables the rule.
 *
 * Configurable as a comma-separated list; an empty value turns it off.
 */
const HEAVY_BASH_COMMANDS = ["npm test", "docker logs", "git log -p", "find /(\\s|$)"];

/** @param {Record<string, string | undefined>} [env] */
function heavyBashCommands(env = process.env) {
  const raw = env[BASH_DENY_COMMANDS_ENV];
  if (raw === undefined) return HEAVY_BASH_COMMANDS;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** @returns {string | null} the matched entry, or null */
function matchedHeavyBash(strippedCommand, env = process.env) {
  const haystack = String(strippedCommand ?? "");
  for (const entry of heavyBashCommands(env)) {
    let hit = false;
    try {
      hit = new RegExp(entry, "i").test(haystack);
    } catch {
      hit = haystack.toLowerCase().includes(entry.toLowerCase());
    }
    if (hit) return entry;
  }
  return null;
}

/** @param {Record<string, string | undefined>} [env] */
function grepAskEnabled(env = process.env) {
  return env[GREP_ASK_ENV] !== "0";
}

/**
 * A search with nothing narrowing it: no directory, no file filter, no result
 * cap, and asking for matching lines rather than file names.
 *
 * All four conditions together, because each one alone is ordinary. `rg -l`
 * over the whole tree costs 0.7 KB and is the cheapest way to answer "where" —
 * refusing to let it run would be routing a call that is already cheap. It is
 * the content mode without any bound that spends 34 KB.
 */
function isUnboundedGrep(toolInput) {
  const ti = toolInput ?? {};
  if (ti.path || ti.glob || ti.type || ti.include) return false;
  if (ti.head_limit !== undefined || ti.limit !== undefined) return false;
  const mode = ti.output_mode ?? ti.outputMode;
  return mode === "content";
}

/** A glob with no directory and a pattern that matches the whole tree. */
function isUnboundedGlob(toolInput) {
  const ti = toolInput ?? {};
  if (ti.path) return false;
  const pattern = String(ti.pattern ?? ti.glob ?? "").trim();
  return pattern === "*" || pattern === "**" || pattern === "**/*" || pattern === "**/*.*";
}

/**
 * The refusal text for reading a whole file, in one place.
 *
 * Written once and used by both the size rule and the escalation ladder, so
 * the escape hatch cannot exist in one of them and not the other — a refusal
 * that forgets to say how to get through is the expensive failure here, not
 * the leak it prevents.
 *
 * The word "redirected" and the replacement call share a line deliberately:
 * the ADR-0003 contract test reads this file line by line.
 */
function readDenyReason(t, filePath, size, env = process.env) {
  const kb = (size / 1024).toFixed(1);
  const seconds = Math.round(readEditWindowMs(env) / 1000);
  const pathJson = JSON.stringify(filePath);
  return (
    `context-mode: Read redirected — this file is ${kb} KB and would enter your conversation whole. Call ${t("ctx_read")}(path: ${pathJson}) to get its shape and the regions you asked for, or ${t("ctx_execute_file")}(path: ${pathJson}, language: "javascript", code: "…") when the answer needs code; either way only the answer comes back, not the file.\n` +
    `Reading it in order to EDIT it? Call Read again on this same path — the repeat is allowed for the next ${seconds}s, because Edit matches against the exact bytes in your conversation and a summary is not those bytes.\n` +
    `Reading one region? Pass offset and limit and it goes through unchanged. Tune with ${READ_DENY_BYTES_ENV} (bytes; 0 turns this off) and ${READ_EDIT_WINDOW_ENV} (retry window).`
  );
}

/** The refusal text for a command whose output belongs in the index. */
function bashDenyReason(t, command, opening) {
  const asJson = JSON.stringify(command);
  const label = JSON.stringify(command.slice(0, 60));
  return (
    `context-mode: Bash redirected — ${opening} Call ${t("ctx_batch_execute")}(commands: [{label: ${label}, command: ${asJson}}], queries: ["what failed", "errors"]) instead: the output is indexed and only the sections answering your questions come back.`
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Escalation: the price of a violation grows instead of resetting.
//
// The advisory used to fire once per session per tool and then go quiet
// forever, latched by an O_CREAT|O_EXCL marker so even a second hook process
// could not repeat it. The first Read of a session got advice; the two
// hundredth got silence. Long sessions are exactly the ones where the rules
// matter most, and they are also the ones where compaction has already
// removed the rules from the system text.
//
// What replaces it is a function of behaviour, not of call ordinality. The
// tally of unrouted heavy calls only grows within a session, so severity
// derived from it can only grow too — that monotonicity is the property, and
// it is asserted directly in the tests rather than inferred.
//
// Four steps, and the first one is silence: a session that routes its heavy
// work says nothing at all, which is not a softer requirement than the others.
// The steps above it move the same lever the enforcement rules above already
// pull (context → ask → deny, with the same ready replacement calls and the
// same edit escape hatch) rather than opening a second, parallel ladder.
//
// Grep tops out at `ask` on purpose. ctx_find ranks where Grep enumerates
// (BENCHMARK.md Part 4), so no amount of accumulated leakage makes refusing an
// exhaustive sweep the right answer — escalation raises the price of a call,
// it does not invent a capability the replacement lacks.
// ─────────────────────────────────────────────────────────────────────────

const NUDGE_AFTER_CALLS_ENV = "CONTEXT_MODE_NUDGE_AFTER_CALLS";
const NUDGE_AFTER_BYTES_ENV = "CONTEXT_MODE_NUDGE_AFTER_BYTES";

/** Steps of the ladder, in order of severity. */
export const ESCALATION_SILENT = 0;
export const ESCALATION_ADVISE = 1;
export const ESCALATION_ASK = 2;
export const ESCALATION_DENY = 3;

/** @param {Record<string, string | undefined>} [env] */
function nudgeAfterCalls(env = process.env) {
  const raw = Number.parseInt(env[NUDGE_AFTER_CALLS_ENV] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
}

/** @param {Record<string, string | undefined>} [env] */
function nudgeAfterBytes(env = process.env) {
  const raw = Number.parseInt(env[NUDGE_AFTER_BYTES_ENV] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 100 * 1024;
}

/** Where PostToolUse leaves the running tally for PreToolUse to read. */
function unroutedTallyPath(sessionId) {
  return resolve(guidanceDirFor(sessionId), "unrouted-tally.json");
}

/**
 * Publish the tally so the NEXT PreToolUse can price its decision.
 *
 * PreToolUse runs in front of every tool call on a budget measured in
 * milliseconds; opening SQLite there to count events would tax every call in
 * the session to inform the few that need it. PostToolUse has the database
 * open already and has just counted (see readMissedRedirectTally), so it
 * writes the two numbers down and PreToolUse reads one small file.
 *
 * Not new telemetry: the same rows, the same count, one hop.
 */
export function writeUnroutedTally(sessionId, tally) {
  try {
    const dir = guidanceDirFor(sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      unroutedTallyPath(sessionId),
      JSON.stringify({ count: tally?.count ?? 0, bytes: tally?.bytes ?? 0 }),
      "utf8",
    );
  } catch { /* the ladder degrades to the advisory when it cannot see */ }
}

/**
 * @returns {{count: number, bytes: number} | null} null when there is nothing
 *   to read — no session id, no PostToolUse has run, an unreadable store. The
 *   distinction between "nothing has leaked" and "cannot tell" is the whole
 *   reason this returns null rather than zeroes: the first means silence, the
 *   second has to mean the pre-existing behaviour.
 */
export function readUnroutedTally(sessionId) {
  try {
    const parsed = JSON.parse(readFileSync(unroutedTallyPath(sessionId), "utf8"));
    const count = Number(parsed?.count);
    const bytes = Number(parsed?.bytes);
    if (!Number.isFinite(count) || !Number.isFinite(bytes)) return null;
    return { count, bytes };
  } catch {
    return null;
  }
}

/**
 * How far up the ladder this session has climbed.
 *
 * Whichever of the two thresholds is further along wins, and each further
 * multiple of it is one more step: three unrouted heavy calls (or 100 KB) buys
 * the advisory back, six (or 200 KB) turns it into a confirmation, nine (or
 * 300 KB) into a refusal. Capped there — there is no step past refusing.
 *
 * @returns {number} 0 silent · 1 advise · 2 ask · 3 deny
 */
export function escalationLevel(tally, env = process.env) {
  if (!tally) return ESCALATION_SILENT;
  const byCalls = Math.floor((Number(tally.count) || 0) / nudgeAfterCalls(env));
  const byBytes = Math.floor((Number(tally.bytes) || 0) / nudgeAfterBytes(env));
  return Math.min(ESCALATION_DENY, Math.max(0, byCalls, byBytes));
}

/** The number the agent is being told about, in one sentence. */
function tallyLine(tally) {
  const count = tally?.count ?? 0;
  const bytes = formatNoticeBytes(tally?.bytes ?? 0);
  return `${count} unrouted heavy call${count === 1 ? "" : "s"} so far this session, ${bytes} of it straight into your context window.`;
}

/** Why the tone just changed, and which knobs move it back. */
function escalationNote(tally, env = process.env) {
  return `${tallyLine(tally)} That is why this is no longer a suggestion — the steps are set by ${NUDGE_AFTER_CALLS_ENV} (${nudgeAfterCalls(env)}) and ${NUDGE_AFTER_BYTES_ENV} (${nudgeAfterBytes(env)} bytes), each further multiple raising it again.`;
}

function defaultGuidanceId() {
  return process.env.VITEST_WORKER_ID
    ? `${process.ppid}-w${process.env.VITEST_WORKER_ID}`
    : String(process.ppid);
}

function guidanceDirFor(sessionId) {
  const id = sessionId ? `s-${sessionId}` : defaultGuidanceId();
  return resolve(tmpdir(), `context-mode-guidance-${id}`);
}

function guidanceOnce(type, content, sessionId) {
  // Fast path: in-memory (same process)
  if (_guidanceShown.has(type)) return null;

  // Resolve marker directory for this session (stable even on Windows/Git Bash
  // where process.ppid shifts every invocation — see #298).
  const dir = guidanceDirFor(sessionId);
  try { mkdirSync(dir, { recursive: true }); } catch {}

  // Atomic create-or-fail: O_CREAT | O_EXCL | O_WRONLY
  // First process to create the file wins; others get EEXIST.
  const marker = resolve(dir, type);
  try {
    const fd = openSync(marker, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
    closeSync(fd);
  } catch {
    // EEXIST = another process already created it, or we did in-memory
    _guidanceShown.add(type);
    return null;
  }

  _guidanceShown.add(type);
  return { action: "context", additionalContext: content };
}

/**
 * Like guidanceOnce, but fires on a periodic cadence (calls 1, period+1,
 * 2·period+1, …) rather than once per session.
 *
 * Motivation: external-MCP tool runs can span 50+ calls (e.g. a Jira/Slack
 * search loop — see #567 follow-up). A single one-shot nudge gets lost
 * after the model's context compaction kicks in, and subsequent large MCP
 * payloads flood context unchecked. Re-firing the nudge every N calls
 * keeps the guidance in the model's recent window without saturating it.
 *
 * Counter state is process-aware: in-memory Map for same-process callers,
 * file-backed `<guidanceDir>/<type>.count` for cross-process hook
 * invocations. On any IO/parse failure we fall back to firing — losing a
 * counter is preferable to silently dropping the advisory.
 */
function guidancePeriodic(type, content, sessionId, period) {
  const safePeriod = Math.max(1, period | 0);
  const id = sessionId ? `s-${sessionId}` : defaultGuidanceId();
  const key = `${id}::${type}`;

  // Read counter from memory first; fall through to disk on miss.
  let count = _guidanceCounters.get(key);
  const dir = guidanceDirFor(sessionId);
  const counterPath = resolve(dir, `${type}.count`);

  if (count == null) {
    try {
      const parsed = Number.parseInt(readFileSync(counterPath, "utf8"), 10);
      count = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    } catch {
      count = 0;
    }
  }

  const next = count + 1;
  _guidanceCounters.set(key, next);

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(counterPath, String(next), "utf8");
  } catch {
    // Best-effort: cross-process counter may drift on FS failure, but we
    // still return a decision based on the in-memory tick.
  }

  // Fire on the 1st, (period+1)th, (2·period+1)th… call.
  if ((next - 1) % safePeriod !== 0) return null;
  return { action: "context", additionalContext: content };
}

/**
 * Robust recursive delete. On Windows, `fs.rmSync` on directories under a
 * tmpdir whose path contains non-ASCII characters (e.g. a Chinese / Japanese /
 * Korean username) silently no-ops without throwing — see #454. Fall back to a
 * manual unlink + rmdir walk so the marker dir actually goes away.
 */
function rmSyncRobust(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
  if (!existsSync(dir)) return;
  // Manual fallback for Windows + non-ASCII tmpdir paths
  try {
    for (const name of readdirSync(dir)) {
      try { unlinkSync(resolve(dir, name)); } catch {}
    }
    rmdirSync(dir);
  } catch {}
}

export function resetGuidanceThrottle(sessionId) {
  _guidanceShown.clear();
  _guidanceCounters.clear();
  // Clear ppid-based dir (legacy / fallback callers) and the sessionId dir if given
  rmSyncRobust(guidanceDirFor());
  if (sessionId) {
    rmSyncRobust(guidanceDirFor(sessionId));
  }
}

/**
 * Strip heredoc content from a shell command.
 * Handles: <<EOF, <<"EOF", <<'EOF', <<-EOF (indented), with optional spaces.
 */
function stripHeredocs(cmd) {
  return cmd.replace(/<<-?\s*["']?(\w+)["']?[\s\S]*?\n\s*\1/g, "");
}

/**
 * Strip ALL quoted content from a shell command so regex only matches command tokens.
 * Removes heredocs, single-quoted strings, and double-quoted strings.
 * This prevents false positives like: gh issue edit --body "text with curl in it"
 */
function stripQuotedContent(cmd) {
  return stripHeredocs(cmd)
    .replace(/'[^']*'/g, "''")                    // single-quoted strings
    .replace(/"[^"]*"/g, '""');                   // double-quoted strings
}

/**
 * Built-in allowlist of structurally-bounded Bash commands (#463).
 *
 * The PreToolUse Bash nudge ("May produce large output. Use ctx_…") is
 * tuned for unbounded commands like `find /` or `cat large-file`. On
 * commands whose stdout is structurally bounded (system probes, version
 * checks, simple git read subcommands), the nudge is pure noise — a
 * recurring ~85 tokens that trains the agent to ignore the warning.
 *
 * isStructurallyBounded() returns true ONLY when the command:
 *   1. Has no shell control operators (pipe, redirect, command
 *      substitution, &&, ||, ;) — any of those can compose with an
 *      unbounded command and re-introduce flooding.
 *   2. Matches one of the conservative patterns below.
 *
 * Unknown commands are treated as unbounded (false) — fail-safe default.
 */
const SAFE_COMMAND_PATTERNS = [
  // System probes (no stdout, or one short line)
  // Defense-in-depth (#470): trailing wildcards use `[^\r\n]+` instead of
  // `.+`. The primary gate is SHELL_CONTROL_OPERATORS, which already rejects
  // `\n` / `\r`, but in JS regex `\s` matches LF/CR too — so a pattern like
  // `\s+.+$` would silently span a newline if the operator gate ever
  // regressed. Anchoring `.+` to a single line removes that latent footgun.
  /^pwd$/,
  /^whoami$/,
  /^hostname(?:\s+-[a-zA-Z]+)?$/,
  // uname (#517): short-flag probes only (`-a`, `-srm`). No path operands —
  // uname doesn't take any, and refusing them keeps the pattern strict.
  /^uname(?:\s+-[a-zA-Z]+)?$/,
  // id (#517): bare `id`, single short flag (`-u`, `-g`), or single user
  // operand (`id mksglu`). Output is one line — bounded by definition.
  /^id(?:\s+\S+)?$/,
  /^date(?:\s+[^\r\n]+)?$/,
  /^echo\s/,
  /^printf\s/,
  /^which\s+\S+(?:\s+\S+)*$/,
  /^type\s+\S+(?:\s+\S+)*$/,
  /^command\s+-v\s+\S+(?:\s+\S+)*$/,
  /^readlink(?:\s+[^\r\n]+)?$/,
  /^basename(?:\s+[^\r\n]+)?$/,
  /^dirname(?:\s+[^\r\n]+)?$/,
  // realpath (#517): canonical path resolution prints one line per operand.
  // Same shape as readlink — single-line `[^\r\n]+` to mirror the operator-gate
  // defense-in-depth from #470.
  /^realpath(?:\s+[^\r\n]+)?$/,
  // Filesystem ops (silent on success, errors on stderr only).
  // For cp / mv / rm we explicitly refuse `-v` / `--verbose`: verbose
  // mode prints one line per file and can flood on big trees
  // (recursive copy of /etc, mass rename, etc.). The "silent on
  // success" invariant only holds without -v.
  /^cd(?:\s+[^\r\n]+)?$/,
  /^mkdir(?:\s+[^\r\n]+)?$/,
  /^touch\s+[^\r\n]+$/,
  // #517 follow-up: the original `(?!\s+-[a-zA-Z]*v\b)` required `v` to be
  // the LAST alpha char in the flag bundle, so `-vs`, `-vfr`, `-rvf`,
  // `-sfvr`, etc. silently slipped past the carve-out and flooded.
  // `(?!\s+-[a-zA-Z]*v[a-zA-Z]*)` catches `v` anywhere in the bundle.
  /^mv(?!\s+-[a-zA-Z]*v[a-zA-Z]*)(?!\s+--verbose\b)\s+[^\r\n]+$/,
  /^cp(?!\s+-[a-zA-Z]*v[a-zA-Z]*)(?!\s+--verbose\b)\s+[^\r\n]+$/,
  /^rm(?!\s+-[a-zA-Z]*v[a-zA-Z]*)(?!\s+--verbose\b)\s+[^\r\n]+$/,
  // ln (#517): silent on success — same `-v` / `--verbose` carve-out as
  // cp/mv/rm. Bulk symlink operations with -v flood one line per link.
  /^ln(?!\s+-[a-zA-Z]*v[a-zA-Z]*)(?!\s+--verbose\b)\s+[^\r\n]+$/,
  // ls — refuse recursive (-R / --recursive) to keep output bounded.
  /^ls(?!\s+-[a-zA-Z]*R)(?!\s+--recursive)(?:\s+[^\r\n]+)?$/,
  // git read-only / status subcommands
  /^git\s+status(?:\s+[^\r\n]+)?$/,
  /^git\s+rev-parse(?:\s+[^\r\n]+)?$/,
  /^git\s+remote(?:\s+-v|\s+show\s+\S+)?$/,
  /^git\s+branch(?:\s+[^\r\n]+)?$/,
  /^git\s+config\s+--get(?:\s+[^\r\n]+)?$/,
  /^git\s+diff\s+--stat(?:\s+[^\r\n]+)?$/,
  /^git\s+diff\s+--name-only(?:\s+[^\r\n]+)?$/,
  /^git\s+stash\s+list$/,
  /^git\s+tag(?:\s+-l(?:\s+[^\r\n]+)?)?$/,
  // git log only when explicitly bounded by -<N> with N up to two digits
  /^git\s+log\s+-\d{1,2}(?:\s+[^\r\n]+)?$/,
  // Version probes (--version anywhere, or `cmd -V`)
  /(?:^|\s)--version(?:\s|$)/,
  /^\S+\s+-V(?:\s|$)/,
  // Mutating git plumbing whose stdout is a fixed handful of lines.
  // Same "silent or near-silent on success" invariant as cp/mv/rm above:
  // these report what they did, not the data they touched.
  /^git\s+add(?:\s+[^\r\n]+)?$/,
  /^git\s+commit(?:\s+[^\r\n]+)?$/,
  /^git\s+push(?:\s+[^\r\n]+)?$/,
  /^git\s+pull(?:\s+[^\r\n]+)?$/,
  /^git\s+fetch(?:\s+[^\r\n]+)?$/,
  /^git\s+switch(?:\s+[^\r\n]+)?$/,
  /^git\s+checkout(?:\s+[^\r\n]+)?$/,
  /^git\s+stash(?:\s+(?:push|pop|apply|drop)(?:\s+[^\r\n]+)?)?$/,
  /^git\s+init(?:\s+[^\r\n]+)?$/,
  // Silent-on-success filesystem/process ops. `-v` / `-c` (chmod's
  // --changes) print one line per file, so they are carved out exactly
  // like the cp/mv/rm patterns above.
  /^chmod(?!\s+-[a-zA-Z]*[vc][a-zA-Z]*)(?!\s+--verbose\b)(?!\s+--changes\b)\s+[^\r\n]+$/,
  /^chown(?!\s+-[a-zA-Z]*[vc][a-zA-Z]*)(?!\s+--verbose\b)(?!\s+--changes\b)\s+[^\r\n]+$/,
  /^kill(?:\s+[^\r\n]+)?$/,
  /^pkill(?:\s+[^\r\n]+)?$/,
  /^sleep\s+\S+$/,
  /^mktemp(?:\s+[^\r\n]+)?$/,
];

// ─── User-extensible allowlist (#463 follow-up) ───
//
// Every project has bounded commands the built-in list cannot know about
// (`ssh prod-web systemctl is-active nginx`, `docker compose ps`, an
// in-house CLI that prints one status line). Without an extension point the
// only options are "eat the nudge on every call" or "widen the built-in
// list for everyone" — the first trains the agent to ignore warnings, the
// second weakens the default for people who never asked for it.
//
// Two sources, both optional:
//   CONTEXT_MODE_SAFE_COMMANDS       — patterns separated by `|||`
//   CONTEXT_MODE_SAFE_COMMANDS_FILE  — file with one pattern per line
//                                      (`#` comments and blanks ignored)
//   default file: <configDir>/context-mode/safe-commands.txt
//
// Each line is a JS regex source compiled with `new RegExp(line)`. User
// patterns are consulted AFTER SHELL_CONTROL_OPERATORS has already rejected
// pipes, redirects, substitutions and separators, so a sloppy user pattern
// widens the nudge carve-out — it cannot widen what the shell may run, and
// it never touches the CASE B security deny gate.
const USER_PATTERN_LIMIT = 200;
const USER_PATTERN_MAX_LENGTH = 500;

// Inlined config-dir resolution — same contract as
// session-helpers.mjs::resolveConfigDir, kept local so the allowlist lookup
// adds no import to a module that runs on every Bash call.
function resolveConfigDirSafe() {
  const envVal = process.env.CLAUDE_CONFIG_DIR;
  if (envVal) {
    if (envVal.startsWith("~")) return resolve(homedir(), envVal.replace(/^~[/\\]?/, ""));
    return envVal;
  }
  return resolve(homedir(), ".claude");
}

/** @type {RegExp[] | null} */
let _userSafePatterns = null;

/** Reset the memoized user allowlist. Test seam. */
export function resetUserSafePatterns() {
  _userSafePatterns = null;
}

/**
 * @param {string[]} lines Raw pattern sources.
 * @returns {RegExp[]} Compiled patterns; unparseable ones are skipped.
 */
function compileUserPatterns(lines) {
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.length > USER_PATTERN_MAX_LENGTH) continue;
    if (out.length >= USER_PATTERN_LIMIT) break;
    try {
      out.push(new RegExp(line));
    } catch {
      // Malformed pattern — skip it rather than take the whole hook down.
      // The hook runs on every Bash call; a throw here would be a hard stop.
    }
  }
  return out;
}

/**
 * @returns {RegExp[]} User-supplied bounded-command patterns (possibly empty).
 */
function getUserSafePatterns() {
  if (_userSafePatterns) return _userSafePatterns;

  const lines = [];

  const inline = process.env.CONTEXT_MODE_SAFE_COMMANDS;
  if (inline) lines.push(...inline.split("|||"));

  try {
    const filePath =
      process.env.CONTEXT_MODE_SAFE_COMMANDS_FILE ||
      resolve(resolveConfigDirSafe(), "context-mode", "safe-commands.txt");
    if (existsSync(filePath)) {
      lines.push(...readFileSync(filePath, "utf-8").split(/\r?\n/));
    }
  } catch {
    // No file access / no config dir — inline patterns still apply.
  }

  _userSafePatterns = compileUserPatterns(lines);
  return _userSafePatterns;
}

// Bash shell control operators that can compose a safe command with an
// unbounded sink. Any match disqualifies the command from the allowlist.
//
// Note `&` (single — background + sequence): listed BEFORE `&&` in the
// alternation so the regex engine doesn't accidentally short-match `&&`
// when `&` is itself a separator (`date & cat huge.log`). Without this,
// `^date(?:\s+.+)?$` would match the whole string and bypass the gate.
//
// `\n` / `\r` (newline injection — #470): bash treats LF as a statement
// separator equivalent to `;`. CRLF (Windows clipboard paste) and bare CR
// fall in the same defect class. Without these, `git status\nfind /`
// would short-match the single-line `^git\s+status` pattern and bypass
// the gate entirely.
const SHELL_CONTROL_OPERATORS = /[|`\n\r]|\$\(|>>|>|<(?!<)|&(?!&)|&&|\|\||;/;

/**
 * @param {string} command Raw Bash command string from the hook payload.
 * @returns {boolean} true when the command's output is bounded enough that
 *   the routing nudge would be noise. Conservative — unknown commands
 *   return false.
 */
export function isStructurallyBounded(command) {
  if (!command) return false;
  const trimmed = command.trim();
  if (SHELL_CONTROL_OPERATORS.test(trimmed)) return false;
  if (SAFE_COMMAND_PATTERNS.some(rx => rx.test(trimmed))) return true;
  return getUserSafePatterns().some(rx => rx.test(trimmed));
}

// Try to import security module — may not exist
let security = null;
let securityInitFailed = false;

/**
 * @returns {boolean} true if security module loaded successfully.
 *
 * Loud fail: if neither the esbuild bundle nor `build/security.js` is
 * importable, log a clear stderr warning instead of swallowing the error
 * silently. Without this, user-configured `permissions.deny` patterns
 * (#466) become no-ops with no indication that policy enforcement is
 * disabled — a fail-open security regression.
 *
 * ─── Resolution order (#558) ───────────────────────────────────────────
 *
 *   1. `hooks/security.bundle.mjs` — esbuild output, sibling of routing.mjs's
 *      parent. Marketplace installs (`git clone` install path) ship this
 *      bundle via CI's `git add -f`, so it's the only artifact reliably
 *      present across BOTH `npm install` (build/ generated by tsc) AND
 *      marketplace install (build/ excluded by .gitignore, never built).
 *
 *   2. `<buildDir>/security.js` — tsc output. Present after `npm run build`.
 *      Kept as a fallback so source checkouts that bypass `npm run bundle`
 *      still degrade gracefully to the tsc-emitted module.
 *
 * Bundle path is computed from `import.meta.url` (sibling layout:
 * `hooks/core/routing.mjs` → `hooks/security.bundle.mjs`).
 * `CONTEXT_MODE_SECURITY_BUNDLE_PATH` is a test seam — it lets
 * subprocess-based tests stage a bundle in tmpdir without polluting the
 * repo's hooks/ directory.
 */
export async function initSecurity(buildDir) {
  const { existsSync } = await import("node:fs");
  const { resolve, dirname } = await import("node:path");
  const { fileURLToPath, pathToFileURL } = await import("node:url");

  // Default: <hooks/core/ dir>/../security.bundle.mjs → hooks/security.bundle.mjs.
  const defaultBundlePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "security.bundle.mjs",
  );
  const bundlePath = process.env.CONTEXT_MODE_SECURITY_BUNDLE_PATH || defaultBundlePath;
  const secPath = resolve(buildDir, "security.js");

  // Bundle-first: marketplace installs ship the bundle, never the build/ dir.
  if (existsSync(bundlePath)) {
    try {
      security = await import(pathToFileURL(bundlePath).href);
      return true;
    } catch (err) {
      if (!securityInitFailed && !process.env.CONTEXT_MODE_SUPPRESS_SECURITY_WARNING) {
        process.stderr.write(
          `[context-mode] WARNING: failed to load security bundle (${bundlePath}) — deny patterns NOT enforced: ${err?.message ?? err}\n`,
        );
      }
      securityInitFailed = true;
      return false;
    }
  }

  // Fallback: tsc-emitted build/security.js (source checkout + `npm run build`).
  if (existsSync(secPath)) {
    try {
      security = await import(pathToFileURL(secPath).href);
      return true;
    } catch (err) {
      if (!securityInitFailed && !process.env.CONTEXT_MODE_SUPPRESS_SECURITY_WARNING) {
        process.stderr.write(
          `[context-mode] WARNING: failed to load security module — deny patterns NOT enforced: ${err?.message ?? err}\n`,
        );
      }
      securityInitFailed = true;
      return false;
    }
  }

  // Neither artifact present — preserve fail-open with an actionable warning
  // that mentions BOTH paths so users on either install model can self-diagnose.
  if (!securityInitFailed && !process.env.CONTEXT_MODE_SUPPRESS_SECURITY_WARNING) {
    process.stderr.write(
      `[context-mode] WARNING: security module not found — security deny patterns will NOT be enforced.\n` +
        `  Searched: ${bundlePath} (bundle) and ${secPath} (build).\n` +
        `  Marketplace installs ship hooks/security.bundle.mjs via CI; for source checkouts run \`npm run bundle\` (or \`npm run build\`).\n` +
        `  Set CONTEXT_MODE_SUPPRESS_SECURITY_WARNING=1 to silence.\n`,
    );
  }
  securityInitFailed = true;
  return false;
}

/** @returns {boolean} true if a previous initSecurity() call failed to load the module. */
export function isSecurityInitFailed() {
  return securityInitFailed;
}

/**
 * Build the agent-facing additionalContext block surfacing the security
 * init failure (#558).
 *
 * Pre-558 the only signal of a fail-open security regression was a
 * stderr WARNING line that adapters typically suppress / discard. The
 * user had no in-band signal that `permissions.deny` was no-op'd.
 *
 * Returns a structured XML-ish block when initSecurity() has failed,
 * `null` otherwise. SessionStart hooks append the block to their
 * additionalContext so the agent (and through the agent, the user)
 * sees the warning the next time they view the session — not just in
 * suppressed stderr.
 *
 * The block format intentionally mirrors the `<context_guidance>`
 * shape used elsewhere in routing so existing prompt-template
 * scaffolding picks it up without special-casing.
 */
export function buildSecurityWarningContext() {
  if (!securityInitFailed) return null;
  return [
    "<context_mode_security_warning>",
    "  <severity>HIGH</severity>",
    "  <issue>",
    "    The context-mode security module failed to load.",
    "    User-configured `permissions.deny` patterns are NOT being enforced.",
    "    Bash commands and file operations bypass the deny gate (fail-open).",
    "  </issue>",
    "  <root_cause>",
    "    `hooks/security.bundle.mjs` (and `build/security.js`) are absent or unloadable.",
    "    Common on marketplace installs where `build/` is gitignored and the",
    "    bundle was missing prior to v1.0.127.",
    "  </root_cause>",
    "  <fix>",
    "    Run `npm run bundle` from the context-mode source checkout, OR",
    "    upgrade context-mode to v1.0.127+ (which ships hooks/security.bundle.mjs",
    "    via CI). To opt in to fail-CLOSED instead, set CONTEXT_MODE_REQUIRE_SECURITY=1.",
    "    To silence this warning while you investigate, set CONTEXT_MODE_SUPPRESS_SECURITY_WARNING=1.",
    "  </fix>",
    "</context_mode_security_warning>",
  ].join("\n");
}

/**
 * Normalize platform-specific tool names to canonical (Claude Code) names.
 *
 * Evidence: https://github.com/openai/codex (shell, read_file, grep_files,
 * container.exec).
 */
/**
 * Native tool names that mean the same thing as a Claude Code tool.
 *
 * Claude Code needs no entries — its names are the canonical ones. Codex has
 * several names for running a command (the executor changed shape across
 * releases and the older ones still appear in the wild), plus its own name for
 * search, and all of them have to reach the same routing branch or the
 * enforcement rules simply do not fire on that host.
 *
 * `Shell` is kept as an alias in its own right: the Codex PostToolUse hook
 * normalises to it, and the missed-redirect classifier lists it among the
 * tools whose payload lands in the conversation whole.
 */
const TOOL_ALIASES = {
  "shell": "Bash",
  "shell_command": "Bash",
  "exec_command": "Bash",
  "container.exec": "Bash",
  "local_shell": "Bash",
  "Shell": "Bash",
  "grep_files": "Grep",
};

function toolLeafName(toolName) {
  const raw = String(toolName ?? "");
  const withoutMcpPrefix = raw.startsWith("MCP:") ? raw.slice(4) : raw;
  const parts = withoutMcpPrefix.split(/__|\//).filter(Boolean);
  return parts.at(-1) ?? withoutMcpPrefix;
}

function matchesContextModeTool(toolName, ctxName, legacyName) {
  const raw = String(toolName ?? "");
  const leaf = toolLeafName(raw);
  if (leaf === ctxName) return true;
  if (raw.startsWith("MCP:") && leaf === legacyName) return true;
  return raw.includes("context-mode") && leaf === legacyName;
}

// External MCP detection (#529 + 15-adapter coverage follow-up).
//
// Both supported hosts wire MCP tools the same way: `mcp__<server>__<tool>`
// (see core/tool-naming.mjs).
//
// Tools belonging to context-mode itself are excluded — they have dedicated
// routing branches above (ctx_execute, ctx_execute_file, ctx_batch_execute)
// and re-routing them here would double-process the call.
const MCP_PREFIX = "mcp__";
const CONTEXT_MODE_SUBSTRING = "context-mode";

function isExternalMcpTool(toolName) {
  const raw = String(toolName ?? "");

  // Both remaining hosts use the same wire shape: `mcp__<server>__<tool>`.
  if (raw.startsWith(MCP_PREFIX)) {
    const server = raw.slice(MCP_PREFIX.length).split("__")[0];
    if (!server) return false;
    return !server.includes(CONTEXT_MODE_SUBSTRING);
  }

  return false;
}

/**
 * The command, whatever the host called the field.
 *
 * `cmd` is Codex's spelling on some executor shapes; `command` is everyone
 * else's. A field name this layer does not know about is not a parse error —
 * it is an empty command that quietly matches no rule, so the list stays a
 * superset of what the two hosts actually send.
 */
function getShellCommand(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";
  if (typeof toolInput.command === "string") return toolInput.command;
  if (typeof toolInput.cmd === "string") return toolInput.cmd;
  return "";
}

function getReadFilePath(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";
  if (typeof toolInput.file_path === "string") return toolInput.file_path;
  if (typeof toolInput.path === "string") return toolInput.path;
  return "";
}

function getWebFetchUrl(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";
  if (typeof toolInput.url === "string") return toolInput.url;
  return "";
}

/**
 * URLs the WebFetch redirect must NOT touch (upstream #938 / #984 / #1006).
 *
 * An Artifact page is a client-rendered SPA behind the caller's claude.ai
 * login. Claude Code's native WebFetch has a documented exception for these
 * URLs and fetches them with that authenticated session; `ctx_fetch_and_index`
 * does a plain anonymous GET and can only ever retrieve the empty shell
 * (~0.1 KB of "Content is user-generated and unverified").
 *
 * So the blanket redirect is not merely overhead here — it hands the model a
 * plausible-looking empty page with no way to tell it apart from a real one.
 * The only correct routing decision for these URLs is to get out of the way.
 *
 * `CONTEXT_MODE_FETCH_PASSTHROUGH` extends the list (#908): entries separated
 * by `|||`, each either a host suffix (`intranet.corp`) or a regex when it
 * starts with `^`. Host suffixes match the hostname; regexes match the full URL.
 */
const BUILTIN_FETCH_PASSTHROUGH = [
  /^https?:\/\/(?:[\w-]+\.)*claude\.ai\/code\/artifact\//i,
  /^https?:\/\/(?:[\w-]+\.)*claude\.ai\/public\/artifacts\//i,
  /^https?:\/\/(?:[\w-]+\.)*claude\.site\/artifacts\//i,
];

/** @type {{patterns: RegExp[], hosts: string[]} | null} */
let _userPassthrough = null;

/** Reset the memoized passthrough list. Test seam. */
export function resetFetchPassthrough() {
  _userPassthrough = null;
}

function getUserPassthrough() {
  if (_userPassthrough) return _userPassthrough;
  const patterns = [];
  const hosts = [];
  const raw = process.env.CONTEXT_MODE_FETCH_PASSTHROUGH;
  if (raw) {
    for (const entryRaw of raw.split("|||")) {
      const entry = entryRaw.trim();
      if (!entry) continue;
      if (entry.startsWith("^")) {
        try { patterns.push(new RegExp(entry, "i")); } catch { /* skip malformed */ }
      } else {
        hosts.push(entry.toLowerCase().replace(/^\.+/, ""));
      }
    }
  }
  _userPassthrough = { patterns, hosts };
  return _userPassthrough;
}

/**
 * @param {string} url URL from the WebFetch tool input.
 * @returns {boolean} true when the native tool should handle this URL itself.
 */
export function isFetchPassthroughUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (BUILTIN_FETCH_PASSTHROUGH.some(rx => rx.test(url))) return true;

  const { patterns, hosts } = getUserPassthrough();
  if (patterns.some(rx => rx.test(url))) return true;
  if (hosts.length === 0) return false;

  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hosts.some(h => hostname === h || hostname.endsWith(`.${h}`));
}

function getCodexConfigDir(env = process.env) {
  const codexHome = env.CODEX_HOME;
  if (codexHome && codexHome.trim() !== "") return resolve(codexHome);
  return resolve(homedir(), ".codex");
}

function getPlatformSettingsPath(platform) {
  if (platform === "codex") return resolve(getCodexConfigDir(), "settings.json");
  return undefined;
}

/**
 * Route a PreToolUse event. Returns normalized decision object or null for passthrough.
 *
 * @param {string} toolName - The tool name as reported by the platform
 * @param {object} toolInput - The tool input/parameters
 * @param {string} [projectDir] - Project directory for security policy lookup
 * @param {string} [platform="claude-code"] - Platform ID for tool name formatting
 * @param {string} [sessionId] - Stable session identifier from hook payload. When
 *   provided, the guidance throttle uses it to scope marker files across hook
 *   invocations even when process.ppid shifts (Windows/Git Bash — see #298).
 * @param {object} [options] - Runtime routing context from the adapter.
 * @param {boolean} [options.mcpToolsAvailable=true] - False when the current
 *   caller context cannot invoke ctx_* MCP tools even though an MCP server is
 *   live on the machine (Claude Code fixed-tool subagents — #794).
 */
export function routePreToolUse(toolName, toolInput, projectDir, platform, sessionId, options = {}) {
  const mcpToolsAvailable = options.mcpToolsAvailable !== false;

  // ─── Opt-in fail-closed gate (#468 follow-up) ───
  // Default behavior on security-module load failure is fail-OPEN (a stderr
  // warning is emitted but routing continues). Security-conscious users can
  // opt in to fail-CLOSED via CONTEXT_MODE_REQUIRE_SECURITY=1 — every PreToolUse
  // event is denied with a clear reason until the security module loads cleanly.
  // Universal gate (applies to all tools, not just Bash) since user `permissions.deny`
  // patterns may target Read/Write paths that would otherwise leak before security loads.
  if (process.env.CONTEXT_MODE_REQUIRE_SECURITY === "1" && securityInitFailed) {
    return {
      action: "deny",
      reason:
        "context-mode: security module unavailable and CONTEXT_MODE_REQUIRE_SECURITY=1 — fail-closed engaged. " +
        "Run `npm run build` (or reinstall context-mode) to restore security enforcement. " +
        "To bypass, unset or set CONTEXT_MODE_REQUIRE_SECURITY=0.",
    };
  }

  // Build platform-specific tool namer (defaults to claude-code for backward compat)
  const t = createToolNamer(platform || "claude-code");

  // Build platform-specific guidance/routing content
  const routingBlock = platform ? createRoutingBlock(t) : ROUTING_BLOCK;
  const readGuidance = platform ? createReadGuidance(t) : READ_GUIDANCE;
  const grepGuidance = platform ? createGrepGuidance(t) : GREP_GUIDANCE;
  const bashGuidance = platform ? createBashGuidance(t) : BASH_GUIDANCE;

  // Normalize platform-specific tool name to canonical
  const canonical = TOOL_ALIASES[toolName] ?? toolName;
  const platformSettingsPath = getPlatformSettingsPath(platform);

  // ─── Bash: Stage 1 security check, then Stage 2 routing ───
  if (canonical === "Bash") {
    const command = getShellCommand(toolInput);

    // Stage 1: Security check against user's deny/allow patterns.
    // Only act when an explicit pattern matched. When no pattern matches,
    // evaluateCommand returns { decision: "ask" } with no matchedPattern —
    // in that case fall through so other hooks and the platform's native engine can decide.
    if (security) {
      const policies = security.readBashPolicies(projectDir, platformSettingsPath);
      if (policies.length > 0) {
        const result = security.evaluateCommand(command, policies);
        if (result.decision === "deny") {
          return { action: "deny", reason: `Blocked by security policy: matches deny pattern ${result.matchedPattern}` };
        }
        if (result.decision === "ask" && result.matchedPattern) {
          return { action: "ask" };
        }
        // "allow" or no match → fall through to Stage 2
      }
    }

    // Stage 2: Context-mode routing (existing behavior)

    // curl/wget detection: strip quoted content first to avoid false positives
    // like `gh issue edit --body "text with curl in it"` (Issue #63).
    const stripped = stripQuotedContent(command);

    // curl/wget — allow silent file-output downloads, block stdout floods (#166).
    // Algorithm: split chained commands, evaluate each segment independently.
    if (/(^|\s|&&|\||\;)(curl|wget)\s/i.test(stripped)) {
      // Split on chain operators (&&, ||, ;) to evaluate each segment
      const segments = stripped.split(/\s*(?:&&|\|\||;)\s*/);
      const hasDangerousSegment = segments.some(seg => {
        const s = seg.trim();
        // Only evaluate segments that contain curl or wget
        if (!/(^|\s)(curl|wget)\s/i.test(s)) return false;

        const isCurl = /\bcurl\b/i.test(s);
        const isWget = /\bwget\b/i.test(s);

        // Check for file output flags
        const hasFileOutput = isCurl
          ? /\s(-o|--output)\s/.test(s) || /\s*>\s*/.test(s) || /\s*>>\s*/.test(s)
          : /\s(-O|--output-document)\s/.test(s) || /\s*>\s*/.test(s) || /\s*>>\s*/.test(s);

        if (!hasFileOutput) return true; // no file output → dangerous

        // Stdout aliases: -o -, -o /dev/stdout, -O -
        if (isCurl && /\s(-o|--output)\s+(-|\/dev\/stdout)(\s|$)/.test(s)) return true;
        if (isWget && /\s(-O|--output-document)\s+(-|\/dev\/stdout)(\s|$)/.test(s)) return true;

        // Verbose/trace flags flood stderr → context
        if (/\s(-v|--verbose|--trace|-D\s+-)\b/.test(s)) return true;

        // Must be silent (curl: -s/--silent, wget: -q/--quiet) to prevent progress bar stderr flood
        const isSilent = isCurl
          ? /\s-[a-zA-Z]*s|--silent/.test(s)
          : /\s-[a-zA-Z]*q|--quiet/.test(s);
        if (!isSilent) return true;

        return false; // safe: silent + file output + no verbose + no stdout alias
      });

      if (hasDangerousSegment) {
        return mcpRedirect({
          action: "modify",
          updatedInput: {
            command: `echo "context-mode: curl/wget redirected. Call ${t("ctx_execute")}(language, code) to fetch the URL, derive your answer in code, and print only the result — the raw HTTP body stays in the sandbox instead of entering your conversation. Or call ${t("ctx_fetch_and_index")}(url, source) when you want to query the response later via ${t("ctx_search")}. Both have full network access. Retry the same call on a transient DNS error (EAI_AGAIN, ETIMEDOUT, ENETUNREACH)."`,
          },
          // D2 PRD Phase 3.1: marker payload for PostToolUse byte accounting.
          redirectMeta: {
            tool: "Bash",
            type: "bash-redirected",
            // 8192 byte default — typical curl/wget HTTP body the agent would
            // have spilled into the model's context window had we not blocked.
            bytesAvoided: 8192,
            commandSummary: command.slice(0, 200),
          },
        }, mcpToolsAvailable);
      }
      // All segments safe → allow through
      return null;
    }

    // Inline HTTP detection: strip only heredocs (not quotes) so that
    // code passed via -e/-c flags is still visible to the regex, while
    // heredoc content (e.g. cat << EOF ... requests.get ... EOF) is removed.
    // These patterns are specific enough that false positives in quoted
    // text are rare, unlike single-word "curl"/"wget" (Issue #63).
    const noHeredoc = stripHeredocs(command);
    if (
      /fetch\s*\(\s*['"](https?:\/\/|http)/i.test(noHeredoc) ||
      /requests\.(get|post|put)\s*\(/i.test(noHeredoc) ||
      /http\.(get|request)\s*\(/i.test(noHeredoc)
    ) {
      return mcpRedirect({
        action: "modify",
        updatedInput: {
          command: `echo "context-mode: Inline HTTP redirected. Call ${t("ctx_execute")}(language, code) to fetch, derive your answer in code, and console.log() only the result — the raw response body stays in the sandbox instead of entering your conversation. Full network access. Retry the same call on a transient DNS error (EAI_AGAIN, ETIMEDOUT, ENETUNREACH)."`,
        },
      }, mcpToolsAvailable);
    }

    // Build tools (gradle, maven, sbt) → redirect to execute sandbox (Issue #38, #406).
    // These produce extremely verbose output that should stay in sandbox.
    // Word-boundary guard prevents matching `gradle-wrapper-config`, `mvnDocker`, etc.
    if (/(^|\s|&&|\||\;)(\.\/gradlew|gradlew|gradle|\.\/mvnw|mvnw|mvn|\.\/sbt|sbt)(\s|$)/i.test(stripped)) {
      const safeCmd = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return mcpRedirect({
        action: "modify",
        updatedInput: {
          command: `echo "context-mode: Build tool redirected. Call ${t("ctx_execute")}(language: \\"shell\\", code: \\"${safeCmd} 2>&1 | tail -30\\") to run the build and print only the tail — the verbose build log stays in the sandbox instead of entering your conversation. For more targeted output, replace \\"tail -30\\" with \\"grep -E '(error|warning|FAIL|✗|×)'\\" or similar, so only the lines that matter come back."`,
        },
      }, mcpToolsAvailable);
    }

    // Named heavy commands: the output size is known before the run, so this
    // is the deny case rather than the advice case. Checked before the
    // structurally-bounded allowlist, because `git log -p` reads as a bounded
    // `git log` to a pattern matcher and is anything but.
    const heavy = matchedHeavyBash(stripped);
    if (heavy) {
      const denial = mcpRedirect({
        action: "deny",
        reason:
          bashDenyReason(t, command, `this command matches "${heavy}" on the heavy-output list, so its whole output would enter your conversation.`) + "\n" +
          `To watch this one directly anyway, drop its entry from ${BASH_DENY_COMMANDS_ENV} (comma-separated patterns; an empty value turns the list off).`,
        redirectMeta: {
          tool: "Bash",
          type: "bash-redirected",
          // Unmeasurable before the run, so no invented figure: the accounting
          // takes the real size from PostToolUse when the replacement runs.
          bytesAvoided: 0,
          commandSummary: command.slice(0, 200),
        },
      }, mcpToolsAvailable);
      if (denial) return denial;
      // MCP unavailable — the replacement does not exist right now, so the
      // command has to stay runnable. Fall through to the advisory.
    }

    // Skip the routing nudge for commands whose output is structurally
    // bounded (#463) — pwd, whoami, git status, --version probes, etc.
    // Conservative: any pipe/redirect/chain disqualifies, unknown commands
    // still get the nudge.
    if (isStructurallyBounded(command)) {
      return null;
    }

    // #817: opt-in size threshold. When the operator configures
    // CONTEXT_MODE_BASH_NUDGE_MIN_COMMAND_BYTES, a short unbounded command is
    // treated as expected-lightweight and passes through untouched — reserving
    // the nudge for commands large/complex enough to plausibly flood context.
    // Default (0) preserves current behavior, so large-output savings are not
    // weakened unless the operator explicitly opts in.
    const minCommandBytes = getBashNudgeMinCommandBytes();
    if (minCommandBytes > 0 && Buffer.byteLength(command, "utf8") < minCommandBytes) {
      return null;
    }

    // Everything else: the ladder decides, and on a session that routes its
    // heavy work it decides on silence. With no tally to read (no session id,
    // no PostToolUse yet, unreadable store) fall back to the one-shot advisory
    // this hook has always emitted — not to the violation branch.
    const tally = readUnroutedTally(sessionId);
    if (!tally) return guidanceOnce("bash", bashGuidance, sessionId);
    const level = escalationLevel(tally);

    if (level >= ESCALATION_DENY) {
      const denial = mcpRedirect({
        action: "deny",
        reason:
          bashDenyReason(t, command, "this session keeps sending command output straight into the conversation.") + "\n" +
          escalationNote(tally),
        redirectMeta: {
          tool: "Bash",
          type: "bash-redirected",
          bytesAvoided: 0,
          commandSummary: command.slice(0, 200),
        },
      }, mcpToolsAvailable);
      if (denial) return denial;
    }
    if (level >= ESCALATION_ASK) {
      return {
        action: "ask",
        reason:
          `context-mode: ${tallyLine(tally)} ${t("ctx_batch_execute")}(commands, queries) indexes this command's output and returns only the sections that answer your questions.\n` +
          `Confirm it when you mean to read the output yourself. ${escalationNote(tally)}`,
      };
    }
    if (level >= ESCALATION_ADVISE) {
      return { action: "context", additionalContext: `context-mode: ${escalationNote(tally)}\n${bashGuidance}` };
    }
    return null;
  }

  // ─── Read: nudge toward execute_file + large-file byte accounting ───
  // D2 PRD Phase 4 (slices 4.4–4.6): when the file is large enough to flood
  // context, attach `redirectMeta` so PostToolUse can emit a `read-redirected`
  // event with the actual file size as bytes_avoided. The threshold follows
  // the refusal threshold (readAccountingBytes); smaller reads stay on the
  // guidance nudge.
  if (canonical === "Read") {
    const filePath = getReadFilePath(toolInput);
    if (filePath) {
      try {
        const st = statSync(filePath);
        const denyAt = readDenyBytes();

        // The refusal promised this exact read would go through. Honour it
        // literally: not a confirmation prompt, not a stronger nudge — a
        // promise the model has to re-read the fine print of is not an escape
        // hatch.
        //
        // And it has to be honoured by the accounting too, which is where this
        // went wrong. The retry is an ordinary allowed Read, so PostToolUse
        // sees a heavy native call with no redirect marker and records a fresh
        // violation: the tally grows, the cost line fires, the adherence
        // denominator gains one, and the ladder climbs another step. The
        // plugin punishes the caller for taking the way out it just offered,
        // and each use of that way out makes the next refusal harsher — a loop
        // that feeds itself, aimed squarely at read-before-edit.
        //
        // The marker below is what stops it: it says "this call is already
        // accounted for" without claiming a saving, because nothing was saved
        // — the bytes did enter the conversation. (The old branch claimed
        // st.size avoided on the retry, which was the same error in the other
        // direction.) Below the collection floor no marker is needed: nothing
        // under it was ever counted as a violation.
        if (st.isFile() && readRetryArmed(sessionId, filePath)) {
          if (st.size >= missedRedirectFloorBytes()) {
            return {
              action: "allow",
              redirectMeta: {
                tool: "Read",
                type: READ_EDIT_EXEMPT_TYPE,
                bytesAvoided: 0,
                commandSummary: String(filePath).slice(0, 200),
              },
            };
          }
          return null;
        }

        // Refuse the whole-file read, and say in the same breath how to get it
        // anyway. Three ways out, all of them the caller's to take: bound the
        // read (offset/limit), repeat the call within the window, or turn the
        // threshold off. A refusal the model cannot read its way past is a
        // refusal it gets stuck behind, which costs more than the bytes.
        if (
          st.isFile() && denyAt > 0 && st.size > denyAt &&
          !isBoundedRead(toolInput)
        ) {
          const denial = mcpRedirect({
            action: "deny",
            reason: readDenyReason(t, filePath, st.size),
            redirectMeta: {
              tool: "Read",
              type: "read-redirected",
              bytesAvoided: st.size,
              commandSummary: String(filePath).slice(0, 200),
            },
          }, mcpToolsAvailable);
          if (denial) {
            armReadRetry(sessionId, filePath);
            return denial;
          }
          // MCP unavailable — ctx_execute_file does not exist right now, so
          // the file has to stay readable. Fall through to the advisory.
        }

        // Below the size rule, the ladder decides. It reuses the same
        // refusal text — escape hatch included — so a file refused because
        // this session keeps leaking reads exactly like one refused for being
        // large, and the way through is the same sentence in both.
        const tally = readUnroutedTally(sessionId);
        const level = tally ? escalationLevel(tally) : ESCALATION_SILENT;
        const meta = st.isFile()
          ? {
            tool: "Read",
            type: "read-redirected",
            bytesAvoided: st.size,
            commandSummary: String(filePath).slice(0, 200),
          }
          : null;

        if (
          tally && level >= ESCALATION_DENY && st.isFile() &&
          // Nothing under the collection floor was ever a violation, so
          // refusing it would be friction bought with no saving at all.
          st.size >= missedRedirectFloorBytes() &&
          !isBoundedRead(toolInput)
        ) {
          const denial = mcpRedirect({
            action: "deny",
            reason: readDenyReason(t, filePath, st.size) + "\n" + escalationNote(tally),
            redirectMeta: meta,
          }, mcpToolsAvailable);
          if (denial) {
            armReadRetry(sessionId, filePath);
            return denial;
          }
        }

        if (st.isFile() && st.size > readAccountingBytes()) {
          // The historical large-read branch: advisory plus byte accounting.
          // Kept as the floor of the ladder so the accounting never depends on
          // which step the session is on.
          const decision = (level >= ESCALATION_ASK && !isBoundedRead(toolInput))
            ? { action: "ask", reason: readDenyReason(t, filePath, st.size) + "\n" + escalationNote(tally) }
            : (tally
              ? (level >= ESCALATION_ADVISE
                ? { action: "context", additionalContext: `context-mode: ${escalationNote(tally)}\n${readGuidance}` }
                : { action: "context", additionalContext: readGuidance })
              : (guidanceOnce("read", readGuidance, sessionId)
                ?? { action: "context", additionalContext: readGuidance }));
          decision.redirectMeta = meta;
          return decision;
        }

        if (tally) {
          if (level >= ESCALATION_ASK && !isBoundedRead(toolInput)) {
            return {
              action: "ask",
              reason:
                `context-mode: ${tallyLine(tally)} ${t("ctx_read")}(path: ${JSON.stringify(filePath)}) answers a question about this file without spending the file on it — one argument, no program to compose.\n` +
                `Confirm the read when you need the bytes themselves — reading in order to Edit is exactly that case. ${escalationNote(tally)}`,
            };
          }
          if (level >= ESCALATION_ADVISE) {
            return { action: "context", additionalContext: `context-mode: ${escalationNote(tally)}\n${readGuidance}` };
          }
          return null;
        }
      } catch { /* file missing or unreadable — fall through to plain guidance */ }
    }
    const tail = readUnroutedTally(sessionId);
    if (tail) {
      return escalationLevel(tail) >= ESCALATION_ADVISE
        ? { action: "context", additionalContext: `context-mode: ${escalationNote(tail)}\n${readGuidance}` }
        : null;
    }
    return guidanceOnce("read", readGuidance, sessionId);
  }

  // ─── Grep / Glob: confirm the unbounded sweep, refuse nothing ───
  // `ask`, not `deny`, and the measurements are the reason. ctx_find spends
  // 2.6 KB where `rg -l` spends 0.7 KB, and it answers with a ranked list
  // rather than every occurrence. Denying here would trade a cheap exhaustive
  // answer for an expensive partial one — so the caller is asked, once the
  // search has nothing bounding it at all, and told plainly that confirming is
  // the right answer when the sweep is the point.
  if (canonical === "Grep") {
    if (grepAskEnabled() && isUnboundedGrep(toolInput)) {
      return {
        action: "ask",
        reason:
          `context-mode: this Grep has no path, no file filter and no result cap, and asks for matching lines across the whole tree — that shape returned 34 KB in our own measurements. ${t("ctx_find")}(query: "…") answers "where does this live" for a fraction of that.\n` +
          `Confirm this Grep when you need every occurrence, counted: ${t("ctx_find")} ranks, it does not enumerate, and an exhaustive literal sweep is exactly what Grep is for. Narrowing it with path, glob or head_limit also stops the prompt, and ${GREP_ASK_ENV}=0 turns it off.`,
      };
    }
    // Bounded searches ride the ladder, but it stops at `ask` for them: the
    // measurements say ctx_find ranks where Grep enumerates, so refusing an
    // exhaustive sweep would remove an answer rather than route it, however
    // much this session has leaked.
    const tally = readUnroutedTally(sessionId);
    if (!tally) return guidanceOnce("grep", grepGuidance, sessionId);
    const level = escalationLevel(tally);
    if (level >= ESCALATION_ASK) {
      return {
        action: "ask",
        reason:
          `context-mode: ${tallyLine(tally)} ${t("ctx_find")}(query: "…") answers "where does this live" for a fraction of the bytes.\n` +
          `Confirm this Grep when you need every occurrence — ${t("ctx_find")} ranks, it does not enumerate, and that stays true no matter how much this session has spent. ${escalationNote(tally)}`,
      };
    }
    if (level >= ESCALATION_ADVISE) {
      return { action: "context", additionalContext: `context-mode: ${escalationNote(tally)}\n${grepGuidance}` };
    }
    return null;
  }

  // Same rule as Grep, and the same reason for it being `ask`.
  //
  // This branch was unreachable until v1.0.172: `Glob` was missing from
  // PRE_TOOL_USE_MATCHERS, so Claude Code never delivered a Glob here, and
  // Codex has no Glob tool at all. Four test files exercised it by calling
  // this router directly, which is why nothing went red — coverage without
  // behaviour. It is wired now; the guard that keeps the next branch from
  // going the same way is tests/hooks/matcher-coverage.test.ts.
  //
  // Narrower than Grep on purpose: the unbounded shape asks, and a bounded
  // Glob returns null rather than riding the escalation ladder. Glob is still
  // counted in FLOODY_TOOLS, so its bytes push the session tally that
  // escalates Read and Bash. Whether Glob should also carry its own ladder
  // step is a D1 question, not a wiring one.
  if (canonical === "Glob") {
    if (grepAskEnabled() && isUnboundedGlob(toolInput)) {
      return {
        action: "ask",
        reason:
          `context-mode: this Glob has no path and a pattern that matches the whole tree. ${t("ctx_find")}(query: "…") returns a ranked short list instead of the full listing.\n` +
          `Confirm it when you actually want every path — ${t("ctx_find")} ranks rather than enumerates. A path prefix or a narrower pattern also stops the prompt, and ${GREP_ASK_ENV}=0 turns it off.`,
      };
    }
    return null;
  }

  // ─── WebFetch: deny + redirect to sandbox ───
  if (canonical === "WebFetch") {
    const url = getWebFetchUrl(toolInput);
    // Auth-gated SPA targets (claude.ai Artifacts) and operator-listed hosts
    // pass straight through: the native tool is the only thing that can read
    // them, and redirecting yields an empty shell that looks like content.
    if (isFetchPassthroughUrl(url)) return null;
    return mcpRedirect({
      action: "deny",
      reason: `context-mode: WebFetch redirected. Call ${t("ctx_fetch_and_index")}(url: "${url}", source: "...") to fetch + index the page, then ${t("ctx_search")}(queries: [...]) to query the indexed content — the raw page bytes stay in storage instead of entering your conversation. Or call ${t("ctx_execute")}(language, code) when you want to derive your answer in one round trip (parse, extract, count) without persisting the response. Both have full network access. Retry the same call on a transient DNS error (EAI_AGAIN, ETIMEDOUT, ENETUNREACH).`,
      // D2 PRD Phase 4.1: marker payload for PostToolUse byte accounting.
      redirectMeta: {
        tool: "WebFetch",
        type: "webfetch-redirected",
        // 16384 = typical web page body bytes prevented from entering the
        // model's context window.
        bytesAvoided: 16384,
        commandSummary: String(url).slice(0, 200),
      },
    }, mcpToolsAvailable);
  }

  // ─── Agent: inject context-mode routing into subagent prompts ───
  // Subagents cannot use ctx commands (stats/doctor/upgrade/purge) — omit that section (#233)
  if (canonical === "Agent") {
    const subagentType = toolInput.subagent_type ?? "";
    // Detect the correct field name for the prompt/request/objective/question/query
    const fieldName = ["prompt", "request", "objective", "question", "query", "task"].find(f => f in toolInput) ?? "prompt";
    const prompt = toolInput[fieldName] ?? "";

    // Claude Code surfaces ctx_* as DEFERRED tools (schemas loaded via ToolSearch).
    // Without a bootstrap step the subagent is told to use ctx_* tools it cannot yet
    // invoke and stalls (see #724). Prepend the ToolSearch bootstrap for claude-code
    // (the default when platform is unset). Other platforms don't defer, so skip it.
    const isClaudeCode = !platform || platform === "claude-code";
    const subagentBlock = createRoutingBlock(t, {
      includeCommands: false,
      toolSearchBootstrap: isClaudeCode,
    });

    const updatedInput =
      subagentType === "Bash"
        ? { ...toolInput, [fieldName]: prompt + subagentBlock, subagent_type: "general-purpose" }
        : { ...toolInput, [fieldName]: prompt + subagentBlock };

    return { action: "modify", updatedInput };
  }

  // ─── MCP execute: security check for shell commands ───
  // Match bare, generic MCP, and legacy context-mode execute tool names.
  const shouldPinClaudeExecutorCwd =
    platform === "claude-code" &&
    typeof projectDir === "string" &&
    projectDir.length > 0;

  if (matchesContextModeTool(toolName, "ctx_execute", "execute")) {
    if (security && toolInput.language === "shell") {
      const code = toolInput.code ?? "";
      const policies = security.readBashPolicies(projectDir, platformSettingsPath);
      if (policies.length > 0) {
        const result = security.evaluateCommand(code, policies);
        if (result.decision === "deny") {
          return { action: "deny", reason: `Blocked by security policy: shell code matches deny pattern ${result.matchedPattern}` };
        }
        if (result.decision === "ask" && result.matchedPattern) {
          return { action: "ask" };
        }
      }
    }
    if (toolInput.language === "shell" && shouldPinClaudeExecutorCwd && typeof toolInput.cwd !== "string") {
      return { action: "modify", updatedInput: { ...toolInput, cwd: projectDir } };
    }
    return null;
  }

  // ─── MCP execute_file: check file path + code against deny patterns ───
  if (matchesContextModeTool(toolName, "ctx_execute_file", "execute_file")) {
    if (security) {
      // Check file path against Read deny patterns
      const filePath = toolInput.path ?? "";
      const denyGlobs = security.readToolDenyPatterns("Read", projectDir, platformSettingsPath);
      const evalResult = security.evaluateFilePath(filePath, denyGlobs);
      if (evalResult.denied) {
        return { action: "deny", reason: `Blocked by security policy: file path matches Read deny pattern ${evalResult.matchedPattern}` };
      }

      // Check code parameter against Bash deny patterns (same as execute)
      const lang = toolInput.language ?? "";
      const code = toolInput.code ?? "";
      if (lang === "shell") {
        const policies = security.readBashPolicies(projectDir, platformSettingsPath);
        if (policies.length > 0) {
          const result = security.evaluateCommand(code, policies);
          if (result.decision === "deny") {
            return { action: "deny", reason: `Blocked by security policy: shell code matches deny pattern ${result.matchedPattern}` };
          }
          if (result.decision === "ask" && result.matchedPattern) {
            return { action: "ask" };
          }
        }
      }
    }
    return null;
  }

  // ─── MCP batch_execute: check each command individually ───
  if (matchesContextModeTool(toolName, "ctx_batch_execute", "batch_execute")) {
    if (security) {
      const commands = toolInput.commands ?? [];
      const policies = security.readBashPolicies(projectDir, platformSettingsPath);
      if (policies.length > 0) {
        for (const entry of commands) {
          const cmd = entry.command ?? "";
          const result = security.evaluateCommand(cmd, policies);
          if (result.decision === "deny") {
            return { action: "deny", reason: `Blocked by security policy: batch command "${entry.label ?? cmd}" matches deny pattern ${result.matchedPattern}` };
          }
          if (result.decision === "ask" && result.matchedPattern) {
            return { action: "ask" };
          }
        }
      }
    }
    if (shouldPinClaudeExecutorCwd && typeof toolInput.cwd !== "string") {
      return { action: "modify", updatedInput: { ...toolInput, cwd: projectDir } };
    }
    return null;
  }

  // ─── External MCP tools: periodic guidance about routing large payloads ─── (#529, #567 follow-up)
  // hooks/hooks.json registers a `mcp__(?!plugin_context-mode_)` matcher so this
  // branch fires for slack/telegram/gdrive/notion-style MCPs whose results would
  // otherwise spill into context. We don't deny or modify — the agent still needs
  // the tool's output; we just nudge it to pipe large results through ctx_execute.
  //
  // Cadence: every N calls (default 10, tunable via CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY).
  // The original one-shot nudge (#529) was lost after context compaction in
  // MCP-heavy sessions (e.g. 50+ Jira calls in #567 follow-up), letting later
  // payloads flood context unchecked. Re-firing periodically keeps the guidance
  // in the model's recent window without saturating it.
  if (isExternalMcpTool(toolName)) {
    const externalMcpGuidance = platform ? createExternalMcpGuidance(t) : EXTERNAL_MCP_GUIDANCE;
    return guidancePeriodic("external-mcp", externalMcpGuidance, sessionId, getExternalMcpNudgeEvery());
  }

  // Unknown tool — pass through
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Missed-redirect cost notice
//
// Between "called Read on 42 KB" and "learned that it cost 42 KB" there was
// no link at all. ctx_stats knows the number, but nothing calls it; the
// PostToolUse telemetry below writes the number to a database the model does
// not read. The price was measured in a place the decision could not see.
//
// So the same fact is put where the decision happens: one line appended to
// the tool result the model is already looking at, while it is still planning
// the next step. One line per unrouted heavy call, nothing at all on a routed
// one — a notice that fires on correct calls too is noise, and noise is what
// gets tuned out.
//
// PostToolUse, not PreToolUse: the byte count is only real after the call.
// PreToolUse already owns the before-the-fact half (the guidance nudges) and
// cannot know what a command will return.
// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// The redirect marker: PreToolUse decides, PostToolUse accounts.
//
// PreToolUse cannot open SessionDB — loading the native SQLite module breaks
// the hook's stdout — so a decision that needs to be recorded is written to a
// file and picked up by the PostToolUse that follows. Two hosts, two pairs of
// hook scripts, one format; keeping the read and the write here is what stops
// the pair from drifting apart on one host while working on the other.
//
// That drift is not hypothetical: until this was shared, the Codex hooks wrote
// no marker and read none, so on Codex every refusal was invisible to the byte
// accounting AND the read-before-edit escape hatch counted as a fresh
// violation — the self-reinforcing loop, still running on the second host
// after it had been fixed on the first.
//
// Format: `tool:type:bytesAvoided:commandSummary`. Only the first three colons
// are structural; the summary may contain more (URLs do).
// ─────────────────────────────────────────────────────────────────────────

function redirectMarkerPath(sessionId) {
  return resolve(tmpdir(), `context-mode-redirect-${sessionId}.txt`);
}

/**
 * Record a decision for the next PostToolUse to account for.
 * @param {string} sessionId
 * @param {{tool: string, type: string, bytesAvoided: number, commandSummary?: string}} meta
 */
export function writeRedirectMarker(sessionId, meta) {
  if (!meta) return;
  try {
    writeFileSync(
      redirectMarkerPath(sessionId),
      `${meta.tool}:${meta.type}:${meta.bytesAvoided}:${String(meta.commandSummary ?? "").slice(0, 200)}`,
      "utf-8",
    );
  } catch { /* best-effort — never block the hook */ }
}

/**
 * Read and delete the pending marker.
 *
 * Consume-once by design: without the delete, one refusal would be accounted
 * for again on every later tool call in the session.
 *
 * @returns {{tool: string, type: string, bytesAvoided: number, summary: string} | null}
 */
export function consumeRedirectMarker(sessionId) {
  let raw;
  try {
    raw = readFileSync(redirectMarkerPath(sessionId), "utf-8").trim();
    unlinkSync(redirectMarkerPath(sessionId));
  } catch {
    return null; // no marker — the phantom-event guard
  }
  if (!raw) return null;
  const i1 = raw.indexOf(":");
  const i2 = i1 >= 0 ? raw.indexOf(":", i1 + 1) : -1;
  const i3 = i2 >= 0 ? raw.indexOf(":", i2 + 1) : -1;
  if (!(i1 > 0 && i2 > i1 && i3 > i2)) return null;
  const bytesAvoided = Number.parseInt(raw.slice(i2 + 1, i3), 10);
  return {
    tool: raw.slice(0, i1),
    type: raw.slice(i1 + 1, i2),
    bytesAvoided: Number.isFinite(bytesAvoided) ? bytesAvoided : 0,
    summary: raw.slice(i3 + 1),
  };
}

/**
 * Byte floor under which a native call is not worth mentioning.
 *
 * The same floor the missed-redirect telemetry records against and the same
 * one src/session/analytics.ts measures adherence against — a notice that
 * fired below the collection floor would name calls that never appear in
 * ctx_stats, and the two surfaces would disagree about the same session.
 */
/** @param {Record<string, string | undefined>} [env] */
export function missedRedirectFloorBytes(env = process.env) {
  const raw = Number.parseInt(env.CONTEXT_MODE_MISSED_REDIRECT_MIN_BYTES ?? "", 10);
  // 2000 bytes ≈ the "> 20 lines of output" line the routing block draws.
  return Number.isFinite(raw) && raw > 0 ? raw : 2000;
}

/** Native tools whose whole payload lands in the conversation. */
const FLOODY_TOOLS = new Set(["Bash", "Read", "Grep", "Glob", "WebFetch", "Shell"]);

/**
 * Classify a finished tool call: was this a heavy payload that entered the
 * context window whole?
 *
 * Returns null for anything that is not — a tool that does not flood, a
 * payload under the floor, or a call the caller already knows was routed.
 * The caller passes `routed: true` when a PreToolUse redirect fired for this
 * call, because that state lives in the hook, not here.
 *
 * @param {{tool_name?: string, tool_input?: Record<string, unknown>, tool_response?: unknown}} input
 * @param {{routed?: boolean, env?: Record<string, string | undefined>}} [opts]
 * @returns {{toolName: string, bytes: number, summary: string} | null}
 */
export function describeMissedRedirect(input, { routed = false, env = process.env } = {}) {
  if (routed) return null;
  const toolName = input?.tool_name ?? "";
  if (!FLOODY_TOOLS.has(toolName)) return null;

  const response = typeof input?.tool_response === "string"
    ? input.tool_response
    : JSON.stringify(input?.tool_response ?? "");
  const bytes = Buffer.byteLength(response, "utf-8");
  if (bytes < missedRedirectFloorBytes(env)) return null;

  const ti = input?.tool_input ?? {};
  const summary = String(
    ti.command ?? ti.file_path ?? ti.pattern ?? ti.url ?? ti.path ?? "",
  ).replace(/\s+/g, " ").slice(0, 120);

  return { toolName, bytes, summary };
}

/**
 * The session tally, read back out of the events the telemetry already
 * writes. No second counter: a notice that counted separately from ctx_stats
 * would eventually disagree with it, and the disagreement would be invisible.
 *
 * The `data` shape (`Bash: 15600 bytes unrouted — git log …`) and the regex
 * that reads the byte count back out of it are shared with
 * src/session/analytics.ts (the parse there is a local literal, not an
 * export, and hooks do not bundle analytics). Keep the two in step.
 *
 * Two honest limits, both inherited from the store rather than introduced
 * here: SessionDB drops an exact repeat of the same event within its dedup
 * window, and evicts the lowest-priority rows once a session hits its event
 * cap. The tally therefore counts recorded calls — the same population
 * ctx_stats reports, which is the point.
 *
 * @param {{getEvents: (sessionId: string, opts?: {type?: string, limit?: number}) => Array<{data?: string}>}} db
 * @param {string} sessionId
 * @returns {{count: number, bytes: number}}
 */
export function readMissedRedirectTally(db, sessionId) {
  try {
    const rows = db.getEvents(sessionId, { type: "missed_redirect", limit: 1000 }) ?? [];
    let count = 0;
    let bytes = 0;
    for (const row of rows) {
      const m = /^(\S+):\s+(\d+)\s+bytes unrouted/.exec(row?.data ?? "");
      if (!m) continue;
      count++;
      bytes += Number.parseInt(m[2], 10) || 0;
    }
    return { count, bytes };
  } catch {
    // A tally we cannot read costs the second line of the notice, not the
    // notice itself.
    return { count: 0, bytes: 0 };
  }
}

/** KB below a megabyte, MB above it — one decimal either way. */
function formatNoticeBytes(n) {
  return n >= 1024 * 1024
    ? `${(n / (1024 * 1024)).toFixed(1)} MB`
    : `${(n / 1024).toFixed(1)} KB`;
}

/**
 * What the agent could have called instead, per native tool, as a concrete
 * call rather than a tool name. The name alone ("use ctx_find") leaves the
 * agent to guess the signature; the signature is the part that makes the
 * next call cheap.
 */
const MISSED_REDIRECT_ALTERNATIVES = {
  Read: (t) => `${t("ctx_execute_file")}(path, language, code) reads it in a subprocess and returns only what your code prints`,
  Grep: (t) => `${t("ctx_find")}(query) returns ranked paths and snippets instead of the whole match list`,
  Glob: (t) => `${t("ctx_find")}(query) returns ranked paths instead of the whole listing`,
  Bash: (t) => `${t("ctx_batch_execute")}(commands, queries) indexes the output and returns only the sections that answer your questions`,
  Shell: (t) => `${t("ctx_batch_execute")}(commands, queries) indexes the output and returns only the sections that answer your questions`,
  WebFetch: (t) => `${t("ctx_fetch_and_index")}(url, source) indexes the page and returns a preview; ${t("ctx_search")}(queries) pulls any section later`,
};

/**
 * The line itself.
 *
 * Deliberately without a "would have returned ~X KB" estimate: nothing in the
 * hook can know what the replacement would have printed, and a number made up
 * at this distance is worse than no number — the one measured figure in the
 * line is the one that has to stay trustworthy.
 *
 * The tally sentence appears from the second call onward. On the first one it
 * would only restate the first sentence.
 *
 * `displayName` is the name the agent used, which is not always the name the
 * telemetry files it under: the Codex hook normalises `Shell` to `Bash` so the
 * two hosts aggregate together, and a line reading "this Bash call" to someone
 * who called Shell is a line about somebody else's session. Lookup stays on
 * the normalised name; only the wording follows the caller.
 *
 * `CONTEXT_MODE_COST_NOTICE=0` turns it off.
 *
 * @param {{
 *   toolName?: string,
 *   displayName?: string,
 *   bytes?: number,
 *   tally?: {count?: number, bytes?: number},
 *   platform?: string,
 *   env?: Record<string, string | undefined>,
 * }} [opts]
 * @returns {string | null}
 */
export function buildMissedRedirectNotice(
  { toolName, displayName, bytes, tally, platform, env = process.env } = {},
) {
  if (env.CONTEXT_MODE_COST_NOTICE === "0") return null;
  const alternative = MISSED_REDIRECT_ALTERNATIVES[toolName];
  if (!alternative || !(bytes > 0)) return null;

  const t = createToolNamer(platform || "claude-code");
  const shown = displayName || toolName;
  const lines = [
    `context-mode: this ${shown} call put ${formatNoticeBytes(bytes)} into your context window; ` +
    `${alternative(t)}.`,
  ];
  const count = tally?.count ?? 0;
  if (count >= 2) {
    lines.push(
      `${count} such calls so far this session, ${formatNoticeBytes(tally.bytes ?? 0)} in total.`,
    );
  }
  return lines.join("\n");
}
