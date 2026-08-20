/**
 * `ctx_pack` — one context package, assembled to a token budget.
 *
 * §3.7 of docs/plans/improvement-roadmap.md. The pieces already existed and
 * were already cheap; what was missing was the thing that composes them and
 * hands the result to somebody else:
 *
 *   1. the repo map — `src/graph/map.ts`, personalized PageRank over
 *      codegraph's tables, packed to a token budget;
 *   2. signatures and verbatim bodies — `symbols()`/`outline()` in
 *      `src/graph/queries.ts` plus `readSymbolBody()` in `src/graph/body.ts`;
 *   3. excerpts from the knowledge base — the same FTS5 pool `ctx_search`
 *      queries, reached through `ContentStore.searchWithFallbackMeta`.
 *
 * ## Why this is a prompt and not a report
 *
 * The output is written to be pasted into a subagent's context, so it names
 * what each section IS. A signature, a body and an excerpt are three different
 * epistemic objects — a declaration with the body withheld, verbatim source at
 * stated lines, and previously-captured text that may no longer be true — and a
 * receiving agent that cannot tell them apart will confidently act on a stale
 * excerpt as if it had read the file. Every block carries its kind in its
 * heading for exactly that reason.
 *
 * ## The budget split, and what happens to slack
 *
 * `budget` counts TOKENS, measured with {@link countTokens} — the same
 * estimator `ctx_stats` and the repo map report with, so a package that claims
 * 4 096 tokens and a stats line that claims 4 096 tokens mean the same thing
 * (docs/adr/0004).
 *
 * The frame (title, legend, section headings, closing notes) is reserved off
 * the top, because a frame discovered afterwards is a budget that fails at the
 * exact moment it was supposed to hold. What remains is split:
 *
 *   - {@link MAP_SHARE} 30% — orientation. Saturates fastest: past a few dozen
 *     files the map is adding leaves, not structure.
 *   - {@link SYMBOL_SHARE} 40% — the largest share, because signatures and
 *     bodies are the only section that answers "what code do I actually touch",
 *     and a body is the one thing the receiving agent cannot cheaply re-derive.
 *   - {@link CHUNK_SHARE} 30% — prior knowledge. Valuable but frequently
 *     absent (a fresh project has an empty knowledge base), which is precisely
 *     why it must not hold budget hostage.
 *
 * Slack flows FORWARD through those three in order, then WRAPS ONCE back to the
 * map. Concretely: whatever the map does not spend raises the symbol cap,
 * whatever the symbols do not spend raises the chunk cap, and whatever is still
 * unspent after the chunks re-renders the map at a larger budget. Nothing is
 * wasted, the wrap terminates after one round, and the map is the section
 * chosen to absorb the remainder because `renderRepoMap` degrades smoothly with
 * budget — more budget means more ranked files, never a half-printed one.
 *
 * A final enforcement pass measures the ASSEMBLED text — `countTokens` is an
 * estimator over a whole string, not a sum over its parts, so a running total
 * of per-block costs is close but not a proof — and drops content in value
 * order until it fits: an excerpt first (ctx_search can fetch it again), then a
 * body (ctx_graph can), then a signature line, and only then the map, which
 * shrinks by re-rendering at a lower budget so it never ends mid-signature.
 * That order is the promise the tool makes, and it is checked against the bytes
 * actually returned rather than against the running sum.
 *
 * ## Degrading honestly
 *
 * No codegraph index: sections 1 and 2 are absent and the notes say so and say
 * what to run. Empty knowledge base: section 3 is absent and the notes say the
 * package is structure only. Both: the package says it is empty rather than
 * returning a confident-looking frame around nothing. A package that quietly
 * omits half of itself is worse than no package, because the receiving agent
 * budgets its own work on the assumption that what it was handed is what
 * exists.
 *
 * ## Deduplication
 *
 * A symbol whose BODY is in section 2 must not reappear as an excerpt in
 * section 3 — the same bytes twice is the specific failure a token budget
 * exists to prevent. Signatures do not suppress excerpts: a declaration and a
 * captured passage about it are different information.
 *
 * ## Screening
 *
 * Bodies are source code read straight off disk and excerpts are captured
 * command output. Neither passes through `ContentStore.index()`, so neither
 * meets `redactSecrets` on its own — the same hole `src/tools/graph.ts`
 * documents for its passthrough branch. The assembled text is screened here,
 * unconditionally, before a byte is returned.
 */

