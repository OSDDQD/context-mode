/**
 * The fff search layer: one native index per project root, owned explicitly.
 *
 * Why a registry with an explicit `destroy()` and not "just create one when
 * you need it": a `FileFinder` instance holds a full native file index plus a
 * watcher thread on the Rust side. The JS garbage collector cannot see any of
 * that, so an instance that is merely dropped leaks its index for the life of
 * the process. Every instance created here is reachable from `registry` and is
 * destroyed on project switch, on LRU eviction, and on process exit.
 *
 * Isolation: the registry key, the native `basePath`, and the frecency /
 * history database names all derive from the SAME canonical project root.
 * Results and watch events are additionally filtered to paths inside that
 * root. Commit 08ddb5e fixed one project's files landing in another project's
 * knowledge base through the code-index queue; this module must not reopen
 * that hole through the search channel.
 *
 * Degradation: nothing here throws. If the native library is missing, every
 * entry point returns `{ ok: false, unavailable: true }` and the caller
 * proceeds without fff.
 */

import { relative } from "node:path";

import {
  isMmapCacheDisabled,
  isWatchDisabled,
  maxFinderInstances,
  scanTimeoutMs,
  watchDebounceMs,
} from "./env.js";
import { describe, loadFffNative, toNativeCursor } from "./native.js";
import {
  canonicalProjectRoot,
  dbDiskBytes,
  ensureFffStorageDir,
  fffDbPathsFor,
  isInsideRoot,
  resolveFffStorageDir,
} from "./paths.js";
import {
  normalizeDirSearchResult,
  normalizeGrepResult,
  normalizeMixedSearchResult,
  normalizeSearchResult,
} from "./normalize.js";
import type { FsChangeEvent, FsChangeListener } from "./watch.js";
import { FsWatchBus } from "./watch.js";
import type {
  DirSearchOptions,
  FffDirSearchResult,
  FffGrepOptions,
  FffGrepResult,
  FffHealthReport,
  FffMixedSearchResult,
  FffMultiGrepOptions,
  FffNativeModule,
  FffResult,
  FffSearchResult,
  GlobOptions,
  HealthCheck,
  NativeFileFinder,
  NativeResult,
  ScanProgress,
  SearchOptions,
} from "./types.js";
import { fffErr, fffOk } from "./types.js";

// ─────────────────────────────────────────────────────────
// Lock contention
// ─────────────────────────────────────────────────────────

/**
 * Several sessions can sit on the same project root at once — two Claude Code
 * windows, an agent fleet, a CLI run alongside the server. They share one
 * persistent frecency/history database per project, and `trackQuery` is the
 * one call that WRITES to it.
 *
 * fff's stores are LMDB environments (`<hash>-frecency.mdb/` holding
 * `data.mdb` + `lock.mdb`). LMDB serializes writers with an OS-level mutex, so
 * the usual outcome of contention is a short block, not an error — there is no
 * `busy_timeout` knob to set from here, and `useUnsafeNoLock` is deliberately
 * left OFF so the lock file keeps doing its job across processes.
 *
 * What can still surface is a transient lock/timeout error string from the
 * native side. Those are retried with a short jittered backoff; anything else
 * fails fast. Reads are not retried — LMDB readers are MVCC and never block.
 */
const LOCK_ERROR_PATTERNS: RegExp[] = [
  /busy/i,
  /lock/i,
  /would ?block/i,
  /temporarily unavailable/i,
  /timed? ?out/i,
  /\bMDB_\w+/,
];

const RETRY_DELAYS_MS = [25, 75, 200];

function looksLikeLockContention(message: string): boolean {
  return LOCK_ERROR_PATTERNS.some((re) => re.test(message));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
  });
}

