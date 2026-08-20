# ADR-0016 — Search responses declare what they omit

**Status:** Accepted
**Date:** 2026-08-20 — recorded retrospectively; both halves shipped earlier
**Source:** [FORK-CHANGES §16, §25](../FORK-CHANGES.md)

## Context

Two ways a retrieval response misleads the reader, both measured on live data:

**Repetition.** A multi-query search ranks every query independently, so a chunk
answering several of them is rendered several times. Measured over five live
`batch:` sources: 144,617 bytes of response held 57 verbatim repeats — **33.5%
of what the model was handed was text it had read a few lines earlier**.

**Silence about the pool.** Three results say nothing about whether three was
all there was, or the first three of forty. That difference decides whether the
reader searches again or stops — and the retrieval layer already knew the
answer: RRF builds a score map over every candidate before slicing to the limit,
then threw the size away.

## Decision

**A response says what it is not showing, and never at the cost of losing
information.**

### Repeats are pointed at, not deleted

`CrossQueryDeduper` suppresses only text that is **byte-identical to something
already printed above in the same response**, and replaces it with a pointer to
where it was printed, plus a one-line tally at the end.

Three rules keep it lossless:

- **Headings and provenance always survive.** A query whose every hit is a
  repeat shows what it matched instead of appearing to have found nothing.
- **A different snippet window over the same chunk is new information** and is
  rendered in full, marked `— further match`. In the same measurement there were
  12 such renders; a plain "seen this chunk" rule would have destroyed all of
  them.
- **Identity is `source + title + first 120 chars`** (`chunkIdentity`, the
  exported former `fusionKey`). `source::title` is not enough — a live index
  carries `Untitled (1)`, `Untitled (2)`.

One deduper instance per response, covering `ctx_batch_execute`, `ctx_gather`
and `ctx_search`. `CONTEXT_MODE_SEARCH_DEDUP=0` restores the previous output
byte for byte.

### Completeness is claimed only when it is provable

`searchWithFallbackMeta()` returns the results plus `{shown, poolSize,
saturated}`; the old signature delegates to it, so no call site had to move.

- **"Complete" requires a provably untruncated pool** — no layer hit its fetch
  limit and no post-filter ran. Everywhere else the total is rendered as `N+`.
- **The error always points at "there may be more."** Erring that way costs a
  character; erring the other way tells the reader to stop looking when there
  was more to find.
- One line per query, one escalation block per response, both before the
  throttle line.
- **Timeline mode says nothing at all.** It merges this session, prior sessions
  and auto-memory into one list, so there is no single pool to be complete with
  respect to.
- Rows added by hybrid fusion or auto-memory are counted separately as
  `(+N from memory/semantic)` rather than silently inflating the denominator.

`CONTEXT_MODE_SEARCH_COMPLETENESS=0` and `CONTEXT_MODE_SEARCH_ESCALATION=0` turn
the two halves off independently.

## Alternatives rejected

**Deduplicate by chunk identity alone.** Simpler, and it would have discarded
the 12 legitimate further-matches in the measurement — a different window over a
long chunk is exactly the case a wide query exists to surface.

**Suppress near-duplicates too.** The moment the rule stops being "byte
identical", the response starts deciding what the reader does not need, and
there is no way to audit what it dropped.

**Print an exact total always.** Real work on a large index in exchange for a
nicer number. `CONTEXT_MODE_SEARCH_EXACT_TOTALS=1` re-fuses at a wider fetch for
callers who want it, capped at 500.

**Say nothing about the pool.** The status quo, and the reason a reader could
not tell a complete answer from a truncated one.

## Consequences

- Response bytes fall on repeat-heavy multi-query searches without any hit
  disappearing from the record.
- Callers reading `searchWithFallback` are unaffected; the metadata is opt-in
  through the `Meta` variant.
- Both mechanisms render in the same voice, and `src/truncate.ts` was brought
  onto it — a bare `... [truncated]` leaves the model unable to tell two lost
  lines from two thousand.