import { z } from "zod";

import { readSymbolBody } from "../graph/body.js";
import {
  MISSING_INDEX_CONSEQUENCE,
  firstMissingIndexNotice,
  hasCodegraphIndex,
  normalizeProjectDir,
  notIndexedMessage,
  openGraphDb,
  type GraphDbHandle,
} from "../graph/db.js";
import { renderRepoMap, repoMap } from "../graph/map.js";
import { outline, symbols as qSymbols, type SymbolRow } from "../graph/queries.js";
import { redactOptionsFromEnv, redactSecrets } from "../session/redact.js";
import { countTokens } from "../session/tokenizer.js";
import type { ToolDeps, ToolResult } from "./shared/deps.js";

// ─────────────────────────────────────────────────────────
// Tuning
// ─────────────────────────────────────────────────────────

/** Default when the caller names no budget — roughly a page and a half. */
export const DEFAULT_PACK_BUDGET = 4_096;

/**
 * Floor on `budget`.
 *
 * Below this the frame alone (title, legend, three headings, notes) is most of
 * the package, so the answer would be a description of a package rather than
 * one. Stated as a schema minimum instead of silently under-delivering.
 */
export const MIN_PACK_BUDGET = 512;

/** Ceiling on `budget`. Past this the caller wants the files, not a package. */
export const MAX_PACK_BUDGET = 32_000;

/** Share of the packable budget for the repo map. See the module note. */
export const MAP_SHARE = 0.3;
/** Share for signatures and bodies — the largest, and the reason to call this. */
export const SYMBOL_SHARE = 0.4;
/**
 * Share for knowledge-base excerpts.
 *
 * Declared for the record and for tests; the code takes the REMAINDER after the
 * other two rather than multiplying by it, so the three floor divisions cannot
 * quietly lose a token or two of the caller's budget to rounding.
 */
export const CHUNK_SHARE = 0.3;

/**
 * Of the symbol section, the part spent on signature LINES before bodies start.
 *
 * Signatures are ~1% the cost of a body and give the receiving agent the shape
 * of the whole neighbourhood; bodies give it three functions. Both matter, and
 * a section that is all bodies is three functions with no map of what surrounds
 * them.
 */
export const SIGNATURE_SUBSHARE = 0.35;

/** Symbols considered before packing. Beyond this, FTS rank is noise. */
export const SYMBOL_CANDIDATES = 24;

/** Declarations pulled per file by the outline fallback. */
export const OUTLINE_LIMIT = 12;

/** Knowledge-base hits requested before dedup and packing. */
export const CHUNK_CANDIDATES = 12;

/** Characters of each excerpt kept — window-extracted around the task terms. */
export const CHUNK_SNIPPET_CHARS = 1_200;

/** Bytes a single body may cost, before the token check decides admission. */
export const BODY_MAX_BYTES = 6_000;

/** Tokens held back for the closing notes, which are written after packing. */
const NOTES_RESERVE_TOKENS = 200;

/** Longest signature rendered on one line. */
const SIGNATURE_MAX = 160;

/** Guard on the final trim loop, so a pathological input cannot spin. */
const MAX_TRIM_STEPS = 200;

/** `CONTEXT_MODE_PACK=0` removes the tool from the surface entirely. */
export function packToolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CONTEXT_MODE_PACK !== "0";
}

// ─────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────

/** One knowledge-base passage, already snippet-extracted by the caller. */
export interface PackChunk {
  title: string;
  /** Indexed source label, so the receiving agent can search for more of it. */
  source: string;
  text: string;
}

export interface PackInput {
  /** What the receiving agent is being asked to do. Steers every section. */
  task: string;
  budget: number;
  projectDir: string;
  /** Read-only handle, or `null` when this project has no codegraph index. */
  handle: GraphDbHandle | null;
  /** Ranked excerpts for the task, best first. Empty is a valid input. */
  chunks: PackChunk[];
  /**
   * Chunks in the knowledge base overall.
   *
   * Distinct from `chunks.length`: zero here means the knowledge base is EMPTY,
   * which the notes say out loud, while zero results against a non-empty base
   * means the task simply matched nothing. Conflating the two would tell a user
   * to go index things they already indexed.
   */
  chunkCount: number;
  env?: NodeJS.ProcessEnv;
}

