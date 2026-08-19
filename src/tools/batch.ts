/**
 * `ctx_batch_execute` and `ctx_gather` — the two tools that run a batch of
 * shell commands, index every command's output, and answer the caller's
 * queries from that index in the same round trip.
 *
 * They ship together because they are one handler wearing two hats.
 * `ctx_gather` is the fork's read-only sibling (#1048): it proves each command
 * mutates nothing, then delegates to the very same `runBatchExecute`. Splitting
 * them across files would put a shared private function on the public surface
 * for no reason, and would let the two drift.
 *
 * This region is where the fork's diff against upstream is densest — the
 * read-only sibling is entirely ours, and `runBatchExecute` exists only because
 * we needed a body two tools could share. It conflicts on every
 * `sync-upstream` already, so moving it out costs nothing and leaves a smaller
 * `src/server.ts` for the next merge to reconcile.
 *
 * Everything `server.ts` owns arrives through {@link BatchToolDeps} rather than
 * an import, for the reason spelled out in `shared/deps.ts`: an import pointing
 * back at `server.ts` closes a cycle, and the bundler resolves cycles by
 * evaluating one side half-initialised. The counters are the exception — they
 * come from `shared/state.ts`, which imports nothing and so cannot close one.
 */

import { z } from "zod";

import { findWriteCommands } from "../read-only.js";
import type { BatchToolDeps } from "./shared/deps.js";
import { sessionStats } from "./shared/state.js";

/** Arguments accepted by both ctx_batch_execute and its read-only sibling. */
interface BatchExecuteArgs {
  commands: Array<{ label: string; command: string }>;
  queries: string[];
  timeout?: number;
  concurrency?: number;
  cwd?: string;
  query_scope?: "batch" | "global";
}

/**
 * Register `ctx_batch_execute` and `ctx_gather` on the server carried by
 * `deps`, in that order — MCP hosts render the tool list in registration
 * order and `tests/core/tool-registration.test.ts` pins it.
 */
