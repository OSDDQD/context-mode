/**
 * Project isolation.
 *
 * Commit 08ddb5e ("stop one project's files landing in another project's
 * knowledge base") fixed a shared queue that let whichever server opened first
 * swallow every project's files. The search layer opens a second channel into
 * the same danger: a shared ranking database, a watcher over a tree, and
 * results carrying paths. Everything below is a guard against reopening it.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireFinder, __resetFinderRegistryForTests } from "../../src/fff/finder.js";
import { __setFffLoaderForTests } from "../../src/fff/native.js";
import { canonicalProjectRoot, fffDbPathsFor, isInsideRoot } from "../../src/fff/paths.js";
import { normalizeGrepResult, normalizeSearchResult } from "../../src/fff/normalize.js";
import { configureFakeNative, fakeLoader, fakeNativeState } from "./fake-native.js";

let workspace: string;
let projectA: string;
let projectB: string;
let storageDir: string;

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "fff-isolation-")));
  projectA = realpathSync(mkdtempSync(join(workspace, "a-")));
  projectB = realpathSync(mkdtempSync(join(workspace, "b-")));
  storageDir = join(workspace, "store");
  // Drive the fake loader regardless of an ambient kill switch.
  delete process.env.CONTEXT_MODE_FFF;
  configureFakeNative({});
  __setFffLoaderForTests(fakeLoader());
  process.env.CONTEXT_MODE_FFF_MAX_INSTANCES = "4";
});

afterEach(() => {
  __resetFinderRegistryForTests();
  __setFffLoaderForTests(null);
  delete process.env.CONTEXT_MODE_FFF_MAX_INSTANCES;
  rmSync(workspace, { recursive: true, force: true });
});

describe("project isolation", () => {
  it("gives each project its own frecency and history databases", () => {
    const a = fffDbPathsFor(projectA, { storageDir });
    const b = fffDbPathsFor(projectB, { storageDir });

    expect(a.frecencyDbPath).not.toBe(b.frecencyDbPath);
    expect(a.historyDbPath).not.toBe(b.historyDbPath);
    expect(dirname(a.frecencyDbPath)).toBe(storageDir);
    expect(dirname(b.historyDbPath)).toBe(storageDir);
    // Stable across calls — the ranking has to survive a restart.
    expect(fffDbPathsFor(projectA, { storageDir })).toEqual(a);
    // Same hash the FTS5 content store keys on.
    expect(a.projectHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("pins the native index to the canonical root and that project's databases", async () => {
    const acquired = await acquireFinder(projectA, { storageDir });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    const opts = fakeNativeState().created[0]!;
    const paths = fffDbPathsFor(projectA, { storageDir });
    expect(opts.basePath).toBe(canonicalProjectRoot(projectA));
    expect(opts.frecencyDbPath).toBe(paths.frecencyDbPath);
    expect(opts.historyDbPath).toBe(paths.historyDbPath);
    expect(acquired.value.projectRoot).toBe(projectA);
  });

  it("keys the registry on the canonical root, so path spellings cannot fork the index", async () => {
    const first = await acquireFinder(projectA, { storageDir });
    const second = await acquireFinder(join(projectA, "src", ".."), { storageDir });
    const third = await acquireFinder(`${projectA}/`, { storageDir });

    expect(first.ok && second.ok && third.ok).toBe(true);
    expect(fakeNativeState().created).toHaveLength(1);
  });

  it("drops search hits that resolve outside the project root", () => {
    const result = normalizeSearchResult(projectA, {
      items: [
        {
          relativePath: "src/inside.ts",
          fileName: "inside.ts",
          size: 1,
          modified: 1_700_000_000,
          accessFrecencyScore: 1,
          modificationFrecencyScore: 2,
          totalFrecencyScore: 3,
          gitStatus: "clean",
        },
        {
          relativePath: "../other-project/leak.ts",
          fileName: "leak.ts",
          size: 1,
          modified: 1_700_000_000,
          accessFrecencyScore: 0,
          modificationFrecencyScore: 0,
          totalFrecencyScore: 0,
          gitStatus: "clean",
        },
      ],
      scores: [
        { total: 90, baseScore: 90, filenameBonus: 0, specialFilenameBonus: 0, frecencyBoost: 0, distancePenalty: 0, currentFilePenalty: 0, comboMatchBoost: 0, exactMatch: false, matchType: "fuzzy" },
        { total: 80, baseScore: 80, filenameBonus: 0, specialFilenameBonus: 0, frecencyBoost: 0, distancePenalty: 0, currentFilePenalty: 0, comboMatchBoost: 0, exactMatch: false, matchType: "fuzzy" },
      ],
      totalMatched: 2,
      totalFiles: 10,
    });

    expect(result.items.map((i) => i.relativePath)).toEqual(["src/inside.ts"]);
    // Scores stay positionally aligned with the surviving items.
    expect(result.scores).toHaveLength(1);
    expect(result.scores[0]!.total).toBe(90);
    // The honest total survives, so a caller can say "showing 1 of 2".
    expect(result.totalMatched).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.items[0]!.path).toBe(join(projectA, "src/inside.ts"));
    // Timestamps normalized from fff's epoch seconds to milliseconds.
    expect(result.items[0]!.modified).toBe(1_700_000_000_000);
  });

  it("carries grep totals through untouched", () => {
    const result = normalizeGrepResult(projectA, {
      items: [],
      totalMatched: 340,
      totalFilesSearched: 128,
      totalFiles: 900,
      filteredFileCount: 57,
      nextCursor: { __brand: "GrepCursor", _offset: 20 } as never,
    });

    expect(result.totalMatched).toBe(340);
    expect(result.filesSearched).toBe(128);
    expect(result.filteredFileCount).toBe(57);
    expect(result.nextCursor).toEqual({ offset: 20 });
    expect(result.truncated).toBe(true);
  });

  it("refuses to track a file belonging to another project", async () => {
    const acquired = await acquireFinder(projectA, { storageDir });
    if (!acquired.ok) throw new Error("setup failed");

    const foreign = join(projectB, "src/other.ts");
    const tracked = await acquired.value.trackQuery("other", foreign);

    expect(tracked.ok).toBe(false);
    if (!tracked.ok) expect(tracked.error).toMatch(/outside/);
    expect(fakeNativeState().instances[0]!.trackedQueries).toHaveLength(0);
  });

  it("refuses to retarget an index at another project", async () => {
    const acquired = await acquireFinder(projectA, { storageDir });
    if (!acquired.ok) throw new Error("setup failed");

    const retargeted = acquired.value.reindex(projectB);
    expect(retargeted.ok).toBe(false);
    if (!retargeted.ok) expect(retargeted.error).toMatch(/refusing to reindex/);
    expect(fakeNativeState().instances[0]!.scanCount).toBe(0);

    // A same-root reindex is just a rescan.
    expect(acquired.value.reindex().ok).toBe(true);
    expect(acquired.value.reindex(projectA).ok).toBe(true);
    expect(fakeNativeState().instances[0]!.scanCount).toBe(2);
  });

  it("never delivers another project's filesystem events to a subscriber", async () => {
    const a = await acquireFinder(projectA, { storageDir, watchDebounceMs: 0 });
    const b = await acquireFinder(projectB, { storageDir, watchDebounceMs: 0 });
    if (!a.ok || !b.ok) throw new Error("setup failed");

    const seenA: string[] = [];
    const seenB: string[] = [];
    a.value.onFsChange((events) => seenA.push(...events.map((e) => e.path)));
    b.value.onFsChange((events) => seenB.push(...events.map((e) => e.path)));

    const nativeA = fakeNativeState().instances[0]!;
    nativeA.emit([
      { path: join(projectA, "src/mine.ts"), kind: "modified" },
      { path: join(projectB, "src/theirs.ts"), kind: "modified" },
      { path: join(workspace, "outside.ts"), kind: "created" },
    ]);

    expect(seenA).toEqual([join(projectA, "src/mine.ts")]);
    expect(seenB).toEqual([]);
  });

  it("isInsideRoot rejects sibling directories with a shared prefix", () => {
    expect(isInsideRoot("/repo/app/src/a.ts", "/repo/app")).toBe(true);
    expect(isInsideRoot("/repo/app", "/repo/app")).toBe(true);
    expect(isInsideRoot("/repo/app-two/src/a.ts", "/repo/app")).toBe(false);
    expect(isInsideRoot("../escape.ts", "/repo/app")).toBe(false);
  });
});
