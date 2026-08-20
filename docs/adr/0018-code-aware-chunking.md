# ADR-0018 — Source files chunk at declaration boundaries

**Status:** Accepted
**Date:** 2026-08-20 — recorded retrospectively; the chunker shipped earlier
**Source:** [FORK-CHANGES §29](../FORK-CHANGES.md)

## Context

`index()` sent every file through `#chunkMarkdown`, whatever it was. That
function looks for `#` headings and blank-line paragraphs. A `.ts` file has
neither, so the whole file arrived as one section and was then cut at paragraph
boundaries until each piece fit the 4 KB cap — landing the cut wherever the byte
budget ran out, usually mid-function.

Two consumers pay for that:

- **BM25**, because a chunk's title is its first line and the title carries five
  times the body's weight in `bm25()`. Every chunk of every source file was
  titled `Untitled (7)` — a heading stack over a file with no headings.
- **Embeddings**, because half a function embeds as half a thought.

Since the code index ([ADR-0009](0009-capture-queues.md)) made the source tree
the largest thing in the store, this stopped being a corner case.

## Decision

Files with a source extension go through `#chunkCode`, which cuts at
declarations and packs consecutive small ones until a chunk reaches
`CODE_CHUNK_MIN_BYTES` (1,024). A file the heuristic cannot read falls through
to `#chunkPlainText`, which caps properly instead of pretending to find
headings.

Measured over 120 tracked files, corpus selected by rule rather than by hand:

| | before (flat) | after (code-aware) |
|---|---|---|
| chunks | 485 | 1,022 |
| **starts at a declaration** | **337 (69.5%)** | **891 (87.2%)** |
| chunks titled `Untitled…` | 455 of 485 (93.8%) | **0** |
| median chunk | 3,705 B | 1,299 B |
| largest chunk | 6,522 B | 4,096 B |

On TypeScript alone, 77.5% → **92.2%**.

**The title column is probably the larger result, and no ratio captures it.**
Chunks are now titled `export function drainCodeIndexQueue(opts…`,
`#insertChunks(`, `class TokenResolver` — against a title weight of 5.0.

**The measurement argues with itself, which is why it is worth reading.** A
stricter boundary test — top-level declarations only — *falls* as a ratio,
39.2% → 36.2%, while rising in absolute terms from 190 to 370 chunks: a 100 KB
class that used to arrive as 25 byte-capped slabs now arrives as one chunk per
method, and every one of those is indented and invisible to the strict test. And
the 69.5% baseline is far above the 30.5% the plan assumed — the old chunker
cuts after blank lines and programmers put blank lines between functions, so it
landed on a declaration by accident a good part of the time. It just could not
do so on purpose, which is the same reason it produced the 6,522 B chunk and the
455 `Untitled` titles.

**Cost: 2.1× the FTS5 rows and 2.1× the vectors** for the same bytes of content.
`CODE_CHUNK_MIN_BYTES` is the dial — 512 gives 89.2% at 824 B median, 2,048
gives 84.0% at 2,223 B. Every setting clears the 80% target, so the choice is
about chunk size rather than about the metric; 1,024 B is roughly one documented
function.

**The rollback is byte-exact and was verified, not assumed.**
`CONTEXT_MODE_CODE_CHUNKING=0` restores the old behaviour: `src/store.ts` from
`HEAD` was compiled into a scratch tree, run over the same 120 files, and the
SHA-256 of the full chunk dump (485 chunks; file, title, content, content type)
matches the new build's output with the flag set — `cb2d7dc7c78d237a…` both
ways.

## Alternatives rejected

**A real parser per language.** A dependency (or several), a build step, and a
new class of failure — a file that fails to parse — on a path whose job is to
degrade quietly. The heuristic's fallback to plain text is the honest version of
the same behaviour.

**Tune the markdown chunker to notice code.** That is what it was already doing
badly. The problem is not the cut *size*, it is that the function has no concept
the cut should align to.

**A smaller or larger `CODE_CHUNK_MIN_BYTES`.** Every tested value clears the
target, so the choice was made on what a chunk should *be*, not on the metric.

## Consequences

- 2.1× rows and vectors for source files. The content-hash cache
  ([ADR-0007](0007-content-hash-index-cache.md)) is what keeps that from being
  paid repeatedly, and the backfill budget
  ([ADR-0010](0010-semantic-layer-adopted-not-bundled.md)) is what keeps it off
  the latency path.
- The retrieval harness ([ADR-0017](0017-retrieval-quality-gate.md)) reports
  **identical numbers to three decimal places** with the change on, off, and at
  the baseline. Expected: the relevance corpus is indexed from strings with no
  file path, and the extension gate never opens for content without one. The
  null result is a property of the corpus, not evidence the chunker does
  nothing.
- `.py` and `.php` are covered by `tests/store-code-chunking.test.ts` on
  representative sources rather than by a real corpus — this repository contains
  neither — which is weaker evidence and is not counted in the numbers above.
