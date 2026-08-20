/**
 * Issue #545 — server.ts getProjectDir() passes strictPlatform to resolveProjectDir.
 *
 * Without strict mode, a foreign workspace var wins the cascade and the
 * session writes into another host's project. The original report was
 * CLAUDE_PROJECT_DIR leaking into Pi's MCP child; the shape survives the
 * fifteen-host removal because a leaked variable does not need its host to
 * still exist — a shell that ran Cursor last week still exports CURSOR_CWD.
 *
 * This integration test exercises the wiring by importing the real resolver
 * and asserting that each platform's strict-mode call rejects foreign env
 * and accepts its own.
 */

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectDir } from "../../src/util/project-dir.js";
import { workspaceEnvVarsFor } from "../../src/adapters/detect.js";
import { getProjectDir } from "../../src/server.js";
import type { PlatformId } from "../../src/adapters/types.js";

// Build a foreign-leak env: a workspace var set to a leak path. The list is
// deliberately WIDER than the supported platforms — the variables of removed
// hosts are exactly what is still lying around in real shells, and strict mode
// has to ignore them now that no registry row claims them.
function makeForeignLeakEnv(): Record<string, string> {
  return {
    CLAUDE_PROJECT_DIR: "/leak/claude",
    GEMINI_PROJECT_DIR: "/leak/gemini",
    VSCODE_CWD: "/leak/vscode",
    OPENCODE_PROJECT_DIR: "/leak/opencode",
    PI_WORKSPACE_DIR: "/leak/pi-ws",
    PI_PROJECT_DIR: "/leak/pi-project",
    IDEA_INITIAL_DIRECTORY: "/leak/idea",
    CURSOR_CWD: "/leak/cursor",
    QWEN_PROJECT_DIR: "/leak/qwen",
    PI_CODING_AGENT_DIR: "/leak/omp",
  };
}

describe("server getProjectDir wiring — strictPlatform for all adapters (issue #545)", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    while (cleanup.length) {
      const p = cleanup.pop();
      if (p) try { rmSync(p, { recursive: true, force: true }); } catch {}
    }
  });

  // Adapters with at least one workspace var. One left: claude-code.
  const platformsWithOwnVar: ReadonlyArray<PlatformId> = ["claude-code"];

  // Adapters with no workspace var (rely on universal escape hatch / pwd / cwd).
  // Codex was the case that made this branch load-bearing rather than
  // theoretical; "unknown" carries the same empty row and reaches the same
  // code, so the branch keeps its coverage after the removal.
  const platformsNoOwnVar: ReadonlyArray<PlatformId> = ["unknown"];

  for (const platform of platformsWithOwnVar) {
    it(`platform=${platform}: strict mode prefers own workspace var over foreign leaks`, () => {
      const ownVars = workspaceEnvVarsFor(platform);
      expect(ownVars.length).toBeGreaterThan(0);

      // Set foreign leaks AND own var. Strict mode must pick own.
      const leakEnv = makeForeignLeakEnv();
      // Override the FIRST own var with the canonical /own value. (Other
      // adapters' workspace vars are leaks above; this one is correct.)
      const env = { ...leakEnv, [ownVars[0]]: "/Users/x/own-project" };

      const result = resolveProjectDir({
        env,
        cwd: "/some/cwd",
        pwd: undefined,
        strictPlatform: platform,
      });
      expect(result).toBe("/Users/x/own-project");
    });
  }

  for (const platform of platformsNoOwnVar) {
    it(`platform=${platform} (no workspace var): strict mode falls back to CONTEXT_MODE_PROJECT_DIR`, () => {
      // Even with every foreign leak set, the universal escape hatch wins.
      const env = {
        ...makeForeignLeakEnv(),
        CONTEXT_MODE_PROJECT_DIR: "/Users/x/escape",
      };
      const result = resolveProjectDir({
        env,
        cwd: "/some/cwd",
        pwd: undefined,
        strictPlatform: platform,
      });
      expect(result).toBe("/Users/x/escape");
    });
  }

  it("every platform: with no own var set and no escape hatch, falls through to PWD", () => {
    const allPlatforms: ReadonlyArray<PlatformId> = [
      ...platformsWithOwnVar,
      ...platformsNoOwnVar,
    ];
    for (const platform of allPlatforms) {
      const result = resolveProjectDir({
        env: makeForeignLeakEnv(),
        cwd: "/anchor/cwd",
        pwd: "/Users/x/from-shell",
        strictPlatform: platform,
      });
      // No own workspace var matches (we set leaks, not the platform's own
      // value). PWD is the next tier. PI / OMP have own vars set in the
      // leak env to /leak/* values though — those would win for them. So
      // distinguish: if the platform has a workspace var that the leak env
      // also sets, that "leak" value IS this platform's value (test artifact).
      // Use a stricter check: the result must NOT be from a foreign-only var.
      const ownVars = new Set(workspaceEnvVarsFor(platform));
      // Check: for any "/leak/*" the result is, the source var must be in ownVars.
      if (result.startsWith("/leak/")) {
        // Allowed only if this is the platform's own var.
        const matchedKey = Object.keys(makeForeignLeakEnv()).find(
          (k) => makeForeignLeakEnv()[k] === result,
        );
        expect(matchedKey).toBeDefined();
        expect(ownVars.has(matchedKey!)).toBe(true);
      } else {
        expect(result).toBe("/Users/x/from-shell");
      }
    }
  });
});

// Issue #45's other half — a server.ts boot proving the session-log heuristic
// was reachable from the production callsite under Codex detection — left with
// the host. The heuristic itself left with it too (src/util/project-dir.ts):
// the branch existed for the one platform that published no workspace env var,
// and a platform in that position again gets its own branch rather than
// inheriting one written for somebody else.
