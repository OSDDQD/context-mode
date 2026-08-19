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
import type { HookAdapter } from "../../adapters/types.js";
import type { PolyglotExecutor } from "../../executor.js";
import type { FloodGuard } from "../../search/flood-guard.js";

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
 * What `ctx_stats` needs on top of {@link ToolDeps} — the four values it
 * reports that `src/server.ts` owns: the running version, the newer version
 * the background npm check may have found, the semantic-index footer, and the
 * sweep that retires stale per-session stats files.
 */
export interface OpsToolDeps extends ToolDeps {
  /** The version of context-mode this process is running. */
  VERSION: string;
  /** Newest published version, or null until/unless the npm check answers. */
  latestVersion: () => string | null;
  /** The semantic-coverage block appended to the report. */
  semanticIndexReport: () => string;
  /** Retire per-session stats files nothing has written to in weeks. */
  rollUpStaleStatsFiles: (sessionsDir: string, maxAgeDays?: number) => number;
}
