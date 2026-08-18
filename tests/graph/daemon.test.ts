/**
 * Daemon supervision and the sync fallback.
 *
 * Nothing here forks a real `codegraph serve`: the spawner and the liveness
 * probe are both injected, so what is under test is the decision — start,
 * restart, or stand down — and not the child process.
 */

import { describe, test, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  attachFsSource,
  daemonStatus,
  daemonSupervisionEnabled,
  ensureDaemon,
  enqueueSync,
  flushSyncQueue,
  readDaemonPid,
  resetDaemonSupervision,
  resetSyncQueue,
  setSyncRunner,
  spawnLockPath,
  syncQueueEnabled,
  syncQueueState,
  type SpawnFn,
} from "../../src/graph/daemon.js";
import { defaultFixture } from "./fixture.js";

const dirs: string[] = [];

interface SpawnCall { command: string; args: string[] }

function recordingSpawn(calls: SpawnCall[], pid = 4242): SpawnFn {
  return (command, args) => {
    calls.push({ command, args });
    return { pid, unref: () => undefined, on: () => undefined } as never;
  };
}

function fixture(): string {
  const fx = defaultFixture();
  dirs.push(fx.projectDir);
  // Each test gets a project whose spawn lock has never been taken.
  try { unlinkSync(spawnLockPath(fx.projectDir)); } catch { /* none yet */ }
  return fx.projectDir;
}

beforeEach(() => {
  resetDaemonSupervision();
  resetSyncQueue();
});

