import { buildHookRuntimeCommand, parseNodeCommand } from "../types.js";

/**
 * adapters/claude-code/hooks — Claude Code hook definitions and matchers.
 *
 * Defines the hook types, matchers, and registration format specific to
 * Claude Code's hook system. This module is used by:
 *   - CLI setup/upgrade commands (to configure hooks in settings.json)
 *   - Doctor command (to validate hook configuration)
 *   - hooks.json generation
 *
 * Claude Code hook system reference:
 *   - Hooks are registered in ~/.claude/settings.json under "hooks" key
 *   - Each hook type maps to an array of { matcher, hooks } entries
 *   - matcher: tool name pattern (empty = match all tools)
 *   - hooks: array of { type: "command", command: "..." }
 *   - Input: JSON on stdin
 *   - Output: JSON on stdout (or empty for passthrough)
 */

// ─────────────────────────────────────────────────────────
// Hook type constants
// ─────────────────────────────────────────────────────────

/** Claude Code hook types. */
export const HOOK_TYPES = {
  PRE_TOOL_USE: "PreToolUse",
  POST_TOOL_USE: "PostToolUse",
  PRE_COMPACT: "PreCompact",
  SESSION_START: "SessionStart",
  USER_PROMPT_SUBMIT: "UserPromptSubmit",
  STOP: "Stop",
  SUBAGENT_STOP: "SubagentStop",
  SESSION_END: "SessionEnd",
} as const;

export type HookType = (typeof HOOK_TYPES)[keyof typeof HOOK_TYPES];

// ─────────────────────────────────────────────────────────
// PreToolUse matchers
// ─────────────────────────────────────────────────────────

/**
 * External MCP catch-all matcher for Claude Code (#529, #547 hotfix).
 *
 * Claude Code's hook matcher engine treats this entry as a substring match
 * (it also accepts regex, but `mcp__` alone is enough — every MCP tool
 * surfaces as `mcp__<server>__<tool>`). v1.0.124 used a negative lookahead
 * `mcp__(?!plugin_context-mode_)` to skip context-mode's own MCP tools,
 * but this same hooks.json is bundled to Codex CLI which uses Rust's
 * `regex` crate (no look-around support) — Codex rejected the matcher at
 * boot, breaking every Codex user (#547). Drop the lookaround on both
 * sides; the hook BODY (`isExternalMcpTool()` in hooks/core/routing.mjs)
 * already filters context-mode's own tools, so semantics are preserved.
 */
export const EXTERNAL_MCP_MATCHER_PATTERN = "mcp__";

/**
 * Tools that context-mode's PreToolUse hook intercepts.
 *
 * Entries MUST NOT overlap. Claude Code fires one hook process per matching
 * entry, and `generateHookConfig` emits one settings.json entry per element of
 * this list, so an entry already covered by another is not redundancy — it is a
 * second `node` process before every affected tool call plus a second pass of
 * the delay / redirect / rejected-approach markers `pretooluse.mjs` writes into
 * tmpdir.
 *
 * That is exactly what the three explicit
 * `mcp__plugin_context-mode_context-mode__ctx_*` entries did until v1.0.170:
 * every one of them is a superstring of `mcp__`, so `ctx_execute` matched twice
 * and paid twice. They were dropped, not replaced — `mcp__` already covers every
 * MCP tool (substring semantics, see EXTERNAL_MCP_MATCHER_PATTERN above), and
 * the hook BODY (`isExternalMcpTool()` in hooks/core/routing.mjs) is what tells
 * context-mode's own tools apart from foreign ones. The Codex adapter reached
 * the same shape independently — its matcher asserts
 * `not.toContain("mcp__plugin_context-mode_context-mode__")`.
 *
 * Non-overlap is enforced by tests/plugins/plugin-structure.test.ts.
 */
export const PRE_TOOL_USE_MATCHERS = [
  "Bash",
  "WebFetch",
  "Read",
  "Grep",
  // Glob sits next to Grep because the router treats them as one rule: an
  // unbounded sweep is asked about, never refused. It was missing here until
  // v1.0.172, and the cost of that was not a silent rule — it was an asymmetric
  // one. `FLOODY_TOOLS` in hooks/core/routing.mjs has always listed Glob, so a
  // large listing was charged on the way out (price line, unrouted tally,
  // escalation, adherence denominator) while the matcher gave it no way in.
  // Penalty without warning. The guard that keeps this from recurring for the
  // next tool is in tests/hooks/matcher-coverage.test.ts.
  "Glob",
  "Agent",
  EXTERNAL_MCP_MATCHER_PATTERN,
] as const;

/**
 * Combined matcher pattern for settings.json (pipe-separated).
 * Used by the upgrade command when writing a single consolidated entry.
 */
export const PRE_TOOL_USE_MATCHER_PATTERN = PRE_TOOL_USE_MATCHERS.join("|");

// ─────────────────────────────────────────────────────────
// PostToolUse matchers (#229)
// ─────────────────────────────────────────────────────────

/**
 * Tools that context-mode's PostToolUse hook should fire on.
 * Only tools that extractEvents() actually handles — all others
 * produce zero events and cause false "hook error" display.
 */
export const POST_TOOL_USE_MATCHERS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "EnterPlanMode",
  "ExitPlanMode",
  "Skill",
  "Agent",
  "AskUserQuestion",
  "EnterWorktree",
  "mcp__",
] as const;

/**
 * Combined matcher pattern for PostToolUse in hooks.json / settings.json.
 */
export const POST_TOOL_USE_MATCHER_PATTERN = POST_TOOL_USE_MATCHERS.join("|");

// ─────────────────────────────────────────────────────────
// Hook script file names
// ─────────────────────────────────────────────────────────

