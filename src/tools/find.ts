/**
 * `ctx_find` — the tool registration and its handler.
 *
 * The ranking itself lives in `src/search/find.ts`, which is pure and takes
 * every source as a seam. This module is the wiring: it binds those seams to
 * the real fff finder, the real content store, the real codegraph index and the
 * real embedding endpoint, renders the result, and closes the ranking-feedback
 * loop described in `src/search/query-marker.ts`.
 *
 * The split is not ceremony. Four of the five signals are unavailable on some
 * machine, in some session, for some project — a test suite that could only
 * exercise them through this file could only test the happy path, which is the
 * one path that was never in doubt.
 *
 * As in `src/tools/search.ts`, everything `src/server.ts` owns arrives through
 * {@link ToolDeps} rather than an import, so the module graph stays one-way.
 */

import { z } from "zod";

import { acquireFinder } from "../fff/index.js";
import type { FffResult } from "../fff/types.js";
import { openGraphDb } from "../graph/db.js";
import {
  formatFindCompletenessLine, formatSignalCoverageLine,
} from "../search/completeness.js";
import { CrossQueryDeduper } from "../search/dedup.js";
import {
  FIND_TYPES, findToolEnabled, formatFindRows, runFind,
  type FindCandidate, type FindFinder, type FindStore, type FindType,
} from "../search/find.js";
import {
  backfillVectors, semanticCandidates, type HybridDb,
} from "../search/hybrid.js";
import { embedTexts, resolveEmbeddingConfigAsync } from "../search/embeddings.js";
import {
  consumeFindSelections, findTrackingEnabled, recordFindCandidates,
} from "../search/query-marker.js";
import type { ToolDeps, ToolResult } from "./shared/deps.js";

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

/**
 * Semantic neighbours, bound to this store.
 *
 * Returns `[]` — never throws and never rejects — when embeddings are off or
 * the endpoint is unreachable, because "the semantic arm is silent" is a
 * normal state of this tool and not a failure of the search the caller asked
 * for. The lazy backfill fires after the answer, exactly as `hybridSearch`
 * does it, so a cold store warms up through use instead of demanding a bulk
 * pass before `ctx_find` is worth calling.
 */
