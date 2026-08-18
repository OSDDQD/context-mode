/**
 * `ctx_find` — one query, five signals, one ranked list.
 *
 * Stage 2 (and, for the graph arm, stage 4) of the consolidation plan. Before
 * this, answering "where does X live" cost four tools and four context dumps:
 * a filename search, a grep, a knowledge-base search, and a structural query,
 * each with its own ranking and its own idea of what "top 5" means. The caller
 * had to fuse them by reading all four.
 *
 * The signals, in the order they are added and for the reason they are added:
 *
 * | signal     | source                          | answers                       |
 * |------------|---------------------------------|-------------------------------|
 * | `filename` | fff `fileSearch`                | "the file is called something like X" |
 * | `content`  | fff `grep`                      | "the string X is in these files"      |
 * | `lexical`  | FTS5 `ContentStore`             | "we already captured something about X" |
 * | `semantic` | chunk vectors                   | "we captured something that MEANS X"    |
 * | `graph`    | codegraph `related`             | "whatever X is, it lives next to these" |
 *
 * ## Fusion
 *
 * Every signal produces a RANKED LIST and nothing else — no cross-signal
 * scores, no hand-tuned addition. The lists go into
 * {@link fuseRankedLists}, the same weighted RRF the lexical/semantic fusion
 * already used; this module adds lists to it rather than introducing a second
 * ranker. Identity is overridden so that one FILE found three ways fuses into
 * one row (which is the whole point — agreement between signals is the signal),
 * while indexed chunks stay individually addressable.
 *
 * ## Why the graph list is weighted below 1
 *
 * The four textual signals answer the query. The graph answers a DIFFERENT
 * question — "what is adjacent to the files the other signals liked" — and it
 * answers it confidently even when the seed was wrong, because adjacency is
 * always defined. At weight 1 a confidently wrong neighbourhood outranks a
 * correct lexical hit that only one matcher found. At the default 0.5 it can
 * promote a file two signals already liked and can add a neighbour at the tail,
 * but it cannot displace a top lexical result on its own. `CONTEXT_MODE_FIND_
 * GRAPH_WEIGHT` moves it; 0 removes it without removing the `[related: …]`
 * annotations.
 *
 * ## Degradation
 *
 * Every signal is optional and every failure is silent. No fff binary, no
 * `.codegraph/` index, no embedding endpoint, an empty knowledge base — each
 * removes one list and leaves the others fused. `ctx_find` answering from FTS5
 * alone is a normal, supported state, and the coverage line says which signals
 * were blind rather than pretending they agreed.
 */

import { join } from "node:path";

import {
  chunkIdentity, fuseRankedLists, type LexicalResult, type RankedList,
} from "./hybrid.js";
import {
  formatGrepCoverage, type GrepCoverage, type SearchCompleteness, type SignalCoverage,
} from "./completeness.js";
import type { GraphOpenResult } from "../graph/db.js";
import { related as graphRelated, type RelatedResult } from "../graph/queries.js";
import type {
  FffGrepResult, FffResult, FffSearchResult,
} from "../fff/types.js";

// ─────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────

export const FIND_SIGNALS = ["filename", "content", "lexical", "semantic", "graph"] as const;
export type FindSignal = (typeof FIND_SIGNALS)[number];

/** What the caller may narrow the search to. */
export const FIND_TYPES = ["all", "files", "code", "memory"] as const;
export type FindType = (typeof FIND_TYPES)[number];

/** Which signals each `type` admits. `all` admits everything. */
const TYPE_SIGNALS: Record<FindType, ReadonlySet<FindSignal>> = {
  all: new Set(FIND_SIGNALS),
  files: new Set<FindSignal>(["filename", "graph"]),
  code: new Set<FindSignal>(["filename", "content", "graph"]),
  memory: new Set<FindSignal>(["lexical", "semantic"]),
};

/**
 * One row of the fused list.
 *
 * Extends {@link LexicalResult} because that is what the fusion consumes; the
 * extra fields are what makes a fused row readable — above all `signals`,
 * without which "why is this first" is unanswerable.
 */
