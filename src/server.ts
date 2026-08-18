#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { existsSync, unlinkSync, readdirSync, readFileSync, writeFileSync, writeSync, renameSync, rmSync, mkdirSync, cpSync, statSync, symlinkSync, lstatSync, realpathSync } from "node:fs";
import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import { join, dirname, resolve, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir, platform } from "node:os";
import { request as httpsRequest } from "node:https";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { PolyglotExecutor } from "./executor.js";
import { runPool, type PoolJob } from "./runPool.js";
import { ContentStore, cleanupStaleDBs, cleanupStaleContentDBs, contentRetentionDays, type SearchResult } from "./store.js";
import {
  readBashPolicies,
  evaluateCommandDenyOnly,
  extractShellCommands,
  readToolDenyPatterns,
  readToolPermissionPatterns,
  evaluateFilePath,
  evaluateProjectContainment,
} from "./security.js";
import {
  detectRuntimes,
  getRuntimeSummary,
  getAvailableLanguages,
  hasBunRuntime,
} from "./runtime.js";
import { classifyNonZeroExit } from "./exit-classify.js";
import { drainCodeIndexQueue, bootstrapCodeIndex, pruneDeletedCodeSources, pruneForeignCodeSources } from "./session/code-index.js";
import { drainSubagentQueue } from "./session/subagent-capture.js";
import { indexHostMemory } from "./session/host-memory.js";
import { searchAutoMemory } from "./search/auto-memory.js";
import {
  hybridSearch, vectorCoverage, getHybridTelemetry, chunkIdentity,
  type HybridDb, type LexicalResult,
} from "./search/hybrid.js";
import { resolveEmbeddingConfig } from "./search/embeddings.js";
import {
  formatCompletenessLine, formatEscalationBlock, type SearchCompleteness,
} from "./search/completeness.js";
import { CrossQueryDeduper } from "./search/dedup.js";
import { registerCtxSearch } from "./tools/search.js";
import { registerBatchTools } from "./tools/batch.js";
// classifyIp and classifyExtraction are injected into the fetch subprocess by
// buildFetchCode below, which is why they travel back across the tool boundary.
import { registerCtxFetch, classifyIp, classifyExtraction, isProxyAllowed } from "./tools/fetch.js";
import { registerOpsTools } from "./tools/ops.js";
import type { BatchToolDeps, FetchToolDeps, OpsToolDeps, ToolDeps, ToolResult as ToolDepsResult } from "./tools/shared/deps.js";
import {
  sessionStats,
  peekStore,
  setStore,
  detectedAdapter,
  setDetectedAdapter,
  claimStatsRollup,
} from "./tools/shared/state.js";
import { startLifecycleGuard, noteMcpActivity, noteRequestStart, noteRequestEnd, attachMcpActivityTap } from "./lifecycle.js";
import {
  describeStorageDirectorySource,
  ensureWritableStorageDir,
  formatStorageDirectoryError,
  hashProjectDirLegacy,
  resolveContentStorePath,
  resolveContentStorageDir,
  resolveDefaultSessionDir,
  resolveSessionDbPath,
  resolveSessionStorageDir,
  resolveStatsStorageDir,
  SessionDB,
  StorageDirectoryError,
} from "./session/db.js";
import { purgeSession } from "./session/purge.js";
import {
  emitIndexWriteEvent,
  emitSandboxExecuteEvent,
} from "./session/event-emit.js";
import { persistToolCallCounter, restoreSessionStats } from "./session/persist-tool-calls.js";
import { searchAllSources } from "./search/unified.js";
import {
  buildCtxSearchInputSchema,
  CTX_SEARCH_SHARED_MODE,
  resolveProjectScope,
} from "./search/ctx-search-schema.js";
import { FloodGuard } from "./search/flood-guard.js";
import { buildNodeCommand, type HookAdapter, type PlatformId, isInProcessPluginPlatform } from "./adapters/types.js";
import { detectPlatform, getSessionDirSegments } from "./adapters/detect.js";
import { CLIENT_NAME_TO_PLATFORM } from "./adapters/client-map.js";
import { parseCodexContextModePluginRoot } from "./adapters/codex/index.js";
import { getHookScriptPaths } from "./util/hook-config.js";
import { stripJsonComments } from "./util/jsonc.js";
import { resolveClaudeConfigDir } from "./util/claude-config.js";
import { resolveProjectDir } from "./util/project-dir.js";
import { loadDatabase } from "./db-base.js";
import { getLifetimeStats, pricePerToken } from "./session/analytics.js";
const __pkg_dir = dirname(fileURLToPath(import.meta.url));
const VERSION: string = (() => {
  for (const rel of ["../package.json", "./package.json"]) {
    const p = resolve(__pkg_dir, rel);
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, "utf8")).version; } catch {}
    }
  }
  return "unknown";
})();

function getPackageRoot(): string {
  return existsSync(resolve(__pkg_dir, "package.json")) ? __pkg_dir : dirname(__pkg_dir);
}

function resolveCodexRuntimePluginRoot(fallbackRoot: string): string {
  try {
    const probe = process.platform === "win32"
      ? spawnSync("cmd.exe", ["/d", "/s", "/c", "codex plugin list"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      })
      : spawnSync("codex", ["plugin", "list"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      });
    if (probe.status !== 0) return fallbackRoot;
    const runtimeRoot = parseCodexContextModePluginRoot(String(probe.stdout));
    if (runtimeRoot && existsSync(resolve(runtimeRoot, ".codex-plugin", "hooks.json"))) {
      return runtimeRoot;
    }
  } catch {
    // Best effort only. Non-Codex hosts and older Codex builds may not expose
    // plugin list; keep the package-root fallback for those environments.
  }
  return fallbackRoot;
}

function getRuntimeAwarePackageRoot(platformId?: PlatformId): string {
  const packageRoot = getPackageRoot();
  return platformId === "codex"
    ? resolveCodexRuntimePluginRoot(packageRoot)
    : packageRoot;
}

// Prevent silent MCP server death from unhandled async errors.
//
// Guarded for plugin-native OpenCode/Kilo imports (#574): when server.js is
// imported only to reuse the ctx_* tool registry, these handlers would become
// process-wide OpenCode/Kilo host handlers. In Node, adding an
// `uncaughtException` listener changes default crash behavior, so only the
// standalone MCP process may install them.
if (process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS !== "1") {
  process.on("unhandledRejection", (err) => {
    process.stderr.write(`[context-mode] unhandledRejection: ${err}\n`);
  });
  process.on("uncaughtException", (err) => {
    try {
      writeSync(2, `[context-mode] uncaughtException: ${err?.message ?? err}\n`);
    } finally {
      process.exit(1);
    }
  });
}

const runtimes = detectRuntimes();
const available = getAvailableLanguages(runtimes);
export const server = new McpServer({
  name: "context-mode",
  version: VERSION,
});

export interface RegisteredCtxTool {
  name: string;
  config: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
  /** Author-written verbose description, kept for the post-initialize upgrade. */
  fullDescription?: string;
  /** SDK handle from registerTool — carries update() on SDK ≥1.9. */
  registered?: { update?: (updates: Record<string, unknown>) => void };
}

export const REGISTERED_CTX_TOOLS: RegisteredCtxTool[] = [];

export function shouldSuppressMcpToolsForNativePluginHost(
  opts: { embedded?: string; platform?: PlatformId; settings?: Record<string, unknown> | null } = {},
): boolean {
  const embedded = opts.embedded ?? process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS;
  if (embedded === "1") return false;
  const platform = opts.platform ?? detectPlatform().platform;
  if (platform !== "opencode" && platform !== "kilo") return false;
  const settings = opts.settings ?? readNativePluginHostSettings(platform);
  return settingsHasContextModePlugin(settings) && settingsHasLegacyContextModeMcp(settings);
}

function readNativePluginHostSettings(platform: PlatformId): Record<string, unknown> | null {
  const base = platform === "kilo" ? "kilo" : "opencode";
  const paths = [
    resolve(`${base}.json`),
    resolve(`${base}.jsonc`),
    resolve(`.${base}`, `${base}.json`),
    resolve(`.${base}`, `${base}.jsonc`),
    join(homedir(), ".config", base, `${base}.json`),
    join(homedir(), ".config", base, `${base}.jsonc`),
  ];
  for (const p of paths) {
    try {
      if (!existsSync(p)) continue;
      return JSON.parse(stripJsonComments(readFileSync(p, "utf8"))) as Record<string, unknown>;
    } catch { /* try next config path */ }
  }
  return null;
}

function settingsHasContextModePlugin(settings: Record<string, unknown> | null | undefined): boolean {
  const plugins = settings?.plugin;
  return Array.isArray(plugins) && plugins.some((p) => typeof p === "string" && p.includes("context-mode"));
}

function settingsHasLegacyContextModeMcp(settings: Record<string, unknown> | null | undefined): boolean {
  const mcp = settings?.mcp;
  return !!(
    mcp &&
    typeof mcp === "object" &&
    !Array.isArray(mcp) &&
    Object.prototype.hasOwnProperty.call(mcp, "context-mode")
  );
}

const suppressMcpToolsForNativePluginHost = shouldSuppressMcpToolsForNativePluginHost();

/**
 * Issue #623 — surface why ctx_* tools/list is empty on suppressed legacy MCP
 * children. When a user upgrades OpenCode/Kilo from v1.0.136 → v1.0.137+ without
 * running `context-mode upgrade`, their opencode.json still has BOTH the legacy
 * mcp.context-mode block AND the plugin entry. The plugin path registers the
 * tools natively, but the legacy MCP child runs in parallel and used to expose
 * duplicate tools — v1.0.137 suppressed those duplicates. The suppression was
 * silent, leaving any MCP client that inspected the child via tools/list with
 * an empty list and no diagnostic. Emit one stderr line per process so an
 * operator running the child directly (or any non-plugin MCP host) sees the
 * exact reason and the `context-mode upgrade` fix.
 *
 * Exported for test (suppression-diagnostic regression guard).
 */
let __suppressionDiagnosticEmitted = false;
export function emitSuppressionDiagnostic(
  opts: { platform?: string; write?: (chunk: string) => void } = {},
): void {
  if (__suppressionDiagnosticEmitted) return;
  __suppressionDiagnosticEmitted = true;
  const write = opts.write ?? ((c: string) => { process.stderr.write(c); });
  const platform = opts.platform ?? "opencode/kilo";
  write(
    `[context-mode] ctx_* tools/list intentionally empty on this MCP child: ` +
    `legacy mcp.context-mode block coexists with plugin: ["context-mode"] in ` +
    `${platform}.json — plugin-native tools are the supported path (#623). ` +
    `Run \`context-mode upgrade\` to remove the legacy block (preserves other ` +
    `MCP servers).\n`
  );
}
/** Test-only: reset the one-shot emission flag so suites can re-exercise. */
export function __resetSuppressionDiagnosticForTests(): void {
  __suppressionDiagnosticEmitted = false;
}

/**
 * Issue #637 — register an explicit empty `tools/list` handler on the McpServer.
 *
 * Background: when `suppressMcpToolsForNativePluginHost` is true, every
 * `server.registerTool()` call is short-circuited (returns `undefined` above).
 * The MCP SDK only installs the SDK-default `tools/list` handler when at least
 * one `registerTool()` reaches `setToolRequestHandlers()` internally
 * (mcp.js:56-67). Suppressing every registration leaves `tools/list`
 * unregistered, and the framework's RPC layer answers it with
 * `-32601 "Method not found"`.
 *
 * The reporter of #637 (SquirrelRat) inspected the suppressed child via
 * `tools/list` and read the JSON-RPC error as "the plugin never registers any
 * ctx_* tools" — when in fact the plugin DOES register all 11 tools natively
 * (verified at `src/adapters/opencode/plugin.ts:469` and
 * `tests/opencode-plugin.test.ts:88`). The misleading -32601 is the seed of
 * the #637 perception.
 *
 * This helper installs an explicit handler that returns `{tools: []}` — a
 * spec-compliant empty list. Paired with the existing #623 stderr diagnostic,
 * an operator now sees:
 *   - wire response: `{tools: []}` (matches expectation, no JSON-RPC error)
 *   - stderr: `[context-mode] ctx_* tools/list intentionally empty… (#623)`
 *
 * Idempotent: throws inside SDK if called twice on the same server because
 * `assertCanSetRequestHandler` (mcp.js:60) rejects duplicate registrations;
 * we therefore install the SDK's default tool handlers FIRST (via a no-op
 * registerTool of a fake tool, immediately removed) only if needed. To keep
 * the public surface minimal, we just call `server.server.setRequestHandler`
 * directly — that is the same low-level call used for prompts/resources at
 * server.ts:259-261 and avoids the SDK guard entirely.
 *
 * Exported for test (#637 in-memory regression guard).
 */
export function registerEmptyToolsListHandler(target: McpServer = server): void {
  target.server.registerCapabilities({ tools: { listChanged: false } });
  target.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
}

/**
 * Compact tool descriptions (#1031).
 *
 * The verbose descriptions below are steering prose: they teach a cold model
 * when to reach for the sandbox instead of Bash. That teaching is not free —
 * the full set costs ~6K tokens of tool definitions on EVERY request, in a
 * project whose entire purpose is to not spend tokens on bytes the model does
 * not need. Once the routing block (SessionStart) and the project rules have
 * already said "think in code", most of that prose is a second copy.
 *
 * So the long form stays in the source as the reference, and this table is
 * what actually ships. `CONTEXT_MODE_TOOL_DESCRIPTIONS=full` restores the
 * verbose text for hosts that inject no routing block of their own.
 */
const COMPACT_TOOL_DESCRIPTIONS: Record<string, string> = {
  ctx_execute:
    "Run code in a separate subprocess (javascript, typescript, python, shell, ruby, go, rust, php, perl, r, elixir, csharp). " +
    "Only what you print enters the conversation — the data your code reads stays in the subprocess. " +
    "Use it to derive an answer FROM data (filter, count, parse, aggregate) instead of reading the raw bytes. " +
    "`background: true` keeps servers/daemons alive; `intent` auto-indexes large output for ctx_search instead of returning it. " +
    "File writes do NOT persist — use Write/Edit for those.",
  ctx_execute_file:
    "Read a file into a FILE_CONTENT variable in a separate subprocess and run code over it; only what you print enters the conversation. " +
    "Use when you need to KNOW something about a file (counts, matches, parsed structure) rather than SEE all of it. " +
    "Use the native Read tool instead when you intend to edit the file.",
  ctx_batch_execute:
    "Run multiple shell commands in one call; each output is auto-indexed, and `queries` returns the matching sections in the same round trip. " +
    "Use for 3+ related commands, or when the combined output is too large to read. " +
    "`concurrency` 2-8 parallelizes I/O-bound work; keep it at 1 for CPU-bound or stateful commands. " +
    "Raw output is never echoed in full — only matched windows. See ctx_gather for a read-only variant.",
  ctx_search:
    "Search the knowledge base (indexed content + auto-captured session memory) with stemming + trigram matching, fused and reranked. " +
    "Batch every question into one `queries` array. `source` scopes to one label, `sort: \"timeline\"` gives chronological recall across sessions, " +
    "`project: \"global\"` spans all projects. Returns window-extracted snippets, not whole documents.",
  ctx_index:
    "Store content in the searchable knowledge base (FTS5/BM25). Markdown splits by heading, code keeps its blocks. " +
    "Use for content you want to recall later without re-reading the source; `file_path` enables staleness detection.",
  ctx_fetch_and_index:
    "Fetch URL(s), convert to markdown, index them, and return only the section list — raw page bytes never enter the conversation. " +
    "Follow with ctx_search to read what matters. Accepts `url` or `requests: [{url, source}]` with `concurrency` 1-8. " +
    "Full network access; retry once on transient DNS errors (EAI_AGAIN, ETIMEDOUT, ENETUNREACH).",
  ctx_gather:
    "Read-only ctx_batch_execute: inspection commands only (cat/ls/grep/find/jq, git log|show|diff|status, docker ps, kubectl get, npm ls). " +
    "Refuses redirections, command substitution, sudo, and unknown binaries. Use it to gather context in plan mode.",
};

/**
 * @returns The description that should ship for `name` — compact by default,
 *   the author-written verbose text when the operator asks for it.
 */
export function resolveToolDescription(name: string, full: unknown): unknown {
  if (process.env.CONTEXT_MODE_TOOL_DESCRIPTIONS === "full") return full;
  return COMPACT_TOOL_DESCRIPTIONS[name] ?? full;
}

/**
 * Should this client get the FULL descriptions after the handshake?
 *
 * The compact/full trade-off flips when the host defers tool schemas: Claude
 * Code's tool-search releases (≥2.1, `ENABLE_TOOL_SEARCH` unset or on) no
 * longer ship MCP tool definitions in every request — the model loads a
 * schema once, on demand. Under that regime the verbose author-written text
 * costs nothing per request and teaches more, so serving compact would be
 * saving tokens that were never being spent.
 *
 * Registration happens before the MCP handshake, so tools always register
 * compact; `upgradeToolDescriptionsForClient` swaps in the full text from
 * `oninitialized` — after the client identified itself, before its
 * tools/list. Env contract:
 *   - `full`    → full from registration (unchanged upstream behaviour);
 *   - `compact` → pinned compact, never upgraded;
 *   - unset / `auto` → compact, upgraded for schema-deferring hosts.
 */
export function shouldServeFullDescriptions(
  clientInfo: { name?: string; version?: string } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const mode = env.CONTEXT_MODE_TOOL_DESCRIPTIONS;
  if (mode === "full") return true;
  if (mode !== undefined && mode !== "" && mode !== "auto") return false;
  // The host inherits ENABLE_TOOL_SEARCH from settings env; `false` is the
  // only value that disables deferral outright.
  if (env.ENABLE_TOOL_SEARCH === "false") return false;
  if (!clientInfo?.name || !clientInfo.version) return false;
  // Consult the clientInfo→platform map directly, NOT detectPlatform: that
  // helper falls back to env sniffing for unknown names, which would claim
  // "claude-code" for any host merely launched from a Claude Code shell.
  if (CLIENT_NAME_TO_PLATFORM[clientInfo.name] !== "claude-code") return false;
  return versionAtLeast(clientInfo.version, [2, 1, 0]);
}

function versionAtLeast(version: string, min: [number, number, number]): boolean {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let i = 0; i < 3; i++) {
    if (parts[i] > min[i]) return true;
    if (parts[i] < min[i]) return false;
  }
  return true;
}

/**
 * Swap every registered tool's description for the author-written full text
 * when the connected client defers schemas (see shouldServeFullDescriptions).
 *
 * @returns Number of descriptions upgraded.
 */
export function upgradeToolDescriptionsForClient(): number {
  const clientInfo = server.server.getClientVersion();
  if (!shouldServeFullDescriptions(clientInfo ?? undefined)) return 0;
  let upgraded = 0;
  for (const tool of REGISTERED_CTX_TOOLS) {
    if (!tool.fullDescription || typeof tool.registered?.update !== "function") continue;
    if (tool.config.description === tool.fullDescription) continue;
    try {
      tool.registered.update({ description: tool.fullDescription });
      tool.config.description = tool.fullDescription;
      upgraded++;
    } catch { /* an SDK without update() keeps compact — still correct */ }
  }
  return upgraded;
}

const originalRegisterTool = server.registerTool.bind(server);
(server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (...args: unknown[]) => {
  const [name, config, handler] = args as [
    string,
    Record<string, unknown>,
    (toolArgs: Record<string, unknown>) => Promise<unknown> | unknown,
  ];
  if (suppressMcpToolsForNativePluginHost) {
    emitSuppressionDiagnostic();
    return undefined;
  }
  let fullDescription: string | undefined;
  if (config && typeof config === "object" && "description" in config) {
    if (typeof config.description === "string") fullDescription = config.description;
    config.description = resolveToolDescription(name, config.description);
  }
  const wrappedHandler = wrapToolHandler(name, handler);
  const entry: RegisteredCtxTool = { name, config, handler: wrappedHandler, fullDescription };
  REGISTERED_CTX_TOOLS.push(entry);
  args[2] = wrappedHandler;
  const registered = (originalRegisterTool as unknown as (...callArgs: unknown[]) => unknown)(...args);
  if (registered && typeof registered === "object") {
    entry.registered = registered as RegisteredCtxTool["registered"];
  }
  return registered;
};

function wrapToolHandler(
  name: string,
  handler: (toolArgs: Record<string, unknown>) => Promise<unknown> | unknown,
): (toolArgs: Record<string, unknown>) => Promise<unknown> {
  return async (toolArgs: Record<string, unknown>) => {
    // #854: mark a tool call in-flight so the bridge-child idle reaper never
    // shuts the server down mid-execution during a long ctx_execute/batch that
    // emits no further inbound messages. Symmetric end in finally (success+error).
    noteRequestStart();
    try {
      return await handler(toolArgs);
    } catch (err) {
      const result = storageErrorResult(err);
      if (result) {
        try {
          return trackResponse(name, result);
        } catch (trackErr) {
          if (trackErr instanceof StorageDirectoryError) return result;
          throw trackErr;
        }
      }
      throw err;
    } finally {
      noteRequestEnd();
    }
  };
}

// Issue #637 — when suppression is active, install the empty tools/list handler
// once at module-init time so the suppressed MCP child responds with
// `{tools: []}` instead of JSON-RPC `-32601 Method not found`. Pair with the
// #623 stderr diagnostic that explains WHY the list is empty. Skipped for the
// embedded plugin-import path because the embedded process is not the stdio
// MCP child an operator would inspect — it lives inside the OpenCode/Kilo
// host and never speaks JSON-RPC over stdio.
if (suppressMcpToolsForNativePluginHost && process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS !== "1") {
  registerEmptyToolsListHandler(server);
}

type ToolContextOverride = { projectDir: string; sessionId?: string };
const projectDirOverride = new AsyncLocalStorage<ToolContextOverride>();

export async function withProjectDirOverride<T>(
  projectDir: string | ToolContextOverride,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx = typeof projectDir === "string" ? { projectDir } : projectDir;
  return projectDirOverride.run(ctx, fn);
}

// Register empty prompts/resources handlers so MCP clients don't get -32601 (#168).
// OpenCode calls listPrompts()/listResources() unconditionally — the error can poison
// the SDK transport layer, causing subsequent listTools() calls to fail permanently.
import { ListPromptsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
server.server.registerCapabilities({ prompts: { listChanged: false }, resources: { listChanged: false } });
server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));

// ── Strict-client (Gemini function-calling) schema compatibility ──────────────
// Gemini's function-calling API — used by Antigravity CLI (`agy`) and Gemini CLI
// — rejects JSON Schema `const` and `additionalProperties`. A rejected parameter
// schema makes the host SILENTLY DROP that tool from the model's function list,
// so the agent never sees our ctx_* tools and falls back to hand-rolling the MCP
// protocol through its Bash tool. Sanitize the EMITTED tools/list schema:
//   • `const: X`  →  `enum: [X]`   — an identical single-value constraint
//   • drop `additionalProperties`  — advisory only; every ctx_* handler parses
//     args with Zod (which strips unknown keys server-side), so removing it
//     changes no validation and no call behavior.
// Both transforms are behavior-preserving for every other client (Claude Code,
// Copilot, Cursor, …): `const` and a one-value `enum` are equivalent, and no
// model sends undeclared properties. Only the wire schema changes — never
// validation or how any tool is invoked.
export function sanitizeSchemaForStrictClients(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeSchemaForStrictClients);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "additionalProperties") continue;
    if (key === "const") {
      out.enum = [value];
      continue;
    }
    out[key] = sanitizeSchemaForStrictClients(value);
  }
  return out;
}

