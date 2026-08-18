/**
 * One filesystem event source for the whole plugin, wired to its consumers.
 *
 * ## Why this module is not in `src/fff/`
 *
 * `src/fff/**` is a self-contained engine: it imports nothing from the rest of
 * the plugin, which is exactly what lets its whole test suite run against a
 * fake native module. Putting the consumer wiring in there would make the
 * search layer depend on the content store, the session code index and the
 * codegraph daemon — the inversion its own header warns against ("consumers
 * live elsewhere entirely"). So the engine stays a library and this module,
 * one layer up, is the only place that knows both sides.
 *
 * ## What it wires
 *
 * `fff`'s native watcher is the single watcher in this process. It is already
 * running to keep the file index fresh, it honours `.gitignore`, and
 * `FsWatchBus` debounces and coalesces its output. Three consumers hang off
 * that one subscription:
 *
 * 1. **FTS5 chunk invalidation** — a changed file is re-indexed under its
 *    `code:` label, a deleted one is evicted. Without this, `ctx_search` keeps
 *    answering from bytes that are gone; the queue in `src/session/code-index.ts`
 *    only ever sees files the AGENT edited, never a `git checkout`, a formatter
 *    or a second editor window.
 * 2. **The `codegraph sync` queue** — `attachFsSource` in `src/graph/daemon.ts`,
 *    which coalesces and runs one PROJECT-level sync (codegraph 1.5.0 has no
 *    per-file sync), and no-ops entirely when a live daemon is already watching.
 * 3. **Per-path caches** — a registry, see {@link registerPathCache}. It ships
 *    EMPTY: there is today no cache of file content or results for
 *    `ctx_execute_file` to invalidate. `Executor.executeFile` wraps the caller's
 *    code so the sandbox subprocess reads the file itself on every run, and
 *    `src/fetch-cache.ts` keys HTTP fetches by URL, not by path. The seam exists
 *    so the first such cache has somewhere to attach instead of growing a second
 *    watcher.
 *
 * ## Degradation is the default, not an option
 *
 * `acquireFinder` never throws and reports `unavailable` when the native binary
 * is missing or the layer is switched off. Every failure here — no fff, watcher
 * disabled, subscription refused — produces a working handle whose `status()`
 * says `active: false`. Nothing upstream needs a try/catch.
 *
 * ## Isolation
 *
 * Everything is keyed on `canonicalProjectRoot`. Events are already confined to
 * the root twice inside fff (the native bridge drops foreign paths, `FsWatchBus`
 * drops them again), and the index consumer checks `isInsideRoot` once more
 * before touching a store — the same guard, imported, never re-implemented.
 */

import type { AcquireFinderOptions, FffFinder, FsChangeEvent } from "../fff/index.js";
import {
  acquireFinder,
  canonicalProjectRoot,
  isFffEnabled,
  isInsideRoot,
  isWatchDisabled,
} from "../fff/index.js";
import { attachFsSource } from "../graph/daemon.js";
import type { IndexTarget } from "../session/code-index.js";
import { invalidateCodeSource, pruneDeletedCodeSources } from "../session/code-index.js";
import {
  isCacheConsumerEnabled,
  isFsBusEnabled,
  isGraphConsumerEnabled,
  isIndexConsumerEnabled,
  maxFilesPerBatch,
} from "./env.js";

export {
  DEFAULT_MAX_FILES_PER_BATCH,
  FS_BUS_CACHE_ENV,
  FS_BUS_ENV,
  FS_BUS_GRAPH_ENV,
  FS_BUS_INDEX_ENV,
  FS_BUS_MAX_FILES_ENV,
  isCacheConsumerEnabled,
  isFsBusEnabled,
  isGraphConsumerEnabled,
  isIndexConsumerEnabled,
  maxFilesPerBatch,
} from "./env.js";

// ─────────────────────────────────────────────────────────
// Path cache registry (consumer 3)
// ─────────────────────────────────────────────────────────

