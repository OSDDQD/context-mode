/**
 * Behavioral tests for the medium-confidence config-directory branch of
 * detectPlatform() and the env-var priority chain.
 *
 * The adjacent detect.test.ts covers clientInfo and the CONTEXT_MODE_PLATFORM
 * override in depth; this file owns the two tiers below it — the `~/.<platform>`
 * existsSync checks and the ordering of the env-var registry — by mocking
 * `node:fs` so each branch is forced deterministically.
 *
 * After the fifteen-host removal both tiers are short, and the interesting
 * assertions moved: what used to be "which of seventeen wins" is now "the two
 * that remain resolve correctly, AND every signal belonging to a removed host
 * resolves to nothing". The second half is new and matters more — a stale
 * ~/.cursor directory or a CURSOR_TRACE_ID left in a shell must not name a
 * platform we no longer have an adapter for.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolve } from "node:path";
import { homedir } from "node:os";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: vi.fn() };
});

// Imports after vi.mock so the mock is in place before detect.ts resolves fs.
import * as fs from "node:fs";
import { detectPlatform, PLATFORM_ENV_VARS } from "../../src/adapters/detect.js";

const existsSyncMock = vi.mocked(fs.existsSync);

// Derived from detect.ts's source-of-truth list so renames can't drift.
const ALL_PLATFORM_ENV_VARS = [
  ...[...PLATFORM_ENV_VARS.values()].flatMap((vars) => vars.map((v) => v.name)),
  "CONTEXT_MODE_PLATFORM",
];

/**
 * Env vars the registry used to carry, one per removed host.
 *
 * These are no longer in PLATFORM_ENV_VARS, which is the point: a shell that
 * still exports one must not steer detection anywhere.
 */
const REMOVED_HOST_ENV: Array<[string, string]> = [
  ["CURSOR_TRACE_ID", "trace-abc"],
  ["CURSOR_CLI", "1"],
  ["VSCODE_PID", "99"],
  ["ANTIGRAVITY_CLI_ALIAS", "agtg"],
  ["KILO_PID", "12345"],
  ["OPENCODE", "1"],
  ["OPENCODE_CLIENT", "desktop"],
  ["ZED_TERM", "1"],
  ["GEMINI_CLI", "1"],
  ["QWEN_PROJECT_DIR", "/p"],
  ["PI_CODING_AGENT", "true"],
  ["PI_CODING_AGENT_DIR", "/p"],
  ["IDEA_INITIAL_DIRECTORY", "/p"],
];

describe("detectPlatform — config directory branches", () => {
  const home = homedir();
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    for (const v of ALL_PLATFORM_ENV_VARS) delete process.env[v];
    for (const [name] of REMOVED_HOST_ENV) delete process.env[name];
    existsSyncMock.mockReset();
  });

  afterEach(() => {
    process.env = savedEnv;
    existsSyncMock.mockReset();
  });

  const forceDir = (target: string) => {
    existsSyncMock.mockImplementation(((p: unknown) => p === target) as typeof fs.existsSync);
  };

  it.each<[string, string]>([
    [".claude", "claude-code"],
    [".codex", "codex"],
  ])("detects %s → %s at medium confidence", (dir, expected) => {
    forceDir(resolve(home, dir));
    const signal = detectPlatform();
    expect(signal.platform).toBe(expected);
    expect(signal.confidence).toBe("medium");
    expect(signal.reason).toContain(dir);
  });

  it("falls back to claude-code low-confidence when no dirs exist", () => {
    existsSyncMock.mockReturnValue(false);
    const signal = detectPlatform();
    expect(signal.platform).toBe("claude-code");
    expect(signal.confidence).toBe("low");
    expect(signal.reason).toContain("No platform detected");
  });

  it("prefers ~/.claude over ~/.codex when both dirs exist", () => {
    existsSyncMock.mockImplementation((
      ((p: unknown) =>
        p === resolve(home, ".claude") || p === resolve(home, ".codex")) as typeof fs.existsSync
    ));
    expect(detectPlatform().platform).toBe("claude-code");
  });

  it("env var wins over a matching config dir", () => {
    forceDir(resolve(home, ".claude"));
    process.env.CODEX_CI = "1";
    const signal = detectPlatform();
    expect(signal.platform).toBe("codex");
    expect(signal.confidence).toBe("high");
  });

  it("CONTEXT_MODE_PLATFORM override wins over a matching config dir", () => {
    forceDir(resolve(home, ".claude"));
    process.env.CONTEXT_MODE_PLATFORM = "codex";
    const signal = detectPlatform();
    expect(signal.platform).toBe("codex");
    expect(signal.confidence).toBe("high");
  });

  it("CONTEXT_MODE_PLATFORM naming a removed host is ignored, not honored", () => {
    // The override is validated against the supported set. A config that still
    // pins CONTEXT_MODE_PLATFORM=cursor — the antigravity-cli plugin bundle
    // shipped exactly this shape — must fall through to real detection rather
    // than name a platform with no adapter behind it.
    forceDir(resolve(home, ".claude"));
    process.env.CONTEXT_MODE_PLATFORM = "cursor";
    const signal = detectPlatform();
    expect(signal.platform).toBe("claude-code");
    expect(signal.confidence).toBe("medium");
  });

  describe("signals from removed hosts steer nothing", () => {
    it.each<[string]>([
      [".cursor"],
      [".gemini"],
      [".kiro"],
      [".pi"],
      [".omp"],
      [".qwen"],
      [".kimi-code"],
      [".openclaw"],
      [".vscode"],
      [".copilot"],
    ])("bare ~/%s resolves to the low-confidence default", (dir) => {
      forceDir(resolve(home, dir));
      const signal = detectPlatform();
      expect(signal.platform).toBe("claude-code");
      expect(signal.confidence).toBe("low");
    });

    it.each<[string[]]>([
      [[".local", "bin", "agy"]],
      [[".gemini", "antigravity-cli"]],
      [[".gemini", "config", "mcp_config.json"]],
      [[".copilot", "mcp-config.json"]],
      [[".config", "kilo"]],
      [[".config", "opencode"]],
      [[".config", "zed"]],
      [[".config", "JetBrains"]],
    ])("marker ~/%s resolves to the low-confidence default", (segs) => {
      forceDir(resolve(home, ...segs));
      const signal = detectPlatform();
      expect(signal.platform).toBe("claude-code");
      expect(signal.confidence).toBe("low");
    });

    it("a removed host's dir never outranks a supported one", () => {
      existsSyncMock.mockImplementation(
        ((p: unknown) =>
          p === resolve(home, ".cursor") || p === resolve(home, ".codex")) as typeof fs.existsSync,
      );
      const signal = detectPlatform();
      expect(signal.platform).toBe("codex");
      expect(signal.confidence).toBe("medium");
    });
  });
});