// Wrap the SDK-installed tools/list handler so its generated schemas pass through
// the sanitizer above. Best-effort by design: if the MCP SDK's internals shift,
// the original handler is left untouched (no regression — strict clients stay as
// they were, every other client unaffected). Must run AFTER all registerTool()
// calls so the SDK's default tools/list handler already exists.
export function installStrictClientSchemaCompat(target: McpServer = server): void {
  try {
    const low = target.server as unknown as {
      _requestHandlers?: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
    };
    const original = low._requestHandlers?.get("tools/list");
    if (typeof original !== "function") return;
    target.server.setRequestHandler(ListToolsRequestSchema, async (req, extra) => {
      const result = (await original(req as unknown, extra as unknown)) as
        | { tools?: Array<{ inputSchema?: unknown }> }
        | undefined;
      if (result && Array.isArray(result.tools)) {
        for (const tool of result.tools) {
          if (!tool || tool.inputSchema == null) continue;
          try {
            tool.inputSchema = sanitizeSchemaForStrictClients(tool.inputSchema);
          } catch {
            /* leave this tool's schema unchanged */
          }
        }
      }
      return result as never;
    });
  } catch {
    /* best-effort — never break tools/list */
  }
}

const executor = new PolyglotExecutor({
  runtimes,
  projectRoot: () => getProjectDir(),
});

// ─────────────────────────────────────────────────────────
// FS read tracking preload for ctx_batch_execute
// ─────────────────────────────────────────────────────────
// NODE_OPTIONS is denied by the executor's #buildSafeEnv (security).
// Instead, we inject it as an inline shell env prefix in each batch command.
// This temp file is loaded via --require when batch commands spawn Node processes.
const CM_FS_PRELOAD = join(tmpdir(), `cm-fs-preload-${process.pid}.js`);
writeFileSync(
  CM_FS_PRELOAD,
  `(function(){var __cm_fs=0;process.on('exit',function(){if(__cm_fs>0)try{process.stderr.write('__CM_FS__:'+__cm_fs+'\\n')}catch(e){}});try{var f=require('fs');var ors=f.readFileSync;f.readFileSync=function(){var r=ors.apply(this,arguments);if(Buffer.isBuffer(r))__cm_fs+=r.length;else if(typeof r==='string')__cm_fs+=Buffer.byteLength(r);return r;};}catch(e){}})();\n`,
);
// In the stdio MCP path, main() also removes this file during graceful
// shutdown. Plugin-native OpenCode/Kilo imports skip main() (#574), so
// register a top-level best-effort cleanup too to avoid leaking preload
// snippets under /tmp when the host process exits.
process.on("exit", () => { try { unlinkSync(CM_FS_PRELOAD); } catch { /* best effort */ } });

// The lazy store singleton itself lives in ./tools/shared/state.ts so the tool
// modules can reach it without importing this file back. Its lifecycle —
// opening it at the right path, wiring the deny checker, draining the capture
// queues — stays here, in getStore() below.

/**
 * Build the FK-attribution object passed to every ContentStore.index*() call
 * in this process. CLAUDE_SESSION_ID is the only MCP-side handle we have on
 * the current session — eventId stays undefined because MCP tool invocations
 * are not paired with PostToolUse event rows at index time (the hook fires
 * AFTER the tool returns). Empty-string fallback inside #insertChunks keeps
 * legacy unattributed rows readable.
 */
export function currentAttribution(): { sessionId?: string } | undefined {
  const override = projectDirOverride.getStore();
  if (override?.sessionId) return { sessionId: override.sessionId };

  // CLAUDE_SESSION_ID env var is NOT propagated to MCP servers (only to hooks).
  // Cross-adapter resolution: every adapter (15 of them) sets *_PROJECT_DIR env
  // and writes session_events via hooks. Read the most-recent session_id from
  // THIS project's session DB. Works for claude-code/cursor/gemini-cli/codex/
  // kiro/opencode/zed/kilo/openclaw/qwen-code/vscode-copilot/jetbrains-copilot/
  // omp/pi/antigravity — no adapter-specific transcript path required.
  const sessionId = process.env.CLAUDE_SESSION_ID ?? resolveSessionIdFromSessionDB();
  if (!sessionId) return undefined;
  return { sessionId };
}

let __cachedSessionId: { sid: string; checkedAt: number } | undefined;
/** v1.0.134 SLICE A: opts injection for testability. Production callers pass nothing. */
export function resolveSessionIdFromSessionDB(opts?: {
  projectDir?: string;
  sessionsDir?: string;
  bypassCache?: boolean;
}): string | undefined {
  // 2s cache — ctx_fetch_and_index can fire 5+ chunks/sec; DB open cost adds up.
  const now = Date.now();
  if (!opts?.bypassCache && __cachedSessionId && now - __cachedSessionId.checkedAt < 2000) {
    return __cachedSessionId.sid;
  }
  try {
    const projectDir = opts?.projectDir
      ?? process.env.CLAUDE_PROJECT_DIR
      ?? process.env.CONTEXT_MODE_PROJECT_DIR;
    if (!projectDir) return undefined;
    const sessionsDir = opts?.sessionsDir ?? getSessionDir();
    const dbPath = resolveSessionDbPath({ projectDir, sessionsDir });
    if (!existsSync(dbPath)) return undefined;
    const Database = loadDatabase();
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare(
        "SELECT session_id FROM session_events ORDER BY created_at DESC LIMIT 1"
      ).get() as { session_id?: string } | undefined;
      const sid = row?.session_id;
      if (sid) __cachedSessionId = { sid, checkedAt: now };
      return sid;
    } finally {
      try { db.close(); } catch { /* best-effort */ }
    }
  } catch {
    return undefined;
  }
}

/**
 * Auto-index session events files written by SessionStart hook.
 * Scans ~/.claude/context-mode/sessions/ for *-events.md files.
 * CLAUDE_PROJECT_DIR is NOT available to MCP servers — only to hooks —
 * so we glob-scan instead of computing a specific hash.
 * Files are consumed (deleted) after indexing to prevent double-indexing.
 * Called on every getStore() — readdirSync is sub-millisecond when no files match.
 */
function maybeIndexSessionEvents(store: ContentStore): void {
  try {
    const sessionsDir = getSessionDir();
    if (!existsSync(sessionsDir)) return;
    const files = readdirSync(sessionsDir).filter(f => f.endsWith("-events.md"));
    for (const file of files) {
      const filePath = join(sessionsDir, file);
      try {
        store.index({ path: filePath, source: "session-events", attribution: currentAttribution() });
        unlinkSync(filePath);
      } catch { /* best-effort per file */ }
    }
  } catch { /* best-effort — session continuity never blocks tools */ }
}

// ── Platform-aware paths ──────────────────────────────────────────────────
// The adapter (stored after MCP handshake) is the canonical source for
// platform-specific paths. All session DB paths go through it — no
// hardcoded configDir detection in tool handlers. The cell itself lives in
// ./tools/shared/state.ts; read it with detectedAdapter().

/**
 * Resolve the Claude Code config root, honoring `CLAUDE_CONFIG_DIR` (incl.
 * leading `~`) before falling back to `~/.claude`. Mirrors
 * `hooks/session-helpers.mjs::resolveConfigDir` and
 * `ClaudeCodeAdapter.getConfigDir` so the pre-detection path agrees with
 * hooks/adapter on where Claude Code session data lives. See issue #453.
 *
 * Issue #460 round-3: delegates to the canonical util so empty/whitespace
 * env values fall back instead of poisoning downstream `join()` calls.
 */
async function getDiagnosticAdapter(): Promise<HookAdapter | null> {
  const detected = detectedAdapter();
  if (detected) return detected;
  try {
    const { getAdapter } = await import("./adapters/detect.js");
    const signal = detectPlatform();
    return await getAdapter(signal.platform);
  } catch {
    return null;
  }
}

/**
 * Get the platform-specific sessions directory from the detected adapter.
 * Falls back to the detected platform config root before adapter detection.
 */
function getDefaultSessionDir(): string {
  const detected = detectedAdapter();
  if (detected) return detected.getSessionDir();
  // Pre-detection path (race window before MCP `initialize` completes):
  // call detectPlatform() (sync, env-var-based) and look up segments via
  // getSessionDirSegments() (sync map, no adapter instantiation). This keeps
  // non-Claude platforms from spilling sessions into ~/.claude/. For Claude
  // Code/Codex (single-segment roots), reroute through their config-dir
  // contracts so the pre-detection window does not split-state with hooks.
  try {
    const signal = detectPlatform();
    const segments = getSessionDirSegments(signal.platform);
    if (segments) {
      return resolveDefaultSessionDir({
        configDir: join(...segments),
        configDirEnv: configDirEnvForSessionSegments(segments),
      });
    }
  } catch { /* fall through to claude fallback */ }
  return resolveDefaultSessionDir({ configDir: ".claude", configDirEnv: "CLAUDE_CONFIG_DIR" });
}

function configDirEnvForSessionSegments(segments: string[]): string | undefined {
  if (segments.length === 1 && segments[0] === ".claude") return "CLAUDE_CONFIG_DIR";
  if (segments.length === 1 && segments[0] === ".codex") return "CODEX_HOME";
  return undefined;
}

function getSessionDir(): string {
  return ensureWritableStorageDir(resolveSessionStorageDir(getDefaultSessionDir));
}

/**
 * Project directory detection across supported platforms.
 *
 * Priority:
 *   1. Platform-specific env var (set by host IDE before MCP server spawn)
 *   2. CONTEXT_MODE_PROJECT_DIR (set by start.mjs for ALL platforms — universal)
 *   3. process.cwd() (last resort)
 *
 * CONTEXT_MODE_PROJECT_DIR guarantees correct projectDir even for platforms
 * that don't set their own env var (Cursor, OpenClaw, Codex, Kiro, Zed).
 */
export function getProjectDir(): string {
  const override = projectDirOverride.getStore();
  if (override) return override.projectDir;

  // Delegated to the shared resolver so the env-var chain rejects plugin
  // install paths (set by a prior MCP boot's start.mjs after `/ctx-upgrade`)
  // and prefers the shell-set PWD before the chdir'd cwd. v1.0.115 adds
  // the Claude Code transcript heuristic — read `cwd` from the most-recently-
  // modified `~/.claude/projects/<encoded>/<session>.jsonl` to recover the
  // real project dir when MCP was launched from a non-project cwd (desktop-
  // app launch, /ctx-upgrade respawn). See src/util/project-dir.ts.
  //
  // Issue #521 (v1.0.119): the transcript heuristic ONLY applies on Claude
  // Code. Other platforms (Cursor, OpenCode, Codex, ...) either have no
  // transcript at that path or use a different schema without `cwd`. Worse,
  // a Cursor user who also runs Claude Code would pick up the most-recently-
  // modified Claude Code session's cwd — wrong project entirely. Gate the
  // path on detected platform so non-Claude hosts skip the heuristic and
  // fall through to PWD/cwd cleanly.
  //
  // The Claude heuristic must also be fresh. Hosts such as Pi can be
  // misdetected as Claude Code solely because ~/.claude exists; without a
  // freshness guard an old Claude transcript can globally hijack ctx shell cwd
  // after reboot. Active Claude sessions update their transcript as the user
  // interacts, so stale transcripts should fall through to PWD/cwd.
  //
  // Issue #545 (v1.0.124): pass strictPlatform for ALL adapters so the
  // env-var cascade is built ALGORITHMICALLY from the platform's own
  // workspace vars + universal escape hatch — foreign workspace vars (e.g.
  // CLAUDE_PROJECT_DIR leaked into Pi's MCP child env from the user's shell)
  // cannot win, regardless of cascade order. start.mjs intentionally does
  // NOT pass strictPlatform — host detection is unreliable at the entrypoint
  // and the legacy literal cascade is preserved there for semver safety.
  let transcriptsRoot: string | undefined;
  let strictPlatform: PlatformId | undefined;
  let codexHome: string | undefined;
  try {
    const detected = detectPlatform().platform;
    strictPlatform = detected;
    if (detected === "claude-code") {
      transcriptsRoot = join(homedir(), ".claude", "projects");
    }
    // Issue #45 — Codex publishes no workspace env var, so the resolver
    // reads `meta.cwd` from the most-recently-modified session.jsonl under
    // `${codexHome}/sessions/`. Wire codexHome at the call site so the
    // resolver can be exercised under test without process-level mutation.
    if (detected === "codex") {
      codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    }
  } catch { /* detection failure — leave undefined, resolver uses legacy cascade */ }
  return resolveProjectDir({
    env: process.env,
    cwd: process.cwd(),
    pwd: process.env.PWD,
    transcriptsRoot,
    transcriptMaxAgeMs: 5 * 60 * 1000,
    strictPlatform,
    codexHome,
  });
}

/**
 * Resolve a possibly-relative path against the project directory (full env cascade),
 * not the MCP server's process.cwd(). MCP server is spawned by the host and its cwd
 * is unrelated to where the user is working.
 */
function resolveProjectPath(filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(getProjectDir(), filePath);
}

/**
 * Resolve the per-project SessionDB path. Delegates to
 * {@link resolveSessionDbPath} so casing-only variants of the same
 * physical worktree on macOS / Windows hit ONE DB, not two — and any
 * pre-existing legacy raw-casing DB gets migrated in place on first
 * resolve. Linux is a no-op.
 */
function getSessionDbPath(): string {
  return resolveSessionDbPath({
    projectDir: getProjectDir(),
    sessionsDir: getSessionDir(),
  });
}

/**
 * Compute a per-project, per-platform persistent path for the ContentStore.
 * Derives content dir from the adapter's session dir so each platform
 * has its own isolated FTS5 DB — no cross-platform data sharing.
 *
 * Layout: ~/<configDir>/context-mode/content/<hash>.db
 *   e.g.  ~/.claude/context-mode/content/87c28c41ddb64d38.db
 *         ~/.cursor/context-mode/content/87c28c41ddb64d38.db
 */
function getStorePath(): string {
  const dir = ensureWritableStorageDir(resolveContentStorageDir(getDefaultSessionDir));
  // Delegate to resolveContentStorePath: same case-fold + one-shot legacy
  // rename behavior as resolveSessionDbPath. On macOS / Windows, an
  // existing legacy raw-casing FTS5 db (with -wal/-shm sidecars) is
  // migrated in place on first call. On Linux it's a no-op.
  return resolveContentStorePath({ projectDir: getProjectDir(), contentDir: dir });
}

function getStore(): ContentStore {
  let store = peekStore();
  if (!store) {
    // Content DB cleanup on fresh start is handled by SessionStart hook.
    // Server just opens whatever DB exists (or creates new if hook deleted it).
    const dbPath = getStorePath();
    store = new ContentStore(dbPath);
    setStore(store);

    // Wire deny-policy hook: store re-checks the Read deny list before
    // re-reading any file_path during auto-refresh. Catches policy edits
    // made after a file was originally indexed. See #442 round-3.
    store.setDenyChecker((filePath: string) => {
      try {
        const projectDir = getProjectDir();
        const denyGlobs = readToolDenyPatterns("Read", projectDir);
        const r = evaluateFilePath(
          filePath,
          denyGlobs,
          process.platform === "win32",
          projectDir,
        );
        return r.denied;
      } catch {
        // Fail-closed for refresh: skip on error rather than re-read.
        return true;
      }
    });

    // One-time startup cleanup: remove stale content DBs (>14 days by default,
    // CONTEXT_MODE_CONTENT_RETENTION_DAYS overrides).
    try {
      const contentDir = dirname(getStorePath());
      const retentionDays = contentRetentionDays();
      cleanupStaleContentDBs(contentDir, retentionDays);
      store.cleanupStaleSources(retentionDays);
      // Also clean legacy shared dir from before platform isolation
      const legacyDir = join(homedir(), ".context-mode", "content");
      if (existsSync(legacyDir)) cleanupStaleContentDBs(legacyDir, 0);
      // Retire per-session stats files nobody has written to in weeks. Every
      // ctx_stats call reads all of them; on this machine that was 735 files.
      if (claimStatsRollup()) {
        rollUpStaleStatsFiles(dirname(getStatsFilePath()));
      }
    } catch { /* best-effort */ }

    // Also clean old PID-based DBs from migration
    cleanupStaleDBs();
  }
  maybeIndexSessionEvents(store);
  maybeIndexEditedFiles(store);
  maybeIndexSubagentCaptures(store);
  maybeIndexHostMemory(store);
  return store;
}

/**
 * Drain the SubagentStop capture queue into the store (see
 * src/session/subagent-capture.ts). A subagent's context dies with the
 * subagent; this indexes a digest of its transcript so ctx_search can still
 * answer from what it saw. Opt out with CONTEXT_MODE_SUBAGENT_CAPTURE=0.
 */
function maybeIndexSubagentCaptures(store: ContentStore): void {
  if (process.env.CONTEXT_MODE_SUBAGENT_CAPTURE === "0") return;
  try {
    drainSubagentQueue({ store, sessionsDir: getSessionDir(), projectDir: getProjectDir() });
  } catch { /* best-effort — capture never blocks a tool call */ }
}

/**
 * Index the host's curated memory files into the store (see
 * src/session/host-memory.ts). Runs once per server process — the store
 * singleton is memoized, so this fires on first tool call and not again.
 * Opt out with CONTEXT_MODE_INDEX_HOST_MEMORY=0.
 */
function maybeIndexHostMemory(store: ContentStore): void {
  if (process.env.CONTEXT_MODE_INDEX_HOST_MEMORY === "0") return;
  try {
    indexHostMemory({
      store,
      configDir: detectedAdapter()?.getConfigDir() ?? resolveClaudeConfigDir(),
      projectDir: getProjectDir(),
      attribution: currentAttribution(),
    });
  } catch { /* best-effort — memory indexing never blocks a tool call */ }
}

/**
 * Drain the PostToolUse code-index queue into the store (see
 * src/session/code-index.ts). Opt out with CONTEXT_MODE_CODE_INDEX=0.
 *
 * Three passes, in the order that keeps the index honest: seed the project's
 * tracked files once so a fresh session is not searching an empty index, evict
 * sources whose file is gone so nothing stale answers, then index the edits.
 * Seeding and pruning run once per server process (the store is memoized).
 */
function maybeIndexEditedFiles(store: ContentStore): void {
  if (process.env.CONTEXT_MODE_CODE_INDEX === "0") return;
  const sessionsDir = getSessionDir();
  const projectDir = getProjectDir();
  const attribution = currentAttribution();

  if (process.env.CONTEXT_MODE_CODE_INDEX_BOOTSTRAP !== "0") {
    try {
      const rawBatch = Number.parseInt(process.env.CONTEXT_MODE_CODE_INDEX_BOOTSTRAP_BATCH ?? "", 10);
      bootstrapCodeIndex({
        store, sessionsDir, projectDir, attribution,
        ...(Number.isFinite(rawBatch) && rawBatch > 0 ? { batchSize: rawBatch } : {}),
      });
    } catch { /* best-effort — seeding never blocks a tool call */ }
  }
  try {
    pruneDeletedCodeSources({ store, projectDir });
    // One-off repair for what the shared queue leaked before drains were
    // project-scoped: other repositories' files indexed into this store.
    pruneForeignCodeSources({ store, projectDir });
  } catch { /* best-effort */ }

  try {
    drainCodeIndexQueue({
      store,
      sessionsDir,
      projectDir,
      attribution,
    });
  } catch { /* best-effort — indexing never blocks a tool call */ }
}

/**
 * What ctx_stats should say about the state of the semantic index.
 *
 * Three states, three different truths. The line this replaces claimed
 * "backfill runs in the background on every search" at every coverage level,
 * including zero — where it is false twice over: with no embedder configured
 * there is no backfill at all, and even with one, waiting for the per-search
 * batch is not a plan (a 1,320-chunk index needs roughly 83 searches).
 *
 * Pure, so the wording is testable without a store.
 *
 * @param configuredModel Model from the embedding config, or undefined when no
 *   embedder is configured.
 */
export function semanticCoverageAdvice(
  coverage: { chunks: number; vectors: number },
  configuredModel?: string,
): string[] {
  if (coverage.vectors === 0) {
    return [
      "  Hybrid search is INACTIVE — every query is lexical-only.",
      configuredModel
        ? `  Embedder configured (${configuredModel}) but nothing is embedded yet. Run \`context-mode drain\` to warm the index in one pass.`
        : "  Set CONTEXT_MODE_EMBEDDINGS_URL (e.g. a local Ollama at http://127.0.0.1:11434) and CONTEXT_MODE_EMBEDDINGS_MODEL, then run `context-mode drain`.",
    ];
  }
  if (coverage.vectors < coverage.chunks) {
    return [
      "  Warm-up is incremental: a small batch after each search, plus a longer pass at session end. " +
      "Run `context-mode drain` to finish it now; uncovered chunks stay lexical-only until then.",
    ];
  }
  return [];
}

/**
 * The semantic layer's own status line for ctx_stats.
 *
 * "Hybrid search is configured" and "hybrid search can answer" are different
 * states: a cold index degrades silently to lexical, which looks exactly like
 * working. Printing coverage plus how often fusion actually changed a ranking
 * makes both the warm-up and the payoff visible — and answers the only
 * question worth asking about an optional side-car: is it earning its latency?
 *
 * @returns A report block, or "" when there is nothing to say.
 */
function semanticIndexReport(): string {
  try {
    const coverage = vectorCoverage(getStore().rawDb() as unknown as HybridDb);
    const configured = resolveEmbeddingConfig();
    if (coverage.vectors === 0 && !configured) return "";

    const pct = coverage.chunks > 0
      ? Math.min(100, Math.round((coverage.vectors / coverage.chunks) * 100))
      : 0;
    const model = coverage.models[0] ?? configured?.model ?? "unknown";
    const mb = coverage.bytes >= 1024 * 1024
      ? `${(coverage.bytes / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.round(coverage.bytes / 1024)} KB`;

    const out: string[] = ["", "  ─── Semantic index (hybrid search) ───", ""];
    out.push(
      `  Embedded: ${coverage.vectors.toLocaleString()} of ${coverage.chunks.toLocaleString()} chunks (${pct}%) · ${model} · ${mb}`,
    );
    out.push(...semanticCoverageAdvice(coverage, configured?.model));
    const t = getHybridTelemetry();
    if (t.searches > 0) {
      out.push(
        `  This session: ${t.searches} semantic pass${t.searches === 1 ? "" : "es"}, ` +
        `${t.withCandidates} returned neighbours, ${t.changedRanking} changed the ranking.`,
      );
    }
    if (coverage.models.length > 1) {
      out.push(`  Mixed models present (${coverage.models.join(", ")}) — stale vectors are evicted on next backfill.`);
    }
    return out.join("\n") + "\n";
  } catch {
    return "";
  }
}

// ─────────────────────────────────────────────────────────
// Session stats — track context consumption per tool
// ─────────────────────────────────────────────────────────
// The counters live in ./tools/shared/state.ts. ctx_batch_execute adds to
// bytesSandboxed from its own module, and there must be exactly one object:
// two copies would each report half of what the session actually did.

// One definition, shared with the extracted tool modules — see deps.ts for why
// it carries an index signature.
type ToolResult = ToolDepsResult;

function storageErrorResult(err: unknown): ToolResult | null {
  if (!(err instanceof StorageDirectoryError)) return null;
  return {
    content: [{ type: "text", text: formatStorageDirectoryError(err) }],
    isError: true,
  };
}
// ── Version outdated warning ──────────────────────────────────────────────
// Non-blocking npm check at startup. trackResponse prepends warning
// using a burst cadence: 3 warnings → 1h silent → 3 warnings → repeat.

