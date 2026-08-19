/**
 * adapters/types — Platform adapter interface for multi-platform hook support.
 *
 * Defines the contract that each platform adapter must implement.
 *
 * Both supported hosts — Claude Code and Codex CLI — speak JSON on hook
 * stdin/stdout; they disagree only about the response envelope and about
 * which mutations they accept (see PlatformCapabilities). A `HookParadigm`
 * field used to sit on every adapter naming one of three wire styles: this
 * one, TS plugin functions (OpenCode, KiloCode, OpenClaw), and MCP-only hosts
 * with no hook layer at all (Antigravity, Zed). The other two paradigms left
 * with their hosts, and a field that can hold one value is not a field, so it
 * is gone; when a host arrives that does not speak this protocol, its adapter
 * is where that shows, not a label on the interface.
 *
 * The MCP server layer is 100% portable and needs no adapter.
 * Only the hook layer requires platform-specific adapters.
 */

import { resolveHookRuntime } from "../runtime.js";

// ─────────────────────────────────────────────────────────
// Platform capabilities
// ─────────────────────────────────────────────────────────

export interface PlatformCapabilities {
  /** Platform supports PreToolUse / BeforeTool / tool.execute.before hooks. */
  preToolUse: boolean;
  /** Platform supports PostToolUse / AfterTool / tool.execute.after hooks. */
  postToolUse: boolean;
  /** Platform supports PreCompact / PreCompress / session.compacting hooks. */
  preCompact: boolean;
  /** Platform supports SessionStart / session.created hooks. */
  sessionStart: boolean;
  /** Platform allows modifying tool input arguments via hooks. */
  canModifyArgs: boolean;
  /** Platform allows modifying tool output via PostToolUse hooks. */
  canModifyOutput: boolean;
  /** Platform allows injecting context during session start or compaction. */
  canInjectSessionContext: boolean;
}

// ─────────────────────────────────────────────────────────
// Normalized hook event types
// ─────────────────────────────────────────────────────────

/** Normalized PreToolUse event — platform-agnostic representation. */
export interface PreToolUseEvent {
  /** Tool name being invoked (e.g., "Bash", "Read", "WebFetch"). */
  toolName: string;
  /** Tool input arguments as key-value pairs. */
  toolInput: Record<string, unknown>;
  /** Session ID extracted by the adapter. */
  sessionId: string;
  /** Project directory (if available). */
  projectDir?: string;
  /** Raw platform-specific input (for passthrough if needed). */
  raw: unknown;
}

/** Normalized PostToolUse event — platform-agnostic representation. */
export interface PostToolUseEvent {
  /** Tool name that was invoked. */
  toolName: string;
  /** Tool input arguments. */
  toolInput: Record<string, unknown>;
  /** Tool output/response (if available). */
  toolOutput?: string;
  /** Whether the tool call resulted in an error. */
  isError?: boolean;
  /** Session ID extracted by the adapter. */
  sessionId: string;
  /** Project directory (if available). */
  projectDir?: string;
  /** Raw platform-specific input. */
  raw: unknown;
}

/** Normalized PreCompact event. */
export interface PreCompactEvent {
  /** Session ID. */
  sessionId: string;
  /** Project directory (if available). */
  projectDir?: string;
  /** Raw platform-specific input. */
  raw: unknown;
}

/** Normalized SessionStart event. */
export interface SessionStartEvent {
  /** Session ID. */
  sessionId: string;
  /** Lifecycle source: fresh start, compaction, resume, or clear. */
  source: "startup" | "compact" | "resume" | "clear";
  /** Project directory (if available). */
  projectDir?: string;
  /** Raw platform-specific input. */
  raw: unknown;
}

// ─────────────────────────────────────────────────────────
// Hook response types
// ─────────────────────────────────────────────────────────

/** Response from PreToolUse hook — can block, modify, inject context, or pass through. */
export interface PreToolUseResponse {
  /**
   * "allow"   = pass through (no action)
   * "deny"    = block tool execution
   * "modify"  = change input args
   * "context" = inject additional context (soft guidance)
   * "ask"     = prompt user for confirmation (security policy match)
   */
  decision: "allow" | "deny" | "modify" | "context" | "ask";
  /** Reason for denial (shown to the model). */
  reason?: string;
  /** Modified tool input (only when decision = "modify"). */
  updatedInput?: Record<string, unknown>;
  /** Additional context to inject (only when decision = "context"). */
  additionalContext?: string;
}

/** Response from PostToolUse hook — can inject context or modify output. */
export interface PostToolUseResponse {
  /** Additional context to inject after tool output. */
  additionalContext?: string;
  /** Modified tool output (if platform supports it). */
  updatedOutput?: string;
}

