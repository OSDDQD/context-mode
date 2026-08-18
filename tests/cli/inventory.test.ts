/**
 * `context-mode inventory` — the read-only answer to "what is recorded about
 * this project?".
 *
 * The command itself is a thin shell around three store calls; everything that
 * can be got wrong — how a source label becomes a type, which sources count as
 * largest, what an empty store prints — lives in the exported pure functions
 * and is asserted here without a database. One integration test then indexes a
 * real store, so the pure layer cannot drift from what `listSources()` and
 * `getIndexState()` actually return.
 */

import { describe, test, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  buildInventory,
  inventoryType,
  renderInventory,
  type Inventory,
} from "../../src/cli.js";
import { ContentStore } from "../../src/store.js";

const ROOT = resolve(import.meta.dirname, "../..");

function inventoryOf(
  sources: Array<{ label: string; chunkCount: number }>,
  overrides: Partial<Parameters<typeof buildInventory>[0]> = {},
): Inventory {
  return buildInventory({
    project: "/proj",
    dbPath: "/db/content.db",
    dbBytes: 1024,
    walBytes: 0,
    sources,
    indexState: {
      totalSources: sources.length,
      totalChunks: sources.reduce((n, s) => n + s.chunkCount, 0),
      lastIndexedAt: "2026-08-18 05:12:33",
    },
    top: 10,
    ...overrides,
  });
}

describe("inventoryType", () => {
  test("takes the kind prefix off a labelled source", () => {
    expect(inventoryType("code:src/store.ts")).toBe("code");
    expect(inventoryType("batch:git log,npm test")).toBe("batch");
    expect(inventoryType("execute:shell")).toBe("execute");
    expect(inventoryType("smoke-spa:page")).toBe("smoke-spa");
  });

  test("a Windows path is one source of kind other, not a drive-letter type", () => {
    // The whole point of requiring a lowercase prefix: `C:\src\app.ts` indexed
    // under its own name must not invent a type called "C".
    expect(inventoryType("C:\\src\\app.ts")).toBe("other");
    expect(inventoryType("D:/work/notes.md")).toBe("other");
  });

  test("free-form labels group together instead of each becoming a type", () => {
    expect(inventoryType("my notes")).toBe("other");
    expect(inventoryType("Deploy:runbook")).toBe("other");
    expect(inventoryType(":leading")).toBe("other");
    expect(inventoryType("")).toBe("other");
  });
});

describe("buildInventory", () => {
  const sources = [
    { label: "code:src/store.ts", chunkCount: 40 },
    { label: "code:src/cli.ts", chunkCount: 12 },
    { label: "batch:git log", chunkCount: 30 },
    { label: "loose note", chunkCount: 1 },
  ];

  test("groups sources by type, heaviest first", () => {
    expect(inventoryOf(sources).byType).toEqual([
      { type: "code", sources: 2, chunks: 52 },
      { type: "batch", sources: 1, chunks: 30 },
      { type: "other", sources: 1, chunks: 1 },
    ]);
  });

  test("ties between types are broken by name, so the order is stable", () => {
    const tied = inventoryOf([
      { label: "zeta:a", chunkCount: 5 },
      { label: "alpha:b", chunkCount: 5 },
    ]);
    expect(tied.byType.map((g) => g.type)).toEqual(["alpha", "zeta"]);
  });

  test("largest lists sources by chunk count and honours --top", () => {
    const inv = inventoryOf(sources, { top: 2 });
    expect(inv.largest).toEqual([
      { label: "code:src/store.ts", chunks: 40 },
      { label: "batch:git log", chunks: 30 },
    ]);
  });

  test("equal-sized sources are ordered by label rather than by insertion", () => {
    const inv = inventoryOf([
      { label: "code:b.ts", chunkCount: 7 },
      { label: "code:a.ts", chunkCount: 7 },
    ]);
    expect(inv.largest.map((s) => s.label)).toEqual(["code:a.ts", "code:b.ts"]);
  });

  test("totals come from the store's own accounting, not from re-summing", () => {
    // getIndexState() is the store's answer. If it ever disagrees with the sum
    // over listSources(), the report shows the store's number — the disagreement
    // is a fact about the store, not something the CLI should paper over.
    const inv = inventoryOf(sources, {
      indexState: { totalSources: 99, totalChunks: 1234, lastIndexedAt: "2026-01-01 00:00:00" },
    });
    expect(inv.sources).toBe(99);
    expect(inv.chunks).toBe(1234);
    expect(inv.lastIndexedAt).toBe("2026-01-01 00:00:00");
  });

  test("an empty store yields empty groups and no last-indexed timestamp", () => {
    const inv = inventoryOf([], { indexState: { totalSources: 0, totalChunks: 0 } });
    expect(inv.byType).toEqual([]);
    expect(inv.largest).toEqual([]);
    expect(inv.lastIndexedAt).toBeUndefined();
  });
});

