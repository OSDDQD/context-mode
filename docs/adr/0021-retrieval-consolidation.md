# ADR-0021 — Retrieval consolidation: three servers become one plugin

**Status:** Accepted
**Date:** 2026-08-20 — recorded retrospectively; the wave shipped earlier
**Source:** [FORK-CHANGES §34](../FORK-CHANGES.md)

## Context

The agent's context was served by three independent MCP servers: **fff** for
lexical file search, **codegraph** for structure, **context-mode** for memory
and execution. Each carried its own index, its own filesystem watcher and its
own tool surface — and the model chose between them badly enough that a global
`CLAUDE.md` rule ("use fff to find files") had to exist to force the choice.

That rule was a symptom. The signals are orthogonal — names, structure, recorded
text, meaning — so the fix is to **add** them, not to pick between them. Adding
them requires them to be in one process.

## Decision

### 1. fff runs as a library, pinned exactly

`@ff-labs/fff-node` is pinned to exactly `0.10.5`: a 0.x API with roughly 290
releases in five months, where a caret range would drift under us. An FFI binary
cannot be bundled, so it installs through `hooks/ensure-deps.mjs` beside
`better-sqlite3`, the loader assembles its import specifier at runtime, and
`--external:@ff-labs/fff-node` backs that up in the esbuild invocation.

`src/fff/` keeps one native index per project root behind an explicit
`destroy()` — the index lives in Rust where the garbage collector cannot see it
— and keys its frecency and history stores by the same project hash the FTS5
store uses, so the cross-project leak
([ADR-0009](0009-capture-queues.md)) cannot reopen through a new channel.

A missing native library degrades to "unavailable"; nothing throws.

### 2. One watcher for the whole plugin

`src/fs-bus/` turns fff's watcher into the plugin's only filesystem event
source: one debounced, coalescing subscription with consumers hanging off it —
FTS5 `code:` chunks re-indexed on change and evicted on delete, the
`codegraph sync` queue fed through the seam `src/graph/daemon.ts` exposes, and a
registry for per-path caches. Re-indexing goes through `store.index({path})`
*without* content, so the store re-reads, screens and hashes the **screened**
bytes; a changed file cannot keep a stale hash.

The wiring lives in the bus, not in the consumers: putting it inside the fff
module would invert the dependency its own header warns against.

### 3. codegraph is read, not asked

codegraph exposes exactly one MCP tool while its whole value sits in an open
SQLite schema. `src/graph/` opens `<project>/.codegraph/codegraph.db`
**read-only** — driver flag plus `PRAGMA query_only`, verified by tests that
assert INSERT/DELETE/CREATE all throw, on a live 235 MB index as well as a
synthetic one. (`file:…?mode=ro` does not work here: neither `better-sqlite3`
nor `node:sqlite` passes `SQLITE_OPEN_URI`, so the URI would be read as a
filename.)

- **The schema is pinned** to a known version window. Drift, or an incomplete
  index, degrades to the `codegraph <cmd> -j` CLI — **never to a guess**.
- **Answers carry a freshness line** ("index lags N files") instead of
  describing yesterday's code silently.
- **The daemon's lifecycle moves with the tool.** It used to be started by the
  MCP host; it is now supervised by the plugin, idempotently across sessions,
  with a debounced project-level `codegraph sync` fallback.
- `explore` has no `--json`, so its output is handed back whole — and that
  branch bypasses the store's screening, so it is run through `redactSecrets`
  first ([ADR-0019](0019-index-time-credential-screening.md)).

### 4. `ctx_find` — one query, five signals

`fuseRankings` is generalised into `fuseRankedLists`: N weighted lists, one
identity function, with the old two-list call now a spelling of it and
numerically unchanged. Five lists enter — fff file names, fff grep, FTS5, chunk
vectors, codegraph adjacency — and **every returned row names the signals that
produced it.**

- The graph list is seeded from the fused lexical rows rather than from the
  query, because adjacency has no opinion about words.
- **The graph weight (0.5) is measured, not chosen.** Against the 74-query
  corpus, fed the worst case — ten plausible but never-relevant neighbours,
  which is what a wrong seed produces — P@1 / R@5 / MRR hold at
  0.662 / 0.770 / 0.699 for weights up to 0.75, R@5 falls to 0.730 at 1.0, and
  everything collapses at 2.0. The env override is clamped to 1.
- **Coverage is reported per signal**, and grep's coverage is stated in files
  scanned against files eligible plus a next-page flag: fff pages grep by file
  and totals only the page in hand, so "N of totalMatched" would be a lie.

**Ranking learns across the MCP boundary**, which the protocol does not
otherwise allow: `ctx_find` publishes the candidates it showed, the PostToolUse
hook records which one was opened, and the next call spends that as `trackQuery`.
The hook records intent only — no hook bundle carries `src/fff/**` — so a
selection is learned at the next search rather than instantly.

## Alternatives rejected

**Keep three servers and improve the instructions.** That was the status quo,
and the global rule telling the model which server to prefer is the evidence it
does not work. Three tool surfaces also cost three schema payloads per request
([ADR-0014](0014-standing-context-budget.md)).

**Write our own structural index.** codegraph's index is open, correct and
already on disk. Reading it read-only costs a driver flag; rebuilding it costs a
language-by-language parser and a second thing to keep fresh.

**Drive codegraph through its MCP tool.** One tool, a second process, a second
schema payload, and no access to the queries that matter.

**Vendor the fff binary into the bundle.** An FFI artifact per platform in a
plugin distributed as source.

**A caret range on `@ff-labs/fff-node`.** ~290 releases in five months on a 0.x
API: the pin is the only version statement that means anything.

**Pick the best signal per query instead of fusing.** That is the choice the
model was making badly. Fusion makes "which signal" a ranking question with
measurable weights.

## Consequences

- Removing `fff` and `codegraph` from the user's MCP config is deliberately left
  to the operator: it is user-owned configuration, and it should happen only
  once the daemon is running under plugin supervision on that machine.
- Two facts the plan did not anticipate, both measured: fff's frecency and
  history stores are LMDB directories rather than SQLite (no `busy_timeout` to
  set; four processes writing 200 selections each produced zero failures), and
  `watch()` refuses subscriptions until its first scan completes, so attachment
  waits for the scan.
- `ctx_doctor` gained a search-layers section so every one of these can be seen:
  fff native and package version, LMDB store sizes, watcher and mmap switches,
  live roots; codegraph binary, schema version against the pinned window, daemon
  liveness, index lag, database size; the bus with its consumers and counters.
  Every probe degrades to "not installed" or "off" rather than failing.
- `ctx_find` does **not** win on bytes — 2.6 KB against `rg -l`'s 0.7 KB — and
  it is ranked rather than exhaustive. Its case rests on replacing a *sequence*
  (`rg -l`, then two or three `Read`s), which is why `Grep` and `Glob` are
  nudged rather than denied ([ADR-0008](0008-escalation-economics.md)).
