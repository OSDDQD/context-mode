/**
 * `ctx_graph` — structural questions answered from codegraph's index.
 *
 * Stage 3B of the consolidation plan. Before this, a structural question cost
 * an MCP round trip to a second server process whose answers arrived as prose
 * and landed in context whole. Now the plugin reads
 * `<project>/.codegraph/codegraph.db` directly (read-only — see
 * `src/graph/db.ts`) and returns the few lines that answer the question.
 *
 * Seven actions, six of them pure SQL:
 *
 * | action    | question                                       |
 * |-----------|------------------------------------------------|
 * | `symbols` | where is X defined?                            |
 * | `outline` | what is in this file? (map / signatures only)  |
 * | `callers` | who calls X?                                   |
 * | `callees` | what does X call?                              |
 * | `impact`  | what breaks if X changes?                      |
 * | `related` | what is adjacent to this file?                 |
 * | `explore` | show me the source and call paths for an area  |
 *
 * `explore` is the exception because it is the one thing the tables cannot
 * reproduce: it returns symbol SOURCE stitched to call paths, and its value is
 * exactly its completeness. It has no `--json`, so it is run as a CLI child and
 * its stdout is handled by the same pattern `src/fetch-passthrough.ts`
 * established — return it whole when it fits the budget, otherwise index it
 * under a label and hand back windows plus the handle to search for more.
 *
 * ## Security note on the passthrough branch
 *
 * "Return it whole" bypasses `ContentStore.index()`, and therefore bypasses
 * `ContentStore.#screen` (src/store.ts) — the only place indexed content meets
 * `redactSecrets`. `explore` returns SOURCE CODE, which is precisely where a
 * hardcoded credential lives. So the passthrough branch calls `redactSecrets`
 * itself, unconditionally, before a single byte is returned. This is not an
 * optimisation that can be skipped when the budget is generous: an unscreened
 * passthrough is a credential leak into the transcript.
 *
 * ## Registration
 *
 * `registerCtxGraph(deps)` follows `src/tools/search.ts`: everything owned by
 * `src/server.ts` arrives through {@link GraphToolDeps} instead of an import,
 * so the module graph stays one-way (server → tools) and the bundler never has
 * to resolve a cycle by half-initialising one side. `src/server.ts` is NOT
 * edited here; wiring it up is a separate change (see the note at the bottom of
 * this file).
 */

import { z } from "zod";

import {
  checkFreshness,
  cliFallbackEnabled,
  formatFreshnessLine,
  hasCodegraphIndex,
  normalizeProjectDir,
  notIndexedMessage,
  openGraphDb,
  runCodegraph,
  runCodegraphJson,
  type GraphDbHandle,
  type GraphOpenResult,
} from "../graph/db.js";
import {
  callees as qCallees,
  callers as qCallers,
  findFiles,
  graphStats,
  impact as qImpact,
  normalizeFilePath,
  outline as qOutline,
  related as qRelated,
  resolveSymbol,
  symbols as qSymbols,
  type OutlineRow,
  type RelatedResult,
  type SymbolRow,
  type WalkRow,
} from "../graph/queries.js";
import { ensureDaemon } from "../graph/daemon.js";
import { redactSecrets, redactOptionsFromEnv } from "../session/redact.js";
import type { ToolDeps, ToolResult } from "./shared/deps.js";

/**
 * `ctx_graph` needs nothing `ctx_search` does not already receive, so the alias
 * exists for documentation rather than for extra fields: if a later action does
 * need something from `src/server.ts`, it is added here and nowhere else.
 */
export type GraphToolDeps = ToolDeps;

/** Actions the tool accepts. */
export const GRAPH_ACTIONS = [
  "symbols",
  "outline",
  "callers",
  "callees",
  "impact",
  "related",
  "explore",
] as const;

export type GraphAction = (typeof GRAPH_ACTIONS)[number];

// ─────────────────────────────────────────────────────────
// Env switches
// ─────────────────────────────────────────────────────────

/** `CONTEXT_MODE_GRAPH=0` removes the tool from the surface entirely. */
export function graphToolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CONTEXT_MODE_GRAPH !== "0";
}

