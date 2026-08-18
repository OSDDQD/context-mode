/**
 * Lifecycle of the codegraph daemon, and the degraded mode for when there
 * isn't one.
 *
 * ## Why this file exists at all
 *
 * Until stage 3 the daemon came up as a side effect: the MCP host launched
 * `codegraph serve --mcp`, and that process happened to also start the file
 * watcher that keeps `.codegraph/codegraph.db` current. Taking codegraph out of
 * the host's MCP config removed the round trip we wanted to remove — and, as a
 * side effect nobody asks for, the thing that kept the index fresh. So the
 * plugin now owns it: `codegraph serve` (watcher + daemon, **no** `--mcp`,
 * because we are not speaking MCP to it any more — we read its SQLite file).
 *
 * ## Idempotency is the whole problem
 *
 * Several agent sessions can point at one project, each with its own plugin
 * process, all reaching this code within milliseconds of each other. Two
 * guards, because either alone leaks:
 *
 * - **`daemon.pid` + a liveness probe** catches the common case: a daemon is
 *   already up, from any process, from any session, started at any time.
 * - **An exclusive lock file in the system temp dir** catches the race the pid
 *   file cannot: two processes that both looked before either wrote. It lives
 *   in `tmpdir()`, keyed by a hash of the project path — deliberately NOT in
 *   `.codegraph/`, which belongs to codegraph. Nothing in `src/graph/**` writes
 *   into another tool's directory.
 *
 * ## The file-system event source is not imported here
 *
 * A sibling change builds the FS event bus in `src/fff/`. Importing it would
 * couple two in-flight branches and make both untestable in isolation, so this
 * module exposes {@link attachFsSource} and {@link enqueueSync} and waits to be
 * wired. Until something calls them, the queue simply stays empty and the
 * daemon (which has its own watcher) does the work.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type SpawnOptions, type ChildProcess } from "node:child_process";

import { codegraphBinary, codegraphDir, hasCodegraphIndex, runCodegraph } from "./db.js";

// ─────────────────────────────────────────────────────────
// Daemon state
// ─────────────────────────────────────────────────────────

/** Shape codegraph 1.5.0 writes to `.codegraph/daemon.pid`. */
export interface DaemonPidFile {
  pid: number;
  version?: string;
  socketPath?: string;
  startedAt?: number;
}

export interface DaemonStatus {
  /** A process with that pid answers to signal 0. */
  running: boolean;
  /** The pid file exists but names a dead process. */
  stale: boolean;
  /** `daemon.sock` is present. Never connected to — presence only. */
  socketPresent: boolean;
  pid?: number;
  version?: string;
  socketPath?: string;
  startedAt?: number;
}

/** Parse `.codegraph/daemon.pid`. Returns null when absent or malformed. */
export function readDaemonPid(projectDir: string): DaemonPidFile | null {
  const path = join(codegraphDir(projectDir), "daemon.pid");
  try {
    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return null;
    // 1.5.0 writes JSON. Older builds wrote a bare integer; accept both so a
    // downgrade does not read as "no daemon" and trigger a second spawn.
    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw) as DaemonPidFile;
      const pid = Number(parsed?.pid);
      if (!Number.isFinite(pid) || pid <= 0) return null;
      return { ...parsed, pid };
    }
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? { pid } : null;
  } catch {
    return null;
  }
}

/** Default liveness probe: signal 0 tells us the pid exists without touching it. */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** Is a daemon running for this project? Reads files only; never connects. */
export function daemonStatus(
  projectDir: string,
  opts: { isAlive?: (pid: number) => boolean } = {},
): DaemonStatus {
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const socketPresent = existsSync(join(codegraphDir(projectDir), "daemon.sock"));
  const pidFile = readDaemonPid(projectDir);
  if (!pidFile) return { running: false, stale: false, socketPresent };
  const running = isAlive(pidFile.pid);
  return {
    running,
    stale: !running,
    socketPresent,
    pid: pidFile.pid,
    version: pidFile.version,
    socketPath: pidFile.socketPath,
    startedAt: pidFile.startedAt,
  };
}

// ─────────────────────────────────────────────────────────
// Supervision
// ─────────────────────────────────────────────────────────

export type EnsureOutcome =
  /** `CONTEXT_MODE_GRAPH_DAEMON=0`. */
  | "disabled"
  /** No `.codegraph/` — nothing to serve. */
  | "no-index"
  /** A live daemon was already there. */
  | "already-running"
  /** We spawned one. */
  | "started"
  /** The pid file named a dead process; we spawned a replacement. */
  | "restarted"
  /** Another process holds the spawn lock, or we spawned recently. */
  | "deferred"
  /** The spawn itself failed. */
  | "spawn-failed";

export interface EnsureResult {
  outcome: EnsureOutcome;
  pid?: number;
  message: string;
}

/** Injectable process spawner, so tests never fork a real daemon. */
export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => Pick<ChildProcess, "pid" | "unref" | "on"> ;

