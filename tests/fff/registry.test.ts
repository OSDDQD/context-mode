/**
 * Registry lifetime: one native index per project root, and an explicit
 * destroy for every one of them.
 *
 * A `FileFinder` owns a native file index and a watcher thread that the JS
 * garbage collector cannot see. "Someone will drop the reference eventually"
 * is not memory management here — these tests pin the ownership rules down.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireFinder,
  activeFinderRoots,
  destroyAllFinders,
  destroyFinder,
  getActiveFinder,
  useProject,
  __resetFinderRegistryForTests,
} from "../../src/fff/finder.js";
import { __setFffLoaderForTests } from "../../src/fff/native.js";
import { configureFakeNative, fakeLoader, fakeNativeState } from "./fake-native.js";

let workspace: string;
let projectA: string;
let projectB: string;
let storageDir: string;

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "fff-registry-")));
  projectA = realpathSync(mkdtempSync(join(workspace, "a-")));
  projectB = realpathSync(mkdtempSync(join(workspace, "b-")));
  storageDir = join(workspace, "store");
  // The suite drives the fake loader, so it must not inherit a developer's
  // kill switch from the ambient environment.
  delete process.env.CONTEXT_MODE_FFF;
  configureFakeNative({ hits: [{ relativePath: "src/index.ts" }] });
  __setFffLoaderForTests(fakeLoader());
});

afterEach(() => {
  __resetFinderRegistryForTests();
  __setFffLoaderForTests(null);
  delete process.env.CONTEXT_MODE_FFF_MAX_INSTANCES;
  rmSync(workspace, { recursive: true, force: true });
});

describe("finder registry", () => {
  it("creates one native index per root and reuses it", async () => {
    const first = await acquireFinder(projectA, { storageDir });
    const second = await acquireFinder(projectA, { storageDir });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value).toBe(first.value);
    expect(fakeNativeState().created).toHaveLength(1);
    expect(activeFinderRoots()).toEqual([projectA]);
  });

  it("collapses concurrent acquisitions of the same root into one index", async () => {
    const [a, b, c] = await Promise.all([
      acquireFinder(projectA, { storageDir }),
      acquireFinder(projectA, { storageDir }),
      acquireFinder(projectA, { storageDir }),
    ]);

    expect(a.ok && b.ok && c.ok).toBe(true);
    expect(fakeNativeState().created).toHaveLength(1);
    if (a.ok && b.ok && c.ok) {
      expect(b.value).toBe(a.value);
      expect(c.value).toBe(a.value);
    }
  });

  it("destroys the native instance explicitly, and only once", async () => {
    const acquired = await acquireFinder(projectA, { storageDir });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    expect(destroyFinder(projectA)).toBe(true);
    expect(fakeNativeState().destroyCount).toBe(1);
    expect(acquired.value.isDestroyed).toBe(true);
    expect(getActiveFinder(projectA)).toBeUndefined();

    // Destroying again is a no-op, not a second native teardown.
    expect(destroyFinder(projectA)).toBe(false);
    acquired.value.destroy();
    expect(fakeNativeState().destroyCount).toBe(1);
  });

  it("tears down the watch subscription and the bus on destroy", async () => {
    const acquired = await acquireFinder(projectA, { storageDir });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    const native = fakeNativeState().instances[0]!;
    const seen: unknown[] = [];
    acquired.value.onFsChange((events) => seen.push(events));
    expect(native.watchCallbacks.size).toBe(1);

    acquired.value.destroy();
    expect(native.watchCallbacks.size).toBe(0);
    expect(acquired.value.watchBus.isClosed).toBe(true);
    expect(acquired.value.watchBus.listenerCount).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it("reports unavailable instead of throwing once destroyed", async () => {
    const acquired = await acquireFinder(projectA, { storageDir });
    if (!acquired.ok) throw new Error("setup failed");
    acquired.value.destroy();

    const search = acquired.value.fileSearch("index");
    expect(search.ok).toBe(false);
    if (!search.ok) expect(search.unavailable).toBe(true);
    await expect(acquired.value.trackQuery("index", join(projectA, "src/index.ts")))
      .resolves.toMatchObject({ ok: false });
  });

  it("re-creates a fresh index when the cached one was destroyed underneath", async () => {
    const first = await acquireFinder(projectA, { storageDir });
    if (!first.ok) throw new Error("setup failed");
    first.value.destroy();

    const second = await acquireFinder(projectA, { storageDir });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value).not.toBe(first.value);
    expect(fakeNativeState().created).toHaveLength(2);
  });

  it("evicts the least-recently-used index past the instance cap", async () => {
    process.env.CONTEXT_MODE_FFF_MAX_INSTANCES = "1";

    await acquireFinder(projectA, { storageDir });
    await acquireFinder(projectB, { storageDir });

    expect(activeFinderRoots()).toEqual([projectB]);
    expect(fakeNativeState().destroyCount).toBe(1);
  });

  it("useProject() destroys every other project's index", async () => {
    process.env.CONTEXT_MODE_FFF_MAX_INSTANCES = "8";
    await acquireFinder(projectA, { storageDir });
    await acquireFinder(projectB, { storageDir });
    expect(activeFinderRoots()).toHaveLength(2);

    const switched = await useProject(projectA, { storageDir });
    expect(switched.ok).toBe(true);
    expect(activeFinderRoots()).toEqual([projectA]);
    expect(fakeNativeState().destroyCount).toBe(1);
  });

  it("destroyAllFinders() releases everything and reports the count", async () => {
    process.env.CONTEXT_MODE_FFF_MAX_INSTANCES = "8";
    await acquireFinder(projectA, { storageDir });
    await acquireFinder(projectB, { storageDir });

    expect(destroyAllFinders()).toBe(2);
    expect(activeFinderRoots()).toEqual([]);
    expect(fakeNativeState().destroyCount).toBe(2);
    expect(destroyAllFinders()).toBe(0);
  });

  it("retries a lock-contended trackQuery instead of losing the signal", async () => {
    configureFakeNative({
      hits: [],
      trackQueryErrors: ["Resource temporarily unavailable (lock)", "MDB_BUSY: db busy"],
    });
    const acquired = await acquireFinder(projectA, { storageDir });
    if (!acquired.ok) throw new Error("setup failed");

    const target = join(projectA, "src/index.ts");
    const tracked = await acquired.value.trackQuery("index", target);

    expect(tracked).toEqual({ ok: true, value: true });
    expect(fakeNativeState().instances[0]!.trackedQueries).toEqual([{ query: "index", path: target }]);
  });

  it("does not retry a non-contention error", async () => {
    configureFakeNative({ hits: [], trackQueryErrors: ["invalid utf-8 in query"] });
    const acquired = await acquireFinder(projectA, { storageDir });
    if (!acquired.ok) throw new Error("setup failed");

    const tracked = await acquired.value.trackQuery("q", join(projectA, "a.ts"));
    expect(tracked.ok).toBe(false);
    if (!tracked.ok) expect(tracked.error).toContain("invalid utf-8");
    expect(fakeNativeState().instances[0]!.trackedQueries).toHaveLength(0);
  });
});