/**
 * `CONTEXT_MODE_GRAPH_EXPLORE_PASSTHROUGH=0` forces every explore result
 * through the index, no matter how small. The screening is identical either
 * way; what changes is whether the bytes land in context now or on request.
 */
export function explorePassthroughEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CONTEXT_MODE_GRAPH_EXPLORE_PASSTHROUGH !== "0";
}

/** Bytes of explore output returned inline before the index takes over. */
export function exploreBudgetBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CONTEXT_MODE_GRAPH_EXPLORE_BUDGET;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 24_000;
}

// ─────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────

function loc(filePath: string, line: number): string {
  return line > 0 ? `${filePath}:${line}` : filePath;
}

function formatSymbolRows(rows: SymbolRow[]): string {
  return rows
    .map(r => {
      const sig = r.signature ? ` — ${collapse(r.signature)}` : "";
      return `${r.kind} ${r.qualifiedName}  ${loc(r.filePath, r.startLine)}${sig}`;
    })
    .join("\n");
}

function formatOutlineRows(rows: OutlineRow[], signaturesOnly: boolean): string {
  return rows
    .map(r => {
      const flags = [r.isExported ? "export" : null, r.isAsync ? "async" : null]
        .filter(Boolean)
        .join(" ");
      const head = `${String(r.startLine).padStart(5)}  ${flags ? `${flags} ` : ""}${r.kind} ${r.name}`;
      if (signaturesOnly) return r.signature ? `${head} — ${collapse(r.signature)}` : head;
      const doc = r.docstring ? `\n         ${collapse(r.docstring, 160)}` : "";
      const sig = r.signature ? ` — ${collapse(r.signature)}` : "";
      return `${head}${sig}${doc}`;
    })
    .join("\n");
}

function formatWalkRows(rows: WalkRow[]): string {
  return rows
    .map(r => `${"·".repeat(r.depth)} [d${r.depth}] ${r.qualifiedName}  ${loc(r.filePath, r.startLine)}`)
    .join("\n");
}