/** Response from PreCompact hook — injects context before compaction. */
export interface PreCompactResponse {
  /** Context to preserve across compaction. */
  context?: string;
}

/** Response from SessionStart hook — injects context at session start. */
export interface SessionStartResponse {
  /** Context to inject at session start. */
  context?: string;
}

// ─────────────────────────────────────────────────────────
// Hook config types
// ─────────────────────────────────────────────────────────

/** A single hook entry in platform configuration. */
export interface HookEntry {
  /** Tool matcher pattern (empty = match all). */
  matcher: string;
  /** Hook commands/handlers to execute. */
  hooks: Array<{
    type: string;
    command: string;
    /**
     * Seconds the host waits before killing the hook process.
     *
     * Optional because not every platform honours it, but omitting it where it
     * IS honoured is not a neutral default: Claude Code falls back to 60s, and
     * a minute of silence in front of a tool call is indistinguishable from a
     * hung terminal. Adapters that can set it should — graded by where the hook
     * sits, not uniformly (see HOOK_TIMEOUTS in adapters/claude-code/hooks.ts).
     */
    timeout?: number;
  }>;
}

/** Hook registration map — maps hook types to their entries. */
export type HookRegistration = Record<string, HookEntry[]>;

// ─────────────────────────────────────────────────────────
// Adapter interface
// ─────────────────────────────────────────────────────────

/**
 * HookAdapter — contract for platform-specific hook implementations.
 *
 * Each supported platform (Claude Code, Gemini CLI, OpenCode, etc.)
 * provides an adapter that normalizes its hook I/O into a common format.
 */
export interface HookAdapter {
  /** Human-readable platform name (e.g., "Claude Code", "Gemini CLI"). */
  readonly name: string;

  /**
   * What this platform supports.
   *
   * Declarative, and currently read by no production code: each adapter's
   * format methods already refuse what its host cannot accept (Codex drops
   * `updatedInput` and `updatedMCPToolOutput` on the floor rather than
   * emitting them). It is kept because the two hosts genuinely disagree here
   * and a new adapter has to answer the question before it can compile.
   */
  readonly capabilities: PlatformCapabilities;

  // ── Input parsing ──────────────────────────────────────

  /** Parse raw PreToolUse input into normalized form. */
  parsePreToolUseInput(raw: unknown): PreToolUseEvent;

  /** Parse raw PostToolUse input into normalized form. */
  parsePostToolUseInput(raw: unknown): PostToolUseEvent;

  /** Parse raw PreCompact input. */
  parsePreCompactInput(raw: unknown): PreCompactEvent;

  /** Parse raw SessionStart input. */
  parseSessionStartInput(raw: unknown): SessionStartEvent;

  // ── Response formatting ────────────────────────────────

  /** Format a PreToolUse response into platform-specific output. */
  formatPreToolUseResponse(response: PreToolUseResponse): unknown;

  /** Format a PostToolUse response into platform-specific output. */
  formatPostToolUseResponse(response: PostToolUseResponse): unknown;

  /**
   * Format a PreCompact response into platform-specific output.
   *
   * Required, not optional. These four were optional for hosts with no hook
   * layer, which registered an adapter only to answer path questions. Both
   * remaining hosts implement all four, so an adapter that silently omits one
   * would be a compaction that quietly stops preserving context — the exact
   * failure the optional marker used to hide.
   */
  formatPreCompactResponse(response: PreCompactResponse): unknown;

  /** Format a SessionStart response into platform-specific output. */
  formatSessionStartResponse(response: SessionStartResponse): unknown;

  // ── Configuration ──────────────────────────────────────

  /** Path to the platform's settings file (e.g., ~/.claude/settings.json). */
  getSettingsPath(): string;

  /**
   * Directory where session data is stored.
   *
   * NOTE — C2 narrowing (2026-05): this is the ONLY storage-path concern an
   * adapter exposes. Per-project DB paths are derived by callers via
   * `resolveSessionDbPath({ projectDir, sessionsDir: adapter.getSessionDir() })`
   * (see `src/session/db.ts`). Per-project events.md paths follow the same
   * `<sessionDir>/<hash><suffix>-events.md` shape and are computed inline at
   * the small number of call sites that need them (server.ts, hooks).
   */
  getSessionDir(): string;

