/**
 * `ctx_graph` — structural questions answered from codegraph's index.
 *
 * Stage 3B of the consolidation plan. Before this, a structural question cost
 * an MCP round trip to a second server process whose answers arrived as prose
 * and landed in context whole. Now the plugin reads
 * `<project>/.codegraph/codegraph.db` directly (read-only — see
 * `src/graph/db.ts`) and returns the few lines that answer the question.
 *
 * Nine actions, eight of them served from the tables:
 *
 * | action    | question                                       |
 * |-----------|------------------------------------------------|
 * | `symbols` | where is X defined?                            |
 * | `outline` | what is in this file? (map / signatures only)  |
 * | `body`    | show me the source of X, and nothing else      |
 * | `callers` | who calls X?                                   |
 * | `callees` | what does X call?                              |
 * | `impact`  | what breaks if X changes?                      |
 * | `related` | what is adjacent to this file?                 |
 * | `map`     | what is this repository, in N tokens?          |
 * | `explore` | show me the source and call paths for an area  |
 *
 * `body` is the one action that touches the filesystem: the tables hold the
 * line RANGE, the file holds the lines. The slicing lives in `src/graph/body.ts`
 * so `src/graph/queries.ts` can keep its promise of no I/O beyond the read-only
 * connection. `map` is pure SQL plus arithmetic — see `src/graph/map.ts`.
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
 * `body` returns source code read straight off disk and `map` returns
 * signatures read straight out of the index — neither passes through
 * `ContentStore.index()` either, so both are screened by the same call for the
 * same reason. A secret in the body of the function someone asked to see is the
 * likeliest secret in this whole tool.
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
  MISSING_INDEX_CONSEQUENCE,
  checkFreshness,
  cliFallbackEnabled,
  firstMissingIndexNotice,
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
import { bodyBudgetBytes, readSymbolBody, type SymbolBody } from "../graph/body.js";
import {
  DEFAULT_BUDGET_TOKENS,
  FOCUS_BOOST,
  renderRepoMap,
  repoMap,
  type RepoMapResult,
} from "../graph/map.js";
import { ensureDaemon } from "../graph/daemon.js";
import { activeFsWiring } from "../fs-bus/index.js";
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
  "body",
  "callers",
  "callees",
  "impact",
  "related",
  "map",
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

  The index is a SQLite graph of declarations and the edges between them (calls, imports, extends, implements, references), built by codegraph and read here directly. Nine actions share one contract: \`symbols\` finds where a name is defined, \`outline\` lists every declaration in one file in source order with signatures, \`body\` returns the source of one named symbol and nothing else, \`callers\` and \`callees\` walk the call graph transitively with a depth limit, \`impact\` reports what breaks if a symbol changes (calls plus references plus subclasses), \`related\` names the symbols and files the graph places next to a file, \`map\` ranks the whole repository by personalized PageRank and packs files plus signatures into a token \`budget\`, and \`explore\` returns source bodies together with the call paths that reach them. Answers are a few lines each; the graph itself stays in SQLite. Every response states whether the index lags behind the working tree.

  WHEN:
    - Instead of Read on a whole file when you want ONE function: \`action: "body"\` slices exactly its lines
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
    Ranked plain-text rows carrying qualified name, kind, file:line and signature, with traversal depth for the walking actions. \`related\` additionally emits a machine-readable JSON block (nodes and files scored by edge weight and hop distance), trimmed to the rows shown unless \`fullJson: true\`. A stale index is reported inline as "index lags N files" rather than silently answering from old data. Tune via CONTEXT_MODE_GRAPH, CONTEXT_MODE_GRAPH_DAEMON, CONTEXT_MODE_GRAPH_EXPLORE_PASSTHROUGH, CONTEXT_MODE_GRAPH_FRESHNESS.

  EXAMPLE: ctx_graph(action: "callers", symbol: "ContentStore.index")
  EXAMPLE: ctx_graph(action: "outline", file: "src/store.ts", signaturesOnly: true)
  EXAMPLE: ctx_graph(action: "impact", symbol: "redactSecrets", depth: 3)
  EXAMPLE: ctx_graph(action: "explore", query: "session attribution")
  EXAMPLE: ctx_graph(action: "map", budget: 1024, focus: "retry handling")`,
      inputSchema: z.object({
        action: z
          .enum(GRAPH_ACTIONS)
          .describe("Which question to ask. `body` slices one symbol's source; `map` packs the repo into `budget`."),
        query: z
          .string()
          .optional()
          .describe("Search text. Required for `symbols` and `explore`."),
        symbol: z
          .string()
          .optional()
          .describe("Symbol name or qualified name. Required for `callers`, `callees`, `impact`, `body`."),
        budget: z
          .number()
          .int()
          .min(64)
          .max(32_000)
          .optional()
          .describe(`\`map\`: token budget (default ${DEFAULT_BUDGET_TOKENS}).`),
        focus: z
          .string()
          .optional()
          .describe("`map`: bias the ranking toward files matching these terms."),
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
        fullJson: z
          .boolean()
          .optional()
          .describe(
            "`related`: emit the complete RelatedResult JSON instead of the trimmed block.",
          ),
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
          fullJson?: boolean;
          budget?: number;
          focus?: string;
          project?: string;
        };
        const projectDir = normalizeProjectDir(p.project || getProjectDir());

        if (!hasCodegraphIndex(projectDir)) {
          // The refusal itself is loud, but what the missing index costs the
          // REST of the session is not, so the first time a project is found
          // unindexed the answer also names the signals that go blind.
          const body = firstMissingIndexNotice(projectDir)
            ? `${notIndexedMessage(projectDir)}\n\n${MISSING_INDEX_CONSEQUENCE}`
            : notIndexedMessage(projectDir);
          return trackResponse("ctx_graph", textResult(body, true));
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
          // Releases the pooled lease, not the connection: `openGraphDb` hands
          // out leases over one long-lived read-only handle per index file, so
          // the next action pays a stat() instead of an open + pragma + two
          // schema SELECTs. Unbalanced leases would pin the entry forever.
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

export interface ActionParams {
  action: GraphAction;
  query?: string;
  symbol?: string;
  file?: string;
  depth?: number;
  limit?: number;
  kind?: string;
  signaturesOnly?: boolean;
  fullJson?: boolean;
  budget?: number;
  focus?: string;
}

/**
 * A token that changes exactly when the working tree under `projectDir` might
 * have — or `null` when nothing is watching it.
 *
 * This is the cheap half of the freshness fix. The expensive half is the
 * `stat()` sweep in `checkFreshness`; the fs-bus is already subscribed to fff's
 * watcher for this root and already counts every batch and event it delivers,
 * so while those counters stand still there is nothing on disk that could have
 * changed the previous sweep's answer. Handing the counters over as an opaque
 * revision lets the cache stay valid past its TTL without `src/graph/db.ts`
 * having to import the bus (fs-bus → graph/daemon → graph/db is already an
 * edge; the reverse edge would close a cycle).
 */