function collapse(text: string, max = 200): string {
  const one = String(text).replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

// ─────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────

/** Register `ctx_graph` on the server carried by `deps`. */
export function registerCtxGraph(deps: GraphToolDeps): void {
  if (!graphToolEnabled()) return;

  const { getStore, getProjectDir, trackResponse, trackIndexed, currentAttribution } = deps;

  deps.server.registerTool(
    "ctx_graph",
    {
      title: "Code Graph",
      // Read-only against another process's index. Declared so hosts that
      // cancel unannotated tools (see the note on ctx_stats) leave it alone.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description: `Answer structural questions about this codebase from the codegraph index instead of reading files into context.

  The index is a SQLite graph of declarations and the edges between them (calls, imports, extends, implements, references), built by codegraph and read here directly. Seven actions share one contract: \`symbols\` finds where a name is defined, \`outline\` lists every declaration in one file in source order with signatures, \`callers\` and \`callees\` walk the call graph transitively with a depth limit, \`impact\` reports what breaks if a symbol changes (calls plus references plus subclasses), \`related\` names the symbols and files the graph places next to a file, and \`explore\` returns source bodies together with the call paths that reach them. Answers are a few lines each; the graph itself stays in SQLite. Every response states whether the index lags behind the working tree.

  WHEN:
    - Instead of Grep on a symbol name, when you want who calls it, what it calls, or what breaks if you change it — a grep returns matching lines, this returns the edges
    - Instead of Read on a whole file, when you want its shape: every declaration and signature in source order, a few lines instead of the file
    - Instead of Grep on a name you have only seen used: this returns the definition site with kind, signature and file:line
    - You want the neighbourhood of a file: what the graph places next to it by imports and calls
    - You want source bodies plus the call paths reaching them for one area of the code (pass \`action: "explore"\`)

  WHEN NOT:
    - You are looking for arbitrary text, a comment, or a string literal — that is lexical, so use ctx_find
    - You are about to edit the file — Read it, because Edit matches against the exact bytes in your conversation
    - You want content you captured earlier (command output, fetched docs, session memory) — that lives in ctx_search
    - The project has no codegraph index yet — run \`codegraph init\` once in the project first

  RETURNS:
    Ranked plain-text rows carrying qualified name, kind, file:line and signature, with traversal depth for the walking actions. \`related\` additionally emits a machine-readable JSON block (nodes and files scored by edge weight and hop distance). A stale index is reported inline as "index lags N files" rather than silently answering from old data. Tune via CONTEXT_MODE_GRAPH, CONTEXT_MODE_GRAPH_DAEMON, CONTEXT_MODE_GRAPH_EXPLORE_PASSTHROUGH, CONTEXT_MODE_GRAPH_FRESHNESS.

  EXAMPLE: ctx_graph(action: "callers", symbol: "ContentStore.index")
  EXAMPLE: ctx_graph(action: "outline", file: "src/store.ts", signaturesOnly: true)
  EXAMPLE: ctx_graph(action: "impact", symbol: "redactSecrets", depth: 3)
  EXAMPLE: ctx_graph(action: "explore", query: "session attribution")`,
      inputSchema: z.object({
        action: z
          .enum(GRAPH_ACTIONS)
          .describe("Which question to ask: symbols | outline | callers | callees | impact | related | explore"),
        query: z
          .string()
          .optional()
          .describe("Search text. Required for `symbols` and `explore`."),
        symbol: z
          .string()
          .optional()
          .describe("Symbol name or qualified name. Required for `callers`, `callees`, `impact`."),
        file: z
          .string()
          .optional()
          .describe("File path, absolute or project-relative. Required for `outline` and `related`."),
        depth: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("Traversal depth for callers/callees/impact/related (default 2, related 1)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximum rows returned."),
        kind: z
          .string()
          .optional()
          .describe("Restrict `symbols` to one node kind (function, class, method, …)."),
        signaturesOnly: z
          .boolean()
          .optional()
          .describe("`outline`: one line per declaration, no docstrings."),
        project: z
          .string()
          .optional()
          .describe("Project root to query. Defaults to the current project."),
      }),
    },
    async (params) => {
      try {
        const p = params as {
          action: GraphAction;
          query?: string;
          symbol?: string;
          file?: string;
          depth?: number;
          limit?: number;
          kind?: string;
          signaturesOnly?: boolean;
          project?: string;
        };
        const projectDir = normalizeProjectDir(p.project || getProjectDir());

        if (!hasCodegraphIndex(projectDir)) {
          return trackResponse("ctx_graph", textResult(notIndexedMessage(projectDir), true));
        }

        // Best-effort, idempotent, and cheap on the hot path (one readFile plus
        // one kill(pid,0) when a daemon is already up). Nothing downstream
        // depends on the outcome — a missing daemon costs freshness, not
        // correctness, and `checkFreshness` reports that separately.
        try { ensureDaemon(projectDir); } catch { /* never block a query on supervision */ }

        if (p.action === "explore") {
          return trackResponse("ctx_graph", runExplore({
            projectDir,
            query: String(p.query ?? "").trim(),
            store: getStore,
            trackIndexed,
            attribution: currentAttribution,
          }));
        }

        const opened = openGraphDb(projectDir);
        if (!opened.ok) {
          return trackResponse("ctx_graph", degrade(opened, projectDir, p));
        }

        const handle = opened.handle;
        try {
          return trackResponse("ctx_graph", runSqlAction(handle, projectDir, p));
        } finally {
          handle.close();
        }
      } catch (err) {
        return trackResponse(
          "ctx_graph",
          textResult(`ctx_graph failed: ${err instanceof Error ? err.message : String(err)}`, true),
        );
      }
    },
  );
}

// ─────────────────────────────────────────────────────────
// SQL actions
// ─────────────────────────────────────────────────────────

interface ActionParams {
  action: GraphAction;
  query?: string;
  symbol?: string;
  file?: string;
  depth?: number;
  limit?: number;
  kind?: string;
  signaturesOnly?: boolean;
}

function runSqlAction(handle: GraphDbHandle, projectDir: string, p: ActionParams): ToolResult {
  const header: string[] = [];
  const freshness = formatFreshnessLine(checkFreshness(handle));
  if (freshness) header.push(freshness);

  switch (p.action) {
    case "symbols": {
      const query = String(p.query ?? "").trim();
      if (!query) return textResult("`symbols` needs a `query`.", true);
      const rows = qSymbols(handle, { query, limit: p.limit, kind: p.kind });
      if (rows.length === 0) {
        const stats = graphStats(handle);
        return textResult(
          join(header, [
            `No symbol matches "${query}" in ${projectDir} (${stats.nodes} nodes indexed).`,
            "Try a shorter fragment — matching is prefix-based per token.",
          ]),
        );
      }
      return textResult(join(header, [
        `${rows.length} symbol${rows.length === 1 ? "" : "s"} matching "${query}":`,
        formatSymbolRows(rows),
      ]));
    }

    case "outline": {
      const file = String(p.file ?? "").trim();
      if (!file) return textResult("`outline` needs a `file`.", true);
      const rows = qOutline(handle, { filePath: file, limit: p.limit });
      const normalized = normalizeFilePath(projectDir, file);
      if (rows.length === 0) {
        const near = findFiles(handle, normalized.split("/").pop() ?? normalized);
        return textResult(join(header, [
          `No indexed symbols for ${normalized}.`,
          near.length ? `Indexed paths that look similar:\n${near.join("\n")}` : "",
        ]));
      }
      return textResult(join(header, [
        `${normalized} — ${rows.length} declaration${rows.length === 1 ? "" : "s"}:`,
        formatOutlineRows(rows, p.signaturesOnly === true),
      ]));
    }

    case "callers":
    case "callees":
    case "impact": {
      const symbol = String(p.symbol ?? "").trim();
      if (!symbol) return textResult(`\`${p.action}\` needs a \`symbol\`.`, true);
      const resolved = resolveSymbol(handle, symbol);
      if (resolved.ids.length === 0) {
        return textResult(join(header, [
          `No symbol named "${symbol}" in the index.`,
          "Use action \"symbols\" to find the exact qualified name first.",
        ]));
      }
      // An `fts` resolution means the name was ambiguous; say so, because the
      // walk below is the union over every match and the caller should know
      // that "37 callers" may be 37 callers of four different things.
      if (resolved.via !== "qualified" && resolved.matches.length > 1) {
        header.push(
          `"${symbol}" matched ${resolved.matches.length} symbols (${resolved.via}); ` +
          `walking all of them: ${resolved.matches.slice(0, 5).map(m => m.qualifiedName).join(", ")}` +
          (resolved.matches.length > 5 ? ", …" : ""),
        );
      }

      const walkOpts = { roots: resolved.ids, depth: p.depth, limit: p.limit };
      const rows =
        p.action === "callers" ? qCallers(handle, walkOpts)
        : p.action === "callees" ? qCallees(handle, walkOpts)
        : qImpact(handle, walkOpts);

      if (rows.length === 0) {
        const what =
          p.action === "callers" ? "Nothing calls or references"
          : p.action === "callees" ? "It calls nothing indexed:"
          : "Nothing depends on";
        return textResult(join(header, [`${what} ${resolved.matches[0]?.qualifiedName ?? symbol}.`]));
      }
      const title =
        p.action === "callers" ? `${rows.length} caller(s) of`
        : p.action === "callees" ? `${rows.length} callee(s) of`
        : `${rows.length} symbol(s) affected by a change to`;
      return textResult(join(header, [
        `${title} ${resolved.matches[0]?.qualifiedName ?? symbol}:`,
        formatWalkRows(rows),
      ]));
    }

    case "related": {
      const file = String(p.file ?? "").trim();
      if (!file) return textResult("`related` needs a `file`.", true);
      const result = qRelated(handle, { filePath: file, depth: p.depth, limit: p.limit });
      if (result.seedNodes === 0) {
        return textResult(join(header, [
          `${result.seedFile} contributes no nodes to the index — nothing to relate.`,
        ]));
      }
      return textResult(join(header, [formatRelated(result)]));
    }

    default:
      return textResult(`Unknown action "${String(p.action)}".`, true);
  }
}

/**
 * `related` renders twice: prose for the reader, JSON for the ranker.
 *
 * The JSON block is not decoration. This action becomes a graph-derived
 * ranking signal in a later stage, and a consumer that has to parse
 * "src/x.ts (weight 3.2)" out of prose is a consumer that breaks the first
 * time the prose is reworded. Fenced as ```json and keyed exactly as
 * `RelatedResult`.
 */
export function formatRelated(result: RelatedResult): string {
  const lines: string[] = [
    `Neighbourhood of ${result.seedFile} (${result.seedNodes} symbols in the file):`,
  ];
  if (result.files.length > 0) {
    lines.push("", "Files, by graph weight:");
    for (const f of result.files.slice(0, 15)) {
      lines.push(`  ${f.weight.toFixed(2)}  ${f.filePath}  (${f.nodes} symbol${f.nodes === 1 ? "" : "s"}, d${f.minDistance})`);
    }
  }
  if (result.nodes.length > 0) {
    lines.push("", "Symbols, by graph weight:");
    for (const n of result.nodes.slice(0, 20)) {
      lines.push(`  ${n.weight.toFixed(2)}  ${n.direction} ${n.via.join("+")}  ${n.qualifiedName}  ${loc(n.filePath, n.startLine)}`);
    }
  }
  if (result.truncated) lines.push("", "(list truncated — raise `limit` for more)");

  lines.push(
    "",
    "Machine-readable (RelatedResult):",
    "```json",
    JSON.stringify(
      {
        seedFile: result.seedFile,
        seedNodes: result.seedNodes,
        truncated: result.truncated,
        nodes: result.nodes,
        files: result.files,
      },
      null,
      0,
    ),
    "```",
  );
  return lines.join("\n");
}

function join(header: string[], body: string[]): string {
  return [...header, ...body].filter(s => s && s.length > 0).join("\n\n");
}

// ─────────────────────────────────────────────────────────
// CLI degradation
// ─────────────────────────────────────────────────────────

/**
 * What to do when the database could not be read.
 *
 * A drifted schema is the interesting case: the tables may still be there and
 * may still look right, which is exactly why the direct read is refused. The
 * CLI's `-j/--json` output is a narrower contract that codegraph maintains
 * across schema migrations, so it answers instead — for the four actions that
 * have a CLI equivalent. `outline` and `related` have none, and a made-up
 * answer is worse than an honest refusal.
 */
function degrade(
  opened: Extract<GraphOpenResult, { ok: false }>,
  projectDir: string,
  p: ActionParams,
): ToolResult {
  if (opened.reason === "no-index") return textResult(notIndexedMessage(projectDir), true);
  if (opened.reason === "incomplete") return textResult(opened.message, true);
  if (!cliFallbackEnabled()) {
    return textResult(
      `${opened.message}\nCLI fallback is disabled (CONTEXT_MODE_GRAPH_CLI_FALLBACK=0).`,
      true,
    );
  }

  const limit = String(p.limit ?? 20);
  const depth = String(p.depth ?? 2);
  let args: string[] | null = null;
  switch (p.action) {
    case "symbols":
      if (p.query) args = ["query", p.query, "-p", projectDir, "-l", limit];
      break;
    case "callers":
      if (p.symbol) args = ["callers", p.symbol, "-p", projectDir, "-l", limit];
      break;
    case "callees":
      if (p.symbol) args = ["callees", p.symbol, "-p", projectDir, "-l", limit];
      break;
    case "impact":
      if (p.symbol) args = ["impact", p.symbol, "-p", projectDir, "-d", depth];
      break;
    default:
      args = null;
  }

  if (!args) {
    return textResult(
      `${opened.message}\n` +
      `Action "${p.action}" has no codegraph CLI equivalent, so it cannot be answered while ` +
      "the direct read is unavailable.",
      true,
    );
  }

  const json = runCodegraphJson(args, { cwd: projectDir });
  if (json !== null) {
    return textResult(`${opened.message}\n\nAnswered via the codegraph CLI:\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``);
  }
  const raw = runCodegraph(args, { cwd: projectDir });
  if (!raw.ok) {
    return textResult(`${opened.message}\n\nThe codegraph CLI also failed: ${raw.stderr.trim() || `exit ${raw.code}`}`, true);
  }
  // Text from the CLI has never passed the store's screening, same as the
  // explore passthrough below — screen it here.
  return textResult(`${opened.message}\n\nAnswered via the codegraph CLI:\n${screen(raw.stdout)}`);
}

// ─────────────────────────────────────────────────────────
// explore
// ─────────────────────────────────────────────────────────

/**
 * Screen credentials out of anything that reaches context without passing
 * through `ContentStore.index()`.
 *
 * This is `redactSecrets` from `src/session/redact.ts` — the content screener
 * that `ContentStore.#screen` calls. NOT the same-named function in
 * `src/session/extract.ts`, which redacts `tool_input` on its way into
 * SessionDB and knows nothing about source files.
 */
export function screen(text: string, env: NodeJS.ProcessEnv = process.env): string {
  return redactSecrets(text, redactOptionsFromEnv(env)).text;
}

export interface ExploreDeps {
  projectDir: string;
  query: string;
  store: () => import("../store.js").ContentStore;
  trackIndexed: (bytes: number, source?: string) => void;
  attribution: () => { sessionId?: string } | undefined;
  env?: NodeJS.ProcessEnv;
}

/**
 * Run `codegraph explore` and return its output within a byte budget.
 *
 * Two branches, one screening rule:
 *
 * - **Under budget** → return the text (screened) without indexing. This is the
 *   branch that would otherwise skip `ContentStore.#screen`, so the screening
 *   is applied here explicitly and unconditionally.
 * - **Over budget** → index under `codegraph:explore:<query>` (the store screens
 *   it again on the way in — screening is idempotent) and return the top
 *   windows plus the source label, so the caller can pull more with
 *   `ctx_search(source: …)` instead of receiving 300 KB of source now.
 */
export function runExplore(deps: ExploreDeps): ToolResult {
  const env = deps.env ?? process.env;
  const query = deps.query.trim();
  if (!query) return textResult("`explore` needs a `query`.", true);

  const res = runCodegraph(["explore", query, "-p", deps.projectDir], {
    cwd: deps.projectDir,
    env,
  });
  if (!res.ok && !res.stdout.trim()) {
    return textResult(
      `codegraph explore failed: ${res.stderr.trim() || `exit ${res.code}`}`,
      true,
    );
  }

  const screened = screen(res.stdout, env);
  const label = `codegraph:explore:${query}`;
  const bytes = Buffer.byteLength(screened, "utf-8");
  const budget = exploreBudgetBytes(env);

  if (bytes <= budget && explorePassthroughEnabled(env)) {
    return textResult(`${label}\n\n${screened}`);
  }

  let indexed: { totalChunks: number } | null = null;
  try {
    indexed = deps.store().index({
      content: screened,
      source: label,
      attribution: deps.attribution(),
    });
    deps.trackIndexed(bytes, label);
  } catch (err) {
    // Indexing failed and the output is too large to return whole. Give the
    // head of it rather than nothing — still screened.
    return textResult(
      `codegraph explore returned ${bytes} bytes and could not be indexed ` +
      `(${err instanceof Error ? err.message : String(err)}). First ${budget} bytes:\n\n` +
      screened.slice(0, budget),
    );
  }

  const store = deps.store();
  const windows = store.searchWithFallback(query, 3, label);
  const body = windows
    .map(w => `## ${w.title}\n${w.content}`)
    .join("\n\n");

  return textResult(
    [
      `codegraph explore "${query}" returned ${bytes} bytes (budget ${budget}) — ` +
      `indexed as ${indexed?.totalChunks ?? 0} chunks under source "${label}" instead of returned whole.`,
      body || "(no window matched the query text; the full output is in the index)",
      `Pull more with: ctx_search(queries: ["…"], source: "${label}")`,
    ].join("\n\n"),
  );
}

/**
 * ─────────────────────────────────────────────────────────
 * WIRING (not done here, by design)
 * ─────────────────────────────────────────────────────────
 *
 * `src/server.ts` is owned by a parallel change, so this module registers
 * nothing on its own. To wire it up, two lines:
 *
 *   import { registerCtxGraph } from "./tools/graph.js";
 *   registerCtxGraph(toolDeps());
 *
 * next to the existing `registerCtxSearch(toolDeps())` call. `toolDeps()`
 * already returns everything {@link GraphToolDeps} requires — no new field on
 * `ToolDeps`, no new argument.
 *
 * Optionally, to keep the index warm even when no ctx_graph call has happened
 * yet, `src/server.ts` may call `ensureDaemon(projectDir)` from
 * `src/graph/daemon.js` at startup; the handler already calls it per request,
 * so this is an optimisation rather than a requirement.
 */
