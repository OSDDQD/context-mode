# ADR-0025 — The rung that asked

**Status:** Accepted
**Date:** 2026-08-20

## Context

A live session, six unrouted heavy calls in, met this on an ordinary `sed`:

> context-mode: 6 unrouted heavy calls so far this session, 121.8 KB of it
> straight into your context window. `ctx_batch_execute(commands, queries)`
> indexes this command's output and returns only the sections that answer your
> questions. Confirm it when you mean to read the output yourself.

The user's question was the right one: *what is the good answer here?* Say no
and the turn ends; say yes and the whole output lands in the window — which is
the exact outcome the ladder exists to price.

That is not a rhetorical complaint, it is arithmetic, and both answers lose:

- **"No"** reaches the model as a bare permission refusal. The hook's reason
  text is shown to the *user*, not attached to the tool result the model sees,
  so the model gets "the user doesn't want to proceed" with no replacement call
  in it — and the turn stops. The work has to be restarted by hand.
- **"Yes"** puts the full output in the context window, and then, by ADR-0008
  §3, records the call as `sanctioned_heavy`: consent means "record it, do not
  hold it against the session". So the bytes arrive *and* the ladder is told
  not to count them. The prompt's most likely answer is strictly worse than the
  leak it was pricing — it costs a kilobyte of reason text, a round trip, the
  bytes, and the evidence.

The step below (advisory) and the step above (refusal) both cost a fraction of
that and neither needs a human.

The `ask` step was designed for a real case, and Grep is it: an unbounded
literal sweep is something `ctx_find` genuinely cannot reproduce, because it
ranks where Grep enumerates. There the human is being asked something only a
human knows — *do you want every occurrence, or the place it lives?* On Bash
there is no such question. `ctx_batch_execute` runs **the same command**, in the
same shell, and differs only in where the output lands. Nothing is traded away
by not asking.

## Decision

**On `Bash`, the escalation ladder climbs silence → advisory → redirect.** From
the `ask` rung upward the decision is a refusal carrying the ready
`ctx_batch_execute(...)` call, the same text the DENY rung already used; the
`ask` rung has nothing left to add, so both rungs return it.

Three properties follow, and they are what the tests pin:

1. **A rung that blocks must hand back the replacement.** A refusal reaches the
   model as reason text, so the redirect travels with it and the turn
   continues. A prompt does not have that channel, which is why "No" was
   destructive.
2. **No saving is claimed.** `bytesAvoided: 0` — the size is unmeasurable
   before the run, and PostToolUse takes the real number from the replacement
   (ADR-0022).
3. **No replacement, no enforcement.** With the MCP server unavailable
   (`mcpRedirect` returns null) the rung falls through to the advisory, never to
   a prompt. Asking a caller to confirm a call against an alternative that is
   not running is asking a question with one legal answer.

`Read` keeps its prompt: the read-before-edit escape hatch means a confirmation
there is sometimes exactly right, and the ask floor (ADR-0008 §1) already keeps
it off small files. `Grep`/`Glob` keep theirs for the reason above, and
`CONTEXT_MODE_GREP_ASK=0` still turns it off.

`CONTEXT_MODE_BASH_ESCALATION_ASK=1` restores the old prompt for an operator who
wants that gear back — the fork's rule that every behavioural default carries an
env switch home.

## Consequences

- Claude Code and Codex now agree at every rung of the Bash ladder. The extra
  gear Claude Code has — the confirmation prompt — belongs to Grep alone, so
  `tests/hooks/platform-parity.test.ts` compares kind *and* text the whole way
  up instead of special-casing one step.
- The session loses a way to say "yes, I really want to read this one". The
  replacement is the quiet window: 15 minutes without a heavy call and the
  ladder is silent again (ADR-0008 §2), plus the thresholds themselves
  (`CONTEXT_MODE_NUDGE_AFTER_CALLS` / `_AFTER_BYTES`). Both were already the
  documented way to move the ladder; neither requires answering a prompt.
- Sessions that leak steadily now hit a refusal one rung earlier than before on
  Bash. That is the intended trade: the refusal is cheaper than the prompt it
  replaces, and unlike the prompt it leaves the caller with a call it can make.

## Amendment to ADR-0008

§1 priced the `ask` step as "cheaper than a refusal — it skips the wasted turn
and the retry round trip". That accounting was incomplete on two counts: the
common answer does not merely "buy nothing", it admits the bytes *and* removes
them from the tally via `sanctioned_heavy`, and the uncommon answer ends the
turn without handing back a replacement. The conclusion held for `Read` and
`Grep`, where the prompt asks something a human actually decides. It did not
hold for `Bash`, and §1's own rule — an intervention must cost less than what it
prevents — is what removes it there.
