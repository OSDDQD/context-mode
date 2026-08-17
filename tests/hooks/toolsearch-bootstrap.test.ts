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
import { createRoutingBlock } from "../../hooks/routing-block.mjs";
// @ts-ignore — plain .mjs hook module without type declarations
import { createToolNamer } from "../../hooks/core/tool-naming.mjs";

const t = createToolNamer("claude-code");

describe("createRoutingBlock toolSearchBootstrap", () => {
  test("off by default — no bootstrap block, no ToolSearch mention", () => {
    const block = createRoutingBlock(t);
    expect(block).not.toContain("deferred_tool_bootstrap");
    expect(block).not.toContain("ToolSearch");
  });

  test("on: teaches a single select: load of the core ctx_* tools", () => {
    const block = createRoutingBlock(t, { toolSearchBootstrap: true });
    expect(block).toContain("deferred_tool_bootstrap");
    // One ToolSearch call with select: syntax and platform-correct tool names.
    expect(block).toMatch(/ToolSearch\(query: "select:/);
    expect(block).toContain(t("ctx_batch_execute"));
    expect(block).toContain(t("ctx_search"));
    expect(block).toContain(t("ctx_execute"));
    // The failure mode it exists to prevent: giving up on ctx_* tools.
    expect(block).toContain("do NOT fall back to Bash/Read");
  });

  test("ADR-0003 vocabulary: the bootstrap must not read as a restriction", () => {
    const block = createRoutingBlock(t, { toolSearchBootstrap: true });
    const bootstrap = block.slice(
      block.indexOf("<deferred_tool_bootstrap>"),
      block.indexOf("</deferred_tool_bootstrap>"),
    );
    for (const word of ["blocked", "forbidden", "not allowed", "restricted", "denied"]) {
      expect(bootstrap.toLowerCase()).not.toContain(word);
    }
  });
});
