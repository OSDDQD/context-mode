#!/usr/bin/env node
/**
 * Retrieval quality of the search stack, measured against a fixed corpus.
 *
 * `tests/fixtures/relevance-corpus.json` holds 40 competing documents and a
 * labelled query set. Every query is answered twice over the same throwaway
 * store — once through the lexical path alone (`searchWithFallback`, what
 * `npm test` gates on), once through the hybrid path the server actually runs
 * (`hybridSearch` re-fusing the lexical top-5 with semantic candidates) — and
 * the two are reported side by side as precision@1, recall@5 and MRR@5.
 *
 * The split is the point. Two of the eight query classes — `paraphrase` and
 * `cross-lingual` — are written so lexical search cannot win them: they share
 * no term with the document that answers them. Their score is the headroom the
 * semantic path has to earn, and the aggregate hides it, so the per-class table
 * is the part worth reading.
 *
 * Nothing here touches the user's knowledge base: the corpus is indexed into a
 * fresh DB under the OS temp directory and removed afterwards. The lexical arm
 * therefore reproduces exactly; the hybrid arm depends on the embedding model
 * behind CONTEXT_MODE_EMBEDDINGS_URL and is not gated in CI for that reason.
 *
 * By default it only prints, like the measurement scripts next to it. Writing
 * the research note is an explicit act: `--report`, or `--report <path>`.
 *
 * Usage:
 *   node scripts/measure-retrieval.mjs [--lexical-only] [--json]
 *                                      [--report [path]] [--force]
 *                                      [--write-baseline]
 *
 * Requires a build: `npm run build`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_LIMIT, byClass, misses, score } from "./lib/retrieval-metrics.mjs";
import { checkReportOverwrite } from "./lib/report-guard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");

/**
 * `--report` on its own means the default path; `--report <path>` means that
 * path. The value is only a path when it does not look like the next flag.
 */
function reportFlag() {
  const i = process.argv.indexOf("--report");
  if (i === -1) return null;
  const next = process.argv[i + 1];
  return { path: next && !next.startsWith("--") ? next : undefined };
}

const asJson = process.argv.includes("--json");
const lexicalOnly = process.argv.includes("--lexical-only");
const writeBaseline = process.argv.includes("--write-baseline");
const force = process.argv.includes("--force");
const report = reportFlag();
const LIMIT = DEFAULT_LIMIT;

let ContentStore, hybridSearch, backfillVectorsUntil, vectorCoverage, resolveEmbeddingConfigAsync;
try {
  ({ ContentStore } = await import("../build/store.js"));
  ({ hybridSearch, backfillVectorsUntil, vectorCoverage } = await import("../build/search/hybrid.js"));
  ({ resolveEmbeddingConfigAsync } = await import("../build/search/embeddings.js"));
} catch (err) {
  console.error(`Cannot load build/: ${err.message}\nRun \`npm run build\` first.`);
  process.exit(1);
}

const corpusPath = join(repo, "tests/fixtures/relevance-corpus.json");
const corpus = JSON.parse(readFileSync(corpusPath, "utf-8"));

/** Local calendar date — the report is filed by the day it was run, not by UTC. */
function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ─────────────────────────────────────────────────────────
// Arms
// ─────────────────────────────────────────────────────────

