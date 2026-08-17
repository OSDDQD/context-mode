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

  /** Progressive per-agent search throttle (#769). */
  searchFloodGuard: FloodGuard;
  /** Bucket key for the throttle — one window per agent, not per machine. */
  searchFloodGuardKey: () => string;
  /** Calls after which results taper to one per query. */
  SEARCH_MAX_RESULTS_AFTER: number;
  /** Calls after which the tool refuses and demands batching. */
  SEARCH_BLOCK_AFTER: number;
}
