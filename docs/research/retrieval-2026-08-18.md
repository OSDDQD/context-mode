# Retrieval quality — measured baseline

**Date:** 2026-08-18
**Harness:** `node scripts/measure-retrieval.mjs --report`
**Subject:** `ContentStore.searchWithFallback` (lexical) vs `hybridSearch` (lexical + semantic)

## Question

How good is retrieval, in numbers, and how much of the gap is the semantic path
actually closing? The suite asserted individual rankings; it never said what
fraction of a query set is answered correctly, so a change could trade five wins
for four losses and no test would notice.

## Method

40 documents from `tests/fixtures/relevance-corpus.json` are indexed
into one throwaway store, so every query competes against the whole corpus.
74 labelled queries are then answered twice at top-5:

- **lexical** — `searchWithFallback`, the RRF-over-FTS5 cascade on its own;
- **hybrid** — the lexical top-5 handed to `hybridSearch`, exactly as
  `src/tools/search.ts` does it, re-fused with semantic candidates.

Metrics are macro-averaged over queries: precision@1 counts queries whose first
result is relevant, recall@5 is the share of a query's relevant documents found
in the top 5, MRR@5 is the mean reciprocal rank of the first relevant hit.

Two of the eight query classes exist to be lost by lexical search:
`paraphrase` states the intent in words the document never uses, and
`cross-lingual` asks in Russian about English documents. They are the semantic
path's headroom, and they drag the lexical aggregate down on purpose.

The hybrid arm ran against `bge-m3` on `http://localhost:11434/v1/embeddings`, with all 97 chunks embedded before measuring rather than backfilled during it.

## Result

| metric | lexical | hybrid |
|---|---|---|
| precision@1 | 66.2% | 87.8% |
| recall@5 | 77.0% | 97.3% |
| MRR@5 | 0.699 | 0.910 |

| class | n | lexical P@1 | hybrid P@1 | lexical MRR | hybrid MRR |
|---|---|---|---|---|---|
| cascade | 1 | 100.0% | 100.0% | 1.000 | 1.000 |
| cross-lingual | 14 | 7.1% | 85.7% | 0.071 | 0.857 |
| keyword | 32 | 96.9% | 96.9% | 0.984 | 0.984 |
| long-code | 6 | 83.3% | 100.0% | 0.917 | 1.000 |
| negative | 4 | 100.0% | 100.0% | 1.000 | 1.000 |
| paraphrase | 14 | 28.6% | 57.1% | 0.407 | 0.705 |
| title | 2 | 100.0% | 100.0% | 1.000 | 1.000 |
| typo | 1 | 100.0% | 100.0% | 1.000 | 1.000 |

Lexical search returns nothing relevant at all in the top 5 for 17 of 74 queries:

`para-hammer`, `para-cachefull`, `para-bigger`, `para-precompute`, `ru-retry`, `ru-ratelimit`, `ru-auth`, `ru-migration`, `ru-timeout`, `ru-docker`, `ru-k8s`, `ru-redis`, `ru-kafka`, `ru-race`, `ru-borrow`, `ru-slowquery`, `ru-vuln`


## The gate

`npm test` gates the lexical arm only, in
`tests/core/search.test.ts`, against `tests/fixtures/retrieval-baseline.json`
minus a tolerance of **0.03** — on all three aggregate metrics,
on per-class precision@1, and on the number of queries answered by nothing
relevant at all.

Three points is roughly two of the 74 queries. The
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
case by case in `tests/core/search.test.ts`, not scored. Latency is not
measured; the corpus is far too small for it to mean anything.
