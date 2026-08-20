/**
 * `ctx_find` — the ranking properties, and the three ways a correct answer used
 * to be thrown away before it reached the fused list.
 *
 * The suite in tests/core/find.test.ts pins the mechanics (five lists fuse,
 * every signal is optional, coverage is honest). This one pins the parts that
 * decide WHICH row wins:
 *
 *  1. A definition outranks its own usages. fff classifies the line in Rust;
 *     the verdict used to be dropped on the TypeScript side, so "where is X
 *     declared" and "where is X called" produced the same ranking.
 *  2. The damping constant. RRF at k=60 over twenty-row lists is nearly rank
 *     agnostic, and the sources' own ordering — frecency, bm25 — was the thing
 *     it flattened.
 *  3. One file, one identity. A file the knowledge base indexed and fff found
 *     is one answer, not two rows agreeing quietly in separate slots.
 *  4. `scope` is a post-filter over a page fff chose without knowing about it,
 *     so a subtree outside the first page read as "no such file".
 *  5. Session isolation reaches the lexical arm, as it already does in
 *     `ctx_search`.
 */

import { describe, expect, test } from "vitest";

import {
  FIND_RRF_K, chunkCandidates, contentCandidates, filenameCandidates,
  fuseFindSignals, runFind,
  type FindCandidate, type FindFinder, type FindStore,
} from "../../src/search/find.js";

const PROJECT = "/repo";

// ─────────────────────────────────────────────────────────
// Fixtures — the two fff shapes, spelled as the native layer normalizes them
// ─────────────────────────────────────────────────────────

function fileItem(rel: string) {
  return {
    path: `${PROJECT}/${rel}`,
    relativePath: rel,
    fileName: rel.split("/").pop() ?? rel,
    size: 100,
    modified: 0,
    accessFrecencyScore: 0,
    modificationFrecencyScore: 0,
    totalFrecencyScore: 0,
    gitStatus: "clean",
  };
}

function scoreOf(exactMatch: boolean) {
  return {
    total: 1, baseScore: 1, filenameBonus: 0, specialFilenameBonus: 0,
    frecencyBoost: 0, distancePenalty: 0, currentFilePenalty: 0,
    comboMatchBoost: 0, exactMatch, matchType: "fuzzy",
  };
}

function fileSearchResult(
  paths: string[],
  opts: { exact?: string[]; totalMatched?: number } = {},
) {
  return {
    ok: true as const,
    value: {
      items: paths.map(fileItem),
      scores: paths.map(p => scoreOf(opts.exact?.includes(p) ?? false)),
      totalMatched: opts.totalMatched ?? paths.length,
      totalFiles: 500,
      truncated: false,
    },
  };
}

function grepMatch(h: { path: string; line: number; text: string; def?: boolean }) {
  return {
    path: `${PROJECT}/${h.path}`,
    relativePath: h.path,
    fileName: h.path.split("/").pop() ?? h.path,
    gitStatus: "clean",
    size: 100,
    modified: 0,
    isBinary: false,
    totalFrecencyScore: 0,
    accessFrecencyScore: 0,
    modificationFrecencyScore: 0,
    lineNumber: h.line,
    col: 0,
    byteOffset: 0,
    lineContent: h.text,
    matchRanges: [] as Array<[number, number]>,
    ...(h.def === undefined ? {} : { isDefinition: h.def }),
  };
}

function grepResult(
  hits: Array<{ path: string; line: number; text: string; def?: boolean }>,
  opts: { nextOffset?: number } = {},
) {
  return {
    ok: true as const,
    value: {
      items: hits.map(grepMatch),
      totalMatched: hits.length,
      filesSearched: new Set(hits.map(h => h.path)).size,
      totalFiles: 500,
      filteredFileCount: 57,
      nextCursor: opts.nextOffset == null ? null : { offset: opts.nextOffset },
      truncated: opts.nextOffset != null,
    },
  };
}

/** A finder built from two callbacks, so a test can watch what it was asked. */
function finderOf(init: {
  fileSearch?: (query: string, options: Record<string, unknown>) => unknown;
  grep?: (query: string, options: Record<string, unknown>) => unknown;
}): FindFinder {
  return {
    fileSearch: ((q: string, o: Record<string, unknown> = {}) =>
      init.fileSearch?.(q, o) ?? fileSearchResult([])) as never,
    grep: ((q: string, o: Record<string, unknown> = {}) =>
      init.grep?.(q, o) ?? grepResult([])) as never,
    trackQuery: async () => ({ ok: true, value: true }),
  };
}

