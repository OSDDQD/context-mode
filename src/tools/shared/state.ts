/**
 * The process-wide state `src/server.ts` and the extracted tool modules share.
 *
 * Three things in this server are singletons by contract, not by convenience:
 * the FTS5 content store (one SQLite handle per process — a second one would
 * take a second lock on the same file), the detected host adapter (resolved
 * once, after the MCP `initialize` handshake), and the per-session counters
 * (`ctx_stats` reports them, the statusline sidecar mirrors them, and a
 * duplicate would silently halve every number the user sees).
 *
 * They live here rather than in `server.ts` so a tool module can reach them
 * without importing `server.ts` back — that cycle resolves by evaluating one
 * side half-initialised, which in the bundle means a module-level `let` read
 * as `undefined` at startup and no error to point at. This file imports
 * nothing but types, so nothing can point back at it.
 *
 * Note what is NOT here. `getStore()` stays in `server.ts`: it does not just
 * hand back the singleton, it opens the DB at a path derived from the
 * adapter's config dir, wires the Read-deny checker, sweeps stale content DBs
 * and drains four capture queues — all of it built on helpers that belong to
 * `server.ts`. Only the cell moved; the lifecycle did not. Same for
 * `trackResponse`, which reaches the plugin-cache heal and the version-warning
 * cadence. What lives here is state with no outbound dependencies at all.
 *
 * Mutating state is exported as accessor pairs because ESM import bindings are
 * read-only at the importing side: `import { _store }` cannot be assigned to.
 * `sessionStats` needs no pair — callers mutate its fields, never rebind it.
 */

import type { ContentStore } from "../../store.js";
import type { HookAdapter } from "../../adapters/types.js";

// ─────────────────────────────────────────────────────────
// Session stats — track context consumption per tool
// ─────────────────────────────────────────────────────────

export const sessionStats = {
  calls: {} as Record<string, number>,
  bytesReturned: {} as Record<string, number>,
  bytesIndexed: 0,
  bytesSandboxed: 0, // network I/O consumed inside sandbox (never enters context)
  cacheHits: 0,
  cacheMisses: 0, // ctx_fetch_and_index calls that bypassed the TTL cache
  cacheBytesSaved: 0, // bytes avoided by TTL cache hits
  sessionStart: Date.now(),
};

// ─────────────────────────────────────────────────────────
// Content store singleton
// ─────────────────────────────────────────────────────────

// Lazy singleton — no DB overhead unless index/search is used
let _store: ContentStore | null = null;

/**
 * The open store, or null when nothing has needed it yet.
 *
 * "Peek" rather than "get" on purpose: this never opens anything. The opening
 * path is `getStore()` in `server.ts`, and shutdown/purge want to know whether
 * there is a handle to close without creating one to close.
 */
export function peekStore(): ContentStore | null {
  return _store;
}

/** Install the freshly opened store, or clear it after a purge/cleanup. */
export function setStore(store: ContentStore | null): void {
  _store = store;
}

// ─────────────────────────────────────────────────────────
// Stale stats-file roll-up — once per process
// ─────────────────────────────────────────────────────────

let _statsRollupDone = false;

/**
 * Claim the one-shot roll-up of retired per-session stats files.
 *
 * Returns true to exactly one caller per process and false to every caller
 * after it. Two places want to do the sweep — the first `getStore()` and
 * `ctx_stats` on Pi — and they must not both walk a directory that had 735
 * files on the machine that motivated the roll-up. The latch is here rather
 * than in either caller because they now live in different modules.
 */
export function claimStatsRollup(): boolean {
  if (_statsRollupDone) return false;
  _statsRollupDone = true;
  return true;
}

// ─────────────────────────────────────────────────────────
// Detected host adapter
// ─────────────────────────────────────────────────────────
// The adapter (stored after the MCP handshake) is the canonical source for
// platform-specific paths. All session DB paths go through it — no hardcoded
// configDir detection in tool handlers.

let _detectedAdapter: HookAdapter | null = null;

/**
 * The detected host adapter, or null before detection completes.
 *
 * A getter, not a value: detection finishes during `main()`, which is long
 * after the tool modules were imported and their dependency objects built.
 */
export function detectedAdapter(): HookAdapter | null {
  return _detectedAdapter;
}

/** Record the adapter resolved from the MCP client handshake. */
export function setDetectedAdapter(adapter: HookAdapter | null): void {
  _detectedAdapter = adapter;
}
