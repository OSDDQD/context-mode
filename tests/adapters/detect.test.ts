/**
 * detectPlatform / getAdapter — the four tiers, at two platforms.
 *
 * The tiers themselves did not change with the fifteen-host removal, and this
 * file still covers all of them in priority order: MCP clientInfo, the
 * CONTEXT_MODE_PLATFORM override, the env-var registry, and the fall-through.
 * What changed is that every "X beats Y" case now has one answer instead of
 * sixteen, and a new class of case appeared that did not exist before — a
 * signal from a removed host must resolve to nothing rather than to a
 * PlatformId with no adapter behind it. Those live in
 * detect-config-dir.test.ts and detect-ambiguity-matrix.test.ts alongside the
 * directory tier; here the concern is the env/clientInfo tiers and getAdapter.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { detectPlatform, getAdapter } from "../../src/adapters/detect.js";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code/index.js";
import { CodexAdapter } from "../../src/adapters/codex/index.js";

/**
 * Env vars that steer detection, plus the ones removed hosts used to set.
 *
 * The second group is not decoration: a developer running this suite inside
 * Cursor or with a Pi session in the shell would otherwise carry those
 * variables into every case. They no longer mean anything to detect.ts, but
 * clearing them keeps a failure here about the code rather than the machine.
 */
const ENV_TO_CLEAR = [
  // Live
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_PLUGIN_ROOT",
  "CODEX_CI",
  "CODEX_THREAD_ID",
  "CONTEXT_MODE_PLATFORM",
  // Removed hosts
  "GEMINI_PROJECT_DIR",
  "GEMINI_CLI",
  "KILO",
  "KILO_PID",
  "OPENCODE",
  "OPENCODE_PID",
  "OPENCODE_CLIENT",
  "OPENCODE_TERMINAL",
  "OPENCLAW_HOME",
  "OPENCLAW_CLI",
  "CURSOR_CWD",
  "CURSOR_SESSION_ID",
  "CURSOR_TRACE_ID",
  "VSCODE_PID",
  "VSCODE_CWD",
  "QWEN_PROJECT_DIR",
  "PI_CODING_AGENT_DIR",
  "PI_CONFIG_DIR",
  "PI_SESSION_FILE",
  "PI_COMPILED",
  "PI_CODING_AGENT",
  "PI_PROJECT_DIR",
  "IDEA_INITIAL_DIRECTORY",
  "ANTIGRAVITY_CLI_ALIAS",
  "ZED_TERM",
  "ZED_SESSION_ID",
];

describe("detectPlatform", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    for (const name of ENV_TO_CLEAR) delete process.env[name];
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  // ── Env-var tier ───────────────────────────────────────

  it.each([
    ["CLAUDE_PROJECT_DIR", "/some/project", "claude-code"],
    ["CLAUDE_SESSION_ID", "abc-123", "claude-code"],
    ["CLAUDE_CODE_ENTRYPOINT", "cli", "claude-code"],
    ["CLAUDE_PLUGIN_ROOT", "/plugins/context-mode/1.0.0", "claude-code"],
    ["CODEX_CI", "1", "codex"],
    ["CODEX_THREAD_ID", "t-1", "codex"],
  ])("%s → %s at high confidence", (name, value, expected) => {
    process.env[name] = value;
    const signal = detectPlatform();
    expect(signal.platform).toBe(expected);
    expect(signal.confidence).toBe("high");
    expect(signal.reason).toContain(name);
  });

  it("claude-code wins when both hosts' env vars are present", () => {
    // The registry is ordered and claude-code is first. This is the last
    // surviving instance of the ordering rule that used to run to sixteen
    // rows, and it is still the rule: order in PLATFORM_ENV_VARS decides.
    process.env.CODEX_THREAD_ID = "t-1";
    process.env.CLAUDE_PROJECT_DIR = "/p";
    expect(detectPlatform().platform).toBe("claude-code");
  });

  it("an empty env var is not a signal", () => {
    process.env.CODEX_THREAD_ID = "";
    const signal = detectPlatform();
    expect(signal.confidence).not.toBe("high");
  });

  it("returns a supported platform when nothing is set", () => {
    const signal = detectPlatform();
    expect(["claude-code", "codex"]).toContain(signal.platform);
  });

  // ── clientInfo tier ────────────────────────────────────

  it.each([
    ["claude-code", "claude-code"],
    ["Codex", "codex"],
    ["codex-mcp-client", "codex"],
  ])("clientInfo.name=%s → %s at high confidence", (name, expected) => {
    const signal = detectPlatform({ name });
    expect(signal.platform).toBe(expected);
    expect(signal.confidence).toBe("high");
    expect(signal.reason).toContain(name);
  });

  it("clientInfo takes priority over env vars", () => {
    process.env.CLAUDE_PROJECT_DIR = "/p";
    expect(detectPlatform({ name: "Codex" }).platform).toBe("codex");
  });

  it("unknown clientInfo falls through to env var detection", () => {
    process.env.CODEX_CI = "1";
    expect(detectPlatform({ name: "some-unknown-client" }).platform).toBe("codex");
  });

  it("a removed host's clientInfo falls through rather than naming it", () => {
    // A Cursor or Qwen build still pointed at this server announces itself in
    // the handshake. Resolving that name would produce a PlatformId with no
    // adapter; falling through hands it the claude-code default instead.
    process.env.CODEX_CI = "1";
    for (const name of ["cursor-vscode", "qwen-cli-mcp-client-fs", "Kiro CLI", "Pi CLI"]) {
      expect(detectPlatform({ name }).platform).toBe("codex");
    }
  });

  // ── CONTEXT_MODE_PLATFORM override ─────────────────────

  it.each([["claude-code"], ["codex"]])("CONTEXT_MODE_PLATFORM=%s is honored", (platform) => {
    process.env.CONTEXT_MODE_PLATFORM = platform;
    const signal = detectPlatform();
    expect(signal.platform).toBe(platform);
    expect(signal.confidence).toBe("high");
  });

  it("CONTEXT_MODE_PLATFORM takes priority over env vars", () => {
    process.env.CLAUDE_PROJECT_DIR = "/p";
    process.env.CONTEXT_MODE_PLATFORM = "codex";
    expect(detectPlatform().platform).toBe("codex");
  });

  it("clientInfo takes priority over CONTEXT_MODE_PLATFORM", () => {
    process.env.CONTEXT_MODE_PLATFORM = "codex";
    expect(detectPlatform({ name: "claude-code" }).platform).toBe("claude-code");
  });

  it.each([["not-a-platform"], ["cursor"], ["pi"], ["opencode"]])(
    "CONTEXT_MODE_PLATFORM=%s is ignored",
    (value) => {
      // Both an outright typo and a config still pinning a removed host must
      // fall through to real detection. The second case is the live one: the
      // antigravity-cli plugin bundle shipped CONTEXT_MODE_PLATFORM pinned.
      process.env.CONTEXT_MODE_PLATFORM = value;
      process.env.CODEX_CI = "1";
      expect(detectPlatform().platform).toBe("codex");
    },
  );
});

