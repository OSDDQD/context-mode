# Fork changes — OSDDQD/context-mode

Fork of [mksglu/context-mode](https://github.com/mksglu/context-mode) at v1.0.169.

Eight changes, each addressing a gap observed while running the plugin daily in
Claude Code. Every one is off-by-default or backwards compatible except the
compact tool descriptions, which change what ships on every request (and carry
an env switch back to the original text).

---

## 1. User-extensible bounded-command allowlist

`hooks/core/routing.mjs`

The built-in `SAFE_COMMAND_PATTERNS` list decides which Bash calls skip the
"may produce large output" nudge. It cannot know about your infrastructure —
`ssh prod-web systemctl is-active nginx` prints one line and gets nudged every
single time, which trains the agent to ignore the nudge everywhere.

Two new sources, consulted after the built-ins:

| Variable | Meaning |
|---|---|
| `CONTEXT_MODE_SAFE_COMMANDS` | Regex patterns separated by `\|\|\|` |
| `CONTEXT_MODE_SAFE_COMMANDS_FILE` | File with one regex per line (`#` comments allowed) |

Default file: `<config-dir>/context-mode/safe-commands.txt`.

```bash
# ~/.claude/context-mode/safe-commands.txt
^ssh\s+\S+\s+systemctl\s+is-active\s+\S+$
^docker\s+compose\s+ps$
```

User patterns are evaluated **after** the shell-operator gate, so they widen the
nudge carve-out and nothing else: `myctl status | cat huge.log` is still
unbounded, and the security deny gate is untouched. Malformed patterns are
skipped rather than crashing the hook (it runs on every Bash call).

Also added to the built-in list: near-silent git plumbing (`add`, `commit`,
`push`, `pull`, `fetch`, `switch`, `checkout`, `stash`, `init`), `chmod`/`chown`
without their per-file verbose flags, `kill`, `pkill`, `sleep`, `mktemp`.

## 2. Missed-redirect telemetry

`hooks/posttooluse.mjs`, `src/session/analytics.ts`

`ctx_stats` could show what routing saved, never what it missed — so the
thresholds could only be tuned by intuition. Any native data-fetching tool
(`Bash`, `Read`, `Grep`, `Glob`, `WebFetch`) that returns more than
`CONTEXT_MODE_MISSED_REDIRECT_MIN_BYTES` (default 2000) **without** a redirect
marker now records a `missed-redirect` event, and `ctx_stats` prints:

```
  Slipped through unrouted: 180.0 KB across 3 calls — these landed in context whole.
    Bash        117.2 KB  git log --stat
    Read         58.6 KB  /repo/dump.json
    Route these through ctx_execute / ctx_batch_execute, or add them to
    safe-commands.txt if their output really is small.
```

Nothing is printed when the session recorded none.

## 3. `ctx_gather` — read-only gather path (upstream #1048)

`src/read-only.ts`, `src/server.ts`

Claude Code's plan mode refuses tools whose `readOnlyHint` is false, so
`ctx_batch_execute` was unavailable exactly when a careful, non-mutating gather
matters most — leaving raw Bash/Read as the only option.

`ctx_gather` runs the same engine behind `readOnlyHint: true`, and proves every
command read-only first: inspection binaries (`cat`, `ls`, `grep`, `find`,
`jq`, `wc`, `stat`, …), read subcommands of the common multiplexers
(`git log|show|diff|status`, `docker ps|logs`, `kubectl get`, `npm ls`,
`systemctl status`), and system probes. Refused: output redirection, command
substitution, `sudo`, in-place `sed`, and any binary not on the allowlist —
unknown fails closed. Offending commands are all named in one error and nothing
executes.

This is a usability gate, not a security boundary: the deny-policy layer runs
first, as it always did.

## 4. Compact tool descriptions (upstream #1031)

`src/server.ts`

The authored descriptions are steering prose shipped in the tool definitions of
every request, in a plugin whose entire purpose is not spending tokens on bytes
the model does not need. Once the SessionStart routing block and the project
rules have said "think in code", most of it is a second copy.

The long form stays in the source as the reference; a compact table is what
ships. `CONTEXT_MODE_TOOL_DESCRIPTIONS=full` restores the original text for
hosts that inject no routing block of their own.

Measured over a live `tools/list` (12 tools, this fork):

| | description chars | ≈ tokens |
|---|---|---|
| `full` | 18 739 | 4 685 |
| compact (default) | 4 971 | 1 243 |
| **saved per request** | **13 768** | **≈3 442 (73%)** |

## 5. Incremental code indexing

`src/session/code-index.ts`, `hooks/posttooluse.mjs`, `src/server.ts`

The knowledge base only ever held command *output*. The source tree — the thing
every session is actually about — was searchable only if someone had previously
piped it through a ctx_* tool, so `ctx_search("where is the retry handled")`
came back empty and the agent fell back to grep + Read.

Now every file written or edited is appended to a queue file (a one-line
append: the hook stays under its <20ms budget, no SQLite load), and the MCP
server drains that queue the next time it opens the content store. Files are
indexed under `code:<relative-path>`, capped at 512 KB, skipping lockfiles,
`node_modules`, `dist`, and binaries. Disable with `CONTEXT_MODE_CODE_INDEX=0`.

## 6. Optional hybrid (semantic) search

`src/search/embeddings.ts`, `src/search/hybrid.ts`, `src/store.ts`

The ranking pipeline is purely lexical — excellent at "find the chunk
containing `useEffect`", blind to "why does the deploy keep failing" when the
chunk says "build step exits 137".

Semantic candidates are now fused into the same RRF the lexical strategies
already use. **Off by default**, dependency-free, no bundled model: point it at
an OpenAI-compatible embeddings endpoint you already run.

| Variable | Meaning |
|---|---|
| `CONTEXT_MODE_EMBEDDINGS_URL` | e.g. `http://localhost:11434/v1/embeddings` |
| `CONTEXT_MODE_EMBEDDINGS_MODEL` | e.g. `nomic-embed-text` |
| `CONTEXT_MODE_EMBEDDINGS_API_KEY` | optional bearer token |
| `CONTEXT_MODE_EMBEDDINGS_TIMEOUT_MS` | default 5000 |

Vectors live in a `chunk_vectors` table inside the existing content DB (so they
are purged and cleaned up with the chunks they describe) and are backfilled
lazily — 32 chunks per search, after the answer is returned. A cold index
behaves exactly like the lexical one and improves as it warms. If the endpoint
is unreachable or slow, search silently degrades to lexical-only; it never
fails because an optional side-car is down.

**Where it is wired.** Two call sites, both the ones that reach *cold* prior
knowledge:

- `ctx_search` in relevance mode (timeline mode is chronological — ranking does
  not apply)
- `ctx_batch_execute` / `ctx_gather` with `query_scope: "global"`

Deliberately NOT wired to the default `query_scope: "batch"`: those queries run
against output the same call just produced, where the caller already knows the
terms and an embedding round trip would only add latency to the hot path.

Usage measured on this machine before wiring the batch path: 70
`ctx_batch_execute` calls against **1** `ctx_search` call across 16 sessions —
i.e. attaching only to `ctx_search` would have left the feature effectively
unreachable.

## 7. Opt-in proxy for `ctx_fetch_and_index` (upstream #1039)

`src/server.ts`, `src/executor.ts`

The fetch subprocess unconditionally stripped `HTTP_PROXY`/`HTTPS_PROXY`/
`ALL_PROXY` to keep the DNS-rebinding guard meaningful. Behind a corporate
proxy that is the only route out, so every fetch became an unexplained timeout.

Stripping remains the default. `CONTEXT_MODE_ALLOW_PROXY=1` (with a proxy
actually configured) keeps the variables and sets `NODE_USE_ENV_PROXY=1` on the
subprocess — which had to go through a new executor `env` override, since Node
reads that flag at bootstrap and setting it from inside the script would be too
late.

**Trade-off, stated plainly:** with a proxy in play, DNS resolves at the proxy,
so the in-subprocess rebinding guard can only see what this process resolves
itself. The operator who sets the flag is accepting that.

## 8. Artifact URLs reach the tool that can actually read them (upstream #938, #984, #1006)

`hooks/core/routing.mjs`, `src/fetch-passthrough.ts`, `src/server.ts`

The WebFetch redirect was unconditional, including for `claude.ai` Artifact
URLs. Those pages are client-rendered SPAs behind the caller's claude.ai login:
Claude Code's native WebFetch has a documented exception and fetches them with
that authenticated session, while `ctx_fetch_and_index` does a plain anonymous
GET and can only ever retrieve the empty shell — ~100 bytes of "Content is
user-generated and unverified".

That is worse than a failure. The model gets a well-formed page, indexes it,
searches it, finds nothing, and has no signal that the content was never there.

Both halves are fixed:

- **The hook gets out of the way.** `WebFetch` on an artifact URL passes through
  untouched, so the native tool handles it.
- **The sandbox fetch refuses loudly.** A direct `ctx_fetch_and_index` call on
  such a URL returns an error that names the working path, instead of an empty
  success.

Covered patterns: `claude.ai/code/artifact/*`, `claude.ai/public/artifacts/*`,
`claude.site/artifacts/*`. `CONTEXT_MODE_FETCH_PASSTHROUGH` extends the list
(#908) — entries separated by `|||`, each a host suffix (`intranet.corp`) or a
regex when it starts with `^`. A shared test asserts the hook and server
implementations agree on the same URL set, so the two halves cannot drift.

---

## New environment variables

| Variable | Default | Effect |
|---|---|---|
| `CONTEXT_MODE_SAFE_COMMANDS` | — | Extra bounded-command regexes, `\|\|\|`-separated |
| `CONTEXT_MODE_SAFE_COMMANDS_FILE` | `<config>/context-mode/safe-commands.txt` | Same, one per line |
| `CONTEXT_MODE_MISSED_REDIRECT_MIN_BYTES` | `2000` | Threshold for recording an unrouted payload |
| `CONTEXT_MODE_TOOL_DESCRIPTIONS` | compact | `full` restores the verbose descriptions |
| `CONTEXT_MODE_CODE_INDEX` | on | `0` disables indexing of edited files |
| `CONTEXT_MODE_EMBEDDINGS_URL` | — | Enables hybrid search (with `_MODEL`) |
| `CONTEXT_MODE_EMBEDDINGS_MODEL` | — | Embedding model name |
| `CONTEXT_MODE_EMBEDDINGS_API_KEY` | — | Bearer token for the endpoint |
| `CONTEXT_MODE_EMBEDDINGS_TIMEOUT_MS` | `5000` | Per-request embedding timeout |
| `CONTEXT_MODE_ALLOW_PROXY` | off | `1` lets the fetch subprocess use the ambient proxy |
| `CONTEXT_MODE_FETCH_PASSTHROUGH` | claude.ai artifacts | Extra hosts/regexes the WebFetch redirect must skip |

## Tests

`npm test` — 4777 passing, 38 skipped. New suites:

- `tests/core/fetch-passthrough.test.ts` — artifact-URL passthrough, hook/server parity
- `tests/core/batch-hybrid-scope.test.ts` — hybrid on `global` scope, lexical on `batch`

- `tests/core/read-only.test.ts` — read-only classification
- `tests/core/code-index.test.ts` — queue draining, overflow, failure isolation
- `tests/core/hybrid-search.test.ts` — embedding config, codec, RRF fusion, degradation
- `tests/core/compact-descriptions.test.ts` — compact default + `full` escape hatch
- `tests/hooks/user-safe-commands.test.ts` — user allowlist, malformed patterns, operator gate
- `tests/analytics/missed-redirect.test.ts` — the unrouted-payload block

## Installing this fork in Claude Code

```
/plugin marketplace add OSDDQD/context-mode
/plugin install context-mode@context-mode
```

Then restart Claude Code (or `/reload-plugins`).
