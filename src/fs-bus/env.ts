/**
 * Env switches for the filesystem event wiring.
 *
 * Fork convention (`CONTEXT_MODE_*`, "0"/"off"/"false" disables), matching
 * `src/fff/env.ts`. One knob per consumer on purpose: an operator who finds the
 * FTS5 re-index too eager must be able to turn only that off and keep the
 * codegraph sync queue, and vice versa. Read lazily on every call — never
 * memoized — so tests can flip them per case.
 *
 * The four consumer knobs are ALSO reachable as one JSON object on the head
 * name (`CONTEXT_MODE_FS_BUS={"index":false}`) — see `FS_BUS_SCHEMA` below for
 * the collapse and for how the head name's long-standing `0` is kept apart
 * from an object. Every individual variable below still works, and still wins.
 *
 * The kill switches compose with fff's own: `CONTEXT_MODE_FFF=0` or
 * `CONTEXT_MODE_FFF_WATCH=0` already remove the event source, and the wiring
 * degrades to an inert handle without any of the flags below being set.
 */

import {
  boolKey,
  disableKeyOnOff,
  isOffValue,
  numberKey,
  readEnvFamily,
  type FamilySettings,
} from "../util/env-family.js";

/** Master switch for the whole wiring. `0` installs an inert handle. */
export const FS_BUS_ENV = "CONTEXT_MODE_FS_BUS" as const;
/** Consumer 1: FTS5 chunk invalidation / re-index of `code:` sources. */
export const FS_BUS_INDEX_ENV = "CONTEXT_MODE_FS_BUS_INDEX" as const;
/** Consumer 2: the `codegraph sync` queue in `src/graph/daemon.ts`. */
export const FS_BUS_GRAPH_ENV = "CONTEXT_MODE_FS_BUS_GRAPH" as const;
/** Consumer 3: per-path caches registered through `registerPathCache`. */
export const FS_BUS_CACHE_ENV = "CONTEXT_MODE_FS_BUS_CACHE" as const;
/** Files re-indexed per delivered batch. */
export const FS_BUS_MAX_FILES_ENV = "CONTEXT_MODE_FS_BUS_MAX_FILES" as const;

/**
 * A mass refactor or a `git checkout` can move thousands of files in one
 * debounce window. Re-indexing all of them inside the watcher callback would
 * stall whatever tool call happens to be running, so the batch is capped and
 * the overflow is left to the store's own mtime-gated refresh
 * (`ContentStore.#refreshStaleSources`), which already catches modified files
 * on the next search.
 */
export const DEFAULT_MAX_FILES_PER_BATCH = 40;

type Env = NodeJS.ProcessEnv;

/**
 * The consumers, as one JSON flag on the head name that already existed:
 * `CONTEXT_MODE_FS_BUS={"index":true,"graph":true,"cache":true,"maxFiles":40}`.
 *
 * The interesting case in the collapse, because `CONTEXT_MODE_FS_BUS` ALREADY
 * had a scalar meaning — `0` = the whole wiring off — and that meaning is load
 * bearing: it is the first thing anyone sets when the watcher misbehaves. So
 * the two forms are told apart by the first non-space character:
 *
 *   `CONTEXT_MODE_FS_BUS=0`         → legacy scalar, master switch off, and
 *                                     with the master off no consumer runs,
 *                                     which is exactly "all off"
 *   `CONTEXT_MODE_FS_BUS={"…":…}`   → family object; the master stays on unless
 *                                     the object says `"enabled":false`
 *
 * JSON objects have exactly one spelling, so this is a decision rather than a
 * guess, and no value that works today can be reclassified by it. Individual
 * scalars (`CONTEXT_MODE_FS_BUS_INDEX=0`) still override the JSON key they
 * overlap — nobody's shell profile changes meaning. See `src/util/env-family.ts`.
 */
