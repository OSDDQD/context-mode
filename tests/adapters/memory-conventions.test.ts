import "../setup-home";
import { fakeHome } from "../setup-home.js";
import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// Neither remaining adapter reads XDG_CONFIG_HOME or APPDATA — the ones that
// did (opencode, kilo) are gone. The anchoring stays because it costs nothing
// and keeps the suite sandboxed if an adapter starts honoring them again;
// GitHub Actions Ubuntu sets these to the runner's real home, which would
// bypass the homedir mock.
process.env.XDG_CONFIG_HOME = join(fakeHome, ".config");
process.env.XDG_DATA_HOME = join(fakeHome, ".local", "share");
process.env.APPDATA = join(fakeHome, "AppData", "Roaming");
process.env.LOCALAPPDATA = join(fakeHome, "AppData", "Local");

import { ClaudeCodeAdapter } from "../../src/adapters/claude-code/index.js";
import { CodexAdapter } from "../../src/adapters/codex/index.js";

/**
 * Slice 3 — per-adapter memory/config conventions.
 *
 * Each adapter declares its own configDir, instructionFiles, memoryDir. Two
 * adapters remain, and the pair is still worth pinning: they disagree on all
 * three (`.claude` vs `.codex`, CLAUDE.md vs AGENTS.md, `memory` vs
 * `memories`), and every one of those disagreements is a path some consumer
 * builds by hand.
 *
 * These are consumed by:
 *   - searchAutoMemory()  (auto-memory file scan)
 *   - ctx_search timeline (configDir for prior session lookup)
 *   - extract.ts isRule  (instruction file detection)
 */

describe("Adapter memory conventions", () => {


  // ClaudeCodeAdapter had no block of its own before the fifteen-host
  // removal — it was implicit in every other adapter's "differs from Claude
  // Code" assertion, and those are gone. Written out here so the surviving
  // default is pinned rather than inferred.
  describe("ClaudeCodeAdapter", () => {
    const a = new ClaudeCodeAdapter();
    it("getConfigDir is ~/.claude", () => {
      expect(a.getConfigDir()).toBe(join(homedir(), ".claude"));
    });
    it("getInstructionFiles is ['CLAUDE.md']", () => {
      expect(a.getInstructionFiles()).toEqual(["CLAUDE.md"]);
    });
    it("getMemoryDir is ~/.claude/memory", () => {
      expect(a.getMemoryDir()).toBe(join(homedir(), ".claude", "memory"));
    });
  });

  describe("CodexAdapter", () => {
    const a = new CodexAdapter();
    it("getConfigDir is ~/.codex", () => {
      expect(a.getConfigDir()).toBe(join(homedir(), ".codex"));
    });
    it("getInstructionFiles is ['AGENTS.md', 'AGENTS.override.md']", () => {
      expect(a.getInstructionFiles()).toEqual(["AGENTS.md", "AGENTS.override.md"]);
    });
    it("getMemoryDir is ~/.codex/memories (plural)", () => {
      expect(a.getMemoryDir()).toBe(join(homedir(), ".codex", "memories"));
    });
  });



  // Project-scoped adapters resolve their convention dir against an
  // explicit projectDir per the always-absolute getConfigDir contract.
  const projectDir = join(fakeHome, "fixture-project");








  // ──────────────────────────────────────────────────────────────────
  // Cross-adapter contract — getConfigDir() ALWAYS returns absolute
  //
  // Catches the leaky-seam bug where some adapters returned project-
  // relative segments ("", ".cursor", ".github", ".kiro") and others
  // returned absolute paths. Every consumer (server.ts, auto-memory.ts)
  // can now treat the return uniformly without isAbsolute() guards.
  // ──────────────────────────────────────────────────────────────────
  describe("HookAdapter.getConfigDir contract", () => {
    const projectDirForContract = join(fakeHome, "fixture-project");

    const allAdapters: Array<{ name: string; instance: { getConfigDir: (p?: string) => string } }> = [
      { name: "ClaudeCodeAdapter", instance: new ClaudeCodeAdapter() },
      { name: "CodexAdapter", instance: new CodexAdapter() },
    ];

    it.each(allAdapters)(
      "$name.getConfigDir(projectDir) returns an absolute path",
      ({ instance }) => {
        const dir = instance.getConfigDir(projectDirForContract);
        expect(typeof dir).toBe("string");
        expect(dir.length).toBeGreaterThan(0);
        expect(isAbsolute(dir)).toBe(true);
      },
    );

    it.each(allAdapters)(
      "$name.getConfigDir() (no args) still returns an absolute path",
      ({ instance }) => {
        const dir = instance.getConfigDir();
        expect(typeof dir).toBe("string");
        expect(dir.length).toBeGreaterThan(0);
        expect(isAbsolute(dir)).toBe(true);
      },
    );
  });
});
