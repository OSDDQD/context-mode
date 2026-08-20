# ADR-0024 — The boundary with the host's own tools

**Status:** Accepted
**Date:** 2026-08-20 — recorded retrospectively; the changes shipped earlier
**Source:** [FORK-CHANGES §3, §7, §8](../FORK-CHANGES.md)

## Context

The plugin's default posture is to take work away from the host's native tools:
`Bash` output belongs in a subprocess, `WebFetch` belongs in the fetch pipeline,
`Grep` competes with `ctx_find`. That posture is right often enough to be the
default and wrong often enough to need a rule for the exceptions.

Three exceptions arrived from live use:

1. **Plan mode.** Claude Code refuses tools whose `readOnlyHint` is false, so
   `ctx_batch_execute` was unavailable exactly when a careful, non-mutating
   gather matters most — leaving raw `Bash`/`Read` as the only option, which is
   the flood the plugin exists to prevent.
2. **Artifact URLs.** `claude.ai` artifact pages are client-rendered SPAs behind
   the caller's own login. The native `WebFetch` has a documented exception and
   fetches them with that authenticated session; `ctx_fetch_and_index` does a
   plain anonymous GET and can only ever retrieve the empty shell — ~100 bytes
   of "Content is user-generated and unverified". **That is worse than a
   failure**: the model gets a well-formed page, indexes it, searches it, finds
   nothing, and has no signal that the content was never there.
3. **Corporate proxies.** The fetch subprocess unconditionally stripped
   `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` to keep the DNS-rebinding guard
   meaningful. Behind a proxy that is the only route out, so every fetch became
   an unexplained timeout.

## Decision

**Where the native tool can do something we cannot, get out of its way — loudly
enough that the difference is visible.**

### 1. A read-only twin rather than a relaxed hint

`ctx_gather` runs the same engine as `ctx_batch_execute` behind
`readOnlyHint: true`, and **proves** every command read-only before running any
of them: inspection binaries, read subcommands of the common multiplexers
(`git log|show|diff|status`, `docker ps|logs`, `kubectl get`, `npm ls`,
`systemctl status`), and system probes. Refused: output redirection, command
substitution, `sudo`, in-place `sed`, and any binary not on the allowlist —
**unknown fails closed**. Offending commands are all named in one error and
nothing executes.

This is a **usability gate, not a security boundary**: the deny-policy layer
runs first, as it always did. Recorded here so nobody later relaxes the
allowlist on the theory that it was protecting something.

### 2. Passthrough, in both halves

- **The hook gets out of the way.** `WebFetch` on an artifact URL passes through
  untouched, so the native tool handles it.
- **The subprocess fetch refuses loudly.** A direct `ctx_fetch_and_index` on
  such a URL returns an error that names the working path, instead of an empty
  success.

Covered: `claude.ai/code/artifact/*`, `claude.ai/public/artifacts/*`,
`claude.site/artifacts/*`. `CONTEXT_MODE_FETCH_PASSTHROUGH` extends the list
with host suffixes or regexes. **A shared test asserts the hook and the server
agree on the same URL set**, so the two halves cannot drift into the state where
one redirects and the other refuses.

### 3. An opt-in with its trade-off written down

Stripping proxy variables remains the default. `CONTEXT_MODE_ALLOW_PROXY=1`
(with a proxy actually configured) keeps them and sets `NODE_USE_ENV_PROXY=1` on
the subprocess — which required a new executor `env` override, since Node reads
that flag at bootstrap and setting it from inside the script would be too late.

**Stated plainly rather than buried:** with a proxy in play, DNS resolves at the
proxy, so the in-subprocess rebinding guard can only see what this process
resolves itself. The operator who sets the flag is accepting that.

## Alternatives rejected

**Flip `readOnlyHint` on `ctx_batch_execute`.** It executes arbitrary commands;
the hint would be a false statement to the host, and plan mode's guarantee would
be worth nothing for every user of this plugin.

**Let `ctx_gather` refuse per command and run the rest.** A partial gather looks
like a complete one. Naming every offender in one error and executing nothing is
the behaviour that cannot be misread.

**Keep redirecting artifact URLs and accept the empty page.** Silent wrong
answers, which is the failure mode this fork spends the most effort on.

**Honour proxies by default.** It weakens the rebinding guard for every user to
serve the ones behind a proxy — and the ones behind a proxy can say so.

**Detect artifact URLs in the hook only.** The two halves would drift, and a
direct tool call would still return the empty shell as a success.

## Consequences

- Two tools now front the same engine; `ctx_gather` inherits every change to
  `ctx_batch_execute`, including the response shaping in
  [ADR-0016](0016-response-declares-what-it-omits.md).
- The routing hook has a passthrough list, which is a permanent invitation to
  grow. The shared test is the constraint that keeps it honest.
- `Grep` and `Glob` are nudged rather than denied for the same reason this ADR
  exists: `ctx_find` ranks, it does not enumerate, so denying an exhaustive
  literal sweep would remove a capability rather than route it — see
  [ADR-0008](0008-escalation-economics.md) and
  [ADR-0021](0021-retrieval-consolidation.md).