// ─────────────────────────────────────────────────────────
// getAdapter
// ─────────────────────────────────────────────────────────

describe("getAdapter", () => {
  it("returns ClaudeCodeAdapter for claude-code", async () => {
    expect(await getAdapter("claude-code")).toBeInstanceOf(ClaudeCodeAdapter);
  });

  it("returns CodexAdapter for codex", async () => {
    expect(await getAdapter("codex")).toBeInstanceOf(CodexAdapter);
  });

  it("returns ClaudeCodeAdapter for unknown platform", async () => {
    expect(await getAdapter("unknown")).toBeInstanceOf(ClaudeCodeAdapter);
  });

  it.each(["cursor", "pi", "opencode", "gemini-cli", "kimi", "zed"])(
    "falls back to ClaudeCodeAdapter for the removed platform %s",
    async (platform) => {
      // getAdapter's switch lost fifteen cases, and its default catches them.
      // The failure this guards against is a case being reintroduced as a
      // dangling dynamic import: the module is gone, so the import would
      // reject at runtime rather than fail the build.
      expect(await getAdapter(platform as never)).toBeInstanceOf(ClaudeCodeAdapter);
    },
  );
});

// ─────────────────────────────────────────────────────────
// Issue #545 — PLATFORM_ENV_VARS typed with workspace/identification roles.
//
// The registry splits each entry into {name, role} so resolveProjectDir can
// derive ALLOW (own workspace vars) and BAN (the other host's workspace vars)
// algorithmically rather than from a hand-written list. That property is what
// let the registry shrink from seventeen rows to two without touching the
// resolver, and it is what the next host will inherit.
// ─────────────────────────────────────────────────────────

