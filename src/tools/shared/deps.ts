/**
 * What a tool module needs from `src/server.ts`, passed in rather than imported.
 *
 * This type is the whole reason the split is safe. `src/server.ts` creates the
 * MCP server, owns the content store, the per-session counters and the
 * adapter detection, and it must import each tool module to register it. If a
 * tool module imported `getStore` or `trackResponse` back from server.ts, the
 * cycle would resolve by evaluating one side half-initialised — a class of bug
 * that appears only in the bundle, only sometimes, and only at startup.
 *
 * So the direction of imports is one-way (server → tools), and everything that
 * would have pointed back comes through here. The interface is also the honest
 * record of how much state a handler really touches: it is short on purpose,
 * and a handler that needs much more than this is telling you it has not been
 * separated yet.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContentStore } from "../../store.js";
import type { HookAdapter, PlatformId } from "../../adapters/types.js";
import type { PolyglotExecutor } from "../../executor.js";
import type { FloodGuard } from "../../search/flood-guard.js";
import type { RuntimeMap } from "../../runtime.js";

/**
 * The response shape every ctx_* handler returns.
 *
 * The index signature is what the MCP SDK's `registerTool` requires of a
 * handler return type; without it a structurally identical interface is
 * rejected at the call site.
 */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolDeps {
  /** The MCP server the tool registers itself on. */
  server: McpServer;

  /** Open (or reuse) this project's content store. */
  getStore: () => ContentStore;
  /** Absolute project root, resolved through the host's env cascade. */
  getProjectDir: () => string;
  /** Directory holding the session DBs and capture queues. */
  getSessionDir: () => string;
  /** Path of this project's FTS5 content DB (its directory holds the sidecars). */
  getStorePath: () => string;
  /** Path of this project's SessionDB, case-folded and migrated on first call. */
  getSessionDbPath: () => string;

  /**
   * Record the call, prepend any version warning, persist the counters.
   * Every handler's return value passes through it.
   */
  trackResponse: (toolName: string, response: ToolResult) => ToolResult;

  /** Window-extract a snippet around the matched terms. */
  extractSnippet: (content: string, query: string, maxLen?: number, highlighted?: string) => string;

  /** One-per-process nudge when the semantic layer is not answering yet. */
  semanticStatusHint: (store: ContentStore) => string | null;

  /**
   * The detected host adapter, as a getter: detection completes during
   * startup, which is after the tool modules are imported.
   */
  detectedAdapter: () => HookAdapter | null;

  /** Count bytes that were indexed instead of returned, and emit the event. */
  trackIndexed: (bytes: number, source?: string) => void;

  /** Session attribution stamped onto every `ContentStore.index*()` write. */
  currentAttribution: () => { sessionId?: string } | undefined;

  /**
   * Server-side deny firewall. Returns an error result when the command
   * matches a Bash deny pattern, or null when it may run.
   */
  checkDenyPolicy: (command: string, toolName: string) => ToolResult | null;

  /** Zod preprocessor: lift a double-serialised or bare string to an array. */
  coerceJsonArray: (val: unknown) => unknown;
  /** Zod preprocessor: also lift bare command strings to `{label, command}`. */
  coerceCommandsArray: (val: unknown) => unknown;
  /** Zod preprocessor: accept the literal strings "true"/"false" as booleans. */
  coerceBoolean: (val: unknown) => unknown;

  /** Progressive per-agent search throttle (#769). */
  searchFloodGuard: FloodGuard;
  /** Bucket key for the throttle — one window per agent, not per machine. */
  searchFloodGuardKey: () => string;
  /** Calls after which results taper to one per query. */
  SEARCH_MAX_RESULTS_AFTER: number;
  /** Calls after which the tool refuses and demands batching. */
  SEARCH_BLOCK_AFTER: number;
}

/**
 * What `ctx_batch_execute` and `ctx_gather` need on top of {@link ToolDeps}.
 *
 * These four stayed in `src/server.ts` deliberately. The command runner, the
 * timeout resolver and the echo clipper are shared with `ctx_execute`, and the
 * upstream project has never touched them — moving them would trade a merge
 * conflict on every sync for nothing. `formatBatchQueryResults` stayed because
 * it calls `extractSnippet`, which is likewise untouched upstream and
 * likewise still in `server.ts`.
 *
 * The shapes below are written out structurally rather than imported from
 * `server.ts`: even an erased `import type` is an edge in the module graph as
 * far as a cycle checker is concerned, and this file's whole job is to have
 * no edge pointing back.
 */
