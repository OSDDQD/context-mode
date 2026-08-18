/**
 * Health of the layers the fork attached under the plugin: the in-process fff
 * search engine, the codegraph index, the filesystem event bus, the token
 * counter and the output-compression pass.
 *
 * `ctx_doctor` used to answer only for the pieces the upstream plugin shipped
 * with (runtimes, FTS5, hooks, versions). Four layers later the interesting
 * failure modes all live outside that list: a missing native library, a
 * `.codegraph` index two schema versions ahead, a daemon that died holding a
 * pid file, a bus that is wired but has no consumers enabled. None of those
 * raise an error anywhere — they degrade, silently, into "search feels worse
 * than it used to". This module is the place that says so out loud.
 *
 * Two rules hold for every collector here:
 *
 *   1. **Never throw.** A layer that is not installed is a *state*
 *      (`installed: false`), not a failure. Every probe is wrapped, every
 *      import is dynamic, and a collector that blows up still returns a
 *      report carrying its own error string.
 *   2. **Never mutate.** No index is created, no daemon is spawned, no
 *      database is written. `fffHealthReport` only enriches from a finder
 *      that already exists; `openGraphDb` is read-only; `daemonStatus` reads
 *      files and never connects.
 *
 * The whole section is behind `CONTEXT_MODE_DOCTOR_LAYERS=0` for anyone who
 * wants the shorter report back.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";

/** Turn the whole layer section off: `CONTEXT_MODE_DOCTOR_LAYERS=0`. */
export const DOCTOR_LAYERS_ENV = "CONTEXT_MODE_DOCTOR_LAYERS" as const;

type Env = NodeJS.ProcessEnv;

/** Fork convention: `0` / `off` / `false` / `no` / `disabled` switches off. */
function isOff(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "0" || v === "off" || v === "false" || v === "no" || v === "disabled";
}

/** Is the layer section printed at all? On by default. */
export function layerDiagnosticsEnabled(env: Env = process.env): boolean {
  return !isOff(env[DOCTOR_LAYERS_ENV]);
}

// ─────────────────────────────────────────────────────────
// Report shapes
// ─────────────────────────────────────────────────────────

export interface FffLayerHealth {
  /** `CONTEXT_MODE_FFF` is not switched off. */
  enabled: boolean;
  /** The native library actually loaded in this process. */
  available: boolean;
  /** Version of the installed `@ff-labs/fff-node` package, when resolvable. */
  packageVersion?: string;
  /** Version the loaded library reports about itself. */
  nativeVersion?: string;
  /** Directory holding the per-project frecency/history LMDB environments. */
  storageDir: string;
  frecencyDbPath?: string;
  frecencyBytes?: number;
  historyDbPath?: string;
  historyBytes?: number;
  indexedFiles?: number;
  gitRepositoryFound?: boolean;
  /** Project roots with a live finder in this process. */
  activeRoots: string[];
  /** `CONTEXT_MODE_FFF_WATCH` is not switched off. */
  watch: boolean;
  /** `CONTEXT_MODE_FFF_MMAP` is not switched off. */
  mmap: boolean;
  error?: string;
}

export interface GraphDaemonHealth {
  running: boolean;
  stale: boolean;
  socketPresent: boolean;
  pid?: number;
  version?: string;
}

export interface GraphLayerHealth {
  /** Path (or bare name) the CLI fallback would spawn. */
  binary: string;
  /** The binary resolves to something that exists, or sits on PATH. */
  binaryFound: boolean;
  /** `<project>/.codegraph/codegraph.db` exists. */
  hasIndex: boolean;
  dbPath: string;
  dbBytes?: number;
  schemaVersion?: number;
  schemaMin: number;
  schemaMax: number;
  /** Absent when there is no index to judge. */
  schemaSupported?: boolean;
  indexState?: string;
  /** `no-index` | `incomplete` | `schema-drift` | `open-failed`, when refused. */
  openReason?: string;
  openMessage?: string;
  nodes?: number;
  edges?: number;
  files?: number;
  /** One line from `formatFreshnessLine`, absent when the index is current. */
  freshness?: string;
  daemon: GraphDaemonHealth;
  /** Paths waiting in the in-process sync queue for this project. */
  queued: number;
  error?: string;
}

