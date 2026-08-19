/**
 * Every tool the server registers is named in the block that teaches routing.
 *
 * The routing block is the only place the rules live inside a session: it
 * arrives on SessionStart, again after every compaction, and again in every
 * subagent's prompt. A tool absent from it is a tool the model was never told
 * to prefer — it exists in the tool list and in its own description, and the
 * one text that shapes the choice says nothing about it.
 *
 * That is not a hypothetical either. `ctx_read` was added specifically so the
 * model would stop reaching for Read, and shipped with the block never
 * mentioning it; `ctx_gather` and `ctx_index` had been unmentioned for longer.
 * The failure is silent by construction — nothing errors, the model simply
 * keeps doing what it did before, and the new tool looks like it "did not
 * help".
 *
 * `tests/plugins/plugin-structure.test.ts` already runs the mirror image of
 * this check against the committed bundle, where it caught three tools going
 * missing from the shipped surface. This one catches the opposite: the tool
 * ships fine, and the rule about it is silent.
 *
 * Both variants of the block are checked, because they are two different
 * prompts: the session one and the one injected into subagents, which drops
 * the operator commands on purpose (a subagent cannot run them — #233).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRoutingBlock } from "../../hooks/routing-block.mjs";
import { createToolNamer } from "../../hooks/core/tool-naming.mjs";

const REPO_ROOT = resolve(__dirname, "..", "..");

/**
 * Files the server registers tools from, read as text.
 *
 * Text, not an import: the assertion is about which names are registered, and
 * reading them directly keeps this test independent of the server's module
 * graph — which pulls in the store, the adapters and the session layer, any of
 * which can be mid-refactor while this invariant still needs checking.
 */
const REGISTRATION_SOURCES = [
  "src/server.ts",
  "src/tools/search.ts",
  "src/tools/find.ts",
  "src/tools/graph.ts",
  "src/tools/read.ts",
  "src/tools/fetch.ts",
  "src/tools/batch.ts",
  "src/tools/ops.ts",
];