/**
 * A cache keyed by absolute file path that wants to be told when a file
 * changes.
 *
 * Registration is process-wide, not per project: paths are absolute, so a cache
 * can serve every root without the wiring having to shard it.
 */
export interface PathCache {
  /** Diagnostic name, surfaced by {@link registeredPathCaches}. */
  name: string;
  /** A file was created, modified or deleted. */
  invalidate(filePath: string): void;
  /** The watcher lost track and asked for a full rescan. Drop everything. */
  clear?(): void;
}

const pathCaches = new Set<PathCache>();

/**
 * Register a per-path cache. Returns the unregister handle, which is the only
 * supported way to detach and is safe to call twice.
 */
export function registerPathCache(cache: PathCache): () => void {
  pathCaches.add(cache);
  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    pathCaches.delete(cache);
  };
}

/** Names of the currently registered caches. Diagnostics and tests. */
export function registeredPathCaches(): string[] {
  return [...pathCaches].map((c) => c.name);
}

/** Drop every registration. Tests only. */
export function __resetPathCachesForTests(): void {
  pathCaches.clear();
}

// ─────────────────────────────────────────────────────────
// Public surface
// ─────────────────────────────────────────────────────────

export interface FsWiringOptions {
  /** Project root. Canonicalized before anything else uses it. */
  projectDir: string;
  env?: NodeJS.ProcessEnv;
  /**
   * How to reach the content store for THIS project, evaluated per batch.
   *
   * A getter rather than a value because the server opens its store lazily, and
   * because returning `null` is a meaningful answer: with no store open there
   * is no index to invalidate, and whatever opens one later re-reads from disk
   * anyway. Prefer a non-creating accessor (`peekStore`) — a watcher callback
   * is the wrong place to pay for opening a database.
   */
  getStore?: () => IndexTarget | null | undefined;
  /** Attribution stamped on chunks re-indexed by the FTS5 consumer. */
  attribution?: { sessionId?: string; eventId?: string };
  /** Files re-indexed per batch. Defaults to `CONTEXT_MODE_FS_BUS_MAX_FILES`. */
  maxFilesPerBatch?: number;
  /** Passed through to `acquireFinder` (storage dir, debounce — tests). */
  finderOptions?: AcquireFinderOptions;
  /** Seam for tests that want to drive a finder they already hold. */
  acquire?: (
    projectDir: string,
    opts?: AcquireFinderOptions,
  ) => Promise<{ ok: true; value: FffFinder } | { ok: false; error: string; unavailable: boolean }>;
}

export interface FsWiringStatus {
  /** A live subscription is delivering events to the consumers. */
  active: boolean;
  /** Canonical project root this wiring is bound to. */
  projectRoot: string;
  /** Why it is not active. Absent while active. */
  reason?: string;
  /** fff reported itself unavailable — missing binary, or switched off. */
  unavailable: boolean;
  /** Per-consumer enablement, re-read from the env on every call. */
  consumers: { index: boolean; graph: boolean; cache: boolean };
  /** How many `installFsWiring` handles are still attached to this root. */
  refs: number;
  /** Batches delivered by the bus. */
  batches: number;
  /** Events across those batches. */
  events: number;
  /** Files re-indexed into FTS5. */
  reindexed: number;
  /** Files whose content hash was unchanged, so only `indexed_at` moved. */
  unchanged: number;
  /** `code:` sources evicted (deleted, or grown past the size cap). */
  evicted: number;
  /** Paths handed to the codegraph sync queue. */
  enqueued: number;
  /** `invalidate` calls made against registered path caches. */
  cacheInvalidations: number;
  /** Rescan batches seen. */
  rescans: number;
  /** Files a batch dropped because it hit `maxFilesPerBatch`. */
  overflowed: number;
  /** Last consumer error, for `ctx_doctor`. Never thrown. */
  lastError?: string;
}

export interface FsWiringHandle {
  /** Detach this handle. Idempotent; the last one out tears the wiring down. */
  detach(): void;
  /** Live snapshot. Safe to call after `detach`. */
  status(): FsWiringStatus;
}

// ─────────────────────────────────────────────────────────
// Installation
// ─────────────────────────────────────────────────────────

