/**
 * Delivery health — *which build is the host actually running?*
 *
 * Every other check in `ctx_doctor` answers a question about the tree the
 * doctor itself was loaded from. That is exactly the tree the interesting
 * failure hides behind: Claude Code does not run the repository, and it does
 * not run the marketplace clone either — it runs an unpacked copy under
 * `~/.claude/plugins/cache/context-mode/context-mode/<version>/start.mjs`,
 * and the **cache key is the version number**. Two waves shipped with the
 * number frozen at `1.0.169`; the cache was never invalidated, so `ctx_find`
 * and `ctx_graph` existed in the repository bundle and in the marketplace
 * clone and were absent from every live session. Nothing failed. Two tools
 * simply were not there, and the doctor reported a clean bill of health.
 *
 * This module is the check that says so out loud. It answers three questions
 * the rest of the report cannot:
 *
 *   1. **What is running?** The `start.mjs` path of the live MCP server,
 *      found from the process table (`pgrep`/`ps`, PowerShell on Windows) and
 *      from this process's own argv — plus the version that path belongs to.
 *   2. **When was it built?** The mtime of the `server.bundle.mjs` beside that
 *      `start.mjs`, and the same for every other version dir in the cache.
 *   3. **What is missing?** The `ctx_*` tools the running bundle registers,
 *      against the list this source is known to ship — named individually,
 *      because "12 of 14 tools" is not an answer anyone can act on.
 *
 * The rules from `layer-health.ts` hold here too: **never throw** (a probe
 * that cannot run is a state, not a failure) and **never mutate** — the only
 * writer in this file is `purgePluginCache`, which callers reach deliberately
 * from `ctx_upgrade` and which touches nothing outside this plugin's own
 * cache directory.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

// ─────────────────────────────────────────────────────────
// The shipped tool surface
// ─────────────────────────────────────────────────────────

/**
 * The `ctx_*` tools this source registers, in registration order.
 *
 * Kept as a literal rather than derived from `REGISTERED_CTX_TOOLS`: the whole
 * point of the check is to compare a *running* bundle against what the source
 * says it should carry, and the running bundle is precisely the thing that may
 * be missing a registration. `tests/util/delivery-health.test.ts` pins this
 * list against the `registerTool` calls in the server source, so it cannot
 * drift the way a hand-maintained list normally would.
 */
export const EXPECTED_CTX_TOOLS: readonly string[] = [
  "ctx_execute",
  "ctx_execute_file",
  "ctx_index",
  "ctx_search",
  "ctx_find",
  "ctx_graph",
  "ctx_fetch_and_index",
  "ctx_batch_execute",
  "ctx_gather",
  "ctx_stats",
  "ctx_doctor",
  "ctx_upgrade",
  "ctx_purge",
  "ctx_insight",
];

// ─────────────────────────────────────────────────────────
// Cache paths
// ─────────────────────────────────────────────────────────

/** Marketplace owner and plugin name — the two segments Claude Code keys on. */
const CACHE_OWNER = "context-mode";
const CACHE_PLUGIN = "context-mode";

/** Raised when the cache location cannot be resolved to something safe. */
export class DeliveryPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryPathError";
  }
}

/**
 * Home directory, or a refusal.
 *
 * `os.homedir()` answers the empty string when `HOME`/`USERPROFILE` are unset
 * and the passwd lookup fails, and `path.resolve("", ".claude")` then collapses
 * to `<cwd>/.claude`. A caller that deletes what this function feeds it would
 * delete inside the user's project. An unusable home is a refusal, not a
 * default.
 */
function homeOrThrow(env: NodeJS.ProcessEnv): string {
  const candidates = [env.HOME, env.USERPROFILE];
  for (const raw of candidates) {
    const trimmed = raw?.trim();
    if (trimmed && isAbsolute(trimmed)) return resolve(trimmed);
  }
  let fromOs = "";
  try { fromOs = homedir(); } catch { /* refusal below */ }
  if (fromOs && fromOs.trim() && isAbsolute(fromOs)) return resolve(fromOs);
  throw new DeliveryPathError(
    "HOME is not set to an absolute path — refusing to guess where the plugin cache lives",
  );
}