let _latestVersion: string | null = null;
let _warningBurstCount = 0;
let _lastBurstStart = 0;
const VERSION_BURST_SIZE = 3;
const VERSION_SILENT_MS = 60 * 60 * 1000; // 1 hour

async function fetchLatestVersion(): Promise<string> {
  return new Promise((res) => {
    const req = httpsRequest(
      "https://registry.npmjs.org/context-mode/latest",
      { headers: { Connection: "close" } },
      (resp) => {
        let raw = "";
        resp.on("data", (chunk: Buffer) => { raw += chunk; });
        resp.on("end", () => {
          try {
            const data = JSON.parse(raw) as { version?: string };
            res(data.version ?? "unknown");
          } catch { res("unknown"); }
        });
      },
    );
    req.on("error", () => res("unknown"));
    req.setTimeout(5000, () => { req.destroy(); res("unknown"); });
    req.end();
  });
}

function getUpgradeHint(): string {
  const name = detectedAdapter()?.name;
  if (name === "Claude Code") return "/ctx-upgrade";
  if (name === "OpenClaw") return "npm run install:openclaw";
  if (name === "Pi") return "npm run build";
  return "npm update -g context-mode";
}

function semverNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

function isOutdated(): boolean {
  if (!_latestVersion || _latestVersion === "unknown") return false;
  return semverNewer(_latestVersion, VERSION);
}

function shouldShowVersionWarning(): boolean {
  if (!isOutdated()) return false;
  const now = Date.now();
  // Start of a new burst?
  if (_warningBurstCount >= VERSION_BURST_SIZE) {
    if (now - _lastBurstStart < VERSION_SILENT_MS) return false; // still silent
    _warningBurstCount = 0; // silence over, reset burst
  }
  if (_warningBurstCount === 0) _lastBurstStart = now;
  _warningBurstCount++;
  return true;
}

// ── Self-heal Layer 2: Mid-session registry heal (anthropics/claude-code#46915) ──
// Runs once on first tool call. If Claude Code auto-updated the registry mid-session,
// hooks break because CLAUDE_PLUGIN_ROOT points to a deleted directory. We create a
// symlink from the broken path to our actual directory so hooks recover.
let _cacheHealDone = false;
function healCacheMidSession(): void {
  if (_cacheHealDone) return;
  _cacheHealDone = true;
  try {
    // Issue #460 round-3: honor $CLAUDE_CONFIG_DIR so users who relocate
    // their CC config root don't have plugin cache healing operate against
    // the wrong tree (and silently miss dangling-symlink cleanup).
    const claudeRoot = resolveClaudeConfigDir();
    const ipPath = resolve(claudeRoot, "plugins", "installed_plugins.json");
    if (!existsSync(ipPath)) return;
    const ip = JSON.parse(readFileSync(ipPath, "utf-8"));
    const cacheRoot = resolve(claudeRoot, "plugins", "cache");
    // Issue #795: canonicalize cacheRoot so the traversal guard works when
    // ~/.claude is a symlink to another volume.  path.resolve() does not
    // dereference symlinks, so installPath values stored as physical paths
    // (e.g. /Volumes/SSD/.../plugins/cache/...) would fail the startsWith
    // check against a symlink-path cacheRoot (/Users/me/.claude/...).
    // realpathSync follows the symlink chain to the canonical location.
    let cacheRootCanon: string;
    try { cacheRootCanon = realpathSync(cacheRoot); }
    catch { cacheRootCanon = cacheRoot; }
    // Plugin root: build/ for tsc, plugin root for bundle
    const pluginRoot = getPackageRoot();
    for (const [key, entries] of Object.entries((ip.plugins ?? {}) as Record<string, Array<{ installPath?: string }>>)) {
      if (key !== "context-mode@context-mode") continue;
      for (const entry of entries) {
        const rp = entry.installPath;
        if (!rp || existsSync(rp)) continue;
        // Path traversal guard (canonical comparison — see #795)
        if (!resolve(rp).startsWith(cacheRootCanon + sep)) continue;
        // Remove dangling symlink
        try { if (lstatSync(rp).isSymbolicLink()) unlinkSync(rp); } catch {}
        const parent = dirname(rp);
        if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
        if (existsSync(pluginRoot)) {
          symlinkSync(pluginRoot, rp, process.platform === "win32" ? "junction" : undefined);
        }
      }
    }
  } catch { /* best effort */ }
}

function trackResponse(toolName: string, response: ToolResult): ToolResult {
  // #854: a response is activity too — refresh the bridge-child idle clock so a
  // chatty/streaming call keeps its server alive even between inbound frames.
  noteMcpActivity();
  // Mid-session cache heal — one-shot, first tool call
  healCacheMidSession();
  // Prepend version outdated warning if needed
  if (shouldShowVersionWarning() && response.content.length > 0) {
    const hint = getUpgradeHint();
    response.content[0].text =
      `⚠️ context-mode v${VERSION} outdated → v${_latestVersion} available. Upgrade: ${hint}\n\n` +
      response.content[0].text;
  }

  const bytes = response.content.reduce(
    (sum, c) => sum + Buffer.byteLength(c.text),
    0,
  );
  sessionStats.calls[toolName] = (sessionStats.calls[toolName] || 0) + 1;
  sessionStats.bytesReturned[toolName] =
    (sessionStats.bytesReturned[toolName] || 0) + bytes;

  // Persist a sidecar JSON snapshot for the statusline — read at ~3-5 Hz by
  // bin/statusline.mjs (and any external dashboard) so they don't have to
  // open the SQLite database. Throttled inside persistStats() (500ms) so
  // it's safe to call on every response.
  persistStats();

  // Persist to SessionDB so counters survive process restart, --continue,
  // upgrade. Re-introduces the write path 4742160 added and b392c2f dropped.
  // setImmediate keeps this off the response hot path; the helper itself
  // is best-effort (never throws).
  setImmediate(() => persistToolCallCounter(getSessionDbPath(), toolName, bytes));

  // D2 Phase 5/7 — sandbox-execute event emission. Tracks the bytes the
  // user actually saw from sandboxed runs so getRealBytesStats() can
  // replace the conservative `events × 256` estimate. Best-effort and
  // off the hot path, same shape as persistToolCallCounter above.
  if (
    toolName === "ctx_execute"
    || toolName === "ctx_execute_file"
    || toolName === "ctx_batch_execute"
  ) {
    setImmediate(() =>
      emitSandboxExecuteEvent({
        sessionDbPath: getSessionDbPath(),
        toolName,
        bytesReturned: bytes,
      })
    );
  }

  return response;
}

function trackIndexed(bytes: number, source: string = "unknown"): void {
  sessionStats.bytesIndexed += bytes;
  persistStats();
  // D2 Phase 5/7 — index-write event emission. `bytes_avoided` because
  // these are bytes that would have flooded context if the user had
  // Read'd the source instead of indexing.
  if (bytes > 0) {
    setImmediate(() =>
      emitIndexWriteEvent({
        sessionDbPath: getSessionDbPath(),
        source,
        bytesAvoided: bytes,
      })
    );
  }
}

// ─────────────────────────────────────────────────────────
// Stats persistence — written after every tool call so
// external readers (status line scripts, dashboards, hooks)
// can see real-time savings without spawning an MCP client.
// ─────────────────────────────────────────────────────────

const STATS_PERSIST_THROTTLE_MS = 500;
// Schema version for the persisted stats payload (~/.claude/context-mode/sessions/stats-*.json).
// Bump when a field is added/renamed/removed. Statusline reads `schemaVersion ?? 0` and warns when
// it sees a future schema, so legacy bundles degrade gracefully on upgrade rather than silently
// rendering missing fields (PR #401 architect review P1.3).
// v2: added tokens_saved_lifetime + dollars_saved_lifetime.
const STATS_SCHEMA_VERSION = 2;
// pricePerToken() intentionally NOT defined here — single source in
// src/session/analytics.ts re-exported above. (P1.1 — pricing constant dedup,
// PR #401 architect + ops 2-vote convergence.)
const LIFETIME_REFRESH_MS = 30_000;
// Matches the conversion factor in src/session/analytics.ts renderBottomLine:
// ~1KB per session event ÷ 4 bytes/token = 256 tokens/event.
const TOKENS_PER_EVENT = 256;
let _lastStatsPersist = 0;
let _lifetimeCache: { tokens: number; computedAt: number } | undefined;

/**
 * Resolve the per-session stats file path.
 *
 * The session id mirrors the Claude Code adapter contract
 * (`pid-<parent pid>`), so a status line script can derive
 * the same id from `$PPID` without coupling to MCP.
 */
// CLAUDE_SESSION_ID flows from the hosting process (Claude Code, pi, etc.)
// straight into a path.join, and path.join collapses ".." into the result,
// so a host env CLAUDE_SESSION_ID=../../evil writes "stats-evil.json" two
// levels above statsDir. The env var is not under direct MCP-tool-caller
// control, but in CI / multi-tenant contexts where the host env is partly
// influenceable this is an arbitrary-write primitive within the MCP server
// process's filesystem permissions. Constrain to a UUID-shaped charset
// before splicing into the stats filename.
const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
function sanitizeSessionId(raw: string): string {
  return SESSION_ID_RE.test(raw) ? raw : `pid-${process.ppid}`;
}

function getStatsFilePath(): string {
  const raw = process.env.CLAUDE_SESSION_ID || `pid-${process.ppid}`;
  const sessionId = sanitizeSessionId(raw);
  const statsDir = ensureWritableStorageDir(resolveStatsStorageDir(getDefaultSessionDir));
  return join(statsDir, `stats-${sessionId}.json`);
}

/**
 * Where the bytes of retired per-session stats files are kept.
 *
 * Named to be picked up by the same `stats-*.json` scan that reads the live
 * files, so folding them in costs the reader nothing.
 */
const STATS_ROLLUP_FILE = "stats-rollup.json";

// Roll up + delete runs once per process; there is nothing to gain from more.
// The latch lives in ./tools/shared/state.ts because the two callers — the
// first getStore() here and ctx_stats in src/tools/ops.ts — are now in
// different modules and must still share one claim.

/**
 * Fold long-dead per-session stats files into one rollup and delete them.
 *
 * Every session writes its own `stats-<id>.json` and nothing ever removed them:
 * 735 files on this machine, all of them read on every ctx_stats call. Plain
 * deletion is not an option — the lifetime byte counters are summed from these
 * files, and a metric that goes down is worse than a directory that grows — so
 * the bytes move into a rollup first.
 *
 * Only files untouched for the retention window are eligible, which is what
 * keeps a live session's own file (rewritten on every persist, cumulative for
 * the session) from being counted twice.
 *
 * @returns Number of files retired.
 */
export function rollUpStaleStatsFiles(sessionsDir: string, maxAgeDays?: number): number {
  const rawDays = Number.parseInt(process.env.CONTEXT_MODE_STATS_FILE_RETENTION_DAYS ?? "", 10);
  const days = maxAgeDays ?? (Number.isFinite(rawDays) && rawDays >= 0 ? rawDays : 14);
  if (days <= 0) return 0;
  if (!existsSync(sessionsDir)) return 0;

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const rollupPath = join(sessionsDir, STATS_ROLLUP_FILE);
  let sandboxed = 0;
  let indexed = 0;
  const victims: string[] = [];

  try {
    for (const f of readdirSync(sessionsDir)) {
      if (!f.startsWith("stats-") || !f.endsWith(".json") || f === STATS_ROLLUP_FILE) continue;
      const path = join(sessionsDir, f);
      try {
        if (statSync(path).mtimeMs >= cutoff) continue;
        const raw = JSON.parse(readFileSync(path, "utf-8"));
        sandboxed += raw?.bytes_sandboxed ?? 0;
        indexed += raw?.bytes_indexed ?? 0;
        victims.push(path);
      } catch { /* unreadable or corrupt — leave it alone rather than lose it */ }
    }
  } catch {
    return 0;
  }
  if (victims.length === 0) return 0;

  try {
    let prev: { bytes_sandboxed?: number; bytes_indexed?: number; files_rolled_up?: number } = {};
    try { prev = JSON.parse(readFileSync(rollupPath, "utf-8")); } catch { /* first rollup */ }
    // Written before anything is deleted: a crash here re-reads the same files
    // next time, which is recoverable; the reverse order loses the bytes.
    writeFileSync(rollupPath, JSON.stringify({
      bytes_sandboxed: (prev.bytes_sandboxed ?? 0) + sandboxed,
      bytes_indexed: (prev.bytes_indexed ?? 0) + indexed,
      files_rolled_up: (prev.files_rolled_up ?? 0) + victims.length,
      updated_at: new Date().toISOString(),
    }), "utf-8");
  } catch {
    return 0;
  }

  let removed = 0;
  for (const path of victims) {
    try { unlinkSync(path); removed++; } catch { /* next pass will retry */ }
  }
  return removed;
}

function persistStats(): void {
  const now = Date.now();
  if (now - _lastStatsPersist < STATS_PERSIST_THROTTLE_MS) return;
  _lastStatsPersist = now;

  try {
    const totalReturned = Object.values(sessionStats.bytesReturned).reduce(
      (a, b) => a + b,
      0,
    );
    const totalCalls = Object.values(sessionStats.calls).reduce(
      (a, b) => a + b,
      0,
    );
    const keptOut =
      sessionStats.bytesIndexed +
      sessionStats.bytesSandboxed +
      sessionStats.cacheBytesSaved;
    const totalProcessed = keptOut + totalReturned;
    const reductionPct =
      totalProcessed > 0
        ? Math.round((1 - totalReturned / totalProcessed) * 100)
        : 0;
    const tokensSaved = Math.round(keptOut / 4);

    // Lifetime savings — cached separately because getLifetimeStats() scans
    // disk (per-project SessionDBs + auto-memory dirs) and is too expensive
    // for the 500ms persist throttle. Refresh every 30s; the statusline
    // doesn't need second-by-second lifetime accuracy.
    let lifetimeTokens = _lifetimeCache?.tokens ?? 0;
    if (!_lifetimeCache || now - _lifetimeCache.computedAt > LIFETIME_REFRESH_MS) {
      try {
        const life = getLifetimeStats({ sessionsDir: getSessionDir() });
        lifetimeTokens = (life?.totalEvents ?? 0) * TOKENS_PER_EVENT;
        _lifetimeCache = { tokens: lifetimeTokens, computedAt: now };
      } catch {
        // best-effort — keep stale cache or 0
      }
    }

    const payload = {
      schemaVersion: STATS_SCHEMA_VERSION,
      version: VERSION,
      updated_at: now,
      session_start: sessionStats.sessionStart,
      uptime_ms: now - sessionStats.sessionStart,
      total_calls: totalCalls,
      bytes_returned: totalReturned,
      bytes_indexed: sessionStats.bytesIndexed,
      bytes_sandboxed: sessionStats.bytesSandboxed,
      cache_hits: sessionStats.cacheHits,
      cache_bytes_saved: sessionStats.cacheBytesSaved,
      kept_out: keptOut,
      total_processed: totalProcessed,
      reduction_pct: reductionPct,
      tokens_saved: tokensSaved,
      // statusline-facing $ values — pre-computed at the current per-token
      // rate (dynamic when PI_CONTEXT_MODE_PRICE_OUTPUT_PER_TOKEN is set by a
      // Pi host; Opus $15/1M otherwise). Resolved on every persist via
      // pricePerToken() so the env override picks up without an MCP restart.
      dollars_saved_session: +(tokensSaved * pricePerToken()).toFixed(2),
      tokens_saved_lifetime: lifetimeTokens,
      dollars_saved_lifetime: +(lifetimeTokens * pricePerToken()).toFixed(2),
      by_tool: Object.fromEntries(
        Object.keys({ ...sessionStats.calls, ...sessionStats.bytesReturned }).map(
          (t) => [
            t,
            {
              calls: sessionStats.calls[t] || 0,
              bytes: sessionStats.bytesReturned[t] || 0,
            },
          ],
        ),
      ),
    };

    const filePath = getStatsFilePath();
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(payload));
    renameSync(tmpPath, filePath);
  } catch {
    // best-effort — never break tool calls because of stats persistence
  }
}

// ==============================================================================
// Security: server-side deny firewall
// ==============================================================================

/**
 * Check a shell command against Bash deny patterns.
 * Returns an error ToolResult if denied, or null if allowed.
 */
function checkDenyPolicy(
  command: string,
  toolName: string,
): ToolResult | null {
  try {
    const policies = readBashPolicies(process.env.CLAUDE_PROJECT_DIR);
    const result = evaluateCommandDenyOnly(command, policies);
    if (result.decision === "deny") {
      return trackResponse(toolName, {
        content: [{
          type: "text" as const,
          text: `Command blocked by security policy: matches deny pattern ${result.matchedPattern}`,
        }],
        isError: true,
      });
    }
  } catch {
    // Security check failed — allow through (fail-open for server,
    // hooks are the primary enforcement layer)
  }
  return null;
}

/**
 * Check non-shell code for shell-escape calls against deny patterns.
 */
function checkNonShellDenyPolicy(
  code: string,
  language: string,
  toolName: string,
): ToolResult | null {
  try {
    const commands = extractShellCommands(code, language);
    if (commands.length === 0) return null;
    const policies = readBashPolicies(process.env.CLAUDE_PROJECT_DIR);
    for (const cmd of commands) {
      const result = evaluateCommandDenyOnly(cmd, policies);
      if (result.decision === "deny") {
        return trackResponse(toolName, {
          content: [{
            type: "text" as const,
            text: `Command blocked by security policy: embedded shell command "${cmd}" matches deny pattern ${result.matchedPattern}`,
          }],
          isError: true,
        });
      }
    }
  } catch {
    // Fail-open
  }
  return null;
}

/**
 * Issue #852 — project-boundary containment for `ctx_execute_file`.
 *
 * The harness sandbox (Claude Code, etc.) cannot inspect MCP input params, so a
 * user approving a `ctx_execute_file` call cannot see that its `path` escapes
 * the workspace. This guard refuses a `path` that resolves outside the project
 * root (absolute escape, `../` traversal, or symlink-out), restoring the
 * boundary the host believes it is enforcing.
 *
 * Escape hatch — NO bespoke opt-out env. A deliberate out-of-project read is
 * expressed in the SAME host config the user already maintains: a
 * `permissions.allow` rule like `Read(/var/log/**)`. This reuses the exact
 * mechanism Claude Code uses to whitelist a path outside its sandbox, so the
 * grant lives in one place and stays meaningful instead of rotting into a
 * context-mode-only env flag nobody sets.
 *
 * Fail-open on resolver failure (consistent with the other deny checks): if the
 * project root cannot be resolved, containment evaluates as "inside" and the
 * path is allowed through rather than spuriously blocking legitimate work.
 */
function checkProjectBoundary(
  filePath: string,
  toolName: string,
): ToolResult | null {
  try {
    const projectDir = getProjectDir();
    const allowGlobs = readToolPermissionPatterns("Read", "allow", projectDir);
    const verdict = evaluateProjectContainment(filePath, projectDir, allowGlobs);
    if (verdict.allowed) return null;
    return trackResponse(toolName, {
      content: [{
        type: "text" as const,
        text:
          `File access blocked: "${filePath}" resolves outside the project root ` +
          `(${projectDir}). context-mode confines ${toolName} to the workspace so it ` +
          `cannot be used to bypass the host's sandbox/permission controls (issue #852). ` +
          `To intentionally process a file outside the project, add a host allow rule, ` +
          `e.g. "permissions": { "allow": ["Read(${filePath})"] } in your settings.`,
      }],
      isError: true,
    });
  } catch {
    // Fail-open — resolver failure must not block legitimate in-project work.
  }
  return null;
}

/**
 * Check a file path against Read deny patterns.
 * Returns an error ToolResult if denied, or null if allowed.
 */
function checkFilePathDenyPolicy(
  filePath: string,
  toolName: string,
): ToolResult | null {
  try {
    const projectDir = getProjectDir();
    const denyGlobs = readToolDenyPatterns("Read", projectDir);
    const result = evaluateFilePath(
      filePath,
      denyGlobs,
      process.platform === "win32",
      projectDir,
    );
    if (result.denied) {
      return trackResponse(toolName, {
        content: [{
          type: "text" as const,
          text: `File access blocked by security policy: path matches Read deny pattern ${result.matchedPattern}`,
        }],
        isError: true,
      });
    }
  } catch {
    // Fail-open
  }
  return null;
}

// Build description dynamically based on detected runtimes
const langList = available.join(", ");
const bunNote = hasBunRuntime()
  ? " (Bun detected — JS/TS runs 3-5x faster)"
  : "";

// ─────────────────────────────────────────────────────────
// Helper: smart snippet extraction — returns windows around
// matching query terms instead of dumb truncation
//
// When `highlighted` is provided (from FTS5 `highlight()` with
// STX/ETX markers), match positions are derived from the markers.
// This is the authoritative source — FTS5 uses the exact same
// tokenizer that produced the BM25 match, so stemmed variants
// like "configuration" matching query "configure" are found
// correctly. Falls back to indexOf on raw terms when highlighted
// is absent (non-FTS codepath).
// ─────────────────────────────────────────────────────────

const STX = "\x02";
const ETX = "\x03";

/**
 * Parse FTS5 highlight markers to find match positions in the
 * original (marker-free) text. Returns character offsets into the
 * stripped content where each matched token begins.
 */
export function positionsFromHighlight(highlighted: string): number[] {
  const positions: number[] = [];
  let cleanOffset = 0;

  let i = 0;
  while (i < highlighted.length) {
    if (highlighted[i] === STX) {
      // Record position of this match in the clean text
      positions.push(cleanOffset);
      i++; // skip STX
      // Advance through matched text until ETX
      while (i < highlighted.length && highlighted[i] !== ETX) {
        cleanOffset++;
        i++;
      }
      if (i < highlighted.length) i++; // skip ETX
    } else {
      cleanOffset++;
      i++;
    }
  }

  return positions;
}

/** Strip STX/ETX markers to recover original content. */
function stripMarkers(highlighted: string): string {
  return highlighted.replaceAll(STX, "").replaceAll(ETX, "");
}

export function extractSnippet(
  content: string,
  query: string,
  maxLen = 1500,
  highlighted?: string,
): string {
  if (content.length <= maxLen) return content;

  // Derive match positions from FTS5 highlight markers when available
  const positions: number[] = [];

  if (highlighted) {
    for (const pos of positionsFromHighlight(highlighted)) {
      positions.push(pos);
    }
  }

  // Fallback: indexOf on raw query terms (non-FTS codepath)
  if (positions.length === 0) {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);
    const lower = content.toLowerCase();

    for (const term of terms) {
      let idx = lower.indexOf(term);
      while (idx !== -1) {
        positions.push(idx);
        idx = lower.indexOf(term, idx + 1);
      }
    }
  }

  // No matches at all — return prefix
  if (positions.length === 0) {
    return content.slice(0, maxLen) + "\n…";
  }

  // Sort positions, merge overlapping windows
  positions.sort((a, b) => a - b);
  const WINDOW = 300;
  const windows: Array<[number, number]> = [];

  for (const pos of positions) {
    const start = Math.max(0, pos - WINDOW);
    const end = Math.min(content.length, pos + WINDOW);
    if (windows.length > 0 && start <= windows[windows.length - 1][1]) {
      windows[windows.length - 1][1] = end;
    } else {
      windows.push([start, end]);
    }
  }

  // Collect windows until maxLen
  const parts: string[] = [];
  let total = 0;
  for (const [start, end] of windows) {
    if (total >= maxLen) break;
    const part = content.slice(start, Math.min(end, start + (maxLen - total)));
    parts.push(
      (start > 0 ? "…" : "") + part + (end < content.length ? "…" : ""),
    );
    total += part.length;
  }

  return parts.join("\n\n");
}

