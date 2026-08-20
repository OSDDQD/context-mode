/**
 * Byte ceilings on the JSON Schemas the server publishes for its tools.
 *
 * Same trade this repo already pins for the routing block
 * (`tests/hooks/routing-block-size.test.ts`) and for the tool prose
 * (`tests/core/compact-descriptions.test.ts`), applied to the third surface
 * that ships on every request: `inputSchema`.
 *
 * The baseline, and how to reproduce it: at commit f74f5b0, `npm run bundle`
 * then handshake `start.mjs` (`initialize`, then `tools/list`) and sum
 * `JSON.stringify(inputSchema).length` over the sixteen tools. That gives
 * 15,284 characters of schema — 8,875 of them field descriptions — against
 * 6,402 characters of tool description. The schemas were 2.4x the prose, and
 * JSON tokenizes worse than prose, so in tokens the gap was wider still. A
 * large share of those descriptions restated a keyword sitting in the same
 * object (`default: 1` spelled out again as "default: 1") or repeated a
 * sentence the tool's own description already carried.
 *
 * Measure the CURRENT number the same way, or by importing `src/server.ts` and
 * calling the sanitized `tools/list` handler as `publishedTools()` below does.
 * The two agree — but `start.mjs` runs the BUILT `server.bundle.mjs`, so a
 * handshake without a rebuild first measures whatever was last bundled and
 * shows source edits having no effect. That mistake is why an earlier draft of
 * this preamble claimed 14,181: it came from a tree with only some of the
 * pending edits reverted, and nobody could reproduce it.
 *
 * A ceiling alone would be satisfied by deleting descriptions, so the first
 * block asserts the opposite invariant: every property, at every nesting
 * depth, keeps a non-empty description. A field with no description is a field
 * the model guesses at, and that is a worse trade than the bytes it saves.
 */

import { describe, expect, test } from "vitest";

import { server } from "../../src/server.js";

/**
 * The schemas as they go out on the wire.
 *
 * Read from the low-level request-handler map rather than through a connected
 * client: importing `src/server.ts` already runs `main()`, which connects the
 * stdio transport, and an McpServer accepts one connection. Reaching for the
 * installed `tools/list` handler is the same move
 * `installStrictClientSchemaCompat` makes in `src/server.ts` — and it is that
 * wrapper's output we want, since the sanitizer is where `$schema` and
 * `additionalProperties` are dropped.
 */
async function publishedTools(): Promise<Array<{ name: string; inputSchema: Record<string, unknown> }>> {
  const low = server.server as unknown as {
    _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
  };
  const handler = low._requestHandlers.get("tools/list");
  expect(typeof handler, "the SDK installs a tools/list handler").toBe("function");
  const result = (await handler!(
    { method: "tools/list", params: {} },
    { signal: new AbortController().signal },
  )) as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
  return result.tools;
}

const size = (schema: unknown) => JSON.stringify(schema).length;

/**
 * Per-tool ceilings, in characters of `JSON.stringify(inputSchema)`.
 *
 * Two derivations, because two different things are being pinned.
 *
 * The four execution tools were cut deliberately, so their ceilings sit at
 * what they measure now with a few characters of slack: the work is finished
 * and the number is the result.
 *
 * Every other tool is pinned at `f74f5b0 - 52` — what it shipped at the
 * baseline commit, less the `$schema` key the sanitizer now strips from all
 * sixteen (51 characters for `"$schema":"…draft-07/schema#"`, plus the comma
 * that separated it). That is a ceiling nobody has to reverse-engineer, and it
 * deliberately does NOT pin a tool at a snapshot of someone's in-progress
 * cutting: it says only that no schema may grow past what the last release
 * shipped. An earlier draft of this table pinned `ctx_search` at 730 from a
 * mid-edit reading and failed the very agent who was shrinking it.
 *
 * Raising a number is allowed — it just has to be a deliberate edit with a
 * reason, which is the whole point: a padded description should cost someone a
 * decision, not slip in unnoticed. Lowering one as a tool is finished is
 * better still.
 */
