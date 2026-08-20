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
 * 3. **Per-path caches** — a registry, see {@link registerPathCache}. Its first
 *    and, so far, only member is the re-read cache below: a path that was read
 *    once and has not moved since answers "unchanged, hash X" instead of the
 *    content a second time, because repeated reads of unchanged files are one
 *    of the largest context expenses there is. Invalidation is free — this
 *    watcher already knows what changed. The registry itself stays public so the
 *    next such cache attaches here instead of growing a second watcher; when
 *    nothing is registered (nobody has read a file yet, or
 *    `CONTEXT_MODE_READ_CACHE=0`) the consumer short-circuits on an empty set
 *    and costs one `Set#size` per batch.
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

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

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
  isReadCacheEnabled,
  maxFilesPerBatch,
  readCacheMaxEntries,
} from "./env.js";

export {
  DEFAULT_MAX_FILES_PER_BATCH,
  DEFAULT_READ_CACHE_ENTRIES,
  FS_BUS_CACHE_ENV,
  FS_BUS_ENV,
  FS_BUS_GRAPH_ENV,
  FS_BUS_INDEX_ENV,
  FS_BUS_MAX_FILES_ENV,
  READ_CACHE_ENV,
  READ_CACHE_MAX_ENV,
  isCacheConsumerEnabled,
  isFsBusEnabled,
  isGraphConsumerEnabled,
  isIndexConsumerEnabled,
  isReadCacheEnabled,
  maxFilesPerBatch,
  readCacheMaxEntries,
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
// Re-read cache (the first member of that registry)
// ─────────────────────────────────────────────────────────

/**
 * What a reader tells the cache after it has read a file.
 *
 * `readAt` should be the clock reading taken BEFORE the file was opened, not
 * after: everything between that instant and the byte the reader got is a
 * window in which a write could have landed and been delivered to
 * {@link invalidate} before this record existed. Recording the earlier
 * timestamp makes such a write win the comparison in `recordRead` and mark the
 * entry dirty. Omitting it defaults to "now", which is only safe when the read
 * was instantaneous.
 */
export interface ReadRecord {
  /** Absolute path that was read. Resolved through `realpath` before keying. */
  path: string;
  /** Content hash. Opaque to the cache; only ever compared for equality. */
  hash: string;
  /** Bytes read, carried back verbatim in the `unchanged` answer. */
  bytes?: number;
  /** Clock reading from before the file was opened. Defaults to `Date.now()`. */
  readAt?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Why the cache refused to answer. Every one of these means "read the file";
 * none of them is an error.
 *
 * - `disabled` — `CONTEXT_MODE_READ_CACHE=0`.
 * - `no-record` — never read through this cache, or evicted, or dropped by a
 *   rescan.
 * - `no-watcher` — no live wiring covers this path, or the cache consumer is
 *   switched off for it, so nothing would ever invalidate the entry. Also the
 *   answer on a platform where the native watcher never came up: the wiring is
 *   inert there and never reaches `installations`.
 * - `watcher-restarted` — the wiring covering this path was torn down and
 *   installed again since the read. Whatever changed in between produced no
 *   event anyone received.
 */
export type ReadCacheUnknownReason =
  | "disabled"
  | "no-record"
  | "no-watcher"
  | "watcher-restarted";

/**
 * The answer to "do I have to read this file again?".
 *
 * A wrong `unchanged` hands the agent bytes that no longer exist on disk, which
 * is far worse than the redundant read a wrong `unknown` costs. Every doubt
 * therefore resolves to `unknown`.
 */
export type ReadCacheAnswer =
  | { state: "unchanged"; hash: string; readAt: number; bytes?: number }
  | { state: "changed"; previousHash?: string; changedAt: number }
  | { state: "unknown"; reason: ReadCacheUnknownReason };

interface ReadEntry {
  /**
   * Hash of the content the reader saw. Absent on a tombstone — an entry minted
   * by {@link invalidate} for a path nobody had read yet, kept so that a read
   * which STARTED before that event cannot be recorded as clean.
   */
  hash?: string;
  bytes?: number;
  /** `readAt` of the record. `0` on a tombstone. */
  readAt: number;
  /**
   * Coverage epoch of the wiring that was watching this path at record time.
   * `null` means nothing was watching, which can never become `unchanged`.
   */
  epoch: number | null;
  /** A watcher event landed on this path after the recorded read. */
  dirty: boolean;
  /** When that event landed. `0` if none has. */
  invalidatedAt: number;
}

export interface ReadCacheStats {
  enabled: boolean;
  /** Entries currently held, tombstones included. */
  entries: number;
  capacity: number;
  /** Registered with the path-cache registry, i.e. receiving invalidations. */
  attached: boolean;
  records: number;
  unchanged: number;
  changed: number;
  unknown: number;
  invalidations: number;
  /** Rescans, each of which dropped every entry. */
  clears: number;
  evictions: number;
}

/** Insertion order IS the LRU order: a touched key is deleted and re-set. */
const readEntries = new Map<string, ReadEntry>();

const readStats = {
  records: 0,
  unchanged: 0,
  changed: 0,
  unknown: 0,
  invalidations: 0,
  clears: 0,
  evictions: 0,
};

const readCache: PathCache = {
  name: "read-cache",
  invalidate(filePath: string): void {
    // The watcher reports canonical absolute paths, and `recordRead` keys on
    // `realpath`, so both sides spell the same file the same way. `resolve` is
    // the cheap half of that agreement — a removed file has no realpath left.
    const key = resolve(filePath);
    const now = Date.now();
    const existing = readEntries.get(key);
    touchEntry(key, {
      ...(existing ?? { readAt: 0, epoch: null }),
      dirty: true,
      invalidatedAt: now,
    }, envForPath(key));
    readStats.invalidations += 1;
  },
  clear(): void {
    // A rescan means the watcher lost track: it can no longer say WHICH files
    // moved, so no surviving entry could be trusted to still describe disk.
    readEntries.clear();
    readStats.clears += 1;
  },
};

/**
 * Attach to the registry on first use, and verify the attachment on every call
 * afterwards.
 *
 * The check is by identity rather than by a `registered` flag because
 * {@link __resetPathCachesForTests} (and any future explicit detach) empties the
 * registry behind our back. A stale flag there would leave the cache answering
 * `unchanged` from entries no watcher event can reach any more — exactly the
 * stale answer this module must never produce. Re-attaching also drops the
 * entries, since anything that happened while detached went unheard.
 *
 * Attaching lazily leaves one window: events that land before the FIRST call of
 * the process reach nobody. It costs nothing — a path with no entry answers
 * `no-record` — as long as the caller asks {@link checkRead} BEFORE it reads,
 * which is the only order in which the cache saves anything anyway. That call
 * attaches, so the read it guards is already covered.
 */
function ensureAttached(): void {
  if (pathCaches.has(readCache)) return;
  readEntries.clear();
  registerPathCache(readCache);
}

/** Move a key to the LRU tail, then evict from the head down to the cap. */
function touchEntry(key: string, entry: ReadEntry, env?: NodeJS.ProcessEnv): void {
  readEntries.delete(key);
  readEntries.set(key, entry);
  const cap = readCacheMaxEntries(env ?? process.env);
  while (readEntries.size > cap) {
    const oldest = readEntries.keys().next();
    if (oldest.done) break;
    readEntries.delete(oldest.value);
    readStats.evictions += 1;
  }
}

/**
 * The epoch of the live wiring watching this path, or `null` when none is.
 *
 * Bound to the INSTALLATION, not to the root string: a wiring that was torn
 * down and re-installed gets a new epoch, so entries recorded under the old one
 * stop being answerable. Nothing delivers events for the gap in between, and a
 * file edited inside it would otherwise read as unchanged forever.
 */
function coverageEpoch(absolutePath: string): number | null {
  const installation = coveringInstallation(absolutePath);
  if (installation === undefined) return null;
  // `CONTEXT_MODE_FS_BUS_CACHE=0` keeps the bus but stops the fan-out to path
  // caches, so entries under this root would never be invalidated again.
  if (!isCacheConsumerEnabled(installation.env)) return null;
  return installation.epoch;
}

function coveringInstallation(absolutePath: string): Installation | undefined {
  for (const installation of installations.values()) {
    if (installation.detached) continue;
    if (isInsideRoot(absolutePath, installation.root) || absolutePath === installation.root) {
      return installation;
    }
  }
  return undefined;
}

/**
 * Which env decides the cap for this path. `invalidate` arrives from the
 * watcher with no caller and therefore no env of its own; the wiring that
 * delivered the event is the one whose configuration applies. In a server both
 * are the same object — they diverge only where a wiring was installed with an
 * env of its own, which is how the tests reach this at all.
 */
function envForPath(absolutePath: string): NodeJS.ProcessEnv {
  return coveringInstallation(absolutePath)?.env ?? process.env;
}

/** `realpath`, so a symlinked spelling cannot key a second entry for one file. */
function readKey(filePath: string): string | null {
  const abs = resolve(filePath);
  try {
    return realpathSync.native(abs);
  } catch {
    return null;
  }
}

/**
 * Remember that `path` was read and what its content hashed to.
 *
 * Cheap and safe to call on every read: a path no live watcher covers is still
 * recorded, but is stamped with a `null` epoch and can only ever answer
 * `unknown`.
 */
export function recordRead(record: ReadRecord): void {
  const env = record.env ?? process.env;
  if (!isReadCacheEnabled(env)) return;
  ensureAttached();

  // No realpath means the file is already gone; keying it would invent a path
  // the watcher will never name.
  const key = readKey(record.path);
  if (key === null) return;

  const readAt = record.readAt ?? Date.now();
  const previous = readEntries.get(key);
  // `>=`, not `>`: `Date.now()` has millisecond resolution, so an invalidation
  // stamped in the same millisecond as the read gives no ordering at all, and
  // the safe reading of a tie is "the write came second".
  const missedWrite = previous !== undefined && previous.invalidatedAt >= readAt;

  touchEntry(key, {
    hash: record.hash,
    ...(record.bytes === undefined ? {} : { bytes: record.bytes }),
    readAt,
    epoch: coverageEpoch(key),
    dirty: missedWrite,
    invalidatedAt: previous?.invalidatedAt ?? 0,
  }, env);
  readStats.records += 1;
}

/**
 * Ask whether `path` still holds the content its last recorded read saw.
 *
 * Pass `sinceHash` when the caller knows what IT last saw: a recorded hash that
 * differs from it belongs to somebody else's read, and the caller is owed the
 * content, not an `unchanged`.
 */
export function checkRead(
  filePath: string,
  options: { sinceHash?: string; env?: NodeJS.ProcessEnv } = {},
): ReadCacheAnswer {
  const env = options.env ?? process.env;
  if (!isReadCacheEnabled(env)) return unknown("disabled");
  ensureAttached();

  const key = readKey(filePath);
  if (key === null) return unknown("no-record");
  const entry = readEntries.get(key);
  if (entry === undefined) return unknown("no-record");

  const epoch = coverageEpoch(key);
  if (epoch === null) return unknown("no-watcher");
  if (entry.epoch === null) return unknown("no-watcher");
  if (entry.epoch !== epoch) return unknown("watcher-restarted");

  if (entry.dirty || entry.hash === undefined) {
    readStats.changed += 1;
    return {
      state: "changed",
      ...(entry.hash === undefined ? {} : { previousHash: entry.hash }),
      changedAt: entry.invalidatedAt,
    };
  }
  if (options.sinceHash !== undefined && options.sinceHash !== entry.hash) {
    readStats.changed += 1;
    return { state: "changed", previousHash: entry.hash, changedAt: entry.readAt };
  }

  // Touch on hit, so the paths an agent keeps coming back to are the last ones
  // evicted.
  touchEntry(key, entry, env);
  readStats.unchanged += 1;
  return {
    state: "unchanged",
    hash: entry.hash,
    readAt: entry.readAt,
    ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }),
  };
}

