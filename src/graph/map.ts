/**
 * A token-budgeted map of the repository — aider's repo map, over codegraph's
 * tables.
 *
 * The question "what is this project, structurally" currently costs a session
 * a `find`, several `outline` calls and usually a couple of Reads, and the
 * answer still arrives as a pile of paths with no ordering. The pieces to
 * answer it in one kilobyte were already in the database; only the algorithm
 * was missing.
 *
 * Three steps:
 *
 * 1. **Graph.** Files are the nodes; an edge exists where a symbol in one file
 *    calls, imports, extends or references a symbol in another. Aggregated in
 *    SQL (see `fileEdges` in `./queries.ts`) so this module never issues a
 *    query per file.
 * 2. **Personalized PageRank.** With a `focus`, files whose path or symbol
 *    names match the query terms take ×{@link FOCUS_BOOST} of the restart mass
 *    and of the edges pointing at them (aider's factor, on both), and rank
 *    flows outward from there — in both directions, at {@link REVERSE_SHARE}
 *    against the arrow — so a file that merely NEIGHBOURS the match still
 *    outranks an unrelated leaf. Without a `focus`, personalization is uniform
 *    and the result is plain PageRank: the files the repository leans on
 *    hardest.
 * 3. **Packing.** Files, then their most important symbols' signatures, emitted
 *    until the token budget is spent — whole lines only.
 *
 * ## Why the budget is in tokens and counted with the repo's own estimator
 *
 * `budget` is what the caller pays, and the caller pays in tokens. Counting
 * bytes and calling them tokens would make the parameter a lie whose error
 * varies by a factor of three between a signature-dense TypeScript map and a
 * path-dense one. {@link countTokens} is the same estimator `ctx_stats` reports
 * with, so a map that claims 1 024 tokens and a stats line that claims 1 024
 * tokens mean the same thing (see docs/adr/0004).
 */

import { countTokens } from "../session/tokenizer.js";
import type { GraphDbHandle } from "./db.js";
import {
  EDGE_WEIGHTS,
  fileEdges,
  inboundEdgeCounts,
  mapNodes,
  type MapNodeRow,
} from "./queries.js";

// ─────────────────────────────────────────────────────────
// Tuning
// ─────────────────────────────────────────────────────────

/** Standard PageRank damping: 85% of the mass follows edges, 15% restarts. */
export const DAMPING = 0.85;

/**
 * Restart-mass multiplier for a file matching the focus terms. Aider's ×10 —
 * strong enough that the focus dominates the ranking, bounded enough that a
 * heavily-connected neighbour of the match can still surface.
 */
export const FOCUS_BOOST = 10;

/**
 * Hard iteration cap. PageRank on a file graph converges in well under this;
 * the cap exists so a pathological graph costs a bounded amount of CPU on a
 * tool call rather than an unbounded one.
 */
export const MAX_ITERATIONS = 30;

/**
 * Share of an edge's weight that also flows against its direction. See the
 * backlink note in {@link repoMap}: a map has to reach callers, not only
 * callees, and 0.5 keeps the dependency direction dominant while doing it.
 */
export const REVERSE_SHARE = 0.5;

/**
 * Per-file convergence tolerance; the L1 threshold is this times the file
 * count, which is networkx's `pagerank` rule. A FIXED L1 threshold looks
 * stricter but is not — it tightens as the repository grows, so a 3 000-file
 * project would hit the iteration cap every time and every map would carry a
 * "did not converge" caveat that says nothing about the ranking's quality.
 */
const TOLERANCE_PER_FILE = 1e-6;

/** Symbols listed per file before the map moves on, budget permitting. */
export const MAX_SYMBOLS_PER_FILE = 6;

/** Default token budget — roughly one kilobyte of answer. */
export const DEFAULT_BUDGET_TOKENS = 1024;

/** Tokens held back so the footer that explains the cut always fits. */
const FOOTER_RESERVE_TOKENS = 40;

/** Signatures are collapsed to this many characters, with an ellipsis. */
const SIGNATURE_MAX = 120;

// ─────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────

export interface MapSymbol {
  name: string;
  kind: string;
  startLine: number;
  /** Signature when codegraph captured one, else `null`. */
  signature: string | null;
  /** Within-file importance: inbound edges, export status, focus match. */
  score: number;
}

export interface MapFile {
  filePath: string;
  /** PageRank mass. Comparable within one result, not across projects. */
  rank: number;
  /** True when the file's path or one of its symbols matched a focus term. */
  focusMatch: boolean;
  symbols: MapSymbol[];
}

