# ADR-0013 — Tracked bundles are the running code

**Status:** Accepted
**Date:** 2026-08-20 — recorded retrospectively; the guards shipped earlier
**Source:** [FORK-CHANGES §11, §33, §36](../FORK-CHANGES.md)

## Context

The host does not run this repository. It runs bundles — `server.bundle.mjs`,
`cli.bundle.mjs` and the `hooks/*.bundle.mjs` set (five today; eight files were
tracked when this was written, before the host removal in
[ADR-0023](0023-two-supported-hosts.md)) — tracked in git because the plugin
loader reads them directly, and installed as an unpacked copy under
`~/.claude/plugins/cache/context-mode/context-mode/<version>/`.

That arrangement failed three times, in three different places, all with the
same signature: **nothing throws, no suite goes red, the host simply goes on
running something else.**

1. **A bundle the build never built.** `hooks/session-attribution.bundle.mjs`
   was produced by hand once and never entered `scripts.bundle`, while its
   source changed three more times. The hooks load the bundle; every attribution
   test imported `src/`. Rebuilt, the file went from 2,799 B to 3,250 B and
   gained a fix that had been dead in production for four months, with a green
   suite standing over it. None of the three guards could see it: `assert-bundle`
   scans an explicit list the orphan was not on, `plugin-cache-integrity` checks
   existence and not content and had the file whitelisted, and the CI workflow
   commits by an explicit `git add -f` list. Three mechanisms, each correct in
   its own terms, none asking *is this file still what its source says it is*.

2. **Merges that carry no information.** Minified single-line bundles produce a
   measured 25 conflict hunks against `upstream/next`, essentially all noise,
   and the resolution is always mechanical.

3. **A cache key that never moved.** Two commits changed the tool surface with
   `version` frozen, so the unpacked cache was never invalidated: `ctx_find`
   appeared eight times in the committed bundle and zero times in the bundle the
   host was executing. Measured in a live session — the server offered twelve
   tools and those two were not among them.

## Decision

**1. Every `hooks/*.bundle.mjs` in the tree is produced by `scripts.bundle`,
scanned by `assert-bundle`, and committed by CI.**
`tests/scripts/bundle-manifest.test.ts` asserts all three, deriving the set from
the build script rather than from a list — with its first test pinning the
`--outfile=` parser against known literals, since every later assertion is "X is
a member of what the parser returned" and a parser returning nothing would pass
all of them.

**2. Tests that guard hook behaviour assert against the built bundle.** Parity
between bundle and source across event batches, plus the specific case that was
dead. The integration suite that should have caught the orphan now resolves
through `loadProjectAttribution()`, the way the hooks do, instead of importing
`src/` while its comment claimed otherwise.

**3. Bundles are merged by rebuilding, not by resolving.** `.gitattributes`
marks them `merge=ours -diff linguist-generated`, and `npm run sync-upstream`
registers the `ours` driver (git ships the attribute but not the driver, so it
must be configured per clone), fetches, merges, reports conflicts left in *real
source files* — those are yours — then rebuilds the bundles and stages them.

**4. The version is the cache key, so the version moves whenever the surface
does.** Three guards stand where the discipline used to:

- `tests/scripts/version-freshness.test.ts` fails when the bundles, `hooks/` or
  the registered tool list changed since the last tag while
  `package.json:version` did not. The baseline is the version as it stood *at*
  that tag, not the tag's name. No tags, or no git, is a **skip** rather than a
  failure: a guard that fails when it cannot see is a guard people delete.
- `version-sync.mjs --check` verifies the manifests without writing and exits
  non-zero on drift. Writer and checker walk one field list, so the check cannot
  assert on a field the sync does not write.
- `tests/plugins/plugin-structure.test.ts` compares the committed bundle against
  the registered tools **in both directions**. The check it replaced scanned
  `src/server.ts` only — and the two tools that went missing register from
  `src/tools/`, precisely out of its view.

**5. Diagnostics answer for the running process, not for the tree they were
loaded from.** `src/util/delivery-health.ts` reports which `start.mjs` the host
is executing (from this process's `argv[1]` and from the process table,
degrading to "not observed" where no such tool exists), what version that
directory carries, when its bundle was built, and the live tool list against the
expected one — **named tool by tool**, because "12 of 14" tells nobody which
call to stop making. Missing tools are a critical fail; no retry makes them
appear.

**6. `ctx_upgrade` sweeps the unpacked cache** and prints what it removed. Two
directories are spared: the tree just installed into, and any tree a live MCP
server is running from — that server resolves dynamic imports against its own
directory and would start failing mid-call, and sparing it costs nothing because
the bumped version is itself a new cache key. The path refuses to resolve when
`HOME` is unset rather than falling back (`resolve("", ".claude")` collapses to
the working directory, and this is a deletion target), every target is checked
for containment inside the plugin's own cache, and a symlinked version name is
unlinked rather than followed.

## Alternatives rejected

**Delete the orphan bundle and live on the `build/` fallback.** `build/` is
gitignored and untracked, so on a marketplace install — a git clone — the bundle
is the only copy that exists. Its absence would make the loader throw into the
silent `catch` the PostToolUse hook keeps so hooks never block a session: the
events would stop being recorded without a word.

**Untrack the bundles and build on install.** The loader reads them directly and
an install that must compile is an install that can fail on a user's machine, in
a plugin that is supposed to be inert until called.

**Resolve bundle conflicts by hand.** Twenty-five hunks of minified text where
the answer is always "rebuild".

**Keep bumping the version by discipline.** That is exactly what was tried; two
waves of work were invisible for it.

## Consequences

- A change to any hook or to the tool surface requires a version bump before it
  reaches a session. This is now enforced, not remembered.
- The attribution correction is **not retroactive**: rows already in
  `session_events` keep the `project_dir` they were written with, so per-project
  history has a seam at that commit and aggregates spanning it mix two
  conventions.
- `bundle.yml` remains the one workflow that commits to this repository — it
  rebuilds the bundles when `src/**` changes, which is a defence against exactly
  the failure this ADR opens with.
- Version identity itself is defined in
  [ADR-0012](0012-fork-identity-and-upgrade-source.md); this ADR is why it has to
  move.
