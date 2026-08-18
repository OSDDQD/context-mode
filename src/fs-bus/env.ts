/**
 * Env switches for the filesystem event wiring.
 *
 * Fork convention (`CONTEXT_MODE_*`, "0"/"off"/"false" disables), matching
 * `src/fff/env.ts`. One flag per consumer on purpose: an operator who finds the
 * FTS5 re-index too eager must be able to turn only that off and keep the
 * codegraph sync queue, and vice versa. Read lazily on every call — never
 * memoized — so tests can flip them per case.
 *
 * The kill switches compose with fff's own: `CONTEXT_MODE_FFF=0` or
 * `CONTEXT_MODE_FFF_WATCH=0` already remove the event source, and the wiring
 * degrades to an inert handle without any of the flags below being set.
 */

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

function isOff(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "0" || v === "off" || v === "false" || v === "no" || v === "disabled";
}

/** `CONTEXT_MODE_FS_BUS=0` — no subscription at all, no finder acquired. */
export function isFsBusEnabled(env: Env = process.env): boolean {
  return !isOff(env[FS_BUS_ENV]);
}

/** `CONTEXT_MODE_FS_BUS_INDEX=0` — keep the bus, drop FTS5 invalidation. */
export function isIndexConsumerEnabled(env: Env = process.env): boolean {
  return !isOff(env[FS_BUS_INDEX_ENV]);
}

/** `CONTEXT_MODE_FS_BUS_GRAPH=0` — keep the bus, drop the codegraph queue. */
export function isGraphConsumerEnabled(env: Env = process.env): boolean {
  return !isOff(env[FS_BUS_GRAPH_ENV]);
}

/** `CONTEXT_MODE_FS_BUS_CACHE=0` — keep the bus, stop poking path caches. */
export function isCacheConsumerEnabled(env: Env = process.env): boolean {
  return !isOff(env[FS_BUS_CACHE_ENV]);
}

/** Files re-indexed per batch. Clamped to 1…5000. */
export function maxFilesPerBatch(env: Env = process.env): number {
  const raw = env[FS_BUS_MAX_FILES_ENV];
  if (raw === undefined) return DEFAULT_MAX_FILES_PER_BATCH;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_FILES_PER_BATCH;
  return Math.min(n, 5_000);
}
