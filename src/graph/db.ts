/**
 * Read-only access to a project's codegraph index.
 *
 * Stage 3B of the consolidation plan: stop paying an MCP round trip (and a
 * second server process) to ask codegraph a question whose answer is already
 * sitting in `<project>/.codegraph/codegraph.db`. The schema is open, the file
 * is WAL, and better-sqlite3 is already a dependency — so the plugin reads it
 * directly.
 *
 * Three rules govern everything in this file, and they are the reason the code
 * is more defensive than a plain `new Database(path)`:
 *
 * 1. **The database belongs to another process.** codegraph's daemon is the
 *    writer. Every connection opened here is read-only at the driver level and
 *    additionally pinned with `PRAGMA query_only`. Nothing in `src/graph/**`
 *    ever issues a write, ever touches `daemon.sock`, and ever deletes a
 *    `-wal`/`-shm` sidecar. WAL is what makes this safe: readers do not block
 *    the writer and the writer does not block readers.
 *
 * 2. **The schema is not ours to depend on.** codegraph 1.5.0 ships
 *    `schema_versions.version = 8`. A future codegraph may renumber columns
 *    under us, and a silently-wrong answer is worse than no answer. So the
 *    supported range is pinned ({@link SCHEMA_MIN}/{@link SCHEMA_MAX}) and a
 *    version outside it degrades to the CLI (`codegraph query|impact|affected`
 *    all take `-j/--json`, which is a narrower and more stable contract than
 *    the tables).
 *
 * 3. **"Not indexed" is a normal state, not an exception.** A project without
 *    `.codegraph/`, or one whose `project_metadata.index_state` is not
 *    `complete`, gets a sentence telling the caller to run `codegraph init` —
 *    not a stack trace.
 *
 * ## Why `readonly: true` and not `file:…?mode=ro`
 *
 * The URI form is the documented way to say this to SQLite, but it is not
 * portable across the three drivers this codebase runs on: better-sqlite3
 * passes the filename straight to `sqlite3_open` without `SQLITE_OPEN_URI`,
 * and `node:sqlite`'s `DatabaseSync` does the same. `{ readonly: true }` is the
 * one spelling `src/db-base.ts` translates for all three (better-sqlite3
 * native option, bun:sqlite `readonly`, node:sqlite `readOnly`), so that is
 * what is used, with `PRAGMA query_only = 1` as a second, driver-independent
 * belt. The effect is identical: `SQLITE_READONLY` on any attempted write.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { Database as DatabaseInstance } from "better-sqlite3";

import { loadDatabase } from "../db-base.js";

// ─────────────────────────────────────────────────────────
// Schema pinning
// ─────────────────────────────────────────────────────────

/** Oldest `schema_versions.version` these queries are known to run against. */
export const SCHEMA_MIN = 1;

/**
 * Newest `schema_versions.version` these queries are known to run against.
 *
 * codegraph 1.5.0 = 8. Bumping this is a deliberate act: read the migration,
 * re-check `nodes`/`edges`/`nodes_fts` column names, then raise the constant.
 * `CONTEXT_MODE_GRAPH_SCHEMA_MAX` exists for the operator who has already done
 * that check locally and does not want to wait for a release.
 */
export const SCHEMA_MAX = 8;

/** Resolved upper bound, honouring the operator override. */
export function schemaMax(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CONTEXT_MODE_GRAPH_SCHEMA_MAX;
  if (!raw) return SCHEMA_MAX;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : SCHEMA_MAX;
}

// ─────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────

/** `<project>/.codegraph`. */
export function codegraphDir(projectDir: string): string {
  return join(projectDir, ".codegraph");
}

/** `<project>/.codegraph/codegraph.db`. */
export function codegraphDbPath(projectDir: string): string {
  return join(codegraphDir(projectDir), "codegraph.db");
}

