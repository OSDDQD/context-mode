/**
 * `deleteSource` exists for the code index: a file deleted on disk must stop
 * answering searches immediately. "Wait for the 14-day staleness sweep" is not
 * an answer when the agent is acting on the result today.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentStore } from "../../src/store.js";

let dir: string;
let store: ContentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ctx-delete-source-"));
  store = new ContentStore(join(dir, "content.db"));
});

afterEach(() => {
  try { store.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

describe("ContentStore.deleteSource", () => {
  test("removes the source and its chunks, leaving the others intact", () => {
    store.indexPlainText("retry with exponential backoff", "code:src/retry.ts");
    store.indexPlainText("cache invalidation strategy", "code:src/cache.ts");

    expect(store.search("backoff", 5).length).toBeGreaterThan(0);

    expect(store.deleteSource("code:src/retry.ts")).toBe(1);

    expect(store.search("backoff", 5)).toHaveLength(0);
    expect(store.search("invalidation", 5).length).toBeGreaterThan(0);
    expect(store.listSources().map(s => s.label)).toEqual(["code:src/cache.ts"]);
  });

  test("deleting an unknown label is a no-op, not an error", () => {
    expect(store.deleteSource("code:never-existed.ts")).toBe(0);
  });
});
