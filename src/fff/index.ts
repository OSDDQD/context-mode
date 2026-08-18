/**
 * Public surface of the in-process fff search layer.
 *
 * Consumers (e.g. a `ctx_find` tool) should import from here and from nothing
 * deeper — `native.ts` and `normalize.ts` are implementation detail, and the
 * upstream package's own types must not leak past this boundary.
 *
 * Typical use:
 *
 * ```ts
 * const acquired = await acquireFinder(projectDir);
 * if (!acquired.ok) return fallbackWithoutFff();   // unavailable → degrade
 * const hits = acquired.value.fileSearch("store", { pageSize: 20 });
 * ```
 */

export {
  acquireFinder,
  activeFinderRoots,
  destroyAllFinders,
  destroyFinder,
  FffFinder,
  fffHealthReport,
  getActiveFinder,
  useProject,
  __resetFinderRegistryForTests,
} from "./finder.js";
export type { AcquireFinderOptions } from "./finder.js";

export {
  fffStaticHealthCheck,
  isFffAvailable,
  loadFffNative,
  __resetFffNativeCacheForTests,
  __setFffLoaderForTests,
} from "./native.js";
export type { FffLoader } from "./native.js";

export {
  DEFAULT_MAX_INSTANCES,
  DEFAULT_SCAN_TIMEOUT_MS,
  DEFAULT_WATCH_DEBOUNCE_MS,
  FFF_DIR_ENV,
  FFF_ENABLED_ENV,
  FFF_MAX_INSTANCES_ENV,
  FFF_MMAP_ENV,
  FFF_SCAN_TIMEOUT_ENV,
  FFF_WATCH_DEBOUNCE_ENV,
  FFF_WATCH_ENV,
  isFffEnabled,
  isMmapCacheDisabled,
  isWatchDisabled,
  maxFinderInstances,
  scanTimeoutMs,
  watchDebounceMs,
} from "./env.js";

export {
  absolutePathIn,
  canonicalProjectRoot,
  dbDiskBytes,
  ensureFffStorageDir,
  fffDbPathsFor,
  isInsideRoot,
  resolveFffStorageDir,
} from "./paths.js";
export type { FffDbPaths } from "./paths.js";

export { FsWatchBus } from "./watch.js";
export type {
  FsChangeEvent,
  FsChangeKind,
  FsChangeListener,
  FsWatchBusOptions,
  FsWatchBusStats,
} from "./watch.js";

export { fffErr, fffOk } from "./types.js";
export type {
  DirSearchOptions,
  FffDirItem,
  FffDirSearchResult,
  FffFileItem,
  FffGrepCursor,
  FffGrepMatch,
  FffGrepOptions,
  FffGrepResult,
  FffHealthReport,
  FffMixedItem,
  FffMixedSearchResult,
  FffMultiGrepOptions,
  FffNativeModule,
  FffResult,
  FffScore,
  FffSearchResult,
  GlobOptions,
  GrepMode,
  HealthCheck,
  NativeFileFinder,
  NativeFileFinderStatic,
  ScanProgress,
  SearchOptions,
} from "./types.js";