/** True when the project has been through `codegraph init` at least once. */
export function hasCodegraphIndex(projectDir: string): boolean {
  try {
    return existsSync(codegraphDbPath(projectDir));
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────
// Open
// ─────────────────────────────────────────────────────────

/** Why {@link openGraphDb} refused. Each maps to a different caller response. */
export type GraphOpenReason =
  /** No `.codegraph/codegraph.db` — the project was never indexed. */
  | "no-index"
  /** Indexed, but `index_state` is not `complete` (init/index still running). */
  | "incomplete"
  /** `schema_versions` is outside the pinned range — fall back to the CLI. */
  | "schema-drift"
  /** The driver refused the file (locked, corrupt, WAL without a readable -shm). */
  | "open-failed";

export interface GraphDbHandle {
  /** The read-only connection. Never write through it. */
  readonly db: DatabaseInstance;
  readonly dbPath: string;
  readonly projectDir: string;
  /** Highest row in `schema_versions`. */
  readonly schemaVersion: number;
  /** `project_metadata.index_state`, normally `complete`. */
  readonly indexState: string;
  /** Close the connection. Idempotent. */
  close(): void;
}

export type GraphOpenResult =
  | { ok: true; handle: GraphDbHandle }
  | { ok: false; reason: GraphOpenReason; message: string; schemaVersion?: number };

/**
 * Open `<project>/.codegraph/codegraph.db` read-only.
 *
 * Never throws for a caller-fixable condition: a missing index, an incomplete
 * index and a drifted schema all come back as `{ ok: false }` with a message
 * the tool layer can print verbatim.
 *
 * The connection underneath is pooled per database file — see the pool section
 * below for what that costs and what invalidates it. The contract callers see
 * is unchanged: `handle.close()` is still the right thing to call in a
 * `finally`, it just releases a lease instead of tearing down the connection.
 * Pass `{ pool: false }` when the caller genuinely needs a private connection
 * it alone owns (a test asserting close semantics, a one-shot probe).
 */
export function openGraphDb(
  projectDir: string,
  opts: { env?: NodeJS.ProcessEnv; pool?: boolean } = {},
): GraphOpenResult {
  const env = opts.env ?? process.env;
  const dbPath = codegraphDbPath(projectDir);

  if (opts.pool === false || graphPoolMax(env) <= 0) {
    const opened = connectGraphDb(dbPath, projectDir, env);
    if (!opened.ok) return opened;
    return { ok: true, handle: privateHandle(opened, dbPath, projectDir) };
  }
  return acquirePooled(projectDir, dbPath, env);
}

/** Open + validate, with no pool involvement. The old `openGraphDb` body. */
type Connected =
  | { ok: true; db: DatabaseInstance; schemaVersion: number; indexState: string }
  | { ok: false; reason: GraphOpenReason; message: string; schemaVersion?: number };

function connectGraphDb(
  dbPath: string,
  projectDir: string,
  env: NodeJS.ProcessEnv,
): Connected {
  if (!existsSync(dbPath)) {
    return {
      ok: false,
      reason: "no-index",
      message:
        `No codegraph index for ${projectDir} (${dbPath} does not exist).\n` +
        `Run \`codegraph init ${projectDir}\` once; after that the index maintains itself.`,
    };
  }

  let db: DatabaseInstance;
  try {
    const Database = loadDatabase();
    // `readonly` is the portable spelling (see the module note). `timeout`
    // becomes busy_timeout: the daemon commits while we read, and under WAL a
    // reader only ever waits on a checkpoint, so a short wait is enough.
    db = new Database(dbPath, { readonly: true, timeout: 5_000 });
    // Second, driver-independent guard. Some drivers reach SQLite through a
    // wrapper whose `readonly` flag we cannot audit from here; `query_only`
    // is enforced by SQLite itself on the connection.
    try { (db as unknown as { pragma(s: string): unknown }).pragma("query_only = 1"); } catch { /* older driver */ }
  } catch (err) {
    return {
      ok: false,
      reason: "open-failed",
      message:
        `Could not open ${dbPath} read-only: ${err instanceof Error ? err.message : String(err)}.\n` +
        "A WAL database needs its -shm sidecar readable; if the codegraph daemon is not running, " +
        "start it (or run any `codegraph` command once) and retry.",
    };
  }

  const meta = readIndexIdentity(db, dbPath);
  if (!meta.ok) {
    closeQuietly(db);
    return meta;
  }

  const refusal = validateIndex(meta.schemaVersion, meta.indexState, projectDir, env);
  if (refusal) {
    closeQuietly(db);
    return refusal;
  }

  return { ok: true, db, schemaVersion: meta.schemaVersion, indexState: meta.indexState };
}

/**
 * The two rows every caller is gated on: the schema version and the index
 * state. Split out because a pooled connection has to re-read them whenever the
 * file has been written to — the connection stays valid across a rebuild, but
 * the numbers it was admitted on do not.
 */
function readIndexIdentity(
  db: DatabaseInstance,
  dbPath: string,
): { ok: true; schemaVersion: number; indexState: string }
  | { ok: false; reason: GraphOpenReason; message: string } {
  try {
    const row = db
      .prepare("SELECT MAX(version) AS v FROM schema_versions")
      .get() as { v?: number } | undefined;
    const schemaVersion = Number(row?.v ?? 0);
    const meta = db
      .prepare("SELECT value FROM project_metadata WHERE key = 'index_state'")
      .get() as { value?: string } | undefined;
    return { ok: true, schemaVersion, indexState: String(meta?.value ?? "") };
  } catch (err) {
    // Reached both for a file that was never a codegraph index and for one that
    // was truncated/corrupted under us — SQLite reports both as a malformed or
    // missing table, and both mean the same thing here: do not guess, degrade.
    return {
      ok: false,
      reason: "schema-drift",
      message:
        `${dbPath} does not look like a codegraph index (${err instanceof Error ? err.message : String(err)}). ` +
        "Falling back to the codegraph CLI.",
    };
  }
}

/** The pinned-schema and index-state gates. `null` when the index is usable. */
function validateIndex(
  schemaVersion: number,
  indexState: string,
  projectDir: string,
  env: NodeJS.ProcessEnv,
): { ok: false; reason: GraphOpenReason; message: string; schemaVersion?: number } | null {
  const max = schemaMax(env);
  if (schemaVersion < SCHEMA_MIN || schemaVersion > max) {
    return {
      ok: false,
      reason: "schema-drift",
      schemaVersion,
      message:
        `codegraph schema version ${schemaVersion} is outside the supported range ` +
        `${SCHEMA_MIN}–${max}. Direct reads are disabled so a renamed column cannot ` +
        "produce a confidently wrong answer; the codegraph CLI (`-j/--json`) is used instead. " +
        "Set CONTEXT_MODE_GRAPH_SCHEMA_MAX once you have verified the new schema.",
    };
  }

  if (indexState && indexState !== "complete") {
    return {
      ok: false,
      reason: "incomplete",
      schemaVersion,
      message:
        `The codegraph index for ${projectDir} is in state "${indexState}", not "complete". ` +
        "Indexing is probably still running — retry in a moment, or run `codegraph status` to check.",
    };
  }
  return null;
}

function privateHandle(
  c: { db: DatabaseInstance; schemaVersion: number; indexState: string },
  dbPath: string,
  projectDir: string,
): GraphDbHandle {
  let closed = false;
  return {
    db: c.db,
    dbPath,
    projectDir,
    schemaVersion: c.schemaVersion,
    indexState: c.indexState || "complete",
    close() {
      if (closed) return;
      closed = true;
      closeQuietly(c.db);
    },
  };
}

function closeQuietly(db: DatabaseInstance): void {
  try { db.close(); } catch { /* already closed */ }
}

// ─────────────────────────────────────────────────────────
// Handle pool
// ─────────────────────────────────────────────────────────

/**
 * One long-lived read-only connection per index file.
 *
 * Before this, every graph question opened its own connection: `ctx_find`'s
 * graph signal did it once per call and every SQL `ctx_graph` action did it
 * again. That is a file open, a WAL/-shm map, a `query_only` pragma and two
 * schema SELECTs paid on the hot retrieval path, for a database that does not
 * change between two calls a second apart.
 *
 * The connection is not the fragile part — SQLite readers see the writer's
 * commits through an open connection without reopening. The fragile parts are
 * (a) the file being *replaced* underneath the fd, and (b) the two numbers the
 * connection was admitted on going stale. Both are checked per acquire, and
 * both checks are `stat()`, never a re-open and never the 5 000-file freshness
 * sweep (that has its own cache; see {@link checkFreshness}).
 */
interface PoolEntry {
  db: DatabaseInstance;
  /** Resolved db path — also the pool key. */
  key: string;
  schemaVersion: number;
  indexState: string;
  /** `dev:ino` at open time. A change means our fd points at a dead file. */
  identity: string;
  /** mtime+size of the db and its `-wal`. A change means the metadata may lie. */
  content: string;
  /** Outstanding leases. The connection must not be closed while this is > 0. */
  leases: number;
  /** Evicted or invalidated; close as soon as the last lease is released. */
  doomed: boolean;
}

/** Insertion order is LRU order: {@link touch} moves a hit to the end. */
const graphDbPool = new Map<string, PoolEntry>();

/** Default ceiling on simultaneously-open index connections. */
export const GRAPH_POOL_MAX = 4;

/**
 * How many index connections may be held open at once. `0` disables pooling.
 *
 * The bound exists for file descriptors, not memory: each entry holds the db,
 * its `-wal` and its `-shm` open, so an unbounded pool in a long session that
 * wanders across repositories is an fd leak that ends in EMFILE. Four covers
 * the realistic case (a project plus a couple of sibling checkouts) and evicts
 * anything beyond it.
 */
export function graphPoolMax(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CONTEXT_MODE_GRAPH_POOL_MAX;
  if (raw === undefined || raw === "") return GRAPH_POOL_MAX;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : GRAPH_POOL_MAX;
}

/**
 * The two cheap facts that decide whether a cached connection is still the
 * right one. `null` when the file is gone.
 *
 * `dev:ino` is the part that matters most. codegraph rebuilds an index by
 * writing a new database and renaming it over the path; on POSIX the rename
 * leaves our fd attached to the *unlinked* old inode, which keeps answering
 * queries — correctly, about a version of the code that no longer exists, with
 * no error anywhere. A path-only check cannot see that; an inode check can.
 *
 * On Windows `ino` may be 0 for every file, which collapses `identity` to a
 * constant. The `content` half still catches an atomic replace there, because a
 * replacement that happens to preserve both mtime and size does not occur in
 * practice.
 */
function poolStamp(dbPath: string): { identity: string; content: string } | null {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(dbPath);
  } catch {
    return null;
  }
  let wal = "-";
  try {
    const w = statSync(`${dbPath}-wal`);
    wal = `${w.mtimeMs}:${w.size}`;
  } catch { /* no sidecar: not in WAL mode, or checkpointed away */ }
  return { identity: `${st.dev}:${st.ino}`, content: `${st.mtimeMs}:${st.size}|${wal}` };
}

function acquirePooled(
  projectDir: string,
  dbPath: string,
  env: NodeJS.ProcessEnv,
): GraphOpenResult {
  const key = resolve(dbPath);
  // Stamped BEFORE any open, deliberately. If the file is replaced between the
  // stamp and the open we record the OLD stamp while holding the NEW inode: the
  // next acquire sees a mismatch and reopens — one wasted open, no wrong
  // answers. Stamping after the open inverts the error into the unrecoverable
  // one: the NEW stamp recorded against the OLD inode, pinning a dead file for
  // the rest of the process.
  const stamp = poolStamp(dbPath);
  const cached = graphDbPool.get(key);

  if (cached) {
    if (!stamp) {
      // The index was deleted while we held it open. The fd survives the unlink
      // on POSIX and would go on serving the last indexed state indefinitely —
      // strictly worse than reopening, because nothing looks wrong.
      retire(cached);
    } else if (cached.identity !== stamp.identity) {
      retire(cached); // atomic rebuild: same path, new inode.
    } else {
      // Same file. The connection is fine; only the admission numbers can have
      // moved, and only if somebody wrote.
      if (cached.content !== stamp.content) {
        const meta = readIndexIdentity(cached.db, dbPath);
        if (!meta.ok) {
          // Corrupted or truncated under us. Do not keep a connection that can
          // no longer answer what it was admitted on.
          retire(cached);
          return meta;
        }
        cached.schemaVersion = meta.schemaVersion;
        cached.indexState = meta.indexState;
        cached.content = stamp.content;
      }
      // Re-run the gates on every hit, not just after a write: `schemaMax` also
      // moves when the operator changes CONTEXT_MODE_GRAPH_SCHEMA_MAX, and a
      // cached handle must never outlive the range it was admitted under.
      const refusal = validateIndex(cached.schemaVersion, cached.indexState, projectDir, env);
      if (refusal) {
        retire(cached);
        return refusal;
      }
      touch(cached);
      return { ok: true, handle: leaseOf(cached, dbPath, projectDir) };
    }
  }

  const opened = connectGraphDb(dbPath, projectDir, env);
  if (!opened.ok) return opened;

  if (!stamp) {
    // `existsSync` inside `connectGraphDb` said yes after our stat said no — a
    // race with the rebuild. The connection is usable but unstampable, so it is
    // handed out privately rather than cached under a stamp we would have to
    // invent.
    return { ok: true, handle: privateHandle(opened, dbPath, projectDir) };
  }

  const entry: PoolEntry = {
    db: opened.db,
    key,
    schemaVersion: opened.schemaVersion,
    indexState: opened.indexState,
    identity: stamp.identity,
    content: stamp.content,
    leases: 0,
    doomed: false,
  };
  evictTo(graphPoolMax(env) - 1);
  graphDbPool.set(key, entry);
  return { ok: true, handle: leaseOf(entry, dbPath, projectDir) };
}

/**
 * A handle over a pooled entry. `close()` releases the lease; the connection
 * outlives it.
 *
 * `dbPath`/`projectDir` are per-lease rather than per-entry on purpose: two
 * spellings of the same project (a symlinked checkout, a relative path) share
 * one connection, but `checkFreshness` resolves the index's relative file rows
 * against `projectDir`, so each caller must get back the root it asked about.
 */
function leaseOf(entry: PoolEntry, dbPath: string, projectDir: string): GraphDbHandle {
  entry.leases++;
  let released = false;
  return {
    db: entry.db,
    dbPath,
    projectDir,
    schemaVersion: entry.schemaVersion,
    indexState: entry.indexState || "complete",
    close() {
      if (released) return;
      released = true;
      entry.leases = Math.max(0, entry.leases - 1);
      if (entry.doomed && entry.leases === 0) closeQuietly(entry.db);
    },
  };
}

/**
 * Take an entry out of the pool and close it — but not while it is leased.
 *
 * Every current caller is synchronous between acquire and `close()`, so leases
 * do not in fact overlap today. The refcount is here so that the day one does
 * (an async action, two projects interleaved in one handler), an eviction
 * cannot pull the connection out from under a query in flight and turn a
 * pooling optimisation into a `SQLITE_MISUSE` crash.
 */
function retire(entry: PoolEntry): void {
  if (graphDbPool.get(entry.key) === entry) graphDbPool.delete(entry.key);
  entry.doomed = true;
  if (entry.leases <= 0) closeQuietly(entry.db);
}

function touch(entry: PoolEntry): void {
  graphDbPool.delete(entry.key);
  graphDbPool.set(entry.key, entry);
}

/** Evict least-recently-used entries until at most `max` remain. */
function evictTo(max: number): void {
  if (max < 0) max = 0;
  while (graphDbPool.size > max) {
    const oldest = graphDbPool.keys().next();
    if (oldest.done) return;
    const entry = graphDbPool.get(oldest.value);
    graphDbPool.delete(oldest.value);
    if (entry) {
      entry.doomed = true;
      if (entry.leases <= 0) closeQuietly(entry.db);
    }
  }
}

/**
 * Close pooled connections. Whole pool, or one database.
 *
 * `dbPath` may be given in any spelling that `resolve` normalises to the key.
 * Used by tests and by `ctx purge`; a leased entry is closed when its last
 * lease is released, never underneath it.
 */
export function closeGraphDbPool(dbPath?: string): void {
  if (dbPath) {
    const entry = graphDbPool.get(resolve(dbPath));
    if (entry) retire(entry);
    return;
  }
  for (const entry of [...graphDbPool.values()]) retire(entry);
  graphDbPool.clear();
}

/** Pool contents, for tests and diagnostics. Never the connections themselves. */
export function graphPoolStats(): Array<{
  dbPath: string;
  schemaVersion: number;
  indexState: string;
  leases: number;
}> {
  return [...graphDbPool.values()].map(e => ({
    dbPath: e.key,
    schemaVersion: e.schemaVersion,
    indexState: e.indexState,
    leases: e.leases,
  }));
}

/** Read all of `project_metadata` as a plain map. */
export function readProjectMetadata(
  handle: GraphDbHandle,
): Record<string, { value: string; updatedAt: number }> {
  const out: Record<string, { value: string; updatedAt: number }> = {};
  try {
    const rows = handle.db
      .prepare("SELECT key, value, updated_at FROM project_metadata")
      .all() as Array<{ key: string; value: string; updated_at: number }>;
    for (const r of rows) {
      out[String(r.key)] = { value: String(r.value ?? ""), updatedAt: Number(r.updated_at ?? 0) };
    }
  } catch { /* metadata is advisory — never fail a query over it */ }
  return out;
}

// ─────────────────────────────────────────────────────────
// Freshness
// ─────────────────────────────────────────────────────────

export interface FreshnessReport {
  /** Files whose on-disk mtime is newer than the row's `indexed_at`. */
  staleFiles: number;
  /** Files present in the index whose path no longer exists on disk. */
  missingFiles: number;
  /** How many rows were actually stat'ed (the scan is capped). */
  checked: number;
  /** Total rows in the index's `files` table. */
  total: number;
  /** True when the scan stopped at the cap, so `staleFiles` is a lower bound. */
  capped: boolean;
  /** Newest `project_metadata.updated_at`, in epoch ms. */
  lastIndexedAt: number;
}

/**
 * One completed sweep, kept so the next `ctx_graph` call inside the same breath
 * does not repeat 5 000 `stat()` syscalls to learn the same number.
 */
interface FreshnessCacheEntry {
  report: FreshnessReport;
  /** When the sweep ran, epoch ms. */
  at: number;
  /** Caller-supplied change token (see `revision`); `null` when none was given. */
  revision: string | null;
  /** mtime+size of the db and its `-wal` sidecar at sweep time. */
  stamp: string;
}

/**
 * Keyed by `dbPath|cap|tolerance` — the three inputs that change the answer.
 * Process-lifetime, bounded below; a session touches one or two projects.
 */
const freshnessCache = new Map<string, FreshnessCacheEntry>();

/** More projects than this in one process means something is wrong; drop the oldest. */
const FRESHNESS_CACHE_MAX = 32;

/**
 * Ceiling on how long a matching change token may hold a report open.
 *
 * A token that never moves is evidence only as long as the thing producing it
 * is really watching. Filesystem watchers do drop events — an editor that
 * writes through a rename on a network mount, a container bind mount, an
 * inotify table that filled up — and a silently dead watcher would otherwise
 * pin one answer for the rest of the process. Five minutes bounds the damage
 * without giving up the win.
 */
const REVISION_MAX_AGE_MS = 5 * 60_000;

/**
 * How long a sweep result may be reused. `0` disables the cache entirely.
 *
 * Ten seconds is chosen against what the number is FOR: it decorates an answer
 * with "the index lags N files". A ten-second-old lag count is the same advice
 * as a fresh one, and the sweep it replaces is the single most expensive thing
 * on the `ctx_graph` hot path.
 */
export function freshnessTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CONTEXT_MODE_GRAPH_FRESHNESS_TTL_MS;
  if (raw === undefined || raw === "") return 10_000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 10_000;
}

