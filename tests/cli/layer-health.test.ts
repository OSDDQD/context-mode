/**
 * `ctx_doctor`'s view of the four layers the fork attached.
 *
 * The contract under test is not "the report is pretty" — it is that every
 * probe answers for a dependency that is NOT installed without throwing, and
 * that the answer says which state it found. A doctor that crashes on a
 * machine without codegraph is worse than no doctor, and a doctor that prints
 * a green line for a layer that never loaded is worse still.
 *
 * The rendering is asserted through `renderLayerHealth` on fabricated reports,
 * so the wording is pinned without needing any of the layers present; the
 * collectors are then run for real against temp directories that deliberately
 * have nothing installed in them.
 */

import { describe, test, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  binaryResolves,
  collectLayerHealth,
  compressionLayerHealth,
  fffLayerHealth,
  fsBusLayerHealth,
  graphLayerHealth,
  layerDiagnosticsEnabled,
  renderLayerHealth,
  shortBytes,
  tokenizerLayerHealth,
  type LayerHealth,
} from "../../src/util/layer-health.js";
import { defaultFixture, makeGraphFixture } from "../graph/fixture.js";

const savedEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A report in which every layer is absent — the "fresh machine" baseline. */
function absentHealth(): LayerHealth {
  return {
    projectDir: "/proj",
    fff: {
      enabled: true,
      available: false,
      storageDir: "/store/fff",
      activeRoots: [],
      watch: true,
      mmap: true,
      error: "module not found",
    },
    graph: {
      binary: "codegraph",
      binaryFound: false,
      hasIndex: false,
      dbPath: "/proj/.codegraph/codegraph.db",
      schemaMin: 1,
      schemaMax: 8,
      daemon: { running: false, stale: false, socketPresent: false },
      queued: 0,
    },
    fsBus: {
      enabled: true,
      active: false,
      unavailable: false,
      reason: "no wiring installed",
      consumers: { index: true, graph: true, cache: true },
      roots: [],
      batches: 0,
      events: 0,
      reindexed: 0,
      evicted: 0,
      enqueued: 0,
      cacheInvalidations: 0,
      overflowed: 0,
    },
    tokenizer: { mode: "heuristic", encoding: "o200k_base" },
    compression: { enabled: true },
  };
}

/** The same report with every layer up and busy. */
function presentHealth(): LayerHealth {
  const h = absentHealth();
  h.fff = {
    enabled: true,
    available: true,
    packageVersion: "0.10.5",
    nativeVersion: "0.10.5",
    storageDir: "/store/fff",
    frecencyDbPath: "/store/fff/abc-frecency.mdb",
    frecencyBytes: 2 * 1024 * 1024,
    historyDbPath: "/store/fff/abc-history.mdb",
    historyBytes: 4096,
    indexedFiles: 4123,
    gitRepositoryFound: true,
    activeRoots: ["/proj"],
    watch: true,
    mmap: true,
  };
  h.graph = {
    binary: "/home/u/.codegraph/versions/v1.5.0/bin/codegraph",
    binaryFound: true,
    hasIndex: true,
    dbPath: "/proj/.codegraph/codegraph.db",
    dbBytes: 12 * 1024 * 1024,
    schemaVersion: 8,
    schemaMin: 1,
    schemaMax: 8,
    schemaSupported: true,
    indexState: "complete",
    nodes: 9000,
    edges: 21000,
    files: 400,
    daemon: { running: true, stale: false, socketPresent: true, pid: 4242, version: "1.5.0" },
    queued: 3,
  };
  h.fsBus = {
    enabled: true,
    active: true,
    unavailable: false,
    consumers: { index: true, graph: true, cache: false },
    roots: ["/proj"],
    batches: 12,
    events: 48,
    reindexed: 30,
    evicted: 1,
    enqueued: 30,
    cacheInvalidations: 4,
    overflowed: 0,
  };
  h.tokenizer = { mode: "exact", encoding: "o200k_base" };
  return h;
}