function fsBusRevision(projectDir: string): string | null {
  try {
    const status = activeFsWiring(projectDir);
    if (!status || !status.active) return null;
    return `${status.batches}:${status.events}:${status.rescans}`;
  } catch {
    // Diagnostics must never decide whether a query runs.
    return null;
  }
}

/** Exported for tests: the action dispatch, without the MCP registration around it. */
export function runSqlAction(handle: GraphDbHandle, projectDir: string, p: ActionParams): ToolResult {
  const header: string[] = [];
  const freshness = formatFreshnessLine(
    checkFreshness(handle, { revision: fsBusRevision(projectDir) }),
  );
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

    case "body": {
      const symbol = String(p.symbol ?? "").trim();
      if (!symbol) return textResult("`body` needs a `symbol`.", true);
      const resolved = resolveSymbol(handle, symbol, { kind: p.kind });
      if (resolved.matches.length === 0) {
        return textResult(join(header, [
          `No symbol named "${symbol}" in the index.`,
          "Use action \"symbols\" to find the exact qualified name first.",
        ]));
      }
      // Ambiguity is answered with a LIST, never with a pick.
      //
      // Concatenating every match would return four function bodies to a caller
      // who asked for one — exactly the flood this action exists to stop — and
      // silently taking `matches[0]` would return the wrong function with no
      // sign that a choice was made. Naming the candidates costs one line each
      // and lets the next call be exact.
      if (resolved.matches.length > 1) {
        const shown = resolved.matches.slice(0, BODY_DISAMBIGUATION_LINES);
        return textResult(join(header, [
          `"${symbol}" matches ${resolved.matches.length} symbols (${resolved.via}) — ` +
          "ask again with one of these qualified names:",
          formatSymbolRows(shown),
          resolved.matches.length > shown.length
            ? `(${resolved.matches.length - shown.length} more not listed)`
            : "",
        ]));
      }
      const row = resolved.matches[0]!;
      return textResult(join(header, [formatBody(row, readSymbolBody(handle, row))]));
    }

    case "map": {
      const result = repoMap(handle, { focus: p.focus });
      if (result.totalFiles === 0) {
        // The database exists and opened cleanly, but holds no declarations —
        // an interrupted or empty `codegraph init`. Saying "no files match" here
        // would send the caller looking for a query bug that is not there.
        return textResult(join(header, [
          `The codegraph index for ${projectDir} holds no declarations, so there is nothing to map.`,
          `Run \`codegraph init ${projectDir}\` to build it.`,
        ]), true);
      }
      return textResult(join(header, [formatRepoMap(result, p.budget)]));
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
      return textResult(join(header, [formatRelated(result, { full: p.fullJson === true })]));
    }

    default:
      return textResult(`Unknown action "${String(p.action)}".`, true);
  }
}