/**
 * `<config>/plugins/cache/context-mode` — the owner directory that holds every
 * version the host has unpacked for this plugin.
 *
 * Mirrors `resolveClaudeConfigDir`'s contract for `CLAUDE_CONFIG_DIR` (tilde
 * expansion, whitespace-only treated as unset) but resolves the home leg
 * through `homeOrThrow`, because the result of this function is a deletion
 * target and `resolveClaudeConfigDir`'s cwd fallback is not survivable there.
 */
export function resolvePluginCacheOwnerDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.CLAUDE_CONFIG_DIR;
  let configDir: string;
  if (raw && raw.trim() !== "") {
    const trimmed = raw.trim();
    configDir = trimmed.startsWith("~")
      ? resolve(homeOrThrow(env), trimmed.replace(/^~[/\\]?/, ""))
      : resolve(trimmed);
  } else {
    configDir = resolve(homeOrThrow(env), ".claude");
  }
  // A one-segment path ("/", "C:\") means something upstream resolved to the
  // filesystem root; joining "plugins/cache/..." onto it would still be inside
  // that root, but nothing about the situation is trustworthy enough to delete
  // from.
  if (!isAbsolute(configDir) || resolve(configDir, "..") === configDir) {
    throw new DeliveryPathError(`refusing to use "${configDir}" as the config directory`);
  }
  return join(configDir, "plugins", "cache", CACHE_OWNER);
}

/** `<owner>/context-mode` — the directory whose children are version dirs. */
export function resolvePluginCacheVersionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolvePluginCacheOwnerDir(env), CACHE_PLUGIN);
}

// ─────────────────────────────────────────────────────────
// Report shapes
// ─────────────────────────────────────────────────────────

/** One `start.mjs` the process table (or this process's argv) points at. */
export interface RunningServer {
  /** Absolute path of the `start.mjs` the host launched. */
  startPath: string;
  /** Directory holding that `start.mjs` — the effective plugin root. */
  root: string;
  /**
   * pids running this exact script, ascending. A host commonly has several —
   * a `node` server and a `bun` one, plus every session that never exited —
   * and they are the same finding, so they share one entry.
   */
  pids: number[];
  /** This very process — the MCP server answering the doctor call. */
  self: boolean;
  /** Version of that tree, from `.claude-plugin/plugin.json` or `package.json`. */
  version?: string;
  /** Where the tree lives: unpacked cache, marketplace clone, or elsewhere. */
  origin: "cache" | "marketplace" | "other";
  /** `ctx_*` names found in the `server.bundle.mjs` beside it, when readable. */
  tools?: string[];
  /** mtime of that bundle, in epoch ms — "when was this build made". */
  builtAt?: number;
}

/** One unpacked version directory under the plugin cache. */
export interface CacheEntry {
  /** Directory name — the key the host looks the plugin up by. */
  version: string;
  path: string;
  /**
   * Target, when this entry is a symlink to another version directory. Heal
   * scripts point old version names at the surviving tree, and following those
   * links would report the same build eight times over.
   */
  aliasOf?: string;
  /** Version the tree's own manifest claims, when it disagrees with the name. */
  manifestVersion?: string;
  /** mtime of `server.bundle.mjs` (or the directory, if the bundle is absent). */
  builtAt?: number;
  /** `ctx_*` names found in that version's bundle. */
  tools?: string[];
  /** This entry is the tree that is running right now. */
  running: boolean;
}

export interface DeliveryHealth {
  /** `<config>/plugins/cache/context-mode`, when it could be resolved. */
  cacheRoot?: string;
  /** Why the cache could not be inspected — unset home, unreadable dir. */
  cacheError?: string;
  /** Version dirs found, newest build first. */
  cacheEntries: CacheEntry[];
  /** Servers seen running, this process first. */
  running: RunningServer[];
  /** Tool names the live process registered, when the caller knows them. */
  liveTools?: string[];
  expectedTools: string[];
  /** Expected but absent from the running surface — the headline finding. */
  missingTools: string[];
  /** Present but not expected — a bundle newer than this source. */
  unexpectedTools: string[];
  /** Plugin root this process loaded from, for the "installed vs running" line. */
  pluginRoot?: string;
  pluginRootVersion?: string;
  status: "ok" | "warn" | "fail";
}