afterEach(() => {
  resetDaemonSupervision();
  resetSyncQueue();
  while (dirs.length) {
    const d = dirs.pop()!;
    try { unlinkSync(spawnLockPath(d)); } catch { /* fine */ }
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("readDaemonPid / daemonStatus", () => {
  test("parses the 1.5.0 JSON pid file", () => {
    const dir = fixture();
    writeFileSync(
      join(dir, ".codegraph", "daemon.pid"),
      JSON.stringify({ pid: 99, version: "1.5.0", socketPath: "/x/daemon.sock", startedAt: 7 }),
    );
    const pidFile = readDaemonPid(dir);
    expect(pidFile).toEqual({ pid: 99, version: "1.5.0", socketPath: "/x/daemon.sock", startedAt: 7 });

    const status = daemonStatus(dir, { isAlive: () => true });
    expect(status.running).toBe(true);
    expect(status.stale).toBe(false);
    expect(status.pid).toBe(99);
  });

  test("accepts a bare-integer pid file from an older build", () => {
    const dir = fixture();
    writeFileSync(join(dir, ".codegraph", "daemon.pid"), "1234\n");
    expect(readDaemonPid(dir)?.pid).toBe(1234);
  });

  test("a dead pid reads as stale, not running", () => {
    const dir = fixture();
    writeFileSync(join(dir, ".codegraph", "daemon.pid"), JSON.stringify({ pid: 5 }));
    const status = daemonStatus(dir, { isAlive: () => false });
    expect(status.running).toBe(false);
    expect(status.stale).toBe(true);
  });

  test("no pid file at all is neither running nor stale", () => {
    const dir = fixture();
    expect(readDaemonPid(dir)).toBeNull();
    expect(daemonStatus(dir)).toMatchObject({ running: false, stale: false });
  });
});

describe("ensureDaemon", () => {
  test("starts `codegraph serve` without --mcp when nothing is running", () => {
    const dir = fixture();
    const calls: SpawnCall[] = [];
    const res = ensureDaemon(dir, { spawnFn: recordingSpawn(calls), isAlive: () => false });
    expect(res.outcome).toBe("started");
    expect(res.pid).toBe(4242);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["serve", "-p", dir]);
    // The whole point of stage 3: we are not an MCP client of codegraph.
    expect(calls[0].args).not.toContain("--mcp");
  });

  test("is idempotent — a second call does not spawn a second daemon", () => {
    const dir = fixture();
    const calls: SpawnCall[] = [];
    const spawnFn = recordingSpawn(calls);
    expect(ensureDaemon(dir, { spawnFn, isAlive: () => false }).outcome).toBe("started");
    const second = ensureDaemon(dir, { spawnFn, isAlive: () => false });
    expect(second.outcome).toBe("deferred");
    expect(calls).toHaveLength(1);
  });

  test("a live daemon short-circuits before the spawn lock is ever taken", () => {
    const dir = fixture();
    writeFileSync(join(dir, ".codegraph", "daemon.pid"), JSON.stringify({ pid: 77 }));
    const calls: SpawnCall[] = [];
    const res = ensureDaemon(dir, { spawnFn: recordingSpawn(calls), isAlive: () => true });
    expect(res.outcome).toBe("already-running");
    expect(res.pid).toBe(77);
    expect(calls).toHaveLength(0);
  });

  test("a dead pid file triggers a restart, and says so", () => {
    const dir = fixture();
    writeFileSync(join(dir, ".codegraph", "daemon.pid"), JSON.stringify({ pid: 77 }));
    const calls: SpawnCall[] = [];
    const res = ensureDaemon(dir, { spawnFn: recordingSpawn(calls), isAlive: () => false });
    expect(res.outcome).toBe("restarted");
    expect(res.message).toContain("77");
    expect(calls).toHaveLength(1);
  });

  test("a second process is held off by the on-disk spawn lock", () => {
    const dir = fixture();
    const calls: SpawnCall[] = [];
    expect(ensureDaemon(dir, { spawnFn: recordingSpawn(calls), isAlive: () => false }).outcome)
      .toBe("started");
    // Simulate a different process: its in-memory cooldown is empty, but the
    // lock file this one wrote is still fresh.
    resetDaemonSupervision();
    const second = ensureDaemon(dir, { spawnFn: recordingSpawn(calls), isAlive: () => false });
    expect(second.outcome).toBe("deferred");
    expect(calls).toHaveLength(1);
  });

  test("an abandoned lock is reclaimed once its TTL passes", () => {
    const dir = fixture();
    const calls: SpawnCall[] = [];
    const t0 = Date.now();
    ensureDaemon(dir, { spawnFn: recordingSpawn(calls), isAlive: () => false, now: () => t0 });
    resetDaemonSupervision();
    const later = t0 + 120_000;
    const res = ensureDaemon(dir, {
      spawnFn: recordingSpawn(calls), isAlive: () => false, now: () => later, cooldownMs: 30_000,
    });
    expect(res.outcome).toBe("started");
    expect(calls).toHaveLength(2);
  });

  test("CONTEXT_MODE_GRAPH_DAEMON=0 turns supervision off", () => {
    const dir = fixture();
    const calls: SpawnCall[] = [];
    const env = { CONTEXT_MODE_GRAPH_DAEMON: "0" } as NodeJS.ProcessEnv;
    expect(daemonSupervisionEnabled(env)).toBe(false);
    const res = ensureDaemon(dir, { env, spawnFn: recordingSpawn(calls), isAlive: () => false });
    expect(res.outcome).toBe("disabled");
    expect(calls).toHaveLength(0);
  });

  test("a project with no index is never served", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-graph-noidx-"));
    dirs.push(dir);
    const calls: SpawnCall[] = [];
    expect(ensureDaemon(dir, { spawnFn: recordingSpawn(calls), isAlive: () => false }).outcome)
      .toBe("no-index");
    expect(calls).toHaveLength(0);
  });

  test("a throwing spawner is reported, not propagated", () => {
    const dir = fixture();
    const res = ensureDaemon(dir, {
      isAlive: () => false,
      spawnFn: () => { throw new Error("ENOENT"); },
    });
    expect(res.outcome).toBe("spawn-failed");
    expect(res.message).toContain("ENOENT");
  });
});

describe("sync fallback queue", () => {
  const slowDebounce = { CONTEXT_MODE_GRAPH_SYNC_DEBOUNCE_MS: "10000" } as NodeJS.ProcessEnv;

  test("coalesces many file events into one sync", () => {
    const dir = fixture();
    const runs: Array<{ projectDir: string; files: string[] }> = [];
    setSyncRunner((projectDir, files) => runs.push({ projectDir, files }));

    enqueueSync("src/a.ts", { projectDir: dir, env: slowDebounce });
    enqueueSync("src/b.ts", { projectDir: dir, env: slowDebounce });
    enqueueSync("src/a.ts", { projectDir: dir, env: slowDebounce });

    const pending = syncQueueState();
    expect(pending).toHaveLength(1);
    expect(pending[0].files.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(pending[0].scheduled).toBe(true);

    const flushed = flushSyncQueue();
    expect(flushed[0].ran).toBe(true);
    expect(runs).toHaveLength(1);
    expect(runs[0].files.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(syncQueueState()).toHaveLength(0);
  });

  test("does nothing for a project with no codegraph index", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-graph-nosync-"));
    dirs.push(dir);
    setSyncRunner(() => { throw new Error("must not run"); });
    enqueueSync("src/a.ts", { projectDir: dir, env: slowDebounce });
    expect(syncQueueState()).toHaveLength(0);
  });

  test("stands down while a live daemon is watching the tree", () => {
    const dir = fixture();
    // `daemonStatus` inside enqueueSync uses the real probe, so name a pid that
    // is certainly alive: this test process.
    writeFileSync(join(dir, ".codegraph", "daemon.pid"), JSON.stringify({ pid: process.pid }));
    setSyncRunner(() => { throw new Error("must not run"); });
    enqueueSync("src/a.ts", { projectDir: dir, env: slowDebounce });
    expect(syncQueueState()).toHaveLength(0);
  });

  test("CONTEXT_MODE_GRAPH_SYNC=0 disables the queue", () => {
    const dir = fixture();
    const env = { CONTEXT_MODE_GRAPH_SYNC: "0" } as NodeJS.ProcessEnv;
    expect(syncQueueEnabled(env)).toBe(false);
    enqueueSync("src/a.ts", { projectDir: dir, env });
    expect(syncQueueState()).toHaveLength(0);
  });

  test("attachFsSource wires an external event source and returns a detach", () => {
    const dir = fixture();
    const runs: string[][] = [];
    setSyncRunner((_p, files) => runs.push(files));

    let emit: ((p: string) => void) | null = null;
    let unsubscribed = false;
    const detach = attachFsSource(
      handler => { emit = handler; return () => { unsubscribed = true; }; },
      { projectDir: dir, env: slowDebounce },
    );

    expect(emit).toBeTypeOf("function");
    emit!("src/one.ts");
    emit!("src/two.ts");
    flushSyncQueue();
    expect(runs).toHaveLength(1);
    expect(runs[0].sort()).toEqual(["src/one.ts", "src/two.ts"]);

    detach();
    expect(unsubscribed).toBe(true);
  });

  test("a failing sync runner never escapes the flush", () => {
    const dir = fixture();
    setSyncRunner(() => { throw new Error("codegraph missing"); });
    enqueueSync("src/a.ts", { projectDir: dir, env: slowDebounce });
    const flushed = flushSyncQueue();
    expect(flushed[0].ran).toBe(false);
  });
});
