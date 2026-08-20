# ADR-0017 — Retrieval quality is gated on the deterministic arm

**Status:** Accepted
**Date:** 2026-08-20 — recorded retrospectively; the gate shipped earlier
**Source:** [FORK-CHANGES §28](../FORK-CHANGES.md)

## Context

The suite asserted individual rankings — "this query returns that source first".
That catches a named ranking flipping and nothing else: a change that trades
five wins for four losses touches no assertion and passes green.

Retrieval is the plugin's core competence, and it was the one thing with no
number attached to it.

## Decision

**1. A fixture corpus, answered twice.** 40 competing documents and 74 labelled
queries live in `tests/fixtures/relevance-corpus.json`. Every query is answered
at top-5 through the lexical path alone and through the hybrid path the server
actually runs. Both arms come out of one throwaway store under the OS temp
directory; nothing touches the user's knowledge base.

| metric | lexical | hybrid |
|---|---|---|
| precision@1 | 66.2% | 87.8% |
| recall@5 | 77.0% | 97.3% |
| MRR@5 | 0.699 | 0.910 |

**2. Two query classes exist to be lost by lexical search.** `paraphrase` states
the intent in words the document never uses; `cross-lingual` asks in Russian
about English documents. They drag the lexical aggregate down on purpose, and
they are where the semantic path earns its round trip — cross-lingual
precision@1 goes 7.1% → 85.7%, paraphrase 28.6% → 57.1%. On `keyword`, `title`
and `negative` the two arms score identically: the semantic layer changes
nothing where lexical already wins. Recorded rather than argued about.

**3. The CI gate is lexical only.** `npm test` compares a fresh run against
`tests/fixtures/retrieval-baseline.json` minus a tolerance of **0.03**, on all
three aggregates, on per-class precision@1, and on the count of queries answered
by nothing relevant.

The lexical arm is deterministic — same corpus, same index order, same ranking,
run after run — so the tolerance is **not** there to absorb noise. It is there
so a deliberate tuning change that trades one ranking for another does not have
to be accompanied by a baseline rewrite. Three points is roughly two of the 74
queries; a real regression moves these numbers by tens of points.

**4. The hybrid arm is measured and not gated.** It needs a live embedding
endpoint, and a gate that fails when a model is unreachable is worse than no
gate — it fails for the wrong reason often enough that people learn to ignore
it.

**5. One implementation of the metric.** `scripts/lib/retrieval-metrics.mjs` is
shared by the harness that records the baseline and the test that checks it. Two
copies of "what precision@1 means" would drift, which is the failure a baseline
gate exists to catch.

**6. The report is protected from the harness that writes it.** The script wrote
its research note by default, so someone running it to check a number — with no
embedding endpoint configured — rewrote the file with eight rows of `—` where
the hybrid measurements had been, after the run that could produce them had
already finished. Two rules came out of that, and the first alone would not have
been enough:

- Writing is explicit (`--report`, or `--report <path>`). Without it the harness
  only prints, like the measurement scripts beside it. Writing by default was
  the deviation from the local convention, and it is what turned "look at a
  number" into "overwrite a document".
- **A run with fewer arms will not replace a run with more** unless `--force` is
  passed. `scripts/lib/report-guard.mjs` reads the file it is about to replace
  and parses the rendered metric row — *not* the environment, because whoever
  overwrites may be configured differently from whoever wrote, which is
  precisely how the column was lost. The refusal names the arm that would be
  discarded, exits non-zero with the file untouched, and the numbers are on
  stdout either way. A run with the same arms or more still overwrites without a
  flag: demanding `--force` for ordinary re-measurement would make passing it a
  reflex, and the guard would be gone.

## Alternatives rejected

**Gate the hybrid arm too.** Red builds on a machine where Ollama is not
running. A gate people disable protects nothing.

**Keep only the individual ranking assertions.** They are still there — the 18
cases the suite had before, still asserted one by one, with a test on their
count so that "fixing" a regression by deleting a case fails. They are a
complement to the aggregate, not a substitute.

**Zero tolerance.** Every deliberate tuning change would arrive with a baseline
rewrite in the same commit, which is indistinguishable from papering over a
regression.

**Always require `--force` to write the report.** Makes the flag a reflex and
removes the protection it exists to provide.

## Consequences

- Ranking changes now come with a number, and a trade that loses more than it
  wins fails the build.
- The hybrid numbers are documented in `docs/research/` and quoted in this
  repository's docs; they are evidence, not a gate.
- The corpus is indexed from strings with no file path, which is why the
  code-aware chunker ([ADR-0018](0018-code-aware-chunking.md)) measures
  identically with it on and off — the extension gate never opens for content
  without a path. Expected, and worth stating so the null result is not read as
  a broken measurement.