// ─────────────────────────────────────────────────────────
// Semantic coverage hint
// ─────────────────────────────────────────────────────────

/** The hint is a nudge, not a status bar: once per process, then silent. */
let _semanticHintShown = false;

/** Test seam — the latch is process-wide by design. */
export function __resetSemanticHintLatch(): void {
  _semanticHintShown = false;
}

/**
 * One line telling the caller the semantic layer is not answering yet.
 *
 * Pure so the wording is testable without a store. Silent below 200 chunks
 * (a small index is well served by lexical search alone, and the advice would
 * be noise) and silent at full coverage.
 */
export function formatSemanticHint(coverage: { chunks: number; vectors: number }): string | null {
  if (coverage.chunks < 200) return null;
  if (coverage.vectors >= coverage.chunks) return null;
  const pct = Math.min(100, Math.round((coverage.vectors / coverage.chunks) * 100));
  const total = coverage.chunks.toLocaleString();
  return coverage.vectors === 0
    ? `> Semantic layer inactive: 0 of ${total} chunks embedded — these results are lexical-only. \`context-mode drain\` warms the index.`
    : `> Semantic layer at ${pct}% of ${total} chunks — the rest is lexical-only. \`context-mode drain\` finishes the warm-up.`;
}

/** The hint for this store, at most once per process. */
export function semanticStatusHint(store: ContentStore): string | null {
  if (process.env.CONTEXT_MODE_SEMANTIC_HINT === "0") return null;
  if (_semanticHintShown) return null;
  try {
    const line = formatSemanticHint(vectorCoverage(store.rawDb() as unknown as HybridDb));
    if (line) _semanticHintShown = true;
    return line;
  } catch {
    return null;
  }
}

// Cross-query deduplication lives in src/search/dedup.ts so the tool modules
// can import it without reaching back into this file. Re-exported here because
// it is part of this module's published surface.
export {
  CrossQueryDeduper,
  searchDedupEnabled,
  type DedupDecision,
} from "./search/dedup.js";

export type BatchQueryScope = "batch" | "global";

export async function formatBatchQueryResults(
  store: ContentStore,
  queries: string[],
  source: string,
  maxOutput = 80 * 1024,
  scope: BatchQueryScope = "batch",
): Promise<string[]> {
  const sections: string[] = [];
  let outputSize = 0;
  // One deduper for the whole response: the repeats we care about are the ones
  // across queries, so it must outlive the per-query loop.
  const deduper = new CrossQueryDeduper();
  // Per-query completeness, collected for the one escalation block at the end.
  const completeness: SearchCompleteness[] = [];

  // When scope is "global", searchWithFallback receives `undefined` for the
  // source filter, which makes it query the entire persistent index instead
  // of only the chunks just produced by this batch's commands. Default
  // remains "batch" to preserve the historical behavior.
  const searchSource = scope === "global" ? undefined : source;

  for (const query of queries) {
    if (outputSize > maxOutput) {
      sections.push(`## ${query}\n(output cap reached — use ctx_search(queries: ["${query}"]) for details)\n`);
      continue;
    }

    const found = store.searchWithFallbackMeta(query, 3, searchSource, undefined, "exact");
    let results = found.results;
    completeness.push(found.completeness);

    // Semantic re-fusion, global scope only. Batch scope searches the output
    // this very call just produced — the caller already knows those terms, so
    // the embedding round trip would buy nothing and cost latency on the hot
    // path. Global scope is the one that reaches cold prior knowledge, where a
    // paraphrased query is exactly what lexical matching misses.
    // No-op unless CONTEXT_MODE_EMBEDDINGS_URL is configured.
    if (scope === "global") {
      results = await hybridSearch({
        db: store.rawDb() as unknown as HybridDb,
        query,
        lexical: results as unknown as LexicalResult[],
        limit: 3,
      }) as unknown as typeof results;
    }

    sections.push(`## ${query}`);
    sections.push("");
    if (results.length > 0) {
      // Semantic re-fusion can add rows the lexical pool never held, so the
      // reported total must be at least what is on screen.
      const info = completeness[completeness.length - 1]!;
      info.shown = results.length;
      info.poolSize = Math.max(info.poolSize, results.length);
      for (const result of results) {
        const snippet = extractSnippet(result.content, query, 3000, result.highlighted);
        const decision = deduper.consider(result, snippet, query);
        if (decision.kind === "suppress") {
          sections.push(`### ${result.title}`);
          sections.push(CrossQueryDeduper.pointerLine(decision.firstQuery));
          sections.push("");
          outputSize += result.title.length;
          continue;
        }
        sections.push(`### ${result.title}${decision.kind === "further" ? " — further match" : ""}`);
        sections.push(snippet);
        sections.push("");
        outputSize += snippet.length + result.title.length;
      }
      const line = formatCompletenessLine(query, completeness[completeness.length - 1]!);
      if (line) {
        sections.push(line);
        sections.push("");
      }
      continue;
    }

    sections.push("No matching sections found.");
    sections.push("");
  }

  const escalation = formatEscalationBlock(completeness);
  if (escalation) sections.push(`\n${escalation}`);

  const dedupFooter = deduper.footer();
  if (dedupFooter) sections.push(`\n${dedupFooter}`);

  if (scope === "global") {
    // Only the global path reaches cold prior knowledge, which is the one place
    // a missing semantic layer changes what the caller gets back.
    const hint = semanticStatusHint(store);
    if (hint) sections.push(`\n${hint}`);
    sections.push(`\n> **Scope:** Queries searched the entire persistent index (query_scope: "global").`);
  } else {
    sections.push(`\n> **Tip:** Results are scoped to this batch only. To search across all indexed sources, use \`ctx_search(queries: [...])\` or call ctx_batch_execute with \`query_scope: "global"\`.`);
  }

  return sections;
}

// ─────────────────────────────────────────────────────────
// batch_execute runner — used by ctx_batch_execute handler
// ─────────────────────────────────────────────────────────

export interface BatchCommand { label: string; command: string; }

export interface BatchRunResult {
  outputs: string[];
  timedOut: boolean;
}

export interface BatchRunOptions {
  /**
   * Total budget (concurrency=1, shared) or per-command (concurrency>1).
   * When `undefined`, no server-side timer fires — the MCP host's RPC
   * timeout governs (Issue #406).
   */
  timeout: number | undefined;
  concurrency: number;
  nodeOptsPrefix: string;
  cwd?: string;
  onFsBytes?: (bytes: number) => void;
}

interface BatchExecutor {
  execute(input: { language: "shell"; code: string; timeout: number | undefined; cwd?: string }): Promise<{ stdout: string; timedOut?: boolean }>;
}

function quotePosixSingle(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function quotePowerShellSingle(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildBatchNodeOptionsPrefix(shellPath: string, preloadPath: string): string {
  const option = `--require ${preloadPath}`;
  const shell = shellPath.toLowerCase();
  const base = shell.split(/[\\/]/).pop() ?? shell;

  if (shell.includes("powershell") || shell.includes("pwsh")) {
    return `$env:NODE_OPTIONS=${quotePowerShellSingle(option)}; `;
  }

  if (base === "cmd" || base === "cmd.exe") {
    return `set "NODE_OPTIONS=${option.replace(/"/g, '""')}" && `;
  }

  return `NODE_OPTIONS=${quotePosixSingle(option)} `;
}

/**
 * Per-section budget for the echoed `$ <command>` line so a 50KB heredoc
 * payload cannot dominate the response body. The full command always reaches
 * the executor — only the echo is clipped (Issues #717 + #736).
 */
const COMMAND_ECHO_MAX = 500;

function truncateCommandForEcho(command: string): string {
  const cleaned = command.replace(/\s+/g, " ").trim();
  if (cleaned.length <= COMMAND_ECHO_MAX) return cleaned;
  return cleaned.slice(0, COMMAND_ECHO_MAX) + "…";
}

/**
 * Default execution timeout (ms) applied ONLY under Antigravity CLI (`agy`).
 * agy does not enforce an MCP RPC timeout, so a ctx_execute with a runaway or
 * blocking script hangs forever — the host never kills it and the user must
 * interrupt. Every other host enforces its own RPC timeout, so we keep the
 * no-server-timer behavior there (Issue #406 — long builds need an unbounded
 * run). A caller can still pass an explicit `timeout` to override on any host.
 */
export const AGY_DEFAULT_EXEC_TIMEOUT_MS = 120_000;
export function resolveExecTimeout(timeout: number | undefined): number | undefined {
  if (timeout !== undefined) return timeout;
  // Only agy gets a default — every other host enforces its own RPC timeout, so
  // keep the unbounded behavior there. Detected via the env the agy bundle pins
  // (CONTEXT_MODE_PLATFORM=antigravity-cli). Tunable via CONTEXT_MODE_AGY_EXEC_TIMEOUT_MS.
  if (detectPlatform().platform !== "antigravity-cli") return undefined;
  const override = Number(process.env.CONTEXT_MODE_AGY_EXEC_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : AGY_DEFAULT_EXEC_TIMEOUT_MS;
}

/**
 * Per-call budget for the source-code echo prepended by `ctx_execute` and
 * `ctx_execute_file` (Issues #717 + #736). The full code always reaches the
 * sandbox — only the echo is clipped so massive payloads don't dominate
 * the response. Multi-line preserved (unlike command echo) so the user
 * sees the actual program shape.
 */
const CODE_ECHO_MAX = 2000;

function truncateCodeForEcho(code: string): string {
  if (code.length <= CODE_ECHO_MAX) return code;
  return code.slice(0, CODE_ECHO_MAX) + "\n… (truncated)";
}

/**
 * Build the source-code preamble surfaced before tool stdout. Provenance
 * survives in indexed chunks (FTS5 sees the fenced block) so later
 * ctx_search hits remember what ran.
 */
function buildExecuteEcho(language: string, code: string, path?: string): string {
  const header = path ? `path=${path}\n` : "";
  const fenced = `\`\`\`${language}\n${truncateCodeForEcho(code)}\n\`\`\``;
  return `${header}${fenced}\n\n`;
}

function formatCommandOutput(label: string, command: string, raw: string, onFsBytes?: (bytes: number) => void): string {
  let output = raw || "(no output)";
  const fsMatches = output.matchAll(/__CM_FS__:(\d+)/g);
  let cmdFsBytes = 0;
  for (const m of fsMatches) cmdFsBytes += parseInt(m[1]);
  if (cmdFsBytes > 0) {
    onFsBytes?.(cmdFsBytes);
    output = output.replace(/__CM_FS__:\d+\n?/g, "");
  }
  // Echo the executed command below the section heading so per-chunk
  // indexed content retains provenance for later ctx_search hits
  // (Issues #717 + #736).
  const echoed = truncateCommandForEcho(command);
  return `# ${label}\n\n$ ${echoed}\n\n${output}\n`;
}

function combineExecOutput(result: { stdout?: string; stderr?: string }): string {
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  if (!stderr) return stdout;
  if (!stdout) return stderr;
  return `${stdout}${stdout.endsWith("\n") ? "" : "\n"}${stderr}`;
}

/**
 * Execute batch commands. concurrency=1 preserves the legacy serial path
 * (shared timeout budget + cascading skip-on-timeout). concurrency>1 runs
 * commands concurrently with at most N in flight; each command receives the
 * full timeout, output is collated by input index, and per-command timeouts
 * record `(timed out)` blocks without skipping siblings.
 */
export async function runBatchCommands(
  commands: BatchCommand[],
  opts: BatchRunOptions,
  executor: BatchExecutor,
): Promise<BatchRunResult> {
  const { timeout, concurrency, nodeOptsPrefix, cwd, onFsBytes } = opts;

  if (concurrency <= 1) {
    // Serial path — shared timeout budget, cascading skip on timeout.
    // When `timeout` is undefined, no shared budget is enforced; each
    // command runs to completion (Issue #406).
    const outputs: string[] = [];
    const startTime = Date.now();
    let timedOut = false;
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      let perCmdTimeout: number | undefined;
      if (timeout !== undefined) {
        const elapsed = Date.now() - startTime;
        const remaining = timeout - elapsed;
        if (remaining <= 0) {
          outputs.push(`# ${cmd.label}\n\n(skipped — batch timeout exceeded)\n`);
          timedOut = true;
          continue;
        }
        perCmdTimeout = remaining;
      }
      const result = await executor.execute({
        language: "shell",
        code: `${nodeOptsPrefix}${cmd.command}`,
        timeout: perCmdTimeout,
        cwd,
      });
      outputs.push(formatCommandOutput(cmd.label, cmd.command, combineExecOutput(result), onFsBytes));
      if (result.timedOut) {
        timedOut = true;
        for (let j = i + 1; j < commands.length; j++) {
          outputs.push(`# ${commands[j].label}\n\n(skipped — batch timeout exceeded)\n`);
        }
        break;
      }
    }
    return { outputs, timedOut };
  }

  // Parallel path — delegated to the shared runPool primitive.
  // Each job returns { output, timedOut }; runPool handles in-flight cap,
  // throw isolation (Promise.allSettled semantics), and order preservation.
  const jobs: PoolJob<{ output: string; timedOut: boolean }>[] = commands.map((cmd) => ({
    run: async () => {
      const result = await executor.execute({
        language: "shell",
        code: `${nodeOptsPrefix}${cmd.command}`,
        timeout,
        cwd,
      });
      // Always route partial output through formatCommandOutput so __CM_FS__
      // markers are stripped + counted, even when the command timed out.
      const formatted = formatCommandOutput(cmd.label, cmd.command, combineExecOutput(result), onFsBytes);
      const output = result.timedOut
        ? formatted.replace(/\n$/, "") + `\n(timed out after ${timeout ?? "?"}ms)\n`
        : formatted;
      return { output, timedOut: !!result.timedOut };
    },
  }));

  const { settled } = await runPool(jobs, { concurrency });
  const outputs: string[] = new Array(commands.length);
  let timedOut = false;
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === "fulfilled") {
      outputs[i] = r.value.output;
      if (r.value.timedOut) timedOut = true;
    } else {
      // Isolated executor throw (spawn EAGAIN, ENOMEM, EMFILE, …) — siblings keep running.
      const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
      outputs[i] = `# ${commands[i].label}\n\n(executor error: ${message})\n`;
    }
  }
  return { outputs, timedOut };
}

// ─────────────────────────────────────────────────────────
// Tool: execute
// ─────────────────────────────────────────────────────────

