/**
 * Issue #542 — config-dir ambiguity matrix.
 *
 * The question this file has always asked: when more than one host has left a
 * config directory in $HOME, which one does the medium-confidence tier pick,
 * and is that answer stable? It used to take seventeen hosts and an ordering
 * rule three paragraphs long (agents before editors, forks before parents).
 * With two hosts the question does not go away — it gets a short answer, and
 * the answer is still worth pinning, because "which directory wins" is exactly
 * the decision that silently routes a session's storage to the wrong root.
 *
 * The fifteen-host removal also created a second question this file is now the
 * right place for: a user who ran Cursor or Pi last month still has ~/.cursor
 * and ~/.pi on disk. Those directories must be INERT — detected as nothing,
 * falling through to the low-confidence default — rather than resolving to a
 * platform id that no longer has an adapter. A leftover directory that still
 * won would point storage at a host we cannot serve.
 *
 * Each case mocks node:fs.existsSync to return true ONLY for the listed dirs,
 * then asserts the resulting platform AND confidence. The env-var and
 * clientInfo tiers are exercised in detect.test.ts and detect-config-dir.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolve } from "node:path";
import { homedir } from "node:os";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: vi.fn() };
});

import * as fs from "node:fs";
import { detectPlatform, PLATFORM_ENV_VARS } from "../../src/adapters/detect.js";

const existsSyncMock = vi.mocked(fs.existsSync);

const ALL_PLATFORM_ENV_VARS = [
  ...[...PLATFORM_ENV_VARS.values()].flatMap((vars) => vars.map((v) => v.name)),
  "CONTEXT_MODE_PLATFORM",
];

/** Config dirs of hosts removed in the fifteen-host cut, as users still have them. */
const REMOVED_HOST_DIRS: Array<[string, string[]]> = [
  ["cursor", [".cursor"]],
  ["pi", [".pi"]],
  ["omp", [".omp"]],
  ["kiro", [".kiro"]],
  ["qwen-code", [".qwen"]],
  ["gemini-cli", [".gemini"]],
  ["openclaw", [".openclaw"]],
  ["vscode-copilot", [".vscode"]],
  ["kimi", [".kimi-code"]],
  ["opencode", [".config", "opencode"]],
  ["kilo", [".config", "kilo"]],
  ["zed", [".config", "zed"]],
  ["jetbrains-copilot", [".config", "JetBrains"]],
];

describe("detectPlatform — config-dir ambiguity matrix (issue #542)", () => {
  const home = homedir();
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    for (const v of ALL_PLATFORM_ENV_VARS) delete process.env[v];
    existsSyncMock.mockReset();
  });

  afterEach(() => {
    process.env = savedEnv;
    existsSyncMock.mockReset();
  });

  const presentDirs = (...segs: string[][]) => {
    const targets = new Set(segs.map((s) => resolve(home, ...s)));
    existsSyncMock.mockImplementation(((p: unknown) =>
      typeof p === "string" && targets.has(p)) as typeof fs.existsSync);
  };

  // [scenario, dirs present, expected platform, expected confidence]
  const cases: Array<[string, string[][], string, string]> = [
    // ── The one live row ──
    ["claude only    → claude-code", [[".claude"]], "claude-code", "medium"],
    // ── A removed host's root does not resolve to it ──
    ["codex only     → claude-code (low)", [[".codex"]], "claude-code", "low"],
    ["claude + codex → claude-code", [[".claude"], [".codex"]], "claude-code", "medium"],
    // ── Neither: the low-confidence default, not a guess ──
    ["neither        → claude-code (low)", [], "claude-code", "low"],
  ];

  it.each(cases)("%s", (_name, dirs, expectedPlatform, expectedConfidence) => {
    presentDirs(...dirs);
    const signal = detectPlatform();
    expect(signal.platform).toBe(expectedPlatform);
    expect(signal.confidence).toBe(expectedConfidence);
  });

  it("resolves the same way regardless of probe order", () => {
    // The old matrix's whole point was that the winner is a property of the
    // documented order, not of which existsSync call happened to run first.
    // With one live row that is cheap to state directly: a leftover root from
    // a removed host cannot change the answer by being probed first.
    presentDirs([".codex"], [".claude"]);
    expect(detectPlatform().platform).toBe("claude-code");
    presentDirs([".claude"], [".codex"]);
    expect(detectPlatform().platform).toBe("claude-code");
  });

  describe("directories left behind by removed hosts are inert", () => {
    it.each(REMOVED_HOST_DIRS)("%s's dir alone detects nothing", (_name, segs) => {
      presentDirs(segs);
      const signal = detectPlatform();
      // Falls through to the low-confidence default. The failure this guards
      // against is a leftover directory resolving to a platform id with no
      // adapter behind it, which would point storage at a host we cannot serve.
      expect(signal.platform).toBe("claude-code");
      expect(signal.confidence).toBe("low");
    });

    it("does not let a removed host's dir outrank a supported one", () => {
      presentDirs([".cursor"], [".claude"]);
      const signal = detectPlatform();
      expect(signal.platform).toBe("claude-code");
      expect(signal.confidence).toBe("medium");
    });
  });
});