async function withLockRetry<T>(
  op: () => NativeResult<T>,
  delays: number[] = RETRY_DELAYS_MS,
): Promise<FffResult<T>> {
  let lastError = "unknown error";
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    let result: NativeResult<T>;
    try {
      result = op();
    } catch (err) {
      return fffErr<T>(describe(err));
    }
    if (result.ok) return fffOk(result.value);
    lastError = result.error;
    if (!looksLikeLockContention(lastError) || attempt === delays.length) break;
    // Jitter so two sessions retrying in lockstep do not keep colliding.
    await sleep(delays[attempt]! + Math.floor(Math.random() * 20));
  }
  return fffErr<T>(lastError);
}

// ─────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────

export interface AcquireFinderOptions {
  /** Override the persistent database directory (tests, sandboxes). */
  storageDir?: string;
  /** Skip the filesystem watcher for this instance. */
  disableWatch?: boolean;
  /** Skip the mmap warmup cache — trades speed for RAM on huge monorepos. */
  disableMmapCache?: boolean;
  /** Milliseconds to wait for the initial scan. `0` returns immediately. */
  waitForScanMs?: number;
  /** fff's LLM-oriented ranking profile. */
  aiMode?: boolean;
  /** Debounce window for this project's event bus. */
  watchDebounceMs?: number;
  env?: NodeJS.ProcessEnv;
}

// ─────────────────────────────────────────────────────────
// Finder
// ─────────────────────────────────────────────────────────

/**
 * A thin, normalized, non-throwing wrapper around one native index.
 *
 * Reads are synchronous (the native calls are); the one write that can meet
 * cross-process contention, `trackQuery`, is async so it can back off.
 */
export class FffFinder {
  readonly projectRoot: string;
  readonly frecencyDbPath: string;
  readonly historyDbPath: string;
  readonly storageDir: string;
  readonly watchBus: FsWatchBus;

  private readonly native: NativeFileFinder;
  private readonly mod: FffNativeModule;
  private unwatch: (() => void) | undefined;
  private watchAttach: (() => (() => void) | null) | undefined;
  private destroyed = false;

  /** @internal — construct through {@link acquireFinder}. */
  constructor(init: {
    projectRoot: string;
    native: NativeFileFinder;
    mod: FffNativeModule;
    storageDir: string;
    frecencyDbPath: string;
    historyDbPath: string;
    watchBus: FsWatchBus;
  }) {
    this.projectRoot = init.projectRoot;
    this.native = init.native;
    this.mod = init.mod;
    this.storageDir = init.storageDir;
    this.frecencyDbPath = init.frecencyDbPath;
    this.historyDbPath = init.historyDbPath;
    this.watchBus = init.watchBus;
  }

  get isDestroyed(): boolean {
    return this.destroyed || this.native.isDestroyed;
  }

  // ── search ────────────────────────────────────────────

  fileSearch(query: string, options?: SearchOptions): FffResult<FffSearchResult> {
    return this.read(() => this.native.fileSearch(query, options), (v) => normalizeSearchResult(this.projectRoot, v));
  }

  glob(pattern: string, options?: GlobOptions): FffResult<FffSearchResult> {
    return this.read(() => this.native.glob(pattern, options), (v) => normalizeSearchResult(this.projectRoot, v));
  }

  directorySearch(query: string, options?: DirSearchOptions): FffResult<FffDirSearchResult> {
    return this.read(
      () => this.native.directorySearch(query, options),
      (v) => normalizeDirSearchResult(this.projectRoot, v),
    );
  }

  mixedSearch(query: string, options?: SearchOptions): FffResult<FffMixedSearchResult> {
    return this.read(
      () => this.native.mixedSearch(query, options),
      (v) => normalizeMixedSearchResult(this.projectRoot, v),
    );
  }

  grep(query: string, options: FffGrepOptions = {}): FffResult<FffGrepResult> {
    const { cursor, ...rest } = options;
    return this.read(
      () => this.native.grep(query, { ...rest, cursor: toNativeCursor(this.mod, cursor) }),
      (v) => normalizeGrepResult(this.projectRoot, v),
    );
  }

  multiGrep(options: FffMultiGrepOptions): FffResult<FffGrepResult> {
    const { cursor, ...rest } = options;
    return this.read(
      () => this.native.multiGrep({ ...rest, cursor: toNativeCursor(this.mod, cursor) }),
      (v) => normalizeGrepResult(this.projectRoot, v),
    );
  }