export interface RepoMapResult {
  /** Every ranked file, best first. Packing decides how many are shown. */
  files: MapFile[];
  /** Declarations the index holds (after `import`/`file` rows are dropped). */
  totalSymbols: number;
  /** Files contributing at least one declaration. */
  totalFiles: number;
  /** Focus terms actually used, lowercased. Empty when no focus was given. */
  focusTerms: string[];
  /** Files matching at least one focus term. 0 with a focus means it missed. */
  focusMatches: number;
  iterations: number;
  converged: boolean;
  /** The node scan hit its cap — ranking saw only part of the index. */
  nodesCapped: boolean;
  /** The aggregated edge scan hit its cap — same caveat, for the links. */
  edgesCapped: boolean;
}

// ─────────────────────────────────────────────────────────
// Ranking
// ─────────────────────────────────────────────────────────

/**
 * Split a focus query into match terms.
 *
 * Same tokenisation as `ftsQuery`, minus the FTS syntax: identifiers are split
 * on non-word characters so `retry handling` and `RetryBudget.consume` both
 * reduce to plain lowercase terms. Single characters are dropped — a one-letter
 * term matches most paths in most repositories and would boost everything,
 * which is the same as boosting nothing.
 */
export function focusTerms(focus: string | undefined): string[] {
  return String(focus ?? "")
    .split(/[^A-Za-z0-9_]+/)
    .map(t => t.toLowerCase())
    .filter(t => t.length > 1)
    .slice(0, 12);
}

