/**
 * The freshness sweep is memoised — but only where memoising it cannot lie.
 *
 * `checkFreshness` is up to 5 000 `stat()` calls, paid on every SQL-backed
 * `ctx_graph` action, to produce one advisory line. Caching it is obvious; the
 * part worth testing is the three ways the cache must NOT answer: past its TTL
 * with no evidence, across a write to the index, and when the caller's own
 * change token says the tree moved.
 */

import { describe, test, expect, afterEach } from "vitest";
import { rmSync, utimesSync } from "node:fs";

import {
  checkFreshness,
  clearFreshnessCache,
  freshnessTtlMs,
  openGraphDb,
  type GraphDbHandle,
} from "../../src/graph/db.js";
import { makeGraphFixture, writeProjectFile, type Fixture } from "./fixture.js";

const open: Array<{ dir: string; handle: GraphDbHandle }> = [];

afterEach(() => {
  clearFreshnessCache();
  while (open.length) {
    const entry = open.pop()!;
    try { entry.handle.close(); } catch { /* already closed */ }
    try { rmSync(entry.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** A project with one indexed, existing, up-to-date file. */
function currentFixture(): { fx: Fixture; handle: GraphDbHandle; file: string } {
  const fx = makeGraphFixture({ files: { "src/a.ts": Date.now() + 60_000 } });
  const file = writeProjectFile(fx.projectDir, "src/a.ts");
  const res = openGraphDb(fx.projectDir);
  if (!res.ok) throw new Error(res.message);
  open.push({ dir: fx.projectDir, handle: res.handle });
  return { fx, handle: res.handle, file };
}

/** Make the working copy newer than its indexed_at, so a sweep sees lag. */
function makeStale(file: string): void {
  const future = new Date(Date.now() + 120_000);
  utimesSync(file, future, future);
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe("freshness TTL cache", () => {
  test("a second call inside the TTL reuses the first sweep", () => {
    const { handle, file } = currentFixture();
    expect(checkFreshness(handle)!.staleFiles).toBe(0);

    // The tree changed, but nothing told the cache so — inside the TTL the
    // previous answer stands. This is the whole point of the cache, and the
    // reason the TTL is seconds rather than minutes.
    makeStale(file);
    expect(checkFreshness(handle)!.staleFiles).toBe(0);

    // ttlMs: 0 is the documented way to demand a real sweep.
    expect(checkFreshness(handle, { ttlMs: 0 })!.staleFiles).toBe(1);
  });

  test("clearFreshnessCache forces the next call to sweep again", () => {
    const { handle, file } = currentFixture();
    expect(checkFreshness(handle)!.staleFiles).toBe(0);
    makeStale(file);
    clearFreshnessCache();
    expect(checkFreshness(handle)!.staleFiles).toBe(1);
  });

  test("an expired TTL sweeps again", async () => {
    const { handle, file } = currentFixture();
    expect(checkFreshness(handle, { ttlMs: 5 })!.staleFiles).toBe(0);
    makeStale(file);
    await sleep(20);
    expect(checkFreshness(handle, { ttlMs: 5 })!.staleFiles).toBe(1);
  });

  test("an unchanged revision keeps the answer valid past the TTL", async () => {
    const { handle, file } = currentFixture();
    expect(checkFreshness(handle, { ttlMs: 5, revision: "b1:e1" })!.staleFiles).toBe(0);
    makeStale(file);
    await sleep(20);

    // The fs-bus counters have not moved, so no file under the root changed as
    // far as the watcher is concerned — the expired TTL is irrelevant.
    expect(checkFreshness(handle, { ttlMs: 5, revision: "b1:e1" })!.staleFiles).toBe(0);
    // A moved counter is the one thing that beats the cache immediately.
    expect(checkFreshness(handle, { ttlMs: 60_000, revision: "b2:e9" })!.staleFiles).toBe(1);
  });

  test("a write to the index invalidates the cache regardless of TTL", () => {
    const { fx, handle, file } = currentFixture();
    expect(checkFreshness(handle, { ttlMs: 60_000 })!.staleFiles).toBe(0);
    makeStale(file);
    // The daemon re-indexed: the answer cannot be carried across that, even
    // with a minute of TTL left.
    const future = new Date(Date.now() + 5_000);
    utimesSync(fx.dbPath, future, future);
    expect(checkFreshness(handle, { ttlMs: 60_000 })!.staleFiles).toBe(1);
  });

  test("the cached report is copied out, so a caller cannot poison the next reader", () => {
    const { handle } = currentFixture();
    const first = checkFreshness(handle)!;
    first.staleFiles = 999;
    expect(checkFreshness(handle)!.staleFiles).toBe(0);
  });

  test("CONTEXT_MODE_GRAPH_FRESHNESS_TTL_MS governs the default, 0 disables the cache", () => {
    expect(freshnessTtlMs({} as NodeJS.ProcessEnv)).toBe(10_000);
    expect(freshnessTtlMs({ CONTEXT_MODE_GRAPH_FRESHNESS_TTL_MS: "250" } as NodeJS.ProcessEnv)).toBe(250);
    expect(freshnessTtlMs({ CONTEXT_MODE_GRAPH_FRESHNESS_TTL_MS: "nonsense" } as NodeJS.ProcessEnv)).toBe(10_000);

    const { handle, file } = currentFixture();
    const env = { CONTEXT_MODE_GRAPH_FRESHNESS_TTL_MS: "0" } as NodeJS.ProcessEnv;
    expect(checkFreshness(handle, { env })!.staleFiles).toBe(0);
    makeStale(file);
    expect(checkFreshness(handle, { env })!.staleFiles).toBe(1);
  });

  test("CONTEXT_MODE_GRAPH_FRESHNESS=0 still short-circuits before the cache", () => {
    const { handle } = currentFixture();
    const report = checkFreshness(handle, {
      env: { CONTEXT_MODE_GRAPH_FRESHNESS: "0" } as NodeJS.ProcessEnv,
    });
    expect(report).toBeNull();
  });
});