server.registerTool(
  "ctx_execute",
  {
    // #852: surface code execution in the host approval prompt's title (the
    // only server-controlled field the MCP permission UI renders besides args).
    title: "Run code in a separate process (executes the supplied code)",
    // #846: runs arbitrary code in a child process with full network access,
    // the project root as cwd, and the parent's filesystem permissions.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description: `Run code in a separate subprocess.${bunNote} Languages: ${langList}.

Think-in-Code — the core philosophy: the bytes your code processes never enter your conversation memory; only what you console.log() does. Reading a 700 KB log directly means 700 KB of your remaining reasoning capacity gets spent on raw bytes. Running code over that same log in the subprocess and printing a 3 KB summary leaves you with 697 KB of capacity for the actual work.

Concrete shape — analyze 47 source files without reading any of them:
  ctx_execute(language: "javascript", code: \`
    const fs = require('fs');
    const files = fs.readdirSync('src').filter(f => f.endsWith('.ts'));
    files.forEach(f => {
      const lines = fs.readFileSync('src/'+f,'utf8').split('\\\\n').length;
      console.log(f + ': ' + lines + ' lines');
    });
  \`)
  // 47 files analyzed, 15,314 LoC summarized — output ~3.6 KB instead of 47 Read() calls = ~700 KB.

WHEN:
  - You intend to derive an answer FROM data (filter, count, aggregate, parse, compare, transform) — do the derivation in code and print only the answer
  - Output shape or size cannot be predicted before execution (recursive finds, repo-wide greps, list endpoints, query results, log scans)
  - You would otherwise read raw output and then mentally compute — that compute belongs here, in code, where its inputs stay out of your conversation
  - You need to keep a long-running process alive (dev server, watcher, daemon) — pass \`background: true\` to detach on timeout instead of killing the process
  - The output may legitimately be large but you only want recall-by-topic later — pass an \`intent\` string; outputs over ~5KB are auto-indexed into the knowledge base and only the section titles + previews come back, retrievable via ctx_search

WHEN NOT:
  - Single observational command whose entire short output you intend to consume verbatim (whoami, pwd, git status on a clean tree) — Bash is simpler
  - File mutations (Edit/Write) or navigation (cd/ls) — Bash is the right surface
  - You already know the output is one short fixed line and you want to read it as-is

RETURNS:
  Only what your code prints. Wrap risky calls in try/catch — uncaught errors go to stderr and may leak more than intended. When \`intent\` is set and output exceeds the auto-index threshold, the response carries searchable section titles + previews instead of the raw stdout; use ctx_search(queries: [...]) to drill into specific sections.

EXAMPLE: ctx_execute(language: "javascript", code: "const out = require('child_process').execSync('npm test', {encoding:'utf8', stdio:['ignore','pipe','pipe']}); console.log(out.split('\\\\n').filter(l => /(FAIL|✗|×|Error:|Tests +.*(failed|passed))/i.test(l)).slice(0, 60).join('\\\\n'))")
EXAMPLE: ctx_execute(language: "javascript", code: "const out = require('child_process').execSync('gh issue list --json number,title --limit 100', {encoding:'utf8'}); const hooks = JSON.parse(out).filter(i => /hook|routing/i.test(i.title)); console.log(\`\${hooks.length} hook-related issues\`)")`,
    inputSchema: z.object({
      language: z
        .enum([
          "javascript",
          "typescript",
          "python",
          "shell",
          "ruby",
          "go",
          "rust",
          "php",
          "perl",
          "r",
          "elixir",
          "csharp",
        ])
        .describe("Runtime language"),
      code: z
        .string()
        .describe(
          "Source code to execute. Use console.log (JS/TS), print (Python/Ruby/Perl/R), echo (Shell), echo (PHP), fmt.Println (Go), IO.puts (Elixir), or Console.WriteLine (C#) to output a summary to context.",
        ),
      timeout: z
        .coerce.number()
        .optional()
        .describe("Max execution time in ms. When omitted, no server-side timer fires — the MCP host's RPC timeout governs (which is the right layer for this policy). Pass an explicit value for long-running builds (Gradle/Maven/SBT)."),
      // background: wrapped in coerceBoolean preprocessor so the literal
      // strings "true"/"false" arriving from OpenCode's native plugin
      // bridge (and several LLM providers' tool-call JSON) parse as the
      // boolean the handler expects. z.coerce.boolean() is unsafe here —
      // Boolean("false") is true. Fixes #627.
      background: z
        .preprocess(coerceBoolean, z.boolean())
        .optional()
        .default(false)
        .describe("Keep process running after timeout (for servers/daemons). Returns partial output without killing the process. IMPORTANT: Do NOT add setTimeout/self-close timers in background scripts — the process must stay alive until the timeout detaches it. For server+fetch patterns, prefer putting both server and fetch in ONE ctx_execute call instead of using background."),
      cwd: z
        .string()
        .optional()
        .describe("Optional working directory for shell commands. Non-shell languages still execute from their sandbox temp directory."),
      intent: z
        .string()
        .optional()
        .describe(
          "What you're looking for in the output. When provided and output is large (>5KB), " +
          "indexes output into knowledge base and returns section titles + previews — not full content. " +
          "Use ctx_search(queries: [...]) to retrieve specific sections. Example: 'failing tests', 'HTTP 500 errors'." +
          "\n\nTIP: Use specific technical terms, not just concepts. Check 'Searchable terms' in the response for available vocabulary.",
        ),
    }),
  },
  async ({ language, code, timeout, background, cwd, intent }) => {
    // Security: deny-only firewall
    if (language === "shell") {
      const denied = checkDenyPolicy(code, "execute");
      if (denied) return denied;
    } else {
      const denied = checkNonShellDenyPolicy(code, language, "execute");
      if (denied) return denied;
    }

    try {
      // For JS/TS: wrap in async IIFE with fetch + http/https interceptors to track network bytes
      let instrumentedCode = code;
      if (language === "javascript" || language === "typescript") {
        // Wrap user code in a closure that shadows CJS require with http/https interceptor.
        // globalThis.require does NOT work because CJS require is module-scoped, not global.
        // The closure approach (function(__cm_req){ var require=...; })(require) correctly
        // shadows the CJS require for all code inside, including __cm_main().
        instrumentedCode = `
// FS read instrumentation — count bytes read via fs.readFileSync/readFile
let __cm_fs=0;
process.on('exit',()=>{if(__cm_fs>0)try{process.stderr.write('__CM_FS__:'+__cm_fs+'\\n')}catch{}});
(function(){
  try{
    var f=typeof require!=='undefined'?require('fs'):null;
    if(!f)return;
    var ors=f.readFileSync;
    f.readFileSync=function(){var r=ors.apply(this,arguments);if(Buffer.isBuffer(r))__cm_fs+=r.length;else if(typeof r==='string')__cm_fs+=Buffer.byteLength(r);return r;};
    var orf=f.readFile;
    if(orf)f.readFile=function(){var a=Array.from(arguments),cb=a.pop();orf.apply(this,a.concat([function(e,d){if(!e&&d){if(Buffer.isBuffer(d))__cm_fs+=d.length;else if(typeof d==='string')__cm_fs+=Buffer.byteLength(d);}cb(e,d);}]));};
  }catch{}
})();
let __cm_net=0;
// Report network bytes on process exit — works with both promise and callback patterns.
// process.on('exit') fires after all I/O completes, unlike .finally() which fires
// when __cm_main() resolves (immediately for callback-based http.get without await).
process.on('exit',()=>{if(__cm_net>0)try{process.stderr.write('__CM_NET__:'+__cm_net+'\\n')}catch{}});
;(function(__cm_req){
// Intercept globalThis.fetch
const __cm_f=globalThis.fetch;
globalThis.fetch=async(...a)=>{const r=await __cm_f(...a);
try{const cl=r.clone();const b=await cl.arrayBuffer();__cm_net+=b.byteLength}catch{}
return r};
// Shadow CJS require with http/https network tracking.
const __cm_hc=new Map();
const __cm_hm=new Set(['http','https','node:http','node:https']);
function __cm_wf(m,origFn){return function(...a){
  const li=a.length-1;
  if(li>=0&&typeof a[li]==='function'){const oc=a[li];a[li]=function(res){
    res.on('data',function(c){__cm_net+=c.length});oc(res);};}
  const req=origFn.apply(m,a);
  const oOn=req.on.bind(req);
  req.on=function(ev,cb,...r){
    if(ev==='response'){return oOn(ev,function(res){
      res.on('data',function(c){__cm_net+=c.length});cb(res);
    },...r);}
    return oOn(ev,cb,...r);
  };
  return req;
}}
var require=__cm_req?function(id){
  const m=__cm_req(id);
  if(!__cm_hm.has(id))return m;
  const k=id.replace('node:','');
  if(__cm_hc.has(k))return __cm_hc.get(k);
  const w=Object.create(m);
  if(typeof m.get==='function')w.get=__cm_wf(m,m.get);
  if(typeof m.request==='function')w.request=__cm_wf(m,m.request);
  __cm_hc.set(k,w);return w;
}:__cm_req;
if(__cm_req){if(__cm_req.resolve)require.resolve=__cm_req.resolve;
if(__cm_req.cache)require.cache=__cm_req.cache;}
async function __cm_main(){
${code}
}
__cm_main().catch(e=>{console.error(e);process.exitCode=1});${background ? '\nsetInterval(()=>{},2147483647);' : ''}
})(typeof require!=='undefined'?require:null);`;
      }
      const effTimeout = resolveExecTimeout(timeout);
      const result = await executor.execute({ language, code: instrumentedCode, timeout: effTimeout, background, cwd });

      // Echo the executed source code before stdout so users can audit
      // and tooling can block command patterns (Issues #717 + #736).
      // Built from the user-supplied `code`, NOT the instrumented variant.
      const echo = buildExecuteEcho(language, code);

      // Parse sandbox network metrics from stderr
      const netMatch = result.stderr?.match(/__CM_NET__:(\d+)/);
      if (netMatch) {
        sessionStats.bytesSandboxed += parseInt(netMatch[1]);
        // Clean the metric line from stderr
        result.stderr = result.stderr.replace(/\n?__CM_NET__:\d+\n?/g, "");
      }

      // Parse sandbox FS read metrics from stderr
      const fsMatch = result.stderr?.match(/__CM_FS__:(\d+)/);
      if (fsMatch) {
        sessionStats.bytesSandboxed += parseInt(fsMatch[1]);
        result.stderr = result.stderr.replace(/\n?__CM_FS__:\d+\n?/g, "");
      }

      if (result.timedOut) {
        const partialOutput = result.stdout?.trim();
        if (result.backgrounded && partialOutput) {
          // Background mode: process is still running, return partial output as success
          return trackResponse("ctx_execute", {
            content: [
              {
                type: "text" as const,
                text: `${echo}${partialOutput}\n\n_(process backgrounded after ${effTimeout}ms — still running)_`,
              },
            ],
          });
        }
        if (partialOutput) {
          // Timeout with partial output — return as success with note
          return trackResponse("ctx_execute", {
            content: [
              {
                type: "text" as const,
                text: `${echo}${partialOutput}\n\n_(timed out after ${effTimeout}ms — partial output shown above)_`,
              },
            ],
          });
        }
        return trackResponse("ctx_execute", {
          content: [
            {
              type: "text" as const,
              text: `${echo}Execution timed out after ${effTimeout}ms\n\nstderr:\n${result.stderr}`,
            },
          ],
          isError: true,
        });
      }

      if (result.exitCode !== 0) {
        const { isError, output } = classifyNonZeroExit({
          language, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
        });
        if (intent && intent.trim().length > 0 && Buffer.byteLength(output) > INTENT_SEARCH_THRESHOLD) {
          trackIndexed(Buffer.byteLength(output));
          return trackResponse("ctx_execute", {
            content: [
              { type: "text" as const, text: `${echo}${intentSearch(output, intent, isError ? `execute:${language}:error` : `execute:${language}`)}` },
            ],
            isError,
          });
        }
        // Auto-index large error output into FTS5 — no data loss
        if (Buffer.byteLength(output) > LARGE_OUTPUT_THRESHOLD) {
          trackIndexed(Buffer.byteLength(output));
          return trackResponse("ctx_execute", {
            content: [
              { type: "text" as const, text: `${echo}${intentSearch(output, "errors failures exceptions", isError ? `execute:${language}:error` : `execute:${language}`)}` },
            ],
            isError,
          });
        }
        return trackResponse("ctx_execute", {
          content: [
            { type: "text" as const, text: `${echo}${output}` },
          ],
          isError,
        });
      }

      const stdout = result.stdout || "(no output)";

      // Intent-driven search: if intent provided and output is large enough
      if (intent && intent.trim().length > 0 && Buffer.byteLength(stdout) > INTENT_SEARCH_THRESHOLD) {
        trackIndexed(Buffer.byteLength(stdout));
        return trackResponse("ctx_execute", {
          content: [
            { type: "text" as const, text: `${echo}${intentSearch(stdout, intent, `execute:${language}`)}` },
          ],
        });
      }

      // Auto-index large stdout into FTS5 — return pointer, not raw content
      if (Buffer.byteLength(stdout) > LARGE_OUTPUT_THRESHOLD) {
        const indexed = indexStdout(stdout, `execute:${language}`);
        // Prepend echo to the first text content so provenance still surfaces
        const echoed = {
          ...indexed,
          content: indexed.content.map((c, i) =>
            i === 0 && c.type === "text"
              ? { ...c, text: `${echo}${(c as { text: string }).text}` }
              : c,
          ),
        };
        return trackResponse("ctx_execute", echoed);
      }

      return trackResponse("ctx_execute", {
        content: [
          { type: "text" as const, text: `${echo}${stdout}` },
        ],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return trackResponse("ctx_execute", {
        content: [
          { type: "text" as const, text: `Runtime error: ${message}` },
        ],
        isError: true,
      });
    }
  },
);

// ─────────────────────────────────────────────────────────
// Helper: index stdout into FTS5 knowledge base
// ─────────────────────────────────────────────────────────

function indexStdout(
  stdout: string,
  source: string,
): { content: Array<{ type: "text"; text: string }> } {
  const store = getStore();
  trackIndexed(Buffer.byteLength(stdout));
  const indexed = store.index({ content: stdout, source, attribution: currentAttribution() });
  return {
    content: [
      {
        type: "text" as const,
        text: `Indexed ${indexed.totalChunks} sections (${indexed.codeChunks} with code) from: ${indexed.label}\nUse ctx_search(queries: ["..."]) to query this content. Use source: "${indexed.label}" to scope results.`,
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────
// Helper: intent-driven search on execution output
// ─────────────────────────────────────────────────────────

const INTENT_SEARCH_THRESHOLD = 5_000; // bytes — ~80-100 lines
const LARGE_OUTPUT_THRESHOLD = 102_400; // 100KB — auto-index into FTS5, return pointer

function intentSearch(
  stdout: string,
  intent: string,
  source: string,
  maxResults: number = 5,
): string {
  const totalLines = stdout.split("\n").length;
  const totalBytes = Buffer.byteLength(stdout);

  // Index into the PERSISTENT store so user can ctx_search() later
  const persistent = getStore();
  const indexed = persistent.indexPlainText(stdout, source, undefined, currentAttribution());

  // Search the persistent store directly (porter → trigram → fuzzy)
  let results = persistent.searchWithFallback(intent, maxResults, source);

  // Extract distinctive terms as vocabulary hints for the LLM
  const distinctiveTerms = persistent.getDistinctiveTerms(indexed.sourceId);

  if (results.length === 0) {
    const lines = [
      `Indexed ${indexed.totalChunks} sections from "${source}" into knowledge base.`,
      `No sections matched intent "${intent}" in ${totalLines}-line output (${(totalBytes / 1024).toFixed(1)}KB).`,
    ];
    if (distinctiveTerms.length > 0) {
      lines.push("");
      lines.push(`Searchable terms: ${distinctiveTerms.join(", ")}`);
    }
    lines.push("");
    lines.push("Use ctx_search(queries: [...]) to explore the indexed content.");
    return lines.join("\n");
  }

  // Return ONLY titles + first-line previews — not full content
  const lines = [
    `Indexed ${indexed.totalChunks} sections from "${source}" into knowledge base.`,
    `${results.length} sections matched "${intent}" (${totalLines} lines, ${(totalBytes / 1024).toFixed(1)}KB):`,
    "",
  ];

  for (const r of results) {
    const preview = r.content.split("\n")[0].slice(0, 120);
    lines.push(`  - ${r.title}: ${preview}`);
  }

  if (distinctiveTerms.length > 0) {
    lines.push("");
    lines.push(`Searchable terms: ${distinctiveTerms.join(", ")}`);
  }

  lines.push("");
  lines.push("Use ctx_search(queries: [...]) to retrieve full content of any section.");

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────
// Tool: execute_file
// ─────────────────────────────────────────────────────────

server.registerTool(
  "ctx_execute_file",
  {
    // #852: the host's MCP approval prompt renders only the tool name/title +
    // raw args — the title is the one server-controlled signal, so make it
    // unambiguously announce code execution + file read for the reviewer.
    title: "Run code over a file (executes code, reads the given path)",
    // #846: runs arbitrary code over a file in a child process with full
    // network access and the parent's filesystem permissions.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description: `Read a file into a FILE_CONTENT variable in a separate subprocess and run code over it. Only what you console.log() enters your conversation — the file bytes stay in the subprocess.

Think-in-Code applied to file-level analysis: Reading the whole file means every byte enters your conversation memory and costs reasoning capacity for the rest of the session. Running code over it here lets you keep the raw bytes out and only the derived answer in. Same principle as ctx_execute, scoped to one named file via the FILE_CONTENT variable.

WHEN:
  - You want to KNOW SOMETHING ABOUT a file (line count, matches of a pattern, parsed structure, statistical aggregate) without needing to SEE all of it
  - The file is structured (CSV, JSON, log, code) and a code-level derivation is cheaper than reading verbatim
  - The file is large enough that reading the full content would burn meaningful conversation memory you need for the actual work
  - The derivation may itself produce a large output you want recall-by-topic on later — pass an \`intent\` string; outputs over ~5KB are auto-indexed and only matching sections come back, retrievable via ctx_search

WHEN NOT:
  - You intend to EDIT the file — use Read so the subsequent Edit can match the exact text
  - You only need one specific line and you know its offset — Read with offset/limit is the simplest path
  - The file is small AND you will consume all of it for understanding/editing — Read directly

RETURNS:
  Only what your code prints. The FILE_CONTENT variable holds the raw bytes inside the sandbox; nothing else leaves. When \`intent\` is set and output exceeds the auto-index threshold, the response carries searchable section titles + previews instead of the raw stdout.

EXAMPLE: ctx_execute_file(path: "huge.log", language: "javascript", code: "const errs = FILE_CONTENT.split('\\\\n').filter(l => /ERROR|FATAL/.test(l)); console.log(\`\${errs.length} error lines\`); console.log(errs.slice(-5).join('\\\\n'))")
EXAMPLE: ctx_execute_file(path: "data.csv", language: "javascript", code: "const rows = FILE_CONTENT.split('\\\\n'); console.log(\`rows: \${rows.length - 1}, header: \${rows[0]}\`)")`,
    inputSchema: z.object({
      path: z
        .string()
        .describe("Absolute file path or relative to project root"),
      language: z
        .enum([
          "javascript",
          "typescript",
          "python",
          "shell",
          "ruby",
          "go",
          "rust",
          "php",
          "perl",
          "r",
          "elixir",
          "csharp",
        ])
        .describe("Runtime language"),
      code: z
        .string()
        .describe(
          "Code to process FILE_CONTENT (file_content in Elixir). Print summary via console.log/print/echo/IO.puts/Console.WriteLine.",
        ),
      timeout: z
        .coerce.number()
        .optional()
        .describe("Max execution time in ms. When omitted, no server-side timer fires — the MCP host's RPC timeout governs."),
      intent: z
        .string()
        .optional()
        .describe(
          "What you're looking for in the output. When provided and output is large (>5KB), " +
          "returns only matching sections via BM25 search instead of truncated output.",
        ),
    }),
  },
  async ({ path, language, code, timeout, intent }) => {
    // Security (#852): confine the processed file to the project root so
    // ctx_execute_file cannot be used to escape the host's sandbox/permission
    // controls. Runs before the deny-glob check — boundary first, then policy.
    const boundaryDenied = checkProjectBoundary(path, "ctx_execute_file");
    if (boundaryDenied) return boundaryDenied;

    // Security: check file path against Read deny patterns
    const pathDenied = checkFilePathDenyPolicy(path, "ctx_execute_file");
    if (pathDenied) return pathDenied;

    // Security: check code parameter against Bash deny patterns
    if (language === "shell") {
      const codeDenied = checkDenyPolicy(code, "execute_file");
      if (codeDenied) return codeDenied;
    } else {
      const codeDenied = checkNonShellDenyPolicy(code, language, "execute_file");
      if (codeDenied) return codeDenied;
    }

    try {
      const effTimeout = resolveExecTimeout(timeout);
      const result = await executor.executeFile({
        path,
        language,
        code,
        timeout: effTimeout,
      });

      // Echo path + executed source code before stdout for audit/debug
      // (Issues #717 + #736).
      const echo = buildExecuteEcho(language, code, path);

      if (result.timedOut) {
        return trackResponse("ctx_execute_file", {
          content: [
            {
              type: "text" as const,
              text: `${echo}Timed out processing ${path} after ${effTimeout}ms`,
            },
          ],
          isError: true,
        });
      }

      if (result.exitCode !== 0) {
        const { isError, output } = classifyNonZeroExit({
          language, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
        });
        if (intent && intent.trim().length > 0 && Buffer.byteLength(output) > INTENT_SEARCH_THRESHOLD) {
          trackIndexed(Buffer.byteLength(output));
          return trackResponse("ctx_execute_file", {
            content: [
              { type: "text" as const, text: `${echo}${intentSearch(output, intent, isError ? `file:${path}:error` : `file:${path}`)}` },
            ],
            isError,
          });
        }
        // Auto-index large error output into FTS5 — no data loss
        if (Buffer.byteLength(output) > LARGE_OUTPUT_THRESHOLD) {
          trackIndexed(Buffer.byteLength(output));
          return trackResponse("ctx_execute_file", {
            content: [
              { type: "text" as const, text: `${echo}${intentSearch(output, "errors failures exceptions", isError ? `file:${path}:error` : `file:${path}`)}` },
            ],
            isError,
          });
        }
        return trackResponse("ctx_execute_file", {
          content: [
            { type: "text" as const, text: `${echo}${output}` },
          ],
          isError,
        });
      }

      const stdout = result.stdout || "(no output)";

      if (intent && intent.trim().length > 0 && Buffer.byteLength(stdout) > INTENT_SEARCH_THRESHOLD) {
        trackIndexed(Buffer.byteLength(stdout));
        return trackResponse("ctx_execute_file", {
          content: [
            { type: "text" as const, text: `${echo}${intentSearch(stdout, intent, `file:${path}`)}` },
          ],
        });
      }

      // Auto-index large stdout into FTS5 — return pointer, not raw content
      if (Buffer.byteLength(stdout) > LARGE_OUTPUT_THRESHOLD) {
        const indexed = indexStdout(stdout, `file:${path}`);
        const echoed = {
          ...indexed,
          content: indexed.content.map((c, i) =>
            i === 0 && c.type === "text"
              ? { ...c, text: `${echo}${(c as { text: string }).text}` }
              : c,
          ),
        };
        return trackResponse("ctx_execute_file", echoed);
      }

      return trackResponse("ctx_execute_file", {
        content: [
          { type: "text" as const, text: `${echo}${stdout}` },
        ],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return trackResponse("ctx_execute_file", {
        content: [
          { type: "text" as const, text: `Runtime error: ${message}` },
        ],
        isError: true,
      });
    }
  },
);

// ─────────────────────────────────────────────────────────
// Tool: index
// ─────────────────────────────────────────────────────────

server.registerTool(
  "ctx_index",
  {
    title: "Index Content",
    // #846: writes content into the local FTS5 store (additive, not destructive;
    // re-indexing the same content adds rows, so not idempotent). No network.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    description: `Store content in a searchable knowledge base (BM25 over FTS5). Splits markdown by headings, keeps code blocks intact, and persists the raw chunks. The full content stays in storage — retrieve any section on-demand via ctx_search; nothing is summarized or truncated.

WHEN:
  - Documentation from Context7, Skills, or MCP tools (API docs, framework guides, code examples)
  - API references (endpoint details, parameter specs, response schemas)
  - MCP tools/list output (exact tool signatures and descriptions)
  - Skill prompts and instructions that are too large to keep verbatim in conversation
  - README files, migration guides, changelog entries
  - Any content with code examples you may need to reference precisely later

WHEN NOT:
  - Log files, test output, CSV, or build output — use ctx_execute_file, which processes in-sandbox without persisting bytes
  - Single-use ephemeral content you will not query later — keep it inline if it fits, or ctx_execute_file it

RETURNS:
  Indexing metadata: chunk counts (total, code-bearing), source label, and the exact ctx_search call shape to query the indexed content. Raw content is NOT echoed back — it lives in storage, retrievable via ctx_search(source: "<label>"). When \`path\` is provided, a content hash is stored so ctx_search results auto-flag staleness on future calls.

EXAMPLE: ctx_index(content: "# React useEffect\\n\\nThe Effect Hook lets you ...", source: "react-useeffect-docs")
EXAMPLE: ctx_index(path: "/path/to/large-spec.md", source: "openapi-v2-spec")`,
    inputSchema: z.object({
      content: z
        .string()
        .optional()
        .describe(
          "Raw text/markdown to index. Provide this OR path, not both.",
        ),
      path: z
        .string()
        .optional()
        .describe(
          "File OR directory path to read and index (content never enters context). Provide this OR content. Directory paths trigger a bounded recursive walk (#687).",
        ),
      source: z
        .string()
        .optional()
        .describe(
          "Label for the indexed content (e.g., 'Context7: React useEffect', 'Skill: frontend-design')",
        ),
      include: z.array(z.string()).optional().describe(
        "Directory-only: glob patterns to include (default: all matching extensions).",
      ),
      exclude: z.array(z.string()).optional().describe(
        "Directory-only: glob patterns to exclude. Merged with defaults (node_modules, .git, dist, build, .next, coverage, .venv, __pycache__, .DS_Store).",
      ),
      maxDepth: z.number().int().min(0).optional().describe(
        "Directory-only: max recursion depth from root (default: 5).",
      ),
      maxFiles: z.number().int().min(1).optional().describe(
        "Directory-only: hard cap on files indexed (default: 200) — FTS5 blow-up guard.",
      ),
      extensions: z.array(z.string()).optional().describe(
        "Directory-only: allowed file extensions (default: .md .mdx .txt .json .yaml .yml .ts .tsx .js .jsx .py .rs .go .sh).",
      ),
      respectGitignore: z.boolean().optional().describe(
        "Directory-only: apply nearest .gitignore (default: true).",
      ),
      followSymlinks: z.boolean().optional().describe(
        "Directory-only: follow directory symlinks (default: false — cycle hazard + escape risk).",
      ),
    }),
  },
  async ({ content, path, source, include, exclude, maxDepth, maxFiles, extensions, respectGitignore, followSymlinks }) => {
    if (!content && !path) {
      return trackResponse("ctx_index", {
        content: [
          {
            type: "text" as const,
            text: "Error: Either content or path must be provided",
          },
        ],
        isError: true,
      });
    }

    // Apply Read deny-policy to prevent indexing sensitive files into the
    // FTS5 store, which would otherwise be queryable via ctx_search and
    // exfiltrate content into the model's context (issue #442). Mirrors the
    // check ctx_execute_file already performs.
    if (path) {
      const pathDenied = checkFilePathDenyPolicy(path, "ctx_index");
      if (pathDenied) return pathDenied;
    }

    try {
      const resolvedPath = path ? resolveProjectPath(path) : undefined;

      // Directory dispatch (#687, reported by @matiasduartee). When the
      // resolved path is a directory, walk it bounded and re-enter `index()`
      // per-file so the security gate at store.ts:845 (TOCTOU defense from
      // #442 round-3) keeps running for every file.
      //
      // Root-level symlink defense: the deny-glob check above ran on the
      // user-supplied `path`. If `path` is a symlink whose target lands in
      // a sensitive directory (e.g. `/tmp/link -> /etc`), statSync would
      // happily report directory and walkDirectoryDetailed would
      // realpathSync internally, walking /etc with the user's deny globs
      // bound to /tmp/link instead of the real target. Detect the symlink
      // with lstatSync, follow it once, and re-apply the deny check
      // against the realpath so the user's deny globs see the actual
      // walk root.
      if (resolvedPath && existsSync(resolvedPath)) {
        const lst = lstatSync(resolvedPath);
        if (lst.isSymbolicLink()) {
          let realTarget: string;
          try {
            realTarget = realpathSync(resolvedPath);
          } catch {
            return trackResponse("ctx_index", {
              content: [{ type: "text" as const, text: "Error: symlink target could not be resolved." }],
            });
          }
          if (realTarget !== resolvedPath) {
            const realDenied = checkFilePathDenyPolicy(realTarget, "ctx_index");
            if (realDenied) return realDenied;
          }
        }
      }
      if (resolvedPath && existsSync(resolvedPath) && statSync(resolvedPath).isDirectory()) {
        const store = getStore();
        const projectDir = getProjectDir();
        const denyGlobs = readToolDenyPatterns("Read", projectDir);
        const isWin32 = process.platform === "win32";
        const perFileDeny = (absPath: string): boolean => {
          try {
            return evaluateFilePath(absPath, denyGlobs, isWin32, projectDir).denied;
          } catch {
            return false; // fail-open consistent with checkFilePathDenyPolicy
          }
        };
        const dirResult = store.indexDirectory({
          path: resolvedPath,
          source: source ?? resolvedPath,
          attribution: currentAttribution(),
          perFileDeny,
          include,
          exclude,
          maxDepth,
          maxFiles,
          extensions,
          respectGitignore,
          followSymlinks,
        });
        const capNote = dirResult.capped
          ? ` (cap reached — only first ${dirResult.filesIndexed} of ${dirResult.totalSeen}+ files; raise maxFiles to index more)`
          : "";
        const denyNote = dirResult.denied > 0
          ? ` (${dirResult.denied} file${dirResult.denied === 1 ? "" : "s"} blocked by Read deny policy)`
          : "";
        const failNote = dirResult.failed > 0
          ? ` (${dirResult.failed} file${dirResult.failed === 1 ? "" : "s"} failed to read)`
          : "";
        return trackResponse("ctx_index", {
          content: [
            {
              type: "text" as const,
              text: `Indexed ${dirResult.filesIndexed} file${dirResult.filesIndexed === 1 ? "" : "s"} (${dirResult.totalChunks} sections) from directory: ${dirResult.label}${capNote}${denyNote}${failNote}\nUse ctx_search(queries: ["..."]) to query this content.`,
            },
          ],
        });
      }

      // Track the raw bytes being indexed (content or file)
      if (content) trackIndexed(Buffer.byteLength(content));
      else if (resolvedPath) {
        try {
          const fs = await import("fs");
          trackIndexed(fs.readFileSync(resolvedPath).byteLength);
        } catch { /* ignore — file read errors handled by store */ }
      }
      const store = getStore();
      const result = store.index({ content, path: resolvedPath, source: source ?? resolvedPath, attribution: currentAttribution() });

      return trackResponse("ctx_index", {
        content: [
          {
            type: "text" as const,
            text: `Indexed ${result.totalChunks} sections (${result.codeChunks} with code) from: ${result.label}\nUse ctx_search(queries: ["..."]) to query this content. Use source: "${result.label}" to scope results.`,
          },
        ],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return trackResponse("ctx_index", {
        content: [
          { type: "text" as const, text: `Index error: ${message}` },
        ],
        isError: true,
      });
    }
  },
);

// ─────────────────────────────────────────────────────────
// Tool: search — progressive throttling
// ─────────────────────────────────────────────────────────

// Track search calls per N-second window for progressive throttling.
// Defaults preserve the historical behavior (60s window, soft-cap at 3
// calls, hard-block at 8). All three thresholds are overridable via env
// vars so users can loosen or tighten the policy without forking. Invalid
// values (non-positive numbers, NaN) fall back to the default to avoid
// silently disabling the protection.
function readPositiveEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

const SEARCH_WINDOW_MS = readPositiveEnv("CONTEXT_MODE_SEARCH_WINDOW_MS", 60_000);
const SEARCH_MAX_RESULTS_AFTER = readPositiveEnv("CONTEXT_MODE_SEARCH_MAX_RESULTS_AFTER", 3); // after N calls: 1 result per query
const SEARCH_BLOCK_AFTER = readPositiveEnv("CONTEXT_MODE_SEARCH_BLOCK_AFTER", 8); // after N calls: refuse, demand batching

// #769: progressive throttle bucketed PER agent-context, not machine-global.
// Concurrent subagents share ONE MCP server process; a single global counter
// summed their independent searches into one budget and hard-blocked
// legitimate parallel fan-out. The guard keys each actor's window separately
// so single-actor flood protection is preserved while fan-out is not starved.
const searchFloodGuard = new FloodGuard({
  windowMs: SEARCH_WINDOW_MS,
  softCapAfter: SEARCH_MAX_RESULTS_AFTER,
  blockAfter: SEARCH_BLOCK_AFTER,
});

/**
 * Per-agent flood-guard key. Each concurrent subagent in a Claude Code
 * Task/Workflow fan-out runs under its own session id (written to SessionDB
 * via hooks), so currentAttribution().sessionId is the per-agent discriminator
 * already available MCP-side. Falls back to a single shared bucket when no
 * identity is resolvable (preserves today's single-threaded behaviour).
 */
function searchFloodGuardKey(): string {
  try {
    return currentAttribution()?.sessionId ?? "__default__";
  } catch {
    return "__default__";
  }
}

/**
 * Defensive coercion: parse stringified JSON arrays, AND lift a bare
 * non-empty string into a single-element array.
 *
 * Two shapes show up from the wild:
 *   1. `"[\"a\",\"b\"]"` — Claude Code double-serialization bug
 *      (https://github.com/anthropics/claude-code/issues/34520).
 *   2. `"single query"` — some LLM providers / OpenCode's native plugin
 *      bridge deliver a single string when the schema expects `string[]`
 *      (issue #627). v1.0.139 (#621) made the bridge run the Zod schema,
 *      so this now surfaces as `Expected array, received string`. The
 *      ergonomic recovery is to treat it as `["single query"]`.
 *
 * An empty string is intentionally NOT lifted — empty input should still
 * fail Zod's `.min(1)` check rather than masquerade as `[""]`.
 */
function coerceJsonArray(val: unknown): unknown {
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed.length === 0) return val; // let zod produce "non-empty" error
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* fall through — not JSON, treat as bare-string lift */ }
    // Bare-string lift (#627): single query delivered as a plain string.
    return [val];
  }
  return val;
}

/**
 * Defensive coercion: accept the string literals "true"/"false" as
 * booleans. The OpenCode native plugin bridge (and several LLM providers'
 * tool-call JSON) stringifies primitives — `background:"false"` instead
 * of `background:false`, `confirm:"true"` instead of `confirm:true`.
 *
 * We deliberately do NOT use `z.coerce.boolean()` for boolean fields:
 * `Boolean("false")` is `true`, so Zod's coerce path silently flips the
 * meaning. This helper recognises only the documented literal forms and
 * passes anything else through untouched so Zod surfaces the right error.
 *
 * Fixes #627.
 */
function coerceBoolean(val: unknown): unknown {
  if (typeof val === "string") {
    const t = val.trim().toLowerCase();
    if (t === "true") return true;
    if (t === "false") return false;
  }
  return val;
}

/**
 * Coerce commands array: handles double-serialization AND the case where
 * the model passes plain command strings instead of {label, command} objects.
 */
function coerceCommandsArray(val: unknown): unknown {
  const arr = coerceJsonArray(val);
  if (Array.isArray(arr)) {
    return arr.map((item, i) =>
      typeof item === "string" ? { label: `cmd_${i + 1}`, command: item } : item
    );
  }
  return arr;
}

/**
 * Everything the extracted tool modules need from this file.
 *
 * Built fresh per registration so the getters close over the live bindings —
 * the detected adapter in particular is still null at import time.
 */
function toolDeps(): ToolDeps {
  return {
    server,
    getStore,
    getProjectDir,
    getSessionDir,
    getStorePath,
    getSessionDbPath,
    trackResponse,
    extractSnippet,
    semanticStatusHint,
    detectedAdapter,
    trackIndexed,
    currentAttribution,
    checkDenyPolicy,
    coerceJsonArray,
    coerceCommandsArray,
    coerceBoolean,
    searchFloodGuard,
    searchFloodGuardKey,
    SEARCH_MAX_RESULTS_AFTER,
    SEARCH_BLOCK_AFTER,
  };
}

/**
 * The batch tools' extra wiring, on top of {@link toolDeps}.
 *
 * `runBatchCommands` arrives pre-bound to the executor and to the NODE_OPTIONS
 * preload prefix, so the handler never has to know that FS-read accounting is
 * implemented by injecting an inline shell env var. The other three are plain
 * pass-throughs of helpers this file still owns.
 */
function batchToolDeps(): BatchToolDeps {
  return {
    ...toolDeps(),
    runBatchCommands: (commands, opts) => runBatchCommands(
      commands,
      { ...opts, nodeOptsPrefix: buildBatchNodeOptionsPrefix(runtimes.shell, CM_FS_PRELOAD) },
      executor,
    ),
    resolveExecTimeout,
    truncateCommandForEcho,
    formatBatchQueryResults,
  };
}

/**
 * The fetch tool's extra wiring, on top of {@link toolDeps}.
 *
 * `buildFetchCode` is passed rather than imported because it stayed in this
 * file (see the section above it for why), and the executor is passed because
 * there is exactly one per process — the shutdown path drains its
 * backgrounded-process registry, and a second instance would leak children.
 */
function fetchToolDeps(): FetchToolDeps {
  return {
    ...toolDeps(),
    executor,
    buildFetchCode,
  };
}

/**
 * The stats tool's extra wiring, on top of {@link toolDeps}.
 *
 * `latestVersion` is a getter for the same reason `detectedAdapter` is: the
 * npm check runs in the background and lands long after registration.
 */
function opsToolDeps(): OpsToolDeps {
  return {
    ...toolDeps(),
    VERSION,
    latestVersion: () => _latestVersion,
    semanticIndexReport,
    rollUpStaleStatsFiles,
  };
}

// ctx_search lives in src/tools/search.ts. Registration happens here, in the
// same position it always did — MCP hosts render the tool list in registration
// order, and tests/core/tool-registration.test.ts pins it.
registerCtxSearch(toolDeps());

// ─────────────────────────────────────────────────────────
// Turndown path resolution (external dep, like better-sqlite3)
// ─────────────────────────────────────────────────────────

let _turndownPath: string | null = null;
let _gfmPluginPath: string | null = null;

function resolveTurndownPath(): string {
  if (!_turndownPath) {
    const require = createRequire(import.meta.url);
    _turndownPath = require.resolve("turndown");
  }
  return _turndownPath;
}

function resolveGfmPluginPath(): string {
  if (!_gfmPluginPath) {
    const require = createRequire(import.meta.url);
    _gfmPluginPath = require.resolve("turndown-plugin-gfm");
  }
  return _gfmPluginPath;
}

// ─────────────────────────────────────────────────────────
// The fetch subprocess program — the tool is in src/tools/fetch.ts
// ─────────────────────────────────────────────────────────
// Only the program the child runs stayed here. It is upstream's code nearly
// line for line, and upstream keeps developing the ladder inside it, so
// moving it to the tool module would turn every one of their edits into a
// delete/modify conflict. The parent-side policy, the cache and the tool
// registration all live in src/tools/fetch.ts, which receives this through
// FetchToolDeps.

// The tool's own public surface, re-exported so `src/server.ts` remains the
// one import path callers and tests already use.
export {
  isProxyAllowed,
  buildFetchEnv,
  classifyExtraction,
  classifyIp,
  parseLadderTried,
  describeRung,
  type ExtractionVerdict,
} from "./tools/fetch.js";

// Subprocess code that fetches a URL, detects Content-Type, and outputs a
// __CM_CT__:<type> marker on the first line so the handler can route to the
// appropriate indexing strategy.  HTML is converted to markdown via Turndown.
//
// SECOND stdout line: the byte length of the response body as received, before
// any conversion. The parent needs it to tell a JavaScript-rendered shell from
// a genuinely short document — see classifyExtraction(). The first line keeps
// its exact historical shape so the `header === "__CM_CT__:json"` comparisons
// downstream are untouched; the parent reads line 0 as the header and treats a
// missing or unparseable line 1 as "no evidence" rather than as a failure.
export function buildFetchCode(url: string, outputPath: string): string {
  const turndownPath = JSON.stringify(resolveTurndownPath());
  const gfmPath = JSON.stringify(resolveGfmPluginPath());
  const escapedOutputPath = JSON.stringify(outputPath);
  // Embed classifyIp into the subprocess so the connect-time DNS lookup is
  // re-validated with the same policy as ssrfGuard. Without this, an attacker
  // can serve a public IP for the parent's pre-flight ssrfGuard lookup and
  // then a blocked IP (e.g. 169.254.169.254 IMDS) for the subprocess fetch's
  // own lookup — classic DNS rebinding across the parent/child boundary.
  //
  // CRITICAL: bundlers (esbuild) rename top-level identifiers — `classifyIp`
  // becomes e.g. `_h` in server.bundle.mjs. `classifyIp.toString()` returns
  // the renamed source `function _h(t){...}`, but the embedded subprocess
  // template references the literal name `classifyIp` (and the function's
  // own internal recursion is also `_h(...)`). Result: the subprocess sees
  // `function _h(t){...; return _h(...)}` injected, then references to
  // `classifyIp` blow up with `ReferenceError: classifyIp is not defined`.
  //
  // Fix: emit `var <fnName> = <fn-expr>; var classifyIp = <fnName>;`. The
  // named function expression preserves recursion under whatever name the
  // bundler chose, and the alias re-exposes the canonical `classifyIp`
  // identifier the rest of the embedded script depends on.
  const classifyIpInner = classifyIp.toString();
  const classifyIpFnName = classifyIp.name || "classifyIp";
  const classifyIpSrc =
    classifyIpFnName === "classifyIp"
      ? `var classifyIp = ${classifyIpInner};`
      : `var ${classifyIpFnName} = ${classifyIpInner};\nvar classifyIp = ${classifyIpFnName};`;
  // Same injection, same bundler hazard, for the shell classifier. The
  // subprocess must decide "did rung 1 actually produce an article?" with the
  // arithmetic the parent ships, not a second copy of it that can drift.
  const classifyExtractionInner = classifyExtraction.toString();
  const classifyExtractionFnName = classifyExtraction.name || "classifyExtraction";
  const classifyExtractionSrc =
    classifyExtractionFnName === "classifyExtraction"
      ? `var classifyExtraction = ${classifyExtractionInner};`
      : `var ${classifyExtractionFnName} = ${classifyExtractionInner};\nvar classifyExtraction = ${classifyExtractionFnName};`;
  const strictMode = process.env.CTX_FETCH_STRICT === "1";
  const proxyAllowed = isProxyAllowed();
  return `
const TurndownService = require(${turndownPath});
const { gfm } = require(${gfmPath});
const fs = require('fs');
const dns = require('no' + 'de:dns');
const dnsPromises = require('no' + 'de:dns/promises');
const url = ${JSON.stringify(url)};
const outputPath = ${escapedOutputPath};

// Strip proxy env vars from this subprocess only. A configured outbound
// proxy (HTTP_PROXY / HTTPS_PROXY / ALL_PROXY) would route fetch through
// an arbitrary target — DNS resolution happens at the proxy and the
// in-subprocess DNS rebinding guard never sees the rebound IP.
//
// #1039: on a corporate network the proxy is the ONLY route out, so the
// unconditional strip turned every ctx_fetch_and_index call into a
// connection timeout with no explanation. Stripping is still the default;
// PROXY_ALLOWED flips it, and the operator who sets CONTEXT_MODE_ALLOW_PROXY
// accepts that DNS now resolves at the proxy (the rebinding guard below
// still runs, but it can only see what this process resolves itself).
const PROXY_ALLOWED = ${JSON.stringify(proxyAllowed)};
if (!PROXY_ALLOWED) {
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.ALL_PROXY;
  delete process.env.http_proxy;
  delete process.env.https_proxy;
  delete process.env.all_proxy;
  delete process.env.npm_config_proxy;
  delete process.env.npm_config_https_proxy;
}

${classifyIpSrc}

${classifyExtractionSrc}

const STRICT = ${JSON.stringify(strictMode)};

// SSRF rebinding defense: every dns.lookup call inside this subprocess
// (including the one undici performs to connect the fetch socket) is
// re-validated against the same policy ssrfGuard runs in the parent.
// Even if a hostname rebinds between the parent's pre-flight check and
// the subprocess's actual connect, the connect-time lookup re-classifies
// every returned record and aborts before TCP if any verdict is "block".
const _origLookup = dns.lookup;
dns.lookup = function patchedLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (typeof options === 'number') { options = { family: options }; }
  const wantAll = options && options.all;
  const opts = Object.assign({}, options || {}, { all: true, verbatim: true });
  _origLookup(hostname, opts, function(err, records) {
    if (err) return callback(err);
    if (!Array.isArray(records)) {
      records = [{ address: records, family: (options && options.family) || 4 }];
    }
    for (var i = 0; i < records.length; i++) {
      var verdict = classifyIp(records[i].address);
      if (verdict === 'block' || (STRICT && verdict === 'private')) {
        return callback(new Error(
          'SSRF blocked at connect-time: ' + hostname +
          ' resolves to ' + records[i].address +
          ' (' + verdict + ')'
        ));
      }
    }
    if (wantAll) callback(null, records);
    else callback(null, records[0].address, records[0].family);
  });
};

// dns/promises is a separate function reference. Patching dns.lookup does
// NOT affect dnsPromises.lookup. Today undici's connect path uses callback
// dns.lookup so default fetch is covered, but the invariant is fragile —
// any future undici switch (or user code calling dnsPromises.lookup
// directly) would bypass the guard. Patch both to keep the contract.
const _origPromisesLookup = dnsPromises.lookup;
dnsPromises.lookup = async function patchedPromisesLookup(hostname, options) {
  const opts = Object.assign({}, options || {}, { all: true, verbatim: true });
  const records = await _origPromisesLookup(hostname, opts);
  const list = Array.isArray(records) ? records : [records];
  for (var i = 0; i < list.length; i++) {
    var verdict = classifyIp(list[i].address);
    if (verdict === 'block' || (STRICT && verdict === 'private')) {
      throw new Error(
        'SSRF blocked at connect-time: ' + hostname +
        ' resolves to ' + list[i].address + ' (' + verdict + ')'
      );
    }
  }
  return options && options.all
    ? list
    : { address: list[0].address, family: list[0].family };
};

// dns.resolve4 / dns.resolve6 use a different code path (no getaddrinfo,
// no /etc/hosts) than dns.lookup — they must be patched separately or the
// guard is trivially bypassed by any caller using dns.resolve* directly.
['resolve4', 'resolve6'].forEach(function patchResolve(name) {
  const _origResolve = dns[name];
  dns[name] = function patchedResolve(hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = undefined; }
    _origResolve.call(dns, hostname, options || {}, function(err, addrs) {
      if (err) return cb(err);
      var withTtl = options && options.ttl;
      for (var i = 0; i < addrs.length; i++) {
        var ip = withTtl ? addrs[i].address : addrs[i];
        var v = classifyIp(ip);
        if (v === 'block' || (STRICT && v === 'private')) {
          return cb(new Error(
            'SSRF blocked at connect-time: ' + hostname +
            ' resolves to ' + ip + ' (' + v + ')'
          ));
        }
      }
      cb(null, addrs);
    });
  };
});

// Generic dns.resolve is a polymorphic dispatcher (rrtype-driven). Internally
// Node delegates to dns.resolve4/dns.resolve6 for A/AAAA, but the patches
// above hook the *exported* references — Node's internal dispatcher holds
// captured originals and bypasses our patch. Patch the wrapper explicitly:
// classify A/AAAA records the same way; pass through CNAME/MX/TXT/SRV/etc.
const _origResolveGeneric = dns.resolve;
dns.resolve = function patchedResolveGeneric(hostname, rrtype, cb) {
  if (typeof rrtype === 'function') { cb = rrtype; rrtype = 'A'; }
  _origResolveGeneric.call(dns, hostname, rrtype, function(err, records) {
    if (err) return cb(err);
    if ((rrtype === 'A' || rrtype === 'AAAA') && Array.isArray(records)) {
      for (var i = 0; i < records.length; i++) {
        var ip = records[i];
        var v = classifyIp(ip);
        if (v === 'block' || (STRICT && v === 'private')) {
          return cb(new Error(
            'SSRF blocked at connect-time: ' + hostname +
            ' resolves to ' + ip + ' (' + v + ')'
          ));
        }
      }
    }
    cb(null, records);
  });
};

function emit(ct, content, sourceBytes, route, rung, tried) {
  // Write content to file to bypass executor stdout truncation (100KB limit).
  // Only the content-type marker goes to stdout.
  fs.writeFileSync(outputPath, content);
  console.log('__CM_CT__:' + ct);
  // Line 2: bytes received off the wire, pre-conversion. Lets the parent
  // compute extraction yield. Emitted unconditionally so "absent" means
  // "old bundle", not "zero".
  console.log(String(typeof sourceBytes === 'number' ? sourceBytes : 0));
  // Line 3: which route produced the document. 'markdown' means the SITE
  // served a machine-readable version of the page and no extraction is
  // needed; 'html' means we converted it and the parent must classify it.
  // A missing line 3 means "old bundle" and the parent assumes 'html'.
  console.log(String(route || 'html'));
  // Line 4: WHICH RUNG OF THE LADDER ANSWERED. The whole point of a ladder is
  // that a reader can tell which step paid, so this is reported on every
  // fetch, success or refusal — never inferred from byte counts.
  console.log(String(rung || 'unknown'));
  // Line 5: the rung-2 URLs actually requested, so a refusal can name them
  // instead of telling the caller to go look for files we already looked for.
  // Empty array when rung 2 never ran (the cheap rungs answered).
  console.log(JSON.stringify(tried || []));
}

// Route 1 of the order of operations: ask for the machine-readable version of
// the page on the SAME request we were already making. Costs zero extra round
// trips. Measured 2026-08-12 — docs.stripe.com returns 1,846,885 B of HTML to
// a plain request and 11,744 B of pure article to this one; GitBook, Mintlify,
// Resend, Polygon, nextjs.org and developers.cloudflare.com behave the same.
// Sites that do not publish markdown (developer.mozilla.org) simply return
// HTML as before — the q-values keep the request a superset of the old one,
// so there is no site this can newly break.
const ACCEPT_HEADERS = {
  'accept': 'text/markdown, text/x-markdown;q=0.9, text/html;q=0.8, application/xhtml+xml;q=0.8, */*;q=0.5',
};

// Manual redirect handling: a 3xx Location header can rebind the subprocess
// fetch to an alternate host the parent's pre-flight ssrfGuard never saw.
// Even with the connect-time DNS patch, a redirect target that is a literal
// IP (e.g. http://169.254.169.254/) skips getaddrinfo entirely. Walk the
// chain manually so every hop runs through classifyIp before the next fetch.
const MAX_REDIRECTS = 5;
async function fetchWithManualRedirect(initialUrl) {
  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const resp = await fetch(currentUrl, { redirect: 'manual', headers: ACCEPT_HEADERS });
    if (resp.status < 300 || resp.status >= 400) return resp;
    const location = resp.headers.get('location') || resp.headers.get('Location');
    if (!location) return resp;
    if (redirectCount === MAX_REDIRECTS) {
      throw new Error(
        'redirect chain exceeded ' + MAX_REDIRECTS + ' hops, so the walk stopped before the ' +
        'SSRF check could be re-run on another hop. A benign locale or consent redirect loop ' +
        'produces this too (measured on Google devsite hosts, 2026-08-12); it is not by itself ' +
        'evidence of an attack. Fetch the page from a host that does not bounce, or fetch its ' +
        'raw source file directly.'
      );
    }
    let nextParsed;
    try { nextParsed = new URL(location, currentUrl); } catch (e) {
      throw new Error('SSRF blocked: invalid redirect Location: ' + location);
    }
    if (nextParsed.protocol !== 'http:' && nextParsed.protocol !== 'https:') {
      throw new Error('SSRF blocked: redirect to non-http(s) scheme ' + nextParsed.protocol);
    }
    // If the redirect target is a literal IP, classify it directly — no DNS
    // lookup will fire and the connect-time guard would never see it.
    const hostname = nextParsed.hostname.replace(/^\[|\]$/g, '');
    const isIpLiteral = /^[0-9.]+$/.test(hostname) || hostname.includes(':');
    if (isIpLiteral) {
      const verdict = classifyIp(hostname);
      if (verdict === 'block' || (STRICT && verdict === 'private')) {
        throw new Error('SSRF blocked: redirect to ' + hostname + ' (' + verdict + ')');
      }
    } else {
      // Hostname target: resolve and classify every record. The patched
      // dns.lookup also fires on the next fetch's connect, but checking
      // here gives a clearer error and short-circuits before TCP setup.
      const records = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
      for (const rec of records) {
        const verdict = classifyIp(rec.address);
        if (verdict === 'block' || (STRICT && verdict === 'private')) {
          throw new Error(
            'SSRF blocked: redirect target ' + hostname +
            ' resolves to ' + rec.address + ' (' + verdict + ')'
          );
        }
      }
    }
    currentUrl = nextParsed.toString();
  }
  throw new Error('SSRF blocked: redirect chain exceeded ' + MAX_REDIRECTS + ' hops');
}

// Subprocess response-body size cap. A malicious or unexpectedly large
// endpoint reachable through ctx_fetch_and_index would otherwise stream
// gigabytes into resp.text(), then into outputPath, then into the parent
// MCP server's heap via readFileSync. 50 MB is far above typical web
// page / API response sizes (~1-5 MB) but bounded enough to keep parent
// heap survivable. Cap both early via Content-Length and after the read.
const MAX_FETCH_BYTES = 50 * 1024 * 1024;
async function safeText(resp) {
  const cl = parseInt(resp.headers.get('content-length') || '0', 10);
  if (cl > MAX_FETCH_BYTES) {
    throw new Error('Response too large: Content-Length ' + cl + ' exceeds ' + MAX_FETCH_BYTES);
  }
  const text = await resp.text();
  if (text.length > MAX_FETCH_BYTES) {
    throw new Error('Response too large: ' + text.length + ' bytes exceeds ' + MAX_FETCH_BYTES);
  }
  return text;
}

// ── Rung 2 of the ladder: the site's own machine-readable files ──────────
//
// Reached ONLY when the cheaper rungs did not produce an article, so the happy
// path still costs exactly the one request it always did. Two sub-rungs, in
// cost order:
//
//   2a  the '.md' sibling of the page path
//   2b  the origin's llms.txt, followed only when it names a DIFFERENT url for
//       this page than 2a already tried
//
// Measured 2026-08-12 over 36 documentation pages (scripts/measure-fetch-ladder.cjs):
// developer.apple.com/documentation/swiftui/view converts to 36 B of text from
// a 17,486 B shell — the hardest measured SPA — and its '.md' sibling returns
// 5,593 B of the real article. reactnative.dev/docs/view ignores the Accept
// header entirely and serves 30,318 B of markdown at '/docs/view.md'.

/** '.md' sibling candidates for a page path, most conventional first. */
function mdSiblingUrls(pageUrl) {
  const p = new URL(pageUrl);
  const pathname = p.pathname;
  const dotHtml = '.html';
  const out = [];
  if (pathname.length > dotHtml.length && pathname.lastIndexOf(dotHtml) === pathname.length - dotHtml.length) {
    out.push(pathname.substring(0, pathname.length - dotHtml.length) + '.md');
  } else if (pathname.charAt(pathname.length - 1) === '/') {
    out.push(pathname.substring(0, pathname.length - 1) + '.md');
    out.push(pathname + 'index.md');
  } else {
    out.push(pathname + '.md');
    out.push(pathname + '/index.md');
  }
  const urls = [];
  for (let i = 0; i < out.length; i++) {
    const full = p.origin + out[i];
    if (urls.indexOf(full) < 0) urls.push(full);
  }
  return urls;
}

// A machine-readable sibling is accepted only when the server did not hand
// back an HTML page. The common failure is a soft 404: status 200 carrying the
// SPA shell. That is caught structurally, by looking for a document element,
// NOT by guessing at the body's shape — developer.apple.com serves its .md
// with an EMPTY Content-Type and an HTML comment as its first bytes, so a
// "starts with #" test would reject a real article (measured 2026-08-12).
function isMachineReadable(resp, body) {
  if (resp.status !== 200) return false;
  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  if (ct.indexOf('html') >= 0) return false;
  const lower = body.toLowerCase();
  if (lower.indexOf('<!doctype html') >= 0) return false;
  if (lower.indexOf('<html') >= 0) return false;
  return body.trim().length > 0;
}

// llms.txt is an INDEX, not the page. Following it blindly would re-fetch the
// url we just failed on, so it is only useful when it names this page at a
// location 2a did not already try — a site that publishes its markdown on
// another host is the case this covers.
function llmsTargetFor(body, pathname, alreadyTried, base) {
  const lines = body.split('\\n');
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].indexOf('](');
    if (open < 0) continue;
    const close = lines[i].indexOf(')', open);
    if (close < 0) continue;
    const target = lines[i].substring(open + 2, close).trim();
    if (target.length === 0) continue;
    let abs;
    try { abs = new URL(target, base).toString(); } catch (e) { continue; }
    let entryPath;
    try { entryPath = new URL(abs).pathname; } catch (e) { continue; }
    const dotMd = '.md';
    const bare = (entryPath.length > dotMd.length &&
      entryPath.lastIndexOf(dotMd) === entryPath.length - dotMd.length)
      ? entryPath.substring(0, entryPath.length - dotMd.length)
      : entryPath;
    // The entry must name THIS page. A path suffix match is segment-safe
    // because pathname always begins with '/', so the match can only start
    // at a segment boundary.
    const names = bare === pathname ||
      bare + '/' === pathname ||
      bare === pathname + '/' ||
      (bare.length > pathname.length && bare.lastIndexOf(pathname) === bare.length - pathname.length);
    if (!names) continue;
    if (abs === base) continue;
    if (alreadyTried.indexOf(abs) >= 0) continue;
    return abs;
  }
  return '';
}

/** Climb rung 2. Returns the recovered document, or the urls it tried. */
async function climbRung2(pageUrl) {
  const tried = [];
  const siblings = mdSiblingUrls(pageUrl);
  for (let i = 0; i < siblings.length; i++) {
    tried.push(siblings[i]);
    try {
      const r = await fetchWithManualRedirect(siblings[i]);
      const b = await safeText(r);
      if (isMachineReadable(r, b)) {
        return { body: b, url: siblings[i], rung: '2a-md-sibling', tried: tried };
      }
    } catch (e) { /* a missing sibling is the expected case, not an error */ }
  }
  const origin = new URL(pageUrl).origin;
  const llmsUrl = origin + '/llms.txt';
  tried.push(llmsUrl);
  let llmsBody = '';
  try {
    const r = await fetchWithManualRedirect(llmsUrl);
    const b = await safeText(r);
    if (isMachineReadable(r, b)) llmsBody = b;
  } catch (e) { /* no llms.txt on this host */ }
  if (llmsBody.length > 0) {
    let pathname = '/';
    try { pathname = new URL(pageUrl).pathname; } catch (e) { pathname = '/'; }
    const target = llmsTargetFor(llmsBody, pathname, tried, pageUrl);
    if (target.length > 0) {
      tried.push(target);
      try {
        const r2 = await fetchWithManualRedirect(target);
        const b2 = await safeText(r2);
        if (isMachineReadable(r2, b2)) {
          return { body: b2, url: target, rung: '2b-llms-txt', tried: tried };
        }
      } catch (e) { /* the index named a url that does not serve */ }
    }
  }
  return { body: '', url: '', rung: '', tried: tried };
}

async function main() {
  const resp = await fetchWithManualRedirect(url);
  if (!resp.ok) { console.error("HTTP " + resp.status); process.exit(1); }
  const contentType = resp.headers.get('content-type') || '';

  // --- Site-authored markdown (route 1 — the cheapest correct answer) ---
  // The server honoured our Accept header and handed back the page as the
  // author wrote it: article only, no nav, no CSS, nothing to extract. Emit
  // it under the 'html' indexing strategy (heading-aware markdown chunking)
  // and tell the parent the route so it skips classification entirely.
  if (contentType.includes('text/markdown') || contentType.includes('text/x-markdown')) {
    const md = await safeText(resp);
    emit('html', md, Buffer.byteLength(md, 'utf-8'), 'markdown', '1-accept-markdown', []);
    return;
  }

  // --- JSON responses ---
  if (contentType.includes('application/json') || contentType.includes('+json')) {
    const text = await safeText(resp);
    const received = Buffer.byteLength(text, 'utf-8');
    try {
      const pretty = JSON.stringify(JSON.parse(text), null, 2);
      emit('json', pretty, received, 'json', '1-json-passthrough', []);
    } catch {
      emit('text', text, received, 'text', '1-text-passthrough', []);
    }
    return;
  }

  // --- HTML responses (default for text/html, application/xhtml+xml) ---
  if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
    const html = await safeText(resp);
    const sourceBytes = Buffer.byteLength(html, 'utf-8');
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    td.use(gfm);
    td.remove(['script', 'style', 'nav', 'header', 'footer', 'noscript']);
    const converted = td.turndown(html);

    // The site served HTML rather than markdown. If what came back converts to
    // an article, that IS the answer and rung 2 is never requested. If it
    // converts to a shell — the SPA case — climb to the site's own
    // machine-readable files BEFORE giving up, using the same arithmetic the
    // parent would have used to refuse.
    if (classifyExtraction(converted.trim().length, sourceBytes).kind === 'shell') {
      const climbed = await climbRung2(url);
      if (climbed.body.length > 0) {
        emit('html', climbed.body, Buffer.byteLength(climbed.body, 'utf-8'),
             'markdown', climbed.rung, climbed.tried);
        return;
      }
      // Ladder exhausted. Emit the shell anyway — the parent stores every
      // byte it was served and refuses to INDEX it, and it now knows which
      // urls were tried so the refusal can name them.
      emit('html', converted, sourceBytes, 'html', 'ladder-exhausted', climbed.tried);
      return;
    }
    emit('html', converted, sourceBytes, 'html', '1-html-converted', []);
    return;
  }

  // --- Everything else: plain text, CSV, XML, etc. ---
  const text = await safeText(resp);
  // Some sites answer the markdown Accept with the markdown document but
  // label it text/plain (measured 2026-08-12: cursor.com/docs/context/rules
  // returns 16,636 B of "# Rules ..." as text/plain). Recognising an ATX H1
  // on the first non-blank line is a structural check, not a threshold, and
  // it only ever changes which chunker runs — the whole document is indexed
  // either way, so a false positive cannot lose a byte.
  if (contentType.includes('text/plain')) {
    let firstLine = '';
    for (const line of text.split('\\n')) {
      if (line.trim().length > 0) { firstLine = line.trim(); break; }
    }
    if (firstLine.lastIndexOf('# ', 0) === 0) {
      emit('html', text, Buffer.byteLength(text, 'utf-8'), 'markdown', '1-accept-markdown', []);
      return;
    }
  }
  emit('text', text, Buffer.byteLength(text, 'utf-8'), 'text', '1-text-passthrough', []);
}
main();
`;
}

// ─────────────────────────────────────────────────────────
// Tool: fetch_and_index — see src/tools/fetch.ts
// ─────────────────────────────────────────────────────────
// Registered here, in the position it always occupied — MCP hosts render the
// tool list in registration order, and tests/core/tool-registration.test.ts
// pins it.

registerCtxFetch(fetchToolDeps());

// ─────────────────────────────────────────────────────────
// Tools: batch_execute + gather — see src/tools/batch.ts
// ─────────────────────────────────────────────────────────
// Both registrations happen here, in the position they always occupied —
// MCP hosts render the tool list in registration order, and
// tests/core/tool-registration.test.ts pins it.

registerBatchTools(batchToolDeps());

// ─────────────────────────────────────────────────────────
// Tool: stats — see src/tools/ops.ts
// ─────────────────────────────────────────────────────────
// Registered here, in the position it always occupied — MCP hosts render the
// tool list in registration order, and tests/core/tool-registration.test.ts
// pins it. ctx_doctor, ctx_upgrade, ctx_purge and ctx_insight below stayed
// put: the fork has barely touched them, so moving them would cost a
// delete/modify conflict per sync and buy nothing.

registerOpsTools(opsToolDeps());

// ── ctx-doctor: diagnostics (server-side) ─────────────────────────────────
server.registerTool(
  "ctx_doctor",
  {
    title: "Run Diagnostics",
    // #846: read-only diagnostics (runs an internal self-test, mutates nothing).
    // Was cancelled by Codex when unannotated.
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      "Diagnose context-mode installation. Runs all checks server-side and " +
      "returns a plain-text status report with [OK]/[FAIL]/[WARN] prefixes " +
      "(renderer-safe across MCP clients). No CLI execution needed.",
    inputSchema: z.object({}),
  },
  async () => {
    // Renderer-safe output (Mickey #3 — Z.ai GLM 4.7 ReferenceError):
    // Z.ai's MCP renderer mounts a custom React component for GitHub-flavored
    // markdown task-list syntax (`- [x]` / `- [ ]` / `- [-]`) that depends on
    // a missing `client` context, throwing `ReferenceError: client is not
    // defined`. We avoid both task-list syntax AND `## ` h2 headings to stay
    // safe across all MCP renderers — using plain-text status prefixes
    // (`[OK]` / `[FAIL]` / `[WARN]`) instead.
    const lines: string[] = ["context-mode doctor", ""];
    let currentPlatform: PlatformId | undefined;
    try {
      currentPlatform = detectPlatform(server.server.getClientVersion() ?? undefined).platform;
    } catch {
      currentPlatform = detectPlatform().platform;
    }
    // __pkg_dir is build/ for tsc, plugin root for bundle — resolve to plugin root.
    // Codex is special: when plugin-manager runtime root differs from the
    // current package root, diagnose the root Codex will actually execute.
    const pluginRoot = getRuntimeAwarePackageRoot(currentPlatform);

    // Runtimes
    const total = 11;
    const pct = ((available.length / total) * 100).toFixed(0);
    lines.push(`[OK] Runtimes: ${available.length}/${total} (${pct}%) — ${available.join(", ")}`);

    // Performance
    if (hasBunRuntime()) {
      lines.push("[OK] Performance: FAST (Bun)");
    } else {
      lines.push("[WARN] Performance: NORMAL — install Bun for 3-5x speed boost");
    }

    const sessionStorage = resolveSessionStorageDir(getDefaultSessionDir);
    const contentStorage = resolveContentStorageDir(getDefaultSessionDir);
    const statsStorage = resolveStatsStorageDir(getDefaultSessionDir);
    lines.push(`[OK] Storage sessions: ${sessionStorage.path} (${describeStorageDirectorySource(sessionStorage)})`);
    lines.push(`[OK] Storage content: ${contentStorage.path} (${describeStorageDirectorySource(contentStorage)})`);
    lines.push(`[OK] Storage stats: ${statsStorage.path} (${describeStorageDirectorySource(statsStorage)})`);

    // Server test — cleanup executor to prevent resource leaks (#247)
    {
      const testExecutor = new PolyglotExecutor({ runtimes });
      try {
        const result = await testExecutor.execute({ language: "javascript", code: 'console.log("ok");', timeout: 5000 });
        if (result.exitCode === 0 && result.stdout.trim() === "ok") {
          lines.push("[OK] Server test: PASS");
        } else {
          const detail = result.stderr?.trim() ? ` (${result.stderr.trim().slice(0, 200)})` : "";
          lines.push(`[FAIL] Server test: FAIL — exit ${result.exitCode}${detail}`);
        }
      } catch (err: unknown) {
        lines.push(`[FAIL] Server test: FAIL — ${err instanceof Error ? err.message : err}`);
      } finally {
        testExecutor.cleanupBackgrounded();
      }
    }

    // FTS5 / SQLite — close in finally to prevent GC segfault (#247)
    {
      let testDb: ReturnType<typeof loadDatabase> extends (...args: any[]) => infer R ? R : never;
      try {
        const Database = loadDatabase();
        testDb = new Database(":memory:");
        testDb.exec("CREATE VIRTUAL TABLE fts_test USING fts5(content)");
        testDb.exec("INSERT INTO fts_test(content) VALUES ('hello world')");
        const row = testDb.prepare("SELECT * FROM fts_test WHERE fts_test MATCH 'hello'").get() as { content: string } | undefined;
        if (row && row.content === "hello world") {
          lines.push("[OK] FTS5 / SQLite: PASS — native module works");
        } else {
          lines.push("[FAIL] FTS5 / SQLite: FAIL — unexpected result");
        }
      } catch (err: unknown) {
        lines.push(`[FAIL] FTS5 / SQLite: FAIL — ${err instanceof Error ? err.message : err}`);
      } finally {
        try { testDb!?.close(); } catch { /* best effort */ }
      }
    }

    // Hooks
    const diagnosticAdapter = await getDiagnosticAdapter();
    if (diagnosticAdapter) {
      for (const result of diagnosticAdapter.validateHooks(pluginRoot)) {
        const prefix = result.status === "pass" ? "[OK]" : result.status === "warn" ? "[WARN]" : "[FAIL]";
        const fix = result.fix ? ` — fix: ${result.fix}` : "";
        lines.push(`${prefix} ${result.check}: ${result.message}${fix}`);
      }

      const hookScriptPaths = getHookScriptPaths(diagnosticAdapter, pluginRoot);
      if (hookScriptPaths.length === 0) {
        lines.push("[OK] Hook scripts: no direct .mjs script paths to verify");
      }
      for (const scriptPath of hookScriptPaths) {
        const hookPath = resolve(pluginRoot, scriptPath);
        if (existsSync(hookPath)) {
          lines.push(`[OK] Hook script: PASS — ${hookPath}`);
        } else {
          lines.push(`[FAIL] Hook script: FAIL — not found at ${hookPath}`);
        }
      }
    } else {
      lines.push("[WARN] Hooks: adapter detection unavailable");
    }

    // Version
    lines.push(`[OK] Version: v${VERSION}`);

    return trackResponse("ctx_doctor", {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    });
  },
);

// ── ctx-upgrade: upgrade meta-tool ─────────────────────────────────────────
server.registerTool(
  "ctx_upgrade",
  {
    title: "Upgrade Plugin",
    // #846: an action tool (returns an upgrade command to run); not read-only,
    // but non-destructive and idempotent. No direct network from the call.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      "Upgrade context-mode to the latest version. Returns a shell command to execute. " +
      "You MUST run the returned command using your shell tool (Bash, shell_execute, " +
      "run_in_terminal, etc.) and display the output as a checklist. " +
      "Tell the user to restart their session after upgrade.",
    inputSchema: z.object({}),
  },
  async () => {
    // Issue #542 — thread MCP clientInfo into the spawned upgrade
    // process. detectPlatform() runs IN-PROCESS here (no spawn boundary)
    // so clientInfo from the MCP handshake is the highest-confidence
    // signal available. We forward the resolved PlatformId as a
    // --platform flag (cross-shell safe on POSIX, Git Bash, PowerShell,
    // and cmd.exe — unlike env-var prefixes). If detection fails we
    // skip the flag and let upgrade()'s own detectPlatform() fall back.
    let platformFlag = "";
    let nodeOpts: { platform: string; jsRuntime: string } | undefined =
      undefined;
    let platformId: PlatformId | undefined;
    try {
      const clientInfo = server.server.getClientVersion();
      const signal = detectPlatform(clientInfo ?? undefined);
      platformId = signal.platform;
      platformFlag = ` --platform ${signal.platform}`;
      nodeOpts = isInProcessPluginPlatform(signal.platform) && runtimes.javascript
        ? { platform: signal.platform, jsRuntime: runtimes.javascript }
        : undefined;
    } catch {
      try { platformId = detectPlatform().platform; } catch { /* best effort — fall back to upgrade()'s own detect */ }
    }

    // __pkg_dir is build/ for tsc, plugin root for bundle — resolve to plugin root.
    // Only Codex may replace it with the plugin-manager runtime root; other
    // adapters can coexist with Codex on the same machine.
    const pluginRoot = getRuntimeAwarePackageRoot(platformId);
    const bundlePath = resolve(pluginRoot, "cli.bundle.mjs");
    const fallbackPath = resolve(pluginRoot, "build", "cli.js");

    // Insight pivoted to the hosted dashboard (context-mode.com/insight), so
    // ctx_insight no longer builds a local cache. On upgrade, sweep the legacy
    // insight-cache and stop any stale local dashboard left from old versions.
    try {
      const sessDir = getSessionDir();
      const insightCacheDir = join(dirname(sessDir), "insight-cache");
      if (existsSync(insightCacheDir)) {
        // Kill any running insight server first via the shared helper —
        // this is locale-independent on Windows (PR #469) and isolates per-pid
        // failures. We ignore the structured result: cache cleanup is
        // best-effort and must never block ctx_upgrade.
        killProcessOnPort(4747);
        rmSync(insightCacheDir, { recursive: true, force: true });
      }
    } catch { /* best effort — don't block upgrade */ }


    let cmd: string;

    if (existsSync(bundlePath)) {
      cmd = `${buildNodeCommand(bundlePath, nodeOpts)} upgrade${platformFlag}`;
    } else if (existsSync(fallbackPath)) {
      cmd = `${buildNodeCommand(fallbackPath, nodeOpts)} upgrade${platformFlag}`;
    } else {
      // Inline fallback: neither CLI file exists (e.g. marketplace installs).
      // Generate a self-contained node -e script that performs the upgrade.
      const repoUrl = "https://github.com/mksglu/context-mode.git";
      // Write inline script to a temp .mjs file — avoids quote-escaping issues
      // across cmd.exe, PowerShell, and bash (node -e '...' breaks on Windows).
      const scriptLines = [
        `import{execFileSync}from"node:child_process";`,
        `import{cpSync,rmSync,existsSync,mkdtempSync,readFileSync,writeFileSync,lstatSync}from"node:fs";`,
        `import{join,resolve,sep}from"node:path";`,
        `import{tmpdir}from"node:os";`,
        `const P=${JSON.stringify(pluginRoot)};`,
        `const T=mkdtempSync(join(tmpdir(),"ctx-upgrade-"));`,
        `try{`,
        `console.log("- [x] Starting inline upgrade (no CLI found)");`,
        `execFileSync("git",["clone","--depth","1","${repoUrl}",T],{stdio:"inherit"});`,
        `console.log("- [x] Cloned latest source");`,
        `execFileSync(process.platform==="win32"?"npm.cmd":"npm",["install"],{cwd:T,stdio:"inherit",shell:process.platform==="win32"});`,
        `execFileSync(process.platform==="win32"?"npm.cmd":"npm",["run","build"],{cwd:T,stdio:"inherit",shell:process.platform==="win32"});`,
        `console.log("- [x] Built from source");`,
        `const pkg=JSON.parse(readFileSync(join(T,"package.json"),"utf8"));`,
        `const items=[...(Array.isArray(pkg.files)?pkg.files:[]),"src","package.json"];`,
        // Supply-chain containment on items[]. Mirror the cli.ts upgrade()
        // guard: a compromised upstream package.json with files:["../etc"]
        // would otherwise let path.join follow ".." out of pluginRoot.
        // path.resolve normalizes "..", so the lexical startsWith catches
        // both relative-".." traversal and absolute-path bypass. Plus a
        // symlink filter so a committed symlink inside the clone can't
        // plant itself in pluginRoot (cpSync default preserves source
        // symlinks; a planted symlink in pluginRoot/src then redirects
        // every subsequent load through to an attacker target).
        `const PW=resolve(P)+sep;const TW=resolve(T)+sep;`,
        `const noSymlink=(src)=>{try{return !lstatSync(src).isSymbolicLink()}catch{return false}};`,
        `for(const item of items){const from=resolve(T,item);const to=resolve(P,item);if(!(to+sep).startsWith(PW))continue;if(!(from+sep).startsWith(TW))continue;if(!noSymlink(from))continue;if(existsSync(from)){rmSync(to,{recursive:true,force:true});cpSync(from,to,{recursive:true,force:true,filter:noSymlink});}}`,
        // Issue #609: do NOT write .mcp.json into the cache dir. Claude Code reads
        // .claude-plugin/plugin.json.mcpServers as the canonical MCP source — the
        // per-version .mcp.json file is a stale-write vector. Same architectural
        // fix as the cli.ts upgrade() path; both writers were the only producers.
        `console.log("- [x] Copied package files");`,
        `execFileSync(process.platform==="win32"?"npm.cmd":"npm",["install","--production"],{cwd:P,stdio:"inherit",shell:process.platform==="win32"});`,
        `console.log("- [x] Installed production dependencies");`,
        `console.log("## context-mode upgrade complete");`,
        `}catch(e){`,
        `console.error("- [ ] Upgrade failed:",e.message);`,
        `process.exit(1);`,
        `}finally{`,
        `try{rmSync(T,{recursive:true,force:true})}catch{}`,
        `}`,
      ].join("\n");

      // Server writes the temp script file — avoids shell quoting issues entirely
      const tmpScript = resolve(pluginRoot, ".ctx-upgrade-inline.mjs");
      const { writeFileSync: writeTmp } = await import("node:fs");
      writeTmp(tmpScript, scriptLines);
      cmd = buildNodeCommand(tmpScript, nodeOpts);
    }

    const text = [
      "## ctx-upgrade",
      "",
      "Run this command using your shell execution tool:",
      "",
      "```",
      cmd,
      "```",
      "",
      "After the command completes, display results as a markdown checklist:",
      "- `[x]` for success, `[ ]` for failure",
      "- Example format:",
      "  ```",
      "  ## context-mode upgrade",
      "  - [x] Pulled latest from GitHub",
      "  - [x] Built and installed v0.9.24",
      "  - [x] npm global updated",
      "  - [x] Hooks configured",
      "  - [x] Doctor: all checks PASS",
      "  ```",
      "- Tell the user to restart their session to pick up the new version.",
    ].join("\n");

    return trackResponse("ctx_upgrade", {
      content: [{ type: "text" as const, text }],
    });
  },
);

// ── ctx-purge: explicit knowledge base wipe ─────────────────────────────────
//
// Issue #520 — scoped purge.
// The schema is ADDITIVE: bare {confirm:true} preserves the legacy
// project-wide wipe verbatim (with a stderr deprecation warning so
// future callers migrate to explicit scope). When sessionId is given,
// only that session's rows + FTS5 chunks are removed; project-wide
// files (events.md, FTS5 store file, stats file) are preserved.
// Passing both sessionId AND scope:"project" is ambiguous (does the
// caller want a per-session wipe or a project-wide one?) and is
// rejected by an explicit check in the handler body — NOT a schema-level
// .refine(). MCP SDK's normalizeObjectSchema() reads `.shape` to project
// inputSchema → JSON Schema for tools/list; a ZodEffects (refine wrapper)
// has no `.shape`, so the SDK silently emits `properties: {}`, and Claude
// Code's strict-input-validation gate then rejects EVERY call to this
// tool with "input_schema does not support fields". Issue #563.
server.registerTool(
  "ctx_purge",
  {
    title: "Purge Knowledge Base",
    // #846: permanently deletes indexed content — destructive. Purging an
    // already-purged scope has no further effect (idempotent). No network.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: `DESTRUCTIVE: permanently delete indexed content. Cannot be undone. Requires confirm:true and exactly one scope.

WHEN:
  - User explicitly asks to clear a specific session ('purge this session', 'wipe this conversation')
  - User explicitly asks to reset the whole project ('reset everything', 'wipe the knowledge base')

WHEN NOT:
  - User says 'reset', 'clear', or 'wipe' without naming a scope -> ask which scope before calling
  - User wants to free memory or improve performance -> recommend ctx_stats first, do not purge

SCOPES (pass exactly one):
  - Per-session: ctx_purge(confirm: true, sessionId: "<uuid>") deletes that session's events (auto-captured decisions, errors, plans, user prompts, rejected approaches, etc.) and per-session FTS5 chunks; sibling sessions and stats file are preserved.
  - Per-project: ctx_purge(confirm: true, scope: "project") wipes FTS5 knowledge base, every session DB row, events markdown, and resets the stats file. Use ctx_stats first to preview category counts before purging.

CONTRACT:
  - confirm:true is required; confirm:false returns 'purge cancelled'.
  - sessionId and scope:'project' together return 'ambiguous - pick one'.
  - scope:'session' without sessionId throws (sessionId required).
  - Bare {confirm:true} is deprecated: maps to scope:'project' with a stderr warning; will hard-error in a future major.

RETURNS:
  A summary of removed rows + the resolved scope.

EXAMPLE: ctx_purge(confirm: true, sessionId: "7c8a-1234-5678-9abc-def012345678")
EXAMPLE: ctx_purge(confirm: true, scope: "project")`,
    // NOTE: schema MUST be a plain z.object — no .refine()/.transform()/
    // .superRefine() wrapper. See block comment above & issue #563. The
    // cross-field ambiguity check lives in the handler body below.
    inputSchema: z.object({
      // confirm: wrapped in coerceBoolean preprocessor — OpenCode's native
      // plugin bridge can deliver `confirm:"true"` / `confirm:"false"` as
      // string literals. Without this, v1.0.139's inputSchema.parse() path
      // rejects valid intent as "Expected boolean, received string" (#627).
      confirm: z.preprocess(coerceBoolean, z.boolean()).describe(
        "MUST be true. Destructive operation; false returns 'purge cancelled'."
      ),
      sessionId: z.string().optional().describe(
        "UUID of a single session. Pairs with confirm:true to wipe only that " +
        "session's events + per-session FTS5 chunks. Sibling sessions and the " +
        "stats file are preserved. MUST NOT be combined with scope:'project'."
      ),
      scope: z.enum(["session", "project"]).optional().describe(
        "Explicit scope selector. 'session' REQUIRES sessionId. 'project' wipes " +
        "the entire project (FTS5 + every session + stats). Omit only for the " +
        "deprecated bare-{confirm:true} back-compat path."
      ),
    }),
  },
  async ({ confirm, sessionId, scope }) => {
    // Cross-field ambiguity check — formerly a schema .refine(), moved
    // into the handler so the inputSchema stays a plain ZodObject and
    // the MCP SDK can serialize `.shape` into JSON Schema (issue #563).
    // Same human-readable message as the original refine() preserved.
    if (sessionId && scope === "project") {
      return trackResponse("ctx_purge", {
        content: [{
          type: "text" as const,
          text:
            "Ambiguous purge: sessionId implies scope:'session', cannot combine with scope:'project'. " +
            "Use scope:'project' WITHOUT sessionId for the legacy whole-project wipe.",
        }],
        isError: true,
      });
    }
    if (!confirm) {
      return trackResponse("ctx_purge", {
        content: [{
          type: "text" as const,
          text: "Purge cancelled. Pass confirm: true to proceed.",
        }],
      });
    }

    // Effective scope resolution:
    //   - explicit scope wins
    //   - else "session" iff sessionId is given
    //   - else "project" (back-compat — emit deprecation warning so
    //     callers migrate to the explicit form before a future major).
    const effectiveScope: "session" | "project" =
      scope ?? (sessionId ? "session" : "project");
    if (!scope && !sessionId) {
      console.warn(
        "[context-mode] ctx_purge: bare {confirm:true} is deprecated. " +
        "Pass scope:'project' for the whole-project wipe, or scope:'session' + sessionId " +
        "for a scoped wipe. See issue #520."
      );
    }

    // Close the persistent FTS5 content store handle BEFORE delegating to
    // purgeSession so the store's lock is released on Windows. The handle
    // is recreated lazily on the next getStore() call.
    let storePathForPurge: string | undefined;
    try {
      storePathForPurge = getStorePath();
    } catch { /* best effort — store path may be unresolvable on fresh install */ }
    const openStore = peekStore();
    if (openStore) {
      try { openStore.cleanup(); } catch { /* best effort */ }
      setStore(null);
    }

    // FTS5 store: pass contentDir so purgeSession sweeps BOTH canonical
    // and legacy raw-casing variants (dual-hash, mirrors session events).
    // storePath is also passed for the rare case where the resolver picked
    // an absolute path that differs from the dual-hash pair (e.g. caller
    // pre-migrated). Both paths are de-duped during unlink.
    const contentDir = storePathForPurge ? dirname(storePathForPurge) : undefined;
    const { deleted } = purgeSession({
      projectDir: getProjectDir(),
      sessionsDir: getSessionDir(),
      storePath: storePathForPurge,
      contentDir,
      legacyContentDir: join(homedir(), ".context-mode", "content"),
      // hashProjectDirLegacy mirrors the deployed (≤ v1.0.111) raw-casing
      // hash that named files under ~/.context-mode/content/. Using the
      // legacy hash here is correct: that pre-pre-legacy directory was
      // never migrated and still uses raw casing.
      contentHash: hashProjectDirLegacy(getProjectDir()),
      scope: effectiveScope,
      sessionId,
    });

    // Stats are PROJECT-scoped (one stats file per project, summing all
    // sessions). A scoped per-session purge MUST leave stats alone — they
    // still belong to other sessions in the same project. Stats reset
    // happens ONLY when scope === "project".
    if (effectiveScope === "project") {
      // Reset in-memory session stats
      sessionStats.calls = {};
      sessionStats.bytesReturned = {};
      sessionStats.bytesIndexed = 0;
      sessionStats.bytesSandboxed = 0;
      sessionStats.cacheHits = 0;
      sessionStats.cacheBytesSaved = 0;
      sessionStats.sessionStart = Date.now();
      deleted.push("session stats");

      // Also drop the persisted stats file so external readers see a fresh state
      try {
        const statsFile = getStatsFilePath();
        if (existsSync(statsFile)) unlinkSync(statsFile);
      } catch { /* best effort */ }
    }

    const message = effectiveScope === "session"
      ? `Purged session ${sessionId}: ${deleted.length ? deleted.join(", ") : "no matching rows"}. ` +
        `Other sessions and project-wide stats preserved.`
      : `Purged: ${deleted.join(", ")}. All session data for this project has been permanently deleted.`;
    return trackResponse("ctx_purge", {
      content: [{
        type: "text" as const,
        text: message,
      }],
    });
  },
);

// ── ctx_insight process helpers ──────────────────────────────────────────────
// Cross-platform process helpers used by ctx_insight (below) and the dashboard
// launcher in cli.ts. All entry points use argv arrays — never `sh -c <string>`
// — so caller-derived values cannot escape into shell context. See issue #441.
//
// `browserOpenArgv` is duplicated as a private 16-LOC copy in cli.ts to avoid
// pulling server.ts top-level boot side effects into the cli bundle.

export type SpawnSyncFn = (
  cmd: string,
  args: readonly string[],
  opts?: SpawnSyncOptions,
) => SpawnSyncReturns<string | Buffer>;

export type BrowserOpenResult =
  | { ok: true; method: string }
  | { ok: false; method: "none"; reason: string };

export type KillResult = {
  killedPids: string[];
  attemptedPids: string[];
  errors: string[];
};

// Hard upper bound on every helper-internal spawnSync call. Caps tail-latency
// when an external binary hangs (xdg-open waiting for an X11 session, lsof
// stalling on /proc, taskkill blocking on an unresponsive process, etc.) so
// the MCP tool surfaces a diagnostic instead of blocking the agent loop.
// 5s is comfortably above the 99th-percentile completion of every command we
// invoke; anything past that is hung.
const HELPER_SPAWN_TIMEOUT_MS = 5000;

// Returns the argv attempts for opening `url` on `platform`, in fall-back order.
// Pure data — no I/O.
export function browserOpenArgv(
  url: string,
  platform: NodeJS.Platform,
): readonly { cmd: string; args: readonly string[] }[] {
  if (platform === "darwin") return [{ cmd: "open", args: [url] }];
  if (platform === "win32") {
    // `start` is a cmd.exe builtin; the empty title arg ("") prevents the URL
    // from being consumed as the window title.
    return [{ cmd: "cmd", args: ["/c", "start", "", url] }];
  }
  // linux/bsd: try xdg-open, then sensible-browser (Debian/Ubuntu).
  return [
    { cmd: "xdg-open", args: [url] },
    { cmd: "sensible-browser", args: [url] },
  ];
}

// Opens a browser synchronously, waiting for each attempt to complete.
// Returns a structured result so callers can surface auto-open failures
// to the user instead of falsely reporting success.
export function openBrowserSync(
  url: string,
  platform: NodeJS.Platform = process.platform,
  runner: SpawnSyncFn = spawnSync,
): BrowserOpenResult {
  const attempts = browserOpenArgv(url, platform);
  const errors: string[] = [];
  for (const { cmd, args } of attempts) {
    try {
      const r = runner(cmd, args, { stdio: "ignore", timeout: HELPER_SPAWN_TIMEOUT_MS });
      // Treat signal-kill (status === null) and any non-zero status as failure
      // so the next fallback fires.
      if (!r.error && r.status === 0) return { ok: true, method: cmd };
      const reason = r.error?.message ?? `status=${r.status === null ? "signaled" : r.status}`;
      errors.push(`${cmd}: ${reason}`);
    } catch (e) {
      errors.push(`${cmd}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ok: false, method: "none", reason: errors.join("; ") };
}

// Kills any process listening on `port`. Returns a structured result so
// the caller can distinguish between (a) port was free, (b) kill succeeded,
// (c) kill failed (perms, missing binary, or per-pid failure mid-loop).
//
// On Windows the netstat parser is locale-independent: the STATE column
// ("LISTENING" / "ESTABLISHED" / ...) is translated on non-English Windows
// (Windows-FR shows "À l'écoute", Windows-DE "ABHÖREN", etc.), but the REMOTE
// ADDRESS column is not. A listening TCP socket always has remote
// "0.0.0.0:0" (IPv4) or "[::]:0" (IPv6); a connected one has a real
// addr:port. We therefore key off the remote column instead of the state
// string. This also rules out the pre-fix bug where matching only the local
// port number cross-matched a remote :port from an outbound connection and
// taskkill'd an unrelated process.
export function killProcessOnPort(
  port: number,
  platform: NodeJS.Platform = process.platform,
  runner: SpawnSyncFn = spawnSync,
): KillResult {
  const result: KillResult = { killedPids: [], attemptedPids: [], errors: [] };
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    result.errors.push(`invalid port: ${port}`);
    return result;
  }

  try {
    if (platform === "win32") {
      const r = runner("netstat", ["-ano"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: HELPER_SPAWN_TIMEOUT_MS,
      });
      if (r.error) {
        result.errors.push(`netstat: ${r.error.message}`);
        return result;
      }
      if (r.status !== 0 || typeof r.stdout !== "string") return result;

      const portSuffix = `:${port}`;
      const pids = new Set<string>();
      for (const rawLine of r.stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const tokens = line.split(/\s+/);
        // netstat -ano LISTENING row (en-US): "TCP  0.0.0.0:4747  0.0.0.0:0  LISTENING  1234"
        // The STATE column is locale-translated and may itself contain spaces
        // (Windows-FR `À l'écoute` splits into two tokens), so we cannot index
        // STATE by position. PID is always the trailing column; PROTO/LOCAL/
        // REMOTE are the first three. We anchor on those + a remote-wildcard
        // check that's locale-independent.
        if (tokens.length < 5) continue;
        const proto = tokens[0];
        const local = tokens[1];
        const remote = tokens[2];
        const pid = tokens[tokens.length - 1];
        if (proto !== "TCP") continue;
        if (!local.endsWith(portSuffix)) continue;
        // Listening sockets carry a wildcard remote; anything else is a
        // connection (and matching it would kill an unrelated process).
        if (remote !== "0.0.0.0:0" && remote !== "[::]:0") continue;
        if (!/^\d+$/.test(pid)) continue;
        pids.add(pid);
      }
      for (const pid of pids) {
        result.attemptedPids.push(pid);
        try {
          const k = runner("taskkill", ["/F", "/PID", pid], {
            stdio: "ignore",
            timeout: HELPER_SPAWN_TIMEOUT_MS,
          });
          if (k.error || k.status !== 0) {
            result.errors.push(
              `taskkill ${pid}: ${k.error?.message ?? `status=${k.status}`}`,
            );
          } else {
            result.killedPids.push(pid);
          }
        } catch (e) {
          result.errors.push(`taskkill ${pid}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } else {
      const r = runner("lsof", ["-ti", `:${port}`], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: HELPER_SPAWN_TIMEOUT_MS,
      });
      if (r.error) {
        // ENOENT (lsof not installed) is a real diagnostic; surface it.
        result.errors.push(`lsof: ${r.error.message}`);
        return result;
      }
      // lsof exits 1 with empty stdout when the port is free — not an error.
      if (r.status !== 0 || typeof r.stdout !== "string") return result;

      const pids = r.stdout.split(/\r?\n/).filter(p => /^\d+$/.test(p));
      for (const pid of pids) {
        result.attemptedPids.push(pid);
        try {
          const k = runner("kill", [pid], {
            stdio: "ignore",
            timeout: HELPER_SPAWN_TIMEOUT_MS,
          });
          if (k.error || k.status !== 0) {
            result.errors.push(
              `kill ${pid}: ${k.error?.message ?? `status=${k.status}`}`,
            );
          } else {
            result.killedPids.push(pid);
          }
        } catch (e) {
          result.errors.push(`kill ${pid}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e));
  }
  return result;
}

// ── ctx-insight: open the hosted Insight dashboard ───────────────────────────
// Insight pivoted from a locally-built dashboard to the hosted B2B product at
// context-mode.com/insight (the landing page is the single source of truth).
// The tool now simply opens that URL in the user default browser via the same
// cross-platform helper (openBrowserSync) used elsewhere.
const INSIGHT_URL = "https://context-mode.com/insight";

server.registerTool(
  "ctx_insight",
  {
    title: "Open Insight Dashboard",
    // #846: opens a hosted dashboard URL in the browser — an external side
    // effect (open world), not a read-only query; safe to repeat.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "Opens the context-mode Insight dashboard (https://context-mode.com/insight) in your " +
      "default browser — a dashboard launcher for the hosted analytics layer, not a Q&A engine. " +
      "Insight surfaces per-engineer productive rate, retry waste, blocker detection, and " +
      "role-narrowed views for CTO, EM, IC, CISO, FinOps, and DevOps. " +
      "For natural-language queries over your indexed content, use ctx_search.",
    inputSchema: z.object({}),
  },
  async () => {
    const open = openBrowserSync(INSIGHT_URL);
    const text = open.ok
      ? `Opening Insight in your browser: ${INSIGHT_URL}`
      : `Could not auto-open your browser (${open.reason}).\nOpen Insight manually: ${INSIGHT_URL}`;
    return trackResponse("ctx_insight", {
      content: [{ type: "text" as const, text }],
    });
  },
);

// ─────────────────────────────────────────────────────────
// Server startup
// ─────────────────────────────────────────────────────────

async function main() {
  // Clean up stale DB files from previous sessions
  const cleaned = cleanupStaleDBs();
  if (cleaned > 0) {
    console.error(`Cleaned up ${cleaned} stale DB file(s) from previous sessions`);
  }

  // MCP readiness sentinel path (#230, #347)
  // Uses process.pid (not ppid) — hooks use directory-scan to find any live sentinel.
  // Hardcoded /tmp on Unix to avoid TMPDIR mismatch (#347).
  const mcpSentinelDir = process.platform === "win32" ? tmpdir() : "/tmp";
  const mcpSentinel = join(mcpSentinelDir, `context-mode-mcp-ready-${process.pid}`);
  // #844: handle to the periodic sentinel refresh timer (started after connect).
  let sentinelRefresh: ReturnType<typeof setInterval> | undefined;

  // Clean up own DB + backgrounded processes + preload script on shutdown
  const shutdown = () => {
    executor.cleanupBackgrounded();
    peekStore()?.close(); // persist DB for --continue sessions
    try { unlinkSync(CM_FS_PRELOAD); } catch { /* best effort */ }
    // Remove MCP readiness sentinel (#230)
    try { unlinkSync(mcpSentinel); } catch { /* best effort */ }
    // #844: stop refreshing the sentinel mtime on shutdown.
    if (sentinelRefresh) clearInterval(sentinelRefresh);
  };
  const gracefulShutdown = async () => {
    // Final stats flush — bypass throttle so the last 0-500ms of
    // bytes_indexed / bytes_returned aren't silently lost on SIGTERM/SIGINT
    // (PR #401 grill-me review B1: persistStats early-returns inside throttle
    // window; gracefulShutdown previously did NOT bypass).
    try {
      _lastStatsPersist = 0;
      persistStats();
    } catch { /* best effort — never block shutdown */ }
    shutdown();
    process.exit(0);
  };
  process.on("exit", shutdown);
  process.on("SIGINT", () => { gracefulShutdown(); });
  process.on("SIGTERM", () => { gracefulShutdown(); });

  // Lifecycle guard: detect parent death + stdin close to prevent orphaned processes (#103)
  startLifecycleGuard({ onShutdown: () => gracefulShutdown() });

  // Upgrade tool descriptions once the client has identified itself (see
  // shouldServeFullDescriptions). oninitialized fires after the MCP handshake
  // and before the client's tools/list, so the upgraded text is what gets
  // listed; assigned before connect so the callback cannot be missed.
  server.server.oninitialized = () => {
    try { upgradeToolDescriptionsForClient(); } catch { /* best-effort */ }
  };

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // #854: refresh the bridge-child idle clock on each inbound MCP message so an
  // abandoned bridge child (CONTEXT_MODE_BRIDGE_DEPTH>0) self-terminates instead
  // of accumulating under a long-lived Pi/omp parent. Best-effort; no stdin touch.
  attachMcpActivityTap(
    transport as unknown as { onmessage?: (message: unknown, extra?: unknown) => unknown },
  );

  // Write MCP readiness sentinel (#230)
  try { writeFileSync(mcpSentinel, String(process.pid)); } catch { /* best effort */ }

  // #844: refresh the sentinel mtime while the server is alive so readiness
  // probes from a foreign PID namespace (shared /tmp) can trust a recent
  // sentinel even when process.kill(pid, 0) cannot see this PID. The reader's
  // freshness window is 90s (hooks/core/mcp-ready.mjs); refresh at 30s (3x).
  // unref() so this timer never keeps the event loop alive on its own.
  sentinelRefresh = setInterval(() => {
    try { writeFileSync(mcpSentinel, String(process.pid)); } catch { /* best effort */ }
  }, 30_000);
  sentinelRefresh.unref();

  // Detect platform adapter — stored for platform-aware session paths
  try {
    const { detectPlatform, getAdapter } = await import("./adapters/detect.js");
    const clientInfo = server.server.getClientVersion();
    const signal = detectPlatform(clientInfo ?? undefined);
    setDetectedAdapter(await getAdapter(signal.platform));
    if (clientInfo) {
      console.error(`MCP client: ${clientInfo.name} v${clientInfo.version} → ${signal.platform}`);
    }
  } catch { /* best effort — the adapter stays null, falls back to .claude */ }

  // Restore tool-call counters from SessionDB BEFORE the heartbeat fires
  // so the very first persistStats() carries the prior PID's totals into
  // the sidecar JSON the statusline reads. Otherwise `/ctx-upgrade` flashes
  // `0 calls / $0.00` until the user makes another MCP tool call. Wrapped
  // in try/catch — a stats-restore failure must never block server startup.
  try {
    const restored = restoreSessionStats(getSessionDbPath());
    if (restored) {
      for (const [tool, count] of Object.entries(restored.calls)) {
        sessionStats.calls[tool] = count;
      }
      for (const [tool, bytes] of Object.entries(restored.bytesReturned)) {
        sessionStats.bytesReturned[tool] = bytes;
      }
      // Anchor uptime_ms to the original session start so `/ctx-upgrade`
      // doesn't reset the "session age" the statusline shows.
      if (restored.sessionStart > 0) {
        sessionStats.sessionStart = restored.sessionStart;
      }
    }
  } catch { /* best effort — never block startup on a stats restore failure */ }

  // Non-blocking version check — result stored for trackResponse warnings.
  // First fetch at startup, then refresh every hour so long-running sessions
  // (some users keep the MCP server alive 24h+) catch new releases without a
  // restart. `.unref()` lets the process exit normally on SIGTERM regardless
  // of pending intervals.
  fetchLatestVersion().then(v => { if (v !== "unknown") _latestVersion = v; });
  setInterval(() => {
    fetchLatestVersion().then(v => { if (v !== "unknown") _latestVersion = v; });
  }, 60 * 60 * 1000).unref();

  // Stats heartbeat — keep the statusline truthful while the user works in
  // tools other than MCP (Bash/Read/Edit during long sessions or post-/compact
  // pauses). Without this, stats.updated_at only advances on MCP tool calls,
  // so bin/statusline.mjs falsely flips to "stale — restart to resume saving"
  // even though the server is alive. Heartbeat refreshes updated_at every 60s;
  // statusline staleness threshold is 30min (cliff is 30 missed ticks away).
  setInterval(() => persistStats(), 60_000).unref();

  if (process.stdin.isTTY) {
    console.error(`Context Mode MCP server v${VERSION} running on stdio`);
    console.error(`Detected runtimes:\n${getRuntimeSummary(runtimes)}`);
    if (!hasBunRuntime()) {
      console.error(
        "\nPerformance tip: Install Bun for 3-5x faster JS/TS execution",
      );
      console.error("  curl -fsSL https://bun.sh/install | bash");
    }
  }
}

// Runs after every registerTool() above, so the SDK's default tools/list handler
// exists and can be wrapped. Makes ctx_* schemas safe for strict (Gemini
// function-calling) clients like Antigravity CLI (`agy`) / Gemini CLI.
installStrictClientSchemaCompat();

if (process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS !== "1") {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
