# ADR-0009 — Capture queues: hooks append, the server drains

**Status:** Accepted
**Date:** 2026-08-20 — recorded retrospectively; the mechanism shipped earlier
**Source:** [FORK-CHANGES §5, §14, §15, §20](../FORK-CHANGES.md)

## Context

Three things worth capturing happen where the knowledge base is not open:

- every file the agent writes or edits (without them, `ctx_search` over the
  source tree returns nothing until something has been piped through a ctx_*
  tool — precisely the sessions where it would help most);
- a subagent's transcript, which is discarded when the subagent ends and takes
  every tool output it saw with it, leaving only the final report;
- the end of a session, after which nothing else in this project will run.

All three are observed by hooks. A hook runs in front of or behind **every**
tool call, on a budget measured in milliseconds, and it is a separate process
each time. Opening the content store there means resolving `better-sqlite3`,
opening a WAL database and writing to it on the hot path of the whole session —
paid on every call to inform the few that matter.

Indexing at capture time is not affordable either: seeding the code index from
`git ls-files` measured **1.3 s for 200 files** on this repository, which is far
more than any one tool call can absorb.

## Decision

**One shape for all three: the hook appends a line, the server drains it.**

| Stage | What runs | Cost |
|---|---|---|
| capture | a hook appends one line (a path, or one JSON object) to a queue file | an `appendFileSync`; no SQLite, no store |
| drain | the MCP server processes the queue the next time it opens the content store | amortised, bounded per pass |
| close | `SessionEnd` spawns a detached `context-mode drain --project <dir>` | off the session's clock entirely |

`drain` is also a plain CLI command, so the index can be warmed by hand.

**The seed is amortised, not blocking.** `bootstrapCodeIndex()` computes the
plan once per project from the repository's own file list — no `.gitignore`
parsing, no walk into `node_modules`, nothing untracked — and works through a
batch per store open. The remaining plan is persisted, so a restart resumes
rather than restarting.

**Deletions are evicted.** A file that was indexed and later deleted keeps
answering searches otherwise, which is the worst failure a retrieval layer has:
a stale answer is indistinguishable from a correct one until the agent acts on
it. `pruneDeletedCodeSources()` sweeps `code:` sources whose file is gone, and a
queued file that vanished before the drain evicts its source instead of being
skipped.

**Queues are project-scoped, and a drain claims only what is its own.** The
queue file lives in a sessions directory shared by every project on the machine
— hooks run wherever the agent is and have no store to key off. So the drain
indexes only paths inside its own `projectDir` and **hands the rest back** to
the shared inbox for the owning project's server; overflow parks in a
per-project backlog so two concurrent drains cannot steal each other's work.
Subagent entries carry no path to filter on, so the `SubagentStop` hook stamps
`projectDir` on the entry itself. `pruneForeignCodeSources()` cleans up what
leaked before this rule existed (measured in this repository's own store: **78
`code:` sources pointing at other repositories**).

**A subagent digest is indexed only when the agent can be isolated.** The drain
resolves the agent's own transcript (dedicated `subagents/agent-<id>.jsonl`
first, sidechain filtering on the legacy inline layout) and refuses to index the
main conversation when it cannot tell them apart.

## Alternatives rejected

**Write to SQLite from the hook.** Correct data, wrong place: it taxes every
tool call in the session to serve the few that produce capture-worthy output,
and it puts the native module on a path that must never fail loudly.

**Index synchronously inside the tool call that triggers it.** 1.3 s for the
seed, and a variable, invisible tax on whichever call happened to be first.

**Drain lazily and only lazily.** The bill then lands on the first tool call of
the *next* session, and is never paid at all if the project is not opened again.
The detached `SessionEnd` drain is the same work moved to idle time.

**One global queue consumed first-come.** This is what existed, and it is how a
project's files ended up in another project's index. Handing entries back costs
one file rewrite and removes the whole class.

## Consequences

- Every stage has an off switch: `CONTEXT_MODE_CODE_INDEX`,
  `CONTEXT_MODE_CODE_INDEX_BOOTSTRAP`, `CONTEXT_MODE_SUBAGENT_CAPTURE`,
  `CONTEXT_MODE_SESSION_END_DRAIN`, and
  `CONTEXT_MODE_CODE_INDEX_PROJECT_SCOPE=0` restores the shared behaviour.
- Capture is at-least-once and idempotent by construction: the store's own
  content-hash cache ([ADR-0007](0007-content-hash-index-cache.md)) makes a
  re-drained entry a no-op.
- A crash between append and drain loses queue lines, never database rows. That
  is the intended direction of failure.
- Indexed code is subject to the screening rules in
  [ADR-0019](0019-index-time-credential-screening.md) — the queue is a path
  into a durable, searchable store.

## What is true today

The queue is no longer the only path in. The filesystem bus
([ADR-0021](0021-retrieval-consolidation.md)) re-indexes changed files and
evicts deleted ones from a single watcher subscription, calling the same
`code-index` entry points. The queue remains the capture path for hosts and
events the watcher does not cover, and the drain remains the place where
project ownership is decided.