// ─────────────────────────────────────────────────────────
// Probes
// ─────────────────────────────────────────────────────────

/** Inject `child_process.execFileSync`. Must return stdout as utf-8. */
export type RunCommand = (cmd: string, args: readonly string[]) => string;

const defaultRun: RunCommand = (cmd, args) =>
  execFileSync(cmd, [...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 3000,
  });

// Same two shapes `sibling-mcp.ts` matches: the unpacked cache and the
// marketplace clone can both be alive at once, across different versions.
const POSIX_PATTERN = "plugins/(cache|marketplaces)/.*context-mode.*start\\.mjs";
const WIN_PS_SCRIPT =
  "Get-CimInstance Win32_Process | " +
  "Where-Object { $_.CommandLine -match 'plugins[\\\\/](cache|marketplaces)[\\\\/].*context-mode.*start\\.mjs' } | " +
  "ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }";

/**
 * Pull the `start.mjs` path out of one `pid <command line>` row.
 *
 * The command line can carry a runtime (`node`, `bun`), flags, and arguments
 * after the script; the script is the first token ending in `start.mjs`.
 */
function parseProcessRow(row: string): { pid?: number; startPath: string } | null {
  const trimmed = row.trim();
  if (!trimmed) return null;
  const pidMatch = /^(\d+)\s+/.exec(trimmed);
  const rest = pidMatch ? trimmed.slice(pidMatch[0].length) : trimmed;
  const pathMatch = /(\S*start\.mjs)/.exec(rest);
  if (!pathMatch) return null;
  const startPath = pathMatch[1];
  if (!startPath.includes("context-mode")) return null;
  return {
    pid: pidMatch ? Number.parseInt(pidMatch[1], 10) : undefined,
    startPath,
  };
}

/**
 * Every `start.mjs` currently running, from the process table.
 *
 * Degrades to an empty list without a word when the platform has no usable
 * process tool — a stripped container has no `pgrep`, and a doctor that fails
 * because of that is worse than a doctor that says "not observed".
 */
