# Fork changes — OSDDQD/context-mode

Fork of [mksglu/context-mode](https://github.com/mksglu/context-mode) at v1.0.169.

Twenty-two changes, each addressing a gap observed while running the plugin daily in
Claude Code. Every one is backwards compatible, and every behavioural default
carries an env switch back. Two defaults differ from upstream on purpose: the
compact tool descriptions (what ships on every request) and the semantic layer,
which now adopts a local embedding runtime if one is already running instead of
waiting to be configured.

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

## 9. The host's own memory becomes searchable

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

## Tests

`npm test` — 4910 passing, 38 skipped (4853 of them this fork's, the rest
upstream's three new fetch suites). New suites:

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

## Installing this fork in Claude Code

```
/plugin marketplace add OSDDQD/context-mode
/plugin install context-mode@context-mode
```

Then restart Claude Code (or `/reload-plugins`).
