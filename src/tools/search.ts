/**
 * `ctx_search` — the tool registration and its handler.
 *
 * First region moved out of `src/server.ts` under the plan in
 * `docs/plans/`. The boundary is chosen by what the fork has already
 * rewritten: this handler conflicts on every `sync-upstream`, so moving it
 * costs nothing extra and gives the next merge a smaller file to reconcile.
 *
 * Everything server.ts owns arrives through {@link ToolDeps} rather than an
 * import. That is not ceremony — importing `getStore` or `trackResponse` from
 * server.ts would close a cycle (server → tools/search → server), and the
 * bundler resolves those by evaluating one side half-initialised.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { searchAutoMemory } from "../search/auto-memory.js";
import {
  hybridSearch, type HybridDb, type LexicalResult,
} from "../search/hybrid.js";
import {
  formatCompletenessLine, formatEscalationBlock, type SearchCompleteness,
} from "../search/completeness.js";
import { CrossQueryDeduper } from "../search/dedup.js";
import {
  buildCtxSearchInputSchema, CTX_SEARCH_SHARED_MODE, resolveProjectScope,
} from "../search/ctx-search-schema.js";
import { searchAllSources } from "../search/unified.js";
import { SessionDB, resolveSessionDbPath } from "../session/db.js";
import { readReuseVerdict } from "../session/retrieval-marker.js";
import { shouldBypassCompression } from "../session/reuse-detector.js";
import { resolveClaudeConfigDir } from "../util/claude-config.js";
import type { ToolDeps } from "./shared/deps.js";

/** Register `ctx_search` on the server carried by `deps`. */
export function registerCtxSearch(deps: ToolDeps): void {
  const {
    getStore, getProjectDir, getSessionDir, getSessionDbPath, trackResponse, extractSnippet,
    semanticStatusHint, detectedAdapter, searchFloodGuard, searchFloodGuardKey,
    SEARCH_MAX_RESULTS_AFTER, SEARCH_BLOCK_AFTER,
  } = deps;

  deps.server.registerTool(
    "ctx_search",
    {
      title: "Search Indexed Content",
      // #846: read-only query over the local FTS5 store. No mutation, no network.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description: `Search a unified knowledge base with a multi-strategy ranking pipeline. Two parallel matchers run on every query: a Porter-stemming matcher ("caching" finds "cached", "caches", "cach") and a trigram-substring matcher ("useEff" finds "useEffect"). Their ranked lists are merged via Reciprocal Rank Fusion, so a document that ranks well in both surfaces above one that wins only on a single strategy. Multi-term queries get an additional proximity-rerank pass that boosts passages where the query terms appear close together. Typos are corrected via Levenshtein distance and re-searched. Result snippets are window-extracted around the matched terms, not blindly truncated.

  The knowledge base is unified: queries reach indexed content you stored (ctx_index, ctx_fetch_and_index, ctx_batch_execute output) AND auto-captured session memory written by hooks (decisions, errors, blockers, plans, user prompts, rejected approaches, tool failures, compaction guides — 26 event categories). File-backed sources carry a content hash and auto-flag staleness when the source file changes.

  WHEN:
    - You want to recall something that exists in storage (recently indexed content, prior session events, auto-memory) instead of re-reading raw sources
    - You have multiple related questions about the same body of knowledge — batch every question into one call (the ranking pipeline runs per-query but the round-trip cost is paid once)
    - You want to scope the query to one labelled source (pass \`source\` — partial match is fine)
    - You want a chronological view across current session + prior sessions + persistent auto-memory (pass \`sort: "timeline"\` — the default \`relevance\` mode only ranks within the current session)
    - You want to filter ranked results by content shape (pass \`contentType: "code"\` to surface implementation snippets or \`contentType: "prose"\` to surface explanations)

  WHEN NOT:
    - The data you want to query has never been stored in the knowledge base AND no session memory has accumulated around it — capture first (run a gather-and-index call), then come back here to query
    - You have one ad-hoc question against data that is not in the knowledge base — answer it inline by running code in ctx_execute; one round-trip instead of capture-then-query

  RETURNS:
    Per-query ranked sections with window-extracted snippets. Use 2-4 specific technical terms per query. Common session-memory source labels: \`decision\` (user corrections / preferences), \`error\` and \`error-resolution\` (past failures + their fixes), \`blocker\`, \`plan\`, \`user-prompt\`, \`rejected-approach\`, \`compaction\` (post-compact session guide). See ctx_stats for live category counts. Each response carries a throttle counter (call #N/M in the rolling time window); results taper toward the soft cap and calls block after the hard cap. Tune via CONTEXT_MODE_SEARCH_WINDOW_MS, CONTEXT_MODE_SEARCH_MAX_RESULTS_AFTER, CONTEXT_MODE_SEARCH_BLOCK_AFTER.

  EXAMPLE: ctx_search(queries: ["root cause", "proposed fix", "test coverage"], source: "issue-#683")
  EXAMPLE: ctx_search(queries: ["what did we decide about caching"], source: "decision", sort: "timeline")
  EXAMPLE: ctx_search(queries: ["useEffect cleanup pattern"], source: "react-docs", contentType: "code", limit: 5)
  EXAMPLE: ctx_search(queries: ["last user prompt", "active skills", "open blockers"], sort: "timeline")`,
      // Schema construction is centralised in `src/search/ctx-search-schema.ts`
      // so the conditional `project` field (only registered when the host runs
      // in shared-DB mode, `CONTEXT_MODE_PROJECT_DIR` set at module load) is a
      // hard property of the tool surface — not a runtime hint. Fixes #737.
      inputSchema: buildCtxSearchInputSchema(CTX_SEARCH_SHARED_MODE),
    },
    async (params) => {
      try {
        const store = getStore();
        const sort = (params as Record<string, unknown>).sort as string || "relevance";

        // Guard: redirect when the index is empty — ctx_search is a follow-up
        // tool that requires prior indexing. Skip for timeline mode (SessionDB/auto-memory may have data).
        if (sort !== "timeline" && store.getStats().chunks === 0) {
          return trackResponse("ctx_search", {
            content: [{
              type: "text" as const,
              text: "Knowledge base is empty — no content has been indexed yet.\n\n" +
                "ctx_search is a follow-up tool that queries previously indexed content. " +
                "To gather and index content first, use:\n" +
                "  • ctx_batch_execute(commands, queries) — run commands, auto-index output, and search in one call\n" +
                "  • ctx_fetch_and_index(url) — fetch a URL, index it, then search with ctx_search\n" +
                "  • ctx_index(content, source) — manually index text content\n\n" +
                "After indexing, ctx_search becomes available for follow-up queries.",
            }],
            isError: true,
          });
        }

        const raw = params as Record<string, unknown>;

        // Normalize: accept both query (string) and queries (array)
        const queryList: string[] = [];
        if (Array.isArray(raw.queries) && raw.queries.length > 0) {
          queryList.push(...(raw.queries as string[]));
        } else if (typeof raw.query === "string" && raw.query.length > 0) {
          queryList.push(raw.query as string);
        }

        if (queryList.length === 0) {
          return trackResponse("ctx_search", {
            content: [{ type: "text" as const, text: "Error: provide query or queries." }],
            isError: true,
          });
        }

        const { limit = 3, source, contentType, project } = params as {
          limit?: number;
          source?: string;
          contentType?: "code" | "prose";
          project?: string;
        };

        // Resolve the per-project scope (#737). When shared-DB mode is off the
        // resolver returns `undefined` and `project` is silently ignored — the
        // per-project DB is naturally isolated by directory hash, so there is
        // nothing for an in-process filter to do.
        const projectScope = resolveProjectScope(
          project,
          CTX_SEARCH_SHARED_MODE,
          () => getProjectDir(),
        );

        // Progressive throttling: track calls per agent-context window (#769).
        const now = Date.now();
        const flood = searchFloodGuard.record(searchFloodGuardKey(), now);
        const searchCallCount = flood.count;

        // After SEARCH_BLOCK_AFTER calls (for THIS agent): refuse
        if (flood.blocked) {
          return trackResponse("ctx_search", {
            content: [{
              type: "text" as const,
              text: `BLOCKED: ${searchCallCount} search calls in ${Math.round((now - flood.windowStart) / 1000)}s. ` +
                "You're flooding context. STOP making individual search calls. " +
                "Use ctx_batch_execute(commands, queries) for your next research step.",
            }],
            isError: true,
          });
        }

        // Determine per-query result limit based on throttle level
        const effectiveLimit = flood.softCapped
          ? 1 // after soft cap: only 1 result per query
          : Math.min(limit, 2); // normal: max 2

        const MAX_TOTAL = 40 * 1024; // 40KB total cap
        let totalSize = 0;
        const sections: string[] = [];
        // Lives across the whole query loop — the repeats worth cutting are the
        // ones between queries of the same response.
        const deduper = new CrossQueryDeduper();
        // C-02 — above the returns threshold, compressing is a double charge:
        // the model re-reads the source in full anyway, so the snippet was
        // paid for and then paid for again. Hand back full text instead.
        // Hoisted out of the per-result map: this reads a marker file.
        const bypassCompression = shouldBypassCompression({
          stats: readReuseVerdict(getSessionDbPath()),
        });
        // Relevance mode only. Timeline mode merges three heterogeneous sources
        // (this session, prior sessions, auto-memory) into one list; there is no
        // single pool to be complete with respect to, so it says nothing.
        const queryCompleteness: SearchCompleteness[] = [];

        // Open SessionDB once before the loop (Blocker 4: avoid open/close per query).
        // Issue #737: also open in relevance mode when a string `projectScope`
        // is in play — the 2-step IN-clause needs SessionDB to translate
        // `project_dir` → allow-set of session ids for the ContentStore filter.
        let timelineDB: InstanceType<typeof SessionDB> | null = null;
        const needsSessionDB = sort === "timeline" || typeof projectScope === "string";
        if (needsSessionDB) {
          try {
            const sessionsDir = getSessionDir();
            const projectDir = getProjectDir();
            const dbFile = resolveSessionDbPath({ projectDir, sessionsDir });
            if (existsSync(dbFile)) {
              timelineDB = new SessionDB({ dbPath: dbFile });
            }
          } catch { /* SessionDB unavailable — search ContentStore + auto-memory only */ }
        }

        // Resolve the session-id allow-set once for the relevance-mode path —
        // searchAllSources resolves its own copy for timeline mode. Empty set
        // is preserved (means "no events for this project"), which surfaces
        // only legacy `session_id=''` chunks via the post-filter.
        let relevanceAllowSet: Set<string> | undefined;
        if (typeof projectScope === "string" && timelineDB) {
          try {
            relevanceAllowSet = new Set(timelineDB.getSessionIdsForProject(projectScope));
          } catch { /* best-effort */ }
        }

        const configDir = detectedAdapter()?.getConfigDir() ?? resolveClaudeConfigDir();

        try {
        for (const q of queryList) {
          if (totalSize > MAX_TOTAL) {
            sections.push(`## ${q}\n(output cap reached)\n`);
            continue;
          }

          let results;
          if (sort === "timeline") {
            results = searchAllSources({
              query: q,
              limit: effectiveLimit,
              store,
              sort,
              source,
              contentType,
              sessionDB: timelineDB,
              projectDir: getProjectDir(),
              configDir,
              adapter: detectedAdapter() ?? undefined,
              projectScope,
            });
          } else {
            const found = store.searchWithFallbackMeta(
              q,
              effectiveLimit,
              source,
              contentType,
              "like",
              relevanceAllowSet,
            );
            results = found.results;
            queryCompleteness.push(found.completeness);
            // Semantic re-fusion (no-op unless CONTEXT_MODE_EMBEDDINGS_URL is
            // configured). Lexical results pass through untouched on any
            // failure, so an unreachable embedding endpoint degrades ranking
            // rather than breaking search.
            results = await hybridSearch({
              db: store.rawDb() as unknown as HybridDb,
              query: q,
              lexical: results as unknown as LexicalResult[],
              limit: effectiveLimit,
              sourceFilter: source,
            }) as unknown as typeof results;

            // Auto-memory in relevance mode. The FTS5 store holds captured
            // output; the user's curated memory files and CLAUDE.md hold the
            // decisions. Those were reachable only via sort:"timeline", so the
            // default mode could not answer "what did we decide about X" from
            // the very files written to answer it.
            //
            // Appended after the ranked results rather than fused into them:
            // memory is a different KIND of hit (a curated fact, not a captured
            // chunk), and it must not silently evict search results the caller
            // asked for. Capped at 2 so it stays an addition, not a takeover.
            // A `source` filter means the caller scoped the query to one label —
            // memory is out of that scope by definition, so it is skipped.
            if (!source) {
              try {
                const memHits = searchAutoMemory(
                  [q],
                  2,
                  getProjectDir(),
                  configDir,
                  detectedAdapter() ?? undefined,
                );
                const seen = new Set(results.map(r => `${r.source}::${r.title}`));
                for (const hit of memHits) {
                  if (seen.has(`${hit.source}::${hit.title}`)) continue;
                  results = [...results, hit as unknown as (typeof results)[number]];
                }
              } catch { /* memory is additive — never fail the search for it */ }
            }
          }

          if (results.length === 0) {
            sections.push(`## ${q}\nNo results found.`);
            continue;
          }

          const formatted = results
            .map((r, i) => {
              const origin = (r as any).origin || "current-session";
              const ts = (r as any).timestamp ? (r as any).timestamp.slice(0, 16).replace("T", " ") : "";
              const header = `--- [${origin}${ts ? " | " + ts : ""} | ${r.source}] ---`;
              const snippet = bypassCompression
                ? r.content
                : extractSnippet(r.content, q, 1500, r.highlighted);
              const decision = deduper.consider(r, snippet, q);
              if (decision.kind === "suppress") {
                // Heading and provenance stay — only the verbatim body goes.
                return `${header}\n### ${r.title}\n\n${CrossQueryDeduper.pointerLine(decision.firstQuery)}`;
              }
              const heading = `### ${r.title}${decision.kind === "further" ? " — further match" : ""}`;
              return `${header}\n${heading}\n\n${snippet}`;
            })
            .join("\n\n");

          const info = queryCompleteness[queryCompleteness.length - 1];
          let tail = "";
          if (sort !== "timeline" && info) {
            // hybridSearch and auto-memory can add rows the lexical pool never
            // held — count them, but never let them make the total look smaller.
            const memoryExtras = Math.max(0, results.length - info.shown);
            info.shown = results.length;
            info.poolSize = Math.max(info.poolSize, results.length);
            const line = formatCompletenessLine(q, info);
            if (line) {
              tail = `\n\n${line}`;
              if (memoryExtras > 0) tail += ` (+${memoryExtras} from memory/semantic)`;
            }
          }
          sections.push(`## ${q}\n\n${formatted}${tail}`);
          totalSize += formatted.length;
        }
        } finally {
          try { timelineDB?.close(); } catch {}
        }

        let output = sections.join("\n\n---\n\n");

        // Report auto-refreshed stale sources
        if (store.lastRefreshCount > 0) {
          output = `> Auto-refreshed ${store.lastRefreshCount} stale source${store.lastRefreshCount > 1 ? "s" : ""} (file changed since indexing).\n\n` + output;
        }

        const dedupFooter = deduper.footer();
        if (dedupFooter) output += `\n\n${dedupFooter}`;

        const semanticHint = semanticStatusHint(store);
        if (semanticHint) output += `\n\n${semanticHint}`;

        const escalation = formatEscalationBlock(queryCompleteness);
        if (escalation) output += `\n\n${escalation}`;

        // Throttle counter — always surfaced so agents can pace themselves
        // proactively instead of discovering the limit only after results are
        // already truncated. Soft warning after SEARCH_MAX_RESULTS_AFTER calls;
        // gentle informational line before that.
        const throttleRemaining = Math.max(0, SEARCH_BLOCK_AFTER - searchCallCount);
        const softCapRemaining = Math.max(0, SEARCH_MAX_RESULTS_AFTER - searchCallCount);
        if (searchCallCount >= SEARCH_MAX_RESULTS_AFTER) {
          output += `\n\n⚠ search call #${searchCallCount}/${SEARCH_BLOCK_AFTER} in this window. ` +
            `Results limited to ${effectiveLimit}/query. ${throttleRemaining} call(s) remaining before block. ` +
            `Batch queries: ctx_search(queries: ["q1","q2","q3"]) or use ctx_batch_execute.`;
        } else {
          output += `\n\n> Throttle: call #${searchCallCount}/${SEARCH_BLOCK_AFTER} in this window. ` +
            `${softCapRemaining} call(s) before soft cap. ` +
            `Prefer ctx_search(queries: [...]) array form for multi-query workloads — it counts as a single call.`;
        }

        if (output.trim().length === 0) {
          const sources = store.listSources();
          const sourceList = sources.length > 0
            ? `\nIndexed sources: ${sources.map((s) => `"${s.label}" (${s.chunkCount} sections)`).join(", ")}`
            : "";
          return trackResponse("ctx_search", {
            content: [{ type: "text" as const, text: `No results found.${sourceList}` }],
          });
        }

        return trackResponse("ctx_search", {
          content: [{ type: "text" as const, text: output }],
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return trackResponse("ctx_search", {
          content: [{ type: "text" as const, text: `Search error: ${message}` }],
          isError: true,
        });
      }
    },
  );
}
