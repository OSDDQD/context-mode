# ADR-0011 — Host memory is indexed, never injected

**Status:** Accepted
**Date:** 2026-08-20 — recorded retrospectively; the fix shipped earlier
**Source:** [FORK-CHANGES §9](../FORK-CHANGES.md)

## Context

Two different stores both called themselves "memory", and they were not talking
to each other:

| | Path | Reality |
|---|---|---|
| `adapter.getMemoryDir()` — what `searchAutoMemory` read | `<config>/memory/<sha256(projectDir)[:16]>` | **does not exist on a normal install** |
| `getLifetimeStats()` — what `ctx_stats` counted | `<config>/projects/<slug>/memory/` | correct |
| Claude Code — where memory is actually written | `<config>/projects/<slug>/memory/` | 62 files present |

So `ctx_stats` reported "52 preferences picked up across 7 projects" while
`ctx_search` could not retrieve a single word of them. The system claimed a
memory it could not read — the specific failure where a report and a capability
disagree and only the report is visible.

Two smaller defects sat behind it. Auto-memory was wired only to
`sort: "timeline"`, so the default relevance mode could not answer "what did we
decide about X" from the very files written to answer it. And slugging is not
`/` → `-`: the host also rewrites dots and underscores, so
`/home/u/projects/casino_front` is stored as `-home-u-projects-casino-front`.

## Decision

**1. Resolve the real path, by trying rather than by assuming.**
`resolveHostMemoryDirs()` tries three strategies in order — plain slug, folded
slug, then a normalised scan of `projects/` that matches whatever naming rule the
installed host version used. Verified against every real project directory on
the author's machine.

**2. Search it in relevance mode, appended rather than fused.** Memory hits are
appended to the result list (capped at 2, skipped when the caller passed a
`source` filter) rather than fused into the ranking. A curated fact is a
different kind of hit than a captured chunk, and it must not evict a result the
caller asked for.

**3. Index it into FTS5** under `memory:<name>` on first store open. Scanning
alone cannot buy what indexing does: `query_scope: "global"` reaches it, the
semantic layer can match a paraphrase or a cross-lingual query against it, and
the content hash flags a memory as stale after an edit. Scoped to the current
project. `CONTEXT_MODE_INDEX_HOST_MEMORY=0` disables it.

**4. Indexing only — never injection, never writes.** The host already loads
`MEMORY.md` into every session; re-injecting those bytes would spend context to
duplicate what is already there. And nothing writes *into* host memory: that
store stays curated by its owner.

## Alternatives rejected

**Inject relevant memory into the session prompt.** Doubles bytes the host has
already spent, on a surface ([ADR-0014](0014-standing-context-budget.md)) where
everything is paid every session.

**Fuse memory hits into the ranking.** A curated file is short and highly
topical, so it wins RRF positions out of proportion to what it answers, and it
displaces results the caller explicitly searched for.

**Write conclusions back into host memory.** The plugin would then be editing a
file the user owns and the host reads on every start. The knowledge base is the
plugin's own store; host memory is not.

**Guess the slug with one rule.** The rule is the host's, it has changed, and a
wrong guess degrades to silence — the exact failure this ADR exists to close.

## Consequences

- The path fix targets Claude Code. Other adapters keep their own
  `getMemoryDir` implementations, whose correct host paths were not verified;
  they were deliberately left untouched. (Of those, only Codex remains — see
  [ADR-0023](0023-two-supported-hosts.md).)
- `ctx_stats` and `ctx_search` now describe the same files. A count in the stats
  report implies retrievable content, which is what a reader assumes anyway.
- Memory content lands in a durable searchable store and is therefore subject to
  the screening rules in [ADR-0019](0019-index-time-credential-screening.md).
