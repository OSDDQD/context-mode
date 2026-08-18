/**
 * Env switches for the fff search layer.
 *
 * Fork convention (`CONTEXT_MODE_*`, "0"/"off"/"false" disables) — see the
 * existing flags in `src/server.ts` and `src/session/*`. Every flag is read
 * lazily on each call, never memoized, so tests can flip them per case.
 */

export const FFF_ENABLED_ENV = "CONTEXT_MODE_FFF" as const;
export const FFF_MMAP_ENV = "CONTEXT_MODE_FFF_MMAP" as const;
export const FFF_WATCH_ENV = "CONTEXT_MODE_FFF_WATCH" as const;
export const FFF_WATCH_DEBOUNCE_ENV = "CONTEXT_MODE_FFF_WATCH_DEBOUNCE_MS" as const;
export const FFF_MAX_INSTANCES_ENV = "CONTEXT_MODE_FFF_MAX_INSTANCES" as const;
export const FFF_SCAN_TIMEOUT_ENV = "CONTEXT_MODE_FFF_SCAN_TIMEOUT_MS" as const;
export const FFF_DIR_ENV = "CONTEXT_MODE_FFF_DIR" as const;

export const DEFAULT_WATCH_DEBOUNCE_MS = 150;
export const DEFAULT_MAX_INSTANCES = 2;
export const DEFAULT_SCAN_TIMEOUT_MS = 5_000;

type Env = NodeJS.ProcessEnv;

function isOff(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "0" || v === "off" || v === "false" || v === "no" || v === "disabled";
}

function positiveInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** `CONTEXT_MODE_FFF=0` switches the whole layer off — no native load, no watcher. */
export function isFffEnabled(env: Env = process.env): boolean {
  return !isOff(env[FFF_ENABLED_ENV]);
}

/**
 * mmap warmup is on by default (that is what makes fff fast on the second
 * query). `CONTEXT_MODE_FFF_MMAP=off` trades it back for RAM, which large
 * monorepos may want.
 */
export function isMmapCacheDisabled(env: Env = process.env): boolean {
  return isOff(env[FFF_MMAP_ENV]);
}

/** `CONTEXT_MODE_FFF_WATCH=0` keeps search but drops the filesystem event bus. */
export function isWatchDisabled(env: Env = process.env): boolean {
  return isOff(env[FFF_WATCH_ENV]);
}

/** Debounce window for the shared fs event bus. Clamped to 0…10s. */
export function watchDebounceMs(env: Env = process.env): number {
  const raw = env[FFF_WATCH_DEBOUNCE_ENV];
  if (raw === undefined) return DEFAULT_WATCH_DEBOUNCE_MS;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_WATCH_DEBOUNCE_MS;
  return Math.min(n, 10_000);
}

/**
 * How many native indexes may be alive at once. Each one holds a full
 * in-memory file index, so the default is deliberately small: the server
 * serves one project, plus one slot of slack while a project switch settles.
 */
export function maxFinderInstances(env: Env = process.env): number {
  return positiveInt(env[FFF_MAX_INSTANCES_ENV], DEFAULT_MAX_INSTANCES, 1, 16);
}

/** How long `acquireFinder` waits for the initial scan before returning. */
export function scanTimeoutMs(env: Env = process.env): number {
  return positiveInt(env[FFF_SCAN_TIMEOUT_ENV], DEFAULT_SCAN_TIMEOUT_MS, 0, 120_000);
}