describe("PLATFORM_ENV_VARS — typed registry (issue #545 algorithmic design)", () => {
  it("each entry tags name + role: 'workspace' | 'identification'", async () => {
    const { PLATFORM_ENV_VARS } = await import("../../src/adapters/detect.js");
    const claudeEntries = PLATFORM_ENV_VARS.get("claude-code");
    expect(claudeEntries).toBeDefined();
    expect(claudeEntries).toContainEqual({ name: "CLAUDE_PROJECT_DIR", role: "workspace" });
    expect(claudeEntries).toContainEqual({ name: "CLAUDE_CODE_ENTRYPOINT", role: "identification" });
    expect(claudeEntries).toContainEqual({ name: "CLAUDE_PLUGIN_ROOT", role: "identification" });
    expect(claudeEntries).toContainEqual({ name: "CLAUDE_SESSION_ID", role: "identification" });

    const codexEntries = PLATFORM_ENV_VARS.get("codex");
    expect(codexEntries).toContainEqual({ name: "CODEX_THREAD_ID", role: "identification" });
    expect(codexEntries).toContainEqual({ name: "CODEX_CI", role: "identification" });
  });

  it("carries exactly the supported platforms", async () => {
    const { PLATFORM_ENV_VARS } = await import("../../src/adapters/detect.js");
    expect([...PLATFORM_ENV_VARS.keys()].sort()).toEqual(["claude-code", "codex"]);
  });

  it("every entry has a valid role and a non-empty name", async () => {
    const { PLATFORM_ENV_VARS } = await import("../../src/adapters/detect.js");
    for (const [host, entries] of PLATFORM_ENV_VARS) {
      expect(entries.length, `${host} has no env vars`).toBeGreaterThan(0);
      for (const e of entries) {
        expect(e.name.length, `${host}: empty env var name`).toBeGreaterThan(0);
        expect(["workspace", "identification"]).toContain(e.role);
      }
    }
  });

  it("getEnvVarNames(p) shim returns string[] for backwards compatibility", async () => {
    const { getEnvVarNames } = await import("../../src/adapters/detect.js");
    const names = getEnvVarNames("claude-code");
    expect(Array.isArray(names)).toBe(true);
    expect(names).toContain("CLAUDE_PROJECT_DIR");
    expect(names).toContain("CLAUDE_CODE_ENTRYPOINT");
  });

  it("workspaceEnvVarsFor(p) returns only role=workspace names in registry order", async () => {
    const { workspaceEnvVarsFor } = await import("../../src/adapters/detect.js");
    expect(workspaceEnvVarsFor("claude-code")).toEqual(["CLAUDE_PROJECT_DIR"]);
    // Codex has no workspace var — it passes cwd in hook stdin instead.
    expect(workspaceEnvVarsFor("codex")).toEqual([]);
  });

  it("foreignWorkspaceEnv(p) returns workspace vars from the OTHER platform only", async () => {
    const { foreignWorkspaceEnv } = await import("../../src/adapters/detect.js");
    const banForCodex = foreignWorkspaceEnv("codex");
    // The live hazard: a Codex session started from a shell where Claude Code
    // exported CLAUDE_PROJECT_DIR must not adopt that project directory.
    expect(banForCodex.has("CLAUDE_PROJECT_DIR")).toBe(true);
    // Identification vars are NOT in the workspace ban set — they belong to
    // foreignIdentificationEnv (#561).
    expect(banForCodex.has("CLAUDE_PLUGIN_ROOT")).toBe(false);
    expect(banForCodex.has("CLAUDE_CODE_ENTRYPOINT")).toBe(false);
    // Claude Code has no foreign workspace var to ban: codex declares none.
    expect([...foreignWorkspaceEnv("claude-code")]).toEqual([]);
  });

  it("foreignIdentificationEnv(p) returns identification vars from the OTHER platform", async () => {
    const { foreignIdentificationEnv } = await import("../../src/adapters/detect.js");
    const banForCodex = foreignIdentificationEnv("codex");
    // Without this scrub a Codex child inheriting CLAUDE_CODE_ENTRYPOINT
    // detects as claude-code and writes its session data into ~/.claude/.
    expect(banForCodex.has("CLAUDE_CODE_ENTRYPOINT")).toBe(true);
    expect(banForCodex.has("CLAUDE_PLUGIN_ROOT")).toBe(true);
    expect(banForCodex.has("CLAUDE_SESSION_ID")).toBe(true);
    // Codex's OWN identification vars must survive its own scrub.
    expect(banForCodex.has("CODEX_THREAD_ID")).toBe(false);
    expect(banForCodex.has("CODEX_CI")).toBe(false);
    // Workspace-role vars are NEVER in the identification ban set.
    expect(banForCodex.has("CLAUDE_PROJECT_DIR")).toBe(false);

    const banForClaude = foreignIdentificationEnv("claude-code");
    expect(banForClaude.has("CODEX_THREAD_ID")).toBe(true);
    expect(banForClaude.has("CODEX_CI")).toBe(true);
    expect(banForClaude.has("CLAUDE_CODE_ENTRYPOINT")).toBe(false);
  });

  it("foreignIdentificationEnv is symmetric — every host excludes its own identification vars", async () => {
    const { foreignIdentificationEnv, PLATFORM_ENV_VARS } = await import("../../src/adapters/detect.js");
    for (const [host, entries] of PLATFORM_ENV_VARS) {
      const ban = foreignIdentificationEnv(host);
      for (const e of entries) {
        if (e.role === "identification") {
          expect(
            ban.has(e.name),
            `host=${host}: own identification var ${e.name} must NOT be in its own ban set`,
          ).toBe(false);
        }
      }
    }
  });

  it("getSessionDirSegments answers for the supported platforms and nothing else", async () => {
    const { getSessionDirSegments } = await import("../../src/adapters/detect.js");
    expect(getSessionDirSegments("claude-code")).toEqual([".claude"]);
    expect(getSessionDirSegments("codex")).toEqual([".codex"]);
    // A removed platform must return null so the caller picks its own safe
    // fallback rather than being handed a directory nothing writes to.
    for (const gone of ["cursor", "pi", "opencode", "kilo", "zed", "unknown"]) {
      expect(getSessionDirSegments(gone), `${gone} should not resolve`).toBeNull();
    }
  });
});
