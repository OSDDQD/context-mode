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

import { isAbsolute, join, relative } from "node:path";

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
  /**
   * The content match this row represents is a DEFINITION (fff's
   * `classifyDefinitions`), not a usage. Set by `contentCandidates`, which
   * also promotes such rows inside the content list.
   */
  isDefinition?: boolean;
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
// Tuning constants — each one is a number the fusion's behaviour rests on
// ─────────────────────────────────────────────────────────

/**
 * RRF damping for the `ctx_find` fusion.
 *
 * k = 60 comes from the original RRF paper, where the lists were TREC runs of a
 * thousand documents; here every list is about twenty rows. At 60 the first row
 * contributes 1/61 and the twentieth 1/80 — a spread of ×1.33, which erases the
 * intra-list order the sources paid to produce (fff's frecency-aware ranking,
 * FTS5's bm25) and lets rank 20 in two lists outrank rank 1 in one. At 12 the
 * same spread is ×2.46: agreement between signals still decides ties, but a
 * list's leader is no longer interchangeable with its tail.
 *
 * Not lowered further: below ~5 the fusion degenerates into "whatever the
 * single most confident list said", which is the state this tool exists to
 * leave. The graph list keeps its 0.5 weight, so with this k it can reach the
 * tail below rank ~12 — the tail is where a neighbourhood belongs.
 */
export const FIND_RRF_K = 12;

/**
 * Matching lines fff may collect from ONE file per grep page.
 *
 * `contentCandidates` collapses every match in a file into a single candidate,
 * so the native default of 200 ships up to 200 line strings across the FFI to
 * produce one row and a counter. A handful is kept rather than one so that a
 * definition line further down the file can still be seen and promoted (see
 * `classifyDefinitions`), which one match per file would make impossible.
 */
const GREP_MATCHES_PER_FILE = 4;

/**
 * Wall-clock ceiling on one grep page. `ctx_find` is interactive and four other
 * signals are already answering; a grep that has not finished sweeping a large
 * tree in this long should return what it has and let the coverage line say the
 * page was partial, rather than hold the whole call.
 */
const GREP_TIME_BUDGET_MS = 1500;

/**
 * How much deeper the fff arms fetch when a `scope` is set.
 *
 * Neither `fileSearch` nor `grep` takes a path constraint, so scope is a
 * post-filter — and a post-filter after a 20-row page returns nothing at all
 * whenever the top 20 happen to live outside the subtree, which reads as "no
 * such file" rather than "look further". Fetching wider and filtering is the
 * only way to answer a scoped query honestly.
 */
const SCOPED_FETCH_FACTOR = 10;

/** Ceiling on the widened scoped fetch — a scoped query is not a tree dump. */
const SCOPED_FETCH_MAX = 500;

/**
 * Extra grep pages pulled while a scope is set and the in-scope pool is still
 * short. Bounded: grep pages by file in frecency order, so a subtree that never
 * appears is a subtree with no matches, and walking the whole cursor to prove
 * it would cost more than the answer is worth.
 */
const SCOPED_GREP_MAX_PAGES = 5;

// ─────────────────────────────────────────────────────────
// Seams — everything this module talks to, as the least it needs
// ─────────────────────────────────────────────────────────

/**
 * The two `ContentStore` methods the lexical and semantic arms use.
 *
 * The parameter names are the store's own (`store.ts` `searchWithFallbackMeta`):
 * the fifth argument is a SOURCE-LABEL match mode (`like` / `exact` / …), not a
 * search mode, and the sixth is the session-id allow-set that keeps a shared
 * database from answering with another project's chunks. Both were nameless
 * here, and the allow-set was missing entirely — a positional seam that quietly
 * disagrees with the implementation is how the wrong argument gets passed.
 */