export interface FsBusLayerHealth {
  /** `CONTEXT_MODE_FS_BUS` is not switched off. */
  enabled: boolean;
  /** A live subscription is delivering events for this project. */
  active: boolean;
  /** fff reported itself unavailable, so nothing can be wired. */
  unavailable: boolean;
  reason?: string;
  consumers: { index: boolean; graph: boolean; cache: boolean };
  /** Every root with wiring attached in this process. */
  roots: string[];
  batches: number;
  events: number;
  reindexed: number;
  evicted: number;
  enqueued: number;
  cacheInvalidations: number;
  overflowed: number;
  lastError?: string;
  error?: string;
}

export interface TokenizerLayerHealth {
  /** `bytes4` (legacy), `heuristic` (calibrated), or `exact` (real BPE). */
  mode: string;
  encoding: string;
  error?: string;
}

export interface CompressionLayerHealth {
  enabled: boolean;
  error?: string;
}

export interface LayerHealth {
  projectDir: string;
  fff: FffLayerHealth;
  graph: GraphLayerHealth;
  fsBus: FsBusLayerHealth;
  tokenizer: TokenizerLayerHealth;
  compression: CompressionLayerHealth;
}

// ─────────────────────────────────────────────────────────
// Small shared helpers
// ─────────────────────────────────────────────────────────

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Human byte size, matching the CLI's own short form. */
export function shortBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "n/a";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * Does this binary exist? An absolute/relative spelling is stat'ed; a bare
 * name is looked up along PATH the way a spawn would resolve it.
 */
export function binaryResolves(bin: string, env: Env = process.env): boolean {
  try {
    if (bin.includes("/") || bin.includes("\\")) return existsSync(bin);
    const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
    const exts = process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
    for (const dir of dirs) {
      for (const ext of exts) {
        if (existsSync(join(dir, bin + ext))) return true;
      }
    }
  } catch { /* an unreadable PATH entry is not a diagnosis */ }
  return false;
}

/**
 * Version of the installed `@ff-labs/fff-node`.
 *
 * Resolution first (works from the plugin cache, from a global npm install and
 * from the repo), then the explicit plugin-root layout `hooks/ensure-deps.mjs`
 * installs into. Undefined means "not installed here" — never an error.
 */