export interface PackResult {
  /** The package. Already screened for credentials. */
  text: string;
  /** What it costs, by the repo's estimator. Always `<= budget`. */
  tokens: number;
  budget: number;
  mapTokens: number;
  symbolTokens: number;
  chunkTokens: number;
  filesMapped: number;
  signaturesShown: number;
  bodiesShown: number;
  chunksShown: number;
  /** Excerpts dropped because a body in section 2 already carried the text. */
  chunksSuppressed: number;
  /** One line per part that could not be built, in the order they are printed. */
  degraded: string[];
}

// ─────────────────────────────────────────────────────────
// Rendering helpers
// ─────────────────────────────────────────────────────────

const HEAD_MAP = "## 1. REPO MAP — ranked files, each with its most important signatures";
const HEAD_SYMBOLS = "## 2. SYMBOLS — signatures first, then verbatim bodies";
const HEAD_CHUNKS = "## 3. EXCERPTS — passages already captured in this project's knowledge base";
const HEAD_NOTES = "## NOTES — what this package contains, and what it does not";

function collapse(text: string): string {
  const one = String(text).replace(/\s+/g, " ").trim();
  return one.length > SIGNATURE_MAX ? `${one.slice(0, SIGNATURE_MAX - 1)}…` : one;
}

/** Whitespace-insensitive form, so dedup is not defeated by re-indentation. */
function normalize(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function preamble(task: string, budget: number): string {
  return [
    "# Context package",
    "",
    `TASK: ${task}`,
    "",
    `Assembled by ctx_pack to a ${budget}-token budget. Three kinds of content appear`,
    "below and they are NOT interchangeable:",
    "",
    "  - SIGNATURE — a declaration only. The body was not included; ask for it with",
    "    ctx_graph(action: \"body\", symbol: \"…\") if you need it.",
    "  - BODY — verbatim source, sliced from the file at the line range stated in the",
    "    heading.",
    "  - EXCERPT — text captured earlier (command output, fetched docs, session",
    "    memory). It was true when it was captured; it is not re-read here.",
    "",
    "Everything is ranked for the task above. Nothing here is exhaustive.",
  ].join("\n");
}

function signatureLine(row: SymbolRow): string {
  const where = `${row.filePath}:${row.startLine}`;
  const what = row.signature ? collapse(row.signature) : `${row.kind} ${row.name}`;
  return `SIGNATURE  ${row.qualifiedName}  ${where}\n  ${what}`;
}

// ─────────────────────────────────────────────────────────
// Packing
// ─────────────────────────────────────────────────────────

/**
 * Candidate symbols for the task, best first.
 *
 * FTS over the task text first — that is what makes the section about the task
 * rather than about the repository. When the task's words appear in no symbol
 * name (a plausible case: "make the retry logic testable" against a codebase
 * that spells it `Backoff`), fall back to walking the outlines of the
 * top-ranked map files. The fallback is worth having because those files were
 * already chosen by a ranking that DID see the task, through personalization.
 */
function candidateSymbols(
  handle: GraphDbHandle,
  task: string,
  mapFiles: string[],
): SymbolRow[] {
  const seen = new Set<string>();
  const out: SymbolRow[] = [];

  for (const row of qSymbols(handle, { query: task, limit: SYMBOL_CANDIDATES })) {
    // `import` and `file` nodes are bookkeeping — a signature line for an
    // import spends budget to say something the map already showed.
    if (row.kind === "import" || row.kind === "file") continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  if (out.length > 0) return out;

  for (const file of mapFiles) {
    for (const row of outline(handle, { filePath: file, limit: OUTLINE_LIMIT })) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(row);
      if (out.length >= SYMBOL_CANDIDATES) return out;
    }
  }
  return out;
}

interface BodyRecord {
  /** Normalized body text, kept so section 3 can suppress a repeat of it. */
  norm: string;
  filePath: string;
  name: string;
}

interface SymbolSection {
  /** One line pair per signature, kept apart so the trim pass can drop one. */
  signatureLines: string[];
  bodyBlocks: string[];
  spent: number;
  signatures: number;
  bodies: number;
  included: BodyRecord[];
}

/**
 * Signature lines up to {@link SIGNATURE_SUBSHARE} of the cap, then bodies.
 *
 * Whole blocks only, in both passes. A body cut at the budget boundary reads as
 * a function that returns nothing, and the reader cannot tell truncation from
 * the real thing — the same reason `renderRepoMap` admits whole lines.
 *
 * The body loop CONTINUES past a block that does not fit instead of stopping:
 * candidates are ranked by relevance, not by size, and a 400-line class ahead
 * of three 12-line functions should not cost the section everything behind it.
 */
function packSymbols(
  handle: GraphDbHandle,
  candidates: SymbolRow[],
  cap: number,
  env: NodeJS.ProcessEnv,
): SymbolSection {
  const out: SymbolSection = {
    signatureLines: [], bodyBlocks: [], spent: 0, signatures: 0, bodies: 0, included: [],
  };
  if (cap <= 0 || candidates.length === 0) return out;

  const signatureCap = Math.floor(cap * SIGNATURE_SUBSHARE);
  const listed: SymbolRow[] = [];
  for (const row of candidates) {
    const line = signatureLine(row);
    const c = countTokens(`${line}\n`);
    if (out.spent + c > signatureCap) break;
    out.spent += c;
    out.signatureLines.push(line);
    listed.push(row);
    out.signatures++;
  }

  for (const row of listed.length > 0 ? listed : candidates) {
    if (out.spent >= cap) break;
    const body = readSymbolBody(handle, row, { maxBytes: BODY_MAX_BYTES, env });
    // An unreadable file is not a failure of the package — the signature above
    // still stands. Skip silently rather than printing an error the receiving
    // agent can do nothing about.
    if (body.error || !body.text.trim()) continue;

    const notes: string[] = [];
    if (body.truncated) notes.push("truncated at the body budget");
    // Staleness is the one caveat that changes what the agent should DO with
    // the lines, so it is never left implicit.
    if (body.stale === true) notes.push("index is stale for this file — lines may have moved");
    else if (body.stale === null) notes.push("staleness unknown — this file has no index row");
    const suffix = notes.length > 0 ? `  (${notes.join("; ")})` : "";

    const block =
      `BODY  ${row.qualifiedName}  ${body.filePath}:${body.startLine}-${body.lastLine}${suffix}\n` +
      "```\n" + body.text + "\n```";
    const c = countTokens(`${block}\n`);
    if (out.spent + c > cap) continue;
    out.spent += c;
    out.bodyBlocks.push(block);
    out.bodies++;
    out.included.push({ norm: normalize(body.text), filePath: body.filePath, name: row.name });
  }

  return out;
}

/**
 * True when this excerpt is already in the package as a body.
 *
 * Two directions, because either can be the larger text: a chunk that is a
 * slice of the body, and a chunk the body sits inside (a captured file dump).
 * The 60-character floor keeps a one-line excerpt from matching by coincidence,
 * and the 200-character probe keeps the containment test cheap on long bodies.
 */
function duplicatesBody(chunk: PackChunk, bodies: BodyRecord[]): boolean {
  const norm = normalize(chunk.text);
  if (norm.length < 60) return false;
  const probe = norm.slice(0, 200);
  for (const body of bodies) {
    if (body.norm.length < 60) continue;
    if (body.norm.includes(probe)) return true;
    if (norm.includes(body.norm)) return true;
    // Title-level match: a chunk titled after the exact file and symbol whose
    // source is printed above adds a header and nothing else.
    const title = chunk.title ?? "";
    if (title.includes(body.filePath) && title.includes(body.name)) return true;
  }
  return false;
}

interface ChunkSection {
  blocks: string[];
  spent: number;
  shown: number;
  suppressed: number;
}

function packChunks(chunks: PackChunk[], cap: number, bodies: BodyRecord[]): ChunkSection {
  const out: ChunkSection = { blocks: [], spent: 0, shown: 0, suppressed: 0 };
  if (cap <= 0) return out;

  for (const chunk of chunks) {
    if (duplicatesBody(chunk, bodies)) {
      out.suppressed++;
      continue;
    }
    const block =
      `EXCERPT  ${chunk.title}  [source: ${chunk.source}]\n${chunk.text.trim()}`;
    const c = countTokens(`${block}\n`);
    // Same reason as the body loop: relevance order is not size order.
    if (out.spent + c > cap) continue;
    out.spent += c;
    out.blocks.push(block);
    out.shown++;
  }
  return out;
}

// ─────────────────────────────────────────────────────────
// Assembly
// ─────────────────────────────────────────────────────────

/**
 * Build the package.
 *
 * Pure with respect to the MCP layer: it takes an already-opened graph handle
 * (or `null`) and already-retrieved chunks, so the whole budget contract is
 * testable without a server, a store, or a network.
 */
export function buildPack(input: PackInput): PackResult {
  const env = input.env ?? process.env;
  const task = String(input.task ?? "").trim();
  const budget = Math.min(
    MAX_PACK_BUDGET,
    Math.max(MIN_PACK_BUDGET, Math.floor(input.budget) || DEFAULT_PACK_BUDGET),
  );

  const degraded: string[] = [];
  const head = preamble(task, budget);

  // Reserved off the top — see the module note on why a frame discovered
  // afterwards is not a budget.
  const frame =
    countTokens(head) +
    countTokens(HEAD_MAP) +
    countTokens(HEAD_SYMBOLS) +
    countTokens(HEAD_CHUNKS) +
    countTokens(HEAD_NOTES) +
    NOTES_RESERVE_TOKENS;
  const packable = Math.max(1, budget - frame);

  const mapCap = Math.floor(packable * MAP_SHARE);
  const symbolCap = Math.floor(packable * SYMBOL_SHARE);
  const chunkCap = packable - mapCap - symbolCap;

  // ── Section 1 + 2: both need the index, and both drop out together when it
  // is missing. Reported as one degradation line, because "run codegraph init"
  // is one instruction, not two.
  let mapText = "";
  let mapTokens = 0;
  let filesMapped = 0;
  let mapFiles: string[] = [];
  let ranked = 0;
  // Kept so the wrap round and the trim pass can re-render at another budget
  // without paying for PageRank again — the ranking does not depend on budget.
  let mapResult: ReturnType<typeof repoMap> | null = null;
  let symbolSection: SymbolSection = {
    signatureLines: [], bodyBlocks: [], spent: 0, signatures: 0, bodies: 0, included: [],
  };
  let carry = 0;

  const handle = input.handle;
  if (!handle) {
    degraded.push(
      `No codegraph index for ${input.projectDir}, so sections 1 (repo map) and 2 (symbols) ` +
      "are absent — this package carries knowledge-base excerpts only. " +
      `Run \`codegraph init ${input.projectDir}\` once to get the structural half.`,
    );
    carry += mapCap + symbolCap;
  } else {
    const result = repoMap(handle, { focus: task });
    ranked = result.totalFiles;
    if (ranked === 0) {
      degraded.push(
        "The codegraph index holds no declarations, so sections 1 and 2 are empty. " +
        "The index exists but is empty — re-run `codegraph init`.",
      );
      carry += mapCap + symbolCap;
    } else {
      mapResult = result;
      const rendered = renderRepoMap(result, { budget: mapCap });
      mapText = rendered.text;
      mapTokens = rendered.tokens;
      filesMapped = rendered.filesShown;
      mapFiles = result.files.slice(0, 8).map(f => f.filePath);
      carry += Math.max(0, mapCap - mapTokens);

      const candidates = candidateSymbols(handle, task, mapFiles);
      if (candidates.length === 0) {
        degraded.push(
          `No indexed symbol matches "${task}", so section 2 is empty. ` +
          "The map above is still ranked for the task.",
        );
      }
      symbolSection = packSymbols(handle, candidates, symbolCap + carry, env);
      carry = Math.max(0, symbolCap + carry - symbolSection.spent);
    }
  }

  // ── Section 3.
  if (input.chunkCount === 0) {
    degraded.push(
      "The knowledge base for this project is empty, so section 3 is absent — " +
      "nothing has been indexed here yet. This package is structure only, not prior " +
      "knowledge. Capture some with ctx_batch_execute(commands, queries) and pack again.",
    );
  } else if (input.chunks.length === 0) {
    degraded.push(
      `The knowledge base holds content but nothing in it matches "${task}", ` +
      "so section 3 is empty. That is a miss, not an empty index.",
    );
  }
  const chunkSection = packChunks(input.chunks, chunkCap + carry, symbolSection.included);
  carry = Math.max(0, chunkCap + carry - chunkSection.spent);

  // ── The wrap. Whatever survived all three re-renders the map at a larger
  // budget: it is the only section whose extra tokens are guaranteed to buy
  // more ranked files rather than a partial block, and it terminates here —
  // one round, no loop.
  if (carry > 0 && mapResult && ranked > filesMapped && mapTokens > 0) {
    const wider = renderRepoMap(mapResult, { budget: mapTokens + carry });
    mapText = wider.text;
    mapTokens = wider.tokens;
    filesMapped = wider.filesShown;
  }

  // ── Notes. Written last because they describe what packing actually did.
  const notes: string[] = [...degraded];
  if (chunkSection.suppressed > 0) {
    notes.push(
      `${chunkSection.suppressed} knowledge-base excerpt(s) were dropped because their text ` +
      "is already printed above as a symbol body — the same bytes twice is what the budget exists to prevent.",
    );
  }
  notes.push(
    `Budget ${budget} tokens. Map ${mapTokens}, symbols ${symbolSection.spent} ` +
    `(${symbolSection.signatures} signature(s), ${symbolSection.bodies} body/bodies), ` +
    `excerpts ${chunkSection.spent} (${chunkSection.shown} shown). ` +
    "Unspent budget in one section was given to the others, not discarded.",
  );
  notes.push(
    "This is a ranked selection, not the whole repository. Widen it from inside the task with " +
    "ctx_graph (structure), ctx_find (where something lives) or ctx_search (what was already captured).",
  );

  // ── Assembly. A section heading is a claim that content follows it, so each
  // one is emitted only while its list is non-empty — including after the trim
  // pass below has emptied it.
  const assemble = (): string => {
    const parts: string[] = [head];
    if (mapText) parts.push(HEAD_MAP, mapText);
    if (symbolSection.signatureLines.length > 0 || symbolSection.bodyBlocks.length > 0) {
      parts.push(HEAD_SYMBOLS);
      if (symbolSection.signatureLines.length > 0) {
        parts.push(symbolSection.signatureLines.join("\n"));
      }
      parts.push(...symbolSection.bodyBlocks);
    }
    if (chunkSection.blocks.length > 0) parts.push(HEAD_CHUNKS, ...chunkSection.blocks);
    parts.push(HEAD_NOTES, notes.map(n => `- ${n}`).join("\n"));
    return parts.join("\n\n");
  };

  // ── Enforcement. Per-block accounting sums each block measured on its own,
  // and {@link countTokens} is an estimator over the whole string, not a sum
  // over its parts — so the assembled text can cost a little more than the
  // running total said. The budget is the one promise this tool makes, so it is
  // checked against the bytes actually returned.
  //
  // Trim order is value order, cheapest to lose first: an excerpt (re-fetchable
  // with ctx_search), then a body (re-fetchable with ctx_graph), then a
  // signature line, and only then the map — which shrinks by re-rendering at a
  // lower budget rather than by losing lines, so it never ends mid-signature.
  let text = assemble();
  let tokens = countTokens(text);
  let trimmed = 0;
  for (let step = 0; step < MAX_TRIM_STEPS && tokens > budget; step++) {
    if (chunkSection.blocks.length > 0) {
      chunkSection.blocks.pop();
      chunkSection.shown = Math.max(0, chunkSection.shown - 1);
    } else if (symbolSection.bodyBlocks.length > 0) {
      symbolSection.bodyBlocks.pop();
      symbolSection.bodies = Math.max(0, symbolSection.bodies - 1);
    } else if (symbolSection.signatureLines.length > 0) {
      symbolSection.signatureLines.pop();
      symbolSection.signatures = Math.max(0, symbolSection.signatures - 1);
    } else if (mapResult && mapTokens > 0) {
      const target = Math.max(0, Math.floor(mapTokens * 0.8) - 1);
      if (target === 0) {
        mapText = "";
        mapTokens = 0;
        filesMapped = 0;
      } else {
        const smaller = renderRepoMap(mapResult, { budget: target });
        mapText = smaller.text;
        mapTokens = smaller.tokens;
        filesMapped = smaller.filesShown;
      }
    } else {
      // Only the frame is left. Reported by the returned `tokens`, which the
      // caller can compare against the budget it asked for.
      break;
    }
    trimmed++;
    if (trimmed === 1) {
      notes.push("Trailing blocks were dropped so the assembled package fits the stated budget.");
    }
    text = assemble();
    tokens = countTokens(text);
  }

  return {
    text: redactSecrets(text, redactOptionsFromEnv(env)).text,
    tokens,
    budget,
    mapTokens,
    symbolTokens: symbolSection.spent,
    chunkTokens: chunkSection.spent,
    filesMapped,
    signaturesShown: symbolSection.signatures,
    bodiesShown: symbolSection.bodies,
    chunksShown: chunkSection.shown,
    chunksSuppressed: chunkSection.suppressed,
    degraded,
  };
}

// ─────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

/** Register `ctx_pack` on the server carried by `deps`. */
export function registerCtxPack(deps: ToolDeps): void {
  if (!packToolEnabled()) return;

  const { getStore, getProjectDir, trackResponse, extractSnippet } = deps;

  deps.server.registerTool(
    "ctx_pack",
    {
      title: "Context Package",
      // Reads the codegraph index and the FTS5 store; writes nothing.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description: `Assemble one hand-off package for a task — repo map, symbols, knowledge-base excerpts — under a token budget.

  Composed into a prompt a subagent can be handed as-is: the personalized-PageRank repo map, the symbols the task matches (signatures, then verbatim bodies at stated line ranges), and passages already captured in this project's knowledge base. Every block is labelled SIGNATURE, BODY or EXCERPT, so a declaration is never mistaken for source or for a stale capture.

  WHEN:
    - You are delegating and want the subagent to start informed instead of re-discovering the codebase
    - You want "what shape is this, what code is involved, what do we already know" answered in one call under a fixed token cost
    - You are opening an unfamiliar area and want orientation plus the relevant source together

  WHEN NOT:
    - You want one specific answer — ctx_find for where it lives, ctx_graph for how it connects, ctx_search for what was captured
    - You are about to edit a file — Read it, because Edit matches the exact bytes in your conversation
    - You want one symbol's source and nothing else — ctx_graph(action: "body")

  RETURNS:
    A labelled prompt under \`budget\` tokens, closing with a NOTES block stating what was included, what was trimmed, and what is absent — no codegraph index drops the map and symbols, an empty knowledge base drops the excerpts, and the notes say which.

  EXAMPLE: ctx_pack(task: "make the retry budget configurable per host", budget: 4096)`,
      inputSchema: z.object({
        task: z
          .string()
          .describe("What the receiving agent is being asked to do. Steers every section."),
        budget: z
          .number()
          .int()
          .min(MIN_PACK_BUDGET)
          .max(MAX_PACK_BUDGET)
          .optional()
          .describe(`Token budget for the whole package (default ${DEFAULT_PACK_BUDGET}).`),
        project: z
          .string()
          .optional()
          .describe("Project root to pack. Defaults to the current project."),
      }),
    },
    async (params) => {
      try {
        const p = params as { task?: string; budget?: number; project?: string };
        const task = String(p.task ?? "").trim();
        if (!task) {
          return trackResponse("ctx_pack", textResult("ctx_pack needs a `task`.", true));
        }
        const projectDir = normalizeProjectDir(p.project || getProjectDir());

        // The knowledge base half, which works with or without the index.
        const store = getStore();
        const chunkCount = store.getStats().chunks;
        const chunks: PackChunk[] = [];
        if (chunkCount > 0) {
          const found = store.searchWithFallbackMeta(task, CHUNK_CANDIDATES);
          for (const r of found.results) {
            chunks.push({
              title: r.title,
              source: r.source,
              text: extractSnippet(r.content, task, CHUNK_SNIPPET_CHARS, r.highlighted),
            });
          }
        }

        // The structural half. A missing index is a degradation, not an error:
        // the package still has a section 3, and saying "no index" while
        // refusing to return what IS available would waste the round trip.
        let handle: GraphDbHandle | null = null;
        const prelude: string[] = [];
        if (hasCodegraphIndex(projectDir)) {
          const opened = openGraphDb(projectDir);
          if (opened.ok) handle = opened.handle;
          else prelude.push(opened.message);
        } else if (firstMissingIndexNotice(projectDir)) {
          prelude.push(`${notIndexedMessage(projectDir)}\n\n${MISSING_INDEX_CONSEQUENCE}`);
        }

        try {
          const packed = buildPack({ task, budget: p.budget ?? DEFAULT_PACK_BUDGET, projectDir, handle, chunks, chunkCount });
          // The prelude sits ABOVE the package rather than inside it: it is
          // addressed to the caller assembling the hand-off, not to the agent
          // receiving it, and it must not be pasted onward as if it were context.
          const body = prelude.length > 0
            ? `${prelude.join("\n\n")}\n\n---\n\n${packed.text}`
            : packed.text;
          return trackResponse("ctx_pack", textResult(body));
        } finally {
          handle?.close();
        }
      } catch (err) {
        return trackResponse(
          "ctx_pack",
          textResult(`ctx_pack failed: ${err instanceof Error ? err.message : String(err)}`, true),
        );
      }
    },
  );
}
