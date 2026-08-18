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
import { openGraphDb } from "../graph/db.js";
import {
  formatFindCompletenessLine, formatSignalCoverageLine,
} from "../search/completeness.js";
import {
  FIND_TYPES, findToolEnabled, formatFindRows, runFind,
  type FindFinder, type FindStore, type FindType,
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
  - The question is "where does X live" or "which file handles Y", and the answer is one path rather than a directory listing
  - The question is "what do we already know about Z", spanning captured output, session memory and the source tree at once
  - A file-name guess, a grep and a knowledge-base query would otherwise be three separate calls whose results have to be merged by reading all three
  - The search should be confined to one subtree (pass scope) or one kind of source (pass type)
WHEN NOT:
  - The file is already known and the next step is reading or editing it
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

        // One finder for the whole call: the selection drain and both fff
        // signals share it, and acquiring twice would open two native indexes.
        let finder: FindFinder | null = null;
        let learned = 0;
        try {
          const acquired = await acquireFinder(projectDir);
          if (acquired.ok) finder = acquired.value as unknown as FindFinder;
        } catch { /* fff unavailable — degrade */ }

        if (finder && findTrackingEnabled()) {
          learned = await drainSelections(finder, getSessionDbPath());
        }

        const outcome = await runFind({
          query,
          projectDir,
          limit: p.limit,
          scope: p.scope,
          type: p.type,
          source: p.source,
          store,
          acquireFinder: finder
            ? async () => ({ ok: true as const, value: finder as FindFinder })
            : undefined,
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

        const body = formatFindRows(outcome.rows, {
          query,
          snippet: (content, q) => extractSnippet(content, q, 300),
        });

        const tails = [
          formatSignalCoverageLine(outcome.coverage),
          formatFindCompletenessLine(query, outcome.completeness),
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
