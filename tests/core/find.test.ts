/**
 * `ctx_find` — fusion, degradation, honest coverage, and the ranking loop.
 *
 * Four things are worth pinning here, and they are the four that were hard:
 *
 *  1. Five lists fuse into one, and each surviving row remembers every signal
 *     that produced it. Agreement between signals IS the ranking, so losing the
 *     provenance would make the result unreadable and the ranking unverifiable.
 *  2. Every signal is optional. The suite runs each arm's absence explicitly,
 *     because "works on this machine" is precisely the property a five-source
 *     search cannot be allowed to have.
 *  3. Grep coverage is stated in FILES. fff pages grep by file and reports
 *     `totalMatched` for the current page only, so "showing 12 of 12" is true
 *     and misleading; the honest denominator is files scanned vs eligible.
 *  4. The graph signal cannot cost lexical quality. Measured against the same
 *     corpus and the same recorded baseline that gates `ctx_search`, with the
 *     graph arm off and on.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ContentStore } from "../../src/store.js";
import { fuseRankedLists, fuseRankings } from "../../src/search/hybrid.js";
import {
  formatGrepCoverage, formatSignalCoverageLine,
} from "../../src/search/completeness.js";
import {
  chunkCandidates, contentCandidates, filenameCandidates, formatFindRows,
  fuseFindSignals, graphCandidates, graphSignalWeight, runFind, signalEnabled,
  type FindCandidate, type FindFinder, type FindStore,
} from "../../src/search/find.js";
import {
  appendFindSelection, consumeFindSelections, matchSelection,
  readFindCandidates, recordFindCandidates,
} from "../../src/search/query-marker.js";
import { score } from "../../scripts/lib/retrieval-metrics.mjs";

// ─────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────

const PROJECT = "/repo";

function fileSearchResult(paths: string[], totalMatched = paths.length) {
  return {
    ok: true as const,
    value: {
      items: paths.map(p => ({
        path: `${PROJECT}/${p}`,
        relativePath: p,
        fileName: p.split("/").pop() ?? p,
        size: 100,
        modified: 0,
        accessFrecencyScore: 0,
        modificationFrecencyScore: 0,
        totalFrecencyScore: 0,
        gitStatus: "clean",
      })),
      scores: [],
      totalMatched,
      totalFiles: 500,
      truncated: paths.length < totalMatched,
    },
  };
}

function grepResult(
  hits: Array<{ path: string; line: number; text: string }>,
  meta: { filesSearched: number; filteredFileCount: number; more?: boolean } = {
    filesSearched: 3,
    filteredFileCount: 57,
  },
) {
  return {
    ok: true as const,
    value: {
      items: hits.map(h => ({
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
      })),
      totalMatched: hits.length,
      filesSearched: meta.filesSearched,
      totalFiles: 500,
      filteredFileCount: meta.filteredFileCount,
      nextCursor: meta.more ? { offset: 12 } : null,
      truncated: Boolean(meta.more),
    },
  };
}

/** A finder that answers from canned data and records what it was told. */
function fakeFinder(init: {
  files?: string[];
  totalMatched?: number;
  grep?: Array<{ path: string; line: number; text: string }>;
  grepMeta?: { filesSearched: number; filteredFileCount: number; more?: boolean };
  tracked?: Array<{ query: string; path: string }>;
}): FindFinder {
  return {
    fileSearch: () => fileSearchResult(init.files ?? [], init.totalMatched) as never,
    grep: () => grepResult(init.grep ?? [], init.grepMeta) as never,
    trackQuery: async (query, path) => {
      init.tracked?.push({ query, path });
      return { ok: true, value: true };
    },
  };
}

function fakeStore(rows: Array<{ title: string; content: string; source: string }>): FindStore {
  return {
    searchWithFallbackMeta: () => ({
      results: rows as unknown as Array<Record<string, unknown>>,
      completeness: { shown: rows.length, poolSize: rows.length + 4, saturated: false },
    }),
    rawDb: () => ({}),
  };
}

/**
 * An open graph handle over a REAL in-memory SQLite database.
 *
 * `related()` is not stubbed: it runs its own BFS and its own SQL against the
 * two tables it actually reads. A hand-rolled stub of `RelatedResult` would
 * have proved only that the fusion accepts the shape it was handed, which was
 * never the question — the question is whether a real neighbourhood, weighted
 * at 0.5, lands where it should in the fused list.
 */
