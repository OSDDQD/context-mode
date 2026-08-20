/**
 * normalize-hooks — source-checkout refusal
 *
 * `bun start.mjs` from a clone used to rewrite TWO TRACKED FILES in the working
 * tree: `.claude-plugin/plugin.json` (`"command": "node"` → the contributor's
 * `~/.bun/bin/bun`, args[0] → their absolute checkout path) and all 14 commands
 * in `hooks/hooks.json`. Committing that ships a plugin pointing at a stranger's
 * home directory — the #523 / #711 failure class aimed at the REPOSITORY rather
 * than the plugin cache.
 *
 * The rewrite is correct for an installed copy and always wrong for a checkout.
 * The signal separating them is `.git`. These tests pin both directions: a root
 * WITH `.git` is never written to, a root WITHOUT one is normalized exactly as
 * before (that second half is the regression that matters — the real heal must
 * keep working).
 */

import { describe, test, expect, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isSourceCheckout,
  normalizeHooksJson,
  normalizeHooksJsonOnly,
  normalizeHooksOnStartup,
  normalizePluginJson,
} from "../../hooks/normalize-hooks.mjs";

const NODE = "/home/someone/.bun/bin/bun";

const cleanups: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (cleanups.length) {
    const dir = cleanups.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
});

const HOOKS_JSON = JSON.stringify(
  {
    hooks: {
      SessionStart: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/sessionstart.mjs"',
            },
          ],
        },
      ],
    },
  },
  null,
  2,
);

const PLUGIN_JSON = JSON.stringify(
  {
    name: "context-mode",
    mcpServers: {
      "context-mode": {
        command: "node",
        args: ["${CLAUDE_PLUGIN_ROOT}/start.mjs"],
      },
    },
  },
  null,
  2,
);

/**
 * Build a plugin root holding both manifests. `git` picks what stands in for a
 * working tree: a `.git` DIRECTORY (plain clone), a `.git` FILE (worktree or
 * submodule — the gitdir pointer form), or nothing (an installed copy).
 */
function makeRoot(git: "dir" | "file" | "none", trailingNewline = false): {
  root: string;
  hooksPath: string;
  pluginPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "ctx-checkout-guard-"));
  cleanups.push(root);
  mkdirSync(join(root, "hooks"), { recursive: true });
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  const suffix = trailingNewline ? "\n" : "";
  const hooksPath = join(root, "hooks", "hooks.json");
  const pluginPath = join(root, ".claude-plugin", "plugin.json");
  writeFileSync(hooksPath, HOOKS_JSON + suffix, "utf-8");
  writeFileSync(pluginPath, PLUGIN_JSON + suffix, "utf-8");
  if (git === "dir") mkdirSync(join(root, ".git"));
  if (git === "file")
    writeFileSync(join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
  return { root, hooksPath, pluginPath };
}

describe("isSourceCheckout", () => {
  test("true for a plain clone (.git directory)", () => {
    expect(isSourceCheckout(makeRoot("dir").root)).toBe(true);
  });

  test("true for a worktree / submodule (.git file holding a gitdir pointer)", () => {
    expect(isSourceCheckout(makeRoot("file").root)).toBe(true);
  });

  test("false for an installed copy (no .git)", () => {
    expect(isSourceCheckout(makeRoot("none").root)).toBe(false);
  });

  test("false for a missing / empty root rather than throwing", () => {
    expect(isSourceCheckout("")).toBe(false);
    expect(isSourceCheckout(undefined)).toBe(false);
    expect(isSourceCheckout(join(tmpdir(), "ctx-does-not-exist-xyz"))).toBe(
      false,
    );
  });
});

describe("normalizeHooksOnStartup — refuses to write a source checkout", () => {
  test("leaves both tracked manifests byte-identical in a clone", () => {
    const { root, hooksPath, pluginPath } = makeRoot("dir");

    normalizeHooksOnStartup({
      pluginRoot: root,
      nodePath: NODE,
      platform: "linux",
    });

    expect(readFileSync(hooksPath, "utf-8")).toBe(HOOKS_JSON);
    expect(readFileSync(pluginPath, "utf-8")).toBe(PLUGIN_JSON);
    // The placeholder is the whole point: it must survive so the committed
    // manifest keeps working on every other machine.
    expect(readFileSync(hooksPath, "utf-8")).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(readFileSync(pluginPath, "utf-8")).toContain('"command": "node"');
  });

  test("leaves them alone in a worktree checkout too (.git as a file)", () => {
    const { root, hooksPath, pluginPath } = makeRoot("file");

    normalizeHooksOnStartup({
      pluginRoot: root,
      nodePath: NODE,
      platform: "linux",
    });

    expect(readFileSync(hooksPath, "utf-8")).toBe(HOOKS_JSON);
    expect(readFileSync(pluginPath, "utf-8")).toBe(PLUGIN_JSON);
  });

  test("does not crash — the server still boots from a checkout", () => {
    const { root } = makeRoot("dir");
    expect(() =>
      normalizeHooksOnStartup({
        pluginRoot: root,
        nodePath: NODE,
        jsRuntimePath: NODE,
        platform: "linux",
      }),
    ).not.toThrow();
  });

  test("the refusal is logged — one line, stderr only, never stdout", () => {
    const { root } = makeRoot("dir");
    const err = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    normalizeHooksOnStartup({
      pluginRoot: root,
      nodePath: NODE,
      platform: "linux",
    });

    const lines = err.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(root);
    expect(lines[0]).toContain("git checkout");
    expect(lines[0].endsWith("\n")).toBe(true);
    // A stray stdout write here would corrupt the MCP JSON-RPC stream.
    expect(out).not.toHaveBeenCalled();
  });

  test("stays quiet on a second boot from the same root", () => {
    const { root } = makeRoot("dir");
    const err = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    normalizeHooksOnStartup({ pluginRoot: root, nodePath: NODE, platform: "linux" });
    normalizeHooksOnStartup({ pluginRoot: root, nodePath: NODE, platform: "linux" });

    expect(err.mock.calls).toHaveLength(1);
  });
});

