/**
 * Normalized result shapes for the in-process fff search layer.
 *
 * The native package (`@ff-labs/fff-node`) is a moving target — 0.x, ~290
 * releases in five months — so nothing outside `src/fff/` should ever touch
 * its types directly. Everything crossing the module boundary is normalized
 * here: absolute paths, epoch-millisecond timestamps, and explicit totals so
 * a caller can honestly say "showing 20 of 340" instead of silently
 * truncating.
 *
 * The native types are imported TYPE-ONLY. The runtime import lives in
 * `native.ts` and is deliberately non-static so esbuild cannot inline a
 * native FFI addon into `server.bundle.mjs`.
 */

import type {
  DirSearchOptions,
  FileFinderApi,
  GrepCursor,
  GrepMode,
  GrepOptions,
  HealthCheck,
  InitOptions,
  MultiGrepOptions,
  Result as NativeResult,
  ScanProgress,
  SearchOptions,
  WatchEventKind,
} from "@ff-labs/fff-node";

export type {
  DirSearchOptions,
  GrepMode,
  HealthCheck,
  ScanProgress,
  SearchOptions,
  WatchEventKind,
};

/**
 * Upstream 0.10.5 declares `GlobOptions` in `fff-api.d.ts` but forgets to
 * re-export it from the package root, and the deep path is not in the exports
 * map. Structurally identical, declared here so the boundary stays typed.
 */
export interface GlobOptions {
  maxThreads?: number;
  currentFile?: string;
  pageIndex?: number;
  pageSize?: number;
}

// ─────────────────────────────────────────────────────────
// Result type
// ─────────────────────────────────────────────────────────

/**
 * Every public call returns this instead of throwing.
 *
 * `unavailable: true` means "the fff layer is not usable here" — env kill
 * switch, missing native binary, unsupported platform, destroyed instance.
 * Callers are expected to fall back to their pre-fff behavior silently.
 * `unavailable: false` is a real operational error worth surfacing.
 */
export type FffResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; unavailable: boolean };

export function fffOk<T>(value: T): FffResult<T> {
  return { ok: true, value };
}

export function fffErr<T>(error: string, unavailable = false): FffResult<T> {
  return { ok: false, error, unavailable };
}

/** Lift a native `Result<T>` into an `FffResult<T>` without mapping the payload. */
export function fromNative<T>(result: NativeResult<T>): FffResult<T> {
  return result.ok ? fffOk(result.value) : fffErr<T>(result.error);
}

// ─────────────────────────────────────────────────────────
// Items
// ─────────────────────────────────────────────────────────

/** A file hit. `path` is absolute; `relativePath` is relative to the project root. */
export interface FffFileItem {
  path: string;
  relativePath: string;
  fileName: string;
  size: number;
  /** Epoch milliseconds (fff reports seconds). */
  modified: number;
  accessFrecencyScore: number;
  modificationFrecencyScore: number;
  totalFrecencyScore: number;
  /** fff's git status word, e.g. "clean" / "modified" / "untracked". */
  gitStatus: string;
}

/** A directory hit. */
export interface FffDirItem {
  path: string;
  relativePath: string;
  dirName: string;
  maxAccessFrecency: number;
}

/** Per-hit score breakdown, positionally aligned with `items`. */
export interface FffScore {
  total: number;
  baseScore: number;
  filenameBonus: number;
  specialFilenameBonus: number;
  frecencyBoost: number;
  distancePenalty: number;
  currentFilePenalty: number;
  comboMatchBoost: number;
  exactMatch: boolean;
  matchType: string;
}

export type FffMixedItem =
  | { type: "file"; item: FffFileItem }
  | { type: "directory"; item: FffDirItem };

// ─────────────────────────────────────────────────────────
// Search results
// ─────────────────────────────────────────────────────────

/**
 * `scores` stays a separate positional array (fff's own shape) so a merger
 * can re-rank across sources without unpacking every item.
 * `truncated` is `items.length < totalMatched`, precomputed so callers do not
 * have to rediscover it.
 */