export interface BatchToolDeps extends ToolDeps {
  /**
   * Run the batch's commands, already bound to the executor and the
   * NODE_OPTIONS FS-tracking preload prefix.
   */
  runBatchCommands: (
    commands: Array<{ label: string; command: string }>,
    opts: {
      /** Shared budget at concurrency 1, per-command above it. */
      timeout: number | undefined;
      concurrency: number;
      cwd?: string;
      onFsBytes?: (bytes: number) => void;
    },
  ) => Promise<{ outputs: string[]; timedOut: boolean }>;

  /** Clip a command for the echoed inventory line (the full one still runs). */
  truncateCommandForEcho: (command: string) => string;

  /** Render the per-query sections appended to the batch's response. */
  formatBatchQueryResults: (
    store: ContentStore,
    queries: string[],
    source: string,
    maxOutput?: number,
    scope?: "batch" | "global",
  ) => Promise<string[]>;
}

/**
 * What `ctx_fetch_and_index` needs on top of {@link ToolDeps}.
 *
 * Two fields, for the same reason there were four on the batch side. The
 * executor is one object per process — a second one would not share the
 * backgrounded-process registry that shutdown drains. And `buildFetchCode`,
 * the program the fetch subprocess runs, stayed in `src/server.ts`: it is
 * upstream's code nearly line for line and upstream keeps developing that
 * ladder, so moving it would buy a delete/modify conflict on every sync and
 * nothing else.
 */
export interface FetchToolDeps extends ToolDeps {
  /** The one polyglot executor this process owns. */
  executor: PolyglotExecutor;
  /** Source of the CJS program the fetch subprocess runs. */
  buildFetchCode: (url: string, outputPath: string) => string;
}

/**
 * What `ctx_stats` needs on top of {@link ToolDeps} — the three values it
 * reports that `src/server.ts` owns: the running version, the newer version
 * the background npm check may have found, and the semantic-index footer.
 *
 * `rollUpStaleStatsFiles` used to be a fourth. It arrived with the Pi
 * byte-accounting patch and left with the Pi adapter; `src/server.ts` still
 * calls the function directly at boot, so the sweep is unchanged — only the
 * injection nothing read any more is gone.
 */
export interface OpsToolDeps extends ToolDeps {
  /** The version of context-mode this process is running. */
  VERSION: string;
  /** Newest published version, or null until/unless the npm check answers. */
  latestVersion: () => string | null;
  /** The semantic-coverage block appended to the report. */
  semanticIndexReport: () => string;
}

/**
 * What `ctx_purge` needs on top of {@link ToolDeps} — one field.
 *
 * The stats file is project-scoped and `src/server.ts` reads its path from two
 * other places (the boot-time rollup and the per-call persist), so the resolver
 * stayed there and the handler receives it. Everything else `ctx_purge` touches
 * it imports sideways: the store handle from `./state.js`, the wipe itself from
 * the session layer.
 */
export interface PurgeToolDeps extends ToolDeps {
  /** Path of this project's persisted stats file, reset by a project-wide purge. */
  getStatsFilePath: () => string;
}

/**
 * What `ctx_upgrade` needs on top of {@link ToolDeps} — two getters.
 *
 * `getRuntimeAwarePackageRoot` resolves the directory the upgrade writes into,
 * and the rule it encodes (only Codex may swap in the plugin-manager runtime
 * root; other adapters coexist on one machine) is boot-time knowledge that
 * `src/server.ts` owns. `getClientVersion` is the MCP handshake's clientInfo,
 * which only the live server object can answer — passing the value instead of
 * the getter would freeze it at registration, before the handshake completes.
 */
export interface UpgradeToolDeps extends ToolDeps {
  /** Plugin root to upgrade into, resolved per host platform. */
  getPackageRoot: () => string;
  /** clientInfo from the MCP handshake, or null before/without one. */
  getClientVersion: () => { name: string; version?: string } | undefined | null;
}

