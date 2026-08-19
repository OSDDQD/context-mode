/**
 * Platform detection from process env vars.
 *
 * Each supported platform sets a distinctive env var when invoking hook
 * scripts; we use those to pick the correct tool-namer prefix and routing
 * block. Falls back to "claude-code" when nothing matches, so a host that
 * sets nothing recognisable still gets working guidance rather than none.
 *
 * ── On the "MUST stay in lock-step" rule this file used to carry ──
 *
 * The old header ordered this table to stay byte-identical with
 * `PLATFORM_ENV_VARS` in `src/adapters/detect.ts`, in capitals, because a
 * divergence would make the MCP server and the hook scripts disagree about
 * which host is running. The rule did not work: by the time it was removed
 * this mirror listed two Claude Code variables where detect.ts listed four,
 * so `CLAUDE_CODE_ENTRYPOINT` and `CLAUDE_PLUGIN_ROOT` identified the host on
 * one side and not the other. A prose MUST cannot hold two hand-copied tables
 * together; it only records the intention of whoever wrote it last.
 *
 * What actually has to hold is narrower than byte-identity, and is worth
 * stating precisely: for any environment, both sides must resolve the SAME
 * platform. Two tables can differ in ordering, in comments, and in variables
 * that no longer discriminate anything, and still satisfy that. So the
 * requirement is now an executable one — `tests/hooks/platform-detect.test.ts`
 * imports detect.ts's own table and asserts agreement on every variable in it,
 * per platform. Add a variable on either side and the test says so; nobody has
 * to remember.
 *
 * Two remarks that used to need saying and no longer do. Ordering was
 * load-bearing when forks had to be listed before their parent (Cursor before
 * VS Code, which inherits `VSCODE_PID`); with two hosts whose variables share
 * no prefix, order cannot change an answer. And the disambiguation logic in
 * detect.ts for Claude Code running inside a VS Code terminal has nothing left
 * to disambiguate against — that path is dead on this side, which is why this
 * file is a flat scan and detect.ts is not.
 */

/**
 * The two supported hosts and the variables that identify them.
 * Mirrors the claude-code and codex rows of `PLATFORM_ENV_VARS` in
 * src/adapters/detect.ts; agreement is asserted by the test named above.
 */
const PLATFORM_ENV_VARS_MIRROR = [
  // Verified against a live `env` dump (2026-05-11): ENTRYPOINT is set on
  // every session, PLUGIN_ROOT when a plugin is loaded, PROJECT_DIR in hooks
  // context, SESSION_ID as the legacy session marker.
  ["claude-code", [
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_PLUGIN_ROOT",
    "CLAUDE_PROJECT_DIR",
    "CLAUDE_SESSION_ID",
  ]],
  ["codex", ["CODEX_THREAD_ID", "CODEX_CI"]],
];

export function detectPlatformFromEnv(env = process.env) {
  for (const [platform, vars] of PLATFORM_ENV_VARS_MIRROR) {
    if (vars.some((v) => env[v])) return platform;
  }
  return "claude-code";
}

// Re-exported for tests so they can assert against the same canonical table.
export { PLATFORM_ENV_VARS_MIRROR };
