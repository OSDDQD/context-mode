/**
 * Every subagent that can reach for a flooding tool must also be able to reach
 * for its routed replacement.
 *
 * A subagent gets the routing block injected into its prompt, so it is told to
 * answer with `ctx_find` instead of Grep, `ctx_execute_file` instead of Read,
 * `ctx_batch_execute` instead of Bash. But an agent's `tools:` frontmatter is
 * an allowlist, not a preference: a tool missing from it cannot be called at
 * all. An agent that lists Grep and not `ctx_find` is therefore instructed to
 * do something it is physically incapable of doing — and the only path left
 * open is the one the instruction forbids, so it takes it, every time.
 *
 * That is not hypothetical either. `context-gather`, the one agent in this
 * repository written specifically to survey a tree without reading it, listed
 * Bash/Read/Glob/Grep and did not list `ctx_find` or `ctx_graph` until c50eb66.
 *
 * The rule is derived, not enumerated: the check reads whatever agent
 * definitions exist and asks, per agent, "which flooding tools did you keep,
 * and did you keep their replacements too". A new agent is covered the moment
 * it is added, without anyone remembering to extend a list here.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { createToolNamer } from "../../hooks/core/tool-naming.mjs";

const REPO_ROOT = resolve(__dirname, "..", "..");

/**
 * Claude Code surfaces the plugin's MCP tools as
 * `mcp__plugin_context-mode_context-mode__<tool>`, and that full name is what
 * an allowlist has to contain — the bare `ctx_find` matches nothing. Taken from
 * the hooks' own namer so the prefix is never hand-copied into a test.
 */
const t = createToolNamer("claude-code");

/**
 * What each context-flooding tool has to be paired with. Values are the tools
 * the routing block actually tells the agent to use in that tool's place, so a
 * failure here reads as "the agent was told X and cannot do X".
 *
 * WebFetch is included alongside the four the plan names: the routing block
 * does not merely prefer `ctx_fetch_and_index` over WebFetch, it blocks
 * WebFetch outright, which makes the missing-replacement case identical.
 */
const REPLACEMENTS: Record<string, string[]> = {
  Bash: ["ctx_batch_execute", "ctx_execute"],
  Read: ["ctx_execute_file"],
  Grep: ["ctx_find"],
  Glob: ["ctx_find"],
  WebFetch: ["ctx_fetch_and_index"],
};

/** Why the pairing matters, quoted back in the failure message. */
const CONSEQUENCE: Record<string, string> = {
  Bash: "every command's full output lands in the subagent's context",
  Read: "whole files land in the subagent's context instead of the answer",
  Grep: "the subagent falls back to raw greps it was told not to run",
  Glob: "the subagent falls back to raw globs it was told not to run",
  WebFetch: "raw page bytes land in the subagent's context",
};

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "refs",
  "dist",
  "build",
  "coverage",
  ".vitest-cache",
]);

/** Every `*.md` under a directory named `agents`, at any depth. */
function findAgentFiles(dir: string, insideAgents = false, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) findAgentFiles(full, insideAgents || entry === "agents", out);
    else if (insideAgents && entry.endsWith(".md")) out.push(full);
  }
  return out;
}

/**
 * The `tools:` entry of a definition's frontmatter, in any of the three shapes
 * a definition may use: a YAML block list, an inline `[a, b]`, or a bare
 * comma-separated string. No YAML parser is pulled in for five lines of it.
 */
function parseTools(frontmatter: string): string[] | null {
  const lines = frontmatter.split("\n");
  const start = lines.findIndex((l) => /^tools\s*:/.test(l));
  if (start < 0) return null;

  const inline = lines[start].replace(/^tools\s*:/, "").trim();
  if (inline) {
    return inline
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }

  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (!item) break; // end of the block list
    items.push(item[1].replace(/^["']|["']$/g, ""));
  }
  return items;
}

interface AgentDef {
  path: string;
  name: string;
  tools: string[];
}

function loadAgents(): AgentDef[] {
  const agents: AgentDef[] = [];
  for (const file of findAgentFiles(REPO_ROOT)) {
    const src = readFileSync(file, "utf-8");
    if (!src.startsWith("---")) continue;
    const end = src.indexOf("\n---", 3);
    if (end < 0) continue;
    const frontmatter = src.slice(3, end);
    const tools = parseTools(frontmatter);
    if (tools === null) continue; // no allowlist at all — nothing is restricted
    const name = /^name\s*:\s*(.+)$/m.exec(frontmatter)?.[1].trim();
    agents.push({
      path: relative(REPO_ROOT, file).split(sep).join("/"),
      name: name ?? relative(REPO_ROOT, file),
      tools,
    });
  }
  return agents;
}

const AGENTS = loadAgents();

describe("subagent tool allowlists", () => {
  it("finds the agent definitions, and actually parses their allowlists", () => {
    // A discovery walk that silently returns nothing — or a frontmatter parse
    // that returns an empty list — turns every assertion below into a no-op,
    // which is the quietest way for this guard to die. Asserted here so a
    // green run means the rule was applied, not skipped.
    expect(
      AGENTS.map((a) => a.path),
      "no agent definitions with a tools allowlist were found — the discovery walk is broken",
    ).not.toEqual([]);
    const empty = AGENTS.filter((a) => a.tools.length === 0).map((a) => a.path);
    expect(empty, `agent definitions whose tools list parsed as empty:\n${empty.join("\n")}`).toEqual([]);
    const exercised = AGENTS.some((a) => a.tools.some((tool) => tool in REPLACEMENTS));
    expect(
      exercised,
      "no discovered agent lists any of " +
        `${Object.keys(REPLACEMENTS).join("/")} — the pairing rule below would assert nothing`,
    ).toBe(true);
  });

  it("pairs every flooding tool with the ctx_* tool that replaces it", () => {
    const violations: string[] = [];
    for (const agent of AGENTS) {
      for (const [flooding, replacements] of Object.entries(REPLACEMENTS)) {
        if (!agent.tools.includes(flooding)) continue;
        const missing = replacements.filter((r) => !agent.tools.includes(t(r)));
        if (missing.length === 0) continue;
        violations.push(
          `${agent.name} (${agent.path}) allows ${flooding} but not ` +
            `${missing.map((m) => t(m)).join(", ")} — the routing block tells it to use ` +
            `${missing.join("/")} instead, and an allowlist omission means it cannot; ` +
            CONSEQUENCE[flooding],
        );
      }
    }
    expect(violations, `subagents told to route but unable to:\n${violations.join("\n")}`).toEqual([]);
  });

  it("spells ctx_* tools with the host-visible MCP prefix", () => {
    // A bare `ctx_find` in an allowlist looks right and allows nothing: the
    // host matches against the fully qualified MCP name. This is the failure
    // mode that would make the check above pass while the agent still cannot
    // call the tool.
    const bare: string[] = [];
    for (const agent of AGENTS) {
      for (const tool of agent.tools) {
        if (/^ctx_[a-z_]+$/.test(tool)) bare.push(`${agent.path}: "${tool}" (should be "${t(tool)}")`);
      }
    }
    expect(bare, `unqualified ctx_* names in agent allowlists:\n${bare.join("\n")}`).toEqual([]);
  });
});