  // ── index maintenance ─────────────────────────────────

  /** Refresh the cached git status. Returns the number of files updated. */
  refreshGitStatus(): FffResult<number> {
    return this.read(() => this.native.refreshGitStatus(), (v) => v);
  }

  /**
   * Rescan this project's tree.
   *
   * The native `reindex(path)` can retarget an instance at ANOTHER directory.
   * That is exactly the cross-project contamination vector 08ddb5e closed, and
   * it would also desynchronize this instance from its registry key and its
   * frecency database. So a foreign path is refused: acquire a finder for that
   * root instead.
   */
  reindex(newPath?: string): FffResult<void> {
    if (this.isDestroyed) return destroyedError<void>(this.projectRoot);
    if (newPath !== undefined && canonicalProjectRoot(newPath) !== this.projectRoot) {
      return fffErr<void>(
        `refusing to reindex ${this.projectRoot} onto ${newPath}: acquire a finder for that root instead`,
      );
    }
    try {
      const result = this.native.scanFiles();
      return result.ok ? fffOk(undefined) : fffErr<void>(result.error);
    } catch (err) {
      return fffErr<void>(describe(err));
    }
  }

  getScanProgress(): FffResult<ScanProgress> {
    return this.read(() => this.native.getScanProgress(), (v) => v);
  }

  isScanning(): boolean {
    if (this.isDestroyed) return false;
    try {
      return this.native.isScanning();
    } catch {
      return false;
    }
  }

  async waitForScan(timeoutMs = scanTimeoutMs()): Promise<FffResult<boolean>> {
    if (this.isDestroyed) return destroyedError<boolean>(this.projectRoot);
    try {
      const result = await this.native.waitForScan(timeoutMs);
      return result.ok ? fffOk(result.value) : fffErr<boolean>(result.error);
    } catch (err) {
      return fffErr<boolean>(describe(err));
    }
  }

  // ── ranking feedback ──────────────────────────────────

  /**
   * Record that `selectedFilePath` answered `query`, which is what makes the
   * ranking improve over time. Persisted, shared across sessions on this
   * project, hence the lock-aware retry.
   *
   * A path outside the project is refused: writing it would put another
   * project's file into this project's ranking database.
   */
  async trackQuery(query: string, selectedFilePath: string): Promise<FffResult<boolean>> {
    if (this.isDestroyed) return destroyedError<boolean>(this.projectRoot);
    if (!isInsideRoot(selectedFilePath, this.projectRoot)) {
      return fffErr<boolean>(`refusing to track ${selectedFilePath}: outside ${this.projectRoot}`);
    }
    return withLockRetry(() => this.native.trackQuery(query, selectedFilePath));
  }

  // ── health ────────────────────────────────────────────

  healthCheck(testPath?: string): FffResult<HealthCheck> {
    return this.read(() => this.native.healthCheck(testPath ?? this.projectRoot), (v) => v);
  }

  // ── filesystem events ─────────────────────────────────

  /**
   * Subscribe to this project's filesystem events. Returns the unsubscribe
   * handle — the only supported way to detach.
   */
  onFsChange(listener: FsChangeListener): () => void {
    // The native watcher only accepts subscriptions once its initial scan has
    // finished; a caller that subscribes early would otherwise get a bus that
    // is wired to nothing. Retry the attach here, lazily.
    this.ensureWatcher();
    return this.watchBus.subscribe(listener);
  }

  /** True once the native watcher feeds this project's bus. */
  get hasWatcher(): boolean {
    return this.unwatch !== undefined;
  }

  /** @internal — how to (re)subscribe to the native watcher. */
  setWatchAttacher(attach: () => (() => void) | null): void {
    this.watchAttach = attach;
  }

