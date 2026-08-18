/**
 * The one routing line that names the search tool.
 *
 * Before this wave the rule a user carried in their own CLAUDE.md pointed at
 * an EXTERNAL file-search MCP ("use the fff MCP tools for all file search").
 * The engine moved in-process, so the rule now has to point at the plugin's
 * own unified search instead — and it has to do so from the block the hooks
 * inject, not from a file the user maintains by hand.
 *
 * Asserted at the level of intent (the tool is named, the external MCP is
 * ruled out, every platform gets its own spelling) rather than by pinning the
 * whole sentence, so wording can improve without a test rewrite.
 */

import { describe, test, expect } from "vitest";

import { createRoutingBlock, ROUTING_BLOCK } from "../../hooks/routing-block.mjs";
import { createToolNamer, KNOWN_PLATFORMS } from "../../hooks/core/tool-naming.mjs";

/** The FIND entry, whatever number it currently carries. */
function findLine(block: string): string | undefined {
  return block.split("\n").find((l) => l.includes("FIND:"));
}

describe("the FIND routing line", () => {
  test("names ctx_find and describes it as one search over four surfaces", () => {
    const line = findLine(ROUTING_BLOCK);
    expect(line).toBeDefined();
    expect(line).toContain("ctx_find");
    for (const surface of ["file names", "file contents", "indexed memory", "code structure"]) {
      expect(line).toContain(surface);
    }
  });

  test("rules out the external file-search MCP and the Glob/Grep chain", () => {
    const line = findLine(ROUTING_BLOCK) ?? "";
    expect(line).toMatch(/instead of chaining Glob\/Grep/);
    expect(line).toMatch(/separate file-search MCP/);
  });

  test("no rule anywhere in the block still points at the external fff MCP", () => {
    expect(ROUTING_BLOCK).not.toMatch(/fff/i);
  });

  test("it lives inside the tool hierarchy, so subagents inherit it", () => {
    const hierarchy = ROUTING_BLOCK.split("<tool_selection_hierarchy>")[1]
      ?.split("</tool_selection_hierarchy>")[0] ?? "";
    expect(hierarchy).toContain("FIND:");
  });

  test("every platform gets the tool spelled its own way", () => {
    for (const platform of KNOWN_PLATFORMS) {
      const t = createToolNamer(platform);
      const line = findLine(createRoutingBlock(t));
      expect(line, platform).toContain(t("ctx_find"));
    }
  });

  test("the line survives the subagent variant of the block", () => {
    const t = createToolNamer("claude-code");
    const block = createRoutingBlock(t, { includeCommands: false, toolSearchBootstrap: true });
    expect(findLine(block)).toContain(t("ctx_find"));
  });
});