/** Rank every indexed file, and pick the symbols worth showing for each. */
export function repoMap(
  handle: GraphDbHandle,
  opts: { focus?: string; maxIterations?: number } = {},
): RepoMapResult {
  const terms = focusTerms(opts.focus);
  const loaded = mapNodes(handle);
  const edges = fileEdges(handle);
  const inbound = inboundEdgeCounts(handle);

  const byFile = new Map<string, MapNodeRow[]>();
  for (const n of loaded.nodes) {
    if (!n.filePath) continue;
    const bucket = byFile.get(n.filePath);
    if (bucket) bucket.push(n);
    else byFile.set(n.filePath, [n]);
  }

  // Sorted, so every downstream index is stable and two runs over the same
  // database produce byte-identical output. A Map's insertion order would also
  // be stable in practice, but it is an accident of the SQL ORDER BY rather
  // than a property this function guarantees.
  const files = [...byFile.keys()].sort();
  if (files.length === 0) {
    return {
      files: [], totalSymbols: 0, totalFiles: 0,
      focusTerms: terms, focusMatches: 0,
      iterations: 0, converged: true,
      nodesCapped: loaded.capped, edgesCapped: edges.capped,
    };
  }

  const index = new Map<string, number>();
  files.forEach((f, i) => index.set(f, i));

  // Personalization. A file matches when a term appears in its path or in one
  // of its symbol names — the path alone would miss `RetryBudget` living in
  // `src/util/limits.ts`, and the symbols alone would miss a file whose whole
  // purpose is named by its directory.
  const personal = new Float64Array(files.length);
  const matched = new Uint8Array(files.length);
  let focusMatches = 0;
  for (let i = 0; i < files.length; i++) {
    let hit = false;
    if (terms.length > 0) {
      const path = files[i]!.toLowerCase();
      hit = terms.some(t => path.includes(t));
      if (!hit) {
        for (const n of byFile.get(files[i]!) ?? []) {
          const name = n.name.toLowerCase();
          if (terms.some(t => name.includes(t))) { hit = true; break; }
        }
      }
    }
    if (hit) { matched[i] = 1; focusMatches++; }
    personal[i] = hit ? FOCUS_BOOST : 1;
  }
  // A focus that matched nothing is a focus that must not silently reweight the
  // graph — uniform personalization is the honest fallback, and the caller is
  // told `focusMatches: 0` so it can see the term missed rather than infer it
  // from a ranking that looks arbitrary.
  let personalSum = 0;
  for (let i = 0; i < files.length; i++) personalSum += personal[i]!;
  for (let i = 0; i < files.length; i++) personal[i] = personal[i]! / personalSum;

  // Adjacency in CSR-ish form: one flat array of {to, weight} per source. Built
  // once; the iteration below only reads it.
  const outgoing: Array<Array<{ to: number; w: number }>> = files.map(() => []);
  const outWeight = new Float64Array(files.length);
  for (const e of edges.edges) {
    const s = index.get(e.source);
    const t = index.get(e.target);
    if (s === undefined || t === undefined || s === t) continue;
    // Repeated edges of one kind between two files are real evidence of
    // coupling, but they are sub-linear evidence: forty calls into a utility
    // module does not make it forty times more central than one call would.
    const base = (EDGE_WEIGHTS[e.kind] ?? 0.3) * Math.sqrt(Math.max(1, e.count));
    // Focus boosts the restart mass AND the edges pointing at a matched file —
    // aider does both, and the second is not optional. Restart mass alone
    // leaks straight back out: a matched file with one outgoing edge hands its
    // whole boost to whatever it calls, which is how a logging helper ends up
    // ranked above the retry module in a search for "retry". Weighting inbound
    // edges makes the boost accumulate at the file the caller asked about
    // rather than at its dependencies.
    const forward = base * (matched[t] === 1 ? FOCUS_BOOST : 1);
    outgoing[s]!.push({ to: t, w: forward });
    outWeight[s] = outWeight[s]! + forward;

    // A reduced backlink, because a purely forward-flowing rank answers the
    // wrong question for a MAP. Rank following calls alone means a focus on
    // "retry" surfaces what retry.ts CALLS and nothing that calls IT — the
    // callers, which are exactly the code someone changing retry behaviour has
    // to look at, score the same as an unrelated leaf. Halved rather than
    // mirrored so the direction of dependency still counts for something: a
    // widely-called utility outranks its callers, as it should.
    const backward = base * REVERSE_SHARE * (matched[s] === 1 ? FOCUS_BOOST : 1);
    outgoing[t]!.push({ to: s, w: backward });
    outWeight[t] = outWeight[t]! + backward;
  }

  const maxIterations = Math.max(1, Math.min(opts.maxIterations ?? MAX_ITERATIONS, MAX_ITERATIONS));
  let rank = Float64Array.from(personal);
  let next = new Float64Array(files.length);
  let iterations = 0;
  let converged = false;

  for (let it = 0; it < maxIterations; it++) {
    iterations = it + 1;
    // Dangling files (no outgoing edges — leaves, entry points, dead modules)
    // would otherwise leak their mass out of the system each iteration and the
    // ranking would decay towards zero. Their mass restarts along the
    // personalization vector, which is what makes this PERSONALIZED PageRank
    // rather than PageRank with a hole in it.
    let dangling = 0;
    for (let i = 0; i < files.length; i++) {
      if (outWeight[i] === 0) dangling += rank[i]!;
      next[i] = 0;
    }
    for (let i = 0; i < files.length; i++) {
      const share = outWeight[i] === 0 ? 0 : rank[i]! / outWeight[i]!;
      if (share === 0) continue;
      for (const edge of outgoing[i]!) next[edge.to] = next[edge.to]! + share * edge.w;
    }
    let delta = 0;
    for (let i = 0; i < files.length; i++) {
      const value = (1 - DAMPING) * personal[i]! + DAMPING * (next[i]! + dangling * personal[i]!);
      delta += Math.abs(value - rank[i]!);
      next[i] = value;
    }
    const swap = rank; rank = next; next = swap;
    if (delta < TOLERANCE_PER_FILE * files.length) { converged = true; break; }
  }

  const ranked: MapFile[] = files.map((filePath, i) => ({
    filePath,
    rank: rank[i]!,
    focusMatch: matched[i] === 1,
    symbols: pickSymbols(byFile.get(filePath) ?? [], inbound, terms),
  }));
  // Descending rank, ties broken by path so the order is total and stable.
  ranked.sort((a, b) => b.rank - a.rank || a.filePath.localeCompare(b.filePath));

  return {
    files: ranked,
    totalSymbols: loaded.total,
    totalFiles: files.length,
    focusTerms: terms,
    focusMatches,
    iterations,
    converged,
    nodesCapped: loaded.capped,
    edgesCapped: edges.capped,
  };
}

/**
 * The symbols worth spending a file's share of the budget on.
 *
 * Inbound edges are the primary signal — a function the rest of the repository
 * calls is what "important" means here. Export status is a smaller thumb on the
 * scale for the file's public surface, and a focus match outranks both, because
 * a caller who asked about retries wants `retry()` named even if nothing has
 * called it yet.
 */
function pickSymbols(
  rows: MapNodeRow[],
  inbound: Map<string, number>,
  terms: string[],
): MapSymbol[] {
  const scored = rows.map(r => {
    const name = r.name.toLowerCase();
    const focused = terms.length > 0 && terms.some(t => name.includes(t));
    return {
      name: r.name,
      kind: r.kind,
      startLine: r.startLine,
      signature: r.signature,
      score: (inbound.get(r.id) ?? 0) + (r.isExported ? 2 : 0) + (focused ? 10 : 0),
    };
  });
  scored.sort((a, b) => b.score - a.score || a.startLine - b.startLine || a.name.localeCompare(b.name));
  return scored.slice(0, MAX_SYMBOLS_PER_FILE);
}

// ─────────────────────────────────────────────────────────
// Packing
// ─────────────────────────────────────────────────────────

