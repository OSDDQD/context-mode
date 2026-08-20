/**
 * CLIENT_NAME_TO_PLATFORM — the handshake tier of platform detection.
 *
 * This map answers before any env var is read, so an entry going missing does
 * not fail loudly: the host quietly drops to the env-var or config-dir tier and
 * is identified by a directory instead of by the name it sent. The fifteen-host
 * removal shrank the map from twenty-nine entries to three, and the risk during
 * that edit was exactly this — losing a surviving host's row among the
 * departing ones. Hence the two-sided assertions below: the supported names
 * resolve, and nothing else does.
 */

import { describe, it, expect } from "vitest";
import { CLIENT_NAME_TO_PLATFORM } from "../../src/adapters/client-map.js";

describe("CLIENT_NAME_TO_PLATFORM", () => {
  it("maps claude-code → claude-code", () => {
    expect(CLIENT_NAME_TO_PLATFORM["claude-code"]).toBe("claude-code");
  });

  it("maps a removed host's client names to nothing", () => {
    // Codex announced itself as `Codex` from the CLI and `codex-mcp-client`
    // from the MCP wrapper. Resolving either now would produce a PlatformId
    // with no adapter behind it; falling through to the env tier and the
    // claude-code default is the honest answer.
    expect(CLIENT_NAME_TO_PLATFORM["Codex"]).toBeUndefined();
    expect(CLIENT_NAME_TO_PLATFORM["codex-mcp-client"]).toBeUndefined();
  });

  it("returns undefined for unknown client name", () => {
    expect(CLIENT_NAME_TO_PLATFORM["some-unknown-client"]).toBeUndefined();
  });

  it.each([
    "antigravity-client",
    "antigravity-cli",
    "agy",
    "cursor-vscode",
    "Visual-Studio-Code",
    "copilot-cli",
    "GitHub Copilot CLI",
    "github-copilot-cli",
    "JetBrains Client",
    "IntelliJ IDEA",
    "PyCharm",
    "Kilo Code",
    "Kiro CLI",
    "Pi CLI",
    "Pi Coding Agent",
    "omp-coding-agent",
    "Zed",
    "zed",
    "qwen-code",
    "qwen-cli-mcp-client",
    "kimi-code",
    "kimi",
    "Kimi Code",
    "gemini-cli-mcp-client",
  ])("no longer maps %s (host removed)", (name) => {
    // A removed host still running against this build would announce itself
    // here. Resolving it would name a PlatformId with no adapter behind it, so
    // the correct answer is "unrecognised" and the fall-through to
    // ClaudeCodeAdapter that getAdapter's default gives it.
    expect(CLIENT_NAME_TO_PLATFORM[name]).toBeUndefined();
  });

  it("maps nothing outside the supported platforms", () => {
    // Guards the shape rather than the rows: every value must be a platform
    // that still exists, whatever the keys grow into.
    expect([...new Set(Object.values(CLIENT_NAME_TO_PLATFORM))].sort()).toEqual([
      "claude-code",
    ]);
  });
});
