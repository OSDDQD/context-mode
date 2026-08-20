/**
 * The long-lived read-only handle pool.
 *
 * What is being defended here is not the speed — that is easy and uninteresting
 * — but the four ways a cached SQLite connection goes silently wrong: the file
 * is deleted and the fd keeps answering from the dead inode; the file is
 * replaced by a rebuild and the fd keeps answering from the dead inode; the
 * index goes back to `indexing` and the cached "complete" says otherwise; and
 * the pool grows without bound until the process runs out of descriptors.
 * Every one of those failures looks like a correct answer, so each gets a test.
 */

import { describe, test, expect, afterEach } from "vitest";
import { renameSync, rmSync, statSync, utimesSync } from "node:fs";

import {
  GRAPH_POOL_MAX,
  closeGraphDbPool,
  codegraphDbPath,
  graphPoolMax,
  graphPoolStats,
  openGraphDb,
  readProjectMetadata,
} from "../../src/graph/db.js";
import { loadDatabase } from "../../src/db-base.js";
import { defaultFixture, makeGraphFixture } from "./fixture.js";

const dirs: string[] = [];
function track<T extends { projectDir: string }>(f: T): T {
  dirs.push(f.projectDir);
  return f;
}

afterEach(() => {
  closeGraphDbPool();
  while (dirs.length) {
    const d = dirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** Open, assert success, return the handle. */
function open(projectDir: string, env?: NodeJS.ProcessEnv) {
  const res = openGraphDb(projectDir, env ? { env } : {});
  if (!res.ok) throw new Error(`expected an open handle, got ${res.reason}: ${res.message}`);
  return res.handle;
}

/** Nudge the file's mtime forward so a same-millisecond write is still visible. */
function bumpMtime(path: string): void {
  const st = statSync(path);
  const next = new Date(st.mtimeMs + 5_000);
  utimesSync(path, next, next);
}

describe("graph handle pool — reuse", () => {
  test("repeated opens share one connection", () => {
    const fx = track(defaultFixture());

    const a = open(fx.projectDir);
    a.close();
    const b = open(fx.projectDir);
    b.close();

    // Same driver object, not merely an equal one: this is the whole point.
    expect(b.db).toBe(a.db);
    expect(graphPoolStats()).toHaveLength(1);
  });

  test("close() releases a lease instead of closing the connection", () => {
    const fx = track(defaultFixture());

    const a = open(fx.projectDir);
    const b = open(fx.projectDir);
    expect(graphPoolStats()[0]!.leases).toBe(2);

    a.close();
    a.close(); // idempotent — a double close must not under-count the lease.
    expect(graphPoolStats()[0]!.leases).toBe(1);

    // b is still usable after a's close, which a real close would have broken.
    expect(b.db.prepare("SELECT COUNT(*) AS c FROM nodes").get()).toBeTruthy();
    b.close();
    expect(graphPoolStats()[0]!.leases).toBe(0);
  });

  test("the pooled connection is still read-only", () => {
    const fx = track(defaultFixture());
    const a = open(fx.projectDir);
    a.close();
    const b = open(fx.projectDir);
    // `query_only` is set once, at open. A pooled handle that lost it would let
    // this plugin corrupt a database it does not own.
    expect(() => b.db.prepare("DELETE FROM nodes").run()).toThrow();
    b.close();
  });

  test("pool: false hands out a private connection", () => {
    const fx = track(defaultFixture());
    const shared = open(fx.projectDir);
    shared.close();

    const res = openGraphDb(fx.projectDir, { pool: false });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.handle.db).not.toBe(shared.db);
    res.handle.close();
    // A private close really closes; the pooled one is untouched.
    expect(() => res.handle.db.prepare("SELECT 1").get()).toThrow();
    expect(shared.db.prepare("SELECT 1 AS one").get()).toEqual({ one: 1 });
  });

  test("CONTEXT_MODE_GRAPH_POOL_MAX=0 disables pooling entirely", () => {
    const fx = track(defaultFixture());
    const env = { ...process.env, CONTEXT_MODE_GRAPH_POOL_MAX: "0" } as NodeJS.ProcessEnv;

    expect(graphPoolMax(env)).toBe(0);
    const a = open(fx.projectDir, env);
    const b = open(fx.projectDir, env);
    expect(b.db).not.toBe(a.db);
    expect(graphPoolStats()).toHaveLength(0);
    a.close();
    b.close();
  });

  test("graphPoolMax falls back to the default on nonsense", () => {
    expect(graphPoolMax({} as NodeJS.ProcessEnv)).toBe(GRAPH_POOL_MAX);
    expect(graphPoolMax({ CONTEXT_MODE_GRAPH_POOL_MAX: "2" } as NodeJS.ProcessEnv)).toBe(2);
    expect(graphPoolMax({ CONTEXT_MODE_GRAPH_POOL_MAX: "junk" } as NodeJS.ProcessEnv)).toBe(GRAPH_POOL_MAX);
  });
});

describe("graph handle pool — invalidation", () => {
  test("an atomically rebuilt index (same path, new inode) gets a fresh connection", () => {
    const before = track(makeGraphFixture({ metadata: { index_state: "complete", build: "before" } }));
    const a = open(before.projectDir);
    expect(readProjectMetadata(a).build?.value).toBe("before");
    a.close();

    // Exactly how codegraph replaces an index: build elsewhere, rename over the
    // path. The old inode is now unlinked but our fd still maps it, and it will
    // happily answer every query with the pre-rebuild graph.
    const rebuilt = track(makeGraphFixture({ metadata: { index_state: "complete", build: "after" } }));
    renameSync(rebuilt.dbPath, before.dbPath);

    const b = open(before.projectDir);
    expect(b.db).not.toBe(a.db);
    expect(readProjectMetadata(b).build?.value).toBe("after");
    b.close();

    // The connection to the dead inode was closed, not merely dropped.
    expect(() => a.db.prepare("SELECT 1").get()).toThrow();
  });

  test("a deleted index is reported, never served from the cached fd", () => {
    const fx = track(defaultFixture());
    const a = open(fx.projectDir);
    a.close();

    rmSync(fx.dbPath, { force: true });

    const res = openGraphDb(fx.projectDir);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("no-index");
    expect(graphPoolStats()).toHaveLength(0);
    expect(() => a.db.prepare("SELECT 1").get()).toThrow();
  });

  test("an in-place write that flips index_state is caught through the cache", () => {
    const fx = track(defaultFixture());
    const a = open(fx.projectDir);
    a.close();

    // The daemon re-indexing in place: same inode, same connection, but the
    // state the handle was admitted on is no longer true.
    const Database = loadDatabase();
    const writer = new Database(fx.dbPath);
    writer.prepare("UPDATE project_metadata SET value = 'indexing' WHERE key = 'index_state'").run();
    writer.close();
    bumpMtime(fx.dbPath);

    const res = openGraphDb(fx.projectDir);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("incomplete");
    expect(graphPoolStats()).toHaveLength(0);
  });

  test("an ordinary write re-reads the metadata but keeps the connection", () => {
    const fx = track(defaultFixture());
    const a = open(fx.projectDir);
    a.close();

    // The daemon committing a normal incremental update. SQLite readers see a
    // writer's commits through an already-open connection, so reopening here
    // would be pure cost — only the admission rows need re-reading.
    const Database = loadDatabase();
    const writer = new Database(fx.dbPath);
    writer.prepare("INSERT INTO project_metadata (key, value, updated_at) VALUES ('build', 'later', ?)")
      .run(Date.now());
    writer.close();
    bumpMtime(fx.dbPath);

    const b = open(fx.projectDir);
    expect(b.db).toBe(a.db);
    expect(b.indexState).toBe("complete");
    expect(readProjectMetadata(b).build?.value).toBe("later");
    b.close();
    expect(graphPoolStats()).toHaveLength(1);
  });

  test("schema-version rejection still fires on a cached handle", () => {
    const fx = track(defaultFixture()); // schema_versions = 8
    const a = open(fx.projectDir);
    a.close();
    expect(graphPoolStats()).toHaveLength(1);

    // The operator narrows the supported range without the file changing. A
    // cached handle must not outlive the range it was admitted under.
    const env = { ...process.env, CONTEXT_MODE_GRAPH_SCHEMA_MAX: "3" } as NodeJS.ProcessEnv;
    const res = openGraphDb(fx.projectDir, { env });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("schema-drift");
    expect(res.schemaVersion).toBe(8);
    expect(graphPoolStats()).toHaveLength(0);
    expect(() => a.db.prepare("SELECT 1").get()).toThrow();
  });

  test("a corrupted index is refused and its connection dropped", () => {
    const fx = track(defaultFixture());
    const a = open(fx.projectDir);
    a.close();

    // Same inode, but the admission tables are gone. SQLite reports this the
    // same way it reports a file that was never an index; both must degrade to
    // the CLI rather than answer from a half-readable database.
    const Database = loadDatabase();
    const writer = new Database(fx.dbPath);
    writer.exec("DROP TABLE schema_versions");
    writer.close();
    bumpMtime(fx.dbPath);

    const res = openGraphDb(fx.projectDir);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("schema-drift");
    expect(graphPoolStats()).toHaveLength(0);
  });
});

describe("graph handle pool — bounds", () => {
  test("eviction closes the evicted connection", () => {
    const env = { ...process.env, CONTEXT_MODE_GRAPH_POOL_MAX: "1" } as NodeJS.ProcessEnv;
    const one = track(defaultFixture());
    const two = track(defaultFixture());

    const a = open(one.projectDir, env);
    a.close();
    const b = open(two.projectDir, env);
    b.close();

    expect(graphPoolStats()).toHaveLength(1);
    expect(graphPoolStats()[0]!.dbPath).toBe(codegraphDbPath(two.projectDir));
    // The failure this bound exists to prevent is a descriptor leak, so the
    // evicted entry has to be closed, not merely forgotten.
    expect(() => a.db.prepare("SELECT 1").get()).toThrow();
  });

  test("two projects at once each keep their own connection", () => {
    const one = track(defaultFixture());
    const two = track(defaultFixture());

    const a = open(one.projectDir);
    const b = open(two.projectDir);
    expect(a.db).not.toBe(b.db);
    expect(a.projectDir).toBe(one.projectDir);
    expect(b.projectDir).toBe(two.projectDir);
    expect(graphPoolStats()).toHaveLength(2);

    a.close();
    b.close();

    // Interleaved reuse: neither eviction nor a shared key collapsed them.
    const a2 = open(one.projectDir);
    const b2 = open(two.projectDir);
    expect(a2.db).toBe(a.db);
    expect(b2.db).toBe(b.db);
    a2.close();
    b2.close();
  });

  test("an evicted-but-leased connection is closed only on release", () => {
    const env = { ...process.env, CONTEXT_MODE_GRAPH_POOL_MAX: "1" } as NodeJS.ProcessEnv;
    const one = track(defaultFixture());
    const two = track(defaultFixture());

    const a = open(one.projectDir, env); // deliberately still leased
    const b = open(two.projectDir, env); // evicts `one`

    // Pulling the connection out from under a live lease would turn a caching
    // optimisation into a crash inside somebody's query.
    expect(a.db.prepare("SELECT 1 AS one").get()).toEqual({ one: 1 });
    a.close();
    expect(() => a.db.prepare("SELECT 1").get()).toThrow();
    b.close();
  });

  test("closeGraphDbPool(dbPath) closes exactly one entry", () => {
    const one = track(defaultFixture());
    const two = track(defaultFixture());
    const a = open(one.projectDir);
    a.close();
    const b = open(two.projectDir);
    b.close();

    closeGraphDbPool(one.dbPath);
    expect(graphPoolStats()).toHaveLength(1);
    expect(() => a.db.prepare("SELECT 1").get()).toThrow();
    expect(b.db.prepare("SELECT 1 AS one").get()).toEqual({ one: 1 });
  });
});
