/**
 * Every routing-target description names the native tool it displaces.
 *
 * A tool description is read immediately before the choice is made. CLAUDE.md
 * and the SessionStart routing block are read long before it, and both are
 * pushed further away by every turn that follows. So the description is the
 * last surface with the model's attention — and the model is not choosing a
 * tool in isolation, it is comparing `ctx_find` against Grep and Glob. If the
 * comparison is not written down, it gets made from priors, and the priors
 * were trained on Grep.
 *
 * Hence the rule this file enforces: a description that competes with a native
 * tool has to say which one, by name. "One search across everything this
 * project knows" is true and loses to Grep; "instead of Grep, when the answer
 * is one path rather than a page of matches" is the same claim with the
 * comparison already made.
 *
 * The honesty half is enforced too. Every routing target carries a WHEN NOT
 * section (the ADR-0002 contract in tests/core/server.test.ts makes WHEN,
 * RETURNS and EXAMPLE mandatory but leaves WHEN NOT optional), because a
 * description that asks to be called for everything is one the model stops
 * reading. WHEN NOT is where "Read before Edit" belongs.
 */

import { describe, it, expect } from "vitest";
import { serverSource } from "../shared/server-source.js";

/**
 * The tools that compete with a native tool for the same job. Value is the
 * set of native names of which at least one must appear — a tool may displace
 * more than one, and which of them the description leads with is an authoring
 * choice, not a contract.
 */
const DISPLACES: Record<string, string[]> = {
  ctx_execute: ["Bash"],
  ctx_execute_file: ["Read"],
  ctx_read: ["Read"],
  ctx_search: ["Bash", "Read"],
  ctx_find: ["Grep", "Glob"],
  ctx_graph: ["Grep", "Read"],
  ctx_batch_execute: ["Bash"],
  ctx_gather: ["Bash"],
  ctx_fetch_and_index: ["WebFetch"],
};

/**
 * Tools with no native counterpart to name.
 *
 * ctx_index stores content the agent already has; nothing native competes for
 * that. The diagnostics (stats, doctor, upgrade, purge, insight) are
 * affordances a user reaches for by name, not choices made against a native
 * tool — the same set ADR-0002 exempts from the WHEN: requirement.
 */
const NO_NATIVE_COUNTERPART = new Set([
  "ctx_index",
  "ctx_stats",
  "ctx_doctor",
  "ctx_upgrade",
  "ctx_purge",
  "ctx_insight",
]);

interface ToolDescription {
  name: string;
  description: string;
}

/**
 * Same extraction shape as the ADR-0002 contract in server.test.ts: read the
 * `description:` block out of every registration across all the files the
 * server is built from, so a tool that moves out of src/server.ts stays in the
 * corpus instead of quietly leaving it.
 */
function extractToolDescriptions(): ToolDescription[] {
  const lines = serverSource().split("\n");
  const out: ToolDescription[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/registerTool\(\s*$/.test(lines[i])) continue;
    const name = /^\s*"(ctx_[a-z_]+)"\s*,\s*$/.exec(lines[i + 1] ?? "")?.[1];
    if (!name) continue;
    let start = -1;
    let end = -1;
    for (let j = i + 2; j < Math.min(i + 80, lines.length); j++) {
      if (start < 0 && /^\s*description:/.test(lines[j])) start = j;
      else if (start >= 0 && /^\s*(inputSchema|outputSchema|annotations):/.test(lines[j])) {
        end = j;
        break;
      }
    }
    if (start < 0 || end < 0) continue;
    out.push({ name, description: lines.slice(start, end).join("\n") });
  }
  return out;
}

const TOOLS = extractToolDescriptions();

describe("tool descriptions name the native tool they displace", () => {
  it("finds every registered tool's description", () => {
    // Guards the extractor: a silent zero here would make every assertion
    // below vacuous, and a tool missing from the corpus is a tool whose
    // description nobody checks.
    const found = new Set(TOOLS.map((t) => t.name));
    const expected = [...Object.keys(DISPLACES), ...NO_NATIVE_COUNTERPART];
    const missing = expected.filter((name) => !found.has(name));
    expect(missing, `descriptions not extracted for: ${missing.join(", ")}`).toEqual([]);
  });

  it("classifies every registered tool as either displacing or not", () => {
    // Forces a decision on a new tool instead of letting it default out of the
    // rule: whoever adds it either names its native counterpart or says here,
    // in writing, that it has none.
    const unclassified = TOOLS.map((t) => t.name).filter(
      (name) => !(name in DISPLACES) && !NO_NATIVE_COUNTERPART.has(name),
    );
    expect(
      unclassified,
      `unclassified tools: ${unclassified.join(", ")} — add each to DISPLACES with the ` +
        "native tool it competes with, or to NO_NATIVE_COUNTERPART with the reason",
    ).toEqual([]);
  });

  it("names at least one displaced native tool per routing target", () => {
    const silent: string[] = [];
    for (const tool of TOOLS) {
      const natives = DISPLACES[tool.name];
      if (!natives) continue;
      const named = natives.filter((n) => new RegExp(`\\b${n}\\b`).test(tool.description));
      if (named.length === 0) {
        silent.push(
          `${tool.name} never names ${natives.join(" or ")} — the model compares it against ` +
            `${natives[0]} at selection time and will make that comparison from priors`,
        );
      }
    }
    expect(silent, `descriptions that leave the comparison unwritten:\n${silent.join("\n")}`).toEqual([]);
  });

  it("carries a WHEN NOT section on every routing target", () => {
    // The concession is what makes the rest credible. A description with no
    // case against itself reads as advertising, and the model discounts it.
    const missing = TOOLS.filter(
      (t) => t.name in DISPLACES && !/(?:\\n|^|\s|")WHEN NOT:/.test(t.description),
    ).map((t) => t.name);
    expect(
      missing,
      `routing targets with no WHEN NOT: section: ${missing.join(", ")} — name the case ` +
        "where the native tool is the better call",
    ).toEqual([]);
  });

  it("concedes Read-before-Edit wherever the tool competes with Read", () => {
    // The one concession that has to be in writing: Edit matches against the
    // exact bytes in the conversation, so routing a pre-edit Read into a
    // subprocess produces an edit that cannot apply. A tool that offers itself
    // in Read's place and stays quiet about this is wrong in a way the model
    // cannot detect until the Edit fails.
    const silent: string[] = [];
    for (const tool of TOOLS) {
      if (!DISPLACES[tool.name]?.includes("Read")) continue;
      if (!/\bEdit\b/.test(tool.description)) silent.push(tool.name);
    }
    expect(
      silent,
      `these offer themselves in Read's place without conceding the Edit case: ${silent.join(", ")}`,
    ).toEqual([]);
  });
});