/**
 * Cheap proof that the index itself has not moved: two `stat()` calls instead
 * of five thousand.
 *
 * The `-wal` sidecar matters more than the main file here — under WAL the
 * daemon's commits land in the sidecar and the main db's mtime only moves at
 * checkpoint, so a db-only stamp would happily serve a cached report across a
 * whole re-index.
 */
function dbStamp(dbPath: string): string {
  const one = (p: string): string => {
    try {
      const st = statSync(p);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return "-";
    }
  };
  return `${one(dbPath)}|${one(`${dbPath}-wal`)}`;
}

/** Drop cached sweeps. Whole cache, or one database. Tests, and `ctx purge`. */
export function clearFreshnessCache(dbPath?: string): void {
  if (!dbPath) {
    freshnessCache.clear();
    return;
  }
  for (const key of [...freshnessCache.keys()]) {
    if (key.startsWith(`${dbPath}|`)) freshnessCache.delete(key);
  }
}

/**
 * How far the index has fallen behind the working tree.
 *
 * Freshness is part of the answer's contract: a graph query that silently
 * describes yesterday's code is a bug that looks like a fact. The check is a
 * bounded `stat()` sweep over the index's own `files` table — cheap (a few ms
 * for the 4 000-file projects this was built against), and it never walks the
 * tree, so it cannot notice brand-new files that were never indexed. That
 * asymmetry is deliberate: a stale row is a wrong answer, an unindexed file is
 * merely a missing one, and the daemon closes the second gap on its own.
 *
 * "A few ms" was measured once, per call, in isolation. In a real session every
 * SQL-backed `ctx_graph` action pays it again, so the sweep is memoised:
 *
 * - **`revision`** — a change token the caller derives from something that
 *   already knows whether the tree moved (the fs-bus counters; see
 *   `src/tools/graph.ts`). While the token is unchanged, no file under the root
 *   has changed, so the previous answer is not merely recent, it is still true,
 *   and the TTL does not apply.
 * - **TTL** — the fallback when no such token exists
 *   ({@link freshnessTtlMs}, `CONTEXT_MODE_GRAPH_FRESHNESS_TTL_MS`).
 *
 * Both are additionally gated on {@link dbStamp}: a cached report is never
 * served across a write to the index, whichever path claimed it was valid.
 *
 * `CONTEXT_MODE_GRAPH_FRESHNESS=0` turns the sweep off for anyone on a
 * filesystem where `stat` is expensive (network mounts, WSL2 `/mnt`).
 */
