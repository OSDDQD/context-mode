/**
 * Deferred-tool bootstrap in the SessionStart routing block (fork feature #13).
 *
 * Claude Code's tool-search releases defer MCP tool schemas: the ctx_* tools
 * are visible by name only until a ToolSearch call loads them, and a direct
 * call before that fails. The routing block must teach the model to load them
 * in one ToolSearch instead of erroring and falling back to raw Bash/Read.
 */

import { describe, expect, test } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs hook module without type declarations
import { createRoutingBlock, createSubagentRoutingBlock } from "../../hooks/routing-block.mjs";
// @ts-ignore — plain .mjs hook module without type declarations
import { createToolNamer } from "../../hooks/core/tool-naming.mjs";

const t = createToolNamer("claude-code");

/**
 * The bootstrap is one line in the compact block — the XML container it used
 * to carry cost 60 bytes of a 3 KB budget for a single sentence.
 */
function bootstrapLine(block: string): string {
  return block.split("\n").find((l) => l.includes("ToolSearch(query:")) ?? "";
}

describe("createRoutingBlock toolSearchBootstrap", () => {
  test("off by default — no bootstrap line, no ToolSearch mention", () => {
    const block = createRoutingBlock(t);
    expect(block).not.toContain("Deferred schemas");
    expect(block).not.toContain("ToolSearch");
  });

  test("on: teaches a single select: load of the core ctx_* tools", () => {
    const block = createRoutingBlock(t, { toolSearchBootstrap: true });
    expect(block).toContain("Deferred schemas");
    // One ToolSearch call with select: syntax and platform-correct tool names.
    expect(block).toMatch(/ToolSearch\(query: "select:/);
    expect(block).toContain(t("ctx_batch_execute"));
    expect(block).toContain(t("ctx_search"));
    expect(block).toContain(t("ctx_execute"));
    // The failure mode it exists to prevent: giving up on ctx_* tools.
    expect(block).toContain("do NOT fall back to Bash/Read");
  });

  test("the subagent block carries the same bootstrap — it is the reader that needs it most", () => {
    // A subagent starts with an empty context: nothing has loaded the schemas
    // for it, and a not-found ctx_* call sends it straight back to Bash (#724).
    const block = createSubagentRoutingBlock(t, { toolSearchBootstrap: true });
    expect(block).toMatch(/ToolSearch\(query: "select:/);
    expect(block).toContain(t("ctx_find"));
    expect(block).toContain("do NOT fall back to Bash/Read");
    expect(createSubagentRoutingBlock(t, {})).not.toContain("ToolSearch");
  });

  test("ADR-0003 vocabulary: the bootstrap must not read as a restriction", () => {
    for (const block of [
      createRoutingBlock(t, { toolSearchBootstrap: true }),
      createSubagentRoutingBlock(t, { toolSearchBootstrap: true }),
    ]) {
      const bootstrap = bootstrapLine(block);
      expect(bootstrap.length, "no bootstrap line found").toBeGreaterThan(0);
      for (const word of ["blocked", "forbidden", "not allowed", "restricted", "denied"]) {
        expect(bootstrap.toLowerCase()).not.toContain(word);
      }
    }
  });
});