const FS_BUS_SCHEMA = {
  enabled: boolKey("enabled", null, true),
  index: boolKey("index", FS_BUS_INDEX_ENV, true),
  graph: boolKey("graph", FS_BUS_GRAPH_ENV, true),
  cache: boolKey("cache", FS_BUS_CACHE_ENV, true),
  maxFiles: numberKey("maxFiles", FS_BUS_MAX_FILES_ENV, DEFAULT_MAX_FILES_PER_BATCH, (n) => {
    // Same clamp as before the collapse: below 1 is a typo (→ default), and the
    // upper bound keeps a `git checkout` of a monorepo from stalling the tool
    // call the watcher fires inside of.
    const truncated = Math.trunc(n);
    return truncated >= 1 ? Math.min(truncated, 5_000) : undefined;
  }),
};

/**
 * Read lazily on every call — never memoized — so tests can flip the variables
 * per case and an operator can change one between two tool calls.
 */
export function fsBusSettings(env: Env = process.env): FamilySettings<typeof FS_BUS_SCHEMA> {
  return readEnvFamily(FS_BUS_ENV, FS_BUS_SCHEMA, env, {
    headScalar: disableKeyOnOff<typeof FS_BUS_SCHEMA>("enabled"),
  });
}

/** `CONTEXT_MODE_FS_BUS=0` (or `{"enabled":false}`) — no subscription at all, no finder acquired. */
export function isFsBusEnabled(env: Env = process.env): boolean {
  return fsBusSettings(env).enabled;
}

/** `CONTEXT_MODE_FS_BUS_INDEX=0` — keep the bus, drop FTS5 invalidation. */
export function isIndexConsumerEnabled(env: Env = process.env): boolean {
  return fsBusSettings(env).index;
}

/** `CONTEXT_MODE_FS_BUS_GRAPH=0` — keep the bus, drop the codegraph queue. */
export function isGraphConsumerEnabled(env: Env = process.env): boolean {
  return fsBusSettings(env).graph;
}

/** `CONTEXT_MODE_FS_BUS_CACHE=0` — keep the bus, stop poking path caches. */
export function isCacheConsumerEnabled(env: Env = process.env): boolean {
  return fsBusSettings(env).cache;
}

/** Files re-indexed per batch. Clamped to 1…5000. */
export function maxFilesPerBatch(env: Env = process.env): number {
  return fsBusSettings(env).maxFiles;
}

// ─────────────────────────────────────────────────────────
// Re-read cache
// ─────────────────────────────────────────────────────────

/**
 * Master switch for the re-read cache (`recordRead` / `checkRead`). `0` makes
 * every check answer `unknown`, which is the same as not having the cache: the
 * caller reads the file. Nothing else changes.
 */
export const READ_CACHE_ENV = "CONTEXT_MODE_READ_CACHE" as const;
/** Entries the re-read cache keeps before evicting the least recently used. */
export const READ_CACHE_MAX_ENV = "CONTEXT_MODE_READ_CACHE_MAX" as const;

/**
 * Entries, not bytes: the cache stores a hash and two timestamps per path and
 * never the content, so 512 paths is a few tens of KB. The cap exists because a
 * watcher batch can mint a tombstone per changed path (see `invalidate` in
 * `index.ts`), and an unbounded map fed by `git checkout` on a monorepo is a
 * leak that only shows up in a long-lived server process.
 */
export const DEFAULT_READ_CACHE_ENTRIES = 512;

/** `CONTEXT_MODE_READ_CACHE=0` — never answer "unchanged", always re-read. */
export function isReadCacheEnabled(env: Env = process.env): boolean {
  return !isOffValue(env[READ_CACHE_ENV]);
}

/** Paths the re-read cache remembers. Clamped to 16…50000. */
export function readCacheMaxEntries(env: Env = process.env): number {
  const raw = env[READ_CACHE_MAX_ENV];
  if (raw === undefined) return DEFAULT_READ_CACHE_ENTRIES;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_READ_CACHE_ENTRIES;
  return Math.min(Math.max(n, 16), 50_000);
}
