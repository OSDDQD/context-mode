/**
 * Stale Detection — Hash-based auto-refresh for file-backed sources.
 *
 * When files are indexed via ctx_index(path), the store records a SHA-256
 * content_hash and file_path in the sources table. On ctx_search(), if a
 * file-backed source's file has changed (mtime > indexed_at, then hash
 * differs), the store auto re-indexes the file and returns fresh results.
 *
 * TDD RED phase: these tests define the contract BEFORE implementation.
 * They should FAIL until the feature is built.
 */

import { describe, test, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContentStore } from "../src/store.js";

// ── Helpers ──

function createStore(): ContentStore {
  const path = join(
    tmpdir(),
    `context-mode-stale-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  return new ContentStore(path);
}

function tmpFile(name?: string): string {
  return join(
    tmpdir(),
    name ?? `stale-test-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
  );
}

// Track temp files for cleanup
const tempFiles: string[] = [];
const tempStores: ContentStore[] = [];

afterEach(() => {
  for (const store of tempStores) {
    try { store.cleanup(); } catch { /* ignore */ }
  }
  tempStores.length = 0;

  for (const file of tempFiles) {
    try { if (existsSync(file)) unlinkSync(file); } catch { /* ignore */ }
  }
  tempFiles.length = 0;
});

// ── Tests ──