export function checkFreshness(
  handle: GraphDbHandle,
  opts: {
    env?: NodeJS.ProcessEnv;
    maxFiles?: number;
    toleranceMs?: number;
    /**
     * Opaque token that changes exactly when the working tree might have. Equal
     * tokens keep a cached report valid past the TTL; `null`/absent falls back
     * to the TTL alone.
     */
    revision?: string | null;
    /** Override {@link freshnessTtlMs}. `0` forces a fresh sweep. */
    ttlMs?: number;
  } = {},
): FreshnessReport | null {
  const env = opts.env ?? process.env;
  if (env.CONTEXT_MODE_GRAPH_FRESHNESS === "0") return null;

  const cap = opts.maxFiles ?? numFromEnv(env.CONTEXT_MODE_GRAPH_FRESHNESS_MAX, 5_000);
  // The daemon writes `indexed_at` after reading the file, so an equal-second
  // mtime is not evidence of staleness. One second of slack removes the noise.
  const tolerance = opts.toleranceMs ?? 1_000;

  const ttl = opts.ttlMs ?? freshnessTtlMs(env);
  const revision = opts.revision ?? null;
  const key = `${handle.dbPath}|${cap}|${tolerance}`;
  const now = Date.now();
  const stamp = ttl > 0 ? dbStamp(handle.dbPath) : "";

  if (ttl > 0) {
    const hit = freshnessCache.get(key);
    // When both sides carry a change token, the token IS the answer — a
    // matching one keeps the report valid past the TTL, and a differing one
    // invalidates it immediately, which a TTL alone would not. The TTL is the
    // fallback for calls that arrive without a token (`ctx_doctor`, tests, a
    // session with no fs-bus).
    const bothTokens = hit !== undefined && revision !== null && hit.revision !== null;
    const stillTrue = hit !== undefined
      && hit.stamp === stamp
      && (bothTokens
        ? hit.revision === revision && now - hit.at < REVISION_MAX_AGE_MS
        : now - hit.at < ttl);
    // Copied out: the report is handed to formatters and to `ctx_doctor`, and a
    // shared mutable object would let one of them corrupt the next reader's
    // answer for the rest of the TTL.
    if (stillTrue) return { ...hit.report };
  }

  const meta = readProjectMetadata(handle);
  const lastIndexedAt = Object.values(meta).reduce((n, m) => Math.max(n, m.updatedAt), 0);

  let total = 0;
  let rows: Array<{ path: string; indexed_at: number }> = [];
  try {
    const countRow = handle.db.prepare("SELECT COUNT(*) AS c FROM files").get() as { c?: number };
    total = Number(countRow?.c ?? 0);
    rows = handle.db
      .prepare("SELECT path, indexed_at FROM files ORDER BY indexed_at DESC LIMIT ?")
      .all(cap) as Array<{ path: string; indexed_at: number }>;
  } catch {
    return null;
  }

  let staleFiles = 0;
  let missingFiles = 0;
  let checked = 0;
  for (const row of rows) {
    const rel = String(row.path ?? "");
    if (!rel) continue;
    const abs = isAbsolute(rel) ? rel : join(handle.projectDir, rel);
    checked++;
    try {
      const st = statSync(abs);
      if (st.mtimeMs > Number(row.indexed_at ?? 0) + tolerance) staleFiles++;
    } catch {
      missingFiles++;
    }
  }

  const report: FreshnessReport = {
    staleFiles,
    missingFiles,
    checked,
    total,
    capped: total > checked,
    lastIndexedAt,
  };

  if (ttl > 0) {
    // Insertion order is age order, so the first key is the oldest entry.
    if (freshnessCache.size >= FRESHNESS_CACHE_MAX) {
      const oldest = freshnessCache.keys().next();
      if (!oldest.done) freshnessCache.delete(oldest.value);
    }
    freshnessCache.set(key, { report, at: now, revision, stamp });
  }
  return { ...report };
}

