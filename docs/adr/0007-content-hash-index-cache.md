# ADR-0007 — Content-hash index cache

**Status:** Accepted
**Date:** 2026-08-18

## Context

`ContentStore.index()` rewrote a source unconditionally: delete every chunk with
that label, re-chunk, re-insert. It did this even when the content was
byte-identical to what was already stored — and it had the evidence to know
better, because `sources.content_hash` was already written on every index. The
column was only ever read by `#refreshStaleSources`, never on the write path.

Three costs, in rising order of how much they hurt:

1. **FTS5 work.** Measured on this repository: ~12.5 ms per file across the
   porter and trigram indexes. The bootstrap seeds 15 files per store open;
   most of them have not changed since the last one.
2. **A re-read on every search.** `#refreshStaleSources` gates on
   `mtime > indexed_at`. A file whose mtime moved without its bytes changing
   (a `git checkout`, a formatter that rewrote the same text, a `touch`) was
   re-read, re-hashed and found identical — on every search, forever, because
   nothing moved `indexed_at`.
3. **Orphaned embeddings.** `chunk_vectors` is keyed on `chunks.rowid`. `chunks`
   is an FTS5 table: delete-and-reinsert gives the new rows new rowids, so every
   re-index of an unchanged file dropped its vectors on the floor and made the
   backfill compute them again. `pruneOrphanVectors` exists precisely because of
   this, and its own comment records "a single re-index left twice as many
   vectors as chunks".

## Decision

`index()` computes the SHA-256 of the content and skips the rewrite when a row
with that label already exists, its stored hash matches, and its `file_path` is
unchanged. The skip still moves `indexed_at` forward, which is what closes
cost 2. `IndexResult` gains `skipped: true` and `sourceId: -1`.

The hash is computed for **every** source, not only file-backed ones. Command
captures dominate this index, and a batch command re-run with identical output
is exactly as skippable as an unchanged file.

Two safety rules:

- A row with no stored hash (written before the column existed) is indexed once
  more so it acquires one, then cached.
- Anything unexpected — a missing row, a throw while reading metadata — falls
  through to indexing. A redundant re-index costs milliseconds; a wrongly
  skipped one loses content.

## The trade

**A skipped chunk keeps the `session_id` of the session that first indexed it.**
Per-session attribution therefore credits the first writer, not the most recent
one.

The obvious fix does not work. `session_id` is a column on an FTS5 table; an
`UPDATE` there deletes and re-inserts the row, changing its rowid — which
destroys the embedding preservation that is the largest part of this change's
value, and does most of the write work the skip exists to avoid.

So: **first writer wins**, stated here rather than discovered later while
reading a stats report. `CONTEXT_MODE_INDEX_HASH_SKIP_REATTRIBUTE=1` forces the
rewrite for anyone who needs current attribution more than the cache.

## Consequences

- No schema change. `sources.content_hash` already exists, so the expensive
  table-recreating migration is not needed.
- `CONTEXT_MODE_INDEX_HASH_SKIP=0` restores unconditional rewriting.
- `#refreshStaleSources` also touches `indexed_at` when it finds a matching hash
  after an mtime bump — the same fix for cost 2, on the path that discovers it.
- Callers reading `result.sourceId` must tolerate `-1`. Inside this repository
  nothing does anything with it but log it.

## Alternatives rejected

**Compare mtime only.** Cheaper, and wrong in both directions: it misses a
rewrite that preserves mtime, and it re-indexes on every `touch`.

**Keep a rewrite but reuse rowids.** SQLite will not promise rowid stability
across an FTS5 delete/insert, and building a mapping to re-key `chunk_vectors`
afterwards is more machinery than the problem deserves.

**Re-attribute with an UPDATE.** Costs the rowids, which costs the vectors —
i.e. it gives back the main saving to fix the smaller problem.
