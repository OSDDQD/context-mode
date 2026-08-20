# Fork changes — OSDDQD/context-mode

Fork of [mksglu/context-mode](https://github.com/mksglu/context-mode) at v1.0.169.

Thirty-eight changes, each addressing a gap observed while running the plugin daily in
Claude Code. Every one is backwards compatible, and every behavioural default
carries an env switch back. Two defaults differ from upstream on purpose: the
compact tool descriptions (what ships on every request) and the semantic layer,
which now adopts a local embedding runtime if one is already running instead of
waiting to be configured.

**The reasoning lives in [`docs/adr/`](adr/).** This file stays the
chronological record — what changed, when, and with which measurements. The
decisions those changes encode, together with the alternatives that were
rejected, are written up as ADRs, and a section that carries one links to it
directly under its heading. Nothing here has been removed: an entry with an ADR
keeps its full text, because the measurement that produced a decision is part of
the record too.

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

> **Decision recorded in** [ADR-0022 — Honest savings accounting](adr/0022-honest-savings-accounting.md).

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

> **Decision recorded in** [ADR-0024 — The boundary with the host’s own tools](adr/0024-boundary-with-native-tools.md).

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

> **Decision recorded in** [ADR-0014 — The standing context budget](adr/0014-standing-context-budget.md).

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

> **Decisions recorded in** [ADR-0009 — Capture queues](adr/0009-capture-queues.md) and [ADR-0019 — Credential screening at index time](adr/0019-index-time-credential-screening.md).

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

**Seeded, not just accumulated.** The queue only ever holds files the agent has
already touched, so a fresh session started blind: search over code returned
nothing until something was edited — precisely when it is needed least.
`bootstrapCodeIndex()` now seeds the index once per project from `git ls-files`,
newest-first, bounded at 200 files / 4 MB. Using the repo's own file list means
no `.gitignore` parsing, no walk into `node_modules`, and nothing untracked.

The seed is **amortised, not blocking**: indexing 200 files measured 1.3 s on
this repo — too much to spend inside one tool call. The plan is computed once
and worked through 15 files (~190 ms) per store open, the same lazy shape the
vector backfill already uses, and it survives a restart because the remaining
plan is persisted. Tune with `CONTEXT_MODE_CODE_INDEX_BOOTSTRAP_BATCH`, or opt
out with `CONTEXT_MODE_CODE_INDEX_BOOTSTRAP=0`.

**Deletions are evicted.** A file indexed and later deleted kept answering
searches forever — the worst failure mode a retrieval layer has, because a
stale answer is indistinguishable from a correct one until the agent acts on
it. `pruneDeletedCodeSources()` sweeps `code:` sources whose file is gone (once
per server process), and a queued file that vanished before the drain evicts
its source instead of being silently skipped. Backed by a new
`ContentStore.deleteSource(label)`.

**Credentials never enter the index.** The old extension allowlist contained
`.env`, and `.json` covered `credentials.json` and `service-account-prod.json`.
The knowledge base is a plaintext SQLite file that search returns snippets
from, so anything indexed can resurface in a future answer — possibly in a
subagent's context, possibly in a transcript. `isSensitivePath()` now refuses
dotenv files, `.ssh` / `.aws` / `.gnupg` / `.kube` trees, private keys and
certificate bundles, and config-ish files whose *name* advertises secrets.
Source files are deliberately exempt from the name check: `token-service.ts`
and `password_reset.py` are ordinary code, and excluding them would blind
search to the exact modules people ask about.

## 6. Optional hybrid (semantic) search

> **Decision recorded in** [ADR-0010 — The semantic layer is adopted, not bundled](adr/0010-semantic-layer-adopted-not-bundled.md).

`src/search/embeddings.ts`, `src/search/hybrid.ts`, `src/store.ts`

The ranking pipeline is purely lexical — excellent at "find the chunk
containing `useEffect`", blind to "why does the deploy keep failing" when the
chunk says "build step exits 137".

Semantic candidates are now fused into the same RRF the lexical strategies
already use. Dependency-free, no bundled model, no vendor call: it uses an
embeddings endpoint you already run.

| Variable | Meaning |
|---|---|
| `CONTEXT_MODE_EMBEDDINGS_URL` | e.g. `http://localhost:11434/api/embed` — set it to skip autodetection |
| `CONTEXT_MODE_EMBEDDINGS_MODEL` | e.g. `bge-m3` (multilingual, the default) or `nomic-embed-text` |
| `CONTEXT_MODE_EMBEDDINGS_API_KEY` | optional bearer token |
| `CONTEXT_MODE_EMBEDDINGS_TIMEOUT_MS` | query budget, default 5000 |
| `CONTEXT_MODE_EMBEDDINGS_BACKFILL_TIMEOUT_MS` | background batch budget, default 120000 |
| `CONTEXT_MODE_EMBEDDINGS_BACKFILL` | chunks embedded per pass, default 16 |
| `CONTEXT_MODE_EMBEDDINGS_QUANT` | `f32` stores float32 instead of the int8 default |
| `CONTEXT_MODE_EMBEDDINGS_AUTODETECT` | `0` never probes localhost |
| `CONTEXT_MODE_EMBEDDINGS` | `0` hard-off, whatever else is configured |

**It finds the runtime you already have.** Requiring two env vars meant the
feature shipped switched off for everyone who did not read this file — a
capability nobody uses is worth exactly nothing. With no URL configured, the
first hybrid search probes three loopback endpoints (Ollama `:11434`, LM Studio
`:1234`, llama.cpp `:8080`) with a 400 ms budget, once per process, and adopts
the first one listing an embedding model. `bge-m3` is preferred — multilingual, so a Russian query matches an English
chunk (measured end-to-end against the local runtime: «почему падает деплой»
scores 0.454 against an English chunk about a build exiting 137, versus 0.338
against an unrelated proxy-configuration chunk). A chat model is never adopted as a
fallback: it answers the embed call with plausible garbage, which poisons
ranking silently. Nothing off-machine is ever probed, and
`CONTEXT_MODE_EMBEDDINGS_AUTODETECT=0` disables the probe entirely.

**Vectors are stored as int8.** Cosine similarity divides by both norms, so a
per-vector positive scale cancels out; quantising to the vector's own peak
makes the table 4× smaller at a measured cosine of **0.99990** against the
unquantised vector (real bge-m3 output, 1024 dims) — noise well below the gap
between any two candidates a ranking has to separate. That matters because
every query walks it: bge-m3's 1024 dims are 4 KB per chunk as float32 and 1 KB
as int8 — 200 MB vs 50 MB read per search over a 50k-chunk store. Rows written
before quantisation existed keep working: the decoder tells the formats apart
by blob length against the `dim` the row already carries, so there is no
migration and no rewrite. `CONTEXT_MODE_EMBEDDINGS_QUANT=f32` opts out.

**The scan is scoped and streamed.** A search filtered to one source used to
pay cosine over every vector in the store and filter afterwards — which could
also return nothing at all when the global top-K happened to belong to other
sources. The filter is now a SQL join pushed into the scan, and rows stream
through `iterate()` instead of materialising every BLOB at once.

**Repeated queries embed once.** `ctx_search` takes an array of queries and
agents re-ask the same question across a session, so the same string was
embedded again and again on the latency path. A 256-entry LRU turns every
repeat into a map lookup. Backfill batches are never cached — they are never
repeated.

**Switching models evicts the old vectors.** Two models' vectors are not
comparable: different dimensionality scores 0 (dead weight), same
dimensionality scores *plausible nonsense*, which is worse because nothing
looks broken. `pruneStaleModelVectors()` runs before each backfill, so changing
`CONTEXT_MODE_EMBEDDINGS_MODEL` re-warms the index instead of leaving it
permanently half-degraded.

**Coverage and payoff are visible in `ctx_stats`.** "Hybrid search is
configured" and "hybrid search can answer" are different states, and a cold
index degrades silently to lexical — which looks exactly like working. The
report now prints embedded-chunk coverage, the model, index size, and how many
of this session's semantic passes actually changed a ranking. That last number
is the only honest answer to "is the embedding round trip earning its
latency?".

**Two budgets, not one.** Measured against bge-m3 on CPU: a single query
embedding is ~230 ms, a batch of 16-32 real chunks is 5-15 s. One shared
timeout would abort every backfill before it wrote a vector, and the index
would stay permanently cold — invisibly, since search just degrades to
lexical. The query path keeps a short budget so a hung endpoint cannot stall
an answer; the background path gets a long one.

**Vectors are pruned, not accumulated.** `chunks` is an FTS5 table:
re-indexing a source deletes and re-inserts its rows with new rowids, orphaning
every vector keyed to the old ones. A fresh store measured 32 vectors against
16 chunks after one restart. `pruneOrphanVectors()` runs before each backfill,
and `indexHostMemory` now skips files whose content hash is unchanged, so a
restart no longer re-indexes and re-embeds identical content.

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

> **Decision recorded in** [ADR-0024 — The boundary with the host’s own tools](adr/0024-boundary-with-native-tools.md).

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

> **Decision recorded in** [ADR-0024 — The boundary with the host’s own tools](adr/0024-boundary-with-native-tools.md).

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

## 9. The host's own memory becomes searchable

> **Decision recorded in** [ADR-0011 — Host memory is indexed, never injected](adr/0011-host-memory-indexed-never-injected.md).

`src/session/host-memory.ts`, `src/search/auto-memory.ts`, `src/server.ts`

Two different stores both call themselves "memory", and they were never
talking to each other:

| | Path | Reality |
|---|---|---|
| `adapter.getMemoryDir()` — what `searchAutoMemory` read | `<config>/memory/<sha256(projectDir)[:16]>` | **does not exist on a normal install** |
| `getLifetimeStats()` — what `ctx_stats` counts | `<config>/projects/<slug>/memory/` | correct |
| Claude Code — where memory is actually written | `<config>/projects/<slug>/memory/` | 62 files here |

So `ctx_stats` reported "52 preferences picked up across 7 projects" while
`ctx_search` could not retrieve a single word of them. The system claimed a
memory it could not read.

Three fixes:

1. **Resolve the real path.** `resolveHostMemoryDirs()` finds
   `<config>/projects/<slug>/memory`. Slugging is not just `/` → `-`: the host
   also rewrites dots and underscores, so `/home/u/projects/casino_front` is
   stored as `-home-u-projects-casino-front`. Three strategies are tried in
   order — plain slug, folded slug, then a normalised scan of `projects/` that
   matches whatever naming rule the installed host version used. Verified
   against every real project directory on the author's machine.
2. **Search it in relevance mode.** Auto-memory was wired only to
   `sort: "timeline"`, so the default mode could not answer "what did we decide
   about X" from the very files written to answer it. Memory hits are now
   appended (capped at 2, skipped when the caller passed a `source` filter)
   rather than fused into the ranking — a curated fact is a different kind of
   hit than a captured chunk, and it must not evict results the caller asked
   for.
3. **Index it into FTS5.** Memory files are indexed under `memory:<name>` on
   first store open, which buys what plain scanning cannot: `query_scope:
   "global"` reaches them, the semantic layer can match a paraphrase (or a
   Russian query against an English memory file), and the content hash flags a
   memory as stale after an edit. Scoped to the current project (#663).
   Disable with `CONTEXT_MODE_INDEX_HOST_MEMORY=0`.

**Indexing only — never injection.** The host already loads `MEMORY.md` into
every session; re-injecting those bytes would spend context to duplicate what
is already there. And nothing writes *into* host memory: that store stays
curated by its owner.

Scope note: the path fix targets Claude Code. Codex, Kimi and OpenClaw have
their own `getMemoryDir` implementations whose correct host paths were not
verified here, so they are left untouched.

---

## 10. `ctx upgrade` stops overwriting the fork with upstream

> **Decision recorded in** [ADR-0012 — Fork identity and the upgrade source](adr/0012-fork-identity-and-upgrade-source.md).

`src/util/fork-info.ts`, `src/cli.ts`, `package.json`

`ctx upgrade` cloned `https://github.com/mksglu/context-mode.git`
unconditionally and rsynced it over the install. Run from a fork install that
is not an upgrade — it is a silent downgrade that deletes every change in this
document, from a command the plugin itself advertises in a skill. The
marketplace step had the same shape: `git reset --hard origin/HEAD` in a clone
that might track a different repo than the one being upgraded from.

The upgrade source is now resolved from what the install actually is, in order:

1. `CONTEXT_MODE_UPGRADE_REPO` — operator override;
2. the `fork` block in the installed `package.json`;
3. the git `origin` of the installed tree;
4. upstream, for an unforked install (unchanged behaviour).

The marketplace clone is only reset when its `origin` matches the resolved
upgrade source; otherwise it is skipped with an explanation instead of quietly
reinstalling another tree's plugin metadata.

**And the install is now identifiable.** Fork and upstream ship the same
`version`, so "which tree is running?" had no answer — the first thing that
matters when a fork-only feature appears to be missing. `package.json` carries
a `fork` block (`name`, `repo`, `upstream`, `version`), and `doctor` prints
`context-mode v1.0.169 · fork OSDDQD/context-mode rev 2` plus the repo it would
upgrade from.

**The same shared `version` also made every fork release invisible to the
upgrade itself.** `ctx upgrade` cloned the right repo, compared `1.0.169`
against `1.0.169`, reported "already on latest" and installed nothing — caught
running it against a tree four commits ahead. `isUpgradeAvailable()` now
compares the pair `(version, fork.version)`, so an upstream bump and a fork
release are both detected, and the version line reads
`v1.0.169 (fork rev 1) → v1.0.169 (fork rev 2)`. An install predating the
marker treats a missing revision as `0`, so it still sees the first marked
release.

**Releasing this fork therefore means bumping `fork.version`** in
`package.json` — the same role `version` plays upstream. Skip it and installs
will keep reporting themselves up to date while running older code.

**And the clone it all depends on got a realistic budget.** The `git clone`
carried a hard-coded 30 s timeout; this tree measures 51 s for
`git clone --depth 1` (20 MB) on a working connection, so the upgrade could
never finish here — it timed out, printed "GitHub pull failed", and left the
old version on disk on every run. The ceiling is now 180 s, overridable with
`CONTEXT_MODE_UPGRADE_TIMEOUT_MS`.

## 11. Merging upstream without drowning in bundle conflicts

> **Decision recorded in** [ADR-0013 — Tracked bundles are the running code](adr/0013-tracked-bundles-are-the-running-code.md).

`.gitattributes`, `scripts/sync-upstream.mjs`

Eight `*.bundle.mjs` files are tracked because the plugin loader reads them
directly, and they are minified to a handful of enormous lines. Every upstream
merge therefore conflicts on all eight in a form no human can resolve by
reading — a measured 25 conflict hunks against `upstream/next`, essentially all
of them noise. The resolution is always mechanical: take the source-level
merge, then rebuild.

`.gitattributes` marks the bundles `merge=ours -diff linguist-generated`, and
`npm run sync-upstream` does the rest: registers the `ours` driver (git ships
the attribute but not the driver, so it must be configured per clone), fetches
and merges, reports any conflicts left in *real source files* — those are
yours — then rebuilds the bundles and stages them.

```bash
npm run sync-upstream               # merge upstream/main
npm run sync-upstream -- next       # merge upstream/next
npm run sync-upstream -- --dry-run  # count the conflicts first
```

## 12. Deny-reason contract test (ADR-0003 follow-up)

`tests/hooks/deny-reason-contract.test.ts`

[ADR-0003](adr/0003-routing-deny-reasons.md) formalised the rule that a
redirect must not speak the vocabulary of a restriction — PR #654 reproduced
an Opus 4.6 session reading the bare word "blocked" in a redirect reason as a
network restriction and giving up instead of calling the tool it was being
handed. The ADR closes by recommending a contract test as a follow-up, "the
rule is already mechanically checkable". This is that test: every CASE A
denial (curl, wget, inline HTTP, WebFetch) must avoid restriction vocabulary
*and* name a concrete alternative, while CASE B security denials keep reading
like the restrictions they are.

## 13. Deferred-tool awareness (Claude Code tool search)

> **Decision recorded in** [ADR-0014 — The standing context budget](adr/0014-standing-context-budget.md).

`hooks/sessionstart.mjs`, `hooks/routing-block.mjs`, `src/server.ts`

Claude Code's tool-search releases (≥2.1, `ENABLE_TOOL_SEARCH` unset or on)
defer MCP tool schemas: the ctx_* tools are visible by name only, and a direct
call before a `ToolSearch` load fails with a validation error. That breaks
this plugin in the worst way — the SessionStart block tells the model to call
`ctx_batch_execute`, the call errors, and the model concludes the tools are
unavailable and falls back to exactly the raw Bash/Read flood the plugin
exists to prevent.

Two halves:

- **The routing block teaches the bootstrap.** On Claude Code, SessionStart
  now includes a `deferred_tool_bootstrap` section: load the five core ctx_*
  tools in ONE `ToolSearch("select:…")` call, and never fall back to raw tools
  just because a schema was not loaded yet. Harmless on hosts that do not
  defer (it reads "may be deferred"). Opt out with
  `CONTEXT_MODE_TOOLSEARCH_HINT=0`.
- **Descriptions upgrade themselves when they become free.** Deferral flips
  the compact-descriptions trade-off (#4): schemas are no longer shipped per
  request, so the verbose author-written text costs nothing and teaches more.
  Tools still register compact; on `oninitialized` — after the MCP handshake
  identifies the client, before its `tools/list` — the server swaps in the
  full text when the client is Claude Code ≥2.1 by high-confidence clientInfo
  mapping (no env-sniff fallback: a foreign host running inside a Claude
  Code-launched shell must not qualify) and `ENABLE_TOOL_SEARCH` is not
  `false`. `CONTEXT_MODE_TOOL_DESCRIPTIONS` grows an explicit `compact` value
  that pins the old behaviour; `full` and the unset/`auto` default keep their
  meaning.

## 14. Subagent transcript capture

> **Decision recorded in** [ADR-0009 — Capture queues](adr/0009-capture-queues.md).

`hooks/subagentstop.mjs`, `src/session/subagent-capture.ts`, `src/server.ts`

A subagent's context dies with the subagent: every tool output it saw is
discarded and only the final report survives. When the parent later needs a
detail the report omitted, the transcript with the answer was sitting on disk
the whole time — unreachable.

Same split as the code index (#5): the new SubagentStop hook appends one JSON
line (session, agent id/type, transcript path) to a queue file and records a
`subagent_end` timeline event; the MCP server drains the queue on its next
store open. The drain resolves the agent's own transcript (dedicated
`subagents/agent-<id>.jsonl` files first, sidechain filtering on the legacy
inline layout — and it refuses to index the main conversation when it cannot
isolate the agent), distills it to a markdown digest — task prompt, each tool
call with its result truncated to 2 KB, final report — and indexes it under
`subagent:<type>:<id>`, capped at 256 KB. `ctx_search("what did that agent
find")` now has somewhere to look. Disable with
`CONTEXT_MODE_SUBAGENT_CAPTURE=0`.

## 15. SessionEnd hook + `context-mode drain`

> **Decisions recorded in** [ADR-0009 — Capture queues](adr/0009-capture-queues.md) and [ADR-0014 — The standing context budget](adr/0014-standing-context-budget.md).

`hooks/sessionend.mjs`, `src/cli.ts`

The capture queues (#5, #14) drain lazily "on the next store open" — which
taxes the first tool call of the NEXT session, and never happens at all if
the project is not opened again. The new SessionEnd hook closes the books
instead: it records a `session_end` event with the host's reason (clear,
logout, prompt_input_exit, …), removes the session's guidance-throttle
markers from tmp, and spawns a detached `context-mode drain --project <dir>`
so the pending queues are indexed while the machine is idle. `drain` is also
a plain CLI command — run it by hand to warm the index at any time. Disable
the auto-drain with `CONTEXT_MODE_SESSION_END_DRAIN=0`.

Also in this change: the ctx-* utility skills moved out of the
auto-discovered `skills/` directory. Claude Code loads every skill
description into every session's system prompt — ~1.5 KB spent per session on
seven commands that are only ever invoked explicitly. They are now plugin
slash commands in `commands/` (`disable-model-invocation: true`, zero
standing context; same `/context-mode:ctx-*` invocations), the big
`context-mode` skill description lost its 30-phrase trigger list, and the
skill files live on in `platform-skills/` for the non-Claude-Code packagers
(pi) that reference them. New in `agents/`: a `context-gather` subagent whose
system prompt bakes in the routing rules — heavy exploration in a disposable
context that reports conclusions, not file dumps.

## 16. Cross-query deduplication in search results

> **Decision recorded in** [ADR-0016 — Search responses declare what they omit](adr/0016-response-declares-what-it-omits.md).

`src/server.ts`, `src/search/hybrid.ts`

A multi-query search ranks every query independently, so a chunk that answers
several of them is rendered several times. Measured over five live `batch:`
sources with `scripts/measure-search-dedup.mjs`: 144,617 bytes of response held
57 verbatim repeats — **33.5% of what the model was handed was text it had read
a few lines earlier** (`docs/research/search-dedup-2026-08-18.md`).

`CrossQueryDeduper` suppresses only text that is **byte-identical to something
already printed above in the same response**, and replaces it with a pointer to
where it was printed:

```
### Deploy failures
(identical to the section shown under "exits 137" — not repeated)
…
> Deduplicated 1 repeated section(s) (~1.2 KB not repeated).
```

Nothing is lost. Headings and provenance always survive, so a query whose every
hit is a repeat shows what it matched instead of claiming it found nothing; a
*different* snippet window over the same chunk is new information and is
rendered in full, marked `— further match` (12 such renders in the same
measurement — a plain "seen this chunk" rule would have destroyed them). One
instance per response covers `ctx_batch_execute`, `ctx_gather` and `ctx_search`.

Identity comes from `chunkIdentity` (the renamed, now exported `fusionKey`):
`source + title + first 120 chars`. `source::title` is not enough — a live index
carries `Untitled (1)`, `Untitled (2)`.

`CONTEXT_MODE_SEARCH_DEDUP=0` restores the previous output byte for byte.

## 17. The hourly WAL reaper no longer deletes fresh knowledge bases

> **Decision recorded in** [ADR-0015 — Content-store lifecycle](adr/0015-content-store-lifecycle.md).

`src/store.ts`

`cleanupStaleContentDBs` set its delete flag from a WAL check that ran
*outside* the age rule: a non-empty WAL untouched for an hour deleted the store
regardless of how new it was. Any session that ended without a checkpoint could
wipe a knowledge base minutes old, and the 14-day retention promise with it.
The comment claimed a PID check; there was none.

Age is now the only reason to delete. The WAL acts inside the age rule and only
protectively: past the cutoff, a recently written WAL means a live owner (in WAL
mode the `.db` mtime only moves on checkpoint), so the store is kept.

| Variable | Default | Effect |
|---|---|---|
| `CONTEXT_MODE_CONTENT_RETENTION_DAYS` | `14` | Retention window for content stores |
| `CONTEXT_MODE_CONTENT_WAL_REAP` | on | `0` drops the WAL guard and goes by `.db` mtime alone |

## 18. Semantic coverage: honest status, and a drain that can fix it

> **Decision recorded in** [ADR-0010 — The semantic layer is adopted, not bundled](adr/0010-semantic-layer-adopted-not-bundled.md).

`src/server.ts`, `src/search/hybrid.ts`, `src/cli.ts`

`ctx_stats` claimed "backfill runs in the background on every search" at every
coverage level, including zero — where it is false twice over. With no embedder
configured there is no backfill at all, and even with one, waiting for the
per-search batch is not a plan: a 1,320-chunk index needs roughly 83 searches.

- The claim splits into the three states it was flattening: inactive (with the
  two ways out, depending on whether an embedder is configured), warming, done.
- `backfillVectorsUntil()` is the bulk pass the per-search warm-up cannot be,
  bounded by both a wall clock and a chunk cap so a detached drain can neither
  run forever nor monopolise a local endpoint. Wired into `context-mode drain`,
  which the SessionEnd hook already runs detached. Measured on this repository:
  **1,104 vectors in a single drain**.
- One line appears in the response itself when the layer is not answering —
  once per process, only above 200 chunks, and only where it changes the result
  (`ctx_search`, global-scope batch queries).

## 19. Disk accounting, budget and compaction

> **Decision recorded in** [ADR-0015 — Content-store lifecycle](adr/0015-content-store-lifecycle.md).

`src/store.ts`, `src/cli.ts`

Nothing measured what the content stores cost. `getDBSizeBytes()` reads the
`.db` file alone, which in WAL mode can be a single page while megabytes sit in
the WAL — measured across 328 stores: **216.5 MB total, 14.3 MB of it WAL**.

- `contentStoreUsage()` walks the directory with `statSync` (no SQLite: opening
  328 databases to ask their size costs more than the answer) and reports bytes
  including sidecars, plus a last-use timestamp.
- `enforceContentBudget()` evicts least-recently-used stores when the directory
  is over budget, down to 90% of it. It refuses to touch the caller's own store,
  any store with a live non-empty WAL, and anything used inside 48 hours. Called
  only from `context-mode drain` — deleting another project's data on the hot
  path of a tool call is not a thing to do quietly. The default budget sits
  above the measured footprint, so the first revision only prints the number.
- `ContentStore.compact()` checkpoints the WAL and VACUUMs, but only when the
  freelist is worth a full rewrite (>1 MB and >20% of the file). Called from
  `drain`, never from `close()`: a session ending should not pay seconds of I/O.
  Measured on this repository's store: **10.7 MB reclaimed**.

## 20. One project's files stop landing in another project's index

> **Decision recorded in** [ADR-0009 — Capture queues](adr/0009-capture-queues.md).

`src/session/code-index.ts`, `src/session/subagent-capture.ts`, `hooks/subagentstop.mjs`

The code-index queue is a single file in a sessions directory shared by every
project on the machine, and the drain indexed whatever it found — whichever
server opened first swallowed the lot. Measured in this repository's own store:
**78 `code:` sources pointing at other repositories**, now evicted.

- The drain indexes only paths inside its `projectDir` and hands the rest back
  to the shared inbox, the way it already handles overflow, so the owning
  project's server can claim them.
- Overflow parks in a per-project backlog (`code-index-queue-<hash>.txt`) so two
  projects draining at once cannot steal each other's backlog. Hooks keep
  appending to the inbox — they run wherever the agent is and have no store to
  key off.
- Subagent digests carry the same problem with no path to filter on, so the
  SubagentStop hook stamps `projectDir` on the queue entry and the drain defers
  entries belonging to elsewhere. Unstamped legacy entries stay first-come.
- `pruneForeignCodeSources()` cleans up what already leaked.

`CONTEXT_MODE_CODE_INDEX_PROJECT_SCOPE=0` restores the shared behaviour.

## 21. Stats that do not contradict themselves

`src/session/analytics.ts`, `src/server.ts`, `docs/adr/0005-stats-scope-labels-and-containment.md`

`ctx_stats` could print "This chat: 6.9 MB kept out" directly above "All your
work: 6.7 MB kept out". Two causes, both in Sections 3-4 — Section 1's
compression formula (ADR-0004) is untouched and now has a regression test.

The narrow number was not narrow: `getConversationWindowStats` pools the whole
worktree on purpose, so the sub-agents a conversation spawns (own `session_id`,
same cwd hash) are credited to it. That is right; "This chat" is the wrong name
for it. And the wide number counted less: `scanOneAdapter` still reports
`contentBytes: 0`.

- Three labelled rows: **This session** (new), **This project** (the same
  worktree pool, renamed), **All your work**.
- Containment by raising the wider scope, never lowering the narrower one — the
  same direction as the monotonic-growth invariant these counters obey.
- The disk footprint gets its own row, worded so it cannot be read as more bytes
  saved.
- The cost block names its basis ("own byte counters at list rates — not an A/B
  measurement"). The 10-developer projection moves behind
  `CONTEXT_MODE_STATS_TEAM_EXTRAPOLATION=1`; `CONTEXT_MODE_STATS_COST=0` drops
  the section.

## 22. Storage hygiene

> **Decision recorded in** [ADR-0015 — Content-store lifecycle](adr/0015-content-store-lifecycle.md).

`src/server.ts`, `vitest.config.ts`, `tests/setup-storage.ts`

Every session wrote its own `stats-<id>.json` and nothing ever removed them —
**735 files on this machine**, all read on every `ctx_stats` call. Plain
deletion is not an option (the lifetime counters are summed from these files,
and a metric that goes down is worse than a directory that grows), so
`rollUpStaleStatsFiles()` folds the bytes of files untouched for the retention
window into `stats-rollup.json` and then deletes them. The age rule is what
keeps a live session's own file from being counted twice.

`npm test` also wrote into the real `~/.claude/context-mode` — **297 stray
content DBs** and hundreds of stats files, which the plugin's own disk
accounting then counted as the user's data. Fake HOME was opt-in per suite; it
is now global, but narrowly: `tests/setup-storage.ts` redirects `homedir()` only.
The two wider options both break real suites — a global HOME breaks every test
that shells out through an asdf/nvm shim, and a global `CONTEXT_MODE_DIR` leaks
into spawned hooks whose tests then look under their own HOME. Measured per run:
13 stray content DBs before, 1 after; the remainder comes from suites that spawn
children with a HOME of their own, which already isolate their own writes.

## 23. The execution watchdog watches for silence, not for elapsed time

> **Decision recorded in** [ADR-0006 — Execution isolation posture](adr/0006-execution-isolation-posture.md).

`src/executor.ts`, `src/types.ts`

A wall clock cannot tell a long build from a hung one — issue #406 is the whole
design constraint here, not a footnote: a 30-minute Gradle build prints
continuously and a wedged process prints nothing, and only one of them should be
killed. So the limit added here is **silence**. Every byte of output resets it,
it arms only when the caller passed no timeout of its own, and never in
background mode, where being quiet is the job.

**It ships off.** `CONTEXT_MODE_EXEC_IDLE_TIMEOUT_MS` defaults to `0`. The
mechanism lands a revision ahead of the default deliberately: a watchdog that
kills honest work is worse than no watchdog, and real use is the only thing that
can show which it is. `CONTEXT_MODE_EXEC_WALL_TIMEOUT_MS` (also `0`) exists for
callers who do want an absolute cap and know what #406 cost.

Four things changed alongside it:

- **`ExecResult.killedBy` says which limit fired** — `timeout`, `idle`, `wall`
  or `output-cap`. `timedOut` stays true for all four, so no existing consumer
  has to know the difference until it wants to.
- **A killed process gets to clean up.** `killTree` sends SIGTERM and escalates
  to SIGKILL after `CONTEXT_MODE_EXEC_KILL_GRACE_MS` (2000), so a killed build
  can flush its output and drop its lock files. The one exception is the
  output-cap path: that process is drowning the host in bytes and must stop now.
- **The output cap drops from 100 MB to 32 MB**
  (`CONTEXT_MODE_EXEC_MAX_OUTPUT_BYTES`). The parent buffers this; a cap that
  large protects nothing.
- **`CONTEXT_MODE_EXEC_ENV_MODE=allowlist` inverts the environment filter.** A
  denylist can only remove what it has heard of, and today `AWS_*`, tokens and
  connection strings all reach a script the model wrote. Opt-in, because
  inverting it also breaks any command that legitimately reads a credential from
  the environment. The allowlist names the runtime settings the executor already
  relies on (`PYTHONUNBUFFERED`, `PYTHONDONTWRITEBYTECODE`, `PYTHONUTF8`, …) so
  they survive the inversion.

## 24. Re-indexing unchanged content stops rewriting the index

`src/store.ts`, `src/types.ts`, [ADR-0007](adr/0007-content-hash-index-cache.md)

`index()` rewrote a source unconditionally — delete every chunk, re-chunk,
re-insert — while already writing the SHA-256 that would have told it not to.
The column existed only for the staleness check and was never read on the write
path.

Measured over 120 tracked files of this repository, 831 chunks
(`scripts/measure-index-skip.mjs`,
`docs/research/index-skip-2026-08-18.md`):

| pass | ms/file | skipped | orphaned vectors |
|---|---|---|---|
| first index (cold) | 5.30 | 0 | — |
| re-index, cache on | **0.11** | 120 | **0** |
| re-index, cache off | 6.76 | 0 | **831** |

**63.5× on unchanged files**, against a bootstrap budget of ~12.5 ms/file. The
orphan column is the larger result: `chunk_vectors` is keyed on `chunks.rowid`
and an FTS5 delete/insert hands out new rowids, so every re-index of an
unchanged file threw away all 831 embeddings and made the backfill compute them
again.

It also closes a re-read that ran forever. `#refreshStaleSources` gates on
`mtime > indexed_at`, so a file whose mtime moved without its bytes changing was
re-read and re-hashed on **every single search**. Both the skip and the
hash-match branch now move `indexed_at` forward.

The hash is computed for every source, not only file-backed ones: command
captures dominate this index, and a repeated capture is exactly as skippable as
an unchanged file.

**The trade, stated in the ADR rather than discovered later:** a skipped chunk
keeps the `session_id` of the session that first indexed it. Re-attributing
means an UPDATE on an FTS5 column, which changes the rowid and destroys the very
saving this exists for. First writer wins;
`CONTEXT_MODE_INDEX_HASH_SKIP_REATTRIBUTE=1` forces the rewrite for anyone who
needs per-session attribution more. `CONTEXT_MODE_INDEX_HASH_SKIP=0` restores
the old behaviour. A skipped call returns `IndexResult.skipped` with
`sourceId: -1` and the counts already stored.

## 25. Search says how much of the match set the caller is seeing

> **Decision recorded in** [ADR-0016 — Search responses declare what they omit](adr/0016-response-declares-what-it-omits.md).

`src/search/completeness.ts`, `src/store.ts`, `src/server.ts`

Three results say nothing about whether three was all there was or the first
three of forty — and that difference decides whether the reader searches again
or stops. The retrieval layer already knew: RRF builds a score map over every
candidate before slicing to the limit, then threw the size away.

```
> Showing 3 of 17+ matching section(s). More: ctx_search(queries: ["retry"], limit: 6)
> Complete: all 2 matching section(s) shown.
> 2 query(s) had more matches than shown. Raise `limit`, scope with `source: "<label>"`, or ask a narrower question.
```

- `searchWithFallbackMeta()` returns the results plus `{shown, poolSize,
  saturated}`. The old signature delegates to it, so no call site and no test
  had to move.
- **"Complete" is claimed only when the pool is provably untruncated** — no
  layer hit its fetch limit and no post-filter ran. Everywhere else the total is
  `N+`. The error always points at "there may be more": erring that way costs a
  character, erring the other way tells the reader to stop looking when there
  was more to find.
- One line per query, one escalation block per response, both before the
  throttle line. Timeline mode says nothing at all — it merges this session,
  prior sessions and auto-memory into one list, so there is no single pool to be
  complete with respect to.
- Rows added by hybrid fusion or auto-memory are counted separately as
  `(+N from memory/semantic)` rather than silently inflating the denominator.

`CONTEXT_MODE_SEARCH_COMPLETENESS=0` and `CONTEXT_MODE_SEARCH_ESCALATION=0` turn
the two halves off independently. `CONTEXT_MODE_SEARCH_EXACT_TOTALS=1` replaces
the lower bound with a real count by re-fusing at a wider fetch — off by
default, because it is real work on a large index in exchange for a nicer
number, and it is still capped at 500.

## 26. "Sandbox" was the wrong word for it

`src/server.ts`, `README.md`, `hooks/routing-block.mjs`, `skills/`, `agents/`,
[ADR-0006](adr/0006-execution-isolation-posture.md)

The tool descriptions promised a "sandboxed subprocess" and the README promised
"complete isolation". Probed with `scripts/measure-sandbox-wording.mjs`
(`docs/research/sandbox-wording-2026-08-18.md`), **five of the six implied
properties are false**: the subprocess runs in the user's real project root, can
read their home directory, inherits every environment variable the denylist has
not heard of, and has unrestricted network.

The sixth holds exactly, and it is the one the plugin exists for — in the same
probe a script read 5,823 bytes and the conversation received one line.

So the word is now "separate subprocess", in the tool descriptions, the approval
titles, the routing block, the README, the skills and the agent definition. The
sentence that actually drives routing — "only what you print enters the
conversation" — is unchanged word for word, because the probe confirms it.
Internal identifiers (`bytesSandboxed`, `bytes_sandboxed`, `sandbox-execute`
events) keep their names: they are columns and event types in databases already
on disk.

ADR-0006 records the posture, including why bwrap/landlock/seccomp are not being
added — a three-OS CI matrix, a host that already gates the tool behind an
approval prompt, and the observation that a sandbox which must allow project
reads, temp writes and network restricts little of what matters — and why the
execution watchdog (#23) is idle-based. The README now tells users to sandbox
the host if they want an OS sandbox, instead of implying this already did.

## 27. Splitting `src/server.ts`

> **Decision recorded in** [ADR-0020 — The ToolDeps seam](adr/0020-tooldeps-seam.md).

`tests/shared/server-source.ts`, `tests/core/tool-registration.test.ts`,
`src/tools/shared/deps.ts`, `src/tools/search.ts`, `src/search/dedup.ts`

A 6,276-line module is where every `sync-upstream` conflict lands. Splitting it
is ordinary work; doing it without silently breaking the tests that guard it is
not, because **40 call sites across 8 suites read `server.ts` as text** and
assert on what they find — and a `not.toContain` over a shrinking file always
passes.

**First, the safety net (`8e01616`, deliberately a no-op).**
`tests/shared/server-source.ts` becomes the only place that knows which files
make up "the server"; when a region moves out, its new home joins
`SERVER_SOURCE_FILES` and every assertion keeps meaning what it meant.
`tests/core/tool-registration.test.ts` is the acceptance gate: the same twelve
tools, the same names, the same registration order (MCP hosts render the list in
that order), each with a handler and a description. It also greps the combined
source for `registerTool` names, so a handler moved into a file the helper does
not list fails loudly instead of vanishing. Baselines recorded for the move:
bundle 740,908 bytes — a local build, see below — `madge --circular` 5 cycles,
none through `server.ts`.

**Then the first motion (`f1252c9`).** `ctx_search` and the deduper move out:

- `src/tools/shared/deps.ts` — the `ToolDeps` seam. Everything a tool module
  needs from `server.ts` arrives as data instead of an import, because importing
  `getStore` or `trackResponse` back would close a cycle that resolves by
  evaluating one side half-initialised — a bug that shows up only in the bundle,
  only at startup, only sometimes. The interface is short on purpose: it is the
  honest record of how much state a handler touches.
- `src/tools/search.ts` — the 331-line `ctx_search` registration, moved
  verbatim. The one behavioural difference: the host adapter is read through a
  getter, since detection finishes after the module is imported.
- `src/search/dedup.ts` — `CrossQueryDeduper`, so a tool module can use it
  without reaching back into `server.ts`. Re-exported from `server.ts`, which is
  where its tests import it from.

Registration stays in the same position, so the tool list order is unchanged.

| | before | after |
|---|---|---|
| `src/server.ts` | 6,276 lines | 5,901 lines |
| `server.bundle.mjs`, built locally | 740,908 B | 741,535 B (+0.08%) |
| `madge --circular` | 5 cycles | 5 cycles, none through `server.ts` |
| `npm test` | — | 5,038 passing |

The bundle row measures a **local build of each commit's source** — the same
esbuild invocation `npm run bundle` runs, esbuild 0.27.7 — not the artifact
committed at that point. The two differ: nothing in the split rebuilt the
bundle, so the committed `server.bundle.mjs` sat at 729,840 B from before
`f1252c9` until `281049f` regenerated it. Rebuilding each state from its own
source is what makes the before/after comparable; reading the committed blob
would have measured when someone last ran the build, not what the split cost.

**Then the second motion (`9f769db`).** `ctx_batch_execute`, `ctx_gather`,
`ctx_fetch_and_index` and the stats/ops handlers move out the same way:
`src/tools/batch.ts` (363 lines), `src/tools/fetch.ts` (911), `src/tools/ops.ts`
(287), and `src/tools/shared/state.ts` (114) for the cross-handler state the
`ToolDeps` seam does not carry. The table above describes the split up to
`f1252c9`; measured at `281049f`, `src/server.ts` is down to 4,711 lines from the
6,276 it started at, the local bundle build is 752,021 B (+1.5% over the
pre-split 740,908), and `madge --circular` still reports the same 5 cycles, none
of them through `server.ts`.

## 28. Retrieval quality is a number now, and the number is gated

> **Decision recorded in** [ADR-0017 — Retrieval quality gate](adr/0017-retrieval-quality-gate.md).

`tests/fixtures/relevance-corpus.json`, `tests/fixtures/retrieval-baseline.json`,
`scripts/measure-retrieval.mjs`, `scripts/lib/retrieval-metrics.mjs`,
`tests/core/search.test.ts`

The suite asserted individual rankings — "this query returns that source first"
— which catches a named ranking flipping and nothing else. A change that trades
five wins for four losses touches no assertion and passes.

40 competing documents and 74 labelled queries now live in a fixture, and every
query is answered twice at top-5: through the lexical path alone
(`searchWithFallback`) and through the hybrid path the server actually runs
(`hybridSearch` re-fusing the lexical top-5 with semantic candidates). Both
arms come out of one throwaway store under the OS temp directory; nothing
touches the user's knowledge base.

| metric | lexical | hybrid |
|---|---|---|
| precision@1 | 66.2% | 87.8% |
| recall@5 | 77.0% | 97.3% |
| MRR@5 | 0.699 | 0.910 |

**Two of the eight query classes exist to be lost by lexical search.**
`paraphrase` states the intent in words the document never uses;
`cross-lingual` asks in Russian about English documents. They drag the lexical
aggregate down on purpose, and they are where the semantic path earns its round
trip — cross-lingual precision@1 goes 7.1% → 85.7%, paraphrase 28.6% → 57.1%,
`long-code` (the answer buried inside a multi-chunk file) 83.3% → 100%. On the
`keyword`, `title` and `negative` classes the two arms score identically: the
semantic layer changes nothing where lexical already wins.

Lexical search finds nothing relevant at all in the top 5 for **17 of the 74
queries** — 13 of the 14 Russian ones and 4 paraphrases. That is the honest size
of the gap, and it is recorded rather than argued about.

**The gate is lexical only.** `npm test` compares a fresh run against
`retrieval-baseline.json` minus a tolerance of **0.03** — on all three
aggregates, on per-class precision@1, and on the count of queries answered by
nothing relevant. The lexical arm is deterministic (same corpus, same index
order, same ranking, run after run), so the tolerance is not there to absorb
noise; it is there so a deliberate tuning change that trades one ranking for
another does not have to be accompanied by a baseline rewrite. Three points is
roughly two of the 74 queries, and a real regression — a search layer dropping
out, a weight inverted — moves these numbers by tens of points.

The hybrid arm stays out of CI: it needs a live embedding endpoint, and a gate
that fails when a model is unreachable is worse than no gate. The 18 individual
cases the suite had before the corpus moved into a fixture are still asserted
one by one, and a test asserts their count so that "fixing" a regression by
deleting a case fails instead.

The metric code has one implementation (`scripts/lib/retrieval-metrics.mjs`),
shared by the harness that records the baseline and the test that checks it —
two copies of "what precision@1 means" would drift, which is the failure a
baseline gate exists to catch. Full report:
`docs/research/retrieval-2026-08-18.md`.

**The report is protected from the harness that writes it**, which is a rule
that exists because the harness destroyed it once. The script wrote the
research note by default, so someone running it to check a number — with no
embedding endpoint configured — rewrote the file with eight rows of `—` where
the hybrid measurements had been. The run that could measure them had already
finished.

Two things came out of that, and the first alone would not have been enough:

- Writing is now explicit — `--report`, or `--report <path>`. Without it the
  harness only prints, like `measure-index-skip.mjs` and
  `measure-search-dedup.mjs` next to it. Writing by default was the deviation
  from the neighbouring convention, and it is what turned "look at a number"
  into "overwrite a document".
- **A run with fewer arms will not replace a run with more** unless `--force`
  is passed. `scripts/lib/report-guard.mjs` reads the file it is about to
  replace — parsing the rendered metric row, not consulting the environment,
  because whoever overwrites may be configured differently from whoever wrote,
  which is precisely how the column was lost. The refusal names the arm that
  would be discarded and the three ways forward, and exits non-zero with the
  file untouched; the run's numbers are on stdout either way, so nothing is
  lost by refusing. A run with the same arms, or more, still overwrites without
  a flag — demanding `--force` for ordinary re-measurement would make passing
  it a reflex, and the guard would be gone.

`tests/scripts/measure-retrieval-report.test.ts` asserts the rule by running
the real script with `--lexical-only`, which is exactly the configuration that
caused the loss.

## 29. Source files chunk at declaration boundaries

> **Decision recorded in** [ADR-0018 — Code-aware chunking](adr/0018-code-aware-chunking.md).

`src/store.ts`, `scripts/measure-code-chunking.mjs`,
`scripts/lib/code-chunk-boundary.mjs`, `tests/store-code-chunking.test.ts`

`index()` sent every file through `#chunkMarkdown`, whatever it was. That
function looks for `#` headings and blank-line paragraphs; a `.ts` file has
neither, so the whole file arrived as one section and was then cut at paragraph
boundaries until each piece fit the 4 KB cap — landing the cut wherever the byte
budget ran out, usually mid-function. Two things pay for that: BM25, because a
chunk's title is its first line and the title carries five times the body's
weight, and embeddings, because half a function embeds as half a thought.

Files with a source extension now go through `#chunkCode`, which cuts at
declarations and packs consecutive small ones until a chunk reaches
`CODE_CHUNK_MIN_BYTES` (1 024). A file the heuristic cannot read falls through
to `#chunkPlainText`, which caps properly.

Measured over 120 tracked files, corpus selected by rule rather than by hand
(`docs/research/code-chunking-2026-08-18.md`):

| | before (flat) | after (code-aware) |
|---|---|---|
| chunks | 485 | 1 022 |
| **starts at a declaration** | **337 (69.5%)** | **891 (87.2%)** |
| chunks titled `Untitled…` | 455 of 485 (93.8%) | **0** |
| median chunk | 3 705 B | 1 299 B |
| largest chunk | 6 522 B | 4 096 B |

On TypeScript alone, 77.5% → **92.2%**.

**The title column is probably the larger result, and no ratio captures it.**
Every chunk of every source file used to be titled `Untitled (7)` — a heading
stack over a file with no headings. Chunks are now titled
`export function drainCodeIndexQueue(opts…`, `#insertChunks(`,
`class TokenResolver`, against a title weight of 5.0 in `bm25()`.

**The measurement argues with itself, which is why it is worth reading.** A
second, stricter boundary test — top-level declarations only — *falls* as a
ratio, 39.2% → 36.2%, while rising in absolute terms from 190 to 370 chunks: a
100 KB class that used to arrive as 25 byte-capped slabs now arrives as one
chunk per method, and every one of those is indented and invisible to the strict
test. And the 69.5% baseline is far above the 30.5% the plan assumed — the old
chunker cuts after blank lines, and programmers put blank lines between
functions, so it landed on a declaration by accident a good part of the time. It
just could not do so on purpose, which is the same reason it produced the
6 522 B chunk and the 455 `Untitled` titles.

**Cost: 2.1× the FTS5 rows and 2.1× the vectors** for the same bytes of content.
`CODE_CHUNK_MIN_BYTES` is the dial — 512 gives 89.2% at 824 B median, 2 048
gives 84.0% at 2 223 B. Every setting clears the 80% target, so the choice is
about chunk size, not about the metric; 1 024 B is roughly one documented
function.

`CONTEXT_MODE_CODE_CHUNKING=0` restores the old behaviour **byte for byte**, and
that was verified rather than assumed: `src/store.ts` from `HEAD` was compiled
into a scratch tree, run over the same 120 files, and the SHA-256 of the full
chunk dump (485 chunks; file, title, content, content type) matches the new
build's output with the flag set — `cb2d7dc7c78d237a…` both ways.

The P2.1 harness (#28) reports **0.662 / 0.770 / 0.699 with the change on, with
it off, and at the baseline** — identical to three decimal places, per class as
well as in aggregate. Expected, and worth stating: the relevance corpus is
indexed from strings with no file path, and the extension gate never opens for
content without one.

Not measured: the plan named `.py` and `.php`, and this repository contains
neither. Those are covered by `tests/store-code-chunking.test.ts` on
representative sources, which is weaker evidence than a real corpus and is not
counted in the numbers above.

## 30. `context-mode inventory` — what is recorded about this project

`src/cli.ts`

The knowledge base could not answer the first question anyone asks of it: what
is in there about me? `ctx_stats` reports savings, `ctx_search` needs a query,
and neither lists what is stored.

```
$ context-mode inventory
project: /home/osddqd/projects/context-mode
db: /home/osddqd/.claude/context-mode/content/c2c6ef653d394742.db
size: 45.4 MB (+ 3.9 MB WAL)
last indexed: 2026-08-17 23:45:23

sources: 319, chunks: 2027

by type:
  code          265 sources     1471 chunks
  batch          52 sources      539 chunks
  smoke-spa       1 sources       11 chunks

largest sources (top 10):
  83 chunks  code:docs/plan-progress.md
  83 chunks  code:tests/core/server.test.ts
  72 chunks  code:src/server.ts
```

`--project <path>` switches project, `--top <n>` sizes the largest-sources list,
`--json` emits the same model as JSON. Read-only: no `index`, no `deleteSource`,
no `compact`, no budget eviction — a test asserts the command body contains none
of them. The one side effect it cannot avoid is `ContentStore`'s constructor
creating the database file for a project that never had one; there is no
read-only store API to open instead.

Grouping is by the prefix of the source label (`code:`, `batch:`, `execute:`,
`fetch:`), and only when that prefix reads like a kind — lowercase letters,
digits and dashes. Otherwise the source counts as `other`. That rule is what
stops a Windows path indexed under its own name (`C:\src\app.ts`) from inventing
a type called `C`, and stops free-form user labels from each becoming a type of
their own. Totals come from the store's own `getIndexState()` rather than from
re-summing `listSources()`: if the two ever disagree, that is a fact about the
store and the report should show the store's answer.

## 31. Credentials are screened on the way into the index

> **Decision recorded in** [ADR-0019 — Credential screening at index time](adr/0019-index-time-credential-screening.md).

`src/session/redact.ts`, `src/store.ts`, `src/types.ts`

The index is a durable, searchable copy of whatever passed through a tool. A
`.env` pasted into a batch command, an `aws configure` transcript, a PEM cat'ed
by mistake — all of it lands in SQLite and stays there, answering searches, long
after the terminal scrollback is gone. `isSensitivePath()` (#5) already keeps
whole files out by name; this keeps credentials out of the files nobody would
think to exclude.

`redactSecrets()` is line-oriented and pure — no env reads, no I/O, no store
dependency — and replaces what it finds with `[redacted:<type>]`. Rules: `sk-`,
`gh[pousr]_`, `A[KS]IA`+16, `xox[baprs]-`, and assignments whose key matches the
same `SENSITIVE_NAME_HINT` that `isSensitivePath` uses. A PEM header on a line
of its own opens a block that collapses, header through footer, into one marker
— redacting only the header would leave the secret, which is the body.

**The interesting half is what it refuses to touch.** A false positive here
silently corrupts indexed source code, and nobody finds out until a search
returns `[redacted:…]` where a function used to be. The first version of the
assignment rule produced **nine false positives across this repository's 136
source files** — every one an ordinary expression assigned to a name containing
"token": `const input_tokens = toNum(u.input_tokens)`, `tokens: Math.round(…)`,
`const tokens = tokenizeCommand(cmd)`. The rule was tightened against those
until the value has to look like a literal rather than like code: one unbroken
opaque run, no bare numbers, no paths or URLs, and — when unquoted — a digit
among the letters and an assignment that starts the line. It now scores **zero
redactions over those 136 files and over the 25 captured fixtures** (logs, JSON
payloads, diffs, transcripts, Playwright snapshots), and both sweeps are tests,
so a future loosening fails with the file and the rule named.

Also left alone, each with a test: base64 inline assets, minified bundles,
UUIDs, git object ids, `sha512-…` integrity hashes, long paths, `sk-` inside
`task-manager`, and the word `Bearer` in documentation.

**Cost: 13.4 ms/MB** on the default path (22.7 with the entropy layer on, and an
early return when screening is disabled) — 0.035 ms for a 4 KB payload, 0.70 ms
for 64 KB. Against a cold index of ~5.3 ms/file (#24), that is a few percent.
Cheap because every rule is gated behind an `indexOf` for its literal marker, so
the regexes almost never run.

Screening happens in one place, called by `index()`, `indexPlainText()` and
`indexJSON()` exactly once each, and always **before the content hash**. That
ordering is what keeps the P1.2 cache honest: the stored hash describes the
bytes that were actually stored, so flipping `CONTEXT_MODE_INDEX_REDACT`
invalidates the row and re-indexes the source instead of leaving a stale hash
pointing at differently-screened content. `IndexResult.redactions` reports the
count, and only when there was one.

**The entropy layer is off by default and stays that way.**
`CONTEXT_MODE_INDEX_ENTROPY_REDACT=1` turns on a Shannon-entropy heuristic over
long opaque runs. It is a heuristic, and the documentation says so rather than
implying otherwise: on real code it fires on base64-inlined assets and minified
bundles — content that is not secret and that the index exists to make
searchable — and a credential with no recognisable marker passes both layers
regardless. This reduces accidental capture. It is not a control to rely on when
handling credentials.

## 32. `ctx_purge` can delete one source instead of everything

> **Decision recorded in** [ADR-0015 — Content-store lifecycle](adr/0015-content-store-lifecycle.md).

`src/server.ts`, `src/store.ts`

`ctx_purge` had two settings: one session, or the whole project. Between them
sits the case that actually comes up — one source went in wrong. A stale doc
site, a 40 MB log capture, a file indexed from the wrong branch. The only
remedy on offer was to delete the entire knowledge base and re-earn it, so the
realistic outcome was that nobody purged anything and the bad source kept
answering searches.

```
ctx_purge(confirm: true, source: "react-docs")
  → Purged source "react-docs": N section(s) removed.
```

The source branch returns before the file-level wipe the other scopes run:
nothing is closed, no file is unlinked, the stats file is not reset, and every
other source, session row and counter survives untouched.

**The label must match exactly, and a miss is refused rather than guessed.**
This is the part worth stating, because the temptation runs the other way:
`ctx_search`'s `source` filter matches partial labels, so a caller who learned
a label there will reasonably pass a substring here. A cheerful "purged" would
then read as "it is gone" while the source is still indexed and still
answering. So a label that matches nothing is an error, and the error names the
indexed labels that contain it — up to ten, then `+N more` — or, when none are
close, says how many sources exist and points at `ctx_stats`.

**Combining `source` with anything wider is refused as ambiguous.** `source`
implies `scope: "source"`; pairing it with a `sessionId` or with
`scope: "project"` asks for two different deletions at once, and choosing one
of them on the caller's behalf is exactly how a whole-project wipe happens by
accident. `scope: "source"` without a label is refused too.

**A partial delete reports itself as one.** `sources.label` carries no UNIQUE
constraint, so one label can own several rows — a legacy import, an interrupted
re-index. The handler loops until the label is gone and, if it could not finish,
answers `Partially purged source "…": N of M row(s) removed` as an error with
what to do next. Removing one row of three and calling it done is the same
silent success as removing none.

## 33. The hook bundle that the build never built

> **Decision recorded in** [ADR-0013 — Tracked bundles are the running code](adr/0013-tracked-bundles-are-the-running-code.md).

`package.json`, `.gitignore`, `.github/workflows/bundle.yml`,
`scripts/plugin-cache-integrity.mjs`, `hooks/session-attribution.bundle.mjs`,
`tests/scripts/bundle-manifest.test.ts`,
`tests/hooks/attribution-bundle-parity.test.ts`,
`tests/integration/cross-project-attribution.test.ts`

`270a56f` added per-event project attribution: the source
(`src/session/project-attribution.ts`), its tests, and a built
`hooks/session-attribution.bundle.mjs`. It did not touch `package.json`. The
bundle was produced by hand once and never entered `scripts.bundle`, so the
build has never rebuilt it — while the source went on to change three times
(`79e0d7e`, `92997e4`, `2e7a543`).

That matters because the hooks load the bundle, not the source.
`createSessionLoaders().loadProjectAttribution()`
(`hooks/session-loaders.mjs:41-53`) resolves bundle first, `build/session/` only
as a fallback, and five hook entry points go through it — PostToolUse,
UserPromptSubmit, SessionStart, Stop, PreCompact. Every attribution test, in
turn, imported `src/`. So the tests and the runtime were reading two different
files, and nothing compared them.

Rebuilding the source with the same esbuild invocation the other bundles use
shows what four months of that cost:

| | shipped bundle | rebuilt from source |
|---|---|---|
| size | 2,799 B | 3,250 B |
| sha256 | `3c041cd0…61743` | `a91a10c6…8ec3b` |
| Bug 8 fix (`2e7a543`) | absent | present |
| `ATTRIBUTION_CONFIDENCE` | not exported | exported |

Concretely: given a `cwd` event for project B followed by a path-less event in
the same batch, with the hook's own cwd pointing at project A, the shipped
bundle attributed the second event to A and the rebuild attributes it to B.
That is exactly the fix `2e7a543` landed in June — dead in production ever
since, with a green test suite standing over it.

**None of the three guards could see it.** `npm run assert-bundle` scans an
explicit list of files and the orphan was not on it. `plugin-cache-integrity`
misses it twice: it checks existence only, never content, and the file is
whitelisted into `SOFT_FALLBACK_BUNDLES` *and* absent from the set derived from
`scripts.bundle` — a file that is not built cannot be required. The CI workflow
commits bundles by an explicit `git add -f` list, which the orphan was also not
on. Three mechanisms, each correct in its own terms, none of them asking the one
question that mattered: is this file still what its source says it is.

Deleting the orphan and living on the `build/` fallback was not an option:
`build/` is gitignored and untracked, so on a marketplace install — a git clone
— the bundle is the only copy that exists, and its absence would have made
`loadProjectAttribution()` throw into the silent `catch` that PostToolUse keeps
so hooks never block a session. The events would have stopped being recorded
without a word.

So the bundle joins the build: `scripts.bundle` produces it, `assert-bundle`
scans it, the CI workflow commits it, `.gitignore` treats it like the other six.
Two invariants keep it there. `tests/scripts/bundle-manifest.test.ts` asserts
that every `hooks/*.bundle.mjs` in the tree is produced by `scripts.bundle`,
scanned by `assert-bundle` and committed by CI — with its first test pinning the
`--outfile=` parser against known literals, since every later assertion is
"X is a member of what the parser returned" and a parser returning nothing would
pass all of them. `tests/hooks/attribution-bundle-parity.test.ts` asserts
against the built bundle rather than `src`: the Bug 8 case explicitly, then
parity between bundle and source across five event batches, then that the bundle
exports everything the source exports. Both were red before the rebuild and
green after. `tests/integration/cross-project-attribution.test.ts` — the suite
that should have caught this and could not — now resolves through
`loadProjectAttribution()`, the way the hooks do; its own comment used to claim
it was exercising the production path while importing `src/`.

**The correction is not retroactive.** Rows already in `session_events` keep the
`project_dir` they were written with, so per-project history has a seam at this
commit: path-less events following a `cd` or `git -C` are attributed to the
target project after it and to the session's startup cwd before it. Aggregates
that span the boundary mix both conventions.

## 34. Three searches become one plugin

> **Decisions recorded in** [ADR-0021 — Retrieval consolidation](adr/0021-retrieval-consolidation.md) and [ADR-0022 — Honest savings accounting](adr/0022-honest-savings-accounting.md).

Until this wave the agent's context was served by three independent MCP
servers — fff for lexical file search, codegraph for structure, context-mode
for memory and the sandbox. Each carried its own index, its own filesystem
watcher and its own tool surface, and the model chose between them badly
enough that a global `CLAUDE.md` rule ("use fff to find files") had to exist.
That rule was a symptom. The signals are orthogonal — names, structure,
recorded text, meaning — so the fix is to add them, not to pick between them.

### fff runs as a library

`@ff-labs/fff-node` is pinned to exactly `0.10.5` — 0.x API, roughly 290
releases in five months, so a caret would drift under us. An FFI binary cannot
be bundled, so it installs through `hooks/ensure-deps.mjs` beside
better-sqlite3 and the loader assembles its import specifier at runtime;
esbuild leaves it alone, and `--external:@ff-labs/fff-node` backs that up.

`src/fff/` keeps one native index per project root behind an explicit
`destroy()` — the index lives in Rust where the garbage collector cannot see
it — and keys its frecency/history stores by the same project hash the FTS5
store uses, so the cross-project leak of change 20 cannot reopen through a new
channel. Two facts the plan did not anticipate, both measured: those stores are
LMDB directories rather than SQLite (no `busy_timeout` to set; four processes
writing 200 selections each produced zero failures), and `watch()` refuses
subscriptions until its first scan completes, so attachment waits for the scan.
A missing native library degrades to "unavailable"; nothing throws.

### One watcher for the whole plugin

`src/fs-bus/` turns fff's watcher into the plugin's only filesystem event
source. Three consumers hang off one debounced, coalescing subscription: FTS5
`code:` chunks are re-indexed on change and evicted on delete, the
`codegraph sync` queue is fed through the seam `src/graph/daemon.ts` exposes,
and a `registerPathCache` registry stands ready. That registry ships empty on
purpose — the plan assumed `ctx_execute_file` had a per-file cache to
invalidate, and it does not; `executeFile` reads the file inside the sandbox on
every run. Re-indexing goes through `store.index({path})` without content, so
the store re-reads, screens and hashes the *screened* bytes; a changed file
cannot keep a stale hash.

### `ctx_graph` reads the index instead of asking a server

codegraph exposes exactly one MCP tool, while its whole value sits in an open
SQLite schema. `src/graph/` opens `<project>/.codegraph/codegraph.db`
read-only — driver flag plus `PRAGMA query_only`, verified by tests that assert
INSERT/DELETE/CREATE all throw, on a live 235 MB index as well as a synthetic
one. (`file:…?mode=ro` does not work here: neither better-sqlite3 nor
`node:sqlite` passes `SQLITE_OPEN_URI`, so the URI would be read as a filename.)
Schema is pinned to versions 1–8; drift or an incomplete index degrades to
`codegraph <cmd> -j`, never to a guess. Answers carry a freshness line —
"index lags N files" — instead of describing yesterday's code silently.

The daemon's lifecycle moves with the tool: it used to be started by the MCP
host through `serve --mcp`, and is now supervised by the plugin, idempotently
across sessions, with a debounced fallback that runs `codegraph sync` at
project level (1.5.0 has no per-file sync). `explore` has no `--json`, so its
output is handed back whole — and that branch bypasses `ContentStore.#screen`,
where credential screening lives, so it is run through `redactSecrets` first.

### `ctx_find` — one query, five signals

`fuseRankings` is generalised into `fuseRankedLists`: N weighted lists, one
identity function, the old two-list call now a spelling of it and numerically
unchanged. Five lists enter — fff file names, fff grep, FTS5, chunk vectors,
codegraph adjacency — and every returned row names the signals that produced
it. The graph list is seeded from the fused lexical rows rather than from the
query, because adjacency has no opinion about words.

The graph weight ships at 0.5, and that number is measured rather than chosen.
Against the 74-query retrieval corpus, fed the worst case (ten plausible but
never-relevant neighbours, which is what a wrong seed produces), P@1 / R@5 /
MRR stay at 0.662 / 0.770 / 0.699 for weights up to 0.75, R@5 falls to 0.730 at
1.0, and everything collapses at 2.0. The env override is clamped to 1.

Coverage is reported per signal, and grep's coverage is stated in files scanned
against files eligible plus a next-page flag: fff pages grep by file and totals
only the page in hand, so "N of totalMatched" would be a lie.

Ranking now learns across the MCP boundary, which the protocol does not
otherwise allow: `ctx_find` publishes the candidates it showed, the PostToolUse
hook records which one was opened, and the next call spends that as
`trackQuery`. The hook records intent only — no hook bundle carries
`src/fff/**` — so a selection is learned at the next search, not instantly.

### Honest token accounting

Every ctx_stats number stood on `bytes / 4`. `src/session/tokenizer.ts`
replaces it with coefficients fitted against OpenAI's published `o200k_base` /
`cl100k_base` rank tables over 4.1 MB of this repository, real command output,
machine payloads and prose in fifteen languages. Held-out error per 4 KB chunk:
4.5 % / 4.7 % versus 18.7 % / 15.3 % for `bytes/4`; on unseen command output,
6.8 % versus 22.0 %. The old constant understated JSON by 25 %, `ls -laR` by
45 % and base64 by 61 %, and overstated Russian prose by 59 % — while being
nearly right on TypeScript, which modern vocabularies encode at ~4.08 bytes per
token. Sites that hold only an aggregate byte count use the measured 3.487
bytes/token; `bytesFromTokens` is its exact inverse, so both sides of every
ratio stay on one basis and all percentages are unchanged. No new dependency:
an exact BPE encoder is used only if one already happens to be installed.

### Returns are subtracted from the savings

If the model reads a file in full after a compressed answer already covered it,
that is a loss the report used to count as a saving.
`src/session/reuse-detector.ts` pairs a compressed delivery naming source X
with a later full read of X inside both a step window (20 tool turns) and a
time window (15 minutes) — both, because `created_at` has second resolution and
every event of one hook fire shares a timestamp, so step distance is the only
reliable ordering, while step distance alone would pair a search with a read
three hours later. The returned bytes are deducted from `bytes_avoided` before
any token conversion, so every downstream consumer inherits the correction with
no formula change, and ctx_stats prints what was taken off. Above a 30 % return
rate the search gateway hands back full text instead of snippets: compressing
into a re-read is a double charge.

### Truncation says what it dropped

`src/truncate.ts` used to end with a bare `... [truncated]`, leaving the model
unable to tell two lost lines from two thousand. It now carries a footer in the
same voice `src/search/completeness.ts` uses for search, and `src/compress/`
adds three samples that each report what they folded: repeated log lines
(normalised for timestamps and counters), env dumps (screened through the
existing `redactSecrets`, tail reduced to names) and test-runner output
(failures and summary kept, green tail folded). The layer is off by default —
`ctx_batch_execute` indexes command output verbatim into FTS5, and folding
before indexing would delete lines a later `ctx_search` is expected to find.

### The diagnostics can see all of it

`ctx_doctor` (both the CLI and the MCP tool) gained a search-layers section:
fff native and package version, LMDB store sizes, watcher and mmap switches,
live roots; codegraph binary, schema version against the pinned window, daemon
liveness, index lag, database size; the bus with its consumers and counters;
tokenizer mode and the compression switch. Every probe degrades to
"not installed" or "off" rather than failing. `context-mode inventory` folds
sources by producer, always listing fff and codegraph even at zero — the zero
is the finding — and reports the footprint that lives outside FTS5.
`context-mode drain` reaps the orphaned `~/.cache/fff_mcp+<ts>+<pid>.log` files
the external server left behind. The injected routing block now points file
search at `ctx_find` instead of an external file-search MCP.

Removing `fff` and `codegraph` from `~/.claude.json` is deliberately left to
the operator: it is a user-owned config, and it should happen only once the
daemon is running under plugin supervision on that machine.

## 35. The plugin as the host sees it

> **Decisions recorded in** [ADR-0014 — The standing context budget](adr/0014-standing-context-budget.md) and [ADR-0013 — Tracked bundles are the running code](adr/0013-tracked-bundles-are-the-running-code.md).

`agents/context-gather.md`, `skills/context-mode/SKILL.md`, `commands/ctx-{find,graph}.md`,
`platform-skills/ctx-{find,graph}/`, `hooks/hooks.json`,
`src/adapters/claude-code/{hooks,index}.ts`, `.claude-plugin/*.json`,
`src/session/analytics.ts`, `tests/plugins/plugin-structure.test.ts`

Change 34 added `ctx_find` and `ctx_graph`, tested them, and shipped them. What it
did not do is tell anyone. Claude Code does not read this repository — it reads a
manifest, a hook registration file, a set of skill descriptions and the tool list
attached to an agent. On every one of those surfaces the two new tools were absent,
which is a specific kind of failure: nothing throws, no suite goes red, the host
simply stops seeing something.

**The tools became reachable.** `agents/context-gather.md` lists its tools
explicitly, and such a list is an allowlist — the research agent written to survey a
tree without reading it could not call the one tool built for that. Both are now in
the list, with the division of labour spelled out in the body: `ctx_find` — where it
lives; `ctx_search` — what we already know about it; `ctx_graph` — how it is
connected. The same three-way split now appears in the routing skill's description
(the text a model reads when deciding whether the skill applies at all), in the root
and platform `CLAUDE.md`, and in the README tool table.

**They got the command parity every other user-facing tool has.** `/ctx-find` and
`/ctx-graph`, both `disable-model-invocation: true` so they cost nothing standing,
plus their `platform-skills/` twins for the hosts that have no slash commands.
Nine commands, nine skills, name for name.

**The PreToolUse hook stopped firing twice.** Three matchers named context-mode's own
MCP tools in full; each is a superstring of `mcp__`, which sat in the same list.
Claude Code fires one process per matching entry, so every `ctx_execute` paid for two
`node` processes and two passes of the delay / redirect / rejected-approach markers
the hook writes into tmpdir. The three were dropped, not replaced — the hook body
(`isExternalMcpTool()`) is what distinguishes our tools from foreign ones, and the
Codex adapter had already reached this shape independently.

**Every hook got a timeout.** Sixteen registrations across eight events had none, so
all of them inherited the host's 60-second default — including `pretooluse.mjs`,
which runs in front of every `Bash` and can self-heal by copying files on a first
run. A minute of silence there is indistinguishable from a hung terminal. Budgets
are graded by position rather than uniform (`HOOK_TIMEOUTS`): 15s on the pre-tool
path, 20s for capture, 30s for the session drain, 45s for `SessionStart`, and 60s
kept deliberately for `PreCompact`, where the work genuinely is heavy.

**The manifests name the fork.** `author`, `homepage`, `repository` and the issues
address pointed at upstream, so a user who installed from this marketplace and
followed the metadata would file a report about this fork's code in someone else's
tracker. Ownership fields now name the fork; the origin stays stated in prose, in the
description and in this document.

**The savings claim rests on the measurement again.** `analytics.ts` carried
`lifetimeTokensWithout * 0.02` as a fallback — a hardcoded 98% that asserted the
headline rather than measuring it, and which nothing consumed (its only reader,
`renderHero`, has no call sites). Removed. The claim itself is now stated identically
in the manifest, the marketplace entry and the README, and traced to its corpus:
315 KB of raw output across the 14 `ctx_execute_file` scenarios comes back as 5.4 KB.
`BENCHMARK.md` said 5.5 KB; summing its own rows gives 5,517 B, so the README was
right and the subtotal was not.

**The litter has a source and the source is fixed.** `f0.tmp`, `f1.tmp`, `f2.tmp`
appeared in the repository root on every `npm test`: an executor concurrency test
wrote to `process.cwd()`, and the executor sets the sandbox cwd to the project root.
Each run now makes its own `mkdtemp` directory and removes it.

**And the whole contract is a test now.** `tests/plugins/plugin-structure.test.ts`
pins the six rules that break quietly — canonical layout, a `SKILL.md` per skill
directory, command ↔ platform-skill parity, no absolute paths in committed manifests,
non-overlapping `PreToolUse` matchers, an explicit timeout on every hook — plus the
tool-surface checks that would have caught this whole wave, and the fork-identity and
savings-claim assertions above. `skills/.ignore` is documented rather than moved: Pi's
skill loader only reads it from the directory it scans, so `skills/` legitimately
contains a file among the directories, and the test now says so out loud
(CONTRIBUTING.md → *Plugin layout contract*).

## 36. Two tools that never arrived

> **Decisions recorded in** [ADR-0013 — Tracked bundles are the running code](adr/0013-tracked-bundles-are-the-running-code.md), [ADR-0014 — The standing context budget](adr/0014-standing-context-budget.md) and [ADR-0022 — Honest savings accounting](adr/0022-honest-savings-accounting.md).

`package.json` and the eleven manifests `scripts/version-sync.mjs` syncs,
`src/util/delivery-health.ts`, `src/cli.ts`, `src/server.ts`,
`src/tools/{find,graph,search,batch,fetch}.ts`, `src/session/analytics.ts`,
`hooks/posttooluse.mjs`, `hooks/codex/posttooluse.mjs`,
`hooks/core/{routing,formatters}.mjs`, `BENCHMARK.md`,
`tests/latency-benchmark.ts`, `README.md`,
`.github/workflows/update-stats.yml` (deleted), `stats.json` (deleted),
plus the suites named below

Change 34 built `ctx_find` and `ctx_graph`. Change 35 told the host they existed —
manifests, allowlists, skill descriptions, hook registrations. Neither reached a
session. Measured in a live Claude Code conversation: the server offered twelve
tools, and those two were not among them.

The host does not run this repository. It runs an unpacked copy under
`~/.claude/plugins/cache/context-mode/context-mode/<version>/`, and **the cache key
is the version number**. `d028f02` and `c50eb66` both changed the tool surface with
`version` frozen at 1.0.169, so the cache was never invalidated. The marketplace
clone was correct. The committed bundle was correct — `ctx_find` appears eight times
in `server.bundle.mjs` here and zero times in the bundle the host was executing,
which was built on 2026-08-18 at 02:23 and stayed. Same class as 33 and 35 —
nothing throws, the host simply goes on serving what it already has — one layer
below both: those fixed manifests and allowlists, this fixes delivery.

`npm version patch` (1.0.169 → 1.0.170, `0e01cb8`) fixed the instance. The rest of
this entry is about the instance not recurring, and about being able to say whether
any of it is working.

### The number stops depending on memory

`scripts/version-sync.mjs` already distributed a version across eleven manifests and
already worked. It was simply never called by the two waves that needed it. Three
guards now stand where the discipline used to:

- `tests/scripts/version-freshness.test.ts` fails when `server.bundle.mjs`,
  `cli.bundle.mjs`, `hooks/` or the registered tool list changed since the last tag
  while `package.json:version` did not. The baseline is the version as it stood *at*
  that tag, not the tag's name, so a repository whose tags lag its manifests still
  gets a truthful answer. No tags, or no git at all, is a skip rather than a
  failure: a guard that fails when it cannot see is a guard people delete.
- `version-sync.mjs --check` verifies the eleven manifests without writing and exits
  non-zero on drift. Writer and checker walk one field list, so the check cannot
  assert on a field the sync does not write.
- `tests/plugins/plugin-structure.test.ts` compares the committed bundle against the
  registered tools **in both directions**. The check it replaces scanned
  `src/server.ts` only — and the two tools that went missing register from
  `src/tools/`, precisely out of its view.

### The doctor could not see the one failure that mattered

Every other check in `ctx_doctor` answers for the tree the doctor was loaded from,
which is exactly where this failure hides. `src/util/delivery-health.ts` adds a
Delivery section that answers about the running process instead: which `start.mjs`
the host is executing (from this process's own `argv[1]` and from the process table
via `pgrep`/`ps`/PowerShell, degrading to "not observed" in silence where no such
tool exists), what version that directory carries, when its bundle was built, and
the live tool list — `REGISTERED_CTX_TOOLS`, the only fully authoritative answer to
"what does this session have" — against the expected one, named tool by tool,
because "12 of 14" tells nobody which call to stop making. On the machine where the
failure was found it reads:

```
running: …/cache/context-mode/context-mode/1.0.169/start.mjs (v1.0.169, unpacked cache)
build:   2026-08-18 02:23 — bundle registers 12 ctx_* tool(s)
tools:   MISSING from this session: ctx_find, ctx_graph — the running build was made 2026-08-18 02:23 for v1.0.169
```

Missing tools are a critical fail; no retry makes them appear. Several servers on
one script collapse into one finding rather than four identical lines, and version
directories that are symlinks — heal scripts leave those behind, seven of them here
— are reported as aliases instead of counted as builds.

`ctx_upgrade` gained the other half: it sweeps the unpacked cache instead of only
pulling and building, and prints what it removed. Two kinds of directory are spared.
The tree just installed into, because deleting it would undo the upgrade it is part
of. And any tree a live MCP server is running from, because that server resolves
dynamic imports against its own directory and would start failing mid-call — sparing
it costs nothing, since the bumped version is itself a new cache key and the host
unpacks a fresh directory regardless. The path refuses to resolve when `HOME` is
unset rather than falling back (`resolve("", ".claude")` collapses to the working
directory, and this path is a deletion target), every target is checked for
containment inside the plugin's own cache, and a symlinked version name is unlinked
rather than followed.

### The description is the last surface before the choice

`CLAUDE.md` and the SessionStart routing block are read long before a tool is
picked, and every turn pushes them further away. The tool description is read
immediately before it — and the model is not choosing a tool in isolation, it is
comparing `ctx_find` against `Grep`. If that comparison is not written down it gets
made from priors, and the priors were trained on `Grep`.

So every routing target now names the native tool it displaces, and carries a WHEN
NOT (which ADR-0002 leaves optional) with honest exclusions:

> Instead of Grep or Glob, when the question is "where does X live" and the answer
> is one path rather than a page of matches to read through.
>
> WHEN NOT: the point is an exhaustive literal sweep, every occurrence counted —
> Grep is the right tool for that; this returns a ranked list, not a complete one.
>
> WHEN NOT: the file is already known and the next step is editing it — Read first,
> because Edit matches against the exact bytes in your conversation.

`tests/core/tool-description-displacement.test.ts` enforces both halves: a routing
target that competes with a native tool has to name it, and it has to say where it
does not apply.

### The routing block survives compaction, and now that is measured

`hooks/hooks.json` registers SessionStart with an empty matcher, and for SessionStart
the matcher is matched against the lifecycle `source`, so empty means all four —
`startup`, `resume`, `clear`, `compact`. That was the whole argument, and it was half
of one: the hook *body* reads `input.source` and branches on it, and a branch that
returned early would drop the block just as effectively as a matcher that never
fired. `tests/hooks/sessionstart-survives-compaction.test.ts` runs the real hook on
all four sources and compares the emitted block byte for byte. It is identical.
(Each run gets its own fake `HOME`/`CLAUDE_CONFIG_DIR`: a true `startup` deliberately
wipes prior data, so pointing the suite at a developer's config dir would make it
destructive.)

The neighbouring failure was real rather than hypothetical. An agent's `tools:`
frontmatter is an allowlist, not a preference, so a subagent handed the routing block
without the tools it names is instructed to do something it cannot do — and the only
path left open is the one the instruction forbids. `context-gather`, the one agent
here written to survey a tree without reading it, listed Bash/Read/Glob/Grep and not
`ctx_find` until `c50eb66`. `tests/plugins/agent-tool-allowlist.test.ts` derives the
rule instead of enumerating it: per agent, which flooding tools did you keep, and did
you keep their replacements. A new agent is covered the moment it is added.

### The price, next to the thing that cost it

Between "called Read on 42 KB" and "learned that it cost 42 KB" there was no link at
all. `ctx_stats` knows the number, but nothing calls it; the missed-redirect
telemetry writes it to a database the model does not read. The price was measured in
a place the decision could not see.

PostToolUse now appends one line to the tool result the model is already looking at:

```
context-mode: this Bash call put 42.0 KB into your context window; ctx_batch_execute(commands, queries)
indexes the output and returns only the sections that answer your questions.
7 such calls so far this session, 310.4 KB in total.
```

One line per unrouted heavy call, nothing at all on a routed one — a notice that
fires on correct calls too is noise, and noise is what gets tuned out. The tally
sentence appears from the second call onward, since on the first it would only
restate the first sentence. Deliberately **without** a "would have returned ~X KB"
estimate: nothing in the hook can know what the replacement would have printed, and
a number invented at that distance would spend the credibility of the one measured
figure in the line. The alternative is named as a call with its signature rather
than as a tool name, because the signature is the part that makes the next call
cheap. `CONTEXT_MODE_COST_NOTICE=0` turns it off. The classification moved into
`hooks/core/routing.mjs` so the Codex hook records the same population against the
same floor — two hosts, one definition of "this went straight into the context
window".

### Enforcement where the loss is proven before the call

Advice competed with habit and lost. The only rules with full adherence were the
ones that deny and hand back a ready replacement, so the wave moved two cases from
advice to refusal — the two where the loss is knowable *before* the call runs.

**A whole-file `Read` at or above `CONTEXT_MODE_READ_DENY_BYTES` (50 000).** The
refusal carries `ctx_execute_file` on the actual path, not a tool name. It is the
same 50 000 the large-read byte accounting has always used, and
`readAccountingBytes()` now derives from `readDenyBytes()` rather than repeating the
literal: with the threshold lowered to 10 000 the old code refused at 10 KB while
accounting still began at 50 KB, so every file between them was refused and never
counted — the plugin reported saving nothing on exactly the reads the operator had
asked it to be strictest about. A read the caller already bounded with
`offset`/`limit` is a slice, not a file, and passes unchanged.

**The escape hatch is stated in the refusal itself**, because intent is not visible
in the call: a 60 KB file being read to edit and one being read to summarise are the
same request. `Edit` matches against the exact bytes in the conversation and a
summary is not those bytes, so read-before-edit has to keep working. The refusal
names three ways out — bound the read, repeat the same path within
`CONTEXT_MODE_READ_EDIT_WINDOW_MS` (120 000), or set the threshold to `0` — and a
refusal the model cannot read its way past is one it gets stuck behind, which costs
more than the bytes.

**And the accounting had to honour the hatch, which is where it first went wrong.**
The retry is an ordinary allowed `Read`, so PostToolUse saw a heavy native call with
no marker and recorded a fresh violation: the tally grew, the cost line fired, the
adherence denominator gained one, and the ladder climbed a step. Taking the way out
the plugin had just offered made the next refusal harsher — a loop that feeds
itself, aimed squarely at the one case the hatch exists for. The retry now carries a
`read-edit-exempt` marker with `bytesAvoided: 0`: already accounted for, and
claiming no saving, because the bytes really did arrive. Below the collection floor
no marker is needed — nothing under it was ever counted as a violation. The marker
type is one exported constant rather than two string literals, since a typo on
either side would silently restore the loop.

**A known-heavy Bash command** is denied with `ctx_batch_execute`. Four entries by
default (`npm test`, `docker logs`, `git log -p`, `find /`), configurable through
`CONTEXT_MODE_BASH_DENY_COMMANDS`; an entry that will not compile as a regex falls
back to a case-insensitive substring test, and an empty value turns the list off.
The refusal names the entry it matched, so the way to watch that one command
directly is to drop it from the list rather than to fight the hook.

**`Grep` and `Glob` only ask, and only when unbounded** — no path, no glob, no
`head_limit`, and asking for matching lines rather than file names, all four
together, because each condition alone is ordinary. They stayed at `ask` on the
strength of our own measurement, printed two subsections down: `ctx_find` returns
2.6 KB against `rg -l`'s 0.7 KB and ranks rather than enumerates. Denying an
exhaustive literal sweep would trade a cheap complete answer for an expensive
partial one, which is removing a capability rather than routing it. Escalation
raises the price of a call; it does not invent a capability the replacement lacks.

### Escalation instead of a one-shot nudge

The advisory fired once per session per rule. The first `Read` of a session got it
and the two-hundredth got silence — in exactly the long sessions where the plugin
matters most, and after a compaction the model no longer had even the first one.
Firing it every time was not the fix either: a notice on every call is noise, and
noise is what gets tuned out.

So the price of a violation grows instead of resetting. Four steps —
`0` silent, `1` advise, `2` ask, `3` deny — and **the first one is silence**: a
session that routes its heavy work never hears from the plugin at all. Past the
threshold the advisory returns carrying the number of bytes already lost, then it
becomes a confirmation, then a refusal. Capped there; there is no step past
refusing.

The steps are multiples of `CONTEXT_MODE_NUDGE_AFTER_CALLS` (3) and
`CONTEXT_MODE_NUDGE_AFTER_BYTES` (102 400), whichever is further along: three
unrouted heavy calls or 100 KB buys the advisory back, six or 200 KB turns it into a
confirmation, nine or 300 KB into a refusal. The tone change explains itself in the
message, naming both knobs and their current values, because a rule that hardens
without saying why reads as a malfunction.

It moves the same lever D2 built — the same refusal, the same escape hatch, the same
`ctx_execute_file` handed back — rather than opening a second ladder beside it. Two
mechanisms that both refuse a `Read` would have to agree about the retry window, and
they would eventually not.

**No new telemetry.** PreToolUse runs in front of every tool call on a budget
measured in milliseconds; opening SQLite there to count events would tax the whole
session to inform the few calls that need it. PostToolUse has the database open and
has just counted, so it writes the two numbers to one small file and PreToolUse
reads that — the same rows, the same count, one hop. When the file cannot be read
the reader returns `null` rather than zeroes, and `null` means the pre-existing
behaviour: "nothing has leaked" and "cannot tell" must not collapse into the same
silence.

### Whether the routing happens at all is a number now

Every change above tries to make the model route more work through the plugin, and
until now none of them could be checked: `ctx_stats` could say what routing *saved*
and what it *missed*, never what share of the heavy work it was given. That is the
position retrieval was in before 28 made quality a number.

`ctx_stats` now reports `routed heavy calls / all heavy calls` for the conversation:

```
Routing adherence: 3% — 9 of 276 heavy calls went through context-mode.
  Heavy means one call moving 2.0 KB or more (CONTEXT_MODE_ADHERENCE_MIN_BYTES).
  Through the plugin: 138 KB · straight into context: 1.3 MB.
```

Four decisions keep it honest, and each of them costs the number some flattery:

- **The threshold is named in the line.** A share of "heavy calls" cannot be read
  without it.
- **It cannot go below the collection floor.** The PostToolUse hook only records an
  unrouted call above `CONTEXT_MODE_MISSED_REDIRECT_MIN_BYTES`, so measuring under
  that line would drop unrouted calls out of the denominator while routed ones
  stayed in — a ratio that flatters by construction. A lower setting is clamped up,
  and the report says it was.
- **Nothing crossed the line is `no data`, not `0%`.** A quiet session and a session
  that leaked everything must not print the same number.
- **Calls of unknown size get their own line** ("not classified: N, M of them
  routed") rather than being spread over the denominator.

The numerator is assembled from what is actually attributable: `redirect` events,
which the hook writes per call against the calling session with the payload in
`bytes_avoided`, and the `ctx_*` calls in `tool_calls`. The `sandbox` events look
like the better source and are not — they are written against `getLatestSessionId()`
rather than the calling session, so they land under whichever session was newest in
the database (measured: a session with nine `ctx_*` calls in `tool_calls` had zero
sandbox rows of its own), and they carry only the bytes returned, not the payload
handled. `tool_calls` has no per-call size either, so heaviness there is decided by
the session's own per-tool average and every call sized that way is counted and
named as an estimate. The average is of bytes *returned*, which is smaller than what
the sandbox handled, so the bias is downward: the metric undercounts routed heavy
calls rather than inventing them. Making it a measurement means changing
`emitSandboxExecuteEvent` to record the calling session and the payload; until then
the report says which of its numbers are averages.

Meta commands (`ctx_doctor`, `ctx_stats`, `ctx_upgrade`, `ctx_purge`, `ctx_insight`)
are excluded from the numerator, or a session could raise its adherence by running
diagnostics.

### What routing costs in time

Everything measured in `BENCHMARK.md` before this wave was bytes saved. Part 4 adds
what those bytes cost in time, on the grounds that a routed call which answers slower
is paid for twice — and the model has every incentive to go back to `Grep` the
moment the detour feels expensive. The harness (`tests/latency-benchmark.ts`) drives
the committed `server.bundle.mjs` over stdio JSON-RPC, the way a host does, and
measures `rg` including process spawn, because the host pays that too.

The uncomfortable rows are the point of the section:

- **`ctx_find` does not win on bytes.** 2.6 KB against `rg -l`'s 0.7 KB — roughly
  four times *more* context, because it returns ranked snippets and graph relations
  rather than a path list. And it is ranked, not exhaustive. Its case rests entirely
  on replacing a *sequence* (`rg -l`, then two or three `Read`s at 30 KB each); where
  that sequence does not happen it is both slower and larger than the tool it
  replaces.
- **Cold start is the real cost.** 0.62 s for `ctx_find`, 1.39 s for `ctx_search`
  with a 1.78 s p90 — and cold `ctx_search` is the least stable row in the set,
  having reached a 4.1 s p90 on an earlier build. It is paid exactly when the model
  is deciding, for the rest of the session, whether the routed tool is worth using.
- **Warm, the detour is invisible**: 188 ms (`ctx_search`), 152 ms (`ctx_find`) and
  25–26 ms (both file-reading tools) of absolute penalty. The multiples look alarming
  (8×, 20×, ~125–130×) only because the native baselines are 0.2–26 ms.
- **The routed call is slower in every pair, in every regime.** There is no
  configuration in which routing is free.

Which locates the problem. `ctx_execute_file` costs 26 ms warm and returns 529 B
where `Read` returns 34.0 KB — a 98.5% reduction for a delay nobody can feel. So
latency is emphatically *not* why a model reaches for `Read` instead; what it avoids
is having to compose a program. That is an ergonomics problem, not a speed one, and
it is a different fix from anything in this wave.

Three caveats are stated in the section rather than buried: the OS page cache cannot
be dropped without root, so the native side has no true cold regime; the machine
carried a background load of 3.6–5.4 throughout, so sub-10 ms rows should be read as
"single-digit milliseconds"; and the routed rows move 20–40% run to run, which is
worth knowing before quoting any single number.

### The CI job that was measuring someone else's package

`.github/workflows/update-stats.yml` ran here every six hours (`0 */6 * * *`) with
`contents: write`. It fetched total npm downloads for `context-mode` — the package
upstream publishes — added this repository's own clone count to them, committed the
sum to this repository as `ci: update install stats`, and then purged
`purge.jsdelivr.net/gh/mksglu/…`, someone else's CDN path. The README's `users`,
`npm` and `marketplace` badges read that file from
`cdn.jsdelivr.net/gh/**mksglu**/context-mode@main/stats.json`, so they displayed
upstream's numbers live while the `stats.json` the workflow faithfully committed here
was read by nothing at all — verified across the tree: the pages under `web/` fetch
upstream's copy by URL, and the only other `stats.json` in the repository belongs to
a smoke test's temp directory.

The workflow and the file are deleted rather than merely unscheduled: everything the
job did was upstream-scoped, and a disabled-but-present workflow is an invitation to
re-enable it. The three dynamic badges are gone with it — there was nothing left to
point them at — and `stars`, `forks` and `last-commit` now read `OSDDQD/context-mode`,
which is the repository this README describes. Same class as the manifest ownership
fixed in 35, in CI and README this time.

`bundle.yml` remains the one workflow that commits to this repository, and stays:
it rebuilds the bundles when `src/**` changes, which is a defence against the exact
failure this entry opens with.

## 37. Seventeen hosts become two

> **Decisions recorded in** [ADR-0023 — Two supported hosts](adr/0023-two-supported-hosts.md) and [ADR-0012 — Fork identity and the upgrade source](adr/0012-fork-identity-and-upgrade-source.md).

`src/adapters/**`, `configs/**`, `.cursor-plugin/`, `.openclaw-plugin/`, `.pi/`,
`openclaw.plugin.json`, `scripts/version-sync.mjs`, `package.json`,
`scripts/postinstall.mjs`, `scripts/ctx-debug.sh`,
`.github/workflows/tier2-e2e-smoke.yml`, `README.md`,
`docs/platform-support.md`, `.claude/skills/context-mode-ops/*`,
`src/server.ts`, `.github/FUNDING.yml` (deleted), `web/**`

`15a02cf` removes fifteen client platforms — Gemini CLI, VS Code Copilot,
JetBrains Copilot, GitHub Copilot CLI, Cursor, OpenCode, KiloCode, OpenClaw,
Kimi Code, Qwen Code, Antigravity (IDE and `agy`), Kiro, Zed, Pi and OMP —
leaving Claude Code and Codex. 207 files, 36,541 deleted lines, and not one
line added: restoring any host is a revert of that commit and nothing else, and
a conflict with upstream resolves by "our deletion wins" rather than line by
line. The tree does not compile at that commit, deliberately; the couplings are
untangled in the one that follows.

**The reason is the multiplier, not the code.** Every change to routing had to
be reasoned about seventeen times — seventeen hook wire formats, seventeen
config locations, seventeen session-id conventions — and verified on two, since
those are the two hosts anyone here actually runs. The other fifteen were
maintained from documentation and upstream source reading, which is exactly the
regime where a change looks right and is not. This wave measured what that
costs: D0 lost two full waves to a version number that eleven manifests had to
agree on, and eight of those eleven belonged to hosts nobody could test.

**What the reduction bought, concretely.** `version-sync.mjs` went from eleven
manifests to three (`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`,
`.codex-plugin/plugin.json`) plus `package.json` itself — every removed entry was
a place the number could be forgotten, and forgetting it is what made `ctx_find`
and `ctx_graph` invisible for two waves. `package.json` lost its `pi`, `openclaw`
and `omp` blocks, the `install:openclaw` script, two `files[]` entries, five
keywords, and a `main`/`exports` pair that pointed at `build/adapters/opencode/`
and `build/adapters/openclaw/` — build outputs whose sources no longer exist.
`ctx-debug.sh` lost its fourteen-host detection ladder, its config-file probes
and its session-directory sweep, all of which were reporting on paths this fork
can no longer write. The tier-2 smoke workflow lost its Pi job — the only
implemented one, whose driver script went with the host — and keeps the Claude
Code placeholder plus the host-independent assertion half
(`scripts/tier2-smoke/assert-stats.mjs`, covered by
`tests/tier2-smoke-assert.test.ts`).

**The documentation stops describing hosts that are gone.** The README's install
section was sixteen `<details>` blocks; it is two, plus the build-prerequisites
note. Its hook matrix and capability matrix went from eighteen columns to three,
the per-platform prose from fifteen paragraphs to two, and the routing table
from fifteen rows to two. `docs/platform-support.md` went from 955 lines to 280
— fourteen platform sections and twenty-seven matrix rows removed — and now says
plainly that one paradigm is left: both remaining hosts speak JSON over stdin
and stdout, which is the paradigm the hooks were written against. The ops skill's
"respect all 17 adapters equally" rule now names the two it means.

**What is deliberately still there.** `tests/scripts/version-sync.test.ts` keeps
every assertion it derives from `TARGETS`, and gained a floor
(`TARGETS.length >= 3`) because a list that shrank to nothing would have made the
whole suite pass by having nothing left to check. The two named cases for the
`agy` and Copilot CLI bundles are gone with the bundles — what they asserted, the
derived assertions still assert for every manifest that exists. And the removed
hosts stay in this document's earlier entries: they were true when written, and
a history rewritten to match the present tells you nothing about how it got here.

**The package stops pointing at somebody else's repository.** `package.json`
still carried upstream's `repository`, `homepage` and `bugs`, so a fork user who
followed `npm bugs` filed against a tree that does not contain the code they are
running; `.codex-plugin/plugin.json` carried upstream's author, homepage and
repository as well, and `.github/FUNDING.yml` pointed the fork's Sponsor button
at upstream's account. All of it now resolves to `OSDDQD/context-mode`, except
the funding file, which is removed rather than retargeted — this fork asks for
nothing, and a Sponsor button that renders an error is worse than none. Upstream
keeps its credit where credit is the point: `contributors` in `package.json`, the
"Fork of mksglu/context-mode" line in both plugin descriptions, `docs/UPSTREAM-CREDITS.md`,
and every issue link that cites the report a fix came from. The same retarget
applies to the issue templates, the `npx skills add` and `git clone` lines in
`README.md` and `CONTRIBUTING.md`, and the `/plugin marketplace add` command,
which was still installing upstream's plugin from a fork's own README. Same class
as entries 33 and 35, and as the CI job above: an address inherited from a parent
is not a neutral default, it is a wrong answer that nothing checks.

Three counts were wrong in the same file set. The manifests advertised eleven
sandbox languages against the twelve in `src/runtime.ts`; the README's host list
in `package.json:description` still named Gemini CLI, VS Code Copilot and
OpenCode; and the ops skill's data-verification table sourced three of its ten
rows from `stats.json`, deleted with the workflow that wrote it. The table now
says so in place of those rows, because a data-verification table that names a
missing file is an invitation to invent the number it promised to verify.

**The contributor-facing documentation catches up.** `CONTRIBUTING.md` described
a `src/adapters/` tree with seven directories that no longer exist, a test matrix
naming seven hook suites that were deleted, and a whole section on installing and
testing the OpenClaw adapter through `npm run install:openclaw` — a script the
previous step removed from `package.json`, pointing at `docs/adapters/openclaw.md`,
a file in a directory that is gone. The pull-request template asked which of
fifteen platforms a change affects. Both now describe the two that exist. The
README's "Used across teams at" logo wall and its Hacker News badge are removed:
neither claim is this fork's to make, and the marketing skill in this same tree
forbids exactly that ("if you cannot verify a number, do not use it").
`docs/adr/0006` keeps its accepted text and gains a dated amendment instead —
its host-gating argument cited VS Code and JetBrains, and an ADR whose evidence
is edited under it stops being a record.

**The multi-adapter tests narrowed instead of thinning.** `enumerateAdapterDirs`
was asserted against a hardcoded list of seventeen names and five hand-picked
session-dir paths; it is now cross-checked against `getSessionDirSegments` in
both directions, for every adapter, which covers strictly more than the sample
did and needs no editing when a host is added — the duplicated segment map in
`analytics.ts` is deliberate, and a deliberate copy is only safe while something
proves the two agree. The renderer tests kept their subject and lost their
ceiling: with two adapters the "Skipped" line can no longer join seven names, so
the comma join is now proven in the one shape that remains reachable, a machine
where both hosts hold nothing but fixtures. `auto-memory-adapter` lost the
GEMINI.md case, which proved instruction-file lookup was table-driven rather than
an AGENTS.md special case; the surviving half of that property — a second adapter
choosing a second file name — is pinned with `ClaudeCodeAdapter` against an
`AGENTS.md` planted in the same directory, so the assertion still fails if the
adapter is ignored.

**And the update path itself was pointed at upstream.** Found while retargeting the
addresses above: `ctx_upgrade`'s inline fallback in `src/server.ts` cloned
`mksglu/context-mode` with the URL written out as a literal. That branch is not an
edge case — its own comment says "neither CLI file exists (e.g. marketplace
installs)", which is how this plugin is installed. Running `ctx_upgrade` on a fork
install therefore overwrote the fork with upstream: every local commit gone, nothing
printed to say so, and the same command run again would report success.

What makes it the same class as the rest of the day: **the defence already existed
and was simply not connected here.** `src/util/fork-info.ts` was written for exactly
this — its own docstring says an unconditional upstream clone "is not an upgrade —
it is a silent downgrade that deletes every local addition and leaves no trace of
having done so" — and `resolveUpgradeRepo()` walks operator override → the `fork`
marker in `package.json` → the git origin of the installed tree → upstream only as a
last resort. The CLI path used it. The inline path, the one a marketplace install
actually takes, kept its literal. A mechanism that exists, is correct, and is wired
to the branch that does not matter is entry 33 and entry 35 again, one layer further
down: `resolveUpgradeRepo({ pluginRoot }).url` now feeds the clone, and the `fork`
block in `package.json` resolves it to `OSDDQD/context-mode` on the first step.

## 38. The plugin stops charging for obedience

`hooks/core/routing.mjs`, `hooks/pretooluse.mjs`, `hooks/posttooluse.mjs`,
`hooks/codex/pretooluse.mjs`, `hooks/codex/posttooluse.mjs`,
`src/session/analytics.ts`, `docs/adr/0008-escalation-economics.md`

A live session refused a `Read` of a **2.4 KB** file. The standard refusal
threshold is 50 KB. The refusal text was about a kilobyte, the model took the
escape hatch and read the file anyway, and the session had been pinned to the
top step of the ladder for hours: *"93 unrouted heavy calls, 619.9 KB"*.

Seven defects, one theme. **The price of an intervention was never compared
with the price of the bytes it defended against**, and the counter that set the
price was being filled by behaviour the plugin itself calls correct.

**The DENY step was refusing at the telemetry floor.** 2000 bytes decides what
is worth *recording*; it was also deciding what was worth *refusing*. Refusing a
2.4 KB file spends ~1 KB of reason text and a round trip, and then the file
arrives anyway. Enforcement gets its own floor —
`max(16384, CONTEXT_MODE_ESCALATION_DENY_MIN_BYTES)`, an 8–16× margin over the
refusal's own price — and the env var can only raise it.

The step below had no size test at all, so a session at `ask` was asked to
confirm a 500-byte read. It gets the same arithmetic at half the number (8 KB,
derived from the refusal floor so the two cannot end up in the wrong order): a
prompt is cheaper than a refusal, but its text still enters the conversation and
the common answer is yes, which buys nothing. Below 8 KB the ladder keeps only
its advisory.

**The ladder could only climb.** Nine unrouted calls bought a refusal on every
subsequent `Read` ≥ 2 KB for the rest of the session, however carefully it
behaved afterwards — and long sessions are the ones this plugin exists for. The
level is now read from a sliding window
(`CONTEXT_MODE_ESCALATION_WINDOW_MS`, 15 min). Fifteen quiet minutes return a
session to silence on its own. Session totals are still counted and still
quoted: the notice says what the session has spent, the ladder prices what it is
doing now.

**The tally was full of sanctioned calls.** A bounded `Read` — the one the
refusal text promises in writing "goes through unchanged" — moved the ladder. So
did `git diff`, which the routing block tells the agent to run in Bash. So did
calls the user had explicitly confirmed at an `ask` prompt. And so did every
read made by a **subagent**: `pretooluse.mjs` knew about subagents,
`posttooluse.mjs` did not, so an `Explore` agent pulling 500 KB escalated the
main loop — for bytes that never entered the main window at all, since a
subagent's context is discarded and only its report comes back. That is the most
likely source of the 93 calls.

Bounded reads and subagent calls are now not events. The rest are recorded as
`sanctioned_heavy` — same data line, visible in `ctx_stats`, excluded from both
the ladder (which filters on event **type**) and the adherence denominator
(which filters on **category**). ADR-0008 records that those two exclusions have
to move together.

The subagent test is `agent_id`, never `agent_type`. Claude Code's schema:
*"agent_type … Present when the hook fires from within a subagent (alongside
agent_id), **or on the main thread of a session started with `--agent`**"*. The
old `agent_id ?? agent_type` disjunct therefore reported "subagent" for every
call in an `--agent` session and silently disabled enforcement there.

**`ctx_stats` was reporting savings for bytes that arrived.** The advisory
branch — which ALLOWS the read — stamped `bytesAvoided: st.size` on its
decision. Reachable on any fallthrough, and unavoidable with
`CONTEXT_MODE_READ_DENY_BYTES=0`: the operator turns enforcement off, and every
large read is then booked as a win. `bytesAvoided > 0` now survives on real
refusals and nowhere else.

**One marker cell per session, and Claude Code runs tool calls concurrently.**
PreToolUse B routinely overwrote A's marker before A's PostToolUse read it.
Markers are keyed per call now — `tool_use_id` where the host supplies one, a
fingerprint of the call's name and canonicalised arguments where it does not.
Refusals get a path-keyed marker instead, because a denied call has no
PostToolUse of its own: a later one sweeps it once no matching call can still be
in flight, and PreToolUse **deletes** it when it lets the read-before-edit retry
through — at that moment the bytes are entering the conversation and the saving
is not real.

**The fine print was reprinted on every refusal.** Full refusal text and full
escalation note now fire once per session each; after that, one line carrying
only what the caller has to act on. ADR-0003's CASE A rubric holds for the short
form and its contract test still passes.

## Merged ahead of upstream: the fetch extraction ladder

`src/fetch/blocks.ts`, `src/fetch/extract.ts`, `src/fetch/page-store.ts`, `src/server.ts`

Not a fork change — upstream's `next` branch, merged here before it reached
`upstream/main`, because it fixes a failure this fork hits daily: fetching
documentation that is client-rendered.

- **A JavaScript shell is no longer a successful fetch.** excalidraw.com turned
  6,862 B of HTML into 21 B of markdown — the page `<title>` — and that was
  indexed as though it were the document. `classifyExtraction()` now answers
  "did this produce an article?" with one definition shared by parent and
  subprocess.
- **The article is extracted, not the whole page transliterated.** Chrome is
  what repeats across pages of the same host; content is what does not. A block
  is labelled `template` only when the identical block was already seen on a
  *different* page of that host — no per-page threshold, which upstream's
  measurements show cannot work (28.3% link-only lines on Stripe vs 0.3% on
  Resend). Nothing is dropped: the full document is stored verbatim in
  `fetch-pages.db`, only content blocks reach FTS.
- **Rung 2 recovers SPA pages browser-free**: the page's `.md` sibling, then the
  host's `llms.txt` — fired only when the cheaper rungs produced no article, so
  the happy path is still one request. Upstream measured 36 doc pages: 4 had no
  article in the HTTP response, 4 of 4 recovered without a browser, 0 needed one.

Verified end-to-end against the bundle this fork ships:

| Page | Result |
|---|---|
| `resend.com/docs/api-reference/emails/send-email` | rung 1 — site served markdown to the `Accept` header, 12,410 B, 6 sections |
| `developer.apple.com/documentation/swiftui/view` | rung 2a — rung 1 returned a JS shell, the `.md` sibling carried the article, 5,593 B, 11 sections |

The Apple page is the one that used to produce 36 bytes and call it success.

Every fork feature on this code path was re-checked after the merge: the
Artifact-URL passthrough, the proxy opt-in (which is where the single merge
conflict landed), compact descriptions, `ctx_gather`, hybrid search, host
memory and the code index.

## New environment variables

| Variable | Default | Effect |
|---|---|---|
| `CONTEXT_MODE_SAFE_COMMANDS` | — | Extra bounded-command regexes, `\|\|\|`-separated |
| `CONTEXT_MODE_SAFE_COMMANDS_FILE` | `<config>/context-mode/safe-commands.txt` | Same, one per line |
| `CONTEXT_MODE_MISSED_REDIRECT_MIN_BYTES` | `2000` | Threshold for recording an unrouted payload |
| `CONTEXT_MODE_TOOL_DESCRIPTIONS` | auto | `full` restores the verbose descriptions everywhere; `compact` pins compact even for schema-deferring hosts; unset/`auto` registers compact and upgrades to full for Claude Code ≥2.1 |
| `CONTEXT_MODE_TOOLSEARCH_HINT` | on | `0` drops the deferred-tool ToolSearch bootstrap from the SessionStart block |
| `CONTEXT_MODE_SUBAGENT_CAPTURE` | on | `0` disables SubagentStop transcript capture and its drain |
| `CONTEXT_MODE_SESSION_END_DRAIN` | on | `0` stops SessionEnd from spawning the detached `context-mode drain` |
| `CONTEXT_MODE_CODE_INDEX` | on | `0` disables indexing of edited files |
| `CONTEXT_MODE_CODE_INDEX_BOOTSTRAP` | on | `0` skips the one-time `git ls-files` seed |
| `CONTEXT_MODE_CODE_INDEX_BOOTSTRAP_BATCH` | `15` | Files seeded per store open |
| `CONTEXT_MODE_EMBEDDINGS_URL` | autodetected | Embeddings endpoint; set it to skip the loopback probe |
| `CONTEXT_MODE_EMBEDDINGS_MODEL` | `bge-m3` | Embedding model name |
| `CONTEXT_MODE_EMBEDDINGS_API_KEY` | — | Bearer token for the endpoint |
| `CONTEXT_MODE_EMBEDDINGS_TIMEOUT_MS` | `5000` | Query embedding timeout (on the answer path) |
| `CONTEXT_MODE_EMBEDDINGS_BACKFILL_TIMEOUT_MS` | `120000` | Background backfill batch timeout |
| `CONTEXT_MODE_EMBEDDINGS_BACKFILL` | `16` | Chunks embedded per background pass |
| `CONTEXT_MODE_EMBEDDINGS_QUANT` | `i8` | `f32` stores unquantised vectors |
| `CONTEXT_MODE_EMBEDDINGS_AUTODETECT` | on | `0` never probes localhost for a runtime |
| `CONTEXT_MODE_EMBEDDINGS` | on | `0` disables the semantic layer entirely |
| `CONTEXT_MODE_UPGRADE_REPO` | fork marker → git origin → upstream | Repository `ctx upgrade` pulls from |
| `CONTEXT_MODE_UPGRADE_TIMEOUT_MS` | `180000` | Budget for the upgrade's `git clone` |
| `CONTEXT_MODE_ALLOW_PROXY` | off | `1` lets the fetch subprocess use the ambient proxy |
| `CONTEXT_MODE_FETCH_PASSTHROUGH` | claude.ai artifacts | Extra hosts/regexes the WebFetch redirect must skip |
| `CONTEXT_MODE_INDEX_HOST_MEMORY` | on | `0` stops indexing the host's memory files into FTS5 |
| `CONTEXT_MODE_SEARCH_DEDUP` | on | `0` restores repeated sections in multi-query responses |
| `CONTEXT_MODE_CONTENT_RETENTION_DAYS` | `14` | Retention window for per-project content stores |
| `CONTEXT_MODE_CONTENT_WAL_REAP` | on | `0` drops the live-WAL guard in the retention sweep |
| `CONTEXT_MODE_SEMANTIC_HINT` | on | `0` silences the in-response semantic-coverage line |
| `CONTEXT_MODE_DRAIN_BACKFILL` | on | `0` stops `drain` from bulk-embedding |
| `CONTEXT_MODE_DRAIN_BACKFILL_MS` | `60000` | Wall clock for the drain's backfill pass |
| `CONTEXT_MODE_DRAIN_BACKFILL_MAX` | `2000` | Chunk cap for the drain's backfill pass |
| `CONTEXT_MODE_CONTENT_BUDGET_MB` | `512` | Disk budget for all content stores; `0` disables eviction |
| `CONTEXT_MODE_CONTENT_BUDGET_DRY_RUN` | off | `1` reports evictions without deleting |
| `CONTEXT_MODE_VACUUM_MAX_BYTES` | `268435456` | Largest store `compact()` will VACUUM |
| `CONTEXT_MODE_CODE_INDEX_PROJECT_SCOPE` | on | `0` restores the machine-wide, first-come queue drain |
| `CONTEXT_MODE_STATS_FILE_RETENTION_DAYS` | `14` | Age at which `stats-*.json` files are rolled up |
| `CONTEXT_MODE_STATS_COST` | on | `0` drops the dollar section of `ctx_stats` |
| `CONTEXT_MODE_STATS_TEAM_EXTRAPOLATION` | off | `1` adds the 10-developer projection |
| `CONTEXT_MODE_EXEC_IDLE_TIMEOUT_MS` | `0` (off) | Silence budget for a foreground run; every byte of output resets it |
| `CONTEXT_MODE_EXEC_WALL_TIMEOUT_MS` | `0` (off) | Absolute cap on a foreground run, for callers who want one |
| `CONTEXT_MODE_EXEC_KILL_GRACE_MS` | `2000` | SIGTERM → SIGKILL delay, so a killed process can flush and unlock |
| `CONTEXT_MODE_EXEC_MAX_OUTPUT_BYTES` | `33554432` (32 MB) | Hard output cap per run; was 100 MB |
| `CONTEXT_MODE_EXEC_ENV_MODE` | denylist | `allowlist` passes only named variables to the subprocess |
| `CONTEXT_MODE_INDEX_HASH_SKIP` | on | `0` re-indexes a source even when its bytes are unchanged |
| `CONTEXT_MODE_INDEX_HASH_SKIP_REATTRIBUTE` | off | `1` rewrites a skipped source so its chunks carry the current session id |
| `CONTEXT_MODE_CODE_CHUNKING` | on | `0` chunks source files as markdown again, byte for byte — see `docs/research/code-chunking-2026-08-18.md` |
| `CONTEXT_MODE_SEARCH_COMPLETENESS` | on | `0` drops the per-query "showing N of M" line |
| `CONTEXT_MODE_SEARCH_ESCALATION` | on | `0` drops the per-response escalation block |
| `CONTEXT_MODE_SEARCH_EXACT_TOTALS` | off | `1` re-fuses at a wider fetch for an exact total instead of `N+`, capped at 500 |
| `CONTEXT_MODE_INDEX_REDACT` | on | `0` disables credential screening of indexed text |
| `CONTEXT_MODE_INDEX_ENTROPY_REDACT` | off | `1` adds the entropy heuristic to that screening |
| `CONTEXT_MODE_FFF` | on | `0` removes the in-process fff layer entirely |
| `CONTEXT_MODE_FFF_WATCH` | on | `0` keeps fff search without its filesystem watcher |
| `CONTEXT_MODE_FFF_MMAP` | on | `off` sets `disableMmapCache` — trades first-grep latency for memory on large monorepos |
| `CONTEXT_MODE_FFF_MAX_INSTANCES` | `2` | Live native indexes before LRU eviction destroys the oldest |
| `CONTEXT_MODE_FFF_DIR` | `<config>/context-mode/fff` | Where the frecency and history stores live |
| `CONTEXT_MODE_FFF_LOG_SWEEP` | on | `0` keeps the orphaned `fff_mcp+<ts>+<pid>.log` files |
| `CONTEXT_MODE_FFF_LOG_MAX_AGE_DAYS` | `7` | Age gate for that sweep |
| `CONTEXT_MODE_GRAPH` | on | `0` unregisters `ctx_graph` |
| `CONTEXT_MODE_GRAPH_DAEMON` | on | `0` stops the plugin supervising `codegraph serve` |
| `CONTEXT_MODE_GRAPH_EXPLORE_PASSTHROUGH` | on | `0` always indexes `explore` output instead of returning it whole |
| `CONTEXT_MODE_GRAPH_EXPLORE_BUDGET` | `24000` | Inline byte budget for `explore` |
| `CONTEXT_MODE_GRAPH_CLI_FALLBACK` | on | `0` refuses to degrade to `codegraph <cmd> -j` on schema drift |
| `CONTEXT_MODE_GRAPH_SCHEMA_MAX` | `8` | Raises the pinned schema ceiling |
| `CONTEXT_MODE_GRAPH_FRESHNESS` | on | `0` drops the "index lags N files" sweep |
| `CONTEXT_MODE_GRAPH_SYNC` | on | `0` disables the fallback sync queue; `_DEBOUNCE_MS` retunes it (1500) |
| `CONTEXT_MODE_FS_BUS` | on | `0` installs an inert handle — no watcher, no consumers |
| `CONTEXT_MODE_FS_BUS_INDEX` / `_GRAPH` / `_CACHE` | on | Per-consumer switches: FTS5 invalidation, sync queue, path caches |
| `CONTEXT_MODE_FS_BUS_MAX_FILES` | `40` | Files per event batch |
| `CONTEXT_MODE_FIND` | on | `0` unregisters `ctx_find` |
| `CONTEXT_MODE_FIND_FILENAME` / `_CONTENT` / `_LEXICAL` / `_SEMANTIC` / `_GRAPH` | on | Per-signal switches for the fusion |
| `CONTEXT_MODE_FIND_GRAPH_WEIGHT` | `0.5` | Weight of the adjacency list, clamped to 0–1 |
| `CONTEXT_MODE_FIND_TRACK` | on | `0` stops feeding selections back into fff's ranking |
| `CONTEXT_MODE_TOKENIZER` | `heuristic` | `bytes4` restores the pre-fork numbers; `exact` uses a BPE encoder if one is installed |
| `CONTEXT_MODE_TOKENIZER_ENCODING` | auto | Pins `o200k_base` or `cl100k_base` instead of detecting from the client |
| `CONTEXT_MODE_TOKENIZER_BYTES_PER_TOKEN` | measured | Override for operators who measured their own payload mix |
| `CONTEXT_MODE_REUSE_DETECT` | on | `0` disables returns detection, the deduction and the bypass |
| `CONTEXT_MODE_REUSE_THRESHOLD` | `30` | Return rate above which the gateway hands back full text |
| `CONTEXT_MODE_REUSE_STEP_WINDOW` / `_WINDOW_MS` / `_MIN_SAMPLES` | `20` / `900000` / `3` | Pairing windows and the minimum sample before the bypass may fire |
| `CONTEXT_MODE_TRUNCATE_FOOTER` | on | `0` silences the "showing X of Y, dropped D" footer |
| `CONTEXT_MODE_EXEC_COMPRESS` | off | `1` enables output folding process-wide; `0` is a kill switch over per-call opt-in |
| `CONTEXT_MODE_COMPRESS_TESTS` / `_ENV` / `_REPEATS` | on | Individual folding samples within that layer |
| `CONTEXT_MODE_DOCTOR_LAYERS` | on | `0` drops the search-layers section from doctor and inventory |
| `CONTEXT_MODE_ADHERENCE_MIN_BYTES` | collection floor (`2000`) | Heaviness line for the routing-adherence metric; clamped up to `CONTEXT_MODE_MISSED_REDIRECT_MIN_BYTES` |
| `CONTEXT_MODE_COST_NOTICE` | on | `0` drops the per-call line naming what an unrouted payload cost |
| `CONTEXT_MODE_READ_DENY_BYTES` | `50000` | Size at or above which a whole-file `Read` is refused with `ctx_execute_file` on the same path; `0` leaves only the advisory |
| `CONTEXT_MODE_READ_EDIT_WINDOW_MS` | `120000` | How long the refused path may be read anyway — the read-before-edit escape hatch |
| `CONTEXT_MODE_BASH_DENY_COMMANDS` | `npm test,docker logs,git log -p,find /(\s\|$)` | Comma-separated regexes refused with a ready `ctx_batch_execute`; empty turns the list off |
| `CONTEXT_MODE_GREP_ASK` | on | `0` stops unbounded `Grep`/`Glob` asking for confirmation |
| `CONTEXT_MODE_NUDGE_AFTER_CALLS` | `3` | Unrouted heavy calls per step of the escalation ladder (silent → advise → ask → deny) |
| `CONTEXT_MODE_ESCALATION_WINDOW_MS` | `900000` | How far back the ladder looks; a window with no heavy call returns the session to silence |
| `CONTEXT_MODE_ESCALATION_DENY_MIN_BYTES` | `16384` | Size below which the ladder's DENY step refuses nothing. Can only be raised — a refusal costs ~1 KB of reason text and usually ends with the file being read anyway |
| `CONTEXT_MODE_NUDGE_AFTER_BYTES` | `102400` | The same ladder in leaked bytes; whichever threshold is further along sets the step |

The redaction switches are read by `src/session/redact.ts` and applied by
`ContentStore` on every path that writes to the index — `index`,
`indexPlainText`, `indexJSON` — ahead of the content hash, so flipping one
re-indexes affected sources instead of leaving the cached hash describing bytes
that are no longer what would be stored. Both are resolved when the store is
constructed, so a change takes effect on the next store, not mid-process. The
entropy layer is off for a reason worth repeating outside the source:
it is a heuristic, not a guarantee. On real code it fires on base64-inlined
assets and minified bundles, and a credential with no recognisable marker passes
both layers regardless. It reduces accidental capture; it is not a control to
rely on when handling credentials.

## Tests

`npm test` — 5,645 passing and 38 skipped across 268 suites. New suites:

- `tests/cli/fork-info.test.ts` — upgrade-source resolution, fork identity
- `tests/core/store-delete-source.test.ts` — source eviction
- `tests/hooks/deny-reason-contract.test.ts` — ADR-0003 redirect ≠ restriction

- `tests/core/host-memory.test.ts` — host memory path resolution, scoping, indexing

- `tests/core/fetch-passthrough.test.ts` — artifact-URL passthrough, hook/server parity
- `tests/core/batch-hybrid-scope.test.ts` — hybrid on `global` scope, lexical on `batch`

- `tests/core/read-only.test.ts` — read-only classification
- `tests/core/code-index.test.ts` — queue draining, overflow, failure isolation
- `tests/session/subagent-capture.test.ts` — transcript resolution, digest extraction, drain lifecycle
- `tests/hooks/toolsearch-bootstrap.test.ts` — deferred-tool bootstrap block, ADR-0003 vocabulary
- `tests/hooks/lifecycle-hooks-registration.test.ts` — SubagentStop/SessionEnd wiring end to end
- `tests/core/hybrid-search.test.ts` — embedding config, codec, RRF fusion, degradation
- `tests/core/compact-descriptions.test.ts` — compact default + `full` escape hatch
- `tests/hooks/user-safe-commands.test.ts` — user allowlist, malformed patterns, operator gate
- `tests/analytics/missed-redirect.test.ts` — the unrouted-payload block
- `tests/core/search-dedup.test.ts` — suppression rule, further-match window, opt-out
- `tests/core/semantic-visibility.test.ts` — the three coverage states, hint latch
- `tests/core/content-budget.test.ts` — usage accounting, eviction guards, compaction
- `tests/session/stats-scope-containment.test.ts` — ADR-0005 scope labels and nesting
- `tests/executor/idle-timeout.test.ts` — the silence watchdog, its arming rules, `killedBy`
- `tests/executor/env-allowlist.test.ts` — `CONTEXT_MODE_EXEC_ENV_MODE=allowlist`
- `tests/store-hash-skip.test.ts` — the unchanged-content skip and the re-attribution switch
- `tests/search/completeness.test.ts` — the completeness line, the escalation block, both switches
- `tests/core/tool-registration.test.ts` — fourteen tools, their names and order; the acceptance gate for the `server.ts` split
- `tests/session/redact.test.ts` — credential screening, and the real-corpus false-positive guards
- `tests/store-redaction-wiring.test.ts` — no credential reaches the database, on every index path
- `tests/store-code-chunking.test.ts` — declaration boundaries, packing, the byte-for-byte opt-out
- `tests/cli/inventory.test.ts` — label grouping, ordering, empty store, and that the command stays read-only
- `tests/core/search.test.ts` — also carries the retrieval gate: the 18 named cases plus the aggregate against `retrieval-baseline.json`
- `tests/scripts/bundle-manifest.test.ts` — every hook bundle is built, scanned and committed; the parser itself is pinned first
- `tests/hooks/attribution-bundle-parity.test.ts` — the shipped bundle against its source, including the Bug 8 case that the orphan lost
- `tests/plugins/plugin-structure.test.ts` — the plugin as the host sees it: layout, a `SKILL.md` per skill directory, command ↔ platform-skill parity, no absolute paths in committed manifests, non-overlapping `PreToolUse` matchers, a timeout on every hook, the tool surface (agent allowlist, skill description, README table), fork identity, and the savings claim against its measured basis
- `tests/scripts/version-freshness.test.ts` — the version must move when the bundles, the hooks or the tool list do
- `tests/scripts/version-sync.test.ts` — also covers `--check`: every manifest in `TARGETS` verified without writing (eleven when written, three since 15a02cf)
- `tests/util/delivery-health.test.ts` — which `start.mjs` is running, what its bundle registers, and a cache sweep that spares what is in use
- `tests/core/tool-description-displacement.test.ts` — every routing target names the native tool it displaces, and says where it does not apply
- `tests/hooks/sessionstart-survives-compaction.test.ts` — the real hook on all four lifecycle sources, block compared byte for byte
- `tests/plugins/agent-tool-allowlist.test.ts` — no agent keeps a flooding tool without its routed replacement
- `tests/hooks/missed-redirect-notice.test.ts` — the cost line: when it fires, what it names, and what it refuses to estimate
- `tests/analytics/routing-adherence.test.ts` — the adherence metric, its floor, and the cases where it must answer "no data" instead of a number

## Installing this fork in Claude Code

```
/plugin marketplace add OSDDQD/context-mode
/plugin install context-mode@context-mode
```

Then restart Claude Code (or `/reload-plugins`).