interface Counters {
  batches: number;
  events: number;
  reindexed: number;
  unchanged: number;
  evicted: number;
  enqueued: number;
  cacheInvalidations: number;
  rescans: number;
  overflowed: number;
  lastError?: string;
}

interface Installation {
  root: string;
  env: NodeJS.ProcessEnv;
  options: FsWiringOptions;
  counters: Counters;
  refs: number;
  detached: boolean;
  unsubscribeBus: () => void;
  detachGraph: (() => void) | null;
  /** Handlers registered by `attachFsSource`; one per graph attachment. */
  fileListeners: Set<(filePath: string) => void>;
}

/**
 * What one `create` pass produced. Handles are minted per CALLER, not per
 * installation: two concurrent installs share the subscription but must own
 * separate handles, or the first `detach` would silently unsubscribe the other.
 */
type CreateOutcome =
  | { kind: "installed"; installation: Installation }
  | { kind: "inert"; handle: FsWiringHandle };

const installations = new Map<string, Installation>();
const inFlight = new Map<string, Promise<CreateOutcome>>();
/** Bumped by {@link detachAllFsWiring}, so an in-flight install can see it. */
let resetGeneration = 0;

function newCounters(): Counters {
  return {
    batches: 0,
    events: 0,
    reindexed: 0,
    unchanged: 0,
    evicted: 0,
    enqueued: 0,
    cacheInvalidations: 0,
    rescans: 0,
    overflowed: 0,
  };
}

/**
 * Subscribe the plugin's consumers to this project's filesystem events.
 *
 * Idempotent per canonical root: a second call attaches a second handle to the
 * SAME subscription rather than opening another one, and the wiring is torn
 * down when the last handle detaches. Concurrent calls share one installation
 * promise, so two tool invocations racing at server start cannot double-wire.
 *
 * Never rejects. When fff is unavailable or the watcher is off, the returned
 * handle is inert and `status().active` is false.
 */
export async function installFsWiring(options: FsWiringOptions): Promise<FsWiringHandle> {
  const env = options.env ?? process.env;
  const root = canonicalProjectRoot(options.projectDir);

  const existing = installations.get(root);
  if (existing && !existing.detached) return attachHandle(existing);

  let creation = inFlight.get(root);
  if (!creation) {
    creation = create(root, { ...options, env }).finally(() => {
      inFlight.delete(root);
    });
    inFlight.set(root, creation);
  }

  const outcome = await creation;
  if (outcome.kind === "inert") return outcome.handle;
  // Torn down while this caller was waiting: hand back an inert handle rather
  // than one attached to a subscription that no longer exists.
  if (outcome.installation.detached) return inertHandle(root, "detached", false, env);
  return attachHandle(outcome.installation);
}

async function create(root: string, options: FsWiringOptions): Promise<CreateOutcome> {
  const env = options.env ?? process.env;
  // A `detachAllFsWiring()` that lands while this await is in flight must not
  // be overtaken by the installation it was meant to cancel — otherwise the
  // subscription survives with a refcount of zero and nothing left to detach it.
  const generation = resetGeneration;

  const inert = (reason: string, unavailable: boolean): CreateOutcome => ({
    kind: "inert",
    handle: inertHandle(root, reason, unavailable, env),
  });

  if (!isFsBusEnabled(env)) {
    return inert("fs wiring disabled via CONTEXT_MODE_FS_BUS", false);
  }
  if (!isFffEnabled(env)) {
    return inert("fff search layer disabled via CONTEXT_MODE_FFF", true);
  }
  if (isWatchDisabled(env)) {
    // No point acquiring a finder: with the watcher off it would never emit.
    return inert("fff watcher disabled via CONTEXT_MODE_FFF_WATCH", true);
  }

  const acquire = options.acquire ?? acquireFinder;
  const acquired = await acquire(root, { ...options.finderOptions, env });
  if (!acquired.ok) {
    return inert(acquired.error, acquired.unavailable);
  }

  const installation: Installation = {
    root,
    env,
    options,
    counters: newCounters(),
    refs: 0,
    detached: false,
    unsubscribeBus: () => { /* replaced below */ },
    detachGraph: null,
    fileListeners: new Set(),
  };

  installation.unsubscribeBus = acquired.value.onFsChange((events) => {
    deliver(installation, events);
  });

  // The graph queue takes a `(path) => void` handler and hands back its own
  // unsubscribe. Routing it through `fileListeners` keeps `daemon.ts` free of
  // any type from this module, which is the contract it was written against.
  installation.detachGraph = attachFsSource(
    (handler) => {
      installation.fileListeners.add(handler);
      return () => { installation.fileListeners.delete(handler); };
    },
    { projectDir: root, env },
  );

  if (generation !== resetGeneration) {
    teardown(installation);
    return inert("detached while installing", false);
  }
  installations.set(root, installation);
  return { kind: "installed", installation };
}

