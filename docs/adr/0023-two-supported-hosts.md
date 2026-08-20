# ADR-0023 — Two supported hosts

**Status:** Accepted
**Date:** 2026-08-20
**Source:** [FORK-CHANGES §37](../FORK-CHANGES.md) (commits `15a02cf`, `6aaf312`)

## Context

The plugin supported seventeen client platforms. Two of them — Claude Code and
Codex CLI — are the ones anyone working on this fork actually runs.

The cost is not the code, it is the multiplier. Every change to routing had to
be reasoned about seventeen times — seventeen hook wire formats, seventeen
config locations, seventeen session-id conventions — and verified on two. The
other fifteen were maintained from documentation and upstream source reading,
which is exactly the regime where a change looks right and is not.

This is measurable rather than aesthetic. The delivery failure recorded in
[ADR-0013](0013-tracked-bundles-are-the-running-code.md) cost two full waves to
a version number that **eleven manifests** had to agree on — and eight of those
eleven belonged to hosts nobody could test.

## Decision

**Support Claude Code and Codex CLI. Remove the other fifteen** — Gemini CLI,
VS Code Copilot, JetBrains Copilot, GitHub Copilot CLI, Cursor, OpenCode,
KiloCode, OpenClaw, Kimi Code, Qwen Code, Antigravity (IDE and `agy`), Kiro,
Zed, Pi and OMP.

**The removal is one commit that only deletes.** 207 files, 36,541 deleted
lines, and not one line added. Restoring any host is a revert of that commit and
nothing else, and a conflict with upstream resolves as "our deletion wins"
rather than line by line. The tree does not compile at that commit,
deliberately; the couplings are untangled in the one that follows.

**Surfaces shrink with the hosts, not just the adapters.** `version-sync.mjs`
went from eleven manifests to three plus `package.json` itself — every removed
entry was a place the number could be forgotten. `package.json` lost its
host-specific blocks, an install script, `files[]` entries, keywords, and a
`main`/`exports` pair pointing at build outputs whose sources no longer exist.
The debug script lost a fourteen-host detection ladder that was reporting on
paths this fork can no longer write. The README's install section went from
sixteen `<details>` blocks to two, its matrices from eighteen columns to three;
`docs/platform-support.md` went from 955 lines to 280 and now states plainly
that one paradigm is left — both remaining hosts speak JSON over stdin and
stdout, which is the paradigm the hooks were written against.

**Tests narrow by deriving, not by thinning.** `enumerateAdapterDirs` was
asserted against a hardcoded list of seventeen names and five hand-picked
paths; it is now cross-checked against `getSessionDirSegments` in both
directions, for every adapter — strictly more coverage than the sample, and no
editing when a host is added. `tests/scripts/version-sync.test.ts` keeps every
assertion it derives from `TARGETS` and gained a floor (`TARGETS.length >= 3`),
because a list that shrank to nothing would make the whole suite pass by having
nothing left to check.

**History is not rewritten.** The removed hosts stay in this fork's changelog
entries: they were true when written, and a history edited to match the present
tells you nothing about how it got here. Where an existing decision record cited
a removed host as evidence, it gains a **dated amendment** rather than an edit —
[ADR-0006](0006-execution-isolation-posture.md) §3 is the case: its host-gating
argument named VS Code and JetBrains, and an ADR whose evidence is edited
underneath it stops being a record.

## Alternatives rejected

**Keep the fifteen, maintained from documentation.** That was the arrangement,
and the two-wave delivery failure is what it cost. Support that cannot be
verified is a claim, not a feature.

**Deprecate rather than delete.** A deprecated adapter still appears in the
manifest list, still needs the version number, still shows up in the test matrix
and still invites a bug report. The whole cost being removed is the multiplier.

**Delete gradually, host by host.** Fifteen commits, each leaving the tree in a
half-supported state, and none of them revertible as a unit.

**Rewrite the changelog to match the surviving hosts.** Deletes the reasoning
trail this fork is documented by.

## Consequences

- Restoring a host is `git revert 15a02cf` plus the follow-up commit's
  untangling — a bounded, reviewable operation.
- Three manifests carry the version, down from eleven, which materially reduces
  the surface behind [ADR-0013](0013-tracked-bundles-are-the-running-code.md).
- Ownership metadata was retargeted in the same pass — see
  [ADR-0012](0012-fork-identity-and-upgrade-source.md), including the
  `ctx_upgrade` inline fallback that still cloned upstream by literal URL.
- Unverifiable marketing claims went with it: a logo wall and a Hacker News
  badge that were not this fork's to make, and a stats workflow that was
  measuring upstream's package and purging someone else's CDN path while the
  file it committed here was read by nothing.
- Three counts that were quietly wrong in the same file set were corrected
  (advertised sandbox languages, the host list in the package description, and a
  data-verification table sourcing rows from a deleted file).
