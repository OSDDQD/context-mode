# ADR-0022 — Honest accounting for what routing saves

**Status:** Accepted
**Date:** 2026-08-20 — recorded retrospectively; the pieces shipped earlier
**Source:** [FORK-CHANGES §2, §34, §36](../FORK-CHANGES.md)
**Relates to:** [ADR-0004](0004-stats-strict-compression-formula.md),
[ADR-0005](0005-stats-scope-labels-and-containment.md),
[ADR-0008](0008-escalation-economics.md)

## Context

The plugin's headline claim is a number: bytes kept out of the context window,
converted to tokens, converted to money. Four things were wrong with how that
number was produced, and each of them flattered it:

1. **Every figure stood on `bytes / 4`.** Measured against published rank
   tables, that constant understates JSON by 25%, `ls -laR` by 45% and base64 by
   61%, and overstates Russian prose by 59% — while being nearly right on
   TypeScript, which is what anyone spot-checking it would have tried.
2. **Nothing was ever subtracted.** If the model read a file in full after a
   compressed answer had already covered it, the compression was still booked as
   a saving. The bytes arrived anyway; the plugin charged for them twice.
3. **Nothing measured whether routing happened at all.** `ctx_stats` could say
   what routing *saved* and what it *missed*, never what share of the heavy work
   it was given — the position retrieval was in before
   [ADR-0017](0017-retrieval-quality-gate.md) made quality a number.
4. **A hardcoded fallback asserted the headline.** `analytics.ts` carried
   `lifetimeTokensWithout * 0.02` — a 98% saving claimed rather than measured.

## Decision

**No number in the report may be more confident than its measurement.**

### 1. Token counts are fitted, not assumed

`src/session/tokenizer.ts` replaces `bytes / 4` with coefficients fitted against
published `o200k_base` / `cl100k_base` rank tables over 4.1 MB of this
repository, real command output, machine payloads and prose in fifteen
languages. Held-out error per 4 KB chunk: **4.5% / 4.7%** versus 18.7% / 15.3%
for `bytes/4`; on unseen command output, 6.8% versus 22.0%.

Sites that hold only an aggregate byte count use the measured 3.487 bytes/token,
and `bytesFromTokens` is its **exact inverse**, so both sides of every ratio
stay on one basis and all percentages are unchanged. No new dependency: an exact
BPE encoder is used only if one already happens to be installed.

### 2. Returns are subtracted from the savings

`src/session/reuse-detector.ts` pairs a compressed delivery naming source X with
a later full read of X inside **both** a step window (20 tool turns) and a time
window (15 minutes). Both, because `created_at` has second resolution and every
event of one hook fire shares a timestamp — so step distance is the only
reliable ordering — while step distance alone would pair a search with a read
three hours later.

The returned bytes are deducted from `bytes_avoided` **before** any token
conversion, so every downstream consumer inherits the correction with no formula
change, and `ctx_stats` prints what was taken off. Above a 30% return rate the
search gateway hands back full text instead of snippets: compressing into a
re-read is a double charge.

### 3. Adherence is a ratio, and every honest rule costs it flattery

`ctx_stats` reports routed heavy calls against all heavy calls for the
conversation. Four rules:

- **The threshold is named in the line.** A share of "heavy calls" cannot be
  read without it.
- **It cannot go below the collection floor.** The hook only records an unrouted
  call above `CONTEXT_MODE_MISSED_REDIRECT_MIN_BYTES`, so measuring under that
  line would drop unrouted calls out of the denominator while routed ones stayed
  in — a ratio that flatters by construction. A lower setting is clamped up, and
  the report says it was.
- **Nothing crossed the line is `no data`, not `0%`.** A quiet session and a
  session that leaked everything must not print the same number.
- **Calls of unknown size get their own line** rather than being spread over the
  denominator.

**The numerator is assembled from what is actually attributable.** `sandbox`
events look like the better source and are not: they are written against
`getLatestSessionId()` rather than the calling session, so they land under
whichever session was newest in the database — measured, a session with nine
ctx_* calls in `tool_calls` had zero sandbox rows of its own — and they carry
only the bytes returned, not the payload handled. `tool_calls` has no per-call
size either, so heaviness there is decided by the session's own per-tool average
and **every call sized that way is counted and named as an estimate**. That
average is of bytes *returned*, which is smaller than what was handled, so the
bias is downward: the metric undercounts routed calls rather than inventing
them.

Meta commands (`ctx_doctor`, `ctx_stats`, `ctx_upgrade`, `ctx_purge`,
`ctx_insight`) are excluded from the numerator, or a session could raise its
adherence by running diagnostics.

### 4. Telemetry exists so thresholds are tuned on data

Any native data-fetching tool returning more than the collection floor without a
redirect marker records a `missed-redirect` event, and `ctx_stats` prints what
slipped through, by tool, with the commands. Nothing is printed when the session
recorded none. This is what makes every threshold in
[ADR-0008](0008-escalation-economics.md) an argument about measured behaviour
rather than about intuition.

### 5. Asserted numbers are removed, and the claim is traced to its corpus

The 98% fallback is deleted (nothing consumed it — its only reader had no call
sites). The savings claim is now stated identically in the manifest, the
marketplace entry and the README, and traced: 315 KB of raw output across the 14
`ctx_execute_file` scenarios comes back as 5.4 KB.

## Alternatives rejected

**Keep `bytes / 4` and call it an estimate.** It is not uniformly wrong; it is
wrong in a way that correlates with content type, so it distorts comparisons
between tools rather than adding noise.

**Bundle an exact tokenizer.** A dependency for a number that is already within
5%, on a path that runs on every event.

**Use `sandbox` events as the adherence numerator.** Wrong session, wrong bytes.
Fixing that means changing `emitSandboxExecuteEvent` to record the calling
session and the payload; until then the report says which of its numbers are
averages.

**Ignore returns.** The single largest source of overstatement, and the one a
sceptical reader finds first.

## Consequences

- Some reported numbers went **down**. That is the point.
- `ctx_stats` distinguishes measured figures from averages in its own text, and
  states its basis ([ADR-0005](0005-stats-scope-labels-and-containment.md)).
- Sanctioned behaviour is recorded but not charged, and the two exclusions that
  implement it have to move together — see
  [ADR-0008](0008-escalation-economics.md) §3.
- The remaining known gap is `emitSandboxExecuteEvent`'s session attribution.
  It is written down here rather than left for the next reader to rediscover.
