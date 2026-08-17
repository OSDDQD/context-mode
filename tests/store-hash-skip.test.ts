/**
 * Content-hash index cache (ADR-0007).
 *
 * Re-indexing was unconditional even though `content_hash` was already written
 * — the column existed only for staleness detection. The write path now
 * consults it, which buys more than the FTS5 work avoided: chunk rowids
 * survive, and `chunk_vectors` is keyed on `chunks.rowid`, so every re-index of
 * an unchanged file used to orphan its embeddings.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentStore } from "../src/store.js";
import { pruneOrphanVectors, ensureVectorTable, type HybridDb } from "../src/search/hybrid.js";

let dir: string;
let store: ContentStore;

// Three sections, so the source owns several rowids — with one chunk in a
// fresh table SQLite hands the same rowid back after a delete and the
// difference between "kept" and "rewritten" is invisible.
const DOC = [
  "# Retry policy\n\nThe client retries three times with backoff.",
  "# Timeouts\n\nEach attempt gets its own deadline.",
  "# Circuit breaker\n\nFive consecutive failures open the breaker.",
].join("\n\n");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ctx-hash-skip-"));
  store = new ContentStore(join(dir, "content.db"));
});

afterEach(() => {
  try { store.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CONTEXT_MODE_INDEX_HASH_SKIP;
  delete process.env.CONTEXT_MODE_INDEX_HASH_SKIP_REATTRIBUTE;
});

/** Rowids of every chunk currently stored, in order. */
function rowids(): number[] {
  return (store.rawDb().prepare("SELECT rowid FROM chunks ORDER BY rowid").all() as Array<{ rowid: number }>)
    .map(r => r.rowid);
}