  /**
   * Platform config directory.
   *
   * Contract: ALWAYS returns an absolute path. Never returns a relative
   * segment, never returns an empty string. This eliminates the leaky-seam
   * where callers could not tell whether the return needed further resolution.
   *
   * Resolution rules:
   *   - Home-rooted platforms return paths under `homedir()` / XDG / APPDATA.
   *     Both remaining adapters are home-rooted: claude-code at
   *     `$CLAUDE_CONFIG_DIR` or `~/.claude`, codex at `$CODEX_HOME` or
   *     `~/.codex`.
   *   - A project-scoped platform (the departed hosts put their config in
   *     `.cursor`, `.github`, `.kiro`, or the project root) resolves its
   *     segment against the supplied `projectDir`, falling back to
   *     `process.cwd()` when it is omitted. Nothing does this today; the
   *     parameter stays because it is what makes "absolute path" a property
   *     of the adapter rather than of the caller.
   *
   * @param projectDir Optional project root used to resolve project-scoped
   *                   adapters. Ignored by home-rooted adapters.
   */
  getConfigDir(projectDir?: string): string;

  /**
   * Names of platform-native instruction/rule files that act as the
   * project's "user CLAUDE.md equivalent" (e.g., ["CLAUDE.md"],
   * ["AGENTS.md"], ["GEMINI.md"]). Auto-memory scans for these in the
   * project root and config dir, and rule-detection emits "rule" events
   * when they are read.
   */
  getInstructionFiles(): string[];

  /**
   * Directory where persistent per-user memory is stored
   * (e.g., ~/.claude/memory, ~/.codex/memories). Auto-memory scans
   * *.md files in this directory.
   *
   * When `projectDir` is supplied, the path MUST be project-scoped (issue
   * #663) so two projects running in parallel cannot read each other's
   * memory. Adapters scope via `hashProjectDirCanonical(projectDir)`.
   * Callers that pre-date this contract may omit `projectDir`; in that
   * case the unscoped legacy path is returned.
   */
  getMemoryDir(projectDir?: string): string;

  /** Generate hook registration config for this platform. */
  generateHookConfig(pluginRoot: string): HookRegistration;

  /** Read current platform settings. */
  readSettings(): Record<string, unknown> | null;

  /** Write platform settings. */
  writeSettings(settings: Record<string, unknown>): void;

  // ── Diagnostics (doctor) ───────────────────────────────

  /** Validate that hooks are properly configured for this platform. */
  validateHooks(pluginRoot: string): DiagnosticResult[];

  /**
   * Adapter-defined per-platform health checks (Algo-D1).
   *
   * OPTIONAL, and genuinely so: claude-code implements it with hook-script
   * existence checks that join `pluginRoot + scriptName` directly via
   * `existsSync` (so doctor never round-trips through a regex on a hook
   * command — the #548 root cause), while codex ships its hook config inside
   * the host's own `hooks.json` and has no per-script file to probe.
   *
   * The doctor iterates `adapter.getHealthChecks?.(pluginRoot) ?? []` and
   * renders each — no per-adapter wiring in the doctor body.
   */
  getHealthChecks?(pluginRoot: string): readonly HealthCheck[];

  /** Check if the plugin is registered/enabled on this platform. */
  checkPluginRegistration(): DiagnosticResult;

  /**
   * Get the installed version from this platform's registry/marketplace, or
   * "standalone" when no platform-owned plugin version exists.
   */
  getInstalledVersion(): string;

  // ── Upgrade ────────────────────────────────────────────

  /** Configure all hooks for this platform. Returns change descriptions. */
  configureAllHooks(pluginRoot: string): string[];

  /** Backup platform settings before modification. Returns backup path or null. */
  backupSettings(): string | null;

  /** Set executable permissions on hook scripts. Returns paths that were set. */
  setHookPermissions(pluginRoot: string): string[];

  /** Update platform's plugin registry to point to given path and version. */
  updatePluginRegistry(pluginRoot: string, version: string): void;

}

// ─────────────────────────────────────────────────────────
// Diagnostic result
// ─────────────────────────────────────────────────────────

/** Result from a platform-specific diagnostic check. */
export interface DiagnosticResult {
  /** What was checked. */
  check: string;
  /** Pass, fail, or warning. */
  status: "pass" | "fail" | "warn";
  /** Human-readable message. */
  message: string;
  /** Suggested fix command (if applicable). */
  fix?: string;
}

/**
 * Adapter-defined health check (Algo-D1).
 *
 * Lighter-weight than `DiagnosticResult`: adapters declare a name and a
 * synchronous `check()` thunk. The doctor renders the result. The
 * thunk-style intentionally avoids forcing adapters into async — the
 * existsSync probe used by claude-code is sync and the doctor invokes it
 * directly without an `await`. Adapters needing async work return a
 * pre-resolved status (the check ran at thunk-creation time) or extend
 * `validateHooks()` instead.
 */
export interface HealthCheck {
  /** Human-readable check title (e.g. "Hook script exists: pretooluse.mjs"). */
  readonly name: string;
  /** Synchronous check thunk. Returns OK or FAIL with optional detail. */
  check(): { status: "OK" | "FAIL"; detail?: string };
}