export interface FffSearchResult {
  items: FffFileItem[];
  scores: FffScore[];
  totalMatched: number;
  totalFiles: number;
  truncated: boolean;
}

export interface FffDirSearchResult {
  items: FffDirItem[];
  scores: FffScore[];
  totalMatched: number;
  totalDirs: number;
  truncated: boolean;
}

export interface FffMixedSearchResult {
  items: FffMixedItem[];
  scores: FffScore[];
  totalMatched: number;
  totalFiles: number;
  totalDirs: number;
  truncated: boolean;
}

// ─────────────────────────────────────────────────────────
// Grep
// ─────────────────────────────────────────────────────────

/**
 * Serializable pagination cursor. The native cursor is a branded object; this
 * carries only the offset so it can round-trip through an MCP tool argument.
 */
export interface FffGrepCursor {
  offset: number;
}

export interface FffGrepMatch {
  path: string;
  relativePath: string;
  fileName: string;
  gitStatus: string;
  size: number;
  /** Epoch milliseconds. */
  modified: number;
  isBinary: boolean;
  totalFrecencyScore: number;
  accessFrecencyScore: number;
  modificationFrecencyScore: number;
  lineNumber: number;
  col: number;
  byteOffset: number;
  lineContent: string;
  matchRanges: Array<[number, number]>;
  fuzzyScore?: number;
  contextBefore?: string[];
  contextAfter?: string[];
  isDefinition?: boolean;
}

/**
 * Coverage, spelled out — grep pages by FILE, not by match.
 *
 * - `totalMatched`  matches on THIS page only (fff 0.10.5 semantics).
 * - `filesSearched` files consumed to build this page.
 * - `filteredFileCount` files eligible for the query after its constraints.
 * - `nextCursor` non-null ⇔ more pages exist. This, not `totalMatched`, is
 *   what makes "showing 12 matches from 3 of 57 files, more available" honest.
 */
export interface FffGrepResult {
  items: FffGrepMatch[];
  totalMatched: number;
  filesSearched: number;
  totalFiles: number;
  filteredFileCount: number;
  nextCursor: FffGrepCursor | null;
  /** More pages remain (or hits were dropped for landing outside the root). */
  truncated: boolean;
  regexFallbackError?: string;
}

/** Grep options with the serializable cursor swapped in. */
export interface FffGrepOptions extends Omit<GrepOptions, "cursor"> {
  cursor?: FffGrepCursor | null;
}

/** Multi-pattern grep options with the serializable cursor swapped in. */
export interface FffMultiGrepOptions extends Omit<MultiGrepOptions, "cursor"> {
  cursor?: FffGrepCursor | null;
}

// ─────────────────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────────────────

/** What `ctx_doctor` needs to render one line about the search layer. */
export interface FffHealthReport {
  /** `CONTEXT_MODE_FFF` is not switched off. */
  enabled: boolean;
  /** The native library actually loaded. */
  available: boolean;
  version?: string;
  error?: string;
  /** Directory holding the persistent frecency/history databases. */
  storageDir: string;
  frecencyDbPath?: string;
  historyDbPath?: string;
  frecencyDiskBytes?: number;
  historyDiskBytes?: number;
  indexedFiles?: number;
  gitRepositoryFound?: boolean;
  /** Project roots with a live native instance in this process. */
  liveRoots: string[];
}

// ─────────────────────────────────────────────────────────
// Native surface (structural — a test double can satisfy it)
// ─────────────────────────────────────────────────────────

export type NativeFileFinder = FileFinderApi;

/** The static half of `FileFinder` we depend on. */
export interface NativeFileFinderStatic {
  create(options: InitOptions): NativeResult<NativeFileFinder>;
  isAvailable(): boolean;
  healthCheckStatic?(testPath?: string): NativeResult<HealthCheck>;
}

/** The shape `native.ts` resolves — the real package or a test double. */
export interface FffNativeModule {
  FileFinder: NativeFileFinderStatic;
  createGrepCursor?: (offset: number) => GrepCursor;
}

export type { InitOptions, NativeResult, GrepCursor };