  /** @internal — attach if not attached yet. Returns true when wired up. */
  ensureWatcher(): boolean {
    if (this.unwatch) return true;
    if (this.destroyed || !this.watchAttach) return false;
    const unwatch = this.watchAttach();
    if (!unwatch) return false;
    this.unwatch = unwatch;
    return true;
  }

  // ── lifecycle ─────────────────────────────────────────

  /**
   * Release the native index and the watcher. Idempotent, and the ONLY thing
   * that frees the native memory — dropping the reference does not.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      this.unwatch?.();
    } catch {
      // The native subscription may already be gone; keep tearing down.
    }
    this.unwatch = undefined;
    this.watchAttach = undefined;
    this.watchBus.close();
    try {
      this.native.destroy();
    } catch {
      // Best effort: a native double-destroy must not escape as an exception.
    }
  }

  private read<N, T>(op: () => NativeResult<N>, map: (value: N) => T): FffResult<T> {
    if (this.isDestroyed) return destroyedError<T>(this.projectRoot);
    try {
      const result = op();
      return result.ok ? fffOk(map(result.value)) : fffErr<T>(result.error);
    } catch (err) {
      return fffErr<T>(describe(err));
    }
  }
}

function destroyedError<T>(root: string): FffResult<T> {
  return fffErr<T>(`fff finder for ${root} has been destroyed`, true);
}

// ─────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────

interface RegistryEntry {
  finder: FffFinder;
  lastUsed: number;
}

const registry = new Map<string, RegistryEntry>();
const inFlight = new Map<string, Promise<FffResult<FffFinder>>>();
let exitHookInstalled = false;

/**
 * Destroy everything on the way out. Only `exit` is hooked: adding SIGINT /
 * SIGTERM listeners would suppress Node's default termination behavior for the
 * MCP server, and the OS reclaims native memory on process death anyway. The
 * hook exists for the in-process case (`process.exit()` from a CLI path).
 */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    destroyAllFinders();
  });
}

/**
 * Get (or lazily create) the finder for `projectDir`.
 *
 * Concurrent calls for the same root share one creation promise, so two tool
 * invocations racing at server start cannot open two native indexes.
 */
export async function acquireFinder(
  projectDir: string,
  opts: AcquireFinderOptions = {},
): Promise<FffResult<FffFinder>> {
  const env = opts.env ?? process.env;
  const root = canonicalProjectRoot(projectDir);

  const existing = registry.get(root);
  if (existing) {
    if (!existing.finder.isDestroyed) {
      existing.lastUsed = Date.now();
      return fffOk(existing.finder);
    }
    registry.delete(root);
  }

  const pending = inFlight.get(root);
  if (pending) return pending;

  const creation = createFinder(root, opts, env).finally(() => {
    inFlight.delete(root);
  });
  inFlight.set(root, creation);
  return creation;
}

