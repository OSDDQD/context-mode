/**
 * Opening someone else's database.
 *
 * The three properties asserted here are the ones that, if they broke, would
 * break them silently: that the connection cannot write, that a schema outside
 * the pinned range is refused rather than guessed at, and that an unindexed
 * project produces a sentence instead of an exception.
 */

import { describe, test, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SCHEMA_MAX,
  checkFreshness,
  codegraphBinary,
  codegraphDbPath,
  formatFreshnessLine,
  hasCodegraphIndex,
  notIndexedMessage,
  openGraphDb,
  readProjectMetadata,
  schemaMax,
} from "../../src/graph/db.js";
import { defaultFixture, makeGraphFixture, writeProjectFile } from "./fixture.js";

const dirs: string[] = [];
function track<T extends { projectDir: string }>(f: T): T {
  dirs.push(f.projectDir);
  return f;
}

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("openGraphDb", () => {
  test("opens a complete index and reports its schema version", () => {
    const fx = track(defaultFixture());
    const res = openGraphDb(fx.projectDir);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.handle.schemaVersion).toBe(SCHEMA_MAX);
    expect(res.handle.indexState).toBe("complete");
    expect(res.handle.dbPath).toBe(codegraphDbPath(fx.projectDir));
    res.handle.close();
  });

  test("the connection is read-only — every write is refused", () => {
    const fx = track(defaultFixture());
    const res = openGraphDb(fx.projectDir);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    try {
      // Three shapes of write, because a driver could plausibly enforce one
      // and not the others: row insert, row delete, and schema change.
      expect(() =>
        res.handle.db.prepare("INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, updated_at) VALUES ('x','function','x','x','x.ts','ts',1,2,0,0,0)").run(),
      ).toThrow();
      expect(() => res.handle.db.prepare("DELETE FROM edges").run()).toThrow();
      expect(() => res.handle.db.exec("CREATE TABLE intruder (x TEXT)")).toThrow();
      // And the data is intact.
      const row = res.handle.db.prepare("SELECT COUNT(*) AS c FROM edges").get() as { c: number };
      expect(row.c).toBe(5);
    } finally {
      res.handle.close();
    }
  });

  test("close() is idempotent", () => {
    const fx = track(defaultFixture());
    const res = openGraphDb(fx.projectDir);
    if (!res.ok) throw new Error("fixture failed to open");
    res.handle.close();
    expect(() => res.handle.close()).not.toThrow();
  });

  test("a project without .codegraph is a message, not an exception", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-graph-empty-"));
    dirs.push(dir);
    expect(hasCodegraphIndex(dir)).toBe(false);
    const res = openGraphDb(dir);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("no-index");
    expect(res.message).toContain("codegraph init");
    expect(notIndexedMessage(dir)).toContain("codegraph init");
  });

  test("a schema version above the pinned range degrades instead of guessing", () => {
    const fx = track(makeGraphFixture({ schemaVersion: SCHEMA_MAX + 5 }));
    const res = openGraphDb(fx.projectDir);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("schema-drift");
    expect(res.schemaVersion).toBe(SCHEMA_MAX + 5);
    expect(res.message).toContain("CONTEXT_MODE_GRAPH_SCHEMA_MAX");
  });

  test("CONTEXT_MODE_GRAPH_SCHEMA_MAX raises the ceiling for an operator who checked", () => {
    const fx = track(makeGraphFixture({ schemaVersion: SCHEMA_MAX + 5 }));
    const env = { CONTEXT_MODE_GRAPH_SCHEMA_MAX: String(SCHEMA_MAX + 5) } as NodeJS.ProcessEnv;
    expect(schemaMax(env)).toBe(SCHEMA_MAX + 5);
    const res = openGraphDb(fx.projectDir, { env });
    expect(res.ok).toBe(true);
    if (res.ok) res.handle.close();
  });

  test("an index still building is reported as incomplete", () => {
    const fx = track(makeGraphFixture({ metadata: { index_state: "indexing" } }));
    const res = openGraphDb(fx.projectDir);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("incomplete");
    expect(res.message).toContain("indexing");
  });
});

describe("project metadata and freshness", () => {
  test("metadata reads back as a map", () => {
    const fx = track(makeGraphFixture({
      metadata: { index_state: "complete", indexed_with_version: "1.5.0" },
    }));
    const res = openGraphDb(fx.projectDir);
    if (!res.ok) throw new Error(res.message);
    try {
      const meta = readProjectMetadata(res.handle);
      expect(meta.index_state.value).toBe("complete");
      expect(meta.indexed_with_version.value).toBe("1.5.0");
      expect(meta.index_state.updatedAt).toBeGreaterThan(0);
    } finally {
      res.handle.close();
    }
  });

  test("a file modified after indexing is counted as lag", () => {
    const indexedAt = Date.now() - 60_000;
    const fx = track(makeGraphFixture({
      files: { "src/server.ts": indexedAt, "src/validate.ts": indexedAt },
    }));
    // One file exists and is newer than the index; the other never existed.
    const abs = writeProjectFile(fx.projectDir, "src/server.ts", "changed");
    const future = new Date(Date.now() + 10_000);
    utimesSync(abs, future, future);

    const res = openGraphDb(fx.projectDir);
    if (!res.ok) throw new Error(res.message);
    try {
      const report = checkFreshness(res.handle);
      expect(report).not.toBeNull();
      expect(report!.staleFiles).toBe(1);
      expect(report!.missingFiles).toBe(1);
      expect(report!.total).toBe(2);
      const line = formatFreshnessLine(report);
      expect(line).toContain("index lags 2 files");
    } finally {
      res.handle.close();
    }
  });

  test("a current index produces no freshness line", () => {
    const fx = track(makeGraphFixture({ files: { "src/a.ts": Date.now() + 60_000 } }));
    writeProjectFile(fx.projectDir, "src/a.ts");
    const res = openGraphDb(fx.projectDir);
    if (!res.ok) throw new Error(res.message);
    try {
      expect(formatFreshnessLine(checkFreshness(res.handle))).toBeNull();
    } finally {
      res.handle.close();
    }
  });

  test("CONTEXT_MODE_GRAPH_FRESHNESS=0 skips the stat sweep entirely", () => {
    const fx = track(makeGraphFixture({ files: { "src/gone.ts": Date.now() } }));
    const res = openGraphDb(fx.projectDir);
    if (!res.ok) throw new Error(res.message);
    try {
      const report = checkFreshness(res.handle, {
        env: { CONTEXT_MODE_GRAPH_FRESHNESS: "0" } as NodeJS.ProcessEnv,
      });
      expect(report).toBeNull();
    } finally {
      res.handle.close();
    }
  });
});

describe("codegraphBinary", () => {
  test("an explicit CONTEXT_MODE_CODEGRAPH_BIN wins when it exists", () => {
    const fx = track(defaultFixture());
    const bin = codegraphBinary({ CONTEXT_MODE_CODEGRAPH_BIN: fx.dbPath } as NodeJS.ProcessEnv);
    expect(bin).toBe(fx.dbPath);
  });

  test("falls back to PATH when nothing is installed under HOME", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-graph-home-"));
    dirs.push(dir);
    expect(codegraphBinary({ HOME: dir } as NodeJS.ProcessEnv)).toBe("codegraph");
  });
});
