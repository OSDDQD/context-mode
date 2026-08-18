/**
 * Smoke test against a real codegraph index.
 *
 * The synthetic fixture proves the SQL is right; this proves the SQL is right
 * about codegraph's actual output — a 50k-node, 135k-edge index written by
 * codegraph 1.5.0, opened read-only while its daemon is live. It is skipped
 * whenever that index is not on the machine, so it never fails CI.
 *
 * Strictly read-only: the assertions are shape and sanity checks, never exact
 * counts, because the index moves whenever the developer edits that project.
 */

import { describe, test, expect } from "vitest";
import { existsSync } from "node:fs";

import { checkFreshness, openGraphDb, readProjectMetadata } from "../../src/graph/db.js";
import {
  callers,
  graphStats,
  outline,
  related,
  resolveSymbol,
  symbols,
} from "../../src/graph/queries.js";

const REAL_PROJECT = "/home/osddqd/projects/casino";
const available = existsSync(`${REAL_PROJECT}/.codegraph/codegraph.db`);

describe.runIf(available)("real codegraph index", () => {
  test("opens read-only alongside a running daemon", () => {
    const res = openGraphDb(REAL_PROJECT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    try {
      expect(res.handle.schemaVersion).toBeGreaterThanOrEqual(1);
      expect(res.handle.indexState).toBe("complete");
      // WAL is what makes a concurrent reader safe; assert we are not the writer.
      expect(() => res.handle.db.prepare("DELETE FROM edges WHERE 0").run()).toThrow();

      const stats = graphStats(res.handle);
      expect(stats.nodes).toBeGreaterThan(1_000);
      expect(stats.edges).toBeGreaterThan(1_000);

      const meta = readProjectMetadata(res.handle);
      expect(meta.index_state?.value).toBe("complete");
    } finally {
      res.handle.close();
    }
  });

  test("symbol search, outline and a caller walk all return coherent rows", () => {
    const res = openGraphDb(REAL_PROJECT);
    if (!res.ok) return;
    try {
      const h = res.handle;

      // Pick a real function from the index rather than hardcoding a name that
      // may not exist in whatever state that repo is in today.
      const seed = h.db
        .prepare(
          "SELECT qualified_name, file_path FROM nodes WHERE kind IN ('function','method') " +
          "AND file_path LIKE '%.ts' ORDER BY rowid LIMIT 1",
        )
        .get() as { qualified_name?: string; file_path?: string } | undefined;
      if (!seed?.qualified_name) return;

      const resolved = resolveSymbol(h, seed.qualified_name);
      expect(resolved.ids.length).toBeGreaterThan(0);
      expect(resolved.via).toBe("qualified");

      // A walk on a 135k-edge graph must stay bounded and typed.
      const up = callers(h, { roots: resolved.ids, depth: 2, limit: 25 });
      expect(up.length).toBeLessThanOrEqual(25);
      for (const row of up) {
        expect(row.depth).toBeGreaterThan(0);
        expect(row.depth).toBeLessThanOrEqual(2);
        expect(typeof row.qualifiedName).toBe("string");
      }

      const rows = outline(h, { filePath: seed.file_path! });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(r => r.filePath === seed.file_path)).toBe(true);
      // Source order is the contract for an outline.
      const lines = rows.map(r => r.startLine);
      expect([...lines].sort((a, b) => a - b)).toEqual(lines);

      const found = symbols(h, { query: rows[0].name, limit: 5 });
      expect(found.length).toBeGreaterThan(0);
    } finally {
      res.handle.close();
    }
  });

  test("related returns a scored, machine-readable neighbourhood", () => {
    const res = openGraphDb(REAL_PROJECT);
    if (!res.ok) return;
    try {
      const h = res.handle;
      const seed = h.db
        .prepare(
          "SELECT file_path, COUNT(*) AS c FROM nodes WHERE file_path LIKE '%.ts' " +
          "GROUP BY file_path ORDER BY c DESC LIMIT 1",
        )
        .get() as { file_path?: string } | undefined;
      if (!seed?.file_path) return;

      const result = related(h, { filePath: seed.file_path, depth: 1, limit: 20 });
      expect(result.seedFile).toBe(seed.file_path);
      expect(result.seedNodes).toBeGreaterThan(0);
      expect(result.nodes.length).toBeLessThanOrEqual(20);
      for (const n of result.nodes) {
        expect(n.weight).toBeGreaterThan(0);
        expect(n.distance).toBe(1);
        expect(n.via.length).toBeGreaterThan(0);
        expect(["in", "out", "both"]).toContain(n.direction);
      }
      const weights = result.nodes.map(n => n.weight);
      expect([...weights].sort((a, b) => b - a)).toEqual(weights);
    } finally {
      res.handle.close();
    }
  });

  test("freshness reports a number rather than throwing on a live tree", () => {
    const res = openGraphDb(REAL_PROJECT);
    if (!res.ok) return;
    try {
      const report = checkFreshness(res.handle, { maxFiles: 300 });
      expect(report).not.toBeNull();
      expect(report!.checked).toBeGreaterThan(0);
      expect(report!.staleFiles).toBeGreaterThanOrEqual(0);
    } finally {
      res.handle.close();
    }
  });
});
