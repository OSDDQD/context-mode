# ADR-0008 — The economics of escalation

**Status:** Accepted
**Date:** 2026-08-20

## Context

A live session refused a `Read` of a **2.4 KB** file. The refusal text was about
a kilobyte, the standard refusal threshold is 50 KB, and the session had been
pinned to the top step of the escalation ladder for hours: *"93 unrouted heavy
calls, 619.9 KB"*.

Taken apart, that one symptom was seven separate defects with one thing in
common: **the price of an intervention was never compared with the price of the
bytes it was defending against**, and the counter that set the price was being
filled by behaviour the plugin itself calls correct.

- The DENY step refused any unbounded `Read` at or above the *telemetry*
  collection floor (2000 bytes). Refusing a 2.4 KB file costs ~1 KB of reason
  text plus a round trip, and the caller then almost always takes the escape
  hatch and reads the file anyway — 3.4 KB spent to save nothing.
- The ladder only ever climbed. Nine unrouted calls and the session was refused
  for the rest of its life, however carefully it behaved afterwards. Long
  sessions are the ones this plugin exists for.
- The tally counted bounded reads (the refusal text promises in writing that
  those "go through unchanged"), `git` commands (the routing block tells the
  agent Bash is the right surface for those), calls the user had explicitly
  confirmed, and **subagent** reads — whose bytes never enter the main window at
  all, since a subagent's context is discarded and only its report returns.
- Advisory decisions — where the read is ALLOWED and the file enters the window
  whole — were stamped `bytesAvoided: st.size`, so `ctx_stats` reported a saving
  for bytes that were never saved.
- The redirect marker was one file per session, written by every PreToolUse and
  consumed by whichever PostToolUse ran next. Claude Code runs tool calls
  concurrently.
- The full fine print was reprinted on every refusal.

## Decision

Four invariants, distributed across `hooks/core/routing.mjs`,
`hooks/*/posttooluse.mjs` and `src/session/analytics.ts`. They are recorded here
because no single file holds them.

### 1. An intervention must cost less than what it prevents

Enforcement gets its own floor, separate from the telemetry floor:

```
escalationDenyFloorBytes(env) = max(16384, CONTEXT_MODE_ESCALATION_DENY_MIN_BYTES)
```

16 KB is an 8–16× margin over the refusal's own price, so a refusal still pays
off when the caller ignores the redirect half the time. The env var can only
RAISE it: a lower enforcement floor is the setting that produced the incident,
and no session state makes refusing a 3 KB read profitable.

The collection floor (`CONTEXT_MODE_MISSED_REDIRECT_MIN_BYTES`, 2000) is
untouched — it decides what is worth *recording*, which is a different question.

The step below gets the same treatment at half the number
(`escalationAskFloorBytes` = 8 KB, derived from the refusal floor so the two
cannot drift into the wrong order). A confirmation prompt is cheaper than a
refusal — it skips the wasted turn and the retry round trip — but its reason
text enters the conversation either way, and the common answer is yes, which
buys nothing. The Read branch on the upper steps had **no** size test at all,
so a session at `ask` was prompted for a 500-byte file. Below 8 KB the ladder
now keeps only its advisory, which is a few hundred bytes and, since §5, fires
its explanation once.

### 2. The level is a function of recent behaviour, not of session history

`escalationLevel` reads a **sliding window**
(`CONTEXT_MODE_ESCALATION_WINDOW_MS`, default 15 minutes), not the session
total. A window with no heavy call publishes nothing, its timestamp goes stale,
and the session returns to silence on its own — no confirmation, no command, and
no second "credits" counter to drift out of step with the first.

Session totals are still counted and still quoted: **the notice says what the
session has spent; the ladder prices what it is doing now.**

The previous manifest in `routing.mjs` named monotonicity as the property and
asserted it in the tests. That is explicitly repealed. A session cannot
apologise to a number that never goes down.

### 3. Sanctioned behaviour is recorded, never charged

Three things the plugin or the user said yes to:

| Case | Treatment |
|---|---|
| `Read` with `offset`/`limit` | **not an event at all** — the advice was followed exactly |
| Bash the routing rules route TO Bash (`git`, `npm install`, `mkdir`, `mv`, `rm`, `cd`, `ls`, and anything `isStructurallyBounded`) | `sanctioned_heavy` |
| A call the user confirmed at an `ask` prompt | `sanctioned_heavy` |
| Any call made inside a subagent (`agent_id` present) | **not an event at all** — those bytes are not in this window |

`sanctioned_heavy` carries the same `data` line as `missed_redirect` and stays
visible in `ctx_stats`. Two exclusions keep it out of the two places that would
charge for it, and **they have to move together**:

- the ladder filters on the event **type** (`readMissedRedirectTally`);
- the adherence denominator filters on the event **category**
  (`analytics.ts`, `category = 'missed-redirect'`).

If one is changed without the other, `ctx_stats` and the ladder start describing
different sessions, silently.

The subagent test is `agent_id`, **never** `agent_type`. Claude Code's own hook
schema: *"agent_type … Present when the hook fires from within a subagent
(alongside agent_id), **or on the main thread of a session started with
`--agent`**"*. The old `agent_id ?? agent_type` test therefore reported
"subagent" for every call in an `--agent` session and silently disabled
enforcement there.

### 4. A saving may only be claimed for bytes that did not arrive

`bytesAvoided > 0` survives on real refusals and nowhere else. An allowed
unbounded large read is a miss and is counted as one, whatever advice was
attached to it.

Markers are per call. `tool_use_id` is present in both hook payloads and is the
key; where a host does not supply one, the call is fingerprinted from its name
and canonicalised arguments. Three shapes, because they have different
lifetimes:

- `c-<callKey>` — a call that will have its own PostToolUse, which consumes
  exactly its own marker;
- `d-<pathKey>` — a refusal, which has no PostToolUse; swept by a later one once
  no matching call can still be in flight, and **deleted outright** when
  PreToolUse lets the read-before-edit retry through, because at that moment the
  bytes are entering the conversation and the saving is not real;
- `a-<callKey>` — an `ask`; its survival to PostToolUse is the user's yes,
  because a declined call never runs.

### 5. The fine print is worth saying once

Full refusal text and full escalation note: once per session each. After that,
one line carrying only what the caller has to act on — the word `redirected`, a
ready replacement call, the escape hatch and its deadline. ADR-0003's CASE A
rubric holds for the short form too, and its contract test still passes: the
word and the `ctx_*` call share a line.

## Consequences

- A session at DENY reads a 2.4 KB file without a refusal and without a prompt
  — it gets the advisory — and a 20 KB one with a refusal.
- Fifteen quiet minutes return any session to silence.
- An `Explore` subagent reading 500 KB moves nothing in the main session.
- `git diff` at 15 KB shows up in `ctx_stats` and leaves the ladder alone.
- Deny savings are now recorded by a **later** PostToolUse rather than the next
  one, since a refusal marker is only swept once it is old enough that no
  matching call can still be in flight. A session that ends immediately after a
  refusal may not record that refusal's saving. Accepted: the alternative is
  claiming savings for bytes a retry is about to deliver.
- The `escalationLevel(tally, env, now)` signature gained a third parameter so
  the window is testable without fake timers.

## References

- `docs/plans/escalation-economics.md` — the incident, the seven defects, the phases
- ADR-0003 — routing deny reasons (the CASE A rubric the short form still satisfies)
- `docs/plans/tool-adherence.md` D0 — why the version has to move before any of this ships
