/**
 * `context-mode inventory` — the layer view.
 *
 * `by type` answers "what kind of thing is indexed". It cannot answer "which
 * layer put it there", because two very different producers write the same
 * `code:` prefix, and a store that is 90% `codegraph:explore:` dumps looks
 * exactly like one that is 90% hand-indexed files. The channel fold and the
 * external-index block are what make the two layers this fork attached
 * visible, and both are pure functions, so they are asserted without a store.
 */

import { describe, test, expect } from "vitest";

import {
  buildInventory,
  inventoryChannel,
  inventoryLayersFrom,
  renderInventory,
  renderInventoryLayers,
  type Inventory,
  type InventoryLayers,
} from "../../src/cli.js";
import type { LayerHealth } from "../../src/util/layer-health.js";

function inventoryOf(
  sources: Array<{ label: string; chunkCount: number }>,
  layers?: InventoryLayers,
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
    layers,
  });
}

describe("inventoryChannel", () => {
  test("routes the two attached layers to their own channels", () => {
    expect(inventoryChannel("codegraph")).toBe("codegraph");
    expect(inventoryChannel("graph")).toBe("codegraph");
    expect(inventoryChannel("fff")).toBe("fff");
    expect(inventoryChannel("find")).toBe("fff");
  });

  test("keeps the file index separate from ad-hoc captures", () => {
    expect(inventoryChannel("code")).toBe("code-index");
    expect(inventoryChannel("batch")).toBe("capture");
    expect(inventoryChannel("execute")).toBe("capture");
    expect(inventoryChannel("fetch")).toBe("web");
    expect(inventoryChannel("compaction")).toBe("memory");
  });

  test("an unknown prefix never lands in fff or codegraph", () => {
    // The classification may under-claim for the two tracked layers; it may
    // never over-claim, or the block stops being evidence of anything.
    expect(inventoryChannel("smoke-spa")).toBe("capture");
    expect(inventoryChannel("other")).toBe("capture");
  });
});

describe("buildInventory — byChannel", () => {
  test("folds sources by producer and keeps the by-type view intact", () => {
    const inv = inventoryOf([
      { label: "codegraph:explore:store", chunkCount: 40 },
      { label: "codegraph:explore:search", chunkCount: 20 },
      { label: "code:src/store.ts", chunkCount: 12 },
      { label: "batch:git log", chunkCount: 3 },
    ]);

    const byChannel = Object.fromEntries(inv.byChannel.map((c) => [c.channel, c]));
    expect(byChannel.codegraph).toEqual({ channel: "codegraph", sources: 2, chunks: 60 });
    expect(byChannel["code-index"]).toEqual({ channel: "code-index", sources: 1, chunks: 12 });
    expect(byChannel.capture).toEqual({ channel: "capture", sources: 1, chunks: 3 });
    expect(inv.byType.map((t) => t.type)).toContain("codegraph");
  });

  test("fff and codegraph are always listed, at zero when they fed nothing", () => {
    const inv = inventoryOf([{ label: "batch:git log", chunkCount: 3 }]);
    const byChannel = Object.fromEntries(inv.byChannel.map((c) => [c.channel, c]));
    expect(byChannel.fff).toEqual({ channel: "fff", sources: 0, chunks: 0 });
    expect(byChannel.codegraph).toEqual({ channel: "codegraph", sources: 0, chunks: 0 });
  });

  test("channels are ordered by chunk count, ties broken by name", () => {
    const inv = inventoryOf([
      { label: "code:a.ts", chunkCount: 5 },
      { label: "codegraph:explore:x", chunkCount: 50 },
    ]);
    expect(inv.byChannel[0].channel).toBe("codegraph");
  });
});

describe("rendering", () => {
  const layers: InventoryLayers = {
    fff: { storageDir: "/store/fff", frecencyBytes: 2 * 1024 * 1024, historyBytes: 4096, indexedFiles: 4123 },
    codegraph: { dbPath: "/proj/.codegraph/codegraph.db", bytes: 12 * 1024 * 1024, files: 400, nodes: 9000, edges: 21000 },
  };

  test("the report carries a by-channel block", () => {
    const text = renderInventory(inventoryOf([{ label: "codegraph:explore:x", chunkCount: 9 }]));
    expect(text).toContain("by channel:");
    expect(text).toMatch(/codegraph\s+1 sources\s+9 chunks/);
    expect(text).toMatch(/fff\s+0 sources\s+0 chunks/);
  });

  test("external indexes are reported beside the knowledge base", () => {
    const text = renderInventory(inventoryOf([{ label: "code:a.ts", chunkCount: 1 }], layers));
    expect(text).toContain("external indexes:");
    expect(text).toContain("2.0 MB frecency + 4 KB history");
    expect(text).toContain("4123 file(s) scanned");
    expect(text).toContain("12.0 MB, 400 files / 9000 nodes / 21000 edges");
    expect(text).toContain("/proj/.codegraph/codegraph.db");
  });

  test("an empty store still reports what the layers hold", () => {
    const text = renderInventory(inventoryOf([], layers));
    expect(text).toContain("Nothing is indexed for this project yet.");
    expect(text).toContain("external indexes:");
  });

  test("no layer block at all when neither layer is installed", () => {
    expect(renderInventoryLayers(undefined)).toEqual([]);
    expect(renderInventoryLayers({})).toEqual([]);
    expect(renderInventory(inventoryOf([{ label: "code:a.ts", chunkCount: 1 }])))
      .not.toContain("external indexes:");
  });
});

describe("inventoryLayersFrom", () => {
  const base: LayerHealth = {
    projectDir: "/proj",
    fff: {
      enabled: true, available: false, storageDir: "/store/fff",
      activeRoots: [], watch: true, mmap: true,
    },
    graph: {
      binary: "codegraph", binaryFound: false, hasIndex: false,
      dbPath: "/proj/.codegraph/codegraph.db", schemaMin: 1, schemaMax: 8,
      daemon: { running: false, stale: false, socketPresent: false }, queued: 0,
    },
    fsBus: {
      enabled: true, active: false, unavailable: false,
      consumers: { index: true, graph: true, cache: true }, roots: [],
      batches: 0, events: 0, reindexed: 0, evicted: 0, enqueued: 0,
      cacheInvalidations: 0, overflowed: 0,
    },
    tokenizer: { mode: "heuristic", encoding: "o200k_base" },
    compression: { enabled: false },
  };

  test("omits a layer that is not installed", () => {
    expect(inventoryLayersFrom(base)).toEqual({});
  });

  test("reports fff once the library is loaded and codegraph once indexed", () => {
    const health: LayerHealth = {
      ...base,
      fff: { ...base.fff, available: true, frecencyBytes: 10, historyBytes: 20, indexedFiles: 7 },
      graph: { ...base.graph, hasIndex: true, dbBytes: 99, nodes: 5, edges: 6, files: 2 },
    };
    const layers = inventoryLayersFrom(health);
    expect(layers.fff).toEqual({
      storageDir: "/store/fff", frecencyBytes: 10, historyBytes: 20, indexedFiles: 7,
    });
    expect(layers.codegraph).toEqual({
      dbPath: "/proj/.codegraph/codegraph.db", bytes: 99, files: 2, nodes: 5, edges: 6,
    });
  });
});
