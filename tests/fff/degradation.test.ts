/**
 * Degradation: the plugin must work on machines where fff does not.
 *
 * The native binary ships as an optional dependency. Missing platform,
 * `--ignore-scripts`, a corporate registry that blocks the scoped package —
 * all of these are normal, and none of them may take the server down or turn
 * into an exception a caller has to catch.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireFinder, fffHealthReport, __resetFinderRegistryForTests } from "../../src/fff/finder.js";
import { isFffAvailable, loadFffNative, __setFffLoaderForTests } from "../../src/fff/native.js";
import { isFffEnabled, isMmapCacheDisabled, isWatchDisabled } from "../../src/fff/env.js";
import {
  configureFakeNative,
  fakeLoader,
  fakeNativeState,
  missingBinaryLoader,
  unavailableBinaryLoader,
} from "./fake-native.js";

let workspace: string;
let project: string;
let storageDir: string;

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "fff-degrade-")));
  project = realpathSync(mkdtempSync(join(workspace, "p-")));
  storageDir = join(workspace, "store");
  // Each case sets the switches it needs; start from a clean environment so an
  // ambient CONTEXT_MODE_FFF=0 cannot mask a real regression.
  delete process.env.CONTEXT_MODE_FFF;
  delete process.env.CONTEXT_MODE_FFF_MMAP;
  delete process.env.CONTEXT_MODE_FFF_WATCH;
  configureFakeNative({});
});

afterEach(() => {
  __resetFinderRegistryForTests();
  __setFffLoaderForTests(null);
  delete process.env.CONTEXT_MODE_FFF;
  delete process.env.CONTEXT_MODE_FFF_MMAP;
  delete process.env.CONTEXT_MODE_FFF_WATCH;
  rmSync(workspace, { recursive: true, force: true });
});

describe("fff degradation", () => {
  it("reports unavailable — without throwing — when the module cannot be imported", async () => {
    __setFffLoaderForTests(missingBinaryLoader());

    const loaded = await loadFffNative();
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.unavailable).toBe(true);
      expect(loaded.error).toMatch(/unavailable/i);
    }
    await expect(isFffAvailable()).resolves.toBe(false);

    const acquired = await acquireFinder(project, { storageDir });
    expect(acquired.ok).toBe(false);
    if (!acquired.ok) expect(acquired.unavailable).toBe(true);
  });

  it("reports unavailable when the module loads but no binary is present", async () => {
    __setFffLoaderForTests(unavailableBinaryLoader());

    const acquired = await acquireFinder(project, { storageDir });
    expect(acquired.ok).toBe(false);
    if (!acquired.ok) {
      expect(acquired.unavailable).toBe(true);
      expect(acquired.error).toMatch(/binary not found/i);
    }
  });

  it("CONTEXT_MODE_FFF=0 switches the layer off without loading anything", async () => {
    let loaderCalls = 0;
    __setFffLoaderForTests(async () => {
      loaderCalls += 1;
      return (await fakeLoader()());
    });
    process.env.CONTEXT_MODE_FFF = "0";

    expect(isFffEnabled()).toBe(false);
    const acquired = await acquireFinder(project, { storageDir });
    expect(acquired.ok).toBe(false);
    if (!acquired.ok) {
      expect(acquired.unavailable).toBe(true);
      expect(acquired.error).toMatch(/CONTEXT_MODE_FFF/);
    }
    expect(loaderCalls).toBe(0);

    // The kill switch is re-read, not memoized: clearing it restores service.
    delete process.env.CONTEXT_MODE_FFF;
    const retried = await acquireFinder(project, { storageDir });
    expect(retried.ok).toBe(true);
    expect(loaderCalls).toBe(1);
  });

  it("treats a failed index creation as an error, not as unavailability", async () => {
    configureFakeNative({ createError: "Failed to init file picker: Invalid path" });
    __setFffLoaderForTests(fakeLoader());

    const acquired = await acquireFinder(project, { storageDir });
    expect(acquired.ok).toBe(false);
    if (!acquired.ok) {
      expect(acquired.unavailable).toBe(false);
      expect(acquired.error).toMatch(/Invalid path/);
    }
  });

  it("health report stays renderable when the layer is unavailable", async () => {
    __setFffLoaderForTests(missingBinaryLoader());

    const report = await fffHealthReport(project);
    expect(report.available).toBe(false);
    expect(report.enabled).toBe(true);
    expect(report.error).toBeTruthy();
    expect(report.storageDir).toMatch(/fff$/);
    expect(report.liveRoots).toEqual([]);
  });

  it("health report marks the layer as switched off when the env kill switch is set", async () => {
    __setFffLoaderForTests(fakeLoader());
    process.env.CONTEXT_MODE_FFF = "off";

    const report = await fffHealthReport(project);
    expect(report.enabled).toBe(false);
    expect(report.available).toBe(false);
  });

  it("CONTEXT_MODE_FFF_MMAP=off reaches the native init options", async () => {
    __setFffLoaderForTests(fakeLoader());
    process.env.CONTEXT_MODE_FFF_MMAP = "off";
    expect(isMmapCacheDisabled()).toBe(true);

    const acquired = await acquireFinder(project, { storageDir });
    expect(acquired.ok).toBe(true);
    expect(fakeNativeState().created[0]).toMatchObject({ disableMmapCache: true });
  });

  it("CONTEXT_MODE_FFF_WATCH=0 keeps search but never subscribes a watcher", async () => {
    __setFffLoaderForTests(fakeLoader());
    process.env.CONTEXT_MODE_FFF_WATCH = "0";
    expect(isWatchDisabled()).toBe(true);

    const acquired = await acquireFinder(project, { storageDir });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect(fakeNativeState().created[0]).toMatchObject({ disableWatch: true });
    expect(fakeNativeState().instances[0]!.watchCallbacks.size).toBe(0);
    expect(acquired.value.fileSearch("x").ok).toBe(true);
  });

  it("survives a storage directory it cannot create", async () => {
    __setFffLoaderForTests(fakeLoader());
    // A path under a regular file can never be created.
    const blocked = join(project, "not-a-dir", "fff");
    rmSync(blocked, { recursive: true, force: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(project, "not-a-dir"), "x");

    const acquired = await acquireFinder(project, { storageDir: blocked });
    expect(acquired.ok).toBe(true);
    // No persistent DB paths handed to the native side — in-memory ranking only.
    expect(fakeNativeState().created[0]).not.toHaveProperty("frecencyDbPath");
  });
});
