# Code-aware chunking — measurement (2026-08-18)

P2.2. Everything below is reproducible from the repository at this commit with
`npx tsc && node scripts/measure-code-chunking.mjs [--flat]`.

## Question

`ContentStore.index()` sent every file through `#chunkMarkdown`, whatever it
was. That function looks for `#` headings and blank-line paragraphs. A `.ts`
file has neither, so the whole file arrived as one section and was then cut at
paragraph boundaries until each piece fit the 4 KB cap — which lands the cut
wherever the byte budget runs out, usually inside a function.

Two things pay for that. BM25, because a chunk's title is its first line
(`CHUNK_TITLE_MAX_CHARS`) and `bm25(chunks, 5.0, 1.0)` weights the title five
times the body. And embeddings, because half a function embeds as half a
thought.

The question: **how often does a stored code chunk start where a declaration
starts**, before and after.

## Method

### Corpus

Fully determined by the tree — there is no hand-picked file list:

    git ls-files
      → paths under src/, scripts/, tests/, hooks/
      → extension in {.ts, .mjs, .cjs, .js, .sh}
      → 2 KB ≤ size ≤ 200 KB
      → not a generated bundle, no line longer than 2 000 chars (minified)
      → sorted by path
      → an even spread of 120 entries across that sorted list

The spread matters: a plain `slice(0, 120)` of the sorted list is all `hooks/`
and `scripts/`, and the sample has to reach the class-heavy `src/` and the test
suites too. 120 files land 485 chunks under the old chunker, near the 400 the
plan measured.

Each file is indexed through the real `ContentStore` into a throwaway database
and the stored chunks are read back — no reimplementation of the chunker in the
measurement.

The corpus is read from the working tree, and `src/store.ts` is in it, so
editing the chunker moves the corpus by a chunk or two. Both arms below were
measured in the same run against the same tree; re-running on a later tree will
not reproduce the counts to the unit.

**Limitation, stated plainly:** the plan named `.py` and `.php`, and this
repository contains neither, in its tree or in `node_modules`. The corpus is
TypeScript, ESM/CJS JavaScript and shell. Python and PHP are covered by
`tests/store-code-chunking.test.ts` on representative sources instead, which is
weaker evidence than a real corpus and is not counted in the numbers below.

### What counts as a boundary

One definition, in `scripts/lib/code-chunk-boundary.mjs`, applied identically to
both arms. It is syntax-level and parser-free, like the chunker it measures.
Three ways to count, and nothing else:

- **(a) top-level declaration** — first line at column zero, opening with a
  declaration keyword. At column zero `const` and `import` really are
  declarations, so they are in that list.
- **(b) member declaration** — first line indented, opening with a keyword that
  only ever introduces a member (`public`, `async`, `def`, …) or reading as a
  signature rather than a statement: an identifier followed by `(` or `<`, not
  ending in `;`, not a control-flow head. `const`/`import` are *not* accepted
  here — an indented `const rows = query(...)` is a statement inside a body,
  which is exactly the mid-function cut this measures.
- **(c) doc-introduced declaration** — the first line opens a comment or
  decorator run and that run is followed, with nothing but comment/blank lines
  in between, by a line satisfying (a) or (b). A chunk that starts at a
  function's docstring starts at that function.

A second, narrower number is reported alongside: **strict**, which counts only
(a) plus the comment run in front of it — no indented members, no signature
pattern. A chunk opening on a class method scores as a miss there by
construction. It is a floor, not the answer, and it is reported because the main
number is the one a reader would want to argue with.

### Before / after

`--flat` sets `CONTEXT_MODE_CODE_CHUNKING=0`, so both arms come out of the same
build over the same files. That the flag really does restore the old behaviour
was verified separately, not assumed: `src/store.ts` from `HEAD` was compiled
into a scratch tree and run over the same 120 files, and the SHA-256 of the full
chunk dump (file, title, content, content type — 485 chunks) is identical to the
new build's output with the flag set.

    HEAD build                       485 chunks  sha256 cb2d7dc7c78d237a…
    new build, CODE_CHUNKING=0       485 chunks  sha256 cb2d7dc7c78d237a…
    new build, default             1 022 chunks  sha256 38e6fc8002d46227…

## Result

| | before (flat) | after (code-aware) |
|---|---|---|
| chunks | 485 | 1 022 |
| **starts at a declaration** | **337 (69.5 %)** | **891 (87.2 %)** |
| strict reading | 190 (39.2 %) | 370 (36.2 %) |
| chunks titled `Untitled…` | 455 of 485 (93.8 %) | 0 |
| median chunk | 3 705 B | 1 299 B |
| largest chunk | 6 522 B | 4 096 B |