function attachHandle(installation: Installation): FsWiringHandle {
  installation.refs += 1;
  let released = false;
  return {
    detach(): void {
      if (released) return;
      released = true;
      installation.refs -= 1;
      if (installation.refs <= 0) teardown(installation);
    },
    status(): FsWiringStatus {
      return snapshot(installation);
    },
  };
}

function teardown(installation: Installation): void {
  if (installation.detached) return;
  installation.detached = true;
  installation.refs = 0;
  try { installation.unsubscribeBus(); } catch { /* bus already closed */ }
  try { installation.detachGraph?.(); } catch { /* source already gone */ }
  installation.fileListeners.clear();
  if (installations.get(installation.root) === installation) {
    installations.delete(installation.root);
  }
}

function snapshot(installation: Installation): FsWiringStatus {
  const env = installation.env;
  return {
    active: !installation.detached,
    projectRoot: installation.root,
    ...(installation.detached ? { reason: "detached" } : {}),
    unavailable: false,
    consumers: {
      index: isIndexConsumerEnabled(env),
      graph: isGraphConsumerEnabled(env),
      cache: isCacheConsumerEnabled(env),
    },
    refs: installation.refs,
    ...installation.counters,
  };
}

function inertHandle(
  root: string,
  reason: string,
  unavailable: boolean,
  env: NodeJS.ProcessEnv,
): FsWiringHandle {
  const status: FsWiringStatus = {
    active: false,
    projectRoot: root,
    reason,
    unavailable,
    consumers: {
      index: isIndexConsumerEnabled(env),
      graph: isGraphConsumerEnabled(env),
      cache: isCacheConsumerEnabled(env),
    },
    refs: 0,
    ...newCounters(),
  };
  return {
    detach(): void { /* nothing was ever attached */ },
    status(): FsWiringStatus { return { ...status, consumers: { ...status.consumers } }; },
  };
}

/** The live wiring for a root, if there is one. Never creates. Diagnostics. */
export function activeFsWiring(projectDir: string): FsWiringStatus | undefined {
  const installation = installations.get(canonicalProjectRoot(projectDir));
  return installation ? snapshot(installation) : undefined;
}

/** Roots with a live wiring in this process. */
export function activeFsWiringRoots(): string[] {
  return [...installations.keys()];
}

/** Tear every wiring down. Tests, and any explicit process-wide reset. */
export function detachAllFsWiring(): number {
  resetGeneration += 1;
  let count = 0;
  for (const installation of [...installations.values()]) {
    teardown(installation);
    count += 1;
  }
  inFlight.clear();
  return count;
}

// ─────────────────────────────────────────────────────────
// Fan-out
// ─────────────────────────────────────────────────────────

