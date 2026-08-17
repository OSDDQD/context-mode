# ADR-0005 — Stats scope labels and containment

**Status:** Accepted
**Date:** 2026-08-18
**Extends:** [ADR-0004 — Stats strict compression formula](0004-stats-strict-compression-formula.md)

## Context

`ctx_stats` could print, on the same screen:

```
This chat: 6.9 MB kept out · …
All your work: 6.7 MB kept out · …
```

A subset larger than the set that contains it. Two independent causes, both in
Sections 3–4 of the narrative renderer — Section 1's compression formula, which
ADR-0004 fixes, is not involved and is not touched here.

**1. The narrow number was not narrow.** `getConversationWindowStats`
(`src/session/analytics.ts`) pools *the whole worktree* on purpose: a
conversation fans out into sub-agents and sandbox sessions that each get their
own `session_id` but share the cwd hash, and their retrieval was genuinely kept
out of the user's window. Crediting them to the conversation is right. Calling
the result "This chat" is not: it is a project-scoped number wearing a
session-scoped label.

**2. The wide number counted less.** `scanOneAdapter` reports
`contentBytes: 0` — the multi-adapter lifetime scan never walks the content
stores. So the wide scope omitted a category the narrow scope included, and on
a content-heavy project the narrow number could simply be bigger.

## Decision

**Three scopes, each labelled for what it measures.**

| Row | Source | Meaning |
|---|---|---|
| `This session` | `sessionKeptOutBytes` — this `session_id` alone | what this conversation itself kept out |
| `This project` | the worktree pool (unchanged number) | this conversation and the agents it spawned |
| `All your work` | lifetime / multi-adapter scan | every project on disk |

`This session` is a new row. Nothing that was previously displayed is removed or
reduced; the number that used to be labelled "This chat" is still shown, under
the name it always deserved.

**Containment by raising the wider scope.**

```
projectShown  = max(projectRaw, sessionBytes)
lifetimeShown = max(lifetimeRaw, projectShown)
```

Never by lowering the narrower one. This is the same direction as the existing
monotonic-growth invariant for these counters ("stats only go up"): a number a
user saw last week must not shrink this week. Raising the wider scope is also
the honest correction for cause 2 — the lifetime scan is *undercounting*, and
`max` is a floor on that undercount, not an inflation of it.

The lasting fix for cause 2 is to make `scanOneAdapter` walk the content stores.
Until it does, `lifetimeShown` states a lower bound rather than a contradiction.

**Footprint is not savings.** The disk cost of the knowledge base
(`contentStoreUsage()`) gets its own row, worded so it cannot be read as more
bytes saved:

```
Knowledge base on disk: 216.5 MB across 328 stores — this is what it costs to keep, not what it saved.
```

**The dollar block states its basis.** The measured headline stays. Added:

```
Basis: context-mode's own byte counters (what it kept out, priced at list rates) —
not an A/B measurement against a run without it.
```

The 10-developer projection moves behind `CONTEXT_MODE_STATS_TEAM_EXTRAPOLATION=1`
and, when shown, says outright that it is arithmetic on one person's usage. The
whole cost section can be switched off with `CONTEXT_MODE_STATS_COST=0`.

## Consequences

- `RealBytesStats` gains an optional `sessionKeptOutBytes`, set only by
  `getConversationWindowStats`. Existing callers are unaffected.
- Tests that pinned `This chat:` now pin `This project:`; the team-scale test
  now pins the opt-in behaviour.
- `AnalyticsEngine.contextSavingsTotal` is marked `@deprecated` — a stub with no
  callers, kept only so an external consumer does not break.
- A user who wants the old marketing framing sets
  `CONTEXT_MODE_STATS_TEAM_EXTRAPOLATION=1`.

## Alternatives rejected

**Clamp the narrow number to the wide one.** Displays a smaller number than the
counters justify, breaks monotonic growth, and hides the real defect (the wide
scan's blind spot) instead of naming it.

**Drop the worktree pool and report only this `session_id`.** Loses the
sub-agent fan-out, which is the largest genuine saving the plugin produces —
and the reason the pool exists.

**Fix `scanOneAdapter` to count content bytes in this change.** Correct, and out
of scope here: it means walking every adapter's content DB on every `ctx_stats`
call, which needs its own budget and its own measurement.
