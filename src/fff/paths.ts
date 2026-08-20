/**
 * Where the fff layer keeps its persistent state, and how a project root is
 * canonicalized before anything is keyed on it.
 *
 * Storage lives beside the rest of the plugin's databases
 * (`~/.claude/context-mode/fff/`, or `<CONTEXT_MODE_DIR>/fff`) so that:
 *   - frecency/recency ranking survives a server restart, and
 *   - `ctx_doctor` can point at one directory and report its size.
 *
 * The databases are keyed by `hashProjectDirCanonical` — the SAME hash the
 * FTS5 content store uses — so one project can never read or write another
 * project's ranking data. That is the isolation contract from 08ddb5e
 * ("stop one project's files landing in another project's knowledge base")
 * carried into this new channel.
 */

import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { hashProjectDirCanonical, normalizeWorktreePath } from "../session/db.js";
import { FFF_DIR_ENV } from "./env.js";

const STORAGE_ROOT_ENV = "CONTEXT_MODE_DIR" as const;
const FFF_SUBDIR = "fff";

export interface FffDbPaths {
  storageDir: string;
  frecencyDbPath: string;
  historyDbPath: string;
  /** Stable per-project key, shared with the FTS5 content store. */
  projectHash: string;
}

/**
 * Resolution order, mirroring `resolveContentStorageDir` in `src/session/db.ts`:
 *   1. `CONTEXT_MODE_FFF_DIR`  — absolute, this layer only (test seam / opt-out).
 *   2. `CONTEXT_MODE_DIR`      — absolute, plugin-wide storage root → `<root>/fff`.
 *   3. `~/.claude/context-mode/fff`.
 *
 * Non-absolute overrides are ignored rather than fatal: a bad env var must not
 * take the search layer down, it degrades to the default.
 */
export function resolveFffStorageDir(env: NodeJS.ProcessEnv = process.env): string {
  const own = env[FFF_DIR_ENV]?.trim();
  if (own && isAbsolute(own)) return resolve(own);

  const shared = env[STORAGE_ROOT_ENV]?.trim();
  if (shared && isAbsolute(shared)) return join(resolve(shared), FFF_SUBDIR);

  return join(homedir(), ".claude", "context-mode", FFF_SUBDIR);
}

/**
 * Canonical project root: absolute, symlink-resolved, trailing separators
 * stripped. Used as the registry key AND as the native `basePath`, so two
 * spellings of the same directory can never open two indexes.
 *
 * Casing is preserved (the native layer needs a real path); the case folding
 * that case-insensitive filesystems need happens inside
 * `hashProjectDirCanonical`, which is what names the database files.
 */
export function canonicalProjectRoot(projectDir: string): string {
  const abs = resolve(projectDir);
  const memoised = canonicalRootCache.get(abs);
  if (memoised !== undefined) return memoised;

  let real = abs;
  let resolved = false;
  try {
    real = realpathSync.native(abs);
    resolved = true;
  } catch {
    // Path may not exist yet (fresh worktree, test fixture) — keep the
    // resolved form. `acquireFinder` reports the failure from the native
    // create() call, which has a better error message than we could invent.
  }
  const canonical = normalizeWorktreePath(real);

  // Only SUCCESSFUL resolutions are memoised. A path that did not exist yet is
  // the one case where the answer legitimately changes during a process — a
  // worktree gets created, a fixture directory is made — and pinning the
  // fallback would keep every later lookup on a non-canonical spelling.
  if (resolved) {
    if (canonicalRootCache.size >= CANONICAL_ROOT_CACHE_MAX) canonicalRootCache.clear();
    canonicalRootCache.set(abs, canonical);
  }
  return canonical;
}

/**
 * Memo for {@link canonicalProjectRoot}: resolved input → canonical root.
 *
 * `realpathSync.native` is a syscall per path component and this function runs
 * on EVERY finder-registry lookup, every fs-bus installation lookup and every
 * `fffDbPathsFor` — i.e. several times per tool call, always with the same one
 * or two project roots, always for an answer that already came back.
 *
 * Invalidation semantics, deliberately none-within-a-process: an entry lives
 * until the process exits. The mapping can only change if a symlink on the path
 * is retargeted or the directory is swapped underneath a running server, and in
 * that case re-resolving would not repair anything — the finder registry, the
 * fs-bus installations and the FTS5 project hash are all already keyed on the
 * value handed out earlier, so a late change of answer would split one
 * project's state across two keys instead of moving it. {@link
 * clearCanonicalProjectRootCache} exists for tests, and for a host that knows
 * it moved the tree.
 *
 * Keyed on `resolve(projectDir)` rather than the raw argument: `resolve` reads
 * `process.cwd()`, so caching a relative spelling would answer from the wrong
 * working directory after a `chdir`. The string work is free next to the
 * syscalls it guards.
 */
const canonicalRootCache = new Map<string, string>();

/** Bound on the memo. A server sees one or two roots; a test harness can churn
 *  through hundreds of temp dirs, and an unbounded map would retain them all.
 *  Clearing wholesale rather than evicting is right for a map whose steady
 *  state is two entries — the next few lookups just pay the syscall again. */
const CANONICAL_ROOT_CACHE_MAX = 512;

/** Drop the memo. For tests, and for a host that moved the tree under itself. */
export function clearCanonicalProjectRootCache(): void {
  canonicalRootCache.clear();
}

/** Per-project database paths under the shared storage directory. */
export function fffDbPathsFor(
  projectRoot: string,
  opts: { storageDir?: string; env?: NodeJS.ProcessEnv } = {},
): FffDbPaths {
  const storageDir = opts.storageDir ?? resolveFffStorageDir(opts.env ?? process.env);
  const projectHash = hashProjectDirCanonical(projectRoot);
  return {
    storageDir,
    projectHash,
    // `.mdb` paths are directories on disk (LMDB env with data/lock files).
    frecencyDbPath: join(storageDir, `${projectHash}-frecency.mdb`),
    historyDbPath: join(storageDir, `${projectHash}-history.mdb`),
  };
}

/**
 * Create the storage directory. Returns false instead of throwing — a
 * read-only HOME means "run without persistent ranking", not "crash".
 */
export function ensureFffStorageDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `candidate` is inside `root`. Defence in depth for the isolation
 * contract: every path leaving this module is checked, so a native result or
 * a watch event pointing outside the project is dropped rather than handed to
 * a consumer that would index it.
 */
export function isInsideRoot(candidate: string, root: string): boolean {
  if (!candidate) return false;
  const rel = relative(root, resolve(root, candidate));
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/** Absolute path for a root-relative hit, normalized for the host platform. */
export function absolutePathIn(root: string, relativePath: string): string {
  return resolve(root, relativePath);
}

/** Disk size of one `.mdb` database directory (or file), best effort. */
export function dbDiskBytes(dbPath: string): number | undefined {
  try {
    if (!existsSync(dbPath)) return undefined;
    const st = statSync(dbPath);
    if (st.isFile()) return st.size;
    // LMDB environment: the data file carries essentially all of the size.
    const data = join(dbPath, "data.mdb");
    return existsSync(data) ? statSync(data).size : 0;
  } catch {
    return undefined;
  }
}