export interface FindCandidate extends LexicalResult {
  /** Fusion identity. `file:<relpath>` or `chunk:<identity>`. */
  key: string;
  kind: "file" | "chunk";
  /** Absolute path — file candidates only. */
  path?: string;
  /** Project-relative, forward slashes — file candidates only. */
  relativePath?: string;
  /** First matching line, when a content signal produced this row. */
  line?: number;
  /** Signals that produced this row, in {@link FIND_SIGNALS} order. */
  signals: FindSignal[];
  /** Matching lines in this file on the grep page that produced it. */
  matches?: number;
  /** Files the graph places next to this one, best first. */
  relatedFiles?: string[];
  /** fff's git status word, when it supplied one. */
  gitStatus?: string;
}

/** A ranked list plus what that signal could see. */
interface SignalList {
  signal: FindSignal;
  rows: FindCandidate[];
  coverage: SignalCoverage;
}

export interface FindOutcome {
  query: string;
  rows: FindCandidate[];
  /** Per-signal coverage, in {@link FIND_SIGNALS} order, skipped ones included. */
  coverage: SignalCoverage[];
  /** Pool arithmetic for the fused list. */
  completeness: SearchCompleteness;
  /** Absolute paths of the file rows shown — what the learning loop records. */
  shownPaths: string[];
}

// ─────────────────────────────────────────────────────────
// Env switches
// ─────────────────────────────────────────────────────────

/** `CONTEXT_MODE_FIND=0` removes the tool from the surface entirely. */
export function findToolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CONTEXT_MODE_FIND !== "0";
}

const SIGNAL_ENV: Record<FindSignal, string> = {
  filename: "CONTEXT_MODE_FIND_FILENAME",
  content: "CONTEXT_MODE_FIND_CONTENT",
  lexical: "CONTEXT_MODE_FIND_LEXICAL",
  semantic: "CONTEXT_MODE_FIND_SEMANTIC",
  graph: "CONTEXT_MODE_FIND_GRAPH",
};

/** One switch per signal, so a misbehaving source can be cut without a rebuild. */
export function signalEnabled(
  signal: FindSignal,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[SIGNAL_ENV[signal]] !== "0";
}

/**
 * Weight of the graph list in the fusion. Default 0.5 — see the module note.
 * Clamped to [0, 1]: above 1 the structural prior outvotes the text that was
 * actually searched for, which is not a tuning choice, it is a bug.
 */
export function graphSignalWeight(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseFloat(env.CONTEXT_MODE_FIND_GRAPH_WEIGHT ?? "");
  if (!Number.isFinite(raw)) return 0.5;
  return Math.min(1, Math.max(0, raw));
}

/** Hops the graph walk takes from each seed. Default 1 — direct neighbours. */
export function graphSignalDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.CONTEXT_MODE_FIND_GRAPH_DEPTH ?? "", 10);
  if (!Number.isFinite(raw)) return 1;
  return Math.min(3, Math.max(1, raw));
}

/** File candidates used as graph seeds. Default 3. */
export function graphSignalSeeds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.CONTEXT_MODE_FIND_GRAPH_SEEDS ?? "", 10);
  if (!Number.isFinite(raw)) return 3;
  return Math.min(10, Math.max(1, raw));
}

// ─────────────────────────────────────────────────────────
// Seams — everything this module talks to, as the least it needs
// ─────────────────────────────────────────────────────────

/** The two `ContentStore` methods the lexical and semantic arms use. */
export interface FindStore {
  searchWithFallbackMeta(
    query: string,
    limit: number,
    source?: string,
    contentType?: "code" | "prose",
    mode?: string,
    allowSet?: Set<string>,
  ): { results: Array<Record<string, unknown>>; completeness: SearchCompleteness };
  rawDb(): unknown;
}