/** Candidate symbols listed when a name resolves to more than one node. */
export const BODY_DISAMBIGUATION_LINES = 10;

/**
 * One symbol's source, with every caveat the slice carries stated above it.
 *
 * The staleness line is the important one. `start_line`/`end_line` were true at
 * index time; if the file has moved on, the same range now names whatever code
 * slid into those line numbers, and it will look perfectly plausible. A caller
 * who is told may re-index or open the file; a caller who is not told edits the
 * wrong function.
 */
export function formatBody(row: SymbolRow, body: SymbolBody): string {
  const where = `${body.filePath}:${body.startLine}-${body.endLine}`;
  const lines: string[] = [`${row.kind} ${row.qualifiedName}  ${where}`];

  if (body.error) {
    lines.push(
      "",
      `The index points at ${where}, but the file could not be read: ${body.error}`,
      "The index is describing a file that is no longer there — re-run `codegraph index`.",
    );
    return lines.join("\n");
  }

  if (body.stale === true) {
    lines.push(
      "",
      `⚠ ${body.filePath} has been modified since it was indexed, so lines ` +
      `${body.startLine}-${body.endLine} may no longer be this symbol. ` +
      "Re-run `codegraph index` before trusting the range.",
    );
  } else if (body.stale === null) {
    lines.push(
      "",
      `(no \`files\` row for ${body.filePath}, so the index cannot confirm these ` +
      "line numbers are current)",
    );
  }

  if (body.text.length === 0) {
    lines.push("", `The file has no line ${body.startLine} — it is shorter than the index thinks.`);
    return lines.join("\n");
  }

  // A fence longer than any backtick run in the body, so source that itself
  // contains a markdown fence cannot break out of the block.
  const longest = Math.max(0, ...[...body.text.matchAll(/`+/g)].map(m => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  lines.push("", fence, screen(body.text), fence);

  if (body.truncated) {
    lines.push(
      `(showing lines ${body.startLine}-${body.lastLine} of ${body.startLine}-${body.endLine} — ` +
      `cut at the ${bodyBudgetBytes()}-byte budget; raise CONTEXT_MODE_GRAPH_BODY_BUDGET, ` +
      "or read the rest with ctx_read)",
    );
  } else if (body.lastLine < body.endLine) {
    lines.push(
      `(the file ended at line ${body.lastLine}; the index expected the symbol to run to ` +
      `${body.endLine} — the index is ahead of the file, so re-run \`codegraph index\`)`,
    );
  }
  return lines.join("\n");
}

/**
 * The repo map: one header stating what was ranked and what it cost, then the
 * packed body.
 *
 * The header is deliberately outside the packing budget. It is three lines that
 * tell the caller whether the answer they are reading is the whole ranking or
 * the top of it, and paying for it out of `budget` would mean a small budget
 * spends most of itself explaining that it is small.
 */
export function formatRepoMap(result: RepoMapResult, budget?: number): string {
  const rendered = renderRepoMap(result, { budget });
  const head =
    `Repo map — ${result.totalFiles} files / ${result.totalSymbols} symbols ranked; ` +
    `showing ${rendered.filesShown} files, ${rendered.symbolsShown} symbols in ` +
    `${rendered.tokens} tokens (budget ${budget ?? DEFAULT_BUDGET_TOKENS}).`;
  const lines = [head];
  if (result.focusTerms.length > 0) {
    lines.push(
      result.focusMatches > 0
        ? `Focus ${JSON.stringify(result.focusTerms.join(" "))} — ${result.focusMatches} file(s) ` +
          `weighted x${FOCUS_BOOST}; rank flows outward from them.`
        // A focus that matched nothing must be said out loud: the ranking that
        // came back is the unpersonalized one, and it looks identical to a
        // personalized ranking that simply disagreed with the caller.
        : `Focus ${JSON.stringify(result.focusTerms.join(" "))} matched no file path or symbol ` +
          "name — the ranking below is unpersonalized.",
    );
  }
  return [...lines, "", screen(rendered.text)].join("\n");
}

/** Rows of each list the prose shows — and, by default, the JSON block too. */
export const RELATED_FILE_LINES = 15;
export const RELATED_NODE_LINES = 20;

/**
 * `related` renders twice: prose for the reader, JSON for the ranker.
 *
 * The JSON block is not decoration. This action becomes a graph-derived
 * ranking signal in a later stage, and a consumer that has to parse
 * "src/x.ts (weight 3.2)" out of prose is a consumer that breaks the first
 * time the prose is reworded. Fenced as ```json and keyed exactly as
 * `RelatedResult`.
 *
 * ## Why the JSON is trimmed to the same rows as the prose
 *
 * It was not, and that made this function the one place where the plugin flooded
 * the context it exists to protect: the prose was carefully cut to 15 files and
 * 20 symbols while the JSON directly below it serialised all 400 of each — the
 * same answer, an order of magnitude more bytes, in the same response. The
 * emitted object stays a valid `RelatedResult`, so `truncated` is set whenever
 * the payload is a cut of a longer list, whichever cut did it. `full: true`
 * (tool parameter `fullJson`) is the escape hatch for a caller that really is
 * machine-reading the whole neighbourhood.
 */
export function formatRelated(
  result: RelatedResult,
  opts: { full?: boolean } = {},
): string {
  const lines: string[] = [
    `Neighbourhood of ${result.seedFile} (${result.seedNodes} symbols in the file):`,
  ];
  const files = opts.full ? result.files : result.files.slice(0, RELATED_FILE_LINES);
  const nodes = opts.full ? result.nodes : result.nodes.slice(0, RELATED_NODE_LINES);

  if (files.length > 0) {
    lines.push("", "Files, by graph weight:");
    for (const f of files) {
      lines.push(`  ${f.weight.toFixed(2)}  ${f.filePath}  (${f.nodes} symbol${f.nodes === 1 ? "" : "s"}, d${f.minDistance})`);
    }
  }
  if (nodes.length > 0) {
    lines.push("", "Symbols, by graph weight:");
    for (const n of nodes) {
      lines.push(`  ${n.weight.toFixed(2)}  ${n.direction} ${n.via.join("+")}  ${n.qualifiedName}  ${loc(n.filePath, n.startLine)}`);
    }
  }

  // Three different cuts, three different remedies — a caller told only
  // "truncated" cannot tell which knob to turn.
  const rendered = nodes.length < result.nodes.length || files.length < result.files.length;
  if (rendered) {
    lines.push(
      "",
      `(showing ${nodes.length}/${result.nodes.length} symbols and ${files.length}/${result.files.length} files — ` +
      "pass `fullJson: true` for the complete machine-readable block)",
    );
  }
  if (result.truncated) lines.push("", "(list truncated — raise `limit` for more)");
  if (result.edgesTruncated) {
    lines.push(
      "",
      "(the edge scan hit its cap before the walk finished — some neighbours are missing " +
      "entirely, not just unlisted; lower `depth` or seed with a smaller file for a complete answer)",
    );
  }

  lines.push(
    "",
    "Machine-readable (RelatedResult):",
    "```json",
    JSON.stringify(
      {
        seedFile: result.seedFile,
        seedNodes: result.seedNodes,
        truncated: result.truncated || rendered,
        ...(result.edgesTruncated ? { edgesTruncated: true } : {}),
        nodes,
        files,
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
