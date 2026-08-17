# Content-hash index cache — measured saving

**Date:** 2026-08-18
**Harness:** `node scripts/measure-index-skip.mjs`
**Subject:** `ContentStore.index()` (ADR-0007)

## Question

`index()` rewrote a source unconditionally — delete every chunk with that label,
re-chunk, re-insert — even when the content was byte-identical to what was
already stored. What does consulting the hash that was already being written
actually save?

## Method

120 tracked source files of this repository (`.ts/.js/.md`, under 512 KB) are
indexed into a throwaway store, then indexed again unchanged, twice: once with
the cache on, once with `CONTEXT_MODE_INDEX_HASH_SKIP=0`. Between passes every
chunk is given a vector, so the orphan count is meaningful — `chunk_vectors` is
keyed on `chunks.rowid`, and an FTS5 delete/insert hands out new rowids.

## Result

120 files, 831 chunks.

| pass | ms/file | skipped | orphaned vectors |
|---|---|---|---|
| first index (cold) | 5.30 | 0 | — |
| re-index, cache on | **0.11** | 120 | **0** |
| re-index, cache off | 6.76 | 0 | **831** |

**63.5× faster on unchanged files**, against a bootstrap budget of ~12.5 ms/file.

The orphan column is the larger result. Every re-index of an unchanged file used
to discard the embeddings for all 831 chunks — work the backfill then had to
redo at roughly a second per batch against a local model. On a bootstrap pass
that re-reads the same 15 files at every store open, that is the difference
between a semantic index that converges and one that never does.

## What is not measured here

- The saved re-read on the search path (`#refreshStaleSources` no longer
  re-reads a file whose mtime moved without its bytes changing). It is a
  correctness fix with the same root cause; its cost depends on how many
  file-backed sources a store holds.
- Cold-index cost is unchanged by design — the cache only helps on repeats.
- The `session_id` trade (first writer wins) is a semantic cost, not a
  measurable one. See ADR-0007.