/** The three `FffFinder` methods `ctx_find` uses. */
export interface FindFinder {
  fileSearch(query: string, options?: Record<string, unknown>): FffResult<FffSearchResult>;
  grep(query: string, options?: Record<string, unknown>): FffResult<FffGrepResult>;
  trackQuery(query: string, selectedFilePath: string): Promise<FffResult<boolean>>;
}

/** Semantic neighbours, injected so the arm can be tested without an endpoint. */
export type SemanticProvider = (
  query: string,
  limit: number,
  sourceFilter?: string,
) => Promise<Array<Record<string, unknown>>>;

export interface FindOptions {
  query: string;
  projectDir: string;
  /** Rows in the fused list. */
  limit?: number;
  /** Project-relative path prefix the file signals are confined to. */
  scope?: string;
  type?: FindType;
  /** Source label for the lexical and semantic arms. */
  source?: string;
  env?: NodeJS.ProcessEnv;
  /** Null when the knowledge base could not be opened. */
  store?: FindStore | null;
  /** Acquire the fff finder. Absent (or failing) removes two signals. */
  acquireFinder?: (projectDir: string) => Promise<FffResult<FindFinder>>;
  /** Open the codegraph index. Absent (or failing) removes the graph signal. */
  openGraph?: (projectDir: string) => GraphOpenResult;
  /** Semantic neighbours. Absent removes the semantic signal. */
  semantic?: SemanticProvider;
}

// ─────────────────────────────────────────────────────────
// Candidate builders — one per signal, each pure
// ─────────────────────────────────────────────────────────

