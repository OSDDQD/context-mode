/**
 * Hybrid fusion is wired to the batch path that actually reaches cold
 * knowledge — `query_scope: "global"` — and deliberately NOT to `"batch"`,
 * where the queries run against output the caller just produced.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentStore } from "../../src/store.js";
import { formatBatchQueryResults } from "../../src/server.js";

let dir: string;
let store: ContentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ctx-batch-hybrid-"));
  store = new ContentStore(join(dir, "content.db"));
  store.index({
    content: "# Deploy failures\n\nThe build step exits 137 when the runner runs out of memory.",
    source: "batch:deploy notes",
  });
});

afterEach(() => {
  try { store.cleanup(); } catch { /* already gone */ }
  rmSync(dir, { recursive: true, force: true });
});

describe("formatBatchQueryResults", () => {
  test("batch scope keeps the batch-local tip", async () => {
    const lines = await formatBatchQueryResults(store, ["exits 137"], "batch:deploy notes");
    expect(lines.join("\n")).toContain("scoped to this batch only");
  });

  test("global scope notes the wider scope", async () => {
    const lines = await formatBatchQueryResults(store, ["exits 137"], "batch:deploy notes", undefined, "global");
    expect(lines.join("\n")).toContain("entire persistent index");
  });

  test("global scope returns lexical results unchanged when embeddings are off", async () => {
    delete process.env.CONTEXT_MODE_EMBEDDINGS_URL;
    const lines = await formatBatchQueryResults(store, ["exits 137"], "batch:deploy notes", undefined, "global");
    expect(lines.join("\n")).toContain("Deploy failures");
  });

  test("an unreachable embedding endpoint degrades to lexical instead of failing", async () => {
    process.env.CONTEXT_MODE_EMBEDDINGS_URL = "http://127.0.0.1:1/v1/embeddings";
    process.env.CONTEXT_MODE_EMBEDDINGS_MODEL = "does-not-exist";
    process.env.CONTEXT_MODE_EMBEDDINGS_TIMEOUT_MS = "50";
    try {
      const lines = await formatBatchQueryResults(store, ["exits 137"], "batch:deploy notes", undefined, "global");
      expect(lines.join("\n")).toContain("Deploy failures");
    } finally {
      delete process.env.CONTEXT_MODE_EMBEDDINGS_URL;
      delete process.env.CONTEXT_MODE_EMBEDDINGS_MODEL;
      delete process.env.CONTEXT_MODE_EMBEDDINGS_TIMEOUT_MS;
    }
  });
});
