/**
 * Plugin structure contract — what the HOST sees.
 *
 * Claude Code does not read this repository. It reads a manifest, a hook
 * registration file, a set of skill descriptions and the tool list attached to
 * an agent. Every rule pinned here has the same failure signature: nothing
 * throws, no suite goes red, the host simply stops seeing something. A tool that
 * exists and is tested but is absent from the agent's `tools:` allowlist is not
 * a broken tool — it is an invisible one, and only a test that reads the plugin
 * from outside can tell the difference.
 *
 * The six rules, and the finding each one closes:
 *
 *   1. Canonical layout                      — components at the root, manifest in .claude-plugin/
 *   2. Every skill directory has a SKILL.md  — a directory without one is skipped in silence
 *   3. Command ↔ platform-skill parity       — F3: /ctx-find and /ctx-graph existed on neither side
 *   4. No absolute paths                     — correct on exactly one machine otherwise
 *   5. PreToolUse matchers do not overlap    — F4: three entries were subsumed by `mcp__`, so
 *                                              every ctx_execute paid for two hook processes
 *   6. Every hook entry has a timeout        — F5: the 60s host default in front of every Bash
 *
 * Plus the surface checks for F1/F2: the tools the server registers must be the
 * tools the agent is allowed to call and the tools the plugin's own prose
 * describes — and, since the host loads the committed server.bundle.mjs rather
 * than src/, the tools that bundle actually contains.
 */

import "../setup-home";
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  PRE_TOOL_USE_MATCHERS,
  HOOK_TIMEOUTS,
  HOOK_TYPES,
} from "../../src/adapters/claude-code/hooks.js";
import { ROUTING_BLOCK } from "../../hooks/routing-block.mjs";

const repoRoot = resolve(__dirname, "..", "..");

interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
}
interface HookGroup {
  matcher: string;
  hooks: HookCommand[];
}
interface HooksFile {
  hooks: Record<string, HookGroup[]>;
}

function readJson<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(join(repoRoot, ...segments), "utf-8")) as T;
}

function dirsIn(relative: string): string[] {
  const abs = join(repoRoot, relative);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).filter((name) => statSync(join(abs, name)).isDirectory());
}

// ─────────────────────────────────────────────────────────
// 1. Canonical layout
// ─────────────────────────────────────────────────────────

