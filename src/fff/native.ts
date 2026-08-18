/**
 * Loading the native fff library — and surviving its absence.
 *
 * `@ff-labs/fff-node` is a thin ffi-rs wrapper around a platform-specific
 * `libfff_c` shared object shipped in an optional dependency. Two consequences
 * shape this file:
 *
 * 1. It CANNOT be bundled. `npm run bundle` runs esbuild over `src/server.ts`;
 *    a statically-analyzable `import "@ff-labs/fff-node"` would be inlined and
 *    the FFI loader would then look for the `.so` next to the bundle. The
 *    specifier below is assembled at runtime precisely so esbuild leaves the
 *    `import()` alone, the same way `--external:better-sqlite3` protects the
 *    SQLite addon. `hooks/ensure-deps.mjs` is what puts the package on disk.
 *
 * 2. It may legitimately be missing — unsupported platform, `--ignore-scripts`
 *    install, optional dependency skipped. Then this module reports
 *    `unavailable` and every caller keeps working without fff. Nothing here
 *    throws.
 */

import { isFffEnabled } from "./env.js";
import type { FffNativeModule, FffResult, GrepCursor, HealthCheck } from "./types.js";
import { fffErr, fffOk } from "./types.js";

/**
 * Built at runtime, never a literal: esbuild must not be able to resolve and
 * inline this. Do not "simplify" it back into a string constant.
 */
const NATIVE_PACKAGE = ["@ff-labs", "fff-node"].join("/");

export type FffLoader = () => Promise<FffNativeModule>;

let cached: FffResult<FffNativeModule> | undefined;
let inFlight: Promise<FffResult<FffNativeModule>> | undefined;
let loaderOverride: FffLoader | undefined;

async function defaultLoader(): Promise<FffNativeModule> {
  const mod = (await import(NATIVE_PACKAGE)) as unknown as FffNativeModule;
  if (typeof mod?.FileFinder?.create !== "function") {
    throw new Error(`${NATIVE_PACKAGE} loaded without a usable FileFinder export`);
  }
  return mod;
}

/**
 * Resolve the native module once per process.
 *
 * Both success and failure are cached: a missing binary is a permanent
 * condition for the life of the process, and retrying the import on every
 * search would cost a module-resolution miss per call. The env kill switch is
 * re-read every time, so `CONTEXT_MODE_FFF=0` takes effect without a restart.
 */
export async function loadFffNative(env: NodeJS.ProcessEnv = process.env): Promise<FffResult<FffNativeModule>> {
  if (!isFffEnabled(env)) {
    return fffErr<FffNativeModule>("fff search layer disabled via CONTEXT_MODE_FFF", true);
  }
  if (cached) return cached;
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<FffResult<FffNativeModule>> => {
    try {
      const mod = await (loaderOverride ?? defaultLoader)();
      let available = false;
      try {
        available = mod.FileFinder.isAvailable();
      } catch (err) {
        return fffErr<FffNativeModule>(`fff availability probe failed: ${describe(err)}`, true);
      }
      if (!available) {
        return fffErr<FffNativeModule>(
          "fff native binary not found for this platform (optional dependency missing)",
          true,
        );
      }
      return fffOk(mod);
    } catch (err) {
      return fffErr<FffNativeModule>(`fff native module unavailable: ${describe(err)}`, true);
    }
  })();

  try {
    const result = await inFlight;
    cached = result;
    return result;
  } finally {
    inFlight = undefined;
  }
}

/** True when a search can actually be served in this process. */
export async function isFffAvailable(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return (await loadFffNative(env)).ok;
}

/**
 * Version + git probe without creating an index. Cheap enough for
 * `ctx_doctor` to call on every run.
 */
export async function fffStaticHealthCheck(testPath?: string): Promise<FffResult<HealthCheck>> {
  const loaded = await loadFffNative();
  if (!loaded.ok) return loaded as FffResult<HealthCheck>;
  const statik = loaded.value.FileFinder.healthCheckStatic;
  if (!statik) return fffErr<HealthCheck>("fff build has no static health check", true);
  try {
    const res = statik.call(loaded.value.FileFinder, testPath);
    return res.ok ? fffOk(res.value) : fffErr<HealthCheck>(res.error);
  } catch (err) {
    return fffErr<HealthCheck>(`fff health check threw: ${describe(err)}`);
  }
}

/**
 * Rebuild the native branded cursor from our serializable one. The runtime
 * shape is a plain object, so the fallback stays correct even if the package
 * stops exporting the factory.
 */
export function toNativeCursor(
  mod: FffNativeModule,
  cursor: { offset: number } | null | undefined,
): GrepCursor | null {
  if (!cursor || !Number.isFinite(cursor.offset)) return null;
  if (typeof mod.createGrepCursor === "function") {
    try {
      return mod.createGrepCursor(cursor.offset);
    } catch {
      // fall through to the structural form
    }
  }
  return { __brand: "GrepCursor", _offset: cursor.offset } as unknown as GrepCursor;
}

export function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ─────────────────────────────────────────────────────────
// Test seams
// ─────────────────────────────────────────────────────────

/** Swap the module loader (used to exercise both the happy path and absence). */
export function __setFffLoaderForTests(loader: FffLoader | null): void {
  loaderOverride = loader ?? undefined;
  cached = undefined;
  inFlight = undefined;
}

/** Forget the memoized load result. */
export function __resetFffNativeCacheForTests(): void {
  cached = undefined;
  inFlight = undefined;
}