export interface FindStore {
  searchWithFallbackMeta(
    query: string,
    limit: number,
    source?: string,
    contentType?: "code" | "prose",
    sourceMatchMode?: string,
    sessionIdAllowSet?: Set<string>,
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
  /**
   * Session ids whose chunks the lexical arm may answer with. Absent means "no
   * restriction", which is right for a per-project database and wrong for a
   * shared one: without it `ctx_find` reads chunks captured in other projects'
   * sessions, while `ctx_search` (which does pass it) does not.
   */
  sessionIdAllowSet?: Set<string>;
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

/**
 * fff filename hits, in fff's own order (frecency-aware fuzzy ranking), with
 * exact matches lifted to the front.
 *
 * fff ranks by a blended `total` in which frecency, path distance and the
 * combo-match boost can all outweigh the fact that a file is LITERALLY called
 * what was typed. That blend is right for an editor's "open file" palette,
 * where the hot files are the likely targets; it is wrong for a search whose
 * query is a name. So `exactMatch` — the one field of the score breakdown that
 * says something the blended order cannot — is read back out and used to
 * partition the list. Nothing else is re-applied: `frecencyBoost` and the rest
 * are already inside `total`, and adding them again would double-count the
 * signal fff already weighed.
 *
 * `scores` is positionally aligned with `items` by `normalizeSearchResult`,
 * including across drops; a missing entry simply means "not exact".
 */
export function filenameCandidates(
  result: FffSearchResult,
  opts: { scope?: string } = {},
): FindCandidate[] {
  const exact: FindCandidate[] = [];
  const rest: FindCandidate[] = [];
  (result.items ?? []).forEach((item, i) => {
    if (!inScope(item.relativePath, opts.scope)) return;
    const candidate = fileCandidate({
      path: item.path,
      relativePath: item.relativePath,
      signal: "filename",
      content: "",
      gitStatus: item.gitStatus,
    });
    (result.scores?.[i]?.exactMatch ? exact : rest).push(candidate);
  });
  return [...exact, ...rest];
}

/**
 * fff grep hits, collapsed to one candidate per FILE, definitions first.
 *
 * Per-file, not per-match: forty hits in one file is one answer, and letting it
 * occupy forty of the fused list's slots would hand the whole result set to
 * whichever file happens to repeat the token most.
 *
 * The definition pass is why `classifyDefinitions` is switched on. Rust already
 * decides, per line, whether the match is a declaration or a use; before this,
 * that verdict crossed the FFI and was dropped, so `ctx_find("fuseRankings")`
 * ranked the file that CALLS it — usually many files, in frecency order —
 * exactly as high as the file that DECLARES it. Two things change here:
 * the row's representative line becomes the definition when the file has one
 * (a caller reading the snippet sees the signature, not a call site), and rows
 * with a definition are lifted above rows without one, preserving fff's order
 * inside each group. This is a within-list promotion, not a score: the fusion
 * still decides whether the content signal wins at all.
 */
export function contentCandidates(
  result: FffGrepResult,
  opts: { scope?: string } = {},
): FindCandidate[] {
  const byFile = new Map<string, FindCandidate>();
  for (const match of result.items ?? []) {
    if (!inScope(match.relativePath, opts.scope)) continue;
    const rel = toPosix(match.relativePath);
    const line = String(match.lineContent ?? "").trim().slice(0, 300);
    const existing = byFile.get(rel);
    if (existing) {
      existing.matches = (existing.matches ?? 1) + 1;
      // A definition found later in the file replaces the first usage as what
      // this row shows — the first match is only "first" because grep reads
      // top to bottom, which says nothing about which line answers the query.
      if (match.isDefinition && !existing.isDefinition) {
        existing.isDefinition = true;
        existing.line = match.lineNumber;
        existing.content = line;
        existing.title = match.lineNumber > 0 ? `${rel}:${match.lineNumber}` : rel;
      }
      continue;
    }
    const candidate = fileCandidate({
      path: match.path,
      relativePath: match.relativePath,
      signal: "content",
      content: line,
      line: match.lineNumber,
      matches: 1,
      gitStatus: match.gitStatus,
    });
    if (match.isDefinition) candidate.isDefinition = true;
    byFile.set(rel, candidate);
  }
  const rows = [...byFile.values()];
  const defs = rows.filter(r => r.isDefinition);
  return defs.length > 0 && defs.length < rows.length
    ? [...defs, ...rows.filter(r => !r.isDefinition)]
    : rows;
}

/**
 * The prefix `code-index.ts` writes for a file-backed source:
 * `code:<relpath>` inside the project, `code:<abspath>` outside it.
 */
const CODE_SOURCE_PREFIX = "code:";

/**
 * The project-relative path a `code:` source label names, or null if the label
 * is not one, points outside `projectDir`, or no project dir was supplied.
 */
function codeSourcePath(source: string, projectDir?: string): string | null {
  if (!projectDir || !source.startsWith(CODE_SOURCE_PREFIX)) return null;
  const raw = source.slice(CODE_SOURCE_PREFIX.length).trim();
  if (!raw) return null;
  const rel = toPosix(isAbsolute(raw) ? relative(projectDir, raw) : raw);
  if (!rel || rel.startsWith("../") || isAbsolute(rel)) return null;
  return rel;
}

/**
 * Rows out of the FTS5 store (or the vector scan) as candidates.
 *
 * Chunks of an INDEXED FILE come back as file candidates. One file used to
 * enter the fusion under two identities — `file:src/store.ts` from fff and
 * `chunk:code:src/store.ts…` from FTS5 — which never collapsed, so the two
 * signals that agreed most strongly about a file each spent a slot saying so
 * separately, and the agreement itself was invisible in the ranking. Recognising
 * the `code:` label converts the row to the file identity the fff arms already
 * use, and the chunk's text stays on as the row's snippet: the reader gets the
 * file, plus the indexed text that matched, in one line instead of two.
 *
 * Chunks of anything else (captured output, fetched docs, notes) keep the chunk
 * identity — they are not files and stay individually addressable.
 */
export function chunkCandidates(
  rows: Array<Record<string, unknown>>,
  signal: FindSignal,
  opts: { projectDir?: string; scope?: string } = {},
): FindCandidate[] {
  const out: FindCandidate[] = [];
  /** Files already represented in THIS list — a second chunk of one file is
   *  the same answer, and collapsing it here keeps the list's ranks honest. */
  const seenFiles = new Set<string>();

  for (const row of rows) {
    const base = {
      title: String(row.title ?? "Untitled"),
      content: String(row.content ?? ""),
      source: String(row.source ?? "unknown"),
    };

    const rel = codeSourcePath(base.source, opts.projectDir);
    if (rel) {
      if (seenFiles.has(rel)) continue;
      if (!inScope(rel, opts.scope)) continue;
      seenFiles.add(rel);
      out.push({
        ...row,
        ...base,
        key: `file:${rel}`,
        kind: "file",
        title: rel,
        path: join(opts.projectDir as string, rel),
        relativePath: rel,
        signals: [signal],
      } as FindCandidate);
      continue;
    }

    out.push({
      ...row,
      ...base,
      key: `chunk:${chunkIdentity(base)}`,
      kind: "chunk" as const,
      signals: [signal],
    } as FindCandidate);
  }
  return out;
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
 * What every list said about a key, accumulated as the lists are produced.
 *
 * Kept separate from the ranking because RRF keeps the FIRST row object it sees
 * for a key and discards the rest, so the merged row has no memory of the other
 * lists it appeared in. That memory is exactly what a reader needs — one signal
 * is a guess, three agreeing is an answer.
 *
 * It is a standing index rather than a pass because `runFind` needs the ranking
 * twice: once early, to pick graph seeds, and once at the end over every list.
 * Rebuilding provenance for the second call meant walking the same rows twice
 * and throwing the first set of maps away.
 */
export interface FindProvenance {
  signals: Map<string, Set<FindSignal>>;
  annotations: Map<string, { line?: number; matches?: number; relatedFiles?: string[] }>;
}

export function createFindProvenance(): FindProvenance {
  return { signals: new Map(), annotations: new Map() };
}

/** Fold one signal's list into the index. Call order does not matter. */
export function recordProvenance(
  index: FindProvenance,
  signal: FindSignal,
  rows: FindCandidate[],
): void {
  for (const row of rows) {
    let seen = index.signals.get(row.key);
    if (!seen) index.signals.set(row.key, (seen = new Set()));
    seen.add(signal);
    // A file can arrive from `filename` with no line and from `content` with
    // one. Whichever row object wins the fusion should still carry both.
    const ann = index.annotations.get(row.key) ?? {};
    if (row.line != null && ann.line == null) ann.line = row.line;
    if (row.matches != null) ann.matches = Math.max(ann.matches ?? 0, row.matches);
    if (row.relatedFiles?.length) ann.relatedFiles = row.relatedFiles;
    index.annotations.set(row.key, ann);
  }
}

/**
 * Attach graph neighbours to a key.
 *
 * Keyed rather than written through the row object: the seed rows come out of
 * the seed ranking, which may or may not be the same object the final fusion
 * keeps, and the annotation has to survive either way.
 */
export function annotateRelated(
  index: FindProvenance,
  key: string,
  relatedFiles: string[],
): void {
  const ann = index.annotations.get(key) ?? {};
  ann.relatedFiles = relatedFiles;
  index.annotations.set(key, ann);
}

/**
 * Fuse the signal lists and stamp each surviving row with every signal that
 * produced it.
 *
 * `opts.provenance` lets a caller that already accumulated the index hand it
 * over instead of paying for it a second time; without it the index is built
 * here from the lists, which is what every caller outside `runFind` wants.
 */
export function fuseFindSignals(
  lists: Array<{ signal: FindSignal; rows: FindCandidate[]; weight?: number }>,
  opts: { limit: number; k?: number; provenance?: FindProvenance },
): { rows: FindCandidate[]; poolSize: number } {
  let index = opts.provenance;
  if (!index) {
    index = createFindProvenance();
    for (const list of lists) recordProvenance(index, list.signal, list.rows);
  }
  const { signals: provenance, annotations } = index;

  const ranked: Array<RankedList<FindCandidate>> = lists
    .filter(l => l.rows.length > 0)
    .map(l => ({ rows: l.rows, weight: l.weight }));

  const fused = fuseRankedLists<FindCandidate>(ranked, {
    limit: opts.limit,
    k: opts.k ?? FIND_RRF_K,
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

/** How deep an fff arm fetches, given that `scope` can only be a post-filter. */
function fetchDepth(perSignal: number, scope?: string): number {
  return scope
    ? Math.min(SCOPED_FETCH_MAX, perSignal * SCOPED_FETCH_FACTOR)
    : perSignal;
}

/**
 * One grep page — or several, when a scope is set and the pages seen so far
 * have not produced enough files inside it.
 *
 * fff walks files in frecency order and takes no path constraint, so a subtree
 * that is not currently hot can sit entirely behind the first page. Following
 * the cursor is the only way to reach it; the page budget is what stops that
 * from turning into a full-tree sweep for a subtree with nothing to say.
 *
 * The pages are merged into one result so the per-file collapse downstream sees
 * a whole file's matches at once. `totalMatched` and `filesSearched` are summed
 * because fff reports both per page; the cursor and the eligible-file count
 * come from the last page, which is what "is there more" is asked of.
 */
function collectGrepPages(
  finder: FindFinder,
  query: string,
  opts: { pageSize: number; scope?: string; want: number; maxPages: number },
): FffGrepResult | null {
  let cursor: FffGrepResult["nextCursor"] = null;
  let last: FffGrepResult | null = null;
  const items: FffGrepResult["items"] = [];
  const inScopeFiles = new Set<string>();
  let totalMatched = 0;
  let filesSearched = 0;

  for (let page = 0; page < opts.maxPages; page++) {
    const result = finder.grep(query, {
      pageSize: opts.pageSize,
      maxMatchesPerFile: GREP_MATCHES_PER_FILE,
      timeBudgetMs: GREP_TIME_BUDGET_MS,
      classifyDefinitions: true,
      ...(cursor ? { cursor } : {}),
    });
    if (!result.ok) break;
    const value = result.value;
    last = value;
    for (const match of value.items ?? []) {
      items.push(match);
      if (inScope(match.relativePath, opts.scope)) inScopeFiles.add(toPosix(match.relativePath));
    }
    totalMatched += value.totalMatched ?? 0;
    filesSearched += value.filesSearched ?? 0;
    cursor = value.nextCursor ?? null;
    if (!cursor || inScopeFiles.size >= opts.want) break;
  }

  return last ? { ...last, items, totalMatched, filesSearched } : null;
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
  // What the fff arms ask for. Equal to `perSignal` unscoped; wider when a
  // scope is set, because scope can only be applied after the page comes back.
  const fffDepth = fetchDepth(perSignal, opts.scope);
  // Provenance is accumulated as the lists are produced, so the seed ranking
  // and the final fusion share one index instead of building two.
  const provenance = createFindProvenance();
  const addList = (list: SignalList) => {
    lists.push(list);
    recordProvenance(provenance, list.signal, list.rows);
  };

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
        const result = finder.fileSearch(opts.query, { pageSize: fffDepth });
        if (result.ok) {
          const rows = filenameCandidates(result.value, { scope: opts.scope })
            .slice(0, perSignal);
          addList({
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
        // Grep's `pageSize` counts MATCHES across all files, not files. With
        // at most `GREP_MATCHES_PER_FILE` lines per file, asking for that
        // multiple is what makes a page worth `perSignal` distinct FILES —
        // which is the unit the fused list is built from. A scope widens the
        // number of PAGES rather than the page: grep ships line content, and
        // following the cursor reaches the same distance for a fraction of it.
        const value = collectGrepPages(finder, opts.query, {
          pageSize: perSignal * GREP_MATCHES_PER_FILE,
          scope: opts.scope,
          want: perSignal,
          maxPages: opts.scope ? SCOPED_GREP_MAX_PAGES : 1,
        });
        if (value) {
          const rows = contentCandidates(value, { scope: opts.scope })
            .slice(0, perSignal);
          // Grep pages by FILE and `totalMatched` counts only this page —
          // the denominator that means anything is files scanned vs eligible.
          const grepCov: GrepCoverage = {
            matches: value.totalMatched,
            files: rows.length,
            filesSearched: value.filesSearched,
            filesEligible: value.filteredFileCount,
            morePages: value.nextCursor != null,
          };
          addList({
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
        opts.sessionIdAllowSet,
      );
      const rows = chunkCandidates(found.results ?? [], "lexical", {
        projectDir: opts.projectDir,
        scope: opts.scope,
      });
      addList({
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
        { projectDir: opts.projectDir, scope: opts.scope },
      );
      if (rows.length > 0) {
        addList({
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
  if (wanted("graph") && opts.openGraph && graphWeight > 0) {
    // A seed RANKING, not a second fusion. The seeds need nothing but an order
    // over the two file lists, so this is a bare RRF at the fusion's own k.
    // It used to call `fuseFindSignals`, which rebuilt the provenance and
    // annotation maps and allocated a fresh row object per candidate — all of
    // it discarded except three paths, and all of it rebuilt again by the real
    // fusion below. Those maps are now the index both passes share.
    const seedRows = fuseRankedLists<FindCandidate>(
      lists
        .filter(l => (l.signal === "filename" || l.signal === "content") && l.rows.length > 0)
        .map(l => ({ rows: l.rows })),
      { limit: graphSignalSeeds(env), k: FIND_RRF_K, identity: row => row.key },
    ).filter(r => r.kind === "file" && r.path);

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
                // neighbours the graph added. Written into the shared index by
                // key, so it reaches whichever row object the fusion keeps.
                const tail = relatedTail(result);
                if (tail.length > 0) annotateRelated(provenance, seed.key, tail);
              }
            }
            const rows = graphCandidates(seeds, {
              projectDir: opts.projectDir,
              scope: opts.scope,
            });
            if (rows.length > 0) {
              addList({
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
            // Releases the pooled lease; the connection stays open for the next
            // ctx_find in this session (src/graph/db.ts, handle pool). Still
            // mandatory in a `finally` — a lease that is never released pins
            // its entry against eviction for the life of the process.
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
  const fused = fuseFindSignals(
    lists.map(l => ({
      signal: l.signal,
      rows: l.rows,
      weight: l.signal === "graph" ? graphWeight : 1,
    })),
    { limit, k: FIND_RRF_K, provenance },
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