describe("plugin layout", () => {
  it("keeps the manifest in .claude-plugin/ and every component at the repo root", () => {
    expect(existsSync(join(repoRoot, ".claude-plugin", "plugin.json"))).toBe(true);

    for (const component of ["commands", "agents", "skills", "hooks"]) {
      expect(
        existsSync(join(repoRoot, component)),
        `${component}/ must live at the repo root`,
      ).toBe(true);
      // Nesting a component inside .claude-plugin/ is the classic way to make it
      // invisible: the manifest is found, the component is not.
      expect(
        existsSync(join(repoRoot, ".claude-plugin", component)),
        `${component}/ must NOT be nested inside .claude-plugin/`,
      ).toBe(false);
    }
  });

  it("gives every skill directory a SKILL.md", () => {
    for (const name of dirsIn("skills")) {
      expect(
        existsSync(join(repoRoot, "skills", name, "SKILL.md")),
        `skills/${name}/ has no SKILL.md — the host will skip it silently`,
      ).toBe(true);
    }
  });

  it("tolerates the documented non-skill entries in skills/ (Pi's .ignore list)", () => {
    // `skills/.ignore` is a file, not a skill directory. Pi's skill loader scans
    // with includeRootFiles=true and reads it to decide what to skip (#496), and
    // it only consults the directory it scans — so it cannot be moved out. Any
    // walk over skills/ must expect a file here. See CONTRIBUTING.md → Plugin
    // layout contract.
    const ignorePath = join(repoRoot, "skills", ".ignore");
    expect(existsSync(ignorePath), "skills/.ignore went missing — Pi will parse non-skills as skills").toBe(true);

    const listed = readFileSync(ignorePath, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    const allowed = new Set([".ignore", ...listed]);
    const strays = readdirSync(join(repoRoot, "skills")).filter(
      (name) => !statSync(join(repoRoot, "skills", name)).isDirectory() && !allowed.has(name),
    );
    expect(
      strays,
      `undocumented non-skill file(s) in skills/: ${strays.join(", ")} — add them to skills/.ignore`,
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────
// 2. Command ↔ second-surface parity
// ─────────────────────────────────────────────────────────
//
// What this rule used to be, and why it changed: every `commands/ctx-*.md`
// had to have a `platform-skills/ctx-*/SKILL.md` twin, so hosts without slash
// commands still learned the utility existed. That directory had no consumer
// left — it was read through `package.json` → `pi.skills`, which went with
// Pi, and neither manifest ever pointed at it. It was deleted rather than
// wired into a manifest: doing that would put nine skill descriptions back
// into the standing prompt of every session, which is the cost the move out
// of `skills/` existed to remove.
//
// The second surface is now the injected routing block: it is host-neutral,
// spells each tool with the calling host's own naming, and reaches Codex —
// which has no slash commands — on every SessionStart. So the parity rule
// stands, pointed at the surface that is actually delivered.

describe("command parity", () => {
  it("names every commands/ctx-*.md in the injected routing block", () => {
    const commands = readdirSync(join(repoRoot, "commands"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.replace(/\.md$/, ""))
      .sort();

    expect(commands.length).toBeGreaterThanOrEqual(9);
    for (const command of commands) {
      // /context-mode:ctx-find ↔ the ctx_find the block names.
      const tool = command.replace(/-/g, "_");
      expect(
        ROUTING_BLOCK.includes(tool),
        `${command}: reachable as a slash command on Claude Code and nowhere on a host without them — ` +
          `the routing block never mentions ${tool}`,
      ).toBe(true);
    }
  });

  it("gives every command the frontmatter that keeps it out of the standing prompt", () => {
    for (const name of readdirSync(join(repoRoot, "commands")).filter((n) => n.endsWith(".md"))) {
      const src = readFileSync(join(repoRoot, "commands", name), "utf-8");
      expect(src.startsWith("---\n"), `${name}: no frontmatter block`).toBe(true);
      const frontmatter = src.slice(4, src.indexOf("\n---", 4));
      expect(frontmatter, `${name}: missing description`).toMatch(/^description:/m);
      // These are user-invoked utilities. Without this, seven command
      // descriptions ride in the system prompt of every session.
      expect(frontmatter, `${name}: missing disable-model-invocation`).toMatch(
        /^disable-model-invocation:\s*true$/m,
      );
    }
  });

  it("ships a command and a routing-block mention for every user-facing ctx tool", () => {
    // F3: /ctx-find and /ctx-graph existed on neither surface.
    for (const tool of ["ctx-find", "ctx-graph"]) {
      expect(existsSync(join(repoRoot, "commands", `${tool}.md`)), `commands/${tool}.md missing`).toBe(true);
      expect(
        ROUTING_BLOCK.includes(tool.replace(/-/g, "_")),
        `${tool} is missing from the routing block`,
      ).toBe(true);
    }
  });

  it("has no platform-skills/ directory left to drift", () => {
    // Deleted with its consumer. The check stays for one reason: the twin
    // rule above was satisfied by a directory nothing shipped, and a
    // half-restored copy would satisfy a reader's memory of it just as well.
    expect(existsSync(join(repoRoot, "platform-skills"))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────
// 3. Paths
// ─────────────────────────────────────────────────────────

describe("plugin paths", () => {
  it("never bakes an absolute path into a committed manifest or hook registration", () => {
    const files = [
      [".claude-plugin", "plugin.json"],
      [".claude-plugin", "marketplace.json"],
      ["hooks", "hooks.json"],
    ];
    // An absolute path is correct on exactly one machine. `${CLAUDE_PLUGIN_ROOT}`
    // is the only portable way to name the install dir.
    const absolute = /(?:"|\s)(?:\/(?:home|Users|opt|usr)\/|[A-Za-z]:[\\/])/;
    for (const segments of files) {
      const raw = readFileSync(join(repoRoot, ...segments), "utf-8");
      expect(absolute.test(raw), `${segments.join("/")} contains an absolute path`).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────
// 4. Hook registration
// ─────────────────────────────────────────────────────────

describe("hook registration", () => {
  const hooksJson = () => readJson<HooksFile>("hooks", "hooks.json");

  it("has no PreToolUse matcher that another matcher already covers", () => {
    const matchers = hooksJson().hooks.PreToolUse.map((group) => group.matcher);

    // Claude Code matches a matcher as substring-or-regex and fires one process
    // per matching ENTRY. So `mcp__plugin_context-mode_context-mode__ctx_execute`
    // sitting alongside `mcp__` is not redundancy — it is a second `node` process
    // and a second pass of the delay / redirect / rejected-approach markers
    // before every affected tool call.
    const overlaps: string[] = [];
    for (const a of matchers) {
      for (const b of matchers) {
        if (a === b) continue;
        if (a.includes(b)) overlaps.push(`"${a}" is already covered by "${b}"`);
      }
    }
    expect(overlaps, `overlapping PreToolUse matchers:\n${overlaps.join("\n")}`).toEqual([]);
  });

  it("keeps the same non-overlap invariant in the adapter's matcher list", () => {
    // generateHookConfig emits one settings.json entry per element, so the list
    // has to obey the same rule as hooks.json.
    const overlaps: string[] = [];
    for (const a of PRE_TOOL_USE_MATCHERS) {
      for (const b of PRE_TOOL_USE_MATCHERS) {
        if (a === b) continue;
        if (a.includes(b)) overlaps.push(`"${a}" is already covered by "${b}"`);
      }
    }
    expect(overlaps, `overlapping PRE_TOOL_USE_MATCHERS:\n${overlaps.join("\n")}`).toEqual([]);
  });

  it("gives every hook an explicit timeout", () => {
    const missing: string[] = [];
    for (const [event, groups] of Object.entries(hooksJson().hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          // Omitting it is not neutral: the host waits 60s, and a minute of
          // silence in front of a tool call reads as a hung terminal.
          if (typeof hook.timeout !== "number") {
            missing.push(`${event} [${group.matcher || "*"}]`);
          }
        }
      }
    }
    expect(missing, `hooks with no timeout:\n${missing.join("\n")}`).toEqual([]);
  });

  it("keeps hooks.json timeouts in lockstep with HOOK_TIMEOUTS", () => {
    for (const [event, groups] of Object.entries(hooksJson().hooks)) {
      const expected = HOOK_TIMEOUTS[event as keyof typeof HOOK_TIMEOUTS];
      if (expected === undefined) continue;
      for (const group of groups) {
        for (const hook of group.hooks) {
          expect(hook.timeout, `${event} timeout drifted from HOOK_TIMEOUTS`).toBe(expected);
        }
      }
    }
  });

  it("budgets the pre-tool path more tightly than the heavy lifecycle events", () => {
    // The grading is the point, not the exact seconds: whatever sits in front of
    // a tool call must not be allowed to stall longer than the work that only
    // runs once per session.
    expect(HOOK_TIMEOUTS[HOOK_TYPES.PRE_TOOL_USE]).toBeLessThanOrEqual(15);
    expect(HOOK_TIMEOUTS[HOOK_TYPES.USER_PROMPT_SUBMIT]).toBeLessThanOrEqual(15);
    expect(HOOK_TIMEOUTS[HOOK_TYPES.PRE_COMPACT]).toBeGreaterThan(
      HOOK_TIMEOUTS[HOOK_TYPES.PRE_TOOL_USE],
    );
    expect(HOOK_TIMEOUTS[HOOK_TYPES.SESSION_START]).toBeGreaterThan(
      HOOK_TIMEOUTS[HOOK_TYPES.PRE_TOOL_USE],
    );
  });
});

// ─────────────────────────────────────────────────────────
// 5. Tool surface — what the host is told the plugin can do
// ─────────────────────────────────────────────────────────

describe("tool surface", () => {
  const TOOL_REGISTRATION = /registerTool\(\s*"(ctx_[a-z_]+)"/g;

  const toolNamesIn = (body: string): string[] =>
    [...body.matchAll(TOOL_REGISTRATION)].map((m) => m[1]).sort();

  /**
   * Tools the sources register. src/server.ts holds only a part of them — the
   * retrieval surface (ctx_find, ctx_graph, ctx_search, …) registers from
   * src/tools/*.ts, so scanning the entry point alone would miss exactly the
   * tools that went missing in the field.
   */
  const registeredTools = (): string[] => {
    const files = [
      join(repoRoot, "src", "server.ts"),
      ...readdirSync(join(repoRoot, "src", "tools"))
        .filter((f) => f.endsWith(".ts"))
        .map((f) => join(repoRoot, "src", "tools", f)),
    ];
    const names = new Set(files.flatMap((f) => toolNamesIn(readFileSync(f, "utf-8"))));
    return [...names].sort();
  };

  /** Tools the committed bundle registers — what the host actually loads. */
  const bundledTools = (): string[] => {
    const bundle = join(repoRoot, "server.bundle.mjs");
    expect(existsSync(bundle), "server.bundle.mjs is missing — the plugin ships nothing").toBe(true);
    return toolNamesIn(readFileSync(bundle, "utf-8"));
  };

  it("lets the gather subagent call every retrieval tool it is meant to use", () => {
    const agent = readFileSync(join(repoRoot, "agents", "context-gather.md"), "utf-8");
    // A `tools:` list is an allowlist. An omission here is not a missing
    // mention — it is a tool the subagent cannot call at all, which is exactly
    // how ctx_find and ctx_graph were unreachable from the one agent written to
    // survey a tree without reading it.
    for (const tool of [
      "ctx_batch_execute",
      "ctx_gather",
      "ctx_execute",
      "ctx_execute_file",
      "ctx_search",
      "ctx_find",
      "ctx_graph",
      "ctx_fetch_and_index",
    ]) {
      expect(
        agent.includes(`mcp__plugin_context-mode_context-mode__${tool}`),
        `context-gather cannot call ${tool} — add it to the tools allowlist`,
      ).toBe(true);
    }
  });

  it("describes the retrieval tools on the surfaces a host actually reads", () => {
    const surfaces: Array<[string, string]> = [
      ["skills/context-mode/SKILL.md", readFileSync(join(repoRoot, "skills", "context-mode", "SKILL.md"), "utf-8")],
      ["README.md", readFileSync(join(repoRoot, "README.md"), "utf-8")],
      ["CLAUDE.md", readFileSync(join(repoRoot, "CLAUDE.md"), "utf-8")],
    ];
    for (const [name, body] of surfaces) {
      for (const tool of ["ctx_find", "ctx_graph"]) {
        expect(body.includes(tool), `${name} never mentions ${tool}`).toBe(true);
      }
    }
  });

  it("mentions every registered ctx tool somewhere in the README tool table", () => {
    const readme = readFileSync(join(repoRoot, "README.md"), "utf-8");
    const undocumented = registeredTools().filter((tool) => !readme.includes(`\`${tool}\``));
    expect(undocumented, `registered but undocumented: ${undocumented.join(", ")}`).toEqual([]);
  });

  it("ships every registered tool inside the committed bundle", () => {
    // The host never loads src/. It loads server.bundle.mjs, which is committed
    // to this repository and therefore checkable as a source file. This is the
    // shape of the ctx_find/ctx_graph incident: both tools existed in src/, were
    // exercised by tests, were listed in every manifest — and were simply absent
    // from the bundle the host had, so the session saw twelve tools instead of
    // fourteen while nothing anywhere went red.
    const bundled = new Set(bundledTools());
    const missing = registeredTools().filter((tool) => !bundled.has(tool));
    expect(
      missing,
      `missing from server.bundle.mjs: ${missing.join(", ")} — the bundle was built ` +
        `without these tools, so the host will not see them no matter how many ` +
        `edits land in src/. Rebuild the bundle and commit it.`,
    ).toEqual([]);
  });

  it("keeps the bundle's tool list identical to the sources'", () => {
    // The reverse direction of the same failure: a stale bundle can also carry
    // tools that src/ no longer registers. Either way the drift means the bundle
    // was not rebuilt alongside the change to the tool surface.
    expect(
      bundledTools(),
      "server.bundle.mjs is out of step with src/ — rebuild and commit it",
    ).toEqual(registeredTools());
  });
});

// ─────────────────────────────────────────────────────────
// 6. Fork identity
// ─────────────────────────────────────────────────────────

describe("fork identity", () => {
  it("points the manifests at the fork, not at upstream's tracker", () => {
    const pkg = readJson<{ fork?: { repo?: string; name?: string } }>("package.json");
    const forkRepo = pkg.fork?.repo?.replace(/\.git$/, "");
    expect(forkRepo, "package.json has no fork marker").toBeTruthy();
    const owner = forkRepo!.replace(/^https?:\/\/github\.com\//, "").split("/")[0];

    const plugin = readJson<Record<string, unknown>>(".claude-plugin", "plugin.json");
    // A user who installs from this marketplace and follows the metadata must
    // land in the tracker that owns the code they are running.
    for (const field of ["homepage", "repository", "bugs"]) {
      expect(String(plugin[field] ?? ""), `plugin.json ${field} still points at upstream`).toContain(
        `github.com/${owner}/`,
      );
    }
    expect(JSON.stringify(plugin.author)).toContain(owner);

    const marketplace = readJson<{
      owner?: { name?: string };
      plugins?: Array<{ author?: { name?: string } }>;
    }>(".claude-plugin", "marketplace.json");
    expect(marketplace.owner?.name).toBe(owner);
    expect(marketplace.plugins?.[0]?.author?.name).toBe(owner);
  });

  it("credits upstream in prose instead of in the ownership fields", () => {
    const plugin = readJson<{ description?: string }>(".claude-plugin", "plugin.json");
    expect(plugin.description ?? "", "the fork's origin should stay stated somewhere").toMatch(
      /fork of/i,
    );
    expect(existsSync(join(repoRoot, "docs", "FORK-CHANGES.md"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────
// 7. The savings claim
// ─────────────────────────────────────────────────────────

describe("savings claim", () => {
  it("has no hardcoded compression multiplier left in analytics", () => {
    const src = readFileSync(join(repoRoot, "src", "session", "analytics.ts"), "utf-8");
    // The 98% headline used to rest on `lifetimeTokensWithout * 0.02` — a
    // constant that asserted the claim rather than measuring it. Comments may
    // still explain the removal; code may not reintroduce it.
    const offenders = src
      .split("\n")
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
      .filter(([, line]) => /\*\s*0\.02\b/.test(line));
    expect(
      offenders.map(([n, l]) => `analytics.ts:${n}: ${l.trim()}`),
      "hardcoded savings multiplier is back",
    ).toEqual([]);
  });

  it("states the same measured claim in the manifest, the marketplace entry and the README", () => {
    const plugin = readJson<{ description: string }>(".claude-plugin", "plugin.json").description;
    const market = readJson<{ plugins: Array<{ description: string }> }>(
      ".claude-plugin",
      "marketplace.json",
    ).plugins[0].description;
    const readme = readFileSync(join(repoRoot, "README.md"), "utf-8");
    const benchmark = readFileSync(join(repoRoot, "BENCHMARK.md"), "utf-8");

    // Whatever the number is, it has to be the SAME number everywhere and it has
    // to be traceable to the measured corpus rather than to a marketing round-up.
    for (const [name, text] of [["plugin.json", plugin], ["marketplace.json", market]] as const) {
      expect(text, `${name}: savings claim lost its measured basis`).toMatch(/315 KB/);
      expect(text, `${name}: savings claim lost its measured basis`).toMatch(/5\.4 KB/);
      expect(text, `${name}: savings claim lost its measured basis`).toMatch(/98% reduction/);
    }
    expect(readme).toMatch(/315 KB of raw output comes back as 5\.4 KB/);
    expect(benchmark).toMatch(/315 KB raw → 5\.4 KB context \(98% savings\)/);
  });
});