function deliver(installation: Installation, events: FsChangeEvent[]): void {
  if (installation.detached || events.length === 0) return;
  const env = installation.env;
  const counters = installation.counters;
  counters.batches += 1;
  counters.events += events.length;

  const rescan = events.some((e) => e.kind === "rescan");
  if (rescan) counters.rescans += 1;

  // Each consumer is isolated: one that throws must not cost the others their
  // event. The bus already swallows exceptions at the listener boundary, but
  // that granularity is the whole batch, not one consumer.
  if (isIndexConsumerEnabled(env)) {
    guard(counters, () => runIndexConsumer(installation, events, rescan));
  }
  if (isGraphConsumerEnabled(env)) {
    guard(counters, () => runGraphConsumer(installation, events, rescan));
  }
  if (isCacheConsumerEnabled(env)) {
    guard(counters, () => runCacheConsumer(installation, events, rescan));
  }
}

function guard(counters: Counters, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    counters.lastError = err instanceof Error ? err.message : String(err);
  }
}

/** Consumer 1: FTS5 chunks. */
function runIndexConsumer(
  installation: Installation,
  events: FsChangeEvent[],
  rescan: boolean,
): void {
  const store = installation.options.getStore?.();
  if (!store) return;
  const root = installation.root;
  const counters = installation.counters;

  if (rescan) {
    // The watcher lost track, so a per-path answer is not available. Deletions
    // are the half the store cannot recover on its own (`#refreshStaleSources`
    // deliberately keeps chunks for a missing file); modifications it re-reads
    // itself on the next search via the mtime gate.
    counters.evicted += pruneDeletedCodeSources({ store, projectDir: root });
    return;
  }

  const budget = installation.options.maxFilesPerBatch ?? maxFilesPerBatch(installation.env);
  let reindexBudget = budget;

  for (const event of events) {
    // Defense in depth. fff filters twice already; this store is this project's
    // and must never be handed a path from another root.
    if (!isInsideRoot(event.path, root)) continue;

    if (event.kind === "removed") {
      // Evictions are a single DELETE and cost nothing to run in bulk, so they
      // are not rationed — a stale answer is worse than a slow batch.
      if (invalidateCodeSource({ store, filePath: event.path, projectDir: root, removed: true }) === "evicted") {
        counters.evicted += 1;
      }
      continue;
    }

    if (reindexBudget <= 0) {
      counters.overflowed += 1;
      continue;
    }
    reindexBudget -= 1;
    const outcome = invalidateCodeSource({
      store,
      filePath: event.path,
      projectDir: root,
      attribution: installation.options.attribution,
    });
    if (outcome === "indexed") counters.reindexed += 1;
    else if (outcome === "unchanged") counters.unchanged += 1;
    else if (outcome === "evicted") counters.evicted += 1;
  }
}

/** Consumer 2: the codegraph sync queue. */
function runGraphConsumer(
  installation: Installation,
  events: FsChangeEvent[],
  rescan: boolean,
): void {
  if (installation.fileListeners.size === 0) return;
  const counters = installation.counters;

  // codegraph 1.5.0 syncs a PROJECT, not a file: the queue coalesces every path
  // it is given into one run. Forwarding a whole 5000-file batch would buy
  // nothing and pay a daemon-liveness probe per path, so the batch is capped
  // the same way the index consumer is — the paths are evidence, not work.
  const budget = installation.options.maxFilesPerBatch ?? maxFilesPerBatch(installation.env);
  const paths = rescan
    ? [installation.root]
    : events.filter((e) => isInsideRoot(e.path, installation.root)).slice(0, budget).map((e) => e.path);

  for (const path of paths) {
    for (const listener of [...installation.fileListeners]) {
      listener(path);
    }
    counters.enqueued += 1;
  }
}

/** Consumer 3: per-path caches. Empty by default — see the module header. */
function runCacheConsumer(
  installation: Installation,
  events: FsChangeEvent[],
  rescan: boolean,
): void {
  if (pathCaches.size === 0) return;
  const counters = installation.counters;

  for (const cache of [...pathCaches]) {
    try {
      if (rescan) {
        cache.clear?.();
        continue;
      }
      for (const event of events) {
        if (!isInsideRoot(event.path, installation.root)) continue;
        cache.invalidate(event.path);
        counters.cacheInvalidations += 1;
      }
    } catch (err) {
      // One broken cache must not deny its peers the event.
      counters.lastError = err instanceof Error ? err.message : String(err);
    }
  }
}