function storeOf(
  rows: Array<Record<string, unknown>>,
  calls?: Array<unknown[]>,
): FindStore {
  return {
    searchWithFallbackMeta: (...args: unknown[]) => {
      calls?.push(args);
      return {
        results: rows,
        completeness: { shown: rows.length, poolSize: rows.length, saturated: false },
      };
    },
    rawDb: () => ({}),
  } as unknown as FindStore;
}

// ─────────────────────────────────────────────────────────
// 1. Definitions outrank usages
// ─────────────────────────────────────────────────────────

describe("the definition of a symbol ranks above its callers", () => {
  test("a file whose match is a definition leads the content list", () => {
    const rows = contentCandidates(grepResult([
      { path: "src/caller-a.ts", line: 10, text: "fuseRankings(a, b)" },
      { path: "src/caller-b.ts", line: 20, text: "await fuseRankings(x, y)" },
      { path: "src/hybrid.ts", line: 328, text: "export function fuseRankings(", def: true },
    ]).value);
    expect(rows[0].relativePath).toBe("src/hybrid.ts");
    expect(rows[0].isDefinition).toBe(true);
    // The callers keep fff's own order behind it — the promotion is a
    // partition, not a re-scoring of the whole list.
    expect(rows.slice(1).map(r => r.relativePath))
      .toEqual(["src/caller-a.ts", "src/caller-b.ts"]);
  });

  test("the definition line becomes what the row shows, not the file's first hit", () => {
    const rows = contentCandidates(grepResult([
      { path: "src/hybrid.ts", line: 12, text: "// see fuseRankings below" },
      { path: "src/hybrid.ts", line: 328, text: "export function fuseRankings(", def: true },
    ]).value);
    expect(rows).toHaveLength(1);
    expect(rows[0].line).toBe(328);
    expect(rows[0].title).toBe("src/hybrid.ts:328");
    expect(rows[0].content).toBe("export function fuseRankings(");
    // Still one row per file, still counting everything it collapsed.
    expect(rows[0].matches).toBe(2);
  });

  test("no classification at all leaves fff's order untouched", () => {
    const rows = contentCandidates(grepResult([
      { path: "src/a.ts", line: 1, text: "x" },
      { path: "src/b.ts", line: 2, text: "y" },
    ]).value);
    expect(rows.map(r => r.relativePath)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(rows.every(r => r.isDefinition === undefined)).toBe(true);
  });

  test("grep is asked for a handful of lines per file, under a time budget", async () => {
    const seen: Record<string, unknown>[] = [];
    await runFind({
      query: "fuseRankings",
      projectDir: PROJECT,
      store: null,
      acquireFinder: async () => ({
        ok: true,
        value: finderOf({ grep: (_q, o) => { seen.push(o); return grepResult([]); } }),
      }),
    });
    expect(seen).toHaveLength(1);
    // Every line beyond the first few in a file is collapsed away by
    // `contentCandidates`, so shipping 200 of them across the FFI buys nothing.
    expect(seen[0].maxMatchesPerFile).toBeLessThanOrEqual(5);
    expect(seen[0].maxMatchesPerFile).toBeGreaterThanOrEqual(1);
    expect(seen[0].timeBudgetMs).toBeGreaterThan(0);
    expect(seen[0].classifyDefinitions).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────
// 2. Exact filename matches (the fff score breakdown, finally read)
// ─────────────────────────────────────────────────────────

describe("an exactly-named file is not left behind the hot ones", () => {
  test("exactMatch lifts a hit above fff's frecency-blended order", () => {
    const rows = filenameCandidates(
      fileSearchResult(
        ["src/find-helpers.ts", "src/tools/find.ts", "src/find.ts"],
        { exact: ["src/find.ts"] },
      ).value,
    );
    expect(rows[0].relativePath).toBe("src/find.ts");
    expect(rows.slice(1).map(r => r.relativePath))
      .toEqual(["src/find-helpers.ts", "src/tools/find.ts"]);
  });

  test("a result with no score breakdown is fff's order, unchanged", () => {
    const result = fileSearchResult(["a.ts", "b.ts"]).value;
    const rows = filenameCandidates({ ...result, scores: [] });
    expect(rows.map(r => r.relativePath)).toEqual(["a.ts", "b.ts"]);
  });
});

// ─────────────────────────────────────────────────────────
// 3. The damping constant
// ─────────────────────────────────────────────────────────

describe("RRF damping over short lists", () => {
  const row = (key: string): FindCandidate => ({
    key, kind: "file", title: key, content: "", source: "file",
    relativePath: key.slice("file:".length), path: `/${key}`, signals: ["filename"],
  });

  test("k is low enough that a list's leader beats a tail seen twice", () => {
    const a = Array.from({ length: 20 }, (_, i) => row(`file:a${i}.ts`));
    const b = Array.from({ length: 20 }, (_, i) => row(`file:b${i}.ts`));
    // `b19` is last in both lists; `a0` is first in one. At k=60 the agreement
    // of two near-worthless ranks (2/80) outweighs a leader (1/61) and b19 wins.
    b[19] = row("file:shared.ts");
    a[19] = row("file:shared.ts");
    const { rows } = fuseFindSignals(
      [{ signal: "filename", rows: a }, { signal: "content", rows: b }],
      { limit: 5 },
    );
    expect(rows[0].relativePath).toBe("a0.ts");
    expect(FIND_RRF_K).toBeLessThanOrEqual(20);
    expect(FIND_RRF_K).toBeGreaterThanOrEqual(5);
  });

  test("agreement still wins between neighbours of equal rank", () => {
    // The property the low k must not destroy: two signals liking the same
    // file at rank 2 beats one signal liking another at rank 1.
    const a = [row("file:solo.ts"), row("file:both.ts")];
    const b = [row("file:other.ts"), row("file:both.ts")];
    const { rows } = fuseFindSignals(
      [{ signal: "filename", rows: a }, { signal: "content", rows: b }],
      { limit: 3 },
    );
    expect(rows[0].relativePath).toBe("both.ts");
  });
});

// ─────────────────────────────────────────────────────────
// 4. One file, one identity
// ─────────────────────────────────────────────────────────

describe("an indexed file and the file itself are one row", () => {
  test("a `code:` chunk takes the file identity the fff arms use", () => {
    const rows = chunkCandidates(
      [{ title: "store.ts", content: "class ContentStore {", source: "code:src/store.ts" }],
      "lexical",
      { projectDir: PROJECT },
    );
    expect(rows[0].key).toBe("file:src/store.ts");
    expect(rows[0].kind).toBe("file");
    expect(rows[0].path).toBe(`${PROJECT}/src/store.ts`);
    // The chunk's text is what the row shows — the file, plus why it matched.
    expect(rows[0].content).toBe("class ContentStore {");
  });

  test("an absolute `code:` label is relativized; one outside the project is not a file", () => {
    const inside = chunkCandidates(
      [{ title: "t", content: "c", source: `code:${PROJECT}/src/a.ts` }],
      "lexical", { projectDir: PROJECT },
    );
    expect(inside[0].key).toBe("file:src/a.ts");

    const outside = chunkCandidates(
      [{ title: "t", content: "c", source: "code:/elsewhere/b.ts" }],
      "lexical", { projectDir: PROJECT },
    );
    expect(outside[0].kind).toBe("chunk");
  });

  test("captured output stays a chunk, individually addressable", () => {
    const rows = chunkCandidates(
      [{ title: "npm test", content: "3 failed", source: "batch:npm test" }],
      "lexical", { projectDir: PROJECT },
    );
    expect(rows[0].kind).toBe("chunk");
    expect(rows[0].key.startsWith("chunk:")).toBe(true);
  });

  test("two chunks of one file do not spend two slots", () => {
    const rows = chunkCandidates(
      [
        { title: "a", content: "first chunk", source: "code:src/a.ts" },
        { title: "a", content: "second chunk", source: "code:src/a.ts" },
      ],
      "lexical", { projectDir: PROJECT },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("first chunk");
  });

  test("end to end: fff and the knowledge base agree, and it shows as one row", async () => {
    const outcome = await runFind({
      query: "ContentStore",
      projectDir: PROJECT,
      acquireFinder: async () => ({
        ok: true,
        value: finderOf({ fileSearch: () => fileSearchResult(["src/store.ts"]) }),
      }),
      store: storeOf([
        { title: "store.ts", content: "class ContentStore", source: "code:src/store.ts" },
      ]),
    });
    expect(outcome.rows).toHaveLength(1);
    expect(outcome.rows[0].signals).toEqual(["filename", "lexical"]);
    expect(outcome.rows[0].kind).toBe("file");
    // And the file reaches the learning loop, which chunk rows never did.
    expect(outcome.shownPaths).toEqual([`${PROJECT}/src/store.ts`]);
  });
});

// ─────────────────────────────────────────────────────────
// 5. scope is not a filter over someone else's page
// ─────────────────────────────────────────────────────────

describe("a scoped search reaches past the first page", () => {
  test("the filename arm fetches wider when a scope is set", async () => {
    const pages: number[] = [];
    const outcome = await runFind({
      query: "handler",
      projectDir: PROJECT,
      scope: "src/deep",
      store: null,
      acquireFinder: async () => ({
        ok: true,
        value: finderOf({
          fileSearch: (_q, o) => {
            const size = Number(o.pageSize ?? 0);
            pages.push(size);
            // fff ranks by frecency and knows nothing about `scope`: the first
            // twenty hits are all elsewhere in the tree.
            const cold = Array.from({ length: 20 }, (_, i) => `src/hot/h${i}.ts`);
            return fileSearchResult(
              size > 20 ? [...cold, "src/deep/handler.ts"] : cold,
            );
          },
        }),
      }),
    });
    expect(pages[0]).toBeGreaterThan(20);
    expect(outcome.rows.map(r => r.relativePath)).toEqual(["src/deep/handler.ts"]);
  });

  test("the content arm follows the cursor until the subtree appears", async () => {
    const offsets: Array<number | undefined> = [];
    const outcome = await runFind({
      query: "handler",
      projectDir: PROJECT,
      scope: "src/deep",
      store: null,
      acquireFinder: async () => ({
        ok: true,
        value: finderOf({
          grep: (_q, o) => {
            const cursor = o.cursor as { offset: number } | undefined;
            offsets.push(cursor?.offset);
            return cursor
              ? grepResult([{ path: "src/deep/handler.ts", line: 4, text: "handler()" }])
              : grepResult(
                [{ path: "src/hot/h0.ts", line: 1, text: "handler()" }],
                { nextOffset: 7 },
              );
          },
        }),
      }),
    });
    expect(offsets).toEqual([undefined, 7]);
    expect(outcome.rows.map(r => r.relativePath)).toEqual(["src/deep/handler.ts"]);
  });

  test("without a scope the content arm still takes exactly one page", async () => {
    const calls: number[] = [];
    await runFind({
      query: "handler",
      projectDir: PROJECT,
      store: null,
      acquireFinder: async () => ({
        ok: true,
        value: finderOf({
          grep: () => {
            calls.push(1);
            return grepResult(
              [{ path: "src/a.ts", line: 1, text: "handler()" }],
              { nextOffset: 7 },
            );
          },
        }),
      }),
    });
    // An unscoped search reports the next page in its coverage line rather than
    // paying for it — the caller asked for the best rows, not for all of them.
    expect(calls).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────
// 6. Session isolation on the lexical arm
// ─────────────────────────────────────────────────────────

describe("shared-database isolation reaches ctx_find", () => {
  test("the allow-set is passed to the store, in the store's own argument slot", async () => {
    const calls: unknown[][] = [];
    const allow = new Set(["session-a", "session-b"]);
    await runFind({
      query: "retry",
      projectDir: PROJECT,
      sessionIdAllowSet: allow,
      store: storeOf([{ title: "t", content: "c", source: "notes" }], calls),
    });
    expect(calls).toHaveLength(1);
    // (query, limit, source, contentType, sourceMatchMode, sessionIdAllowSet)
    expect(calls[0][4]).toBe("like");
    expect(calls[0][5]).toBe(allow);
  });

  test("no allow-set means no restriction, as a per-project database wants", async () => {
    const calls: unknown[][] = [];
    await runFind({
      query: "retry",
      projectDir: PROJECT,
      store: storeOf([{ title: "t", content: "c", source: "notes" }], calls),
    });
    expect(calls[0][5]).toBeUndefined();
  });
});
