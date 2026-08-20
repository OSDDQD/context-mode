/**
 * The re-read cache — "unchanged since your last read, hash X" instead of the
 * content a second time.
 *
 * Every case here is really the same case: the cache is allowed to say
 * `unchanged` only when a live watcher has been covering the path from the
 * moment of the read until now. The suite spends most of its length on the ways
 * that stops being true — the watcher never came up, it was restarted, it lost
 * track and asked for a rescan, its fan-out was switched off — because a wrong
 * `unchanged` hands the agent bytes that are no longer on disk, while a wrong
 * `unknown` costs one redundant read.
 *
 * Events come from the fake native module in `tests/fff/fake-native.ts`, so
 * nothing here needs an fff binary or a real filesystem watcher.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetFinderRegistryForTests } from "../../src/fff/finder.js";
import { __setFffLoaderForTests } from "../../src/fff/native.js";
import { resetSyncQueue, setSyncRunner } from "../../src/graph/daemon.js";
import {
  __resetPathCachesForTests,
  __resetReadCacheForTests,
  checkRead,
  detachAllFsWiring,
  forgetRead,
  installFsWiring,
  readCacheStats,
  recordRead,
  registeredPathCaches,
} from "../../src/fs-bus/index.js";
import {
  configureFakeNative,
  fakeLoader,
  fakeNativeState,
  type FakeFinder,
} from "../fff/fake-native.js";

let workspace: string;
let projectA: string;
let storageDir: string;

function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CONTEXT_MODE_FFF: "1",
    CONTEXT_MODE_FFF_WATCH: "1",
    CONTEXT_MODE_FFF_MAX_INSTANCES: "4",
    ...overrides,
  };
}

function touch(root: string, relativePath: string, body = "// hello\n"): string {
  const abs = join(root, relativePath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf-8");
  return abs;
}

function nativeFor(index: number): FakeFinder {
  const finder = fakeNativeState().instances[index];
  if (!finder) throw new Error(`no fake native instance at ${index}`);
  return finder;
}

async function install(env: NodeJS.ProcessEnv = baseEnv(), root: string = projectA) {
  return installFsWiring({
    projectDir: root,
    env,
    finderOptions: { storageDir, watchDebounceMs: 0 },
  });
}

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "read-cache-")));
  projectA = realpathSync(mkdtempSync(join(workspace, "a-")));
  storageDir = join(workspace, "store");
  delete process.env.CONTEXT_MODE_FFF;
  delete process.env.CONTEXT_MODE_FFF_WATCH;
  delete process.env.CONTEXT_MODE_READ_CACHE;
  delete process.env.CONTEXT_MODE_READ_CACHE_MAX;
  configureFakeNative({});
  __setFffLoaderForTests(fakeLoader());
  __resetPathCachesForTests();
  __resetReadCacheForTests();
  resetSyncQueue();
});

afterEach(() => {
  detachAllFsWiring();
  __resetReadCacheForTests();
  __resetPathCachesForTests();
  __resetFinderRegistryForTests();
  __setFffLoaderForTests(null);
  resetSyncQueue();
  setSyncRunner(null);
  rmSync(workspace, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────
// The hit
// ─────────────────────────────────────────────────────────

describe("unchanged files", () => {
  it("answers 'unchanged' with the recorded hash while the watcher is live", async () => {
    const env = baseEnv();
    const file = touch(projectA, "src/app.ts");
    await install(env);

    recordRead({ path: file, hash: "h1", bytes: 9, env });
    expect(checkRead(file, { env })).toEqual({
      state: "unchanged",
      hash: "h1",
      readAt: expect.any(Number),
      bytes: 9,
    });
  });

  it("attaches itself to the path-cache registry on first use", async () => {
    const env = baseEnv();
    const file = touch(projectA, "src/app.ts");
    await install(env);

    expect(registeredPathCaches()).toEqual([]);
    recordRead({ path: file, hash: "h1", env });
    expect(registeredPathCaches()).toEqual(["read-cache"]);
    expect(readCacheStats(env).attached).toBe(true);
  });

  it("resolves a symlinked spelling to the path the watcher will name", async () => {
    const env = baseEnv();
    const file = touch(projectA, "src/app.ts");
    await install(env);
    recordRead({ path: join(projectA, "src", "..", "src", "app.ts"), hash: "h1", env });

    expect(checkRead(file, { env }).state).toBe("unchanged");
    expect(readCacheStats(env).entries).toBe(1);
  });

  it("hands back 'changed' when the caller last saw a different hash", async () => {
    const env = baseEnv();
    const file = touch(projectA, "src/app.ts");
    await install(env);
    recordRead({ path: file, hash: "h1", env });

    const answer = checkRead(file, { sinceHash: "h0", env });
    expect(answer.state).toBe("changed");
  });
});

// ─────────────────────────────────────────────────────────
// The miss
// ─────────────────────────────────────────────────────────

describe("invalidation", () => {
  it("reports 'changed' after the watcher sees the file move", async () => {
    const env = baseEnv();
    const file = touch(projectA, "src/app.ts");
    await install(env);
    recordRead({ path: file, hash: "h1", env });

    nativeFor(0).emit([{ path: file, kind: "modified" }]);

    expect(checkRead(file, { env })).toEqual({
      state: "changed",
      previousHash: "h1",
      changedAt: expect.any(Number),
    });
    expect(readCacheStats(env).invalidations).toBe(1);
  });

  it("keeps a tombstone, so a read that started before the event is not clean", async () => {
    const env = baseEnv();
    const file = touch(projectA, "src/app.ts");
    await install(env);

    // The production order: ask first (which attaches the cache), then read.
    expect(checkRead(file, { env })).toEqual({ state: "unknown", reason: "no-record" });

    // The read is in flight (its clock reading is already taken) when the write
    // lands and the watcher delivers it. Recording afterwards must not erase it.
    const readAt = Date.now() - 50;
    nativeFor(0).emit([{ path: file, kind: "modified" }]);
    recordRead({ path: file, hash: "stale", readAt, env });

    expect(checkRead(file, { env }).state).toBe("changed");
  });

  it("drops everything on a rescan — the watcher can no longer say what moved", async () => {
    const env = baseEnv();
    const file = touch(projectA, "src/app.ts");
    await install(env);
    recordRead({ path: file, hash: "h1", env });

    nativeFor(0).emit([{ path: projectA, kind: "rescan" }]);

    expect(checkRead(file, { env })).toEqual({ state: "unknown", reason: "no-record" });
    expect(readCacheStats(env).clears).toBe(1);
    expect(readCacheStats(env).entries).toBe(0);
  });

  it("forgets a path on demand, for a writer that beat the debounce window", async () => {
    const env = baseEnv();
    const file = touch(projectA, "src/app.ts");
    await install(env);
    recordRead({ path: file, hash: "h1", env });

    forgetRead(file);
    expect(checkRead(file, { env })).toEqual({ state: "unknown", reason: "no-record" });
  });
});

// ─────────────────────────────────────────────────────────
// Everything that makes the answer untrustworthy
// ─────────────────────────────────────────────────────────

describe("unknown", () => {
  it("refuses to answer with no live wiring over the path", () => {
    const env = baseEnv();
    const file = touch(projectA, "src/app.ts");

    recordRead({ path: file, hash: "h1", env });
    expect(checkRead(file, { env })).toEqual({ state: "unknown", reason: "no-watcher" });
  });

  it("refuses to answer once the wiring that covered the read is gone", async () => {
    const env = baseEnv();
    const file = touch(projectA, "src/app.ts");
    await install(env);
    recordRead({ path: file, hash: "h1", env });

    detachAllFsWiring();
    expect(checkRead(file, { env })).toEqual({ state: "unknown", reason: "no-watcher" });
  });

  it("refuses to answer across a watcher restart — the gap delivered no events", async () => {
    const env = baseEnv();
    const file = touch(projectA, "src/app.ts");
    await install(env);
    recordRead({ path: file, hash: "h1", env });

    // Whatever an editor did here produced no event anybody received.
    detachAllFsWiring();
    __resetFinderRegistryForTests();
    await install(env);

    expect(checkRead(file, { env })).toEqual({ state: "unknown", reason: "watcher-restarted" });
  });

  it("refuses to answer while the cache consumer is switched off", async () => {
    const env = baseEnv({ CONTEXT_MODE_FS_BUS_CACHE: "0" });
    const file = touch(projectA, "src/app.ts");
    await install(env);
    recordRead({ path: file, hash: "h1", env });

    // The bus still runs; nothing reaches the path caches, so no entry under
    // this root could ever be invalidated.
    expect(checkRead(file, { env })).toEqual({ state: "unknown", reason: "no-watcher" });
  });

  it("records nothing and answers 'disabled' under CONTEXT_MODE_READ_CACHE=0", async () => {
    const env = baseEnv({ CONTEXT_MODE_READ_CACHE: "0" });
    const file = touch(projectA, "src/app.ts");
    await install(env);

    recordRead({ path: file, hash: "h1", env });
    expect(checkRead(file, { env })).toEqual({ state: "unknown", reason: "disabled" });
    expect(readCacheStats(env).entries).toBe(0);
    // Nothing registered either: the fan-out consumer stays a `Set#size` check.
    expect(registeredPathCaches()).toEqual([]);
  });

  it("does not record a file that is already gone", async () => {
    const env = baseEnv();
    await install(env);

    recordRead({ path: join(projectA, "src/never.ts"), hash: "h1", env });
    expect(readCacheStats(env).entries).toBe(0);
  });

  it("drops its entries if the registry is emptied behind its back", async () => {
    const env = baseEnv();
    const file = touch(projectA, "src/app.ts");
    await install(env);
    recordRead({ path: file, hash: "h1", env });

    // Detached: from here on no watcher event reaches the cache, so nothing it
    // still holds describes disk.
    __resetPathCachesForTests();

    expect(checkRead(file, { env })).toEqual({ state: "unknown", reason: "no-record" });
    expect(registeredPathCaches()).toEqual(["read-cache"]);
  });
});

// ─────────────────────────────────────────────────────────
// Bounded memory
// ─────────────────────────────────────────────────────────

describe("bounds", () => {
  it("evicts the least recently used entry and never grows past the cap", async () => {
    const env = baseEnv({ CONTEXT_MODE_READ_CACHE_MAX: "16" });
    await install(env);

    const files = Array.from({ length: 24 }, (_, i) => touch(projectA, `src/f${i}.ts`));
    for (const file of files) recordRead({ path: file, hash: `h-${file}`, env });

    const stats = readCacheStats(env);
    expect(stats.capacity).toBe(16);
    expect(stats.entries).toBe(16);
    expect(stats.evictions).toBe(8);

    // The first eight are gone, the last sixteen answer.
    expect(checkRead(files[0]!, { env })).toEqual({ state: "unknown", reason: "no-record" });
    expect(checkRead(files[7]!, { env })).toEqual({ state: "unknown", reason: "no-record" });
    expect(checkRead(files[8]!, { env }).state).toBe("unchanged");
    expect(checkRead(files[23]!, { env }).state).toBe("unchanged");
  });

  it("a hit moves the entry back to the tail, so hot paths survive", async () => {
    const env = baseEnv({ CONTEXT_MODE_READ_CACHE_MAX: "16" });
    await install(env);

    const files = Array.from({ length: 16 }, (_, i) => touch(projectA, `src/g${i}.ts`));
    for (const file of files) recordRead({ path: file, hash: `h-${file}`, env });

    expect(checkRead(files[0]!, { env }).state).toBe("unchanged");
    recordRead({ path: touch(projectA, "src/newcomer.ts"), hash: "n", env });

    // The newcomer evicted files[1], not the freshly touched files[0].
    expect(checkRead(files[0]!, { env }).state).toBe("unchanged");
    expect(checkRead(files[1]!, { env })).toEqual({ state: "unknown", reason: "no-record" });
    expect(readCacheStats(env).entries).toBe(16);
  });

  it("keeps the cap while a watcher batch mints tombstones", async () => {
    const env = baseEnv({ CONTEXT_MODE_READ_CACHE_MAX: "16" });
    await install(env);
    const files = Array.from({ length: 40 }, (_, i) => touch(projectA, `src/h${i}.ts`));
    recordRead({ path: files[0]!, hash: "h0", env });   // attaches the cache

    nativeFor(0).emit(files.map((path) => ({ path, kind: "modified" as const })));

    // 40 tombstones, one entry each, and the cap still holds.
    expect(readCacheStats(env).entries).toBe(16);
    expect(readCacheStats(env).invalidations).toBe(40);
  });
});