export function fffPackageVersion(pluginRoot?: string): string | undefined {
  const candidates: string[] = [];
  try {
    candidates.push(createRequire(import.meta.url).resolve("@ff-labs/fff-node/package.json"));
  } catch { /* not resolvable from here — try the explicit layout */ }
  if (pluginRoot) {
    candidates.push(join(pluginRoot, "node_modules", "@ff-labs", "fff-node", "package.json"));
  }
  for (const path of candidates) {
    try {
      const version = JSON.parse(readFileSync(path, "utf-8"))?.version;
      if (typeof version === "string" && version.length > 0) return version;
    } catch { /* next candidate */ }
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────
// Collectors
// ─────────────────────────────────────────────────────────

/**
 * fff: is the native library there, which version, where is the per-project
 * ranking state and how big is it, and is the watcher allowed to run.
 *
 * `fffHealthReport` does the loading; everything this adds is the package
 * version (which the library itself cannot report when it failed to load) and
 * the env-switch state.
 */
export async function fffLayerHealth(
  projectDir: string,
  opts: { env?: Env; pluginRoot?: string } = {},
): Promise<FffLayerHealth> {
  const env = opts.env ?? process.env;
  const packageVersion = fffPackageVersion(opts.pluginRoot);
  try {
    const fff = await import("../fff/index.js");
    const report = await fff.fffHealthReport(projectDir);
    return {
      enabled: report.enabled && fff.isFffEnabled(env),
      available: report.available,
      packageVersion,
      nativeVersion: report.version,
      storageDir: report.storageDir,
      frecencyDbPath: report.frecencyDbPath,
      frecencyBytes: report.frecencyDiskBytes,
      historyDbPath: report.historyDbPath,
      historyBytes: report.historyDiskBytes,
      indexedFiles: report.indexedFiles,
      gitRepositoryFound: report.gitRepositoryFound,
      activeRoots: report.liveRoots ?? [],
      watch: !fff.isWatchDisabled(env),
      mmap: !fff.isMmapCacheDisabled(env),
      error: report.error,
    };
  } catch (err) {
    // The module itself is missing (upstream tree, partial install). That is
    // "not installed", not a doctor failure.
    return {
      enabled: false,
      available: false,
      packageVersion,
      storageDir: "n/a",
      activeRoots: [],
      watch: false,
      mmap: false,
      error: message(err),
    };
  }
}

/**
 * codegraph: binary, index, schema window, daemon, lag, size.
 *
 * The index is opened read-only and closed again in the same call — doctor
 * must not leave a handle behind that a later `codegraph sync` would fight.
 */
export async function graphLayerHealth(
  projectDir: string,
  opts: { env?: Env } = {},
): Promise<GraphLayerHealth> {
  const env = opts.env ?? process.env;
  try {
    const db = await import("../graph/db.js");
    const daemonMod = await import("../graph/daemon.js");

    const binary = db.codegraphBinary(env);
    const dbPath = db.codegraphDbPath(projectDir);
    const health: GraphLayerHealth = {
      binary,
      binaryFound: binaryResolves(binary, env),
      hasIndex: db.hasCodegraphIndex(projectDir),
      dbPath,
      schemaMin: db.SCHEMA_MIN,
      schemaMax: db.schemaMax(env),
      daemon: { running: false, stale: false, socketPresent: false },
      queued: 0,
    };

    try {
      if (existsSync(dbPath)) health.dbBytes = statSync(dbPath).size;
    } catch { /* size is a nicety */ }

    try {
      const status = daemonMod.daemonStatus(projectDir);
      health.daemon = {
        running: status.running,
        stale: status.stale,
        socketPresent: status.socketPresent,
        pid: status.pid,
        version: status.version,
      };
    } catch { /* no daemon files — the defaults already say so */ }

    try {
      const canonical = db.normalizeProjectDir(projectDir);
      for (const entry of daemonMod.syncQueueState()) {
        if (db.normalizeProjectDir(entry.projectDir) === canonical) {
          health.queued += entry.files.length;
        }
      }
    } catch { /* the queue is process-local and may not exist */ }

    if (!health.hasIndex) {
      health.openReason = "no-index";
      return health;
    }

    const opened = db.openGraphDb(projectDir, { env });
    if (!opened.ok) {
      health.openReason = opened.reason;
      health.openMessage = opened.message;
      if (opened.schemaVersion !== undefined) {
        health.schemaVersion = opened.schemaVersion;
        health.schemaSupported =
          opened.schemaVersion >= health.schemaMin && opened.schemaVersion <= health.schemaMax;
      }
      return health;
    }

    const handle = opened.handle;
    try {
      health.schemaVersion = handle.schemaVersion;
      health.schemaSupported =
        handle.schemaVersion >= health.schemaMin && handle.schemaVersion <= health.schemaMax;
      health.indexState = handle.indexState;
      try {
        const queries = await import("../graph/queries.js");
        const stats = queries.graphStats(handle);
        health.nodes = stats.nodes;
        health.edges = stats.edges;
        health.files = stats.files;
      } catch { /* stats are advisory */ }
      try {
        const line = db.formatFreshnessLine(db.checkFreshness(handle, { env }));
        if (line) health.freshness = line;
      } catch { /* a stat sweep that fails is not a diagnosis */ }
    } finally {
      try { handle.close(); } catch { /* already closed */ }
    }
    return health;
  } catch (err) {
    return {
      binary: "codegraph",
      binaryFound: false,
      hasIndex: false,
      dbPath: "n/a",
      schemaMin: 0,
      schemaMax: 0,
      daemon: { running: false, stale: false, socketPresent: false },
      queued: 0,
      error: message(err),
    };
  }
}

/** Filesystem bus: wired or not, which consumers are on, what it has moved. */
export async function fsBusLayerHealth(
  projectDir: string,
  opts: { env?: Env } = {},
): Promise<FsBusLayerHealth> {
  const env = opts.env ?? process.env;
  const empty = (extra: Partial<FsBusLayerHealth> = {}): FsBusLayerHealth => ({
    enabled: false,
    active: false,
    unavailable: true,
    consumers: { index: false, graph: false, cache: false },
    roots: [],
    batches: 0,
    events: 0,
    reindexed: 0,
    evicted: 0,
    enqueued: 0,
    cacheInvalidations: 0,
    overflowed: 0,
    ...extra,
  });

  try {
    const bus = await import("../fs-bus/index.js");
    const busEnv = await import("../fs-bus/env.js");
    const roots = bus.activeFsWiringRoots();
    const status = bus.activeFsWiring(projectDir);
    const consumers = {
      index: busEnv.isIndexConsumerEnabled(env),
      graph: busEnv.isGraphConsumerEnabled(env),
      cache: busEnv.isCacheConsumerEnabled(env),
    };
    if (!status) {
      return empty({
        enabled: busEnv.isFsBusEnabled(env),
        unavailable: false,
        reason: roots.length > 0 ? "no wiring for this project" : "no wiring installed",
        consumers,
        roots,
      });
    }
    return {
      enabled: busEnv.isFsBusEnabled(env),
      active: status.active,
      unavailable: status.unavailable,
      reason: status.reason,
      consumers: status.consumers ?? consumers,
      roots,
      batches: status.batches,
      events: status.events,
      reindexed: status.reindexed,
      evicted: status.evicted,
      enqueued: status.enqueued,
      cacheInvalidations: status.cacheInvalidations,
      overflowed: status.overflowed,
      lastError: status.lastError,
    };
  } catch (err) {
    return empty({ error: message(err) });
  }
}

/** Which token counter is live, and under which encoding. */
export async function tokenizerLayerHealth(): Promise<TokenizerLayerHealth> {
  try {
    const tok = await import("../session/tokenizer.js");
    return { mode: tok.tokenizerMode(), encoding: tok.resolveEncoding() };
  } catch (err) {
    return { mode: "bytes4", encoding: "n/a", error: message(err) };
  }
}

/** Is the output-compression pass on? */
export async function compressionLayerHealth(
  opts: { env?: Env } = {},
): Promise<CompressionLayerHealth> {
  try {
    const compress = await import("../compress/index.js");
    // No per-call opt-in here: doctor asks the *default* question, "would a
    // call that says nothing be compressed?", which is the env answer.
    return { enabled: compress.outputCompressionEnabled(undefined, opts.env ?? process.env) };
  } catch (err) {
    return { enabled: false, error: message(err) };
  }
}

/** Every layer, in one pass. Never throws. */
export async function collectLayerHealth(opts: {
  projectDir: string;
  env?: Env;
  pluginRoot?: string;
}): Promise<LayerHealth> {
  const env = opts.env ?? process.env;
  const [fff, graph, fsBus, tokenizer, compression] = await Promise.all([
    fffLayerHealth(opts.projectDir, { env, pluginRoot: opts.pluginRoot }),
    graphLayerHealth(opts.projectDir, { env }),
    fsBusLayerHealth(opts.projectDir, { env }),
    tokenizerLayerHealth(),
    compressionLayerHealth({ env }),
  ]);
  return { projectDir: opts.projectDir, fff, graph, fsBus, tokenizer, compression };
}

// ─────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────

/**
 * The layer section as plain lines — no colour, no clack, so the same text can
 * be asserted in a test, printed by the CLI, or embedded in an MCP response.
 *
 * Each line starts with a fixed-width label so the block reads as a table, and
 * a layer that is not installed still gets its line: "absent" is the diagnosis
 * a user came here for.
 */
export function renderLayerHealth(h: LayerHealth): string[] {
  const lines: string[] = [];
  const pad = (label: string) => `${label}:`.padEnd(14);

  // ── fff ──
  const fff = h.fff;
  if (!fff.enabled) {
    lines.push(`${pad("fff")}off (CONTEXT_MODE_FFF)${fff.error ? ` — ${fff.error}` : ""}`);
  } else if (!fff.available) {
    const version = fff.packageVersion ? `package ${fff.packageVersion} installed` : "package not installed";
    lines.push(`${pad("fff")}not loaded — ${version}${fff.error ? ` (${fff.error})` : ""}`);
  } else {
    const versions = [
      fff.nativeVersion ? `native ${fff.nativeVersion}` : null,
      fff.packageVersion ? `package ${fff.packageVersion}` : null,
    ].filter(Boolean).join(", ");
    lines.push(
      `${pad("fff")}available${versions ? ` (${versions})` : ""} — ` +
      `watcher ${fff.watch ? "on" : "off"}, mmap ${fff.mmap ? "on" : "off"}, ` +
      `${fff.activeRoots.length} live root(s)` +
      (fff.indexedFiles !== undefined ? `, ${fff.indexedFiles} indexed file(s)` : ""),
    );
  }
  if (fff.frecencyDbPath || fff.storageDir !== "n/a") {
    // A database that does not exist yet is not "n/a" — it is the normal state
    // of a project nobody has searched in, and saying so avoids a bug report.
    const db = (bytes: number | undefined) => (bytes === undefined ? "none yet" : shortBytes(bytes));
    lines.push(
      `${pad("fff store")}${fff.storageDir} — ` +
      `frecency ${db(fff.frecencyBytes)}, history ${db(fff.historyBytes)}`,
    );
  }

  // ── codegraph ──
  const g = h.graph;
  if (g.error) {
    lines.push(`${pad("codegraph")}not installed — ${g.error}`);
  } else if (!g.hasIndex) {
    lines.push(
      `${pad("codegraph")}no index for this project (${g.dbPath}) — ` +
      (g.binaryFound ? `binary found: ${g.binary}` : "binary not found (nothing to index with)"),
    );
  } else {
    const schema = g.schemaVersion === undefined
      ? "schema unknown"
      : `schema v${g.schemaVersion} ` +
        `(${g.schemaSupported ? "supported" : "OUT OF RANGE"} ${g.schemaMin}-${g.schemaMax})`;
    const counts = g.nodes !== undefined
      ? `, ${g.files ?? 0} files / ${g.nodes} nodes / ${g.edges ?? 0} edges`
      : "";
    lines.push(
      `${pad("codegraph")}index ${shortBytes(g.dbBytes)}, ${schema}${counts}` +
      (g.openReason ? ` — ${g.openReason}` : ""),
    );
    lines.push(
      `${pad("cg daemon")}` +
      (g.daemon.running
        ? `running (pid ${g.daemon.pid}${g.daemon.version ? `, v${g.daemon.version}` : ""})`
        : g.daemon.stale
          ? `stale pid file (pid ${g.daemon.pid} is gone)`
          : "not running") +
      `, socket ${g.daemon.socketPresent ? "present" : "absent"}` +
      (g.queued > 0 ? `, ${g.queued} path(s) queued` : ""),
    );
    lines.push(`${pad("cg freshness")}${g.freshness ?? "index is current"}`);
  }

  // ── fs bus ──
  const b = h.fsBus;
  const consumers = Object.entries(b.consumers)
    .filter(([, on]) => on)
    .map(([name]) => name)
    .join("+") || "none";
  if (b.error) {
    lines.push(`${pad("fs bus")}not installed — ${b.error}`);
  } else if (!b.active) {
    lines.push(
      `${pad("fs bus")}inactive (${b.enabled ? b.reason ?? "not wired" : "CONTEXT_MODE_FS_BUS off"}) — ` +
      `consumers ${consumers}`,
    );
  } else {
    lines.push(
      `${pad("fs bus")}active — consumers ${consumers}, ` +
      `${b.batches} batch(es) / ${b.events} event(s) / ${b.reindexed} reindexed / ${b.enqueued} enqueued` +
      (b.overflowed > 0 ? `, ${b.overflowed} dropped to the batch cap` : "") +
      (b.lastError ? ` — last error: ${b.lastError}` : ""),
    );
  }

  // ── counters ──
  lines.push(`${pad("tokenizer")}${h.tokenizer.mode} (${h.tokenizer.encoding})`);
  lines.push(
    `${pad("compression")}` +
    (h.compression.enabled ? "on" : "off (CONTEXT_MODE_EXEC_COMPRESS=1 enables)") +
    (h.compression.error ? ` — ${h.compression.error}` : ""),
  );

  return lines;
}
