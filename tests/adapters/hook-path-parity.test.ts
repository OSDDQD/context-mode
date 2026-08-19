import "../setup-home";
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  HOOK_SCRIPTS as CLAUDE_HOOK_SCRIPTS,
  buildHookCommand as buildClaudeHookCommand,
  type HookType as ClaudeHookType,
} from "../../src/adapters/claude-code/hooks.js";

/**
 * Hook path parity — issue #712.
 *
 * For every adapter whose `buildHookCommand` emits an absolute filesystem
 * path, the emitted command MUST resolve to a script that exists in the
 * published tree under the same relative layout HOOK_MAP in src/cli.ts uses.
 *
 * Since the fifteen-host removal that is claude-code alone: gemini-cli and
 * kiro were the other two path-emitting adapters and left with their hosts,
 * and codex emits a CLI-dispatcher string instead. "Cross-adapter parity" is
 * therefore now a one-row table — but the check it performs is not about
 * comparing adapters to each other, it is about comparing each adapter's emit
 * to the tree, and that keeps working at one row.
 *
 * Why this test exists: issue #712 — gemini-cli's `buildHookCommand`
 * carried claude-code's flat `hooks/<script>` shape across without
 * accounting for the `gemini-cli/` platform subdir. HOOK_MAP knew the
 * correct layout, `setHookPermissions` knew the correct layout, but the
 * command emit didn't — and the gemini-cli doctor's regex round-trip
 * (`getHookScriptPaths` -> parse command -> check existsSync on parsed
 * path) silently failed on every install.
 *
 * This test trips at the emit layer: the script path embedded in the
 * command must existsSync in the actual tree being tested. No regex,
 * no parsing, no fragile string scraping — just "does the file the
 * command points at actually exist?".
 *
 * Adapters NOT covered here (CLI-dispatcher Tier C): codex, which writes
 * `context-mode hook codex <event>` into ~/.codex/hooks.json. The reason that
 * tier exists — an absolute path in a workspace-committed file leaks the
 * author's home directory and breaks on every other machine (PR #620) — is
 * still why it must not be assimilated into this one.
 */

interface AdapterParityCase {
  platform: string;
  scripts: Record<string, string>;
  build: (hookType: string, pluginRoot: string) => string;
  /** Relative path component between `hooks/` and `<scriptName>`. */
  subdir: string;
}

const repoRoot = resolve(__dirname, "..", "..");

const adapters: AdapterParityCase[] = [
  {
    platform: "claude-code",
    scripts: CLAUDE_HOOK_SCRIPTS,
    build: (h, p) => buildClaudeHookCommand(h as ClaudeHookType, p),
    subdir: "",
  },
];

describe("hook path parity across adapters (issue #712)", () => {
  for (const adapter of adapters) {
    describe(`${adapter.platform}`, () => {
      it("every emitted hook command points at an existing script in the tree", () => {
        for (const [hookType, scriptName] of Object.entries(adapter.scripts)) {
          const cmd = adapter.build(hookType, repoRoot);
          const expectedRel = adapter.subdir
            ? `hooks/${adapter.subdir}/${scriptName}`
            : `hooks/${scriptName}`;
          const expectedAbs = resolve(repoRoot, expectedRel);
          // buildHookRuntimeCommand emits forward-slash paths on every OS
          // (MSYS / Git Bash on Windows uses forward slashes; node accepts
          // both). path.resolve on Windows returns backslashes, so we
          // normalize before substring-matching the emitted command.
          const expectedAbsForwardSlash = expectedAbs.replace(/\\/g, "/");
          // The command must literally contain the absolute path the
          // doctor will probe; existsSync must succeed against that path.
          expect(
            cmd,
            `${adapter.platform}/${hookType}: command does not embed ${expectedAbsForwardSlash}`,
          ).toContain(expectedAbsForwardSlash);
          expect(
            existsSync(expectedAbs),
            `${adapter.platform}/${hookType}: ${expectedAbs} missing on disk`,
          ).toBe(true);
        }
      });

      it("never emits the wrong subdir (regression guard for issue #712)", () => {
        // `hooks/codex/` is the only platform subdir that still exists, which
        // makes emitting into it the only way this leak can happen now.
        //
        // The list used to carry gemini-cli, kiro, vscode-copilot, cursor and
        // jetbrains-copilot as well, on the argument that a returning
        // directory should trip here rather than ship. That argument does not
        // survive contact with the code: no emit path can produce those names
        // any more, so those five assertions could never fail — and a check
        // that cannot fail is not a guard, it is a list that makes the test
        // look wider than it is. If a host comes back it brings its own
        // adapter, and the adapter belongs in `adapters` above, which is what
        // actually extends this test.
        const otherSubdirs = ["codex"].filter((s) => s !== adapter.subdir);
        for (const [hookType, scriptName] of Object.entries(adapter.scripts)) {
          const cmd = adapter.build(hookType, "/fixed/plugin/root");
          for (const wrong of otherSubdirs) {
            expect(
              cmd,
              `${adapter.platform}/${hookType} leaked into /hooks/${wrong}/${scriptName}`,
            ).not.toContain(`/hooks/${wrong}/${scriptName}`);
          }
        }
      });
    });
  }
});