describe("content-hash index cache", () => {
  test("identical content is not rewritten, and says so", () => {
    const first = store.index({ content: DOC, source: "notes" });
    expect(first.skipped).toBeUndefined();

    const second = store.index({ content: DOC, source: "notes" });
    expect(second.skipped).toBe(true);
    expect(second.totalChunks).toBe(first.totalChunks);
    expect(second.codeChunks).toBe(first.codeChunks);
  });

  /**
   * `notes` first, then an anchor source that keeps the high rowids. A rewrite
   * of `notes` then cannot reuse its old rowids, which is what makes the
   * difference between skipping and rewriting observable.
   */
  function indexTwoSources(): void {
    store.index({ content: DOC, source: "notes" });
    store.index({ content: "# Keep\n\nAnchor section that is never re-indexed.", source: "anchor" });
  }

  test("chunk rowids survive a skip — so the embeddings do too", () => {
    indexTwoSources();
    const before = rowids();
    store.index({ content: DOC, source: "notes" });
    expect(rowids()).toEqual(before);
  });

  test("vectors are not orphaned by a repeat index", () => {
    indexTwoSources();
    const db = store.rawDb() as unknown as HybridDb;
    ensureVectorTable(db);
    for (const rowid of rowids()) {
      db.prepare("INSERT INTO chunk_vectors (chunk_rowid, model, dim, vec) VALUES (?, 'test', 4, ?)")
        .run(rowid, Buffer.from([1, 2, 3, 4]));
    }
    store.index({ content: DOC, source: "notes" });
    expect(pruneOrphanVectors(db)).toBe(0);
  });

  test("without the cache, the same repeat index orphans every one of them", () => {
    indexTwoSources();
    const db = store.rawDb() as unknown as HybridDb;
    ensureVectorTable(db);
    for (const rowid of rowids()) {
      db.prepare("INSERT INTO chunk_vectors (chunk_rowid, model, dim, vec) VALUES (?, 'test', 4, ?)")
        .run(rowid, Buffer.from([1, 2, 3, 4]));
    }
    process.env.CONTEXT_MODE_INDEX_HASH_SKIP = "0";
    store.index({ content: DOC, source: "notes" });
    expect(pruneOrphanVectors(db)).toBeGreaterThan(0);
  });

  test("changed content is indexed, and the result is searchable", () => {
    store.index({ content: DOC, source: "notes" });
    const changed = store.index({
      content: "# Retry policy\n\nThe client now retries seven times with jitter.",
      source: "notes",
    });
    expect(changed.skipped).toBeUndefined();
    expect(store.search("jitter", 3).length).toBeGreaterThan(0);
  });

  test("the cache is not file-only — a repeated command capture is skipped too", () => {
    const output = "$ git status\nOn branch main\nnothing to commit";
    store.index({ content: output, source: "batch:git status" });
    expect(store.index({ content: output, source: "batch:git status" }).skipped).toBe(true);
  });

  test("a label that moved to a different file is a different source", () => {
    const a = join(dir, "a.md");
    const b = join(dir, "b.md");
    writeFileSync(a, DOC);
    writeFileSync(b, DOC);
    store.index({ path: a, source: "doc" });
    // Same bytes, different file — must not be treated as unchanged.
    expect(store.index({ path: b, source: "doc" }).skipped).toBeUndefined();
    expect(store.getSourceMeta("doc")?.filePath).toBe(b);
  });

  test("a legacy row with no hash is re-indexed once, then cached", () => {
    store.index({ content: DOC, source: "legacy" });
    store.rawDb().prepare("UPDATE sources SET content_hash = NULL WHERE label = 'legacy'").run();

    expect(store.index({ content: DOC, source: "legacy" }).skipped).toBeUndefined();
    expect(store.index({ content: DOC, source: "legacy" }).skipped).toBe(true);
  });

  test("a skip moves indexed_at forward so search stops re-reading the file", () => {
    const file = join(dir, "doc.md");
    writeFileSync(file, DOC);
    store.index({ path: file, source: "doc" });

    // Backdate the row, then re-index the same bytes.
    store.rawDb().prepare(
      "UPDATE sources SET indexed_at = '2000-01-01 00:00:00' WHERE label = 'doc'",
    ).run();
    const stale = store.getSourceMeta("doc")!.indexedAt;
    store.index({ path: file, source: "doc" });
    expect(store.getSourceMeta("doc")!.indexedAt).not.toBe(stale);
  });

  test("an mtime touch without a content change stops costing a re-read", () => {
    const file = join(dir, "doc.md");
    writeFileSync(file, DOC);
    store.index({ path: file, source: "doc" });
    store.rawDb().prepare(
      "UPDATE sources SET indexed_at = '2000-01-01 00:00:00' WHERE label = 'doc'",
    ).run();
    const future = Date.now() / 1000 + 60;
    utimesSync(file, future, future);

    // First search sees the advanced mtime, re-reads, finds the same hash.
    store.searchWithFallback("retries", 3);
    expect(store.lastRefreshCount).toBe(0);
    // And has moved indexed_at forward, so nothing is re-read next time.
    expect(store.getSourceMeta("doc")!.indexedAt).not.toBe("2000-01-01 00:00:00");
  });

  test("CONTEXT_MODE_INDEX_HASH_SKIP=0 restores unconditional rewriting", () => {
    store.index({ content: DOC, source: "notes", attribution: { sessionId: "s1" } });
    process.env.CONTEXT_MODE_INDEX_HASH_SKIP = "0";
    const again = store.index({ content: DOC, source: "notes", attribution: { sessionId: "s2" } });
    expect(again.skipped).toBeUndefined();
    // The rewrite is observable: the chunks now carry the second session.
    const sessions = (store.rawDb()
      .prepare("SELECT DISTINCT session_id AS s FROM chunks")
      .all() as Array<{ s: string }>).map(r => r.s);
    expect(sessions).toEqual(["s2"]);
  });

  test("CONTEXT_MODE_INDEX_HASH_SKIP_REATTRIBUTE=1 rewrites so attribution follows the session", () => {
    store.index({ content: DOC, source: "notes", attribution: { sessionId: "s1" } });
    process.env.CONTEXT_MODE_INDEX_HASH_SKIP_REATTRIBUTE = "1";
    store.index({ content: DOC, source: "notes", attribution: { sessionId: "s2" } });
    const sessions = (store.rawDb()
      .prepare("SELECT DISTINCT session_id AS s FROM chunks")
      .all() as Array<{ s: string }>).map(r => r.s);
    expect(sessions).toEqual(["s2"]);
  });
});