describe("detectPlatform — env var priority chain", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    for (const v of ALL_PLATFORM_ENV_VARS) delete process.env[v];
    for (const [name] of REMOVED_HOST_ENV) delete process.env[name];
    existsSyncMock.mockReturnValue(false);
  });

  afterEach(() => {
    process.env = savedEnv;
    existsSyncMock.mockReset();
  });

  it("CLAUDE beats CODEX when both envs are set", () => {
    // The registry is ordered, and claude-code is first. This is the whole of
    // what "fork before parent, agent before editor" reduces to at two hosts:
    // one pair, one documented winner.
    process.env.CLAUDE_PROJECT_DIR = "/p";
    process.env.CODEX_THREAD_ID = "t";
    expect(detectPlatform().platform).toBe("claude-code");
  });

  it("each host's own vars resolve to it at high confidence", () => {
    process.env.CODEX_THREAD_ID = "t";
    expect(detectPlatform()).toMatchObject({ platform: "codex", confidence: "high" });
    delete process.env.CODEX_THREAD_ID;
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    expect(detectPlatform()).toMatchObject({ platform: "claude-code", confidence: "high" });
  });

  it.each(REMOVED_HOST_ENV)(
    "%s alone does not produce a high-confidence detection",
    (name, value) => {
      // A shell that ran Cursor or Pi last week still exports these. Before the
      // removal each one named a platform; now none of them may, or a leftover
      // variable would route this session's storage to a host with no adapter.
      process.env[name] = value;
      const signal = detectPlatform();
      expect(signal.confidence).not.toBe("high");
      expect(signal.platform).toBe("claude-code");
    },
  );

  it("a removed host's var does not displace a live one", () => {
    process.env.CURSOR_TRACE_ID = "trace-abc";
    process.env.CODEX_THREAD_ID = "t";
    expect(detectPlatform()).toMatchObject({ platform: "codex", confidence: "high" });
  });

  it("VSCODE_PID no longer competes with Claude Code (issue #539, resolved by removal)", () => {
    // #539: VS Code's bootstrap exports VSCODE_PID into every child, so a
    // Claude Code CLI launched from its integrated terminal was detected as
    // vscode-copilot, and getSettingsPath() wrote .github/hooks/context-mode.json
    // debris into the user's repo. The fix was a disambiguator that read
    // ~/.claude/plugins/installed_plugins.json to break the tie.
    //
    // The tie no longer exists: vscode-copilot is not a platform any more, so
    // the disambiguator was deleted along with tests/adapters/detect-claude-code-in-vscode.test.ts.
    // What must still hold is the outcome that bug was about, and it is
    // asserted here rather than left implied.
    process.env.VSCODE_PID = "99";
    process.env.VSCODE_CWD = "/w";
    expect(detectPlatform().platform).toBe("claude-code");

    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    expect(detectPlatform()).toMatchObject({ platform: "claude-code", confidence: "high" });
  });
});