By extension:

| ext | chunks before → after | before | after |
|---|---|---|---|
| `.ts` | 386 → 858 | 77.5 % | **92.2 %** |
| `.mjs` | 65 → 153 | 53.8 % | 60.8 % |
| `.cjs` | 3 → 6 | 66.7 % | 100 % |
| `.sh` | 31 → 5 | 3.2 % | 20 % |

Target was ≥ 80 %. Measured 87.2 %, and 92.2 % on TypeScript.

### Reading the numbers honestly

**The 69.5 % baseline is much higher than the plan's 30.5 %.** Different corpus,
and probably a different boundary test — the plan's number is not reproducible
from what it records. The reason the old chunker scores as well as it does is
worth knowing: its paragraph split cuts after blank lines, and programmers put
blank lines between functions, so it lands on a declaration by accident a good
part of the time. It has no way to do so on purpose, which is why it also
produces the 6 522 B chunk and the 455 `Untitled` titles.

**The strict number barely moves (39.2 % → 36.2 %) and that is expected.**
Strict counts only *top-level* declarations, and most of what the new chunker
adds is at member level: a 100 KB class that used to arrive as 25 byte-capped
slabs now arrives as one chunk per method, each indented, each invisible to the
strict test. In absolute terms the strict count rises from 190 to 370 chunks;
as a ratio it is diluted by the 537 new chunks it cannot see.

**The clearest results are the ones that need no metric at all:**

- **Titles.** Every chunk of every source file used to be titled `Untitled (7)`
  — `#chunkMarkdown` builds titles from a heading stack, and a `.ts` file has no
  headings. 455 of 485. It is now 0 of 1 022: chunks are titled
  `export function drainCodeIndexQueue(opts…`, `#insertChunks(`,
  `class TokenResolver`. Given the 5.0 title weight in `bm25()`, this is
  probably the largest single retrieval effect in the change, and it is not
  captured by the boundary ratio at all.
- **The byte cap.** `#chunkMarkdown` emits a single oversized paragraph whole;
  that is the 6 522 B chunk. Source files that the heuristic cannot read now
  fall through to `#chunkPlainText`, which caps properly, so the maximum is
  exactly `MAX_CHUNK_BYTES`.
- **Shell scripts.** `#chunkMarkdown` reads `# comment` as an H1. A 44 KB
  `scripts/ctx-debug.sh` came out as **106 chunks averaging 420 B**, most of
  them a single comment line. It is now 36 chunks of ~1.2 KB. The boundary
  ratio for `.sh` stays low (20 %) because a shell script has few things the
  test will call a declaration, and that is a fair verdict on the ratio, not on
  the change.

### Cost

1 022 chunks against 485 — 2.1× the FTS5 rows for the same bytes of content, and
2.1× the vectors for the embedding backfill to compute. The packing threshold is
what buys that back; `CODE_CHUNK_MIN_BYTES` sets how far consecutive
declarations are packed before a new chunk starts:

| `CODE_CHUNK_MIN_BYTES` | chunks | starts at declaration | median chunk |
|---|---|---|---|
| 512 | 1 303 | 89.2 % | 824 B |
| **1 024 (chosen)** | **1 022** | **87.2 %** | **1 299 B** |
| 1 536 | 851 | 85.7 % | 1 724 B |
| 2 048 | 724 | 84.0 % | 2 223 B |

Every setting clears the 80 % target, so the choice is about chunk size, not
about the metric. 1 024 B is roughly one documented function; below it chunks
start being mostly their own signature, and BM25 length normalisation begins
rewarding them for being short.

## Regression check — P2.1 retrieval harness

`node scripts/measure-retrieval.mjs --lexical-only`, run both ways, against the
recorded baseline (precision@1 0.662, recall@5 0.770, MRR@5 0.699, gate
tolerance 0.03):

| | precision@1 | recall@5 | MRR@5 | misses@5 |
|---|---|---|---|---|
| baseline | 0.662 | 0.770 | 0.699 | 17 |
| code chunking on | 0.662 | 0.770 | 0.699 | 17 |
| `CODE_CHUNKING=0` | 0.662 | 0.770 | 0.699 | 17 |

Identical to three decimal places, per class as well as in aggregate. Expected:
the relevance corpus is indexed from strings with no file path, and the
extension gate never opens for content without one.

## What is not measured here

- **Python and PHP**, for lack of a corpus — see the limitation above.
- **Whether better boundaries retrieve better code.** This measures where the
  cuts land and what the chunks are called, not answer quality on code queries.
  The P2.1 corpus is prose; a code-query corpus would be its own piece of work.
- **The embedding side.** The argument that a whole function embeds better than
  half of one is not tested here, only asserted.
