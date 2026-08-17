# Cross-query deduplication — measured saving

**Date:** 2026-08-18
**Harness:** `node scripts/measure-search-dedup.mjs`
**Subject:** `formatBatchQueryResults` (shared by `ctx_batch_execute`, `ctx_gather`)

## Question

A multi-query search ranks every query independently. When several queries of
one call have the same best answer, that chunk is rendered once per query. How
many of the bytes a batch response hands to the model are text the model already
read a few lines earlier?

## Method

The harness copies a live content DB to a temp directory (it never writes to the
knowledge base it measures), picks the batch sources with the most chunks, and
uses each source's own section headers as the query set — the shape a real
`ctx_batch_execute` asks: several related questions about one captured blob.
Each source is rendered twice through the real formatter:

- `CONTEXT_MODE_SEARCH_DEDUP=0` — the pre-change output, byte for byte;
- dedup on — verbatim repeats replaced by a one-line pointer.

`savedPct` is the byte delta over the full rendered response, tip line included.

## Result

DB: `~/.claude/context-mode/content/c2c6ef653d394742.db` (this project), 8 queries per source.

| source | chunks | bytes before | bytes after | suppressed | further | saved |
|---|---|---|---|---|---|---|
| `batch:FORK-CHANGES doc,Behind upstream commits` | 29 | 23439 | 14368 | 14 | 0 | 38.7% |
| `batch:store.ts class ContentStore + constructo` | 22 | 29787 | 15896 | 14 | 1 | 46.6% |
| `batch:server-RuntimeStats-def-grep,server-runt` | 22 | 35124 | 22668 | 8 | 3 | 35.5% |
| `batch:Local install topology,Routing rules and` | 21 | 17336 | 14825 | 13 | 1 | 14.5% |
| `batch:ctx_search handler loop server.ts 2900-3` | 19 | 38931 | 28463 | 8 | 7 | 26.9% |
| **total** | | **144617** | **96220** | **57** | **12** | **33.5%** |

A third of a batch response was verbatim repetition. The spread (14.5–46.6%)
tracks how much the queries of a source overlap, which is exactly what varies
between real calls.

## What is not saved

`further` counts renders of a chunk that was already shown but through a
*different* snippet window. Those are printed in full and marked
`— further match`; only byte-identical text is replaced. Twelve such renders
across the five sources — that is information the naive "seen this chunk
already" rule would have destroyed, and it is why the identity key alone is not
a sufficient suppression rule.

## Caveats

- Section headers as queries are a proxy for real user questions. They are
  drawn from the same source being searched, which is representative of the
  batch path but says nothing about `ctx_search` against a cold global index.
- Five sources from one project. The number is a magnitude, not a constant.
- The saving is bounded by how many queries a call makes: a single-query call
  can never save anything.