function toPosix(p: string): string {
  return String(p ?? "").split("\\").join("/").replace(/^\.\//, "");
}

/** `scope` is a path prefix, matched on directory boundaries only. */
function inScope(relativePath: string, scope?: string): boolean {
  if (!scope) return true;
  const needle = toPosix(scope).replace(/\/+$/, "");
  if (!needle) return true;
  const hay = toPosix(relativePath);
  return hay === needle || hay.startsWith(`${needle}/`);
}

function fileCandidate(init: {
  path: string;
  relativePath: string;
  signal: FindSignal;
  content: string;
  line?: number;
  matches?: number;
  gitStatus?: string;
}): FindCandidate {
  const rel = toPosix(init.relativePath);
  return {
    key: `file:${rel}`,
    kind: "file",
    title: init.line && init.line > 0 ? `${rel}:${init.line}` : rel,
    content: init.content,
    source: "file",
    path: init.path,
    relativePath: rel,
    line: init.line,
    matches: init.matches,
    gitStatus: init.gitStatus,
    signals: [init.signal],
  };
}

/** fff filename hits, in fff's own order (frecency-aware fuzzy ranking). */
export function filenameCandidates(
  result: FffSearchResult,
  opts: { scope?: string } = {},
): FindCandidate[] {
  const out: FindCandidate[] = [];
  for (const item of result.items ?? []) {
    if (!inScope(item.relativePath, opts.scope)) continue;
    out.push(fileCandidate({
      path: item.path,
      relativePath: item.relativePath,
      signal: "filename",
      content: "",
      gitStatus: item.gitStatus,
    }));
  }
  return out;
}

/**
 * fff grep hits, collapsed to one candidate per FILE.
 *
 * Per-file, not per-match: forty hits in one file is one answer, and letting it
 * occupy forty of the fused list's slots would hand the whole result set to
 * whichever file happens to repeat the token most.
 */
export function contentCandidates(
  result: FffGrepResult,
  opts: { scope?: string } = {},
): FindCandidate[] {
  const byFile = new Map<string, FindCandidate>();
  for (const match of result.items ?? []) {
    if (!inScope(match.relativePath, opts.scope)) continue;
    const rel = toPosix(match.relativePath);
    const existing = byFile.get(rel);
    if (existing) {
      existing.matches = (existing.matches ?? 1) + 1;
      continue;
    }
    byFile.set(rel, fileCandidate({
      path: match.path,
      relativePath: match.relativePath,
      signal: "content",
      content: String(match.lineContent ?? "").trim().slice(0, 300),
      line: match.lineNumber,
      matches: 1,
      gitStatus: match.gitStatus,
    }));
  }
  return [...byFile.values()];
}

/** Rows out of the FTS5 store (or the vector scan) as chunk candidates. */
export function chunkCandidates(
  rows: Array<Record<string, unknown>>,
  signal: FindSignal,
): FindCandidate[] {
  return rows.map(row => {
    const base = {
      title: String(row.title ?? "Untitled"),
      content: String(row.content ?? ""),
      source: String(row.source ?? "unknown"),
    };
    return {
      ...row,
      ...base,
      key: `chunk:${chunkIdentity(base)}`,
      kind: "chunk" as const,
      signals: [signal],
    } as FindCandidate;
  });
}

/**
 * Turn per-seed neighbourhoods into one ranked list of files.
 *
 * A seed's contribution decays with the seed's own rank (`1/(rank+1)`): the
 * neighbourhood of the best file candidate is better evidence than the
 * neighbourhood of the third-best, and without the decay a wrong third seed
 * contributes exactly as much as a right first one.
 *
 * The seeds themselves are excluded — they are already in the fusion through
 * the signal that found them, and re-adding them would be that signal voting
 * twice under another name.
 */
export function graphCandidates(
  seeds: Array<{ relativePath: string; result: RelatedResult }>,
  opts: { projectDir: string; scope?: string },
): FindCandidate[] {
  const seedPaths = new Set(seeds.map(s => toPosix(s.relativePath)));
  const scored = new Map<string, { weight: number; nodes: number }>();

  seeds.forEach((seed, rank) => {
    const decay = 1 / (rank + 1);
    for (const file of seed.result.files ?? []) {
      const rel = toPosix(file.filePath);
      if (!rel || seedPaths.has(rel)) continue;
      if (!inScope(rel, opts.scope)) continue;
      const prev = scored.get(rel) ?? { weight: 0, nodes: 0 };
      prev.weight += decay * (Number(file.weight) || 0);
      prev.nodes += Number(file.nodes) || 0;
      scored.set(rel, prev);
    }
  });

  return [...scored.entries()]
    .sort((a, b) => b[1].weight - a[1].weight)
    .map(([rel, s]) => {
      return fileCandidate({
        path: join(opts.projectDir, rel),
        relativePath: rel,
        signal: "graph",
        content: `graph neighbour — ${s.nodes} symbol(s), weight ${s.weight.toFixed(2)}`,
      });
    });
}

/** Neighbour file names to annotate a seed row with. */
export function relatedTail(result: RelatedResult, max = 3): string[] {
  return (result.files ?? [])
    .slice(0, max)
    .map(f => toPosix(f.filePath))
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────
// Fusion
// ─────────────────────────────────────────────────────────

const SIGNAL_ORDER = new Map<FindSignal, number>(FIND_SIGNALS.map((s, i) => [s, i]));

/**
 * Fuse the signal lists and stamp each surviving row with every signal that
 * produced it.
 *
 * The provenance pass is separate from the fusion on purpose: RRF keeps the
 * FIRST row object it sees for a key and discards the rest, so the merged row
 * has no memory of the other lists it appeared in. That memory is exactly what
 * a reader needs — one signal is a guess, three agreeing is an answer.
 */
export function fuseFindSignals(
  lists: Array<{ signal: FindSignal; rows: FindCandidate[]; weight?: number }>,
  opts: { limit: number; k?: number },
): { rows: FindCandidate[]; poolSize: number } {
  const provenance = new Map<string, Set<FindSignal>>();
  const annotations = new Map<string, { line?: number; matches?: number; relatedFiles?: string[] }>();
  for (const list of lists) {
    for (const row of list.rows) {
      let seen = provenance.get(row.key);
      if (!seen) provenance.set(row.key, (seen = new Set()));
      seen.add(list.signal);
      // A file can arrive from `filename` with no line and from `content` with
      // one. Whichever row object wins the fusion should still carry both.
      const ann = annotations.get(row.key) ?? {};
      if (row.line != null && ann.line == null) ann.line = row.line;
      if (row.matches != null) ann.matches = Math.max(ann.matches ?? 0, row.matches);
      if (row.relatedFiles?.length) ann.relatedFiles = row.relatedFiles;
      annotations.set(row.key, ann);
    }
  }

  const ranked: Array<RankedList<FindCandidate>> = lists
    .filter(l => l.rows.length > 0)
    .map(l => ({ rows: l.rows, weight: l.weight }));

  const fused = fuseRankedLists<FindCandidate>(ranked, {
    limit: opts.limit,
    k: opts.k,
    identity: row => row.key,
  });

  const rows = fused.map(row => {
    const signals = [...(provenance.get(row.key) ?? new Set<FindSignal>([...row.signals]))]
      .sort((a, b) => (SIGNAL_ORDER.get(a) ?? 0) - (SIGNAL_ORDER.get(b) ?? 0));
    const ann = annotations.get(row.key) ?? {};
    return {
      ...row,
      signals,
      line: row.line ?? ann.line,
      matches: row.matches ?? ann.matches,
      relatedFiles: row.relatedFiles ?? ann.relatedFiles,
      title: row.kind === "file" && (row.line ?? ann.line)
        ? `${row.relativePath}:${row.line ?? ann.line}`
        : row.title,
    };
  });

  return { rows, poolSize: provenance.size };
}

// ─────────────────────────────────────────────────────────
// Orchestration
// ─────────────────────────────────────────────────────────

function skipped(signal: FindSignal, detail: string): SignalCoverage {
  return { signal, shown: 0, total: 0, detail, skipped: true };
}

/**
 * Run every enabled signal, fuse, and report what each one saw.
 *
 * Never throws: each arm is individually guarded, because a search tool that
 * fails outright when one of five optional sources is unavailable is worse than
 * the four tools it replaces.
 */
export async function runFind(opts: FindOptions): Promise<FindOutcome> {
  const env = opts.env ?? process.env;
  const limit = Math.min(50, Math.max(1, opts.limit ?? 10));
  const type: FindType = opts.type ?? "all";
  const admitted = TYPE_SIGNALS[type] ?? TYPE_SIGNALS.all;
  const wanted = (s: FindSignal) => admitted.has(s) && signalEnabled(s, env);

  const lists: SignalList[] = [];
  const coverage: SignalCoverage[] = [];
  // Candidate pool per signal: deep enough that the fusion has something to
  // disagree about, shallow enough that a wide grep does not dominate the pool.
  const perSignal = Math.max(limit * 2, 20);

  // ── fff arms: filename + content ──────────────────────
  let finder: FindFinder | null = null;
  const wantsFff = wanted("filename") || wanted("content");
  if (wantsFff && opts.acquireFinder) {
    try {
      const acquired = await opts.acquireFinder(opts.projectDir);
      if (acquired.ok) finder = acquired.value;
      else if (!acquired.unavailable) {
        // A real operational error is worth one word; `unavailable` is not.
        coverage.push(skipped("filename", acquired.error.slice(0, 80)));
      }
    } catch { /* fff never throws by contract; belt and braces */ }
  }

  if (wanted("filename")) {
    if (finder) {
      try {
        const result = finder.fileSearch(opts.query, { pageSize: perSignal });
        if (result.ok) {
          const rows = filenameCandidates(result.value, { scope: opts.scope });
          lists.push({
            signal: "filename",
            rows,
            coverage: {
              signal: "filename",
              shown: rows.length,
              total: result.value.totalMatched,
              more: result.value.truncated || rows.length < result.value.totalMatched,
            },
          });
        }
      } catch { /* degrade */ }
    }
    if (!lists.some(l => l.signal === "filename") && !coverage.some(c => c.signal === "filename")) {
      coverage.push(skipped("filename", finder ? "no matches" : "fff unavailable"));
    }
  } else {
    coverage.push(skipped("filename", "type/env"));
  }

  if (wanted("content")) {
    if (finder) {
      try {
        const result = finder.grep(opts.query, {
          pageSize: perSignal,
          classifyDefinitions: true,
        });
        if (result.ok) {
          const value = result.value;
          const rows = contentCandidates(value, { scope: opts.scope });
          // Grep pages by FILE and `totalMatched` counts only this page —
          // the denominator that means anything is files scanned vs eligible.
          const grepCov: GrepCoverage = {
            matches: value.totalMatched,
            files: rows.length,
            filesSearched: value.filesSearched,
            filesEligible: value.filteredFileCount,
            morePages: value.nextCursor != null,
          };
          lists.push({
            signal: "content",
            rows,
            coverage: {
              signal: "content",
              shown: rows.length,
              total: null,
              detail: formatGrepCoverage(grepCov),
              more: grepCov.morePages,
            },
          });
        }
      } catch { /* degrade */ }
    }
    if (!lists.some(l => l.signal === "content")) {
      coverage.push(skipped("content", finder ? "no matches" : "fff unavailable"));
    }
  } else {
    coverage.push(skipped("content", "type/env"));
  }

  // ── knowledge base: lexical ───────────────────────────
  if (wanted("lexical") && opts.store) {
    try {
      const found = opts.store.searchWithFallbackMeta(
        opts.query, perSignal, opts.source, undefined, "like",
      );
      const rows = chunkCandidates(found.results ?? [], "lexical");
      lists.push({
        signal: "lexical",
        rows,
        coverage: {
          signal: "lexical",
          shown: rows.length,
          total: found.completeness?.poolSize ?? rows.length,
          more: found.completeness?.saturated ?? false,
        },
      });
    } catch { /* degrade */ }
  }
  if (!lists.some(l => l.signal === "lexical")) {
    coverage.push(skipped(
      "lexical",
      wanted("lexical") ? (opts.store ? "no matches" : "no knowledge base") : "type/env",
    ));
  }

  // ── knowledge base: semantic ──────────────────────────
  if (wanted("semantic") && opts.semantic) {
    try {
      const rows = chunkCandidates(
        await opts.semantic(opts.query, perSignal, opts.source),
        "semantic",
      );
      if (rows.length > 0) {
        lists.push({
          signal: "semantic",
          rows,
          coverage: { signal: "semantic", shown: rows.length, total: null },
        });
      }
    } catch { /* degrade — an unreachable endpoint is not an error here */ }
  }
  if (!lists.some(l => l.signal === "semantic")) {
    coverage.push(skipped(
      "semantic",
      wanted("semantic") ? (opts.semantic ? "no vectors" : "embeddings off") : "type/env",
    ));
  }

  // ── structure: graph ──────────────────────────────────
  //
  // Last, and seeded from the text signals rather than from the query: the
  // graph has no opinion about words, only about files, so it needs the other
  // signals to tell it where to stand before it can say what is nearby.
  const graphWeight = graphSignalWeight(env);
  let graphCoverage: SignalCoverage | null = null;
  /** `file:<rel>` → neighbour paths, applied to the ORIGINAL list rows below. */
  const seedTails = new Map<string, string[]>();
  if (wanted("graph") && opts.openGraph && graphWeight > 0) {
    const seedRows = fuseFindSignals(
      lists
        .filter(l => l.signal === "filename" || l.signal === "content")
        .map(l => ({ signal: l.signal, rows: l.rows })),
      { limit: graphSignalSeeds(env) },
    ).rows.filter(r => r.kind === "file" && r.path);

    if (seedRows.length === 0) {
      graphCoverage = skipped("graph", "no file seeds");
    } else {
      try {
        const opened = opts.openGraph(opts.projectDir);
        if (!opened.ok) {
          graphCoverage = skipped("graph", opened.reason);
        } else {
          const handle = opened.handle;
          try {
            const depth = graphSignalDepth(env);
            const seeds: Array<{ relativePath: string; result: RelatedResult }> = [];
            for (const seed of seedRows) {
              const result = graphRelated(handle, {
                filePath: seed.path as string,
                depth,
                limit: 40,
              });
              if (result.seedNodes > 0) {
                seeds.push({ relativePath: seed.relativePath as string, result });
                // Annotate the seed itself — `[related: …]` is useful on the
                // row the caller is most likely to open, not only on the
                // neighbours the graph added. Keyed, not written through
                // `seed`: seed rows are copies made by the pre-fusion, so the
                // tail has to be applied to the rows that enter the real one.
                const tail = relatedTail(result);
                if (tail.length > 0) seedTails.set(seed.key, tail);
              }
            }
            const rows = graphCandidates(seeds, {
              projectDir: opts.projectDir,
              scope: opts.scope,
            });
            if (rows.length > 0) {
              lists.push({
                signal: "graph",
                rows,
                coverage: {
                  signal: "graph",
                  shown: rows.length,
                  total: null,
                  detail: `${seeds.length} seed(s), weight ${graphWeight}`,
                },
              });
            } else {
              graphCoverage = skipped(
                "graph",
                seeds.length === 0 ? "seeds not indexed" : "no neighbours",
              );
            }
          } finally {
            try { handle.close(); } catch { /* best-effort */ }
          }
        }
      } catch { /* degrade */ }
    }
  }
  if (!lists.some(l => l.signal === "graph")) {
    coverage.push(graphCoverage ?? skipped(
      "graph",
      graphWeight <= 0 ? "weight 0" : (wanted("graph") ? "unavailable" : "type/env"),
    ));
  }

  // ── fuse ──────────────────────────────────────────────
  if (seedTails.size > 0) {
    for (const list of lists) {
      for (const row of list.rows) {
        const tail = seedTails.get(row.key);
        if (tail) row.relatedFiles = tail;
      }
    }
  }

  const fused = fuseFindSignals(
    lists.map(l => ({
      signal: l.signal,
      rows: l.rows,
      weight: l.signal === "graph" ? graphWeight : 1,
    })),
    { limit },
  );

  for (const list of lists) coverage.push(list.coverage);
  coverage.sort(
    (a, b) =>
      (SIGNAL_ORDER.get(a.signal as FindSignal) ?? 9)
      - (SIGNAL_ORDER.get(b.signal as FindSignal) ?? 9),
  );

  const saturated = lists.some(l => l.coverage.more === true);
  return {
    query: opts.query,
    rows: fused.rows,
    coverage,
    completeness: {
      shown: fused.rows.length,
      poolSize: fused.poolSize,
      saturated,
    },
    shownPaths: fused.rows
      .filter(r => r.kind === "file" && typeof r.path === "string")
      .map(r => r.path as string),
  };
}

// ─────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────

/**
 * One line per row plus at most one body line.
 *
 * The tails follow `ctx_search`: `>`-prefixed advisory lines after the results,
 * never interleaved with them, so a reader scanning for paths never has to step
 * over prose.
 */
export function formatFindRows(
  rows: FindCandidate[],
  opts: { snippet?: (content: string, query: string) => string; query: string },
): string {
  const snippet = opts.snippet ?? ((c: string) => c.replace(/\s+/g, " ").trim().slice(0, 300));
  return rows
    .map((row, i) => {
      const n = String(i + 1).padStart(2);
      const marks = `[${row.signals.join("+")}]`;
      const head = row.kind === "file"
        ? `${n}. ${row.title}  ${marks}${row.matches && row.matches > 1 ? `  ×${row.matches}` : ""}`
        : `${n}. ${row.source} — ${row.title}  ${marks}`;
      const body = row.content ? snippet(row.content, opts.query) : "";
      const lines = [head];
      if (body) lines.push(`    ${body.split("\n").join("\n    ")}`);
      if (row.relatedFiles?.length) {
        lines.push(`    [related: ${row.relatedFiles.join(", ")}]`);
      }
      return lines.join("\n");
    })
    .join("\n");
}
