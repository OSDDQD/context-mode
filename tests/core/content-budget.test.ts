/**
 * Disk accounting and LRU eviction for the content stores.
 *
 * Eviction deletes another project's knowledge base, so what matters here is
 * mostly what it refuses to touch: the caller's own store, anything with a live
 * WAL behind it, and anything used recently.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentStoreUsage, enforceContentBudget, ContentStore } from "../../src/store.js";

let dir: string;

const HOUR = 3600_000;
const KB = 1024;

/** A store on disk: `<name>.db` plus optional sidecars, aged as asked. */
function makeStore(name: string, opts: {
  dbBytes: number;
  walBytes?: number;
  shmBytes?: number;
  ageMs?: number;
}): string {
  const dbPath = join(dir, `${name}.db`);
  const age = (Date.now() - (opts.ageMs ?? 0)) / 1000;
  writeFileSync(dbPath, "x".repeat(opts.dbBytes));
  utimesSync(dbPath, age, age);
  if (opts.walBytes) {
    writeFileSync(dbPath + "-wal", "w".repeat(opts.walBytes));
    utimesSync(dbPath + "-wal", age, age);
  }
  if (opts.shmBytes) {
    writeFileSync(dbPath + "-shm", "s".repeat(opts.shmBytes));
    utimesSync(dbPath + "-shm", age, age);
  }
  return dbPath;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ctx-content-budget-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("contentStoreUsage", () => {
  test("counts the sidecars, not just the .db", () => {
    makeStore("a", { dbBytes: 10 * KB, walBytes: 4 * KB, shmBytes: KB });
    const usage = contentStoreUsage(dir);
    expect(usage.stores).toHaveLength(1);
    expect(usage.totalBytes).toBe(15 * KB);
    expect(usage.walBytes).toBe(4 * KB);
  });

  test("lastUseMs follows the newest of the three files", () => {
    const db = makeStore("a", { dbBytes: KB, ageMs: 10 * HOUR });
    const fresh = Date.now() / 1000;
    writeFileSync(db + "-wal", "w");
    utimesSync(db + "-wal", fresh, fresh);
    const [store] = contentStoreUsage(dir).stores;
    expect(Date.now() - store.lastUseMs).toBeLessThan(60_000);
  });

  test("a missing directory is zero, not a throw", () => {
    const usage = contentStoreUsage(join(dir, "nope"));
    expect(usage.totalBytes).toBe(0);
    expect(usage.stores).toEqual([]);
  });
});

describe("enforceContentBudget", () => {
  test("under budget evicts nothing and does not even sort", () => {
    makeStore("a", { dbBytes: 10 * KB, ageMs: 100 * HOUR });
    const r = enforceContentBudget({ contentDir: dir, budgetBytes: 1024 * KB });
    expect(r.evicted).toEqual([]);
    expect(r.totalBytes).toBe(10 * KB);
  });

  test("evicts least-recently-used first, down to 90% of budget", () => {
    makeStore("old", { dbBytes: 40 * KB, ageMs: 300 * HOUR });
    makeStore("older", { dbBytes: 40 * KB, ageMs: 500 * HOUR });
    makeStore("recent", { dbBytes: 40 * KB, ageMs: 100 * HOUR });

    const r = enforceContentBudget({ contentDir: dir, budgetBytes: 100 * KB });
    // 120 KB → target 90 KB: one eviction is enough, and it is the oldest.
    expect(r.evicted).toEqual([join(dir, "older.db")]);
    expect(existsSync(join(dir, "older.db"))).toBe(false);
    expect(existsSync(join(dir, "old.db"))).toBe(true);
  });

  test("the caller's own store is never evicted, however old", () => {
    const own = makeStore("own", { dbBytes: 200 * KB, ageMs: 1000 * HOUR });
    const r = enforceContentBudget({
      contentDir: dir,
      protectPaths: [own],
      budgetBytes: 10 * KB,
    });
    expect(r.evicted).toEqual([]);
    expect(existsSync(own)).toBe(true);
  });

  test("a live non-empty WAL protects a store — another process is writing", () => {
    makeStore("busy", { dbBytes: 200 * KB, walBytes: 8 * KB, ageMs: 1000 * HOUR });
    const r = enforceContentBudget({ contentDir: dir, budgetBytes: 10 * KB });
    expect(r.evicted).toEqual([]);
    expect(existsSync(join(dir, "busy.db"))).toBe(true);
  });

  test("stores used inside minAgeMs are off limits", () => {
    makeStore("fresh", { dbBytes: 200 * KB, ageMs: 1 * HOUR });
    const r = enforceContentBudget({
      contentDir: dir,
      budgetBytes: 10 * KB,
      minAgeMs: 48 * HOUR,
    });
    expect(r.evicted).toEqual([]);
  });

  test("dry run reports the same decision without deleting anything", () => {
    const victim = makeStore("victim", { dbBytes: 200 * KB, ageMs: 1000 * HOUR });
    const r = enforceContentBudget({ contentDir: dir, budgetBytes: 10 * KB, dryRun: true });
    expect(r.evicted).toEqual([victim]);
    expect(r.dryRun).toBe(true);
    expect(existsSync(victim)).toBe(true);
  });

  test("eviction takes the sidecars with it", () => {
    const victim = makeStore("victim", { dbBytes: 200 * KB, shmBytes: 4 * KB, ageMs: 1000 * HOUR });
    enforceContentBudget({ contentDir: dir, budgetBytes: 10 * KB });
    expect(existsSync(victim)).toBe(false);
    expect(existsSync(victim + "-shm")).toBe(false);
  });

  test("freedBytes counts what was actually reclaimed", () => {
    makeStore("a", { dbBytes: 100 * KB, shmBytes: 4 * KB, ageMs: 1000 * HOUR });
    const r = enforceContentBudget({ contentDir: dir, budgetBytes: 10 * KB });
    expect(r.freedBytes).toBe(104 * KB);
  });

  test("an empty directory is a no-op", () => {
    const r = enforceContentBudget({ contentDir: dir, budgetBytes: 1 });
    expect(r).toMatchObject({ totalBytes: 0, evicted: [], freedBytes: 0 });
  });
});

describe("ContentStore.compact", () => {
  test("skips the vacuum when there is nothing worth reclaiming", () => {
    const store = new ContentStore(join(dir, "small.db"));
    store.index({ content: "# Tiny\n\nA couple of words.", source: "probe" });
    expect(store.compact()).toBe(0);
    store.close();
  });

  test("reclaims space after a large delete", () => {
    const store = new ContentStore(join(dir, "big.db"));
    const body = Array.from({ length: 400 }, (_, i) =>
      `# Section ${i}\n\n${"filler text for the section body. ".repeat(40)}`).join("\n\n");
    store.index({ content: body, source: "bulk" });
    store.deleteSource?.("bulk");
    const reclaimed = store.compact();
    expect(reclaimed).toBeGreaterThan(0);
    store.close();
  });

  test("CONTEXT_MODE_VACUUM_MAX_BYTES=1 refuses to vacuum anything", () => {
    const store = new ContentStore(join(dir, "capped.db"));
    const body = Array.from({ length: 400 }, (_, i) =>
      `# Section ${i}\n\n${"filler text for the section body. ".repeat(40)}`).join("\n\n");
    store.index({ content: body, source: "bulk" });
    store.deleteSource?.("bulk");
    process.env.CONTEXT_MODE_VACUUM_MAX_BYTES = "1";
    try {
      expect(store.compact()).toBe(0);
    } finally {
      delete process.env.CONTEXT_MODE_VACUUM_MAX_BYTES;
      store.close();
    }
  });
});