async function createFinder(
  root: string,
  opts: AcquireFinderOptions,
  env: NodeJS.ProcessEnv,
): Promise<FffResult<FffFinder>> {
  const loaded = await loadFffNative(env);
  if (!loaded.ok) return loaded as FffResult<FffFinder>;
  const mod = loaded.value;

  const paths = fffDbPathsFor(root, { storageDir: opts.storageDir, env });
  // A read-only storage root is survivable: fff falls back to in-memory
  // ranking, we just lose persistence across restarts.
  const persistent = ensureFffStorageDir(paths.storageDir);
  const watchEnabled = !(opts.disableWatch ?? isWatchDisabled(env));

  let created: NativeResult<NativeFileFinder>;
  try {
    created = mod.FileFinder.create({
      basePath: root,
      ...(persistent ? { frecencyDbPath: paths.frecencyDbPath, historyDbPath: paths.historyDbPath } : {}),
      disableMmapCache: opts.disableMmapCache ?? isMmapCacheDisabled(env),
      disableWatch: !watchEnabled,
      ...(opts.aiMode !== undefined ? { aiMode: opts.aiMode } : {}),
    });
  } catch (err) {
    return fffErr<FffFinder>(`fff index creation threw for ${root}: ${describe(err)}`);
  }
  if (!created.ok) return fffErr<FffFinder>(`fff index creation failed for ${root}: ${created.error}`);
  const nativeIndex = created.value;

  const bus = new FsWatchBus({
    root,
    debounceMs: opts.watchDebounceMs ?? watchDebounceMs(env),
  });

  const finder = new FffFinder({
    projectRoot: root,
    native: nativeIndex,
    mod,
    storageDir: paths.storageDir,
    frecencyDbPath: paths.frecencyDbPath,
    historyDbPath: paths.historyDbPath,
    watchBus: bus,
  });

  if (watchEnabled) {
    finder.setWatchAttacher(() => attachNativeWatcher(finder, nativeIndex, root, paths.storageDir));
  }

  installExitHook();
  registry.set(root, { finder, lastUsed: Date.now() });
  evictOverflow(maxFinderInstances(env), root);

  const waitMs = opts.waitForScanMs ?? scanTimeoutMs(env);
  if (waitMs > 0) {
    // A timeout is not an error: searches just see a partially built index and
    // the background scan keeps going.
    await finder.waitForScan(waitMs);
  }

  // The native watcher refuses subscriptions until its initial scan finishes
  // ("File system watcher is not ready"), so the attach happens here rather
  // than at creation, and keeps retrying in the background if the scan is
  // still running. `onFsChange` retries too, so an early subscriber is safe.
  if (watchEnabled && !finder.ensureWatcher()) scheduleWatcherRetry(finder);

  return fffOk(finder);
}

/** Bounded background retry for a watcher whose index was not ready yet. */
function scheduleWatcherRetry(finder: FffFinder, attempt = 0): void {
  if (attempt >= 10 || finder.isDestroyed || finder.hasWatcher) return;
  const timer = setTimeout(() => {
    if (!finder.ensureWatcher()) scheduleWatcherRetry(finder, attempt + 1);
  }, 200 * (attempt + 1));
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
}

/**
 * Bridge the native watcher into the project's event bus.
 *
 * Two filters apply before anything reaches a consumer: paths outside the
 * project root (isolation), and paths inside our own database directory —
 * fff's LMDB files generate write events of their own, and feeding those back
 * to consumers would be a self-sustaining invalidation loop when a user points
 * `CONTEXT_MODE_FFF_DIR` inside the project.
 */
function attachNativeWatcher(
  finder: FffFinder,
  native: NativeFileFinder,
  root: string,
  storageDir: string,
): (() => void) | null {
  const storageInsideRoot = isInsideRoot(storageDir, root);
  try {
    const sub = native.watch((events) => {
      const mapped: FsChangeEvent[] = [];
      for (const event of events) {
        if (event.kind === "rescan") {
          mapped.push({ path: root, relativePath: "", kind: "rescan" });
          continue;
        }
        if (!isInsideRoot(event.path, root)) continue;
        if (storageInsideRoot && isInsideRoot(event.path, storageDir)) continue;
        mapped.push({
          path: event.path,
          relativePath: relative(root, event.path),
          kind: event.kind,
        });
      }
      finder.watchBus.publish(mapped);
    });
    if (sub.ok) return sub.value;
    if (process.env.CONTEXT_MODE_DEBUG) {
      process.stderr.write(`[fff] watch subscription failed for ${root}: ${sub.error}\n`);
    }
    return null;
  } catch (err) {
    // Watching is an enhancement; search still works without it.
    if (process.env.CONTEXT_MODE_DEBUG) {
      process.stderr.write(`[fff] watch subscription threw for ${root}: ${describe(err)}\n`);
    }
    return null;
  }
}

function evictOverflow(limit: number, keepRoot: string): void {
  while (registry.size > limit) {
    let oldestRoot: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [root, entry] of registry) {
      if (root === keepRoot) continue;
      if (entry.lastUsed < oldestAt) {
        oldestAt = entry.lastUsed;
        oldestRoot = root;
      }
    }
    if (!oldestRoot) return;
    destroyFinder(oldestRoot);
  }
}