// ─────────────────────────────────────────────────────────
// Platform detection
// ─────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────
// Cross-platform command helpers (#369, #372)
// ─────────────────────────────────────────────────────────

/**
 * Build a cross-platform `node <script>` command string.
 *
 * Fixes two Windows bugs:
 *   #369 — Bare `node` fails on Windows Git Bash (MSYS) because PATH
 *          resolution is unreliable. Uses `process.execPath` instead.
 *   #372 — MSYS rewrites absolute paths on non-C: drives (e.g.
 *          `C:\Users\...` → `D:\c\Users\...`). Forward slashes +
 *          double-quoting prevents the translation.
 *
 * Safe on macOS/Linux — quoting and forward slashes are no-ops there.
 */
export function buildNodeCommand(scriptPath: string): string {
  const nodePath = process.execPath.replace(/\\/g, "/");
  const safePath = scriptPath.replace(/\\/g, "/");
  return `"${nodePath}" "${safePath}"`;
}

/**
 * Build a cross-platform hook spawn command using the resolved JS runtime
 * (issue #738). Identical wire-format to {@link buildNodeCommand} — two
 * double-quoted, forward-slashed tokens separated by whitespace — so it
 * round-trips through {@link parseNodeCommand} unchanged.
 *
 * The only difference is the runtime path: when a Bun ≥1.0 install is
 * detected at process start, that path is used in place of `process.execPath`.
 * Hooks run end-to-end in pure JS (no native modules) so swapping the
 * runtime is a no-op for output but cuts ~40-60ms of Node cold-start per
 * tool call.
 *
 * Why a SEPARATE helper instead of repurposing {@link buildNodeCommand}:
 *   a user-visible CLI command must stay on Node, because those entry points
 *   load better-sqlite3 and it has no Bun-compatible prebuild yet (#543).
 *   The caller that made this concrete — the OpenClaw plugin’s doctor and
 *   upgrade suggestions — is gone, but the split is what keeps the audit
 *   trivial: anything emitting a hook spawn command uses
 *   `buildHookRuntimeCommand`, anything emitting a command a human will run
 *   stays on `buildNodeCommand`.
 */
export function buildHookRuntimeCommand(scriptPath: string): string {
  const runtime = resolveHookRuntime();
  const runtimePath = runtime.path.replace(/\\/g, "/");
  const safePath = scriptPath.replace(/\\/g, "/");
  return `"${runtimePath}" "${safePath}"`;
}

/**
 * Strict inverse of `buildNodeCommand`.
 *
 * Returns `{ nodePath, scriptPath }` ONLY when `cmd` could have been
 * produced by `buildNodeCommand` — i.e. exactly two double-quoted args
 * separated by whitespace. Anything else (bare `node …`, single quotes,
 * unquoted ambiguous input, CLI dispatcher entries) returns `null`.
 *
 * Why strict: the legacy `\S+\.mjs` fallback in
 * `src/util/hook-config.ts:24` and the two-step regex in
 * `src/adapters/claude-code/hooks.ts:178` silently grabbed the path tail
 * after the last whitespace whenever the host wire-format dropped quotes,
 * producing the #548 doubled-path FAIL when `pluginRoot` contained
 * spaces (e.g. `C:\Users\High Ground Services\…`). A canonical inverse
 * lets every emit (`buildNodeCommand`) round-trip through every parse
 * (`parseNodeCommand`) without inventing fallbacks. The next adapter inherits
 * the contract by importing one module.
 */
export function parseNodeCommand(
  cmd: string,
): { nodePath: string; scriptPath: string } | null {
  if (typeof cmd !== "string" || cmd.length === 0) return null;
  // Match `"<nodePath>" "<scriptPath>"` with arbitrary whitespace
  // separator. Both segments must be non-empty and contain no embedded
  // double quotes — buildNodeCommand never emits embedded quotes.
  const m = cmd.match(/^"([^"]+)"\s+"([^"]+)"\s*$/);
  if (!m) return null;
  return { nodePath: m[1], scriptPath: m[2] };
}

/** Known JS runtime binary names (base filename without extension). */
export const JS_RUNTIMES: ReadonlySet<string> = new Set(["node", "bun", "deno"]);

/** Supported platform identifiers. */
export type PlatformId =
  | "claude-code"
  | "codex"
  | "unknown";

/** Detection signal used to identify which platform is running. */
export interface DetectionSignal {
  /** Platform identifier. */
  platform: PlatformId;
  /** Confidence: env var match > config dir match > fallback. */
  confidence: "high" | "medium" | "low";
  /** How it was detected. */
  reason: string;
}