describe("renderInventory", () => {
  test("reports project, db, size and both totals", () => {
    const out = renderInventory(inventoryOf([{ label: "code:a.ts", chunkCount: 3 }]));
    expect(out).toContain("project: /proj");
    expect(out).toContain("db: /db/content.db");
    expect(out).toContain("last indexed: 2026-08-18 05:12:33");
    expect(out).toContain("sources: 1, chunks: 3");
    expect(out).toContain("code");
  });

  test("the WAL is shown beside the db size only when it holds something", () => {
    const withWal = renderInventory(inventoryOf([{ label: "code:a.ts", chunkCount: 1 }], {
      dbBytes: 45_400_000,
      walBytes: 20_300_000,
    }));
    expect(withWal).toMatch(/size: .* \(\+ .* WAL\)/);
    expect(renderInventory(inventoryOf([{ label: "code:a.ts", chunkCount: 1 }]))).not.toContain("WAL");
  });

  test("an empty store says so instead of printing empty tables", () => {
    const out = renderInventory(inventoryOf([], { indexState: { totalSources: 0, totalChunks: 0 } }));
    expect(out).toContain("last indexed: never");
    expect(out).toContain("Nothing is indexed for this project yet.");
    expect(out).not.toContain("by type:");
  });
});

describe("inventory over a real ContentStore", () => {
  let store: ContentStore | undefined;

  afterEach(() => {
    store?.cleanup();
    store = undefined;
  });

  test("reads listSources, getIndexState and getDBSizeBytes as they really are", () => {
    const path = join(tmpdir(), `ctx-inventory-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new ContentStore(path);
    store.index({ content: "# Store\n\nchunk one\n\n## Two\n\nchunk two", source: "code:src/store.ts" });
    store.index({ content: "# Cli\n\nchunk one", source: "code:src/cli.ts" });
    store.index({ content: "# Git log\n\nrecent commits", source: "batch:git log" });

    const inv = buildInventory({
      project: "/proj",
      dbPath: path,
      dbBytes: store.getDBSizeBytes(),
      walBytes: 0,
      sources: store.listSources(),
      indexState: store.getIndexState(),
      top: 10,
    });

    expect(inv.sources).toBe(3);
    expect(inv.chunks).toBeGreaterThan(0);
    expect(inv.lastIndexedAt).toBeTruthy();
    expect(inv.db.bytes).toBeGreaterThan(0);
    expect(inv.byType.map((g) => g.type).sort()).toEqual(["batch", "code"]);
    expect(inv.byType.find((g) => g.type === "code")?.sources).toBe(2);
    // The grouped chunk counts must add up to what the store reports overall.
    expect(inv.byType.reduce((n, g) => n + g.chunks, 0)).toBe(inv.chunks);
    expect(inv.largest.map((s) => s.label)).toContain("batch:git log");
  });
});

describe("inventory is wired into the CLI", () => {
  const cliSource = readFileSync(join(ROOT, "src/cli.ts"), "utf-8");

  test("the dispatch chain routes `inventory` to its own command", () => {
    expect(cliSource).toContain('args[0] === "inventory"');
    expect(cliSource).toMatch(/inventoryCommand\(args\.slice\(1\)\)/);
  });

  test("help mentions the command and its options", () => {
    expect(cliSource).toContain("context-mode inventory");
    expect(cliSource).toContain("Inventory options:");
  });

  test("the command never writes: no index, delete or compact call in it", () => {
    const body = cliSource.slice(
      cliSource.indexOf("async function inventoryCommand"),
      cliSource.indexOf("function logStorageDir"),
    );
    expect(body.length).toBeGreaterThan(0);
    for (const forbidden of ["store.index", "deleteSource", "compact(", "cleanupStaleSources", "enforceContentBudget"]) {
      expect(body, `inventory must stay read-only, found ${forbidden}`).not.toContain(forbidden);
    }
  });
});