/**
 * Seconds each hook gets before Claude Code kills it.
 *
 * Claude Code's default is 60s. That default is wrong in both directions here:
 * far too generous for the pre-tool path, where the user is staring at a prompt
 * that has not moved (`pretooluse.mjs` runs in front of every Bash, and on a
 * first run it can self-heal by copying files — a minute of that is
 * indistinguishable from a hang), and not obviously enough for `PreCompact`,
 * which builds the resume snapshot and is the one place the work is genuinely
 * heavy.
 *
 * So the budgets are graded rather than uniform:
 *   - 15s — anything on the pre-tool path or in front of a prompt
 *   - 20s — post-tool and turn-end capture (SQLite writes, extraction)
 *   - 30s — SessionEnd drain
 *   - 45s — SessionStart (context injection, adapter detection, healing)
 *   - 60s — PreCompact (snapshot build; the host default, kept deliberately)
 *
 * Kept in lockstep with hooks/hooks.json by tests/plugins/plugin-structure.test.ts.
 */
export const HOOK_TIMEOUTS: Record<HookType, number> = {
  PreToolUse: 15,
  PostToolUse: 20,
  PreCompact: 60,
  SessionStart: 45,
  UserPromptSubmit: 15,
  Stop: 20,
  SubagentStop: 20,
  SessionEnd: 30,
};

/** Map of hook types to their script file names. */
export const HOOK_SCRIPTS: Record<HookType, string> = {
  PreToolUse: "pretooluse.mjs",
  PostToolUse: "posttooluse.mjs",
  PreCompact: "precompact.mjs",
  SessionStart: "sessionstart.mjs",
  UserPromptSubmit: "userpromptsubmit.mjs",
  Stop: "stop.mjs",
  SubagentStop: "subagentstop.mjs",
  SessionEnd: "sessionend.mjs",
};

// ─────────────────────────────────────────────────────────
// Hook validation
// ─────────────────────────────────────────────────────────

/** Required hooks that must be configured for context-mode to function. */
export const REQUIRED_HOOKS: HookType[] = [
  HOOK_TYPES.PRE_TOOL_USE,
  HOOK_TYPES.SESSION_START,
];

/** Optional hooks that enhance functionality but aren't critical. */
export const OPTIONAL_HOOKS: HookType[] = [
  HOOK_TYPES.POST_TOOL_USE,
  HOOK_TYPES.PRE_COMPACT,
  HOOK_TYPES.USER_PROMPT_SUBMIT,
  HOOK_TYPES.STOP,
  HOOK_TYPES.SUBAGENT_STOP,
  HOOK_TYPES.SESSION_END,
];

/**
 * Check if a hook entry points to a context-mode hook script.
 * Matches both legacy format (node .../pretooluse.mjs) and
 * CLI dispatcher format (context-mode hook claude-code pretooluse).
 */
export function isContextModeHook(
  entry: { hooks?: Array<{ command?: string }> },
  hookType: HookType,
): boolean {
  const scriptName = HOOK_SCRIPTS[hookType];
  const cliCommand = buildHookCommand(hookType);
  return (
    entry.hooks?.some((h) =>
      h.command?.includes(scriptName) || h.command?.includes(cliCommand),
    ) ?? false
  );
}

/**
 * Build the hook command string for a given hook type.
 * Uses process.execPath + forward slashes to avoid PATH issues and MSYS
 * path mangling on Windows (#369, #372).
 * Falls back to CLI dispatcher if pluginRoot is not provided.
 */
export function buildHookCommand(hookType: HookType, pluginRoot?: string): string {
  if (pluginRoot) {
    const scriptName = HOOK_SCRIPTS[hookType];
    return buildHookRuntimeCommand(`${pluginRoot}/hooks/${scriptName}`);
  }
  return `context-mode hook claude-code ${hookType.toLowerCase()}`;
}

/**
 * Extract the hook script file path from a command string.
 *
 * Algo-D2 twin — same shape as `src/util/hook-config.ts::extractHookScriptPath`.
 * Delegates to `parseNodeCommand` for canonical buildNodeCommand-shape;
 * keeps narrow legacy fallbacks for pre-D3 settings.json entries
 * (`node "X.mjs"` and `node X.mjs` with no internal whitespace).
 *
 * Pre-D2 this matched `node\s+"?([^"]+\.mjs)"?` — the unquoted fallback
 * silently grabbed the tail after the last whitespace, producing the
 * #548 doubled-path FAIL on Windows paths with spaces. The new shape
 * refuses ambiguous input; doctor (Algo-D1) falls through to direct
 * `existsSync` instead of trusting the regex.
 */
export function extractHookScriptPath(command: string): string | null {
  const parsed = parseNodeCommand(command);
  if (parsed) {
    return parsed.scriptPath.endsWith(".mjs") ? parsed.scriptPath : null;
  }
  const legacyQuoted = command.match(/^\s*node\s+"([^"]+\.mjs)"\s*$/);
  if (legacyQuoted) return legacyQuoted[1];
  const legacyBare = command.match(/^\s*node\s+(\S+\.mjs)\s*$/);
  if (legacyBare) return legacyBare[1];
  return null;
}

/**
 * Check if a hook entry is a context-mode hook (any hook type).
 * Broader than `isContextModeHook` — matches any context-mode script name
 * without requiring a specific hookType.
 */
export function isAnyContextModeHook(
  entry: { hooks?: Array<{ command?: string }> },
): boolean {
  const scriptNames = Object.values(HOOK_SCRIPTS);
  return (
    entry.hooks?.some((h) =>
      h.command != null &&
      (scriptNames.some((s) => h.command!.includes(s)) ||
        h.command.includes("context-mode hook")),
    ) ?? false
  );
}
