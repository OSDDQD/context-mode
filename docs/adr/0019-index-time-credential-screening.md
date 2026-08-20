# ADR-0019 — Credential screening at index time

**Status:** Accepted
**Date:** 2026-08-20 — recorded retrospectively; both layers shipped earlier
**Source:** [FORK-CHANGES §5, §31](../FORK-CHANGES.md)

## Context

The knowledge base is a plaintext SQLite file that search returns snippets from.
Anything indexed can resurface in a future answer — possibly in a subagent's
context, possibly in a transcript — long after the terminal scrollback is gone.

Two ways credentials get in:

- **By file.** The original extension allowlist for the code index contained
  `.env`, and `.json` covered `credentials.json` and
  `service-account-prod.json`.
- **By content.** A `.env` pasted into a batch command, an `aws configure`
  transcript, a PEM cat'ed by mistake. Nobody would think to exclude the file
  those arrive in, because the file is a command capture.

The governing risk on the second layer runs the other way. A false positive
silently corrupts indexed source code, and nobody finds out until a search
returns `[redacted:…]` where a function used to be.

## Decision

**Two layers, with different jobs.**

**1. Path-level refusal.** `isSensitivePath()` keeps whole files out: dotenv
files, `.ssh` / `.aws` / `.gnupg` / `.kube` trees, private keys, certificate
bundles, and config-ish files whose *name* advertises secrets. **Source files
are deliberately exempt from the name check** — `token-service.ts` and
`password_reset.py` are ordinary code, and excluding them would blind search to
the exact modules people ask about.

**2. Content-level screening.** `redactSecrets()` is line-oriented and pure — no
env reads, no I/O, no store dependency — and replaces what it finds with
`[redacted:<type>]`. Rules: `sk-`, `gh[pousr]_`, `A[KS]IA`+16, `xox[baprs]-`,
and assignments whose key matches the same `SENSITIVE_NAME_HINT` that
`isSensitivePath` uses. A PEM header on a line of its own opens a block that
collapses, header through footer, into one marker — redacting only the header
would leave the secret, which is the body.

**3. The assignment rule is tightened against measured false positives.** Its
first version produced **nine false positives across this repository's 136
source files** — every one an ordinary expression assigned to a name containing
"token": `const input_tokens = toNum(u.input_tokens)`,
`const tokens = tokenizeCommand(cmd)`. The rule now requires the value to look
like a literal rather than like code: one unbroken opaque run, no bare numbers,
no paths or URLs, and — when unquoted — a digit among the letters and an
assignment that starts the line. It scores **zero redactions** over those 136
files and over 25 captured fixtures (logs, JSON payloads, diffs, transcripts,
browser snapshots), and **both sweeps are tests**, so a future loosening fails
with the file and the rule named.

**4. Screening runs before the content hash.** Exactly once, from one place,
called by `index()`, `indexPlainText()` and `indexJSON()`. That ordering is what
keeps the index cache ([ADR-0007](0007-content-hash-index-cache.md)) honest: the
stored hash describes the bytes that were actually stored, so flipping
`CONTEXT_MODE_INDEX_REDACT` invalidates the row and re-indexes the source
instead of leaving a stale hash pointing at differently-screened content.

**5. The entropy layer is off by default and stays that way.**
`CONTEXT_MODE_INDEX_ENTROPY_REDACT=1` enables a Shannon-entropy heuristic over
long opaque runs. On real code it fires on base64-inlined assets and minified
bundles — content that is not secret and that the index exists to make
searchable.

**6. What this is, stated in the documentation rather than implied.** This
reduces accidental capture. A credential with no recognisable marker passes both
layers. **It is not a control to rely on when handling credentials.**

## Alternatives rejected

**Entropy detection by default.** Higher recall, and it corrupts exactly the
content the index is for. The false-positive cost is silent and discovered late.

**Encrypt the content store.** The plugin's own process must read it on every
search, so the key lives beside the data; it defends against someone reading the
file and not against the failure that actually happens, which is a secret
resurfacing in an answer.

**Skip screening for source files.** They are the bulk of the index and they
routinely carry a committed test fixture or a sample key.

**Screen after hashing.** The hash would then describe pre-screening bytes, and
toggling the flag would leave a stale row that never re-indexes.

## Consequences

- Cost: **13.4 ms/MB** on the default path (22.7 with the entropy layer on), so
  0.035 ms for a 4 KB payload. Against a cold index of ~5.3 ms/file that is a
  few percent. It is cheap because every rule is gated behind an `indexOf` for
  its literal marker, so the regexes almost never run.
- `IndexResult.redactions` reports the count, and only when there was one.
- Also left alone, each with a test: base64 inline assets, minified bundles,
  UUIDs, git object ids, `sha512-…` integrity hashes, long paths, `sk-` inside
  `task-manager`, and the word `Bearer` in documentation.
- Paths that bypass `ContentStore`'s screening have to call `redactSecrets`
  themselves — the `ctx_graph` `explore` passthrough
  ([ADR-0021](0021-retrieval-consolidation.md)) is the one that does.