function graphOver(
  edges: Array<{ from: string; to: string; kind: string }>,
  nodes: Array<{ id: string; file: string; name?: string }>,
) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE nodes (id TEXT, kind TEXT, qualified_name TEXT, file_path TEXT, start_line INTEGER);
    CREATE TABLE edges (source TEXT, target TEXT, kind TEXT);
  `);
  for (const n of nodes) {
    db.prepare("INSERT INTO nodes VALUES (?, 'function', ?, ?, 1)")
      .run(n.id, n.name ?? n.id, n.file);
  }
  for (const e of edges) {
    db.prepare("INSERT INTO edges VALUES (?, ?, ?)").run(e.from, e.to, e.kind);
  }
  return () => ({
    ok: true as const,
    handle: {
      db: db as never,
      dbPath: ":memory:",
      projectDir: PROJECT,
      schemaVersion: 8,
      indexState: "complete",
      close: () => { try { db.close(); } catch { /* ok */ } },
    },
  });
}

/** A graph handle whose index has nothing about the seeds. */
const emptyGraph = () => graphOver([], [])();

// ─────────────────────────────────────────────────────────
// 1. Fusion mechanics
// ─────────────────────────────────────────────────────────

describe("weighted N-list fusion", () => {
  const row = (t: string) => ({ title: t, content: t, source: "s" });

  test("fuseRankings is fuseRankedLists with two unweighted lists", () => {
    const a = [row("a"), row("b"), row("c")];
    const b = [row("c"), row("d")];
    expect(fuseRankings(a, b, { limit: 4 })).toEqual(
      fuseRankedLists([{ rows: a }, { rows: b }], { limit: 4 }),
    );
  });

  test("a list at weight 0 contributes nothing", () => {
    const a = [row("a")];
    const b = [row("b")];
    const fused = fuseRankedLists([{ rows: a }, { rows: b, weight: 0 }], { limit: 5 });
    expect(fused.map(r => r.title)).toEqual(["a"]);
  });

  test("a half-weight list cannot outrank a full-weight list's leader", () => {
    // The property the graph signal's default weight rests on: 0.5/(k+1) is
    // strictly less than 1/(k+i+1) for every i a `limit`-sized answer can
    // reach, so a confidently wrong neighbourhood cannot take position 1.
    const lexical = Array.from({ length: 10 }, (_, i) => row(`lex${i}`));
    const graph = Array.from({ length: 10 }, (_, i) => row(`gr${i}`));
    const fused = fuseRankedLists(
      [{ rows: lexical }, { rows: graph, weight: 0.5 }],
      { limit: 10 },
    );
    expect(fused[0].title).toBe("lex0");
    expect(fused.slice(0, 5).every(r => r.title.startsWith("lex"))).toBe(true);
  });

  test("identity is overridable so one file found three ways fuses into one row", () => {
    const byPath = (r: FindCandidate) => r.key;
    const named = (key: string, signal: FindCandidate["signals"][number]): FindCandidate => ({
      key, kind: "file", title: key, content: "", source: "file", signals: [signal],
    });
    const fused = fuseRankedLists<FindCandidate>(
      [
        { rows: [named("file:a.ts", "filename")] },
        { rows: [named("file:a.ts", "content")] },
      ],
      { limit: 5, identity: byPath },
    );
    expect(fused).toHaveLength(1);
  });
});

describe("signal provenance", () => {
  const file = (rel: string, signal: FindCandidate["signals"][number]): FindCandidate => ({
    key: `file:${rel}`,
    kind: "file",
    title: rel,
    content: "",
    source: "file",
    relativePath: rel,
    path: `${PROJECT}/${rel}`,
    signals: [signal],
  });

  test("a row carries every signal that produced it, in signal order", () => {
    const { rows } = fuseFindSignals(
      [
        { signal: "content", rows: [file("src/a.ts", "content")] },
        { signal: "filename", rows: [file("src/a.ts", "filename")] },
        { signal: "graph", rows: [file("src/a.ts", "graph")], weight: 0.5 },
      ],
      { limit: 5 },
    );
    expect(rows[0].signals).toEqual(["filename", "content", "graph"]);
  });

  test("the pool counts distinct candidates, not list entries", () => {
    const { poolSize } = fuseFindSignals(
      [
        { signal: "filename", rows: [file("a.ts", "filename"), file("b.ts", "filename")] },
        { signal: "content", rows: [file("a.ts", "content")] },
      ],
      { limit: 5 },
    );
    expect(poolSize).toBe(2);
  });

  test("a line number found by grep survives onto a row filename search won", () => {
    const withLine = { ...file("src/a.ts", "content"), line: 42 };
    const { rows } = fuseFindSignals(
      [
        { signal: "filename", rows: [file("src/a.ts", "filename")] },
        { signal: "content", rows: [withLine] },
      ],
      { limit: 5 },
    );
    expect(rows[0].line).toBe(42);
    expect(rows[0].title).toBe("src/a.ts:42");
  });
});

// ─────────────────────────────────────────────────────────
// 2. Candidate builders
// ─────────────────────────────────────────────────────────

describe("candidate builders", () => {
  test("grep hits collapse to one candidate per file, counting the rest", () => {
    const rows = contentCandidates(grepResult([
      { path: "src/a.ts", line: 1, text: "hit one" },
      { path: "src/a.ts", line: 9, text: "hit two" },
      { path: "src/b.ts", line: 4, text: "hit three" },
    ]).value);
    expect(rows).toHaveLength(2);
    expect(rows[0].matches).toBe(2);
    expect(rows[0].line).toBe(1);
  });

  test("scope confines file signals to a subtree, on directory boundaries", () => {
    const rows = filenameCandidates(
      fileSearchResult(["src/search/find.ts", "src/searchable.ts", "docs/find.md"]).value,
      { scope: "src/search" },
    );
    expect(rows.map(r => r.relativePath)).toEqual(["src/search/find.ts"]);
  });

  test("graph neighbourhoods decay with the rank of the seed that found them", () => {
    const rows = graphCandidates(
      [
        {
          relativePath: "src/a.ts",
          result: {
            seedFile: "src/a.ts", seedNodes: 2, nodes: [], truncated: false,
            files: [{ filePath: "src/x.ts", weight: 1, nodes: 1, minDistance: 1 }],
          },
        },
        {
          relativePath: "src/b.ts",
          result: {
            seedFile: "src/b.ts", seedNodes: 2, nodes: [], truncated: false,
            files: [{ filePath: "src/y.ts", weight: 1.8, nodes: 1, minDistance: 1 }],
          },
        },
      ],
      { projectDir: PROJECT },
    );
    // y.ts scores 1.8/2 = 0.9 from the second seed; x.ts scores 1.0 from the
    // first. Without the decay the weaker seed's stronger neighbour would win.
    expect(rows.map(r => r.relativePath)).toEqual(["src/x.ts", "src/y.ts"]);
  });

  test("a seed is never re-added as its own neighbour", () => {
    const rows = graphCandidates(
      [{
        relativePath: "src/a.ts",
        result: {
          seedFile: "src/a.ts", seedNodes: 1, nodes: [], truncated: false,
          files: [
            { filePath: "src/a.ts", weight: 9, nodes: 5, minDistance: 0 },
            { filePath: "src/z.ts", weight: 1, nodes: 1, minDistance: 1 },
          ],
        },
      }],
      { projectDir: PROJECT },
    );
    expect(rows.map(r => r.relativePath)).toEqual(["src/z.ts"]);
  });
});

// ─────────────────────────────────────────────────────────
// 3. Orchestration and degradation
// ─────────────────────────────────────────────────────────

describe("runFind — every signal present", () => {
  test("fuses five lists and reports coverage for each", async () => {
    const outcome = await runFind({
      query: "fusion",
      projectDir: PROJECT,
      limit: 10,
      acquireFinder: async () => ({
        ok: true,
        value: fakeFinder({
          files: ["src/search/find.ts", "src/search/hybrid.ts"],
          totalMatched: 9,
          grep: [{ path: "src/search/hybrid.ts", line: 328, text: "export function fuseRankings" }],
          grepMeta: { filesSearched: 4, filteredFileCount: 57, more: true },
        }),
      }),
      store: fakeStore([{ title: "RRF", content: "reciprocal rank fusion", source: "notes" }]),
      semantic: async () => [{ title: "Ranking", content: "merging ranked lists", source: "docs" }],
      openGraph: emptyGraph,
    });

    const signals = new Set(outcome.coverage.filter(c => !c.skipped).map(c => c.signal));
    expect(signals.has("filename")).toBe(true);
    expect(signals.has("content")).toBe(true);
    expect(signals.has("lexical")).toBe(true);
    expect(signals.has("semantic")).toBe(true);

    // hybrid.ts was found by BOTH fff signals, so it must outrank the file
    // only one of them saw.
    const hybrid = outcome.rows.find(r => r.relativePath === "src/search/hybrid.ts");
    expect(hybrid?.signals).toEqual(["filename", "content"]);
    expect(outcome.rows[0].relativePath).toBe("src/search/hybrid.ts");

    // The paths handed to the learning loop are the file rows, absolute.
    expect(outcome.shownPaths).toContain(`${PROJECT}/src/search/hybrid.ts`);
  });
});

describe("runFind — the graph arm, end to end", () => {
  // src/a.ts is what the text signals found. Its symbol calls one in
  // src/near.ts and imports one in src/far.ts; nothing points at src/cold.ts.
  const graph = () => graphOver(
    [
      { from: "a#f", to: "near#g", kind: "calls" },
      { from: "a#f", to: "far#h", kind: "imports" },
    ],
    [
      { id: "a#f", file: "src/a.ts" },
      { id: "near#g", file: "src/near.ts" },
      { id: "far#h", file: "src/far.ts" },
      { id: "cold#i", file: "src/cold.ts" },
    ],
  );

  test("neighbours of the seed enter the list, tagged as graph findings", async () => {
    const outcome = await runFind({
      query: "a",
      projectDir: PROJECT,
      store: null,
      acquireFinder: async () => ({ ok: true, value: fakeFinder({ files: ["src/a.ts"] }) }),
      openGraph: graph(),
    });
    const paths = outcome.rows.map(r => r.relativePath);
    expect(paths).toContain("src/near.ts");
    expect(paths).toContain("src/far.ts");
    // Nothing links to cold.ts, so adjacency does not invent it.
    expect(paths).not.toContain("src/cold.ts");
    expect(outcome.rows.find(r => r.relativePath === "src/near.ts")?.signals).toEqual(["graph"]);
    // `calls` outweighs `imports` (EDGE_WEIGHTS), and the arm inherits that.
    expect(paths.indexOf("src/near.ts")).toBeLessThan(paths.indexOf("src/far.ts"));
  });

  test("the seed keeps position 1 — a neighbourhood does not outrank its own seed", async () => {
    const outcome = await runFind({
      query: "a",
      projectDir: PROJECT,
      store: null,
      acquireFinder: async () => ({ ok: true, value: fakeFinder({ files: ["src/a.ts"] }) }),
      openGraph: graph(),
    });
    expect(outcome.rows[0].relativePath).toBe("src/a.ts");
  });

  test("the seed row carries the [related: …] tail", async () => {
    const outcome = await runFind({
      query: "a",
      projectDir: PROJECT,
      store: null,
      acquireFinder: async () => ({ ok: true, value: fakeFinder({ files: ["src/a.ts"] }) }),
      openGraph: graph(),
    });
    const seed = outcome.rows[0];
    expect(seed.relatedFiles).toEqual(["src/near.ts", "src/far.ts"]);
    expect(formatFindRows([seed], { query: "a" }))
      .toContain("[related: src/near.ts, src/far.ts]");
  });

  test("scope confines the graph arm too", async () => {
    const outcome = await runFind({
      query: "a",
      projectDir: PROJECT,
      scope: "src/a.ts",
      store: null,
      acquireFinder: async () => ({ ok: true, value: fakeFinder({ files: ["src/a.ts"] }) }),
      openGraph: graph(),
    });
    expect(outcome.rows.map(r => r.relativePath)).toEqual(["src/a.ts"]);
    expect(outcome.coverage.find(c => c.signal === "graph")?.detail).toBe("no neighbours");
  });

  test("a seed the index has never heard of is reported, not guessed at", async () => {
    const outcome = await runFind({
      query: "zzz",
      projectDir: PROJECT,
      store: null,
      acquireFinder: async () => ({ ok: true, value: fakeFinder({ files: ["src/unknown.ts"] }) }),
      openGraph: graph(),
    });
    expect(outcome.coverage.find(c => c.signal === "graph")?.detail).toBe("seeds not indexed");
  });
});

describe("runFind — degradation", () => {
  test("no fff: still answers from the knowledge base alone", async () => {
    const outcome = await runFind({
      query: "fusion",
      projectDir: PROJECT,
      store: fakeStore([{ title: "RRF", content: "reciprocal rank fusion", source: "notes" }]),
      // acquireFinder omitted entirely — the binary is not installed.
    });
    expect(outcome.rows).toHaveLength(1);
    expect(outcome.rows[0].kind).toBe("chunk");
    const blind = outcome.coverage.filter(c => c.skipped).map(c => c.signal);
    expect(blind).toContain("filename");
    expect(blind).toContain("content");
  });

  test("fff reports itself unavailable: degrades silently, not as an error", async () => {
    const outcome = await runFind({
      query: "fusion",
      projectDir: PROJECT,
      store: fakeStore([{ title: "RRF", content: "rrf", source: "notes" }]),
      acquireFinder: async () => ({ ok: false, error: "no native binary", unavailable: true }),
    });
    expect(outcome.rows).toHaveLength(1);
    const filename = outcome.coverage.find(c => c.signal === "filename");
    expect(filename?.skipped).toBe(true);
    expect(filename?.detail).toBe("fff unavailable");
  });

  test("no codegraph index: the other four signals still fuse", async () => {
    const outcome = await runFind({
      query: "fusion",
      projectDir: PROJECT,
      acquireFinder: async () => ({ ok: true, value: fakeFinder({ files: ["src/a.ts"] }) }),
      store: fakeStore([{ title: "RRF", content: "rrf", source: "notes" }]),
      openGraph: () => ({ ok: false, reason: "no-index", message: "never indexed" }),
    });
    expect(outcome.rows.length).toBeGreaterThan(0);
    const graph = outcome.coverage.find(c => c.signal === "graph");
    expect(graph?.skipped).toBe(true);
    expect(graph?.detail).toBe("no-index");
  });

  test("no store at all: fff-only is a supported answer", async () => {
    const outcome = await runFind({
      query: "fusion",
      projectDir: PROJECT,
      store: null,
      acquireFinder: async () => ({ ok: true, value: fakeFinder({ files: ["src/a.ts"] }) }),
    });
    expect(outcome.rows.map(r => r.relativePath)).toEqual(["src/a.ts"]);
    expect(outcome.coverage.find(c => c.signal === "lexical")?.detail).toBe("no knowledge base");
  });

  test("nothing available anywhere: empty, not thrown", async () => {
    const outcome = await runFind({ query: "fusion", projectDir: PROJECT, store: null });
    expect(outcome.rows).toEqual([]);
    expect(outcome.coverage.every(c => c.skipped)).toBe(true);
  });

  test("type:\"memory\" leaves the file signals unrun", async () => {
    const outcome = await runFind({
      query: "fusion",
      projectDir: PROJECT,
      type: "memory",
      acquireFinder: async () => ({ ok: true, value: fakeFinder({ files: ["src/a.ts"] }) }),
      store: fakeStore([{ title: "RRF", content: "rrf", source: "notes" }]),
    });
    expect(outcome.rows.every(r => r.kind === "chunk")).toBe(true);
    expect(outcome.coverage.find(c => c.signal === "filename")?.detail).toBe("type/env");
  });

  test("a per-signal env switch removes exactly that signal", async () => {
    const env = { ...process.env, CONTEXT_MODE_FIND_CONTENT: "0" };
    expect(signalEnabled("content", env)).toBe(false);
    expect(signalEnabled("filename", env)).toBe(true);
    const outcome = await runFind({
      query: "fusion",
      projectDir: PROJECT,
      env,
      acquireFinder: async () => ({
        ok: true,
        value: fakeFinder({ files: ["src/a.ts"], grep: [{ path: "src/b.ts", line: 1, text: "x" }] }),
      }),
      store: null,
    });
    expect(outcome.rows.map(r => r.relativePath)).toEqual(["src/a.ts"]);
  });

  test("graph weight 0 removes the graph list without failing the search", async () => {
    const env = { ...process.env, CONTEXT_MODE_FIND_GRAPH_WEIGHT: "0" };
    expect(graphSignalWeight(env)).toBe(0);
    const outcome = await runFind({
      query: "fusion",
      projectDir: PROJECT,
      env,
      store: null,
      acquireFinder: async () => ({ ok: true, value: fakeFinder({ files: ["src/a.ts"] }) }),
      openGraph: emptyGraph,
    });
    expect(outcome.coverage.find(c => c.signal === "graph")?.detail).toBe("weight 0");
    expect(outcome.rows).toHaveLength(1);
  });

  test("the graph weight is clamped — a signal cannot be given more than a vote", () => {
    expect(graphSignalWeight({ CONTEXT_MODE_FIND_GRAPH_WEIGHT: "17" } as NodeJS.ProcessEnv)).toBe(1);
    expect(graphSignalWeight({ CONTEXT_MODE_FIND_GRAPH_WEIGHT: "-3" } as NodeJS.ProcessEnv)).toBe(0);
    expect(graphSignalWeight({} as NodeJS.ProcessEnv)).toBe(0.5);
  });
});

// ─────────────────────────────────────────────────────────
// 4. Honest coverage for grep's file-based pagination
// ─────────────────────────────────────────────────────────

describe("grep coverage is stated in files, not matches", () => {
  test("the line names files scanned and eligible, and flags another page", () => {
    const line = formatGrepCoverage({
      matches: 12, files: 3, filesSearched: 3, filesEligible: 57, morePages: true,
    });
    expect(line).toBe("12 match(es) in 3 file(s), scanned 3/57 file(s), more pages");
    // The number that must NOT be the denominator: fff totals only this page.
    expect(line).not.toContain("of 12");
  });

  test("no cursor means no claim of more pages", () => {
    expect(formatGrepCoverage({
      matches: 4, files: 2, filesSearched: 57, filesEligible: 57, morePages: false,
    })).toBe("4 match(es) in 2 file(s), scanned 57/57 file(s)");
  });

  test("runFind surfaces that coverage verbatim, and marks the signal saturated", async () => {
    const outcome = await runFind({
      query: "fusion",
      projectDir: PROJECT,
      store: null,
      acquireFinder: async () => ({
        ok: true,
        value: fakeFinder({
          grep: [
            { path: "src/a.ts", line: 1, text: "x" },
            { path: "src/b.ts", line: 2, text: "y" },
          ],
          grepMeta: { filesSearched: 2, filteredFileCount: 40, more: true },
        }),
      }),
    });
    const content = outcome.coverage.find(c => c.signal === "content");
    expect(content?.detail).toBe("2 match(es) in 2 file(s), scanned 2/40 file(s), more pages");
    expect(content?.more).toBe(true);
    // A signal with another page means the fused total is a lower bound.
    expect(outcome.completeness.saturated).toBe(true);
  });

  test("the coverage line names blind signals rather than omitting them", () => {
    const line = formatSignalCoverageLine([
      { signal: "filename", shown: 3, total: 12 },
      { signal: "content", shown: 2, total: null, detail: "2 match(es) in 2 file(s), scanned 2/40 file(s), more pages", more: true },
      { signal: "graph", shown: 0, total: 0, detail: "no-index", skipped: true },
    ]);
    expect(line).toBe(
      "> Signals: filename 3/12 · content 2+ "
      + "(2 match(es) in 2 file(s), scanned 2/40 file(s), more pages) · graph off (no-index)",
    );
  });
});

// ─────────────────────────────────────────────────────────
// 5. The ranking-feedback loop
// ─────────────────────────────────────────────────────────

describe("trackQuery loop — server writes, hook selects, server learns", () => {
  let dir: string;
  const DB = "/sessions/abcd__main.db";

  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "ctx-find-marker-")); });
  afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ } });

  test("a full round trip: shown → opened → trained", async () => {
    recordFindCandidates(DB, {
      query: "rank fusion",
      paths: ["/repo/src/search/hybrid.ts", "/repo/src/search/find.ts"],
      at: Date.now(),
    }, dir);

    // Hook side: the file the caller opened was one of the candidates.
    const records = readFindCandidates(DB, dir);
    const hit = matchSelection(records, "/repo/src/search/find.ts");
    expect(hit?.query).toBe("rank fusion");
    appendFindSelection(DB, { query: hit!.query, path: "/repo/src/search/find.ts", at: Date.now() }, dir);

    // Server side: drain and feed fff.
    const drained = consumeFindSelections(DB, dir);
    expect(drained).toEqual([
      expect.objectContaining({ query: "rank fusion", path: "/repo/src/search/find.ts" }),
    ]);

    const tracked: Array<{ query: string; path: string }> = [];
    const finder = fakeFinder({ tracked });
    for (const s of drained) await finder.trackQuery(s.query, s.path);
    expect(tracked).toEqual([{ query: "rank fusion", path: "/repo/src/search/find.ts" }]);
  });

  test("selections are consumed once — a file cannot win the ranking forever", () => {
    appendFindSelection(DB, { query: "q", path: "/repo/a.ts", at: Date.now() }, dir);
    expect(consumeFindSelections(DB, dir)).toHaveLength(1);
    expect(consumeFindSelections(DB, dir)).toHaveLength(0);
  });

  test("candidates are NOT consumed on read — one search can be followed by several opens", () => {
    const db = "/sessions/read-twice__main.db";
    recordFindCandidates(db, { query: "q2", paths: ["/repo/a.ts", "/repo/b.ts"], at: Date.now() }, dir);
    expect(readFindCandidates(db, dir)).toHaveLength(1);
    expect(readFindCandidates(db, dir)).toHaveLength(1);
  });

  test("a file that was never shown trains nothing", () => {
    recordFindCandidates(DB, { query: "q3", paths: ["/repo/a.ts"], at: Date.now() }, dir);
    expect(matchSelection(readFindCandidates(DB, dir), "/repo/unrelated.ts")).toBeNull();
  });

  test("an expired window trains nothing", () => {
    recordFindCandidates(DB, {
      query: "stale",
      paths: ["/repo/stale.ts"],
      at: Date.now() - 60 * 60_000,
    }, dir);
    expect(readFindCandidates(DB, dir, Date.now(), 15 * 60_000)
      .some(r => r.query === "stale")).toBe(false);
  });

  test("a corrupt marker is silence, not a failure", () => {
    expect(readFindCandidates("/sessions/never-written.db", dir)).toEqual([]);
    expect(consumeFindSelections("/sessions/never-written.db", dir)).toEqual([]);
  });

  test("the hook's inline spelling of both marker paths still matches this module", () => {
    // The hook cannot import from src/ — no bundle carries src/search/**. It
    // therefore re-derives both paths by hand, exactly as it already does for
    // the retrieval marker. If either spelling drifts, the loop silently stops
    // learning and nothing else fails. So the drift is asserted here.
    const hook = readFileSync(
      new URL("../../hooks/posttooluse.mjs", import.meta.url),
      "utf-8",
    );
    expect(hook).toContain("context-mode-find-${basename(dbPath)}.json");
    expect(hook).toContain("context-mode-find-selected-${basename(dbPath)}.jsonl");
    expect(hook).toContain("CONTEXT_MODE_FIND_TRACK");
    expect(hook).toContain("CONTEXT_MODE_FIND_TRACK_TTL_MS");
  });
});

// ─────────────────────────────────────────────────────────
// 6. The graph signal must not cost lexical quality
// ─────────────────────────────────────────────────────────
//
// Same corpus, same recorded baseline, same metrics module as the ctx_search
// gate in tests/core/search.test.ts. Two arms: the fused list WITHOUT the
// graph signal, and WITH it at the shipped weight. The graph arm is fed the
// worst case on purpose — plausible file candidates that are never the answer,
// which is what a wrong seed produces — because the risk being guarded against
// is displacement, not agreement.

interface RelevanceFixture {
  documents: Array<{ source: string; markdown: string }>;
  queries: Array<{ id: string; cls: string; query: string; relevant: string[] }>;
}
interface RetrievalBaseline {
  tolerance: number;
  corpus: { limit: number };
  lexical: { precisionAt1: number; recallAt5: number; mrr: number };
}

const readFixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf-8")) as T;

describe("graph signal vs the recorded retrieval baseline", () => {
  const fixture = readFixture<RelevanceFixture>("relevance-corpus.json");
  const baseline = readFixture<RetrievalBaseline>("retrieval-baseline.json");
  const limit = baseline.corpus.limit;

  let store: ContentStore;
  let before: { precisionAt1: number; recallAt5: number; mrr: number };
  let after: { precisionAt1: number; recallAt5: number; mrr: number };

  beforeAll(() => {
    const path = join(tmpdir(), `ctx-find-graph-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new ContentStore(path);
    for (const doc of fixture.documents) store.index({ content: doc.markdown, source: doc.source });

    // A fixed set of file candidates standing in for a graph neighbourhood
    // that has nothing to do with the query. Ten of them, so the list is long
    // enough to displace a short lexical tail if the weighting let it.
    const noise: FindCandidate[] = Array.from({ length: 10 }, (_, i) => ({
      key: `file:src/noise-${i}.ts`,
      kind: "file" as const,
      title: `src/noise-${i}.ts`,
      content: "",
      source: "file",
      relativePath: `src/noise-${i}.ts`,
      path: `${PROJECT}/src/noise-${i}.ts`,
      signals: ["graph" as const],
    }));

    const run = (withGraph: boolean) => fixture.queries.map(c => {
      // Exactly the call the ctx_search gate measures, at exactly its limit:
      // the arm is a comparison against that baseline, and asking the store
      // for a deeper pool would change the ranking being compared.
      const lexical = chunkCandidates(
        store.searchWithFallback(c.query, limit) as unknown as Array<Record<string, unknown>>,
        "lexical",
      );
      const lists = withGraph
        ? [
            { signal: "lexical" as const, rows: lexical },
            { signal: "graph" as const, rows: noise, weight: graphSignalWeight({} as NodeJS.ProcessEnv) },
          ]
        : [{ signal: "lexical" as const, rows: lexical }];
      return {
        id: c.id,
        cls: c.cls,
        relevant: c.relevant,
        sources: fuseFindSignals(lists, { limit }).rows.map(r => r.source),
      };
    });

    before = score(run(false), limit);
    after = score(run(true), limit);

    // Printed so the numbers land in the run log rather than only in an
    // assertion message — the point of the arm is the comparison, not the pass.
    console.log(
      `[ctx_find graph arm] before: P@1=${before.precisionAt1.toFixed(3)} `
      + `R@5=${before.recallAt5.toFixed(3)} MRR=${before.mrr.toFixed(3)} | `
      + `after(weight ${graphSignalWeight({} as NodeJS.ProcessEnv)}): `
      + `P@1=${after.precisionAt1.toFixed(3)} R@5=${after.recallAt5.toFixed(3)} `
      + `MRR=${after.mrr.toFixed(3)}`,
    );
  });

  afterAll(() => { try { store.cleanup(); } catch { /* ok */ } });

  test("the fused list without the graph matches the lexical baseline", () => {
    for (const metric of ["precisionAt1", "recallAt5", "mrr"] as const) {
      expect(
        before[metric],
        `fused-without-graph ${metric} ${before[metric]} vs lexical baseline ${baseline.lexical[metric]}`,
      ).toBeGreaterThanOrEqual(baseline.lexical[metric] - baseline.tolerance);
    }
  });

  test("adding the graph signal at the shipped weight costs nothing", () => {
    for (const metric of ["precisionAt1", "recallAt5", "mrr"] as const) {
      expect(
        after[metric],
        `${metric} fell from ${before[metric]} to ${after[metric]} when the graph list was added. `
        + "Lower CONTEXT_MODE_FIND_GRAPH_WEIGHT — do not re-record the baseline.",
      ).toBeGreaterThanOrEqual(before[metric] - 1e-9);
    }
  });

  test("and it still clears the recorded baseline", () => {
    for (const metric of ["precisionAt1", "recallAt5", "mrr"] as const) {
      expect(after[metric]).toBeGreaterThanOrEqual(baseline.lexical[metric] - baseline.tolerance);
    }
  });
});
