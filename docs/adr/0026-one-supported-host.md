# ADR-0026 — One supported host

**Status:** Accepted
**Date:** 2026-08-21
**Supersedes the scope of** [ADR-0023](0023-two-supported-hosts.md)

## Context

[ADR-0023](0023-two-supported-hosts.md) cut seventeen client platforms to two on
one argument: **the cost is not the code, it is the multiplier.** Every change to
routing had to be reasoned about once per host and verified on the ones anyone
actually runs.

At two hosts the multiplier is smaller and the argument is unchanged. This
repository is developed inside Claude Code. The Claude Code path is exercised on
every commit of every session; the Codex path was exercised by its own tests and
by nothing else — which is precisely the regime ADR-0023 named as the one where
a change looks right and is not.

The parity suite was written to cover that gap, and its own docblock records
what writing it found:

> It had already happened. […] the Codex PreToolUse hook wrote no redirect
> marker and its PostToolUse read none, so on Codex nothing refused was ever
> counted as bytes avoided, and the read-before-edit retry — the escape hatch
> the refusal itself offers — arrived looking like a fresh violation and pushed
> the escalation ladder up a step. The self-reinforcing loop had been fixed on
> one host and left running on the other.

A parity suite is the right answer when both halves are used. When one half is
used by nobody working on the repository, the suite is the only thing keeping
that half alive, and it is comparing a host against a host nobody runs.

The cost was still being paid in the current wave. [ADR-0025](0025-the-rung-that-asked.md)
had to reason about the Bash rung twice over — once for a host that shows
prompts and once for a host whose `output_parser.rs` rejects
`permissionDecision: "ask"` outright — and its acceptance criterion was that the
two agree at every rung.

## Decision

**Support Claude Code. Remove Codex CLI.**

**The removal is one commit that only deletes.** 28 files, 5,337 deleted lines,
not one line added: the `.codex-plugin` manifests, `configs/codex`, the seven
`hooks/codex` entry points, the capability probe, the four-file adapter, and the
eight test files whose only subject was Codex — `platform-parity` among them, a
suite that would otherwise compare one host to itself. Restoring Codex is a
revert of that commit and nothing else, and a conflict with upstream resolves as
"our deletion wins" rather than line by line. The tree does not compile at that
commit, deliberately; the couplings are untangled in the one that follows.

**The seams stay; only the second row goes.** `PLATFORM_ENV_VARS`,
`CLIENT_NAME_TO_PLATFORM`, `getSessionDirSegments`, the formatter registry, the
adapter enumeration in `analytics.ts` and the security reader's derived adapter
table are all one-row tables now. None of them was collapsed into a literal. A
one-row table costs a few bytes and keeps the property that the next host is
**added as data** rather than discovered as a branch somewhere — which is the
failure mode ADR-0023's fifteen removals were paying off in the first place.

**What a one-row table can no longer assert is written down, not quietly
dropped.** Three properties genuinely lost coverage, and each is marked where it
lived rather than deleted with its test:

- `foreignIdentificationEnv` / `foreignWorkspaceEnv` return empty sets. The test
  now pins *empty*, and says why: the scrub exists so a child inheriting another
  host's identification var cannot detect as that host.
- The cross-adapter security-parity case (#451) is unreachable. What is pinned
  instead is that a removed host's `settings.json` is **not** read, and that the
  Claude global still is.
- `getMultiAdapterLifetimeStats` and the statusline's "across N tools" branch
  cannot see two roots. The aggregation tests now seed a `.codex` root on
  purpose and assert it contributes **nothing** — a machine that once ran the
  removed host still has one on disk, and crediting its bytes to nobody is the
  behaviour worth having.

**Two things outlive their host on purpose.** `isPluginInstallPath` still
recognises `~/.codex/plugins/...`: a path that is not a project must not become
one just because the host that created it is gone. And the Bash tool-name
aliases (`shell`, `local_shell`, `exec_command`, `apply_patch`, …) stay in the
canonicalisation table — an alias that stops resolving does not fail loudly, it
quietly stops enforcing anything, and canonicalisation is a property of the name
rather than of the platform.

## Alternatives rejected

**Keep Codex, keep the parity suite.** This is what the previous wave chose, and
it is defensible exactly as long as somebody runs both. Nobody here does. The
suite's value is proportional to the chance that a divergence is noticed by a
human; at zero Codex sessions that chance is zero, and what remains is a
maintenance bill and a false sense of coverage.

**Keep the adapter, drop the hooks.** MCP-only Codex support would have removed
the routing multiplier and kept the tools working. Rejected because MCP-only is
the configuration this plugin exists to argue against: without hooks there is no
enforcement, and "supported" would mean "the tools load."

**Collapse the one-row tables into literals.** Smaller, and wrong. The registries
are how ADR-0023's lesson is encoded; flattening them puts the next host's
detection back into scattered branches.

## Consequences

- `docs/platform-support.md` states one paradigm and one host.
- `version-sync.mjs` went from three manifests to two — every removed entry was
  a place the version number could be forgotten.
- `configs/` no longer ships a `.json` template, so the portability guard
  (#613 / PR #620) now scans `.claude-plugin/` and `hooks/` as well: the rule
  was about committed files that reach a user's machine, and it had been
  spelled as a directory.
- `getRuntimeAwarePackageRoot` is gone. Its only reason to exist was Codex's
  plugin-manager runtime root; callers take `getPackageRoot()` directly.
- The Bash escalation ladder has one shape again, so ADR-0025's acceptance
  criterion — the hosts agree at every rung — is satisfied trivially rather than
  by a suite.
- 4,656 tests pass, 38 skipped, on a tree with no Codex in it.
