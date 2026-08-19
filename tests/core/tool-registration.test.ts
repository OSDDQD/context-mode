/**
 * The fifteen tools, in the order they register.
 *
 * This is the acceptance harness for splitting `src/server.ts` apart. Moving a
 * handler into its own module is only safe if the same tools still register,
 * with the same names, in the same order — MCP hosts render the tool list in
 * registration order, and a host that caches tool schemas keys off the name.
 *
 * It also catches the subtler failure: a module extracted with a side effect at
 * import time that never runs because nothing imports it, so its tool quietly
 * vanishes from the list.
 */

import { describe, test, expect } from "vitest";
import { REGISTERED_CTX_TOOLS } from "../../src/server.js";
import { serverSource } from "../shared/server-source.js";

/** Registration order as shipped. Update only with a deliberate decision. */
const EXPECTED_ORDER = [
  "ctx_execute",
  "ctx_execute_file",
  "ctx_index",
  "ctx_search",
  // Fork additions, registered beside ctx_search: fused retrieval and the
  // structural index. Both self-disable on an env switch, so this list is the
  // shipped default rather than an invariant of the process.
  "ctx_find",
  "ctx_graph",
  // ctx_read: ctx_execute_file with the default program supplied, registered
  // beside the retrieval tools because that is the question it answers.
  "ctx_read",
  "ctx_fetch_and_index",
  "ctx_batch_execute",
  "ctx_gather",
  "ctx_stats",
  "ctx_doctor",
  "ctx_upgrade",
  "ctx_purge",
  "ctx_insight",
] as const;

describe("tool registration", () => {
  test("every tool registers, in the shipped order", () => {
    expect(REGISTERED_CTX_TOOLS.map(t => t.name)).toEqual([...EXPECTED_ORDER]);
  });

  test("fifteen tools — no more, no fewer", () => {
    expect(REGISTERED_CTX_TOOLS).toHaveLength(15);
  });

  test("each one carries a handler and a description", () => {
    for (const tool of REGISTERED_CTX_TOOLS) {
      expect(typeof tool.handler, `${tool.name} handler`).toBe("function");
      expect(String(tool.fullDescription ?? tool.config?.description ?? "").length,
        `${tool.name} description`).toBeGreaterThan(20);
    }
  });

  test("the source registers exactly these names, wherever it now lives", () => {
    // Guards the extraction directly: if a registerTool call moves to a file
    // that SERVER_SOURCE_FILES does not list, this count drops.
    const found = [...serverSource().matchAll(/registerTool\(\s*\n?\s*"(ctx_[a-z_]+)"/g)]
      .map(m => m[1]);
    expect(new Set(found)).toEqual(new Set(EXPECTED_ORDER));
  });
});