export function discoverRunningStartPaths(opts: {
  platform?: NodeJS.Platform;
  runCommand?: RunCommand;
} = {}): { pid?: number; startPath: string }[] {
  const platform = opts.platform ?? process.platform;
  const run = opts.runCommand ?? defaultRun;
  const attempts: Array<[string, string[]]> = platform === "win32"
    ? [["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN_PS_SCRIPT]]]
    : [
      ["pgrep", ["-af", POSIX_PATTERN]],
      // BusyBox `pgrep` has no -a; fall back to a full listing and filter here.
      ["ps", ["-eo", "pid=,args="]],
    ];
  for (const [cmd, args] of attempts) {
    let stdout: string;
    try {
      stdout = run(cmd, args);
    } catch {
      continue; // tool missing or nothing matched — try the next shape
    }
    const found: { pid?: number; startPath: string }[] = [];
    for (const row of stdout.split(/\r?\n/)) {
      if (!/start\.mjs/.test(row)) continue;
      const parsed = parseProcessRow(row);
      if (parsed) found.push(parsed);
    }
    if (found.length > 0) return found;
  }
  return [];
}

/** Version of a tree, preferring the manifest the host itself keys on. */
export function readTreeVersion(root: string): string | undefined {
  for (const rel of [join(".claude-plugin", "plugin.json"), "package.json"]) {
    try {
      const parsed = JSON.parse(readFileSync(join(root, rel), "utf-8"));
      if (parsed && typeof parsed.version === "string") return parsed.version;
    } catch { /* unreadable or malformed — try the next manifest */ }
  }
  return undefined;
}

/**
 * The `ctx_*` tools a built bundle registers.
 *
 * Reads the shipped `server.bundle.mjs` — the artifact the host executes, not
 * the source it was built from. esbuild keeps `registerTool("ctx_find"` intact
 * (the bundle is not minified), so the same regex works on the bundle and on
 * the source.
 */
export function scanBundleTools(bundlePath: string): string[] | undefined {
  let text: string;
  try {
    text = readFileSync(bundlePath, "utf-8");
  } catch {
    return undefined;
  }
  const names = new Set<string>();
  for (const m of text.matchAll(/registerTool\(\s*"(ctx_[a-z_]+)"/g)) names.add(m[1]);
  return [...names];
}

/** mtime in epoch ms of the bundle in `root`, falling back to the directory. */
function builtAtOf(root: string): number | undefined {
  for (const candidate of [join(root, "server.bundle.mjs"), root]) {
    try { return statSync(candidate).mtimeMs; } catch { /* try the next */ }
  }
  return undefined;
}

function originOf(path: string): RunningServer["origin"] {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.includes("/plugins/cache/")) return "cache";
  if (normalized.includes("/plugins/marketplaces/")) return "marketplace";
  return "other";
}

// ─────────────────────────────────────────────────────────
// Collection
// ─────────────────────────────────────────────────────────

export interface DeliveryHealthOptions {
  /** Plugin root this process loaded from — `getPluginRoot()`. */
  pluginRoot?: string;
  /**
   * Tool names the live process registered. The server-side doctor passes
   * `REGISTERED_CTX_TOOLS`, which is the only fully authoritative answer to
   * "what does this session actually have"; the CLI has no such list and
   * falls back to scanning the running bundle.
   */
  liveTools?: readonly string[];
  expectedTools?: readonly string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  runCommand?: RunCommand;
  /** `process.argv` injection — argv[1] is this process's own entry script. */
  argv?: readonly string[];
  /** `process.pid` injection. */
  pid?: number;
}

/** Collect the delivery picture. Never throws. */
export function collectDeliveryHealth(opts: DeliveryHealthOptions = {}): DeliveryHealth {
  const env = opts.env ?? process.env;
  const expectedTools = [...(opts.expectedTools ?? EXPECTED_CTX_TOOLS)];
  const argv = opts.argv ?? process.argv;
  const selfPid = opts.pid ?? process.pid;

  // ── who is running ──
  // Grouped by script path: a host routinely has four live servers on the same
  // `start.mjs` (node and bun, times the sessions that never exited), and they
  // are one finding, not four.
  const byPath = new Map<string, { pids: Set<number>; self: boolean }>();
  const sight = (startPath: string, pid: number | undefined, self: boolean) => {
    const entry = byPath.get(startPath) ?? { pids: new Set<number>(), self: false };
    if (pid !== undefined) entry.pids.add(pid);
    entry.self = entry.self || self;
    byPath.set(startPath, entry);
  };
  const selfScript = argv[1];
  if (typeof selfScript === "string" && /start\.mjs$/.test(selfScript)) {
    // The doctor usually runs *inside* the MCP server, so argv[1] is the most
    // reliable sighting available — no process tool involved, no ambiguity
    // about which of several servers answered this call.
    sight(resolve(selfScript), selfPid, true);
  }
  for (const found of discoverRunningStartPaths({ platform: opts.platform, runCommand: opts.runCommand })) {
    sight(resolve(found.startPath), found.pid, found.pid === selfPid);
  }

  const running: RunningServer[] = [...byPath.entries()].map(([startPath, entry]) => {
    const root = resolve(startPath, "..");
    return {
      startPath,
      root,
      pids: [...entry.pids].sort((a, b) => a - b),
      self: entry.self,
      version: readTreeVersion(root),
      origin: originOf(startPath),
      tools: scanBundleTools(join(root, "server.bundle.mjs")),
      builtAt: builtAtOf(root),
    };
  });
  // This process first: it is the one whose tool list the caller is holding.
  running.sort((a, b) => Number(b.self) - Number(a.self));

  // ── what the cache holds ──
  let cacheRoot: string | undefined;
  let cacheError: string | undefined;
  const cacheEntries: CacheEntry[] = [];
  try {
    cacheRoot = resolvePluginCacheOwnerDir(env);
    const versionsDir = join(cacheRoot, CACHE_PLUGIN);
    if (existsSync(versionsDir)) {
      for (const name of readdirSync(versionsDir)) {
        const path = join(versionsDir, name);
        // lstat, not stat: the directory name is the key the host resolves,
        // and a symlinked name is an alias for another build — following it
        // would report the same tree once per alias.
        let link: string | undefined;
        try {
          const st = lstatSync(path);
          if (st.isSymbolicLink()) link = readlinkSync(path);
          else if (!st.isDirectory()) continue;
        } catch { continue; /* vanished mid-scan */ }
        const manifestVersion = link ? undefined : readTreeVersion(path);
        cacheEntries.push({
          version: name,
          path,
          aliasOf: link,
          manifestVersion: manifestVersion && manifestVersion !== name ? manifestVersion : undefined,
          builtAt: link ? undefined : builtAtOf(path),
          tools: link ? undefined : scanBundleTools(join(path, "server.bundle.mjs")),
          running: running.some((r) => r.root === path),
        });
      }
      // Newest build first; equal (or unknown) build times fall back to the
      // version name so the order is stable rather than readdir order.
      cacheEntries.sort((a, b) =>
        (b.builtAt ?? 0) - (a.builtAt ?? 0) || b.version.localeCompare(a.version, undefined, { numeric: true }));
    }
  } catch (err) {
    cacheError = err instanceof Error ? err.message : String(err);
  }

  // ── what is missing ──
  // Priority: the live registration list (exact), then the bundle of the tree
  // that answered this call, then any running bundle we could read. A session
  // where none of the three is available reports no finding rather than a
  // false one.
  const liveTools = opts.liveTools ? [...opts.liveTools] : undefined;
  const observed = liveTools
    ?? running.find((r) => r.self && r.tools)?.tools
    ?? running.find((r) => r.tools)?.tools;
  const missingTools = observed ? expectedTools.filter((t) => !observed.includes(t)) : [];
  const unexpectedTools = observed ? observed.filter((t) => !expectedTools.includes(t)) : [];

  const pluginRoot = opts.pluginRoot ? resolve(opts.pluginRoot) : undefined;
  const pluginRootVersion = pluginRoot ? readTreeVersion(pluginRoot) : undefined;

  // A stale cache is a warning; a tool the session does not have is a failure,
  // because no amount of retrying makes it appear.
  let status: DeliveryHealth["status"] = "ok";
  if (cacheError) status = "warn";
  // Aliases are names, not builds — comparing against one would call a healthy
  // install stale every time a heal script left a symlink behind.
  const realEntries = cacheEntries.filter((e) => !e.aliasOf);
  const newest = realEntries[0];
  const runningEntry = realEntries.find((e) => e.running);
  if (newest && runningEntry && newest.path !== runningEntry.path) status = "warn";
  if (
    pluginRootVersion && running[0]?.version
    && running[0].origin === "cache"
    && pluginRootVersion !== running[0].version
  ) status = "warn";
  if (missingTools.length > 0 || unexpectedTools.length > 0) status = "fail";

  return {
    cacheRoot,
    cacheError,
    cacheEntries,
    running,
    liveTools,
    expectedTools,
    missingTools,
    unexpectedTools,
    pluginRoot,
    pluginRootVersion,
    status,
  };
}

// ─────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────

/** `2026-08-18 02:23` — local time, minute precision. Empty for unknown. */
export function formatBuiltAt(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "unknown";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The delivery section as plain lines — no colour, no clack — so the same text
 * is asserted in a test, printed by the CLI, and embedded in the MCP response.
 */
export function renderDeliveryHealth(h: DeliveryHealth): string[] {
  const lines: string[] = [];
  const WIDTH = 14;
  const pad = (label: string) => `${label}:`.padEnd(WIDTH);
  /** Continuation of the previous line — blank label, same column. */
  const cont = " ".repeat(WIDTH);

  if (h.running.length === 0) {
    lines.push(`${pad("running")}not observed — no start.mjs found in the process table`);
  }
  for (const r of h.running) {
    const bits = [
      r.version ? `v${r.version}` : "version unknown",
      r.pids.length > 0 ? `${r.pids.length === 1 ? "pid" : "pids"} ${r.pids.join(", ")}` : null,
      r.self ? "this process" : null,
      r.origin === "cache" ? "unpacked cache" : r.origin === "marketplace" ? "marketplace clone" : null,
    ].filter(Boolean).join(", ");
    lines.push(`${pad("running")}${r.startPath} (${bits})`);
    lines.push(
      `${pad("build")}${formatBuiltAt(r.builtAt)}`
      + (r.tools ? ` — bundle registers ${r.tools.length} ctx_* tool(s)` : " — bundle not readable"),
    );
  }

  if (h.liveTools) {
    lines.push(`${pad("session")}${h.liveTools.length} ctx_* tool(s) registered in this process`);
  }

  if (h.missingTools.length > 0) {
    // Name them. "12 of 14" tells nobody which call to stop making.
    const built = formatBuiltAt(h.running[0]?.builtAt);
    const version = h.running[0]?.version ? ` for v${h.running[0].version}` : "";
    lines.push(
      `${pad("tools")}MISSING from this session: ${h.missingTools.join(", ")}`
      + ` — the running build was made ${built}${version}`,
    );
    lines.push(`${cont}Fix: bump the plugin version, rebuild, then run /context-mode:ctx-upgrade and restart the session`);
  } else if (h.unexpectedTools.length > 0) {
    lines.push(
      `${pad("tools")}running build carries tools this source does not know: ${h.unexpectedTools.join(", ")}`
      + " — the installed tree is newer than the one this doctor came from",
    );
  } else if (h.expectedTools.length > 0 && (h.liveTools || h.running.some((r) => r.tools))) {
    lines.push(`${pad("tools")}all ${h.expectedTools.length} expected ctx_* tools present`);
  }

  if (h.cacheError) {
    lines.push(`${pad("cache")}not inspected — ${h.cacheError}`);
  } else if (!h.cacheRoot) {
    lines.push(`${pad("cache")}not resolved`);
  } else if (h.cacheEntries.length === 0) {
    lines.push(`${pad("cache")}${h.cacheRoot} — no unpacked versions (host has not installed the plugin here)`);
  } else {
    const builds = h.cacheEntries.filter((e) => !e.aliasOf);
    const aliases = h.cacheEntries.filter((e) => e.aliasOf);
    lines.push(`${pad("cache")}${h.cacheRoot} — ${builds.length} unpacked build(s), newest first`);
    for (const e of builds) {
      const marks = [
        `built ${formatBuiltAt(e.builtAt)}`,
        e.tools ? `${e.tools.length} tool(s)` : "no bundle",
        e.manifestVersion ? `manifest says v${e.manifestVersion}` : null,
        e.running ? "RUNNING" : null,
      ].filter(Boolean).join(", ");
      lines.push(`${cont}  v${e.version} — ${marks}`);
    }
    if (aliases.length > 0) {
      // One line for the lot: a heal script that symlinks eight old version
      // names at the surviving tree is housekeeping, not a finding.
      lines.push(`${cont}  ${aliases.length} alias(es): ${aliases.map((a) => a.version).join(", ")}`);
    }
  }

  if (h.pluginRoot) {
    const same = h.running.some((r) => r.root === h.pluginRoot);
    lines.push(
      `${pad("loaded from")}${h.pluginRoot}`
      + (h.pluginRootVersion ? ` (v${h.pluginRootVersion})` : "")
      + (same ? "" : " — not the tree the host is running"),
    );
  }

  return lines;
}

// ─────────────────────────────────────────────────────────
// Cache purge (the only writer here)
// ─────────────────────────────────────────────────────────

export interface CachePurgeOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * Trees that must survive — normally the plugin root the upgrade just wrote
   * new files into. Deleting that one would undo the upgrade it is part of and
   * pull the tree out from under the session that is running it.
   */
  keep?: readonly string[];
  /** Report what would go without removing anything. */
  dryRun?: boolean;
  /** `fs.rmSync` injection for tests that must not touch a real cache. */
  remove?: (path: string) => void;
}

export interface CachePurgeResult {
  /** The owner directory that was swept, when it could be resolved. */
  root?: string;
  /** Absolute paths removed (or, under `dryRun`, that would be). */
  removed: string[];
  /** Paths deliberately left alone, with the reason. */
  kept: { path: string; reason: string }[];
  /** Why nothing could be swept. */
  error?: string;
}

/** Is `candidate` the same directory as `other`, or does it contain it? */
function coversPath(candidate: string, other: string): boolean {
  return candidate === other || (other + sep).startsWith(candidate + sep);
}

/**
 * Delete the host's unpacked copies of *this plugin* so it re-extracts them.
 *
 * The cache key is the version number, so a wave that changes the tool surface
 * without moving the number leaves every installed user on the old unpacked
 * copy forever. Sweeping the cache is the other half of the fix: the version
 * bump makes the host want a new directory, and this makes sure no stale one
 * is left claiming to be current.
 *
 * Scope is deliberately narrow — only `<config>/plugins/cache/context-mode/**`,
 * only whole version directories, and only after each target has been proven
 * to sit inside that root. The tree named in `keep` is never touched.
 */
export function purgePluginCache(opts: CachePurgeOptions = {}): CachePurgeResult {
  const env = opts.env ?? process.env;
  const removed: string[] = [];
  const kept: { path: string; reason: string }[] = [];
  const remove = opts.remove ?? ((path: string) => rmSync(path, { recursive: true, force: true }));

  let root: string;
  try {
    root = resolvePluginCacheOwnerDir(env);
  } catch (err) {
    return { removed, kept, error: err instanceof Error ? err.message : String(err) };
  }

  // Both the path as written and where it actually points. Heal scripts leave
  // old version names symlinked at the surviving build, so a plugin root the
  // host reached through an alias would otherwise fail to protect the real
  // directory it resolves to — and the sweep would delete the tree in use.
  const keep = new Set<string>();
  for (const raw of opts.keep ?? []) {
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const abs = resolve(raw);
    keep.add(abs);
    try { keep.add(realpathSync(abs)); } catch { /* not on disk — the lexical form still counts */ }
  }
  const rootWithSep = root + sep;

  if (!existsSync(root)) return { root, removed, kept };

  // Two levels: <owner>/<plugin>/<version>. Walking both instead of removing
  // the owner directory wholesale keeps the surviving tree in place — an
  // upgrade that just wrote into <version> must not delete its own work.
  const pluginDirs: string[] = [];
  try {
    for (const name of readdirSync(root)) {
      const path = join(root, name);
      // lstat: a symlinked plugin directory is not walked into — following one
      // would put the sweep somewhere the containment check never approved.
      try { if (lstatSync(path).isDirectory()) pluginDirs.push(path); } catch { /* vanished */ }
    }
  } catch (err) {
    return { root, removed, kept, error: err instanceof Error ? err.message : String(err) };
  }

  for (const pluginDir of pluginDirs) {
    let versionDirs: string[] = [];
    try {
      versionDirs = readdirSync(pluginDir).map((n) => join(pluginDir, n));
    } catch { continue; }
    for (const versionDir of versionDirs) {
      // Directories and the symlinked version names heal scripts leave behind
      // both go: an alias pointing at a deleted build is the next boot's
      // MODULE_NOT_FOUND. `rmSync` unlinks a symlink rather than following it,
      // so removing an alias never reaches whatever it pointed at.
      try {
        const st = lstatSync(versionDir);
        if (!st.isDirectory() && !st.isSymbolicLink()) continue;
      } catch { continue; }
      // Lexical containment: nothing outside the plugin's own cache is ever a
      // deletion target, whatever a symlinked or crafted directory name says.
      if (!(versionDir + sep).startsWith(rootWithSep)) {
        kept.push({ path: versionDir, reason: "outside the plugin cache root" });
        continue;
      }
      let versionReal = versionDir;
      try { versionReal = realpathSync(versionDir); } catch { /* dangling alias — the name is all there is */ }
      const spared = [...keep].some((k) => coversPath(versionDir, k) || coversPath(versionReal, k));
      if (spared) {
        kept.push({ path: versionDir, reason: "in use by this session" });
        continue;
      }
      if (opts.dryRun) {
        removed.push(versionDir);
        continue;
      }
      try {
        remove(versionDir);
        removed.push(versionDir);
      } catch (err) {
        kept.push({ path: versionDir, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return { root, removed, kept };
}
