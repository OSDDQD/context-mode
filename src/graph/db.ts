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
 */
export function openGraphDb(
  projectDir: string,
  opts: { env?: NodeJS.ProcessEnv } = {},
): GraphOpenResult {
  const env = opts.env ?? process.env;
  const dbPath = codegraphDbPath(projectDir);

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

  let schemaVersion = 0;
  let indexState = "";
  try {
    const row = db
      .prepare("SELECT MAX(version) AS v FROM schema_versions")
      .get() as { v?: number } | undefined;
    schemaVersion = Number(row?.v ?? 0);
    const meta = db
      .prepare("SELECT value FROM project_metadata WHERE key = 'index_state'")
      .get() as { value?: string } | undefined;
    indexState = String(meta?.value ?? "");
  } catch (err) {
    closeQuietly(db);
    return {
      ok: false,
      reason: "schema-drift",
      message:
        `${dbPath} does not look like a codegraph index (${err instanceof Error ? err.message : String(err)}). ` +
        "Falling back to the codegraph CLI.",
    };
  }

  const max = schemaMax(env);
  if (schemaVersion < SCHEMA_MIN || schemaVersion > max) {
    closeQuietly(db);
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
    closeQuietly(db);
    return {
      ok: false,
      reason: "incomplete",
      schemaVersion,
      message:
        `The codegraph index for ${projectDir} is in state "${indexState}", not "complete". ` +
        "Indexing is probably still running — retry in a moment, or run `codegraph status` to check.",
    };
  }

  let closed = false;
  const handle: GraphDbHandle = {
    db,
    dbPath,
    projectDir,
    schemaVersion,
    indexState: indexState || "complete",
    close() {
      if (closed) return;
      closed = true;
      closeQuietly(db);
    },
  };
  return { ok: true, handle };
}

function closeQuietly(db: DatabaseInstance): void {
  try { db.close(); } catch { /* already closed */ }
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
 * `CONTEXT_MODE_GRAPH_FRESHNESS=0` turns the sweep off for anyone on a
 * filesystem where `stat` is expensive (network mounts, WSL2 `/mnt`).
 */
export function checkFreshness(
  handle: GraphDbHandle,
  opts: { env?: NodeJS.ProcessEnv; maxFiles?: number; toleranceMs?: number } = {},
): FreshnessReport | null {
  const env = opts.env ?? process.env;
  if (env.CONTEXT_MODE_GRAPH_FRESHNESS === "0") return null;

  const cap = opts.maxFiles ?? numFromEnv(env.CONTEXT_MODE_GRAPH_FRESHNESS_MAX, 5_000);
  // The daemon writes `indexed_at` after reading the file, so an equal-second
  // mtime is not evidence of staleness. One second of slack removes the noise.
  const tolerance = opts.toleranceMs ?? 1_000;

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

  return {
    staleFiles,
    missingFiles,
    checked,
    total,
    capped: total > checked,
    lastIndexedAt,
  };
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
