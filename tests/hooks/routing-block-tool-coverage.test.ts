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
 * prompts now, not one text with a section switched off: the session block and
 * the smaller subagent block, which drops the operator commands on purpose (a
 * subagent cannot run them — #233) along with the memory and stats prose.
 */

import { describe, it, expect } from "vitest";
import { createRoutingBlock, createSubagentRoutingBlock } from "../../hooks/routing-block.mjs";
import { createToolNamer } from "../../hooks/core/tool-naming.mjs";
import { serverSource } from "../shared/server-source.js";

/**
 * The tools the server registers, read out of the source as text.
 *
 * Text, not an import of the server: the assertion is about which names are
 * registered, and reading them directly keeps this test independent of the
 * server's module graph — which pulls in the store, the adapters and the
 * session layer, any of which can be mid-refactor while this invariant still
 * needs checking. `serverSource()` is a test helper that reads text too, so
 * that independence is unchanged.
 *
 * This file used to keep its OWN list of registration files, and it drifted:
 * `src/tools/pack.ts` was extracted, `ctx_pack` shipped, and this suite could
 * not see it — the one thing the suite exists to catch went uncaught by the
 * suite itself. Two lists of the same thing will always drift, so there is now
 * one: `SERVER_SOURCE_FILES` in `tests/shared/server-source.ts`, which eight
 * other suites already depend on. A new tool file omitted from it now fails
 * loudly across all of them instead of quietly narrowing this check.
 *
 * The helper's extra entries (`shared/state.ts`, `search/dedup.ts`) hold no
 * `registerTool` call, so widening the corpus cannot add a false name.
 */
function registeredTools(): string[] {
  const names = new Set<string>();
  for (const m of serverSource().matchAll(/registerTool\(\s*\n?\s*"(ctx_[a-z_]+)"/g)) {
    names.add(m[1]!);
  }
  return [...names].sort();
}

/**
 * Tools the SUBAGENT block is allowed to stay silent about.
 *
 * Mostly the operator commands, and only in the subagent variant: a subagent
 * has no user to run `ctx doctor` for and no business upgrading or purging
 * anything, which is why `createSubagentRoutingBlock` is a separate text
 * (#233). Everything else — every tool a subagent might actually choose
 * between — must be named.
 *
 * `ctx_pack` is the one non-operator entry, and it is here for the same reason
 * rather than a new one: a subagent's job is to hand its answer back to its
 * parent, not to assemble briefs for further subagents, so it is not a tool a
 * subagent chooses between. The cost is not rhetorical either — this list also
 * gates the ToolSearch bootstrap below, one name there costs 47 bytes at the
 * Claude Code prefix, and the subagent block has 45 bytes under its ceiling.
 * The SESSION block names ctx_pack with no exemption, which is where the
 * delegating agent actually reads it.
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
  ctx_pack: "briefs a subagent — a subagent reports to its parent, it does not brief further ones",
};

const TOOLS = registeredTools();
const t = createToolNamer("claude-code");
const SESSION_BLOCK = createRoutingBlock(t, { includeCommands: true });
const SUBAGENT_BLOCK = createSubagentRoutingBlock(t, { toolSearchBootstrap: true });

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

  it("gives the running host's spelling, once, for the bare names it then uses", () => {
    // A bare `ctx_read` is a name the agent cannot call on Claude Code, where
    // the wire name carries a 39-character prefix. Spelling all fifteen in
    // full costs ~600 bytes of a 3 KB block, so the compact text declares the
    // prefix instead — which only works while the declaration is present, is
    // the host's own, and no OTHER host's spelling has leaked in beside it.
    for (const [platform, block] of [
      ["claude-code", SESSION_BLOCK],
      ["claude-code", SUBAGENT_BLOCK],
      ["codex", createRoutingBlock(createToolNamer("codex"), { includeCommands: true })],
      ["codex", createSubagentRoutingBlock(createToolNamer("codex"))],
    ] as const) {
      const namer = createToolNamer(platform);
      expect(
        block,
        `${platform}: the block uses bare names and never spells one the host's way`,
      ).toContain(namer("ctx_find"));

      const mentions = [...block.matchAll(/(?<![<\/])(?:mcp__[A-Za-z0-9_-]*__)?ctx_[a-z_]+/g)].map((m) => m[0]);
      for (const mention of mentions) {
        const bare = mention.replace(/^mcp__[A-Za-z0-9_-]*__/, "");
        if (!TOOLS.includes(bare)) continue; // prose like "ctx purge" is not a call
        // Either bare — covered by the declaration above — or this host's
        // full spelling. Anything else is another host's wire name.
        expect(
          mention === bare || mention === namer(bare),
          `${platform}: "${mention}" is neither bare nor how ${platform} spells it`,
        ).toBe(true);
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
