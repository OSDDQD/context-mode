# ADR-0015 — Content-store lifecycle: retention, budget and deletion

**Status:** Accepted
**Date:** 2026-08-20 — recorded retrospectively; the changes shipped earlier
**Source:** [FORK-CHANGES §17, §19, §22, §32](../FORK-CHANGES.md)

## Context

The knowledge base is one SQLite database per project, in WAL mode, plus a
per-session stats file. Nothing measured what any of it cost, and the one
mechanism that deleted anything deleted the wrong things:

- `cleanupStaleContentDBs` set its delete flag from a WAL check that ran
  **outside** the age rule, so a non-empty WAL untouched for an hour deleted the
  store regardless of how new it was. Any session that ended without a
  checkpoint could wipe a knowledge base minutes old, taking the 14-day
  retention promise with it. The comment claimed a PID check; there was none.
- `getDBSizeBytes()` read the `.db` file alone, which in WAL mode can be a
  single page while megabytes sit in the WAL. Measured across 328 stores:
  **216.5 MB total, 14.3 MB of it WAL**.
- Every session wrote its own `stats-<id>.json` and nothing removed them —
  **735 files**, all read on every `ctx_stats` call.
- `ctx_purge` had two settings, one session or the whole project, with nothing
  between them for the case that actually comes up: one source went in wrong.
  The only remedy on offer was to delete the entire knowledge base and re-earn
  it, so the realistic outcome was that nobody purged anything and the bad
  source kept answering searches.

## Decision

**1. Age is the only reason to delete a store.** The WAL acts *inside* the age
rule and only protectively: past the cutoff, a recently written WAL means a live
owner (in WAL mode the `.db` mtime only moves on checkpoint), so the store is
kept. `CONTEXT_MODE_CONTENT_RETENTION_DAYS` (14) sets the window;
`CONTEXT_MODE_CONTENT_WAL_REAP=0` drops the guard and goes by `.db` mtime alone.

**2. Measure the directory, not the databases.** `contentStoreUsage()` walks
with `statSync` and reports bytes including sidecars plus a last-use timestamp.
Opening 328 databases to ask their size costs more than the answer.

**3. Eviction happens off the hot path, and refuses more than it takes.**
`enforceContentBudget()` evicts least-recently-used stores down to 90% of the
budget, and refuses to touch the caller's own store, any store with a live
non-empty WAL, and anything used inside 48 hours. It is called **only** from
`context-mode drain` — deleting another project's data during a tool call is
not a thing to do quietly. The default budget sits above the measured footprint,
so the first revision only prints the number.

**4. Compaction is conditional and never on close.** `ContentStore.compact()`
checkpoints the WAL and VACUUMs, but only when the freelist is worth a full
rewrite (>1 MB and >20% of the file), and it runs from `drain`, never from
`close()`: a session ending should not pay seconds of I/O. Measured on this
repository's store: **10.7 MB reclaimed**.

**5. Stats files are rolled up, never simply deleted.** The lifetime counters
are summed from these files, and a metric that goes down is worse than a
directory that grows. `rollUpStaleStatsFiles()` folds the bytes of files
untouched for the retention window into `stats-rollup.json` and then deletes
them; the age rule is what keeps a live session's own file from being counted
twice.

**6. `ctx_purge` gains a source scope, and it refuses to guess.**

- The source branch returns before the file-level wipe the other scopes run:
  nothing is closed, no file is unlinked, the stats file is not reset, and every
  other source, session row and counter survives.
- **The label must match exactly.** `ctx_search`'s `source` filter matches
  partial labels, so a caller who learned a label there will reasonably pass a
  substring here — and a cheerful "purged" would read as "it is gone" while the
  source is still indexed and still answering. A label that matches nothing is
  an error, and the error names the indexed labels that contain it, or says how
  many sources exist.
- **Combining `source` with anything wider is refused as ambiguous.** Pairing it
  with a `sessionId` or `scope: "project"` asks for two different deletions at
  once, and choosing one on the caller's behalf is how a whole-project wipe
  happens by accident. `scope: "source"` without a label is refused too.
- **A partial delete reports itself as one.** `sources.label` carries no UNIQUE
  constraint, so one label can own several rows; the handler loops until the
  label is gone and answers `Partially purged … N of M row(s) removed` as an
  error when it could not finish. Removing one row of three and calling it done
  is the same silent success as removing none.

**7. Tests do not write into the user's store.** `npm test` was writing into the
real config directory — **297 stray content DBs** and hundreds of stats files,
which the plugin's own disk accounting then counted as the user's data.
`tests/setup-storage.ts` is global but narrow: it redirects `homedir()` only. A
global `HOME` breaks every test that shells out through a version-manager shim,
and a global `CONTEXT_MODE_DIR` leaks into spawned hooks whose tests then look
under their own `HOME`. Measured per run: 13 stray DBs before, 1 after.

## Alternatives rejected

**Delete stale stats files outright.** Lifetime counters would fall. A number a
user saw last week must not shrink this week — the same invariant
[ADR-0005](0005-stats-scope-labels-and-containment.md) reasons from.

**VACUUM on close, or on every drain.** Seconds of I/O charged to a session that
is trying to end, for a file that is usually not fragmented enough to care.

**Evict from the tool-call path when the budget is exceeded.** Silent deletion
of another project's knowledge base as a side effect of an unrelated search.

**Accept substring matching in `ctx_purge`.** Convenient, and the failure is a
confident report of a deletion that did not happen — or one that deleted more
than was asked.

**A global fake `HOME` for tests.** Breaks the suites that legitimately shell
out.

## Consequences

- Every automatic deletion is bounded by age and runs off the hot path; every
  user-initiated deletion is scoped by an exact name or refused.
- `ctx_stats` reports the disk footprint as its own row, worded so it cannot be
  read as more bytes saved ([ADR-0005](0005-stats-scope-labels-and-containment.md)).
- `context-mode drain` is now the maintenance window for the store: backfill
  ([ADR-0010](0010-semantic-layer-adopted-not-bundled.md)), capture drains
  ([ADR-0009](0009-capture-queues.md)), budget and compaction all run there.