describe("normalizeHooksJsonOnly — same refusal on the narrow /ctx-upgrade path", () => {
  test("does not touch hooks.json in a checkout", () => {
    const { root, hooksPath } = makeRoot("dir");

    normalizeHooksJsonOnly({
      pluginRoot: root,
      nodePath: NODE,
      platform: "linux",
    });

    expect(readFileSync(hooksPath, "utf-8")).toBe(HOOKS_JSON);
  });
});

describe("the real heal is untouched — installed copy (no .git)", () => {
  test("normalizes hooks.json exactly as before", () => {
    const { root, hooksPath } = makeRoot("none");

    normalizeHooksOnStartup({
      pluginRoot: root,
      nodePath: NODE,
      platform: "linux",
    });

    const after = readFileSync(hooksPath, "utf-8");
    expect(after).not.toContain("${CLAUDE_PLUGIN_ROOT}");
    const command =
      JSON.parse(after).hooks.SessionStart[0].hooks[0].command as string;
    expect(command).toBe(`"${NODE}" "${root}/hooks/sessionstart.mjs"`);
  });

  test("normalizes plugin.json exactly as before", () => {
    const { root, pluginPath } = makeRoot("none");

    normalizeHooksOnStartup({
      pluginRoot: root,
      nodePath: NODE,
      platform: "linux",
    });

    const parsed = JSON.parse(readFileSync(pluginPath, "utf-8"));
    expect(parsed.mcpServers["context-mode"].command).toBe(NODE);
    expect(parsed.mcpServers["context-mode"].args[0]).toBe(`${root}/start.mjs`);
  });

  test("writes without logging a refusal", () => {
    const { root } = makeRoot("none");
    const err = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    normalizeHooksOnStartup({
      pluginRoot: root,
      nodePath: NODE,
      platform: "linux",
    });

    expect(err).not.toHaveBeenCalled();
  });

  test("preserves the trailing newline the committed manifests carry", () => {
    const { root, hooksPath, pluginPath } = makeRoot("none", true);

    normalizeHooksOnStartup({
      pluginRoot: root,
      nodePath: NODE,
      platform: "linux",
    });

    const hooksAfter = readFileSync(hooksPath, "utf-8");
    const pluginAfter = readFileSync(pluginPath, "utf-8");
    expect(hooksAfter).not.toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(hooksAfter.endsWith("\n")).toBe(true);
    expect(hooksAfter.endsWith("\n\n")).toBe(false);
    expect(pluginAfter.endsWith("\n")).toBe(true);
    expect(pluginAfter.endsWith("\n\n")).toBe(false);
  });

  test("adds no newline when the original had none", () => {
    const { root, hooksPath } = makeRoot("none", false);

    normalizeHooksOnStartup({
      pluginRoot: root,
      nodePath: NODE,
      platform: "linux",
    });

    expect(readFileSync(hooksPath, "utf-8").endsWith("\n")).toBe(false);
  });
});

describe("in-memory resolution still works in a checkout", () => {
  test("the pure rewrites still return absolute paths while the files stay clean", () => {
    const { root, hooksPath, pluginPath } = makeRoot("dir");

    // The refusal is about PERSISTING. A caller that needs the resolved
    // command/args for the current process still gets them.
    const hooks = normalizeHooksJson(HOOKS_JSON, NODE, root);
    const plugin = normalizePluginJson(PLUGIN_JSON, NODE, root);

    expect(hooks).toContain(`${root}/hooks/sessionstart.mjs`);
    expect(hooks).not.toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(JSON.parse(plugin).mcpServers["context-mode"].args[0]).toBe(
      `${root}/start.mjs`,
    );

    // …and nothing landed on disk.
    expect(readFileSync(hooksPath, "utf-8")).toBe(HOOKS_JSON);
    expect(readFileSync(pluginPath, "utf-8")).toBe(PLUGIN_JSON);
  });
});