/** How long a spawn lock is honoured before it is treated as abandoned. */
const LOCK_TTL_MS = 30_000;

/** In-process memory of what we already tried, keyed by project dir. */
const lastAttempt = new Map<string, number>();

/** True unless the operator turned daemon supervision off. */
export function daemonSupervisionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CONTEXT_MODE_GRAPH_DAEMON !== "0";
}

/**
 * Start `codegraph serve` for this project if — and only if — nothing already
 * has.
 *
 * Safe to call on every `ctx_graph` invocation: the fast path is one `readFile`
 * plus one `kill(pid, 0)`.
 */
export function ensureDaemon(
  projectDir: string,
  opts: {
    env?: NodeJS.ProcessEnv;
    spawnFn?: SpawnFn;
    isAlive?: (pid: number) => boolean;
    now?: () => number;
    /** Minimum gap between two spawn attempts from this process. */
    cooldownMs?: number;
  } = {},
): EnsureResult {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const cooldown = opts.cooldownMs ?? LOCK_TTL_MS;

  if (!daemonSupervisionEnabled(env)) {
    return { outcome: "disabled", message: "daemon supervision disabled (CONTEXT_MODE_GRAPH_DAEMON=0)" };
  }
  if (!hasCodegraphIndex(projectDir)) {
    return { outcome: "no-index", message: `no .codegraph index in ${projectDir}` };
  }

  const status = daemonStatus(projectDir, { isAlive: opts.isAlive });
  if (status.running) {
    return { outcome: "already-running", pid: status.pid, message: `codegraph daemon already running (pid ${status.pid})` };
  }

  // In-process cooldown. Without it, a project whose daemon refuses to start
  // turns every ctx_graph call into a fork — the failure amplifies instead of
  // staying a failure.
  const last = lastAttempt.get(projectDir) ?? 0;
  if (now() - last < cooldown) {
    return { outcome: "deferred", message: "spawn attempted recently; waiting before retrying" };
  }

  // Cross-process guard.
  const lock = acquireSpawnLock(projectDir, now(), cooldown);
  if (!lock) {
    return { outcome: "deferred", message: "another session is starting the daemon" };
  }

  lastAttempt.set(projectDir, now());
  const wasStale = status.stale;
  const spawnFn = opts.spawnFn ?? (spawn as unknown as SpawnFn);
  const bin = codegraphBinary(env);

  try {
    // No `--mcp`: we are not a client of its MCP surface any more. Plain
    // `serve` is the watcher + daemon, which is the only part we still want.
    const child = spawnFn(bin, ["serve", "-p", projectDir], {
      cwd: projectDir,
      env: { ...env, NO_COLOR: "1" },
      // Detached + ignored stdio: the daemon must outlive this MCP process,
      // and an inherited pipe nobody drains deadlocks it at 64 KB of output.
      detached: true,
      stdio: "ignore",
    });
    child.unref?.();
    return {
      outcome: wasStale ? "restarted" : "started",
      pid: child.pid ?? undefined,
      message: wasStale
        ? `restarted codegraph daemon (previous pid ${status.pid} was dead)`
        : "started codegraph daemon",
    };
  } catch (err) {
    return {
      outcome: "spawn-failed",
      message: `could not start codegraph daemon: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Forget this process's spawn history. Tests only. */
export function resetDaemonSupervision(): void {
  lastAttempt.clear();
}

/**
 * Path of the cross-process spawn lock.
 *
 * In `tmpdir()`, not in `.codegraph/`: that directory is codegraph's, and the
 * contract for this whole subsystem is that we read it and never write it.
 */
export function spawnLockPath(projectDir: string, dir: string = tmpdir()): string {
  const hash = createHash("sha256").update(projectDir).digest("hex").slice(0, 16);
  return join(dir, `context-mode-codegraph-${hash}.lock`);
}

function acquireSpawnLock(projectDir: string, now: number, ttlMs: number, dir?: string): boolean {
  const path = spawnLockPath(projectDir, dir);
  try {
    const st = statSync(path);
    if (now - st.mtimeMs < ttlMs) return false;
    // Abandoned by a process that died mid-spawn. Reclaim it.
    try { unlinkSync(path); } catch { /* raced; the open below decides */ }
  } catch { /* no lock file — normal */ }

  try {
    mkdirSync(tmpdir(), { recursive: true });
    const fd = openSync(path, "wx");
    try {
      writeSync(fd, `${process.pid} ${projectDir}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    // EEXIST: someone won the race between our stat and our open.
    return false;
  }
}

// ─────────────────────────────────────────────────────────
// Fallback: debounced `codegraph sync`
// ─────────────────────────────────────────────────────────

/**
 * Run one sync pass. Injectable so tests assert scheduling without spawning.
 *
 * `files` is the coalesced set of paths that changed. codegraph 1.5.0's
 * `sync [path]` takes a PROJECT path, not a file, so the list is not passed to
 * the CLI — it is carried because it is the evidence of what changed (useful
 * in the message, and the argument a future per-file sync would take).
 */
export type SyncRunner = (projectDir: string, files: string[]) => void;

interface QueueEntry {
  files: Set<string>;
  timer: NodeJS.Timeout | null;
}

const queues = new Map<string, QueueEntry>();
let syncRunner: SyncRunner | null = null;

/** Replace the sync executor. Pass `null` to restore the CLI default. */
export function setSyncRunner(fn: SyncRunner | null): void {
  syncRunner = fn;
}

function defaultSyncRunner(projectDir: string, _files: string[]): void {
  runCodegraph(["sync", "-q", projectDir], { cwd: projectDir });
}

/** True unless the operator turned the fallback queue off. */
export function syncQueueEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CONTEXT_MODE_GRAPH_SYNC !== "0";
}

function debounceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CONTEXT_MODE_GRAPH_SYNC_DEBOUNCE_MS;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 1_500;
}

/**
 * Record that a file changed, and schedule a sync.
 *
 * This is the public entry point for the FS event bus being built in
 * `src/fff/`. It is intentionally a plain function taking a path: the caller
 * needs no types from this module, and this module needs no import from
 * theirs — the two land independently and meet at this signature.
 *
 * Coalescing is the point. A save-all in an editor fires dozens of events;
 * one `codegraph sync` afterwards costs less than one per file, and the daemon
 * (when there is one) makes the whole path unnecessary anyway.
 */
export function enqueueSync(
  filePath: string,
  opts: { projectDir?: string; env?: NodeJS.ProcessEnv } = {},
): void {
  const env = opts.env ?? process.env;
  if (!syncQueueEnabled(env)) return;
  const projectDir = opts.projectDir ?? env.CONTEXT_MODE_PROJECT_DIR ?? process.cwd();
  if (!hasCodegraphIndex(projectDir)) return;

  // A live daemon already watches the tree; a second sync would be pure
  // contention on the same SQLite file.
  if (daemonStatus(projectDir).running) return;

  let entry = queues.get(projectDir);
  if (!entry) {
    entry = { files: new Set(), timer: null };
    queues.set(projectDir, entry);
  }
  if (filePath) entry.files.add(filePath);

  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => { void flushSyncQueue(projectDir); }, debounceMs(env));
  // Never hold the process open for a background sync.
  entry.timer.unref?.();
}

/**
 * Subscribe this queue to a file-system event source.
 *
 * @param subscribe A function that registers a `(path) => void` handler and
 *   returns its unsubscribe callback. Written this way so the FS bus in
 *   `src/fff/` can hand over whatever shape it settles on without either
 *   module importing the other.
 * @returns Detach function. Calling it unsubscribes and drops pending work.
 */
export type FsSubscribe = (handler: (filePath: string) => void) => (() => void) | void;

export function attachFsSource(
  subscribe: FsSubscribe,
  opts: { projectDir?: string; env?: NodeJS.ProcessEnv } = {},
): () => void {
  const unsubscribe = subscribe((filePath: string) => enqueueSync(filePath, opts));
  return () => {
    try { unsubscribe?.(); } catch { /* source already gone */ }
  };
}

export interface SyncFlushResult {
  projectDir: string;
  files: string[];
  ran: boolean;
}

/**
 * Run the pending sync for one project (or every project) now.
 *
 * Exposed because "flush before you answer" is the right move for a tool that
 * is about to report on the index it just invalidated.
 */
export function flushSyncQueue(projectDir?: string): SyncFlushResult[] {
  const targets = projectDir ? [projectDir] : [...queues.keys()];
  const results: SyncFlushResult[] = [];
  for (const dir of targets) {
    const entry = queues.get(dir);
    if (!entry) continue;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    const files = [...entry.files];
    entry.files.clear();
    queues.delete(dir);
    if (files.length === 0) {
      results.push({ projectDir: dir, files, ran: false });
      continue;
    }
    try {
      (syncRunner ?? defaultSyncRunner)(dir, files);
      results.push({ projectDir: dir, files, ran: true });
    } catch {
      // A failed sync is a stale index, which `checkFreshness` already reports
      // to the caller. Nothing here is worth throwing into a tool handler.
      results.push({ projectDir: dir, files, ran: false });
    }
  }
  return results;
}

/** Pending work, for tests and diagnostics. */
export function syncQueueState(): Array<{ projectDir: string; files: string[]; scheduled: boolean }> {
  return [...queues.entries()].map(([projectDir, entry]) => ({
    projectDir,
    files: [...entry.files],
    scheduled: entry.timer !== null,
  }));
}

/** Drop every pending timer and file. Tests only. */
export function resetSyncQueue(): void {
  for (const entry of queues.values()) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  queues.clear();
  syncRunner = null;
}