describe("renderLayerHealth — nothing installed", () => {
  const lines = renderLayerHealth(absentHealth()).join("\n");

  test("a missing fff library reads as not loaded, not as a failure", () => {
    expect(lines).toMatch(/fff:\s+not loaded/);
    expect(lines).toMatch(/package not installed/);
    expect(lines).not.toMatch(/FAIL/);
  });

  test("a project without .codegraph says so and names the path it looked at", () => {
    expect(lines).toMatch(/codegraph:\s+no index for this project/);
    expect(lines).toContain("/proj/.codegraph/codegraph.db");
    expect(lines).toMatch(/binary not found \(nothing to index with\)/);
  });

  test("databases that were never created read as none yet, not as an error", () => {
    const h = absentHealth();
    h.fff.available = true;
    h.fff.error = undefined;
    expect(renderLayerHealth(h).join("\n")).toMatch(/frecency none yet, history none yet/);
  });

  test("an unwired bus prints its reason and which consumers are enabled", () => {
    expect(lines).toMatch(/fs bus:\s+inactive \(no wiring installed\)/);
    expect(lines).toMatch(/consumers index\+graph\+cache/);
  });

  test("the counters always report a mode and a compression state", () => {
    expect(lines).toMatch(/tokenizer:\s+heuristic \(o200k_base\)/);
    expect(lines).toMatch(/compression:\s+on/);
  });

  test("compression off names the switch that turns it on", () => {
    const h = absentHealth();
    h.compression.enabled = false;
    expect(renderLayerHealth(h).join("\n"))
      .toMatch(/compression:\s+off \(CONTEXT_MODE_EXEC_COMPRESS=1 enables\)/);
  });
});

describe("renderLayerHealth — everything installed", () => {
  const lines = renderLayerHealth(presentHealth()).join("\n");

  test("fff reports both versions, the switches and the live roots", () => {
    expect(lines).toMatch(/fff:\s+available \(native 0\.10\.5, package 0\.10\.5\)/);
    expect(lines).toMatch(/watcher on, mmap on, 1 live root\(s\)/);
    expect(lines).toMatch(/4123 indexed file\(s\)/);
  });

  test("fff store names the directory and the size of both databases", () => {
    expect(lines).toMatch(/fff store:\s+\/store\/fff — frecency 2\.0 MB, history 4 KB/);
  });

  test("codegraph reports size, schema window, counts and daemon", () => {
    expect(lines).toMatch(/codegraph:\s+index 12\.0 MB, schema v8 \(supported 1-8\)/);
    expect(lines).toMatch(/400 files \/ 9000 nodes \/ 21000 edges/);
    expect(lines).toMatch(/cg daemon:\s+running \(pid 4242, v1\.5\.0\), socket present, 3 path\(s\) queued/);
    expect(lines).toMatch(/cg freshness:\s+index is current/);
  });

  test("the bus prints its counters", () => {
    expect(lines).toMatch(/fs bus:\s+active — consumers index\+graph/);
    expect(lines).toMatch(/12 batch\(es\) \/ 48 event\(s\) \/ 30 reindexed \/ 30 enqueued/);
  });
});

describe("renderLayerHealth — degraded states each get their own wording", () => {
  test("fff switched off names the env var rather than blaming the library", () => {
    const h = absentHealth();
    h.fff.enabled = false;
    h.fff.error = undefined;
    expect(renderLayerHealth(h).join("\n")).toMatch(/fff:\s+off \(CONTEXT_MODE_FFF\)/);
  });

  test("a schema outside the pinned window is called out", () => {
    const h = presentHealth();
    h.graph.schemaVersion = 11;
    h.graph.schemaSupported = false;
    expect(renderLayerHealth(h).join("\n")).toMatch(/schema v11 \(OUT OF RANGE 1-8\)/);
  });

  test("a dead daemon holding a pid file is not reported as running", () => {
    const h = presentHealth();
    h.graph.daemon = { running: false, stale: true, socketPresent: false, pid: 99 };
    const lines = renderLayerHealth(h).join("\n");
    expect(lines).toMatch(/cg daemon:\s+stale pid file \(pid 99 is gone\)/);
    expect(lines).not.toMatch(/daemon: running/);
  });

  test("index lag is surfaced verbatim from formatFreshnessLine", () => {
    const h = presentHealth();
    h.graph.freshness = "⚠ index lags 3 files — these results may describe the previous version";
    expect(renderLayerHealth(h).join("\n")).toContain("index lags 3 files");
  });

  test("a bus switched off names the env var, not a missing wiring", () => {
    const h = absentHealth();
    h.fsBus.enabled = false;
    expect(renderLayerHealth(h).join("\n")).toMatch(/inactive \(CONTEXT_MODE_FS_BUS off\)/);
  });

  test("modules missing entirely render as not installed", () => {
    const h = absentHealth();
    h.graph.error = "Cannot find module '../graph/db.js'";
    h.fsBus.error = "Cannot find module '../fs-bus/index.js'";
    const lines = renderLayerHealth(h).join("\n");
    expect(lines).toMatch(/codegraph:\s+not installed/);
    expect(lines).toMatch(/fs bus:\s+not installed/);
  });
});