/** One line for the response header, or `null` when the index is current. */
export function formatFreshnessLine(report: FreshnessReport | null): string | null {
  if (!report) return null;
  const behind = report.staleFiles + report.missingFiles;
  if (behind === 0) return null;
  const suffix = report.capped ? ` (of ${report.checked} checked; index has ${report.total})` : "";
  return (
    `⚠ index lags ${behind} file${behind === 1 ? "" : "s"}${suffix} — ` +
    "these results may describe the previous version of that code. " +
    "Run `codegraph sync` (or let the daemon catch up) for an exact answer."
  );
}

function numFromEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ─────────────────────────────────────────────────────────
// CLI fallback
// ─────────────────────────────────────────────────────────

/**
 * Locate the codegraph binary.
 *
 * `CONTEXT_MODE_CODEGRAPH_BIN` wins; then the versioned install layout
 * (`~/.codegraph/versions/v<X>/bin/codegraph`, newest first); then bare
 * `codegraph`, which resolves through PATH at spawn time.
 */
export function codegraphBinary(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.CONTEXT_MODE_CODEGRAPH_BIN;
  if (explicit && existsSync(explicit)) return explicit;

  const home = env.HOME || env.USERPROFILE || homedir();
  const versionsDir = join(home, ".codegraph", "versions");
  try {
    const entries = readdirSync(versionsDir)
      .filter(name => name.startsWith("v"))
      .sort(compareVersionDesc);
    for (const entry of entries) {
      const candidate = join(versionsDir, entry, "bin", "codegraph");
      if (existsSync(candidate)) return candidate;
    }
  } catch { /* no versioned install — fall through to PATH */ }
  return "codegraph";
}

