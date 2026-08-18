/**
 * A test double for `@ff-labs/fff-node`.
 *
 * The whole point of `src/fff/native.ts`'s loader seam is that the suite runs
 * on machines where the native binary is absent — CI without optional
 * dependencies, unsupported platforms, `npm ci --ignore-scripts`. Every
 * behavioural test in `tests/fff/` drives this fake; the one test that touches
 * the real library skips itself when it cannot load.
 */

import type {
  FffNativeModule,
  NativeFileFinder,
  NativeResult,
} from "../../src/fff/types.js";

export interface FakeFileHit {
  relativePath: string;
  fileName?: string;
  size?: number;
  /** Epoch SECONDS, the way fff reports it. */
  modified?: number;
  gitStatus?: string;
  accessFrecencyScore?: number;
  modificationFrecencyScore?: number;
  totalFrecencyScore?: number;
}

export interface FakeWatchEvent {
  path: string;
  kind: "created" | "modified" | "removed" | "rescan";
}

export interface FakeFinderConfig {
  /** Hits every `fileSearch` / `glob` returns. */
  hits?: FakeFileHit[];
  /** Reported independently of `hits.length`, so truncation can be asserted. */
  totalMatched?: number;
  /** Errors `trackQuery` returns before it starts succeeding. */
  trackQueryErrors?: string[];
  /** Make `create()` fail. */
  createError?: string;
  /** Grep matches every `grep` / `multiGrep` returns. */
  grepHits?: FakeFileHit[];
  grepTotalMatched?: number;
  grepNextCursorOffset?: number | null;
}

export interface FakeNativeState {
  created: Array<Record<string, unknown>>;
  instances: FakeFinder[];
  destroyCount: number;
}

let config: FakeFinderConfig = {};
let state: FakeNativeState = { created: [], instances: [], destroyCount: 0 };

export function configureFakeNative(next: FakeFinderConfig = {}): void {
  config = next;
  state = { created: [], instances: [], destroyCount: 0 };
}

export function fakeNativeState(): FakeNativeState {
  return state;
}

function ok<T>(value: T): NativeResult<T> {
  return { ok: true, value };
}

function err<T>(error: string): NativeResult<T> {
  return { ok: false, error };
}

function toFileItem(hit: FakeFileHit) {
  return {
    relativePath: hit.relativePath,
    fileName: hit.fileName ?? hit.relativePath.split("/").pop() ?? hit.relativePath,
    size: hit.size ?? 10,
    modified: hit.modified ?? 1_700_000_000,
    accessFrecencyScore: hit.accessFrecencyScore ?? 0,
    modificationFrecencyScore: hit.modificationFrecencyScore ?? 0,
    totalFrecencyScore: hit.totalFrecencyScore ?? 0,
    gitStatus: hit.gitStatus ?? "clean",
  };
}

function toScore(i: number) {
  return {
    total: 100 - i,
    baseScore: 100 - i,
    filenameBonus: 0,
    specialFilenameBonus: 0,
    frecencyBoost: 0,
    distancePenalty: 0,
    currentFilePenalty: 0,
    comboMatchBoost: 0,
    exactMatch: false,
    matchType: "fuzzy",
  };
}

/** Minimal stand-in for one native index. */
export class FakeFinder {
  readonly options: Record<string, unknown>;
  destroyed = false;
  watchCallbacks = new Set<(events: FakeWatchEvent[]) => void>();
  trackedQueries: Array<{ query: string; path: string }> = [];
  scanCount = 0;
  private trackFailures: string[];

  constructor(options: Record<string, unknown>) {
    this.options = options;
    this.trackFailures = [...(config.trackQueryErrors ?? [])];
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
    this.watchCallbacks.clear();
    state.destroyCount += 1;
  }

  /** Push events as if the native watcher fired. */
  emit(events: FakeWatchEvent[]): void {
    for (const cb of [...this.watchCallbacks]) cb(events);
  }

  private searchResult() {
    const hits = config.hits ?? [];
    return ok({
      items: hits.map(toFileItem),
      scores: hits.map((_, i) => toScore(i)),
      totalMatched: config.totalMatched ?? hits.length,
      totalFiles: 100,
    });
  }

  fileSearch() {
    return this.guard(() => this.searchResult());
  }

  glob() {
    return this.guard(() => this.searchResult());
  }

  directorySearch() {
    const hits = config.hits ?? [];
    return this.guard(() => ok({
      items: hits.map((h) => ({
        relativePath: h.relativePath,
        dirName: h.relativePath.split("/").pop() ?? h.relativePath,
        maxAccessFrecency: 0,
      })),
      scores: hits.map((_, i) => toScore(i)),
      totalMatched: config.totalMatched ?? hits.length,
      totalDirs: 5,
    }));
  }