/** The live finder for a root, if one exists. Never creates. */
export function getActiveFinder(projectDir: string): FffFinder | undefined {
  const entry = registry.get(canonicalProjectRoot(projectDir));
  if (!entry) return undefined;
  if (entry.finder.isDestroyed) {
    registry.delete(entry.finder.projectRoot);
    return undefined;
  }
  return entry.finder;
}

/** Explicitly destroy one project's index. Returns true if there was one. */
export function destroyFinder(projectDir: string): boolean {
  const root = canonicalProjectRoot(projectDir);
  const entry = registry.get(root);
  if (!entry) return false;
  registry.delete(root);
  entry.finder.destroy();
  return true;
}

/**
 * Switch the process to a single active project: acquire `projectDir` and
 * destroy every other live index. Use this on an explicit project change,
 * where holding the previous index is pure leak.
 */
export async function useProject(
  projectDir: string,
  opts: AcquireFinderOptions = {},
): Promise<FffResult<FffFinder>> {
  const root = canonicalProjectRoot(projectDir);
  for (const other of [...registry.keys()]) {
    if (other !== root) destroyFinder(other);
  }
  return acquireFinder(root, opts);
}

/** Destroy every live index. Returns how many were destroyed. */
export function destroyAllFinders(): number {
  let count = 0;
  for (const root of [...registry.keys()]) {
    if (destroyFinder(root)) count += 1;
  }
  return count;
}

/** Canonical roots with a live index in this process. */
export function activeFinderRoots(): string[] {
  return [...registry.keys()];
}

// ─────────────────────────────────────────────────────────
// Doctor
// ─────────────────────────────────────────────────────────

/**
 * One-shot status for `ctx_doctor`: is the layer on, did the binary load,
 * where does the persistent ranking live and how big is it.
 *
 * Deliberately does NOT create an index — passing a `projectDir` only enriches
 * the report when that project already has a live finder.
 */
export async function fffHealthReport(projectDir?: string): Promise<FffHealthReport> {
  const env = process.env;
  const storageDir = resolveFffStorageDir(env);
  const report: FffHealthReport = {
    enabled: true,
    available: false,
    storageDir,
    liveRoots: activeFinderRoots(),
  };

  const loaded = await loadFffNative(env);
  if (!loaded.ok) {
    report.enabled = !/disabled via/.test(loaded.error);
    report.error = loaded.error;
    return report;
  }
  report.available = true;

  const finder = projectDir ? getActiveFinder(projectDir) : undefined;
  if (projectDir) {
    // A live finder knows where its databases actually landed (a caller may
    // have overridden the directory); otherwise fall back to the default.
    const paths = finder ?? fffDbPathsFor(canonicalProjectRoot(projectDir), { env });
    report.storageDir = finder ? finder.storageDir : report.storageDir;
    report.frecencyDbPath = paths.frecencyDbPath;
    report.historyDbPath = paths.historyDbPath;
    report.frecencyDiskBytes = dbDiskBytes(paths.frecencyDbPath);
    report.historyDiskBytes = dbDiskBytes(paths.historyDbPath);
  }

  const health = finder
    ? finder.healthCheck()
    : await (async () => {
      const statik = loaded.value.FileFinder.healthCheckStatic;
      if (!statik) return fffErr<HealthCheck>("no static health check", true);
      try {
        const res = statik.call(loaded.value.FileFinder, projectDir);
        return res.ok ? fffOk(res.value) : fffErr<HealthCheck>(res.error);
      } catch (err) {
        return fffErr<HealthCheck>(describe(err));
      }
    })();

  if (health.ok) {
    report.version = health.value.version;
    report.gitRepositoryFound = health.value.git.repositoryFound;
    if (health.value.filePicker.indexedFiles !== undefined) {
      report.indexedFiles = health.value.filePicker.indexedFiles;
    }
  } else {
    report.error = health.error;
  }
  return report;
}

/** Test seam: drop every registry entry without relying on process exit. */
export function __resetFinderRegistryForTests(): void {
  destroyAllFinders();
  inFlight.clear();
}