const BUDGETS: Record<string, number> = {
  // Cut in this pass — every ceiling is the measured result plus a little
  // slack, so a real new parameter fits but padding does not. The number in
  // the comment is what the tool shipped at f74f5b0, before the cut.
  ctx_batch_execute: 1_550,   // 2,190 at f74f5b0
  ctx_execute: 1_360,         // 1,809
  ctx_gather: 1_060,          // 1,126
  ctx_execute_file: 820,      // 891

  ctx_fetch_and_index: 1_000, // 1,446
  ctx_graph: 1_520,           // 1,678
  ctx_index: 1_400,           // 1,577
  ctx_search: 850,            // 1,031
  ctx_read: 640,              // 811
  ctx_find: 670,              // 733
  ctx_pack: 370,              // 438

  // Never cut. ctx_purge is the one destructive tool, and ADR-0002 records
  // that its heavy framing was validated empirically — Probe 4 measured
  // parameter fidelity at 5/5 against 3/5 on Haiku without it. Its ceiling is
  // what f74f5b0 shipped less the 52-char $schema, and it is a ceiling, not a
  // target: nobody trims the delete tool to save bytes.
  ctx_purge: 1_162,           // 1,214

  // The four argument-less diagnostics: `{"type":"object","properties":{}}`
  // and nothing else, once $schema is stripped. If one of these grows it has
  // gained a parameter, and that deserves to be noticed.
  ctx_stats: 33,              // 85
  ctx_doctor: 33,             // 85
  ctx_upgrade: 33,            // 85
  ctx_insight: 33,            // 85
};

describe("every published property is described", () => {
  test("no property, at any depth, ships without a description", async () => {
    const tools = await publishedTools();
    const missing: string[] = [];

    const walk = (node: unknown, tool: string, path: string): void => {
      if (!node || typeof node !== "object") return;
      const obj = node as Record<string, unknown>;
      const props = obj.properties as Record<string, Record<string, unknown>> | undefined;
      if (props && typeof props === "object") {
        for (const [key, value] of Object.entries(props)) {
          const here = path ? `${path}.${key}` : key;
          const description = value?.description;
          if (typeof description !== "string" || description.trim() === "") {
            missing.push(`${tool}:${here}`);
          }
          walk(value, tool, here);
        }
      }
      if (obj.items) walk(obj.items, tool, `${path}[]`);
      for (const branch of ["anyOf", "oneOf", "allOf"]) {
        const arm = obj[branch];
        if (Array.isArray(arm)) for (const n of arm) walk(n, tool, path);
      }
    };

    for (const tool of tools) walk(tool.inputSchema, tool.name, "");

    expect(
      missing,
      "shrinking a schema by deleting a description trades bytes for a field the model guesses at",
    ).toEqual([]);
  });
});

describe("schema byte ceilings", () => {
  test("every registered tool has a budget, and every budget a tool", async () => {
    const tools = await publishedTools();
    expect(new Set(tools.map((t) => t.name))).toEqual(new Set(Object.keys(BUDGETS)));
  });

  test("each tool's schema fits its budget", async () => {
    const tools = await publishedTools();
    for (const tool of tools) {
      const budget = BUDGETS[tool.name];
      expect(
        size(tool.inputSchema),
        `${tool.name} inputSchema exceeds its ${budget}-character budget. ` +
          "Cut redundancy — prose restating a `default`/`enum`/`min`/`max` sitting beside it, " +
          "or a sentence the tool's own description already carries — or raise the budget " +
          "in this file with a reason.",
      ).toBeLessThanOrEqual(budget);
    }
  });

  test("the sixteen schemas together stay under 13 KB", async () => {
    // 15,284 characters at f74f5b0. Per-tool budgets alone would let every
    // tool creep to its own ceiling at once — they sum to 13,434 — so this
    // pins the number that actually reaches the model on every request, and is
    // set below that sum so it genuinely binds. The measured total once every
    // tool in this pass was finished is 12,359 — reproduce it with `npm run
    // bundle` then a handshake, per the preamble. An earlier draft of this
    // comment said 12,201, taken mid-pass while two retrieval tools were still
    // being cut; it was never reproducible and is the same mistake the
    // preamble already documents.
    //
    // No companion ratio assertion (schema bytes vs description bytes),
    // tempting as it is: it would fail whenever the tool prose is legitimately
    // cut, which is the opposite of what this file wants to encourage. The
    // ratio — 2.4x at the baseline — belongs in the preamble as a reason, not
    // in an assertion as a trap.
    const tools = await publishedTools();
    const total = tools.reduce((sum, t) => sum + size(t.inputSchema), 0);
    expect(total).toBeLessThanOrEqual(13_000);
  });
});

describe("the sanitizer's strips reach the wire", () => {
  test("no schema carries `$schema` — the SDK stamps it, no MCP host reads it", async () => {
    // 51 characters ("$schema":"http://json-schema.org/draft-07/schema#") plus
    // a separator, on every tool, in every session. It names the dialect the
    // document is written in; it constrains no argument.
    const tools = await publishedTools();
    for (const tool of tools) {
      expect(tool.inputSchema, `${tool.name}`).not.toHaveProperty("$schema");
      expect(JSON.stringify(tool.inputSchema)).not.toContain("$schema");
    }
  });

  test("no schema carries `additionalProperties` — Zod validates args server-side", async () => {
    const tools = await publishedTools();
    for (const tool of tools) {
      expect(JSON.stringify(tool.inputSchema)).not.toContain("additionalProperties");
    }
  });
});