describe("Hash-based stale detection", () => {
  test("index a file, search returns results without stale refresh note", () => {
    const store = createStore();
    tempStores.push(store);

    // Create a temp file with known content
    const filePath = tmpFile();
    tempFiles.push(filePath);
    writeFileSync(filePath, "# Database Guide\n\nPostgreSQL connection pooling best practices for production workloads.");

    // Index the file via path
    const indexResult = store.index({ path: filePath, source: filePath });
    expect(indexResult.totalChunks).toBeGreaterThan(0);
    expect(indexResult.label).toBe(filePath);

    // Search for content — should find it without any stale refresh
    const results = store.search("PostgreSQL connection pooling", 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("PostgreSQL");

    // The source should have a content_hash stored (new column)
    const meta = store.getSourceMeta(filePath);
    expect(meta).not.toBeNull();
    expect(meta!.label).toBe(filePath);
    // content_hash should be a 64-char hex SHA-256 string
    expect((meta as any).contentHash).toMatch(/^[a-f0-9]{64}$/);
    // file_path should be stored
    expect((meta as any).filePath).toBe(filePath);
  });

  test("index a file, modify it, search auto-refreshes and returns new content", () => {
    const store = createStore();
    tempStores.push(store);

    // Create a temp file with original content
    const filePath = tmpFile();
    tempFiles.push(filePath);
    writeFileSync(filePath, "# Original Guide\n\nOriginal content about databases and SQL queries.");

    // Index the file
    store.index({ path: filePath, source: filePath });

    // Verify original content is searchable
    const originalResults = store.search("databases SQL queries", 3);
    expect(originalResults.length).toBeGreaterThan(0);

    // Overwrite the file with completely different content
    // Use a small delay to ensure mtime changes (filesystem resolution)
    const mtimeBefore = require("fs").statSync(filePath).mtimeMs;
    writeFileSync(filePath, "# Updated Guide\n\nUpdated content about REST APIs and GraphQL endpoints.");
    const mtimeAfter = require("fs").statSync(filePath).mtimeMs;
    // If mtime didn't change (rare on fast FS), force it forward
    if (mtimeAfter <= mtimeBefore) {
      const futureTime = Date.now() + 2000;
      require("fs").utimesSync(filePath, futureTime / 1000, futureTime / 1000);
    }

    // Search for NEW content — should auto-detect stale file and re-index
    const refreshedResults = store.searchWithFallback("REST APIs GraphQL endpoints", 3);
    expect(refreshedResults.length).toBeGreaterThan(0);
    expect(refreshedResults[0].content).toContain("APIs");

    // The old content should no longer be found (replaced by re-index)
    const staleResults = store.search("databases SQL queries", 3);
    expect(staleResults.length).toBe(0);

    // Verify metadata shows the refresh happened
    const meta = store.getSourceMeta(filePath);
    expect(meta).not.toBeNull();
    // content_hash should now match the new file content
    const crypto = require("crypto");
    const expectedHash = crypto
      .createHash("sha256")
      .update("# Updated Guide\n\nUpdated content about REST APIs and GraphQL endpoints.")
      .digest("hex");
    expect((meta as any).contentHash).toBe(expectedHash);
  });

  test("index content without path, search never triggers stale check", () => {
    const store = createStore();
    tempStores.push(store);

    // Index with content string only (no file path)
    const indexResult = store.index({
      content: "# In-Memory Guide\n\nRedis caching strategies for session management.",
      source: "redis-guide",
    });
    expect(indexResult.totalChunks).toBeGreaterThan(0);

    // Search — should work normally
    const results = store.search("Redis caching strategies", 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("Redis");

    // No file_path: stale detection only ever applies to file-backed sources,
    // and #refreshStaleSources selects on `file_path IS NOT NULL`.
    //
    // A content_hash IS recorded, though — since ADR-0007 it is what lets a
    // repeated command capture skip its rewrite, and command captures are most
    // of what this store holds.
    const meta = store.getSourceMeta("redis-guide");
    expect(meta).not.toBeNull();
    expect((meta as any).filePath).toBeNull();
    expect((meta as any).contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("index a file, delete it, search returns results without crashing", () => {
    const store = createStore();
    tempStores.push(store);

    // Create and index a temp file
    const filePath = tmpFile();
    tempFiles.push(filePath);
    writeFileSync(filePath, "# Kubernetes Guide\n\nPod scheduling and resource limits configuration.");

    store.index({ path: filePath, source: filePath });

    // Verify it was indexed
    const beforeResults = store.search("Kubernetes Pod scheduling", 3);
    expect(beforeResults.length).toBeGreaterThan(0);

    // Delete the file
    unlinkSync(filePath);
    expect(existsSync(filePath)).toBe(false);

    // Search should still work — return cached results from index, no crash
    // The file is gone so stale check should gracefully skip re-indexing
    const afterResults = store.search("Kubernetes Pod scheduling", 3);
    expect(afterResults.length).toBeGreaterThan(0);
    expect(afterResults[0].content).toContain("Kubernetes");

    // Source metadata should still exist
    const meta = store.getSourceMeta(filePath);
    expect(meta).not.toBeNull();
  });
});

// ── Sweep throttle ──

/**
 * Push the file's mtime safely past the source's indexed_at, whatever the
 * filesystem's timestamp resolution is. The sweep gates on mtime before it
 * ever hashes, so without this a fast rewrite can land in the same second as
 * the index and read as unchanged.
 */
function touchFuture(path: string): void {
  const futureSeconds = (Date.now() + 2000) / 1000;
  utimesSync(path, futureSeconds, futureSeconds);
}

describe("Stale sweep throttle", () => {
  afterEach(() => {
    delete process.env.CONTEXT_MODE_STALE_REFRESH_MS;
  });

  test("a second search inside the window does not walk the sources again", () => {
    const store = createStore();
    tempStores.push(store);

    const filePath = tmpFile();
    tempFiles.push(filePath);
    writeFileSync(filePath, "# Alpha\n\nOriginal notes about zeppelin navigation charts.");
    store.index({ path: filePath, source: filePath });

    // First search pays for the walk.
    store.searchWithFallback("zeppelin navigation charts", 3);
    expect(store.staleSweeps).toBe(1);

    writeFileSync(filePath, "# Beta\n\nRewritten notes about submarine sonar bearings.");
    touchFuture(filePath);

    // Second search inside the default 3s window: no statSync walk at all, so
    // the edit is deliberately not seen yet. That staleness bound is the
    // tradeoff the throttle buys.
    const during = store.searchWithFallback("submarine sonar bearings", 3);
    expect(store.staleSweeps).toBe(1);
    expect(during.length).toBe(0);

    // The explicit bypass makes the very next search walk again.
    store.invalidateStaleSweep();
    const after = store.searchWithFallback("submarine sonar bearings", 3);
    expect(store.staleSweeps).toBe(2);
    expect(after.length).toBeGreaterThan(0);
    expect(after[0].content).toContain("sonar");
  });

  test("CONTEXT_MODE_STALE_REFRESH_MS=0 restores one walk per search", () => {
    process.env.CONTEXT_MODE_STALE_REFRESH_MS = "0";

    const store = createStore();
    tempStores.push(store);

    const filePath = tmpFile();
    tempFiles.push(filePath);
    writeFileSync(filePath, "# Alpha\n\nOriginal notes about tectonic drift models.");
    store.index({ path: filePath, source: filePath });

    store.searchWithFallback("tectonic drift models", 3);
    expect(store.staleSweeps).toBe(1);

    writeFileSync(filePath, "# Beta\n\nRewritten notes about glacier calving rates.");
    touchFuture(filePath);

    const after = store.searchWithFallback("glacier calving rates", 3);
    expect(store.staleSweeps).toBe(2);
    expect(after.length).toBeGreaterThan(0);
  });

  test("once the window elapses the next search walks again", async () => {
    process.env.CONTEXT_MODE_STALE_REFRESH_MS = "5";

    const store = createStore();
    tempStores.push(store);

    const filePath = tmpFile();
    tempFiles.push(filePath);
    writeFileSync(filePath, "# Alpha\n\nOriginal notes about kiln firing schedules.");
    store.index({ path: filePath, source: filePath });

    store.searchWithFallback("kiln firing schedules", 3);
    expect(store.staleSweeps).toBe(1);

    writeFileSync(filePath, "# Beta\n\nRewritten notes about lathe tolerance grinding.");
    touchFuture(filePath);

    await new Promise((resolve) => setTimeout(resolve, 25));

    const after = store.searchWithFallback("lathe tolerance grinding", 3);
    expect(store.staleSweeps).toBe(2);
    expect(after.length).toBeGreaterThan(0);
  });
});