  mixedSearch() {
    const hits = config.hits ?? [];
    return this.guard(() => ok({
      items: hits.map((h) => ({ type: "file" as const, item: toFileItem(h) })),
      scores: hits.map((_, i) => toScore(i)),
      totalMatched: config.totalMatched ?? hits.length,
      totalFiles: 100,
      totalDirs: 5,
    }));
  }

  private grepResult() {
    const hits = config.grepHits ?? config.hits ?? [];
    const cursor = config.grepNextCursorOffset;
    return ok({
      items: hits.map((h) => ({
        ...toFileItem(h),
        isBinary: false,
        lineNumber: 1,
        col: 0,
        byteOffset: 0,
        lineContent: `hit in ${h.relativePath}`,
        matchRanges: [[0, 3]] as Array<[number, number]>,
      })),
      totalMatched: config.grepTotalMatched ?? hits.length,
      totalFilesSearched: 42,
      totalFiles: 100,
      filteredFileCount: hits.length,
      nextCursor: cursor === undefined || cursor === null ? null : { __brand: "GrepCursor", _offset: cursor },
    });
  }

  grep() {
    return this.guard(() => this.grepResult());
  }

  multiGrep() {
    return this.guard(() => this.grepResult());
  }

  scanFiles() {
    this.scanCount += 1;
    return this.guard(() => ok(undefined));
  }

  isScanning(): boolean {
    return false;
  }

  getBasePath() {
    return this.guard(() => ok(String(this.options.basePath ?? "")));
  }

  getScanProgress() {
    return this.guard(() => ok({
      scannedFilesCount: 100,
      isScanning: false,
      isWatcherReady: true,
      isWarmupComplete: true,
    }));
  }

  async waitForScan() {
    return this.guard(() => ok(true));
  }

  waitForScanBlocking() {
    return this.guard(() => ok(true));
  }

  async waitForIndexReady() {
    return this.guard(() => ok(true));
  }

  reindex() {
    return this.guard(() => ok(undefined));
  }

  refreshGitStatus() {
    return this.guard(() => ok(7));
  }

  trackQuery(query: string, selectedFilePath: string) {
    return this.guard(() => {
      const failure = this.trackFailures.shift();
      if (failure) return err<boolean>(failure);
      this.trackedQueries.push({ query, path: selectedFilePath });
      return ok(true);
    });
  }

  getHistoricalQuery() {
    return this.guard(() => ok(null));
  }

  watch(...args: unknown[]) {
    const callback = (typeof args[0] === "function" ? args[0] : args[1]) as
      | ((events: FakeWatchEvent[]) => void)
      | undefined;
    if (!callback) return err<() => void>("no callback");
    return this.guard(() => {
      this.watchCallbacks.add(callback);
      return ok(() => {
        this.watchCallbacks.delete(callback);
      });
    });
  }

  healthCheck() {
    return this.guard(() => ok({
      version: "0.0.0-fake",
      git: { available: true, repositoryFound: true, libgit2Version: "fake" },
      filePicker: { initialized: true, indexedFiles: 100 },
      frecency: { initialized: true },
      queryTracker: { initialized: true },
    }));
  }

  private guard<T>(fn: () => NativeResult<T>): NativeResult<T> {
    if (this.destroyed) return err<T>("FileFinder instance has been destroyed.");
    return fn();
  }
}

/** A loader that resolves to the fake module. */
export function fakeLoader(): () => Promise<FffNativeModule> {
  return async () => ({
    FileFinder: {
      create(options: Record<string, unknown>) {
        if (config.createError) return err<NativeFileFinder>(config.createError);
        const finder = new FakeFinder(options);
        state.created.push(options);
        state.instances.push(finder);
        return ok(finder as unknown as NativeFileFinder);
      },
      isAvailable: () => true,
      healthCheckStatic: () => ok({
        version: "0.0.0-fake",
        git: { available: true, repositoryFound: false, libgit2Version: "fake" },
        filePicker: { initialized: false },
        frecency: { initialized: false },
        queryTracker: { initialized: false },
      }),
    },
  } as unknown as FffNativeModule);
}

/** A loader that fails the way a missing native binary does. */
export function missingBinaryLoader(): () => Promise<FffNativeModule> {
  return async () => {
    throw new Error("Cannot find module '@ff-labs/fff-node'");
  };
}

/** A loader whose module loads but reports no usable binary. */
export function unavailableBinaryLoader(): () => Promise<FffNativeModule> {
  return async () => ({
    FileFinder: {
      create: () => err<NativeFileFinder>("unreachable"),
      isAvailable: () => false,
    },
  } as unknown as FffNativeModule);
}