function unknown(reason: ReadCacheUnknownReason): ReadCacheAnswer {
  readStats.unknown += 1;
  return { state: "unknown", reason };
}

/**
 * Forget one path. For writers that already know they invalidated it — an edit
 * applied by the agent itself lands before the watcher's debounce window
 * closes, and the reader must not be told "unchanged" in between.
 */
export function forgetRead(filePath: string): void {
  const abs = resolve(filePath);
  readEntries.delete(abs);
  const real = readKey(filePath);
  if (real !== null && real !== abs) readEntries.delete(real);
}

/** Diagnostics — `ctx_doctor`, `ctx_stats`, tests. */
export function readCacheStats(env: NodeJS.ProcessEnv = process.env): ReadCacheStats {
  return {
    enabled: isReadCacheEnabled(env),
    entries: readEntries.size,
    capacity: readCacheMaxEntries(env),
    attached: pathCaches.has(readCache),
    ...readStats,
  };
}

/** Drop entries, counters and the registration. Tests only. */
export function __resetReadCacheForTests(): void {
  readEntries.clear();
  pathCaches.delete(readCache);
  readStats.records = 0;
  readStats.unchanged = 0;
  readStats.changed = 0;
  readStats.unknown = 0;
  readStats.invalidations = 0;
  readStats.clears = 0;
  readStats.evictions = 0;
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
  /** Identity of THIS subscription; see {@link coverageEpoch}. */
  epoch: number;
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
/** Never reused, never reset: an epoch must not be able to come back. */
let coverageGeneration = 0;

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
    epoch: ++coverageGeneration,
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