/**
 * What `ctx_doctor` needs on top of {@link ToolDeps} — eight facts about the
 * install, which is what a tool whose entire job is inspecting the install
 * legitimately needs.
 *
 * Every one of them is computed once at boot in `src/server.ts`. Recomputing
 * `detectRuntimes()` or re-running adapter detection inside the handler would
 * make the report describe a fresh detection pass rather than the process the
 * user is running — which is precisely the failure the tool is supposed to
 * catch. `REGISTERED_CTX_TOOLS` is passed as the live array rather than a
 * snapshot because it is the authoritative answer to "what does THIS session
 * have", and the delivery check compares it against what is on disk.
 */
export interface DoctorToolDeps extends ToolDeps {
  /** The version of context-mode this process is running. */
  VERSION: string;
  /** Runtimes detected once at boot; the report describes these, not a re-probe. */
  runtimes: RuntimeMap;
  /** Languages those runtimes enable, in the order the report prints them. */
  available: readonly string[];
  /** Plugin root to diagnose, resolved per host platform. */
  getPackageRoot: () => string;
  /** Pre-detection sessions directory, passed to the storage-dir resolvers. */
  getDefaultSessionDir: () => string;
  /** Host adapter for hook validation — detected, or resolved on demand. */
  getDiagnosticAdapter: () => Promise<HookAdapter | null>;
  /** The live registry: what this session actually registered. */
  REGISTERED_CTX_TOOLS: ReadonlyArray<{ name: string }>;
  /** clientInfo from the MCP handshake, or null before/without one. */
  getClientVersion: () => { name: string; version?: string } | undefined | null;
}

/**
 * What `ctx_index` needs on top of {@link ToolDeps} — two security-relevant
 * resolvers, both of which `ctx_execute_file` uses the same way.
 *
 * `checkFilePathDenyPolicy` reads the host's own Read deny policy; a second
 * implementation here would be a second opinion on which files are off limits,
 * which is how the gate of #442 gets bypassed. `resolveProjectPath` resolves
 * against the project root the env cascade picked, and that cascade is boot
 * state `src/server.ts` owns.
 */
export interface IndexToolDeps extends ToolDeps {
  /** Read deny-policy gate for a file path. Returns an error result, or null. */
  checkFilePathDenyPolicy: (filePath: string, toolName: string) => ToolResult | null;
  /** Resolve a caller-supplied path against the resolved project root. */
  resolveProjectPath: (filePath: string) => string;
}

/**
 * What `ctx_execute` and `ctx_execute_file` need on top of {@link ToolDeps}.
 *
 * The executor is the process-wide one, for the reason {@link FetchToolDeps}
 * gives: a second instance would not share the backgrounded-process registry
 * that shutdown drains.
 *
 * The other six stayed in `src/server.ts` on the rule wave 1 set — a region
 * travels only if the fork has actually rewritten it. `buildExecuteEcho` is the
 * echo family shared with the batch tools, untouched upstream (see
 * {@link BatchToolDeps}); the three `check*` guards read the host's own deny
 * policy and the resolved project root, so re-deriving any of them inside a
 * tool module would be a second opinion on what is off limits; and `langList` /
 * `bunNote` are rendered from the boot-time runtime detection, so recomputing
 * them here would describe a second probe rather than this process.
 */
export interface ExecuteToolDeps extends ToolDeps {
  /** The one polyglot executor this process owns. */
  executor: PolyglotExecutor;
  /** Deny firewall for non-shell source code (Python/Ruby/... equivalents). */
  checkNonShellDenyPolicy: (code: string, language: string, toolName: string) => ToolResult | null;
  /** Refuse a path outside the project root, before the deny globs run (#852). */
  checkProjectBoundary: (path: string, toolName: string) => ToolResult | null;
  /** Read deny-policy gate for a file path. Returns an error result, or null. */
  checkFilePathDenyPolicy: (filePath: string, toolName: string) => ToolResult | null;
  /** The fenced source-code preamble prepended to every execution response. */
  buildExecuteEcho: (language: string, code: string, path?: string) => string;
  /** Detected languages, rendered into the tool description at registration. */
  langList: string;
  /** The "(Bun detected — 3-5x faster)" clause, or "" when Bun is absent. */
  bunNote: string;
}