function compareVersionDesc(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(n => Number.parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map(n => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export interface CliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

/** True unless the operator disabled CLI degradation. */
export function cliFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CONTEXT_MODE_GRAPH_CLI_FALLBACK !== "0";
}

/**
 * Run a codegraph subcommand and capture stdout.
 *
 * This is the degradation path for a drifted schema and the transport for
 * `explore`, which has no JSON mode and no SQL equivalent. It is deliberately
 * `spawnSync`: the MCP handler is already async at its own boundary, and a
 * synchronous child keeps the daemon-vs-CLI ordering obvious.
 */
export function runCodegraph(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBuffer?: number } = {},
): CliResult {
  const env = opts.env ?? process.env;
  const bin = codegraphBinary(env);
  try {
    const res = spawnSync(bin, args, {
      cwd: opts.cwd,
      env: { ...env, NO_COLOR: "1" },
      encoding: "utf-8",
      timeout: opts.timeoutMs ?? numFromEnv(env.CONTEXT_MODE_GRAPH_CLI_TIMEOUT_MS, 60_000),
      maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
    });
    return {
      ok: res.status === 0,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? (res.error ? String(res.error.message) : ""),
      code: res.status,
    };
  } catch (err) {
    return { ok: false, stdout: "", stderr: err instanceof Error ? err.message : String(err), code: null };
  }
}

/** `runCodegraph` plus `-j`, with the JSON parsed. `null` on any failure. */
export function runCodegraphJson<T = unknown>(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): T | null {
  const res = runCodegraph([...args, "-j"], opts);
  if (!res.ok || !res.stdout.trim()) return null;
  try {
    return JSON.parse(res.stdout) as T;
  } catch {
    // Some subcommands print a banner before the JSON body. Recover the first
    // balanced object/array rather than losing the whole answer to a prefix.
    const start = res.stdout.search(/[[{]/);
    if (start < 0) return null;
    try {
      return JSON.parse(res.stdout.slice(start)) as T;
    } catch {
      return null;
    }
  }
}

/** Absolute, symlink-free-enough project root for the CLI's `-p` flag. */
export function normalizeProjectDir(dir: string): string {
  return resolve(dir);
}

/** Text for a `.codegraph`-less project, shared by every action. */
export function notIndexedMessage(projectDir: string): string {
  return (
    `No codegraph index for ${projectDir}.\n` +
    `Run \`codegraph init ${projectDir}\` to build one (a few seconds to a few minutes, ` +
    "depending on repository size). ctx_graph reads that index directly and cannot answer without it."
  );
}

/**
 * What ELSE stops working without the index — printed once per project.
 *
 * `ctx_graph` fails loudly when there is no index, but it is not the only
 * consumer: `ctx_find` carries a graph list among its five signals and simply
 * drops it when the index is absent, so retrieval quietly loses a signal and
 * the session never learns why. Saying it out loud at the one moment the user
 * is already looking at the missing index is the cheapest place to close that
 * gap.
 */
export const MISSING_INDEX_CONSEQUENCE =
  "Until then the graph signal of ctx_find is blind too (it contributes nothing to ranking, " +
  "silently), and `ctx_graph` actions other than `explore` cannot answer at all.";

/** Projects already told about their missing index, so the notice is not repeated. */
const missingIndexNoticed = new Set<string>();

/**
 * True the first time this process is asked about a given index-less project.
 *
 * Per process rather than per call: repeating the same paragraph on every
 * `ctx_graph` invocation would be the plugin flooding the context it exists to
 * protect, and repeating it never would leave the first call as silent as the
 * degradation it is warning about.
 */
export function firstMissingIndexNotice(projectDir: string): boolean {
  if (missingIndexNoticed.has(projectDir)) return false;
  missingIndexNoticed.add(projectDir);
  return true;
}

/** Reset the once-per-project notice. Tests only. */
export function __resetMissingIndexNoticesForTests(): void {
  missingIndexNoticed.clear();
}
