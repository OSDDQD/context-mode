# ADR-0012 — Fork identity, release versioning and the upgrade source

**Status:** Accepted
**Date:** 2026-08-20 — recorded retrospectively; the mechanism shipped earlier
**Source:** [FORK-CHANGES §10, §37](../FORK-CHANGES.md)

## Context

`ctx upgrade` cloned `https://github.com/mksglu/context-mode.git`
unconditionally and rsynced it over the install. Run from a fork install, that
is not an upgrade — it is a **silent downgrade that deletes every change in this
fork**, from a command the plugin advertises in its own skill. The marketplace
step had the same shape: `git reset --hard origin/HEAD` in a clone that might
track a different repository than the one being upgraded from.

Underneath it sat an identity problem. Fork and upstream ship the same
`version`, so "which tree is running?" had no answer — the first question that
matters when a fork-only feature appears to be missing. The same collision made
every fork release invisible to the upgrade itself: `ctx upgrade` cloned the
right repository, compared `1.0.169` against `1.0.169`, reported "already on
latest" and installed nothing. Caught while running it against a tree four
commits ahead.

And the ownership metadata was inherited rather than chosen: `repository`,
`homepage`, `bugs`, the issue templates, the `git clone` and
`/plugin marketplace add` lines in the README, and the funding file all pointed
at upstream. A user who followed any of them filed a report about this fork's
code in someone else's tracker.

## Decision

**1. The install states what it is.** `package.json` carries a `fork` block
(`name`, `repo`, `upstream`, `version`) and `doctor` prints it —
`context-mode v1.0.173 · fork OSDDQD/context-mode rev 4` — plus the repository
it would upgrade from.

**2. Identity is the pair `(version, fork.version)`.** `isUpgradeAvailable()`
compares both, so an upstream bump and a fork release are each detected, and the
version line names both halves — `v1.0.169 (fork rev 1) → v1.0.169 (fork rev 2)`
was the first release this made visible. An install
predating the marker treats a missing revision as `0`, so it still sees the
first marked release.

**Releasing this fork therefore means bumping `fork.version`** — the role
`version` plays upstream. Skip it and installs keep reporting themselves up to
date while running older code.

**3. The upgrade source is resolved from what the install actually is**, in
order: `CONTEXT_MODE_UPGRADE_REPO` (operator override) → the `fork` block in the
installed `package.json` → the git `origin` of the installed tree → upstream,
for an unforked install. The marketplace clone is reset only when its `origin`
matches the resolved source; otherwise it is skipped with an explanation rather
than quietly reinstalling another tree's plugin metadata.

**4. Every path takes the ladder, including the ones that look like edge cases.**
`resolveUpgradeRepo()` was written for exactly this failure, and for a while it
was wired only to the CLI path while the inline fallback in `src/server.ts` kept
a literal upstream URL. That branch is not an edge case — its own comment says
"neither CLI file exists (e.g. marketplace installs)", which is how this plugin
is installed. A mechanism that exists, is correct, and is wired to the branch
that does not matter is the same class of defect as
[ADR-0013](0013-tracked-bundles-are-the-running-code.md).

**5. Ownership fields name the fork; credit stays where credit is the point.**
`repository`, `homepage`, `bugs`, the issue templates, the install commands and
the marketplace entry resolve to `OSDDQD/context-mode`. Upstream keeps
`contributors`, the "Fork of mksglu/context-mode" line in both plugin
descriptions, `docs/UPSTREAM-CREDITS.md`, and every issue link that cites the
report a fix came from. The funding file is removed rather than retargeted —
this fork asks for nothing, and a Sponsor button that renders an error is worse
than none.

## Alternatives rejected

**Give the fork its own version numbering.** It makes "how far behind upstream
are we" unanswerable, and every upstream merge would have to reconcile two
number lines. The pair keeps upstream's number meaning what it means.

**Detect the fork from the working directory or the git origin alone.** The
origin is one rung of the ladder, not the whole ladder: a marketplace install is
a clone whose origin is right, and a copied tree is one whose origin is
meaningless. The explicit marker in `package.json` is the only signal that
survives being rsynced.

**Leave the upstream clone as the default and document the risk.** The command
is advertised by the plugin's own skill; a documented footgun aimed at users who
never read the document is not a mitigation.

**Retarget the funding file.** See above.

## Consequences

- `CONTEXT_MODE_UPGRADE_REPO` exists for operators running a further fork.
- The `git clone` budget moved from a hard-coded 30 s to 180 s
  (`CONTEXT_MODE_UPGRADE_TIMEOUT_MS`): this tree measures 51 s for
  `git clone --depth 1` on a working connection, so the upgrade could never
  finish and left the old version on disk on every run.
- An unforked install behaves exactly as it did.
- Version bumps are no longer a matter of discipline — see
  [ADR-0013](0013-tracked-bundles-are-the-running-code.md), where the version is
  also the plugin cache key.