function registeredTools(): string[] {
  const names = new Set<string>();
  for (const rel of REGISTRATION_SOURCES) {
    let source: string;
    try {
      source = readFileSync(resolve(REPO_ROOT, rel), "utf-8");
    } catch {
      continue; // a file that moved is caught by the sanity check below
    }
    for (const m of source.matchAll(/registerTool\(\s*\n?\s*"(ctx_[a-z_]+)"/g)) names.add(m[1]);
  }
  return [...names].sort();
}

/**
 * Tools the SUBAGENT block is allowed to stay silent about.
 *
 * Only the operator commands, and only in the subagent variant: a subagent has
 * no user to run `ctx doctor` for and no business upgrading or purging
 * anything, which is why `includeCommands: false` exists (#233). Everything
 * else — every tool a subagent might actually choose between — must be named.
 *
 * The session block has no exemptions at all. If one is ever needed, it goes
 * here with the reason written out; a tool dropped from the block without a
 * line in this list is what this test is for.
 */
const SUBAGENT_EXEMPT: Record<string, string> = {
  ctx_stats: "operator command — a subagent has no user to report savings to",
  ctx_doctor: "operator command — diagnostics are run by the person, not the subagent",
  ctx_upgrade: "operator command — a subagent must not upgrade the plugin under itself",
  ctx_purge: "operator command — destructive, and never a subagent's call to make",
  ctx_insight: "operator command — opens a dashboard in the person's browser",
};

const TOOLS = registeredTools();
const t = createToolNamer("claude-code");
const SESSION_BLOCK = createRoutingBlock(t, { includeCommands: true });
const SUBAGENT_BLOCK = createRoutingBlock(t, { includeCommands: false, toolSearchBootstrap: true });

describe("routing block names every registered tool", () => {
  it("finds the registrations at all", () => {
    // A silent zero here would make every assertion below vacuous.
    expect(TOOLS.length, "no ctx_* registrations found — the extractor is out of date").toBeGreaterThanOrEqual(15);
    expect(TOOLS).toContain("ctx_read");
  });

  it("names all of them in the session block", () => {
    const silent = TOOLS.filter((tool) => !SESSION_BLOCK.includes(tool));
    expect(
      silent,
      `these tools ship but the routing block never mentions them: ${silent.join(", ")}. ` +
        "The block is what the model reads before choosing, so an unmentioned tool is one " +
        "it was never told to prefer. Add it to the hierarchy where it belongs — not as a " +
        "line at the end — or, if it genuinely does not belong there, add it to " +
        "SUBAGENT_EXEMPT with the reason.",
    ).toEqual([]);
  });

  it("names all of them in the subagent block, bar the operator commands", () => {
    const expected = TOOLS.filter((tool) => !(tool in SUBAGENT_EXEMPT));
    const silent = expected.filter((tool) => !SUBAGENT_BLOCK.includes(tool));
    expect(
      silent,
      `the subagent block never mentions: ${silent.join(", ")}. A subagent gets this text ` +
        "and nothing else — a tool missing here is a tool it cannot know to use.",
    ).toEqual([]);
  });

  it("keeps the exemption list honest", () => {
    // An exemption for a tool that no longer exists is a comment pretending to
    // be a decision; and every exempt tool must really be absent, otherwise
    // the list is describing a state that is not true.
    for (const [tool, reason] of Object.entries(SUBAGENT_EXEMPT)) {
      expect(TOOLS, `${tool} is exempt but no longer registered`).toContain(tool);
      expect(reason.length, `${tool} is exempt without a reason`).toBeGreaterThan(20);
      expect(
        SUBAGENT_BLOCK.includes(tool),
        `${tool} is listed as exempt from the subagent block but appears in it`,
      ).toBe(false);
    }
  });

  it("spells every mention the running host's way", () => {
    // A bare `ctx_read` in the block is a name the agent cannot call on Claude
    // Code, where the wire name is prefixed. Everything must go through the
    // namer — the `<ctx_commands>` XML tag is markup, not a tool.
    for (const [platform, block] of [
      ["claude-code", SESSION_BLOCK],
      ["codex", createRoutingBlock(createToolNamer("codex"), { includeCommands: true })],
    ] as const) {
      const namer = createToolNamer(platform);
      const mentions = [...block.matchAll(/(?<![<\/])(?:mcp__[A-Za-z0-9_-]*__)?ctx_[a-z_]+/g)].map((m) => m[0]);
      for (const mention of mentions) {
        const bare = mention.replace(/^mcp__[A-Za-z0-9_-]*__/, "");
        if (!TOOLS.includes(bare)) continue; // prose like "ctx purge" is not a call
        expect(mention, `${platform}: "${mention}" is not how ${platform} spells it`).toBe(namer(bare));
      }
    }
  });
});

describe("the block does not promise what is no longer there", () => {
  it("names no removed platform", () => {
    for (const gone of [
      "gemini", "cursor", "vscode", "jetbrains", "kiro", "kimi", "kilo",
      "zed", "opencode", "openclaw", "qwen", "antigravity", "copilot", "\\bpi\\b",
    ]) {
      expect(
        new RegExp(gone, "i").test(SESSION_BLOCK),
        `the routing block still mentions ${gone}, a host that no longer ships`,
      ).toBe(false);
    }
  });

  it("names no tool that is not registered", () => {
    // The inverse of the coverage check: a block that advertises a tool the
    // server does not register sends the model to call something that will
    // come back "not found", and the fallback is the native tool.
    const mentioned = new Set(
      [...SESSION_BLOCK.matchAll(/(?<![<\/])mcp__[A-Za-z0-9_-]*__(ctx_[a-z_]+)/g)].map((m) => m[1]),
    );
    const phantom = [...mentioned].filter((tool) => !TOOLS.includes(tool));
    expect(phantom, `the block names tools that are not registered: ${phantom.join(", ")}`).toEqual([]);
  });

  it("preloads the deferred schema of every tool it tells a subagent to use", () => {
    // Claude Code defers MCP schemas, so a subagent that calls a tool it has
    // not loaded gets "tool not found" and falls back to the native tool it
    // was told to avoid. ctx_find and ctx_graph sat in the hierarchy for a
    // whole wave without being in this list.
    const bootstrap = /ToolSearch\(query: "select:([^"]+)"\)/.exec(SUBAGENT_BLOCK)?.[1] ?? "";
    const preloaded = new Set(bootstrap.split(",").map((n) => n.trim().replace(/^mcp__[A-Za-z0-9_-]*__/, "")));
    const expected = TOOLS.filter((tool) => !(tool in SUBAGENT_EXEMPT));
    const missing = expected.filter((tool) => !preloaded.has(tool));
    expect(
      missing,
      `the subagent is told to use these but their schemas are never preloaded: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});

describe("ctx_read is placed where the choice is made", () => {
  it("sits beside ctx_execute_file, not appended after the hierarchy", () => {
    const hierarchy = /<tool_selection_hierarchy>([\s\S]*?)<\/tool_selection_hierarchy>/.exec(SESSION_BLOCK)?.[1] ?? "";
    expect(hierarchy, "ctx_read is not in the selection hierarchy at all").toContain("ctx_read");
    expect(hierarchy).toContain("ctx_execute_file");
  });

  it("gives one reason to pick it over Read, and one over ctx_execute_file", () => {
    // A tool named without a reason to choose it loses to habit. The two
    // distinctions that matter: it answers a question instead of returning the
    // file, and unlike ctx_execute_file it needs no program written first.
    const hierarchy = /<tool_selection_hierarchy>([\s\S]*?)<\/tool_selection_hierarchy>/.exec(SESSION_BLOCK)?.[1] ?? "";
    expect(hierarchy, "no reason given to prefer ctx_read over Read").toMatch(/KNOW something about a file rather than SEE/);
    expect(hierarchy, "no reason given to prefer ctx_read over ctx_execute_file").toMatch(/no program to compose/i);
  });

  it("still concedes Read-before-Edit", () => {
    // The concession is what keeps the rest credible, and it is the one case
    // where routing a Read away breaks the actual job.
    expect(SESSION_BLOCK).toMatch(/Edit matches the exact bytes|Edit needs the exact bytes/);
  });
});
