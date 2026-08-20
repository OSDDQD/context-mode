# ADR-0020 — Splitting the server: the ToolDeps seam

**Status:** Accepted
**Date:** 2026-08-20 — recorded retrospectively; the split is ongoing
**Source:** [FORK-CHANGES §27](../FORK-CHANGES.md)

## Context

`src/server.ts` was 6,276 lines, and it is where every `sync-upstream` conflict
lands. Splitting it is ordinary work. Doing it without silently breaking the
tests that guard it is not, because **40 call sites across 8 suites read
`server.ts` as text** and assert on what they find — and a `not.toContain` over
a shrinking file always passes.

## Decision

**1. The safety net lands first, as a deliberate no-op.**
`tests/shared/server-source.ts` becomes the only place that knows which files
make up "the server". When a region moves out, its new home joins
`SERVER_SOURCE_FILES` and every existing assertion keeps meaning what it meant.

`tests/core/tool-registration.test.ts` is the acceptance gate: the same tools,
the same names, the same **registration order** (MCP hosts render the list in
that order), each with a handler and a description. It also greps the combined
source for `registerTool` names, so a handler moved into a file the helper does
not list fails loudly instead of vanishing.

**2. Dependencies travel as data, never as an import back.**
`src/tools/shared/deps.ts` defines `ToolDeps`: everything a tool module needs
from `server.ts` arrives as a value. Importing `getStore` or `trackResponse`
back would close a cycle that resolves by evaluating one side half-initialised —
a bug that shows up only in the bundle, only at startup, only sometimes. The
interface is deliberately short: it is the honest record of how much state a
handler touches, and it gets harder to extend as it grows, which is the point.

`src/tools/shared/state.ts` carries the cross-handler state the seam does not.

**3. Registration keeps its position.** A moved tool registers from the same
place in the sequence, so the tool list order the host renders is unchanged.

**4. Measurement rebuilds each commit from its own source.** Nothing in the
split rebuilt the committed bundle, so reading the committed blob would have
measured when someone last ran `npm run bundle`, not what the split cost. The
recorded before/after runs the same esbuild invocation over each state's source:
740,908 B → 752,021 B (+1.5%), with `madge --circular` reporting the same 5
cycles throughout, **none of them through `server.ts`**.

## Alternatives rejected

**Import back into `server.ts` from the tool modules.** Shorter diff, and it
reintroduces exactly the cycle class the seam exists to prevent — with a failure
mode that only appears in the shipped artifact.

**Move registration to a table and lose the ordering.** The order is part of
what the host shows the user; changing it is a user-visible change smuggled into
a refactor.

**Split first, then fix the tests.** The tests read the file as text; splitting
first makes them pass by having less to read, which is the failure mode this ADR
is built around.

**Measure the committed bundle.** Measures build hygiene, not the change.

## Consequences

- Every new tool goes in `src/tools/` and receives `ToolDeps`; adding a
  dependency to that interface is a visible decision rather than an import.
- Upstream merges conflict in smaller files.
- The bidirectional bundle/tool-list check in
  [ADR-0013](0013-tracked-bundles-are-the-running-code.md) exists because tools
  now register from `src/tools/` — a check that scanned `src/server.ts` alone
  went blind the moment this split started.

## What is true today

`src/server.ts` is 3,220 lines, down from 6,276. `src/tools/` holds
`batch.ts`, `doctor.ts`, `execute.ts`, `fetch.ts`, `find.ts`, `graph.ts`,
`index-content.ts`, `insight.ts`, `ops.ts`, `pack.ts`, `purge.ts`, `read.ts`,
`search.ts` and `upgrade.ts`, plus `shared/{deps,state}.ts`. No ctx_* tool
registers inline any more: `src/server.ts` builds the `ToolDeps` values and
calls the `register*` functions in order, and every handler lives in its own
module. `ctx_pack` is the first tool to have been *born* in `src/tools/`
rather than extracted into it — the seam is now the default place a tool goes,
not the destination of a migration.
