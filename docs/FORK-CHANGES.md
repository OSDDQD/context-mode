# Fork changes — OSDDQD/context-mode

Fork of [mksglu/context-mode](https://github.com/mksglu/context-mode) at v1.0.169.

Twelve changes, each addressing a gap observed while running the plugin daily in
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
| `CONTEXT_MODE_TOOL_DESCRIPTIONS` | compact | `full` restores the verbose descriptions |
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
| `CONTEXT_MODE_ALLOW_PROXY` | off | `1` lets the fetch subprocess use the ambient proxy |
| `CONTEXT_MODE_FETCH_PASSTHROUGH` | claude.ai artifacts | Extra hosts/regexes the WebFetch redirect must skip |
| `CONTEXT_MODE_INDEX_HOST_MEMORY` | on | `0` stops indexing the host's memory files into FTS5 |

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