const work = mkdtempSync(join(tmpdir(), "ctx-retrieval-"));
let summary;
try {
  const store = new ContentStore(join(work, "content.db"));
  for (const doc of corpus.documents) store.index({ content: doc.markdown, source: doc.source });

  const lexicalRows = corpus.queries.map((qq) => ({
    id: qq.id,
    cls: qq.cls,
    relevant: qq.relevant,
    sources: store.searchWithFallback(qq.query, LIMIT).map((r) => r.source),
  }));

  // The hybrid arm mirrors src/tools/search.ts: the lexical top-5 is handed to
  // hybridSearch, which fuses it with the semantic candidates. Backfill is
  // disabled per call — every chunk is embedded up front instead, so the
  // measurement is of a warm index rather than of a race with its own warmup.
  let hybridRows = null;
  let embedding = null;
  if (!lexicalOnly) {
    const config = await resolveEmbeddingConfigAsync();
    if (config) {
      const db = store.rawDb();
      const embedded = await backfillVectorsUntil(db, config, { deadlineMs: 600_000, maxChunks: 5000 });
      const coverage = vectorCoverage(db);
      embedding = {
        model: config.model,
        url: config.url,
        chunks: coverage.chunks,
        vectors: coverage.vectors,
        embedded,
      };
      hybridRows = [];
      for (const qq of corpus.queries) {
        const lexical = store.searchWithFallback(qq.query, LIMIT);
        const fused = await hybridSearch({
          db, query: qq.query, lexical, limit: LIMIT, config, backfillBatch: 0,
        });
        hybridRows.push({ id: qq.id, cls: qq.cls, relevant: qq.relevant, sources: fused.map((r) => r.source) });
      }
    }
  }

  summary = {
    measuredAt: today(),
    corpus: {
      path: "tests/fixtures/relevance-corpus.json",
      documents: corpus.documents.length,
      queries: corpus.queries.length,
      limit: LIMIT,
    },
    embedding,
    lexical: { ...score(lexicalRows), byClass: byClass(lexicalRows) },
    hybrid: hybridRows ? { ...score(hybridRows), byClass: byClass(hybridRows) } : null,
    lexicalMisses: misses(lexicalRows),
  };

  store.cleanup();
} finally {
  rmSync(work, { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────

const pct = (x) => `${(x * 100).toFixed(1)}%`;

function metricTable(lex, hyb) {
  const lines = [
    "| metric | lexical | hybrid |",
    "|---|---|---|",
    `| precision@1 | ${pct(lex.precisionAt1)} | ${hyb ? pct(hyb.precisionAt1) : "—"} |`,
    `| recall@5 | ${pct(lex.recallAt5)} | ${hyb ? pct(hyb.recallAt5) : "—"} |`,
    `| MRR@5 | ${lex.mrr.toFixed(3)} | ${hyb ? hyb.mrr.toFixed(3) : "—"} |`,
  ];
  return lines.join("\n");
}

function classTable(lex, hyb) {
  const lines = [
    "| class | n | lexical P@1 | hybrid P@1 | lexical MRR | hybrid MRR |",
    "|---|---|---|---|---|---|",
  ];
  for (const [cls, s] of Object.entries(lex.byClass)) {
    const h = hyb?.byClass?.[cls];
    lines.push(
      `| ${cls} | ${s.queries} | ${pct(s.precisionAt1)} | ${h ? pct(h.precisionAt1) : "—"} ` +
      `| ${s.mrr.toFixed(3)} | ${h ? h.mrr.toFixed(3) : "—"} |`,
    );
  }
  return lines.join("\n");
}

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`corpus: ${summary.corpus.documents} documents, ${summary.corpus.queries} queries, top-${LIMIT}`);
  console.log(summary.embedding
    ? `embeddings: ${summary.embedding.model} — ${summary.embedding.vectors}/${summary.embedding.chunks} chunks vectorised\n`
    : `embeddings: off (${lexicalOnly ? "--lexical-only" : "no endpoint configured"}) — hybrid arm skipped\n`);
  console.log(metricTable(summary.lexical, summary.hybrid));
  console.log();
  console.log(classTable(summary.lexical, summary.hybrid));
  if (summary.lexicalMisses.length > 0) {
    console.log(`\nlexical found nothing relevant in top ${LIMIT} for ${summary.lexicalMisses.length} queries:`);
    console.log(`  ${summary.lexicalMisses.join(", ")}`);
  }
}

if (writeBaseline) {
  const baselinePath = join(repo, "tests/fixtures/retrieval-baseline.json");
  const previous = (() => {
    try { return JSON.parse(readFileSync(baselinePath, "utf-8")); } catch { return {}; }
  })();
  const baseline = {
    note: [
      "Lexical retrieval baseline for the gate in tests/core/search.test.ts.",
      "Regenerate with `node scripts/measure-retrieval.mjs --write-baseline`.",
      "Only the lexical arm is recorded: it is deterministic given the corpus,",
      "while the hybrid arm needs a live embedding endpoint and is measured by",
      "the script alone.",
    ].join(" "),
    measuredAt: summary.measuredAt,
    harness: "node scripts/measure-retrieval.mjs --write-baseline",
    corpus: summary.corpus,
    // Three points ≈ two of the 74 queries. The lexical arm is deterministic,
    // so anything wider stops being a gate; anything narrower fails on a
    // deliberate tuning change that trades one ranking for another.
    tolerance: previous.tolerance ?? 0.03,
    lexical: {
      queries: summary.lexical.queries,
      precisionAt1: summary.lexical.precisionAt1,
      recallAt5: summary.lexical.recallAt5,
      mrr: summary.lexical.mrr,
      // Queries with nothing relevant anywhere in the top-5. Recorded as a
      // count rather than derived from recall, so a query that later gains a
      // second relevant document does not move the gate on its own.
      missesAt5: summary.lexicalMisses.length,
    },
    lexicalByClass: summary.lexical.byClass,
  };
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
  if (!asJson) console.log(`\nbaseline written: tests/fixtures/retrieval-baseline.json`);
}

if (report) {
  const reportPath = report.path ?? join(repo, "docs/research", `retrieval-${summary.measuredAt}.md`);

  // What this run can claim, checked against what the file already claims.
  // Read from disk, never from the environment: whoever overwrites may be
  // configured differently from whoever wrote, which is the case that lost the
  // hybrid column in the first place.
  const arms = { lexical: true, hybrid: summary.hybrid !== null };
  const existing = existsSync(reportPath) ? readFileSync(reportPath, "utf-8") : null;
  const verdict = checkReportOverwrite({ existing, arms, force });
  if (!verdict.ok) {
    console.error(`\n${reportPath}\n${verdict.reason}`);
    process.exit(1);
  }
  if (verdict.forced && !asJson) {
    console.log(`\n--force: overwriting a report that measured the ${verdict.forced.join(" and ")} arm`);
  }

  const { lexical: lex, hybrid: hyb } = summary;
  const baselineTolerance = (() => {
    try {
      return JSON.parse(readFileSync(join(repo, "tests/fixtures/retrieval-baseline.json"), "utf-8")).tolerance;
    } catch {
      return 0.03;
    }
  })();
  const body = `# Retrieval quality — measured baseline

**Date:** ${summary.measuredAt}
**Harness:** \`node scripts/measure-retrieval.mjs --report\`
**Subject:** \`ContentStore.searchWithFallback\` (lexical) vs \`hybridSearch\` (lexical + semantic)

## Question

How good is retrieval, in numbers, and how much of the gap is the semantic path
actually closing? The suite asserted individual rankings; it never said what
fraction of a query set is answered correctly, so a change could trade five wins
for four losses and no test would notice.

## Method

${summary.corpus.documents} documents from \`${summary.corpus.path}\` are indexed
into one throwaway store, so every query competes against the whole corpus.
${summary.corpus.queries} labelled queries are then answered twice at top-${LIMIT}:

- **lexical** — \`searchWithFallback\`, the RRF-over-FTS5 cascade on its own;
- **hybrid** — the lexical top-${LIMIT} handed to \`hybridSearch\`, exactly as
  \`src/tools/search.ts\` does it, re-fused with semantic candidates.

Metrics are macro-averaged over queries: precision@1 counts queries whose first
result is relevant, recall@5 is the share of a query's relevant documents found
in the top ${LIMIT}, MRR@5 is the mean reciprocal rank of the first relevant hit.

Two of the eight query classes exist to be lost by lexical search:
\`paraphrase\` states the intent in words the document never uses, and
\`cross-lingual\` asks in Russian about English documents. They are the semantic
path's headroom, and they drag the lexical aggregate down on purpose.

${summary.embedding
  ? `The hybrid arm ran against \`${summary.embedding.model}\` on \`${summary.embedding.url}\`, with all ${summary.embedding.chunks} chunks embedded before measuring rather than backfilled during it.`
  : "The hybrid arm did not run: no embedding endpoint was configured."}

## Result

${metricTable(lex, hyb)}

${classTable(lex, hyb)}

${summary.lexicalMisses.length > 0
  ? `Lexical search returns nothing relevant at all in the top ${LIMIT} for ${summary.lexicalMisses.length} of ${summary.corpus.queries} queries:\n\n\`${summary.lexicalMisses.join("`, `")}\`\n`
  : `Lexical search finds something relevant in the top ${LIMIT} for every query.\n`}

## The gate

\`npm test\` gates the lexical arm only, in
\`tests/core/search.test.ts\`, against \`tests/fixtures/retrieval-baseline.json\`
minus a tolerance of **${baselineTolerance}** — on all three aggregate metrics,
on per-class precision@1, and on the number of queries answered by nothing
relevant at all.

Three points is roughly two of the ${summary.corpus.queries} queries. The
lexical arm is deterministic — same corpus, same index order, same ranking, run
after run — so the tolerance is not there to absorb noise; it is there so a
deliberate tuning change that trades one ranking for another does not have to be
accompanied by a baseline rewrite. Anything wider stops being a gate: a real
regression (a search layer dropping out, a weight inverted) moves these numbers
by tens of points, not by two queries.

The hybrid arm stays out of CI: it needs a live embedding endpoint, and a gate
that fails when a model is unreachable is worse than no gate at all.

## What is not measured here

Snippet quality — whether the returned window contains the answer — is asserted
case by case in \`tests/core/search.test.ts\`, not scored. Latency is not
measured; the corpus is far too small for it to mean anything.
`;
  writeFileSync(reportPath, body);
  if (!asJson) console.log(`report written: ${reportPath}`);
}