describe("collectors run against a machine with nothing installed", () => {
  test("fff degrades to disabled when the env switch is off", async () => {
    process.env.CONTEXT_MODE_FFF = "0";
    const health = await fffLayerHealth(tempDir("cm-fff-"));
    expect(health.available).toBe(false);
    expect(health.enabled).toBe(false);
    // The switch must not be mistaken for a broken install.
    expect(renderLayerHealth({ ...absentHealth(), fff: health }).join("\n")).toMatch(/fff:\s+off/);
  });

  test("codegraph answers no-index for a directory that was never indexed", async () => {
    const dir = tempDir("cm-graph-");
    const health = await graphLayerHealth(dir);
    expect(health.hasIndex).toBe(false);
    expect(health.openReason).toBe("no-index");
    expect(health.dbPath).toContain(".codegraph");
    expect(health.schemaMax).toBeGreaterThanOrEqual(health.schemaMin);
  });

  test("codegraph reads schema, counts and daemon state off a real index", async () => {
    const fixture = defaultFixture();
    const health = await graphLayerHealth(fixture.projectDir);
    expect(health.hasIndex).toBe(true);
    expect(health.schemaVersion).toBe(8);
    expect(health.schemaSupported).toBe(true);
    expect(health.indexState).toBe("complete");
    expect(health.dbBytes).toBeGreaterThan(0);
    expect(health.nodes).toBeGreaterThan(0);
    // No daemon was started for a fixture directory.
    expect(health.daemon.running).toBe(false);
    expect(health.daemon.stale).toBe(false);
  });

  test("a stale daemon pid file is reported as stale, not running", async () => {
    const fixture = makeGraphFixture();
    // pid 1 is never ours; a pid that cannot exist proves the liveness probe
    // is consulted rather than the file's presence alone.
    writeFileSync(
      join(fixture.projectDir, ".codegraph", "daemon.pid"),
      JSON.stringify({ pid: 2147483646, version: "1.5.0" }),
      "utf-8",
    );
    const health = await graphLayerHealth(fixture.projectDir);
    expect(health.daemon.running).toBe(false);
    expect(health.daemon.stale).toBe(true);
    expect(health.daemon.pid).toBe(2147483646);
  });

  test("the bus reports no wiring for a project nothing subscribed to", async () => {
    const health = await fsBusLayerHealth(tempDir("cm-bus-"));
    expect(health.active).toBe(false);
    expect(health.reason).toBeDefined();
    expect(health.error).toBeUndefined();
  });

  test("tokenizer and compression always answer", async () => {
    const tok = await tokenizerLayerHealth();
    expect(["bytes4", "heuristic", "exact"]).toContain(tok.mode);
    expect(tok.encoding.length).toBeGreaterThan(0);
    const compression = await compressionLayerHealth();
    expect(typeof compression.enabled).toBe("boolean");
  });

  test("collectLayerHealth never throws and renders a line per layer", async () => {
    const dir = tempDir("cm-layers-");
    const health = await collectLayerHealth({ projectDir: dir });
    const lines = renderLayerHealth(health);
    expect(lines.some((l) => l.startsWith("fff:"))).toBe(true);
    expect(lines.some((l) => l.startsWith("codegraph:"))).toBe(true);
    expect(lines.some((l) => l.startsWith("fs bus:"))).toBe(true);
    expect(lines.some((l) => l.startsWith("tokenizer:"))).toBe(true);
    expect(lines.some((l) => l.startsWith("compression:"))).toBe(true);
  });
});

describe("helpers", () => {
  test("the layer section is on by default and off by env", () => {
    expect(layerDiagnosticsEnabled({})).toBe(true);
    expect(layerDiagnosticsEnabled({ CONTEXT_MODE_DOCTOR_LAYERS: "0" })).toBe(false);
    expect(layerDiagnosticsEnabled({ CONTEXT_MODE_DOCTOR_LAYERS: "off" })).toBe(false);
    expect(layerDiagnosticsEnabled({ CONTEXT_MODE_DOCTOR_LAYERS: "1" })).toBe(true);
  });

  test("binaryResolves stats an explicit path and walks PATH for a bare name", () => {
    const dir = tempDir("cm-bin-");
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    const bin = join(binDir, process.platform === "win32" ? "codegraph.EXE" : "codegraph");
    writeFileSync(bin, "#!/bin/sh\n", "utf-8");

    expect(binaryResolves(bin, {})).toBe(true);
    expect(binaryResolves(join(binDir, "absent"), {})).toBe(false);
    expect(binaryResolves("codegraph", { PATH: binDir, PATHEXT: ".EXE" })).toBe(true);
    expect(binaryResolves("codegraph", { PATH: dir, PATHEXT: ".EXE" })).toBe(false);
  });

  test("shortBytes degrades to n/a rather than printing NaN", () => {
    expect(shortBytes(undefined)).toBe("n/a");
    expect(shortBytes(0)).toBe("0 B");
    expect(shortBytes(2048)).toBe("2 KB");
    expect(shortBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