export function registerBatchTools(deps: BatchToolDeps): void {
  const {
    getStore, trackResponse, trackIndexed, currentAttribution, checkDenyPolicy,
    coerceJsonArray, coerceCommandsArray, runBatchCommands, resolveExecTimeout,
    truncateCommandForEcho, formatBatchQueryResults,
  } = deps;

  // ─────────────────────────────────────────────────────────
  // Tool: batch_execute
  // ─────────────────────────────────────────────────────────

  deps.server.registerTool(
    "ctx_batch_execute",
    {
      title: "Batch Execute & Search",
      // #846: runs arbitrary shell commands (with network) and indexes output.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      description: `Run multiple commands in ONE call. Every command's output is auto-indexed into the knowledge base; if you also pass \`queries\`, the matching sections come back in the same round trip so a follow-up search call is not needed.

Concurrency parallelizes the FETCH phase (run-the-commands). The DERIVATION phase — turning raw output into an answer — still belongs in code: add a processing command that consumes the indexed output and prints only the answer, so the raw bytes never enter your conversation (Think-in-Code, same principle as ctx_execute).

WHEN:
  - Instead of Bash, when the output is long or you intend to filter it — the bytes land in storage and only the matched windows come back, where Bash puts every line in your conversation
  - You have 3+ related commands you would otherwise run sequentially (multi-issue lookups, git log + git diff + git blame, multi-file reads, multi-region cloud queries)
  - Instead of several Read calls across files: one command per file, indexed, answered by \`queries\` in the same round trip
  - You want to gather AND query in one round trip — pass \`queries\` so the matching sections come back inline
  - You want to parallelize I/O-bound work — pass \`concurrency\` 2-8 (network calls, gh CLI, cloud APIs, multi-repo git reads)
  - The combined output is large enough that piping it through ctx_search later would itself be expensive — let auto-index + inline queries do both in one shot

WHEN NOT:
  - The output is short, fixed, and you will read it verbatim (git status on a clean tree, whoami, a version string) — Bash is the smaller move
  - The point is to mutate state and see it succeed or fail (git commit, mkdir, rm, npm install) — Bash is direct, and there is nothing to index
  - Single command with no follow-up query — run it in ctx_execute directly
  - CPU-bound or stateful commands — keep concurrency at 1 (npm test, build, lint, port-binding servers, lock-file holders, anything that races on the same resource)

RETURNS:
  Auto-indexed section list per command label, plus top matches per query (when \`queries\` is passed). Raw output is NOT echoed in full — only the matched windows. Concurrency>1 switches each command to its own per-command timeout (no shared budget); concurrency=1 preserves the legacy shared-budget cascading-skip-on-timeout path. Use 4-8 for I/O-bound batches; keep at 1 for CPU work or shared-state commands; lower the value when target hosts enforce per-IP rate limits.

EXAMPLE: ctx_batch_execute(
  commands: [
    {label: "issue 1", command: "gh issue view 1"},
    {label: "issue 2", command: "gh issue view 2"},
    {label: "summarize", command: "echo done"}
  ],
  queries: ["root cause", "proposed fix"],
  concurrency: 2
)`,
      inputSchema: z.object({
        commands: z.preprocess(coerceCommandsArray, z
          .array(
            z.object({
              label: z
                .string()
                .describe(
                  "Section header for this command's output (e.g., 'README', 'Package.json', 'Source Tree')",
                ),
              command: z
                .string()
                .describe("Shell command to execute"),
            }),
          )
          .min(1)
          .describe(
            "Commands to execute as a batch. Output is labeled with the section header. " +
            "Default order is sequential; pass concurrency>1 to run in parallel (output stays in input order).",
          )),
        queries: z.preprocess(coerceJsonArray, z
          .array(z.string())
          .min(1)
          .describe(
            "Search queries to extract information from indexed output. Use 5-8 comprehensive queries. " +
            "Each returns top 5 matching sections with full content. " +
            "This is your ONLY chance — put ALL your questions here. No follow-up calls needed.",
          )),
        timeout: z
          .coerce.number()
          .optional()
          .describe("Max execution time in ms. When omitted, no server-side timer fires — the MCP host's RPC timeout governs. With concurrency=1, the value (when set) is a shared budget across commands; with concurrency>1, it is applied per-command."),
        concurrency: z
          .coerce.number()
          .int()
          .min(1)
          .max(8)
          .optional()
          .default(1)
          .describe(
            "Max commands to run in parallel (1-8, default: 1). " +
            "Use 4-8 for I/O-bound batches (network, gh, curl, multi-repo git reads). " +
            "Keep at 1 for CPU-bound (npm test, build, lint) or stateful commands (ports, locks). " +
            ">1 switches to per-command timeouts (no shared budget) and " +
            "individual `(timed out)` blocks instead of cascading skip.",
          ),
        cwd: z
          .string()
          .optional()
          .describe("Optional working directory for all shell commands in this batch."),
        query_scope: z
          .enum(["batch", "global"])
          .optional()
          .default("batch")
          .describe(
            "Scope for `queries` (default: `batch`). " +
            "`batch` searches ONLY the chunks produced by this batch's commands " +
            "— useful when you want answers about the just-fetched output. " +
            "`global` searches the entire persistent index (same scope as ctx_search) " +
            "— useful when you want the batch commands to enrich context and " +
            "the queries to also surface related prior knowledge in one round trip.",
          ),
      }),
    },
    runBatchExecute,
  );

  async function runBatchExecute(
    { commands, queries, timeout, concurrency, cwd, query_scope }: BatchExecuteArgs,
  ) {
    // Security: check each command against deny patterns
    for (const cmd of commands) {
      const denied = checkDenyPolicy(cmd.command, "batch_execute");
      if (denied) return denied;
    }

    try {
      // Full stdout is preserved per-command and indexed into FTS5 (Issue #61, #197).
      // Concurrency>1 switches to a worker pool with per-command timeouts.
      // NODE_OPTIONS for FS read tracking is injected by the bound runner —
      // the executor denies NODE_OPTIONS in its env (security), so it goes in
      // as an inline shell prefix that only affects child `node` invocations.
      const effTimeout = resolveExecTimeout(timeout);
      const { outputs: perCommandOutputs, timedOut } = await runBatchCommands(
        commands,
        {
          timeout: effTimeout,
          concurrency: concurrency ?? 1,
          cwd,
          onFsBytes: (bytes) => { sessionStats.bytesSandboxed += bytes; },
        },
      );

      const stdout = perCommandOutputs.join("\n");
      const totalBytes = Buffer.byteLength(stdout);
      const totalLines = stdout.split("\n").length;

      if (timedOut && perCommandOutputs.length === 0) {
        return trackResponse("ctx_batch_execute", {
          content: [
            {
              type: "text" as const,
              text: `Batch timed out after ${effTimeout}ms. No output captured.`,
            },
          ],
          isError: true,
        });
      }

      // Track indexed bytes (raw data that stays in sandbox)
      trackIndexed(totalBytes);

      // Index into knowledge base — markdown heading chunking splits by # labels
      const store = getStore();
      const source = `batch:${commands
        .map((c) => c.label)
        .join(",")
        .slice(0, 80)}`;
      const indexed = store.index({ content: stdout, source, attribution: currentAttribution() });

      // Commands inventory — list what the agent actually ran so the
      // response itself documents intent, not just per-section echoes.
      // Placed before "## Indexed Sections" so it scans top-down with
      // the human asking "what just happened" (Issues #717 + #736).
      const commandsInventory: string[] = ["## Commands", ""];
      for (const c of commands) {
        commandsInventory.push(`- ${c.label}: \`${truncateCommandForEcho(c.command)}\``);
      }

      // Build section inventory — direct query by source_id (no FTS5 MATCH needed)
      const allSections = store.getChunksBySource(indexed.sourceId);
      const inventory: string[] = ["## Indexed Sections", ""];
      const sectionTitles: string[] = [];
      for (const s of allSections) {
        const bytes = Buffer.byteLength(s.content);
        inventory.push(`- ${s.title} (${(bytes / 1024).toFixed(1)}KB)`);
        sectionTitles.push(s.title);
      }

      // Run all search queries — default scope is batch-local (legacy behavior).
      // When the caller passes query_scope: "global", searches reach the entire
      // persistent index in the same round trip. Cross-source search remains
      // available via explicit ctx_search() as well.
      const queryResults = await formatBatchQueryResults(store, queries, source, undefined, query_scope);

      // Get searchable terms for edge cases where follow-up is needed
      const distinctiveTerms = store.getDistinctiveTerms
        ? store.getDistinctiveTerms(indexed.sourceId)
        : [];

      const output = [
        `Executed ${commands.length} commands (${totalLines} lines, ${(totalBytes / 1024).toFixed(1)}KB). ` +
          `Indexed ${indexed.totalChunks} sections. Searched ${queries.length} queries.`,
        "",
        ...commandsInventory,
        "",
        ...inventory,
        "",
        ...queryResults,
        distinctiveTerms.length > 0
          ? `\nSearchable terms for follow-up: ${distinctiveTerms.join(", ")}`
          : "",
      ].join("\n");

      return trackResponse("ctx_batch_execute", {
        content: [{ type: "text" as const, text: output }],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return trackResponse("ctx_batch_execute", {
        content: [
          {
            type: "text" as const,
            text: `Batch execution error: ${message}`,
          },
        ],
        isError: true,
      });
    }
  }

  // ─────────────────────────────────────────────────────────
  // Tool: gather — read-only sibling of batch_execute (#1048)
  // ─────────────────────────────────────────────────────────

  deps.server.registerTool(
    "ctx_gather",
    {
      title: "Gather (read-only)",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description: `Read-only ctx_batch_execute: runs inspection commands, auto-indexes their output, and returns the sections matching \`queries\` — with a hard guarantee that nothing on the machine changed.

Every command must be provably read-only. Accepted: file inspection (cat, ls, head, tail, grep, find, wc, jq, stat), read subcommands of the common multiplexers (git log|show|diff|status|branch, docker ps|logs|inspect, kubectl get|describe|logs, npm ls|view|outdated), and system probes. Refused: output redirection, command substitution, sudo, and any binary not on the allowlist.

WHEN:
  - Instead of Bash while the host is in plan mode, where tools that may write are refused outright — this is the read-only gather path that survives that gate
  - Instead of a run of Read and Grep calls over a tree you are surveying: the output is indexed and answered by \`queries\`, so the files themselves stay out of your conversation
  - You must be able to promise the caller that a gather step mutated nothing
  - You want ctx_batch_execute's index-and-query round trip for a set of pure inspection commands

WHEN NOT:
  - Any command in the batch writes, installs, builds, or deploys — use ctx_batch_execute
  - A single command whose short output you will read verbatim — Bash is simpler
  - You are deriving an answer from data rather than collecting it — use ctx_execute

RETURNS:
  Auto-indexed section list per command label, plus the top matches per query. Raw output is NOT echoed in full — only the matched windows. When a command cannot be proven read-only, the call fails with that command named and nothing is executed.

EXAMPLE: ctx_gather(
  commands: [
    {label: "recent commits", command: "git log -20 --oneline"},
    {label: "failing service", command: "kubectl get pods -n prod"}
  ],
  queries: ["what changed recently", "which pods are unhealthy"]
)`,
      inputSchema: z.object({
        commands: z.preprocess(coerceCommandsArray, z
          .array(
            z.object({
              label: z.string().describe("Section header for this command's output"),
              command: z.string().describe("Read-only shell command to execute"),
            }),
          )
          .min(1))
          .describe("Read-only commands to run. Output is labeled with the section header."),
        queries: z
          .array(z.string())
          .min(1)
          .describe("Search queries run against the indexed output. Batch every question here."),
        concurrency: z
          .number()
          .int()
          .min(1)
          .max(8)
          .optional()
          .default(1)
          .describe("Max commands to run in parallel (1-8). Use 4-8 for network-bound reads."),
        cwd: z.string().optional().describe("Optional working directory for all commands."),
        timeout: z.number().optional().describe("Max execution time in ms."),
        query_scope: z
          .enum(["batch", "global"])
          .optional()
          .default("batch")
          .describe("`batch` (default) searches only this call's output; `global` searches the whole index."),
      }),
    },
    async ({ commands, queries, timeout, concurrency, cwd, query_scope }) => {
      const writes = findWriteCommands(commands);
      if (writes.length > 0) {
        const listed = writes.map(c => `  • ${c.label}: ${c.command}`).join("\n");
        return trackResponse("ctx_gather", {
          content: [
            {
              type: "text" as const,
              text:
                `ctx_gather accepts read-only commands only. These could not be proven read-only:\n${listed}\n\n` +
                "Either rewrite them as pure inspection commands, or call ctx_batch_execute " +
                "(outside plan mode) if the write is intended.",
            },
          ],
          isError: true,
        });
      }
      return runBatchExecute({ commands, queries, timeout, concurrency, cwd, query_scope });
    },
  );
}