export interface RenderedMap {
  text: string;
  /** Tokens the text actually costs, by the repo's estimator. */
  tokens: number;
  filesShown: number;
  symbolsShown: number;
}

/**
 * Pack the ranking into `budget` tokens.
 *
 * Greedy over the ranked list, whole lines only. The alternative — fill the
 * budget exactly and cut the last line mid-signature — produces a map whose
 * final entry is a lie: `export function handleRe` is not a signature, and a
 * reader cannot tell truncation from a real short name. So the loop stops at
 * the last line that fits, and the footer says how much was left out.
 *
 * The footer's own cost is reserved up front rather than discovered afterwards,
 * because a footer that pushes the answer over the budget the caller set is the
 * budget failing at the exact moment it was supposed to hold.
 */
export function renderRepoMap(
  result: RepoMapResult,
  opts: { budget?: number } = {},
): RenderedMap {
  const budget = Math.max(1, Math.floor(opts.budget ?? DEFAULT_BUDGET_TOKENS));
  const body = Math.max(1, budget - FOOTER_RESERVE_TOKENS);

  // Per-line accounting rather than re-tokenising the whole buffer after every
  // line: the latter is O(n²) on the packing loop, and the small over-count it
  // avoids errs on the safe side of the budget anyway.
  const cost = (line: string): number => countTokens(`${line}\n`);
  let spent = 0;

  // ── Pass 1: breadth. Admit files in rank order, each with its single most
  // important symbol.
  //
  // Depth-first packing — six symbols for the top file, then six for the next —
  // spends a 1 024-token budget on seven files of a three-thousand-file
  // repository, which is not a map of anything. Breadth is what the caller
  // asked for; the detail is what `outline` and `body` are for.
  const admitted: Array<{ file: MapFile; shown: number }> = [];
  for (const file of result.files) {
    const first = file.symbols[0];
    // A file header with no room for a single symbol under it is a path the
    // caller could have read off `ls` — it spends budget without answering the
    // question the map exists for. Header and first symbol are admitted
    // together, so no file in the map is ever a bare path.
    const opening = cost(headLine(file)) + (first ? cost(symbolLine(first)) : 0);
    if (spent + opening > body) break;
    spent += opening;
    admitted.push({ file, shown: first ? 1 : 0 });
  }

  // ── Pass 2: depth, round by round, so leftover budget deepens the map evenly
  // instead of pouring the remainder into whichever file happened to be first.
  let full = false;
  for (let round = 1; round < MAX_SYMBOLS_PER_FILE && !full; round++) {
    let progressed = false;
    for (const entry of admitted) {
      const symbol = entry.file.symbols[entry.shown];
      if (!symbol) continue;
      const c = cost(symbolLine(symbol));
      if (spent + c > body) { full = true; break; }
      spent += c;
      entry.shown++;
      progressed = true;
    }
    if (!progressed) break;
  }

  const lines: string[] = [];
  let symbolsShown = 0;
  for (const entry of admitted) {
    lines.push(headLine(entry.file));
    for (const symbol of entry.file.symbols.slice(0, entry.shown)) {
      lines.push(symbolLine(symbol));
      symbolsShown++;
    }
  }

  const hiddenFiles = result.files.length - admitted.length;
  const footer: string[] = [];
  if (hiddenFiles > 0) {
    footer.push(
      `(${admitted.length} of ${result.files.length} ranked files shown — raise \`budget\` for more)`,
    );
  }
  if (result.nodesCapped || result.edgesCapped) {
    // Not the same cut as the budget: this one happened before ranking, so the
    // files NOT shown include files never scored at all.
    footer.push(
      "(the index scan hit its cap, so the ranking saw only part of the graph — " +
      "the map is directional, not exhaustive)",
    );
  }
  if (!result.converged) {
    footer.push(
      `(ranking stopped at the ${result.iterations}-iteration cap before converging — ` +
      "order is approximate)",
    );
  }

  const text = [...lines, ...(footer.length ? ["", ...footer] : [])].join("\n");
  return { text, tokens: countTokens(text), filesShown: admitted.length, symbolsShown };
}

function headLine(file: MapFile): string {
  return `${file.filePath}  (${file.rank.toFixed(4)}${file.focusMatch ? ", focus" : ""})`;
}

function symbolLine(symbol: MapSymbol): string {
  const where = String(symbol.startLine).padStart(5);
  const what = symbol.signature
    ? collapse(symbol.signature)
    : `${symbol.kind} ${symbol.name}`;
  return `${where}  ${what}`;
}

function collapse(text: string): string {
  const one = String(text).replace(/\s+/g, " ").trim();
  return one.length > SIGNATURE_MAX ? `${one.slice(0, SIGNATURE_MAX - 1)}…` : one;
}