async function semanticProvider(
  store: FindStore,
  query: string,
  limit: number,
  sourceFilter?: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    const config = await resolveEmbeddingConfigAsync();
    if (!config) return [];
    const db = store.rawDb() as HybridDb;
    const vectors = await embedTexts([query], config);
    if (!vectors) return [];
    const rows = semanticCandidates(db, vectors[0], { limit, sourceFilter });
    if (config.backfillBatch > 0) void backfillVectors(db, config, config.backfillBatch);
    return rows as unknown as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

/**
 * The byte envelope one `ctx_find` answer is allowed to occupy.
 *
 * Same 40 KB as `ctx_search`, and the same number on purpose: the cap is a
 * property of what a tool response may cost the conversation, not of which
 * pipeline produced it. A plugin whose whole premise is that raw output must
 * not reach the context window cannot be the thing that floods it — and
 * `ctx_find` could, since `limit` reaches 50 and a row carries a snippet, a
 * related-files tail and, for chunk rows, whatever the store held.
 */
export const FIND_MAX_TOTAL = 40 * 1024;

/**
 * Cost of one rendered row, in the shape `formatFindRows` prints it.
 *
 * An estimate rather than a render: `formatFindRows` numbers rows in one pass,
 * so rendering a row alone to measure it would either restart the numbering or
 * force a second renderer to exist. The estimate tracks the real layout — head,
 * indented body, related tail — within a few bytes per row, which is the right
 * precision for a 40 KB guard.
 */
function rowCost(row: FindCandidate, body: string): number {
  const head = row.kind === "file"
    ? row.title.length
    : row.source.length + row.title.length + 3;
  const related = row.relatedFiles?.length
    ? row.relatedFiles.join(", ").length + 16
    : 0;
  // Numbering, the `[signal+signal]` marks, indentation and newlines.
  return head + body.length + related + row.signals.join("+").length + 24;
}

export interface BudgetedFindRows {
  /** Rows to render, each with `content` already reduced to its final body. */
  rows: FindCandidate[];
  /** Lower-ranked rows the byte cap kept out. */
  dropped: number;
  /** The deduper that judged these rows — ask it for the response footer. */
  deduper: CrossQueryDeduper;
}

/**
 * Apply the response budget and the cross-row dedup before anything is printed.
 *
 * Two distinct savings, both of which `ctx_find` was missing:
 *
 *  - **Dedup.** One file legitimately arrives twice — once as `file:<rel>` from
 *    the fff arms, once as a `code:<rel>` chunk from FTS5 — and the fusion keeps
 *    both because their identities differ. The second copy's body is then the
 *    same bytes the reader just read. {@link CrossQueryDeduper} replaces only
 *    text that is byte-identical to something already shown above, and only
 *    with a pointer to where it was shown; a different window over the same
 *    chunk is new information and is marked, not suppressed.
 *  - **Budget.** Rows are admitted in rank order until the next one would cross
 *    `maxTotal`. The first row is always admitted: a single oversized row must
 *    truncate the tail, never produce an empty answer.
 *
 * Bodies are resolved here rather than inside the formatter so that what is
 * measured is exactly what is printed — the formatter is handed finished text
 * and an identity snippet function.
 */
export function budgetFindRows(
  rows: FindCandidate[],
  opts: {
    query: string;
    snippet: (content: string, query: string) => string;
    maxTotal?: number;
    deduper?: CrossQueryDeduper;
  },
): BudgetedFindRows {
  const maxTotal = opts.maxTotal ?? FIND_MAX_TOTAL;
  const deduper = opts.deduper ?? new CrossQueryDeduper();
  const kept: FindCandidate[] = [];
  let total = 0;

  for (const row of rows) {
    let body = row.content ? opts.snippet(row.content, opts.query) : "";
    // An empty body has nothing to repeat: running it through the deduper
    // would replace "no body at all" with a pointer line, i.e. spend bytes to
    // save none.
    if (body) {
      const decision = deduper.consider(row, body, opts.query);
      if (decision.kind === "suppress") {
        body = CrossQueryDeduper.pointerLine(decision.firstQuery);
      } else if (decision.kind === "further") {
        body = `(further match) ${body}`;
      }
    }
    const cost = rowCost(row, body);
    if (kept.length > 0 && total + cost > maxTotal) break;
    total += cost;
    kept.push({ ...row, content: body });
  }

  return { rows: kept, dropped: rows.length - kept.length, deduper };
}

/**
 * Spend the selections the PostToolUse hook recorded.
 *
 * This is step 3 of the loop: the hook saw the caller open a file `ctx_find`
 * had shown and appended `{query, path}`; here, where a finder actually exists,
 * that becomes `trackQuery`. Runs before the search so the current query is
 * ranked with everything learned so far.
 *
 * @returns How many selections were fed back, for the response footer.
 */
async function drainSelections(
  finder: FindFinder,
  sessionDbPath: string,
): Promise<number> {
  let learned = 0;
  try {
    for (const selection of consumeFindSelections(sessionDbPath)) {
      try {
        const result = await finder.trackQuery(selection.query, selection.path);
        if (result.ok) learned++;
      } catch { /* one bad selection must not stop the rest */ }
    }
  } catch { /* the loop is an optimisation; never fail a search for it */ }
  return learned;
}

/** Register `ctx_find` on the server carried by `deps`. */
export function registerCtxFind(deps: ToolDeps): void {
  if (!findToolEnabled()) return;

  const { getStore, getProjectDir, getSessionDbPath, trackResponse, extractSnippet } = deps;

  deps.server.registerTool(
    "ctx_find",
    {
      title: "Find (fused search)",
      // Read-only: file index, FTS5, vectors and the codegraph DB are all read.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description: `One search across everything this project knows about itself, returned as a single ranked list. Five signals run in parallel and are fused with reciprocal-rank fusion: fuzzy file names (frecency-aware, so files this project actually opens rank higher), literal grep over the tree, the FTS5 knowledge base of indexed output and auto-captured session memory, chunk vectors for a query that shares meaning but not words, and the codegraph neighbourhood of whatever the text signals liked. Every row is tagged with the signals that produced it, so a file three signals agree on is visibly stronger than one a single matcher found. Signals that cannot run (no file index, no codegraph index, no embedding endpoint, empty knowledge base) are reported as blind and the rest still fuse.

WHEN:
  - Instead of Grep or Glob, when the question is "where does X live" or "which file handles Y" and the answer is one path rather than a page of matches to read through
  - Instead of Read on a directory of candidates: one ranked list says which file to open, and the other files stay out of your conversation
  - The question is "what do we already know about Z", spanning captured output, session memory and the source tree at once
  - A file-name guess, a grep and a knowledge-base query would otherwise be three separate calls whose results have to be merged by reading all three
  - The search should be confined to one subtree (pass scope) or one kind of source (pass type)
  - One required parameter, query: a plain question is a valid call, and scope, type and source only narrow it
WHEN NOT:
  - The file is already known and the next step is editing it — Read first, because Edit matches against the exact bytes in your conversation
  - The point is an exhaustive literal sweep, every occurrence counted — Grep is the right tool for that; this returns a ranked list, not a complete one
  - The question is structural in itself, such as who calls a symbol or what breaks when it changes — ctx_graph answers those directly
  - The content has never been indexed and does not exist in the tree — capture it first with ctx_batch_execute or ctx_fetch_and_index
RETURNS:
  One ranked list of file paths and knowledge-base sections, each carrying the signals that found it, a match preview, and, for files the graph knows, the neighbours it places next to them. A coverage line states what each signal saw, including how many files a grep page actually scanned and whether more pages remain.
EXAMPLE: ctx_find(query: "reciprocal rank fusion")
EXAMPLE: ctx_find(query: "session db path", scope: "src/session", type: "code")
EXAMPLE: ctx_find(query: "what did we decide about caching", type: "memory", limit: 5)`,
      inputSchema: z.object({
        query: z
          .string()
          .describe("What to find. Free text; 2-5 specific terms work best."),
        scope: z
          .string()
          .optional()
          .describe("Project-relative directory prefix the file signals are confined to, e.g. \"src/search\"."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Rows in the fused list (default 10)."),
        type: z
          .enum(FIND_TYPES)
          .optional()
          .describe("all (default) | files (names + graph) | code (names + grep + graph) | memory (FTS5 + vectors)"),
        source: z
          .string()
          .optional()
          .describe("Scope the knowledge-base signals to one indexed source label (partial match)."),
      }),
    },
    async (params) => {
      try {
        const p = params as {
          query: string;
          scope?: string;
          limit?: number;
          type?: FindType;
          source?: string;
        };
        const query = String(p.query ?? "").trim();
        if (!query) {
          return trackResponse("ctx_find", textResult("Error: `query` is required.", true));
        }

        const projectDir = getProjectDir();

        // The store is opened lazily and may fail (read-only volume, corrupt
        // DB). That removes two of five signals, not the tool.
        let store: FindStore | null = null;
        try { store = getStore() as unknown as FindStore; } catch { store = null; }

        // One finder for the whole call, acquired LAZILY — on first use inside
        // `runFind`, not here.
        //
        // Acquiring unconditionally charged every call for a native index build
        // and up to the fff scan timeout of tree walking, including the calls
        // that cannot use a finder at all: `type: "memory"` admits only the
        // lexical and semantic signals, and the per-signal env switches can cut
        // the fff arms out of any other type. `runFind` already computes that
        // admitted set (TYPE_SIGNALS × `signalEnabled`) and calls this seam only
        // when a signal fff actually serves survives it, so deferring keeps ONE
        // source of truth for "does this call need a finder" instead of a copy
        // of the type table that would drift.
        //
        // The promise — not the result — is memoised, so two arms asking at
        // once share one acquisition rather than opening two native indexes.
        let acquisition: Promise<FffResult<FindFinder>> | null = null;
        let learned = 0;
        const acquireOnce = (): Promise<FffResult<FindFinder>> => {
          acquisition ??= (async () => {
            let acquired: FffResult<FindFinder>;
            try {
              acquired = await acquireFinder(projectDir) as unknown as FffResult<FindFinder>;
            } catch (err) {
              // `acquireFinder` does not throw by contract; belt and braces.
              // `unavailable` keeps a degraded machine from being reported as
              // an operational error in the coverage line.
              acquired = {
                ok: false,
                unavailable: true,
                error: err instanceof Error ? err.message : String(err),
              };
            }
            // Step 3 of the ranking loop still has to run BEFORE the filename
            // search, so the current query is ranked with everything learned so
            // far. `runFind` calls this seam before it runs either fff arm, so
            // "on first use" is still early enough.
            if (acquired.ok && findTrackingEnabled()) {
              learned = await drainSelections(acquired.value, getSessionDbPath());
            }
            return acquired;
          })();
          return acquisition;
        };

        const outcome = await runFind({
          query,
          projectDir,
          limit: p.limit,
          scope: p.scope,
          type: p.type,
          source: p.source,
          store,
          acquireFinder: acquireOnce,
          openGraph: dir => openGraphDb(dir),
          semantic: store
            ? (q, limit, sourceFilter) => semanticProvider(store as FindStore, q, limit, sourceFilter)
            : undefined,
        });

        if (outcome.rows.length === 0) {
          const blind = formatSignalCoverageLine(outcome.coverage);
          return trackResponse("ctx_find", textResult(
            `## ${query}\n\nNo results found.${blind ? `\n\n${blind}` : ""}`,
          ));
        }

        // Publish what was shown BEFORE returning: the hook fires on the very
        // next tool call, and a marker written after the response would race it.
        if (findTrackingEnabled() && outcome.shownPaths.length > 0) {
          try {
            recordFindCandidates(getSessionDbPath(), {
              query,
              paths: outcome.shownPaths,
              at: Date.now(),
            });
          } catch { /* best-effort */ }
        }

        // Bodies are resolved, deduped and capped before rendering; the
        // formatter is then handed finished text, so what was measured is
        // exactly what is printed.
        const budgeted = budgetFindRows(outcome.rows, {
          query,
          snippet: (content, q) => extractSnippet(content, q, 300),
        });
        const body = formatFindRows(budgeted.rows, {
          query,
          snippet: content => content,
        });

        const tails = [
          formatSignalCoverageLine(outcome.coverage),
          formatFindCompletenessLine(query, outcome.completeness),
          // Truncation is stated, never silent: a ranked list that stops early
          // must not read like a list that ended.
          budgeted.dropped > 0
            ? `> Output cap reached (${Math.round(FIND_MAX_TOTAL / 1024)} KB): ` +
              `${budgeted.dropped} lower-ranked row(s) not shown. Narrow with scope/type or lower limit.`
            : null,
          budgeted.deduper.footer(),
          learned > 0
            ? `> Ranking feedback: ${learned} prior selection(s) fed back into filename ranking.`
            : null,
        ].filter((t): t is string => Boolean(t));

        return trackResponse("ctx_find", textResult(
          `## ${query}\n\n${body}${tails.length > 0 ? `\n\n${tails.join("\n")}` : ""}`,
        ));
      } catch (err) {
        return trackResponse("ctx_find", textResult(
          `ctx_find failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        ));
      }
    },
  );
}
