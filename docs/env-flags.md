# `CONTEXT_MODE_*` environment flags

Every environment switch the plugin reads, what it defaults to, which layer owns
it, and whether you have any business setting it.

**This file is generated-checkable, not hand-maintained by hope.**
`tests/env-flags-doc.test.ts` scans `src/` and `hooks/` for names read as
environment keys and fails when one is missing here (or documented here and gone
from the source). If that test fails, add the row — do not delete the test.

## How to read the table

- **Default** is what the code falls back to when the variable is unset, empty,
  or unparseable. Where a value is clamped, the clamp is stated.
- Boolean flags follow one of two fork conventions:
  - **off-switch** — anything except `0` (and, in the layers that use the
    shared `isOff` helper, `off` / `false` / `no` / `disabled`) leaves the
    feature on. These are written `on`.
  - **opt-in** — only the exact value shown turns the feature on. Written
    `off`.
- Some families are **collapsed**: one head name takes a JSON object
  (`CONTEXT_MODE_FS_BUS={"index":false}`) covering the whole family, and every
  individual variable still works and **overrides** the JSON key it overlaps.
  Malformed JSON is ignored, never fatal — the scalars and defaults apply. Where
  a head name also has a scalar meaning of its own, the first non-space
  character decides: `{` is an object, anything else is the old scalar. See
  "Flag families" below and `src/util/env-family.ts`.
- **⚠ do not touch** marks flags that exist for tests, for CI, or for digging
  out of an emergency. Setting them in normal use degrades the plugin or
  disables a safety property.

---

## Layer: store & indexing (17)

The FTS5 content store, its retention, and what gets redacted on the way in.

| Flag | Default | When you would touch it |
|---|---|---|
| `CONTEXT_MODE_DIR` | adapter default (`~/.claude/context-mode`, `~/.codex/context-mode`) | Move all plugin storage. Must be absolute; empty is ignored. The one flag most operators ever set. |
| `CONTEXT_MODE_DATA_DIR` | unset | Same idea one level up — overrides the adapter's data root before `CONTEXT_MODE_DIR` splits it into `sessions/` and `content/`. `~` is expanded here. Prefer `CONTEXT_MODE_DIR`. |
| `CONTEXT_MODE_CONTENT_RETENTION_DAYS` | `14` | Indexed content older than this is reaped. Raise on a long-running investigation you want to keep searchable; `0` disables reaping and lets the store grow. |
| `CONTEXT_MODE_CONTENT_WAL_REAP` | on | `0` keeps SQLite WAL/SHM siblings when a store directory is reaped. Diagnosing a corrupted store. ⚠ do not touch in normal use. |
| `CONTEXT_MODE_CONTENT_BUDGET_MB` | `512` | Disk ceiling for `content/` before least-recently-used stores are evicted. `0` disables the budget. |
| `CONTEXT_MODE_CONTENT_BUDGET_DRY_RUN` | off (`1` enables) | Report what the budget would evict without evicting it. Verification only. |
| `CONTEXT_MODE_VACUUM_MAX_BYTES` | `268435456` (256 MB) | Databases above this are never `VACUUM`ed — the pause would be longer than the win. Raise only with a measurement. |
| `CONTEXT_MODE_STALE_REFRESH_MS` | `3000` | How often a search may re-stat its sources for changed files. Raise on a network filesystem where `stat` is expensive. |
| `CONTEXT_MODE_INDEX_HASH_SKIP` | on | `0` re-indexes a file whose content hash is unchanged. Roughly doubles index cost. ⚠ do not touch in normal use. |
| `CONTEXT_MODE_INDEX_HASH_SKIP_REATTRIBUTE` | off (`1` enables) | Forces a re-index of unchanged content so attribution metadata is rewritten. One-shot repair after an attribution bug. ⚠ do not leave set. |
| `CONTEXT_MODE_CODE_CHUNKING` | on | `0` falls back to fixed-window chunking for source files instead of AST-ish boundaries. Bisecting a bad chunking result. |
| `CONTEXT_MODE_GRAPH_CHUNKING` | on | `0` stops cutting code chunks on codegraph symbol boundaries and falls back to the plain code chunker. Set when the graph index is stale enough that its symbol ranges are wrong. |
| `CONTEXT_MODE_INDEX_REDACT` | on | `0` disables pattern-based secret redaction before content enters the store. ⚠ never in normal use — this is the credential guard. |
| `CONTEXT_MODE_INDEX_ENTROPY_REDACT` | off (`1` enables) | Adds high-entropy-string redaction on top of the pattern matcher. Turn on when indexing content that carries opaque tokens the patterns miss; costs false positives. |
| `CONTEXT_MODE_INDEX_HOST_MEMORY` | on | `0` stops indexing the host's own memory/CLAUDE.md files at startup. Set when that content is noise in your search results. |
| `CONTEXT_MODE_SEARCH_EXACT_TOTALS` | off (`1` enables) | Re-runs a saturated query wide to report an exact match total instead of a lower bound. Costs a second search per saturated query. Benchmarking only. |
| `CONTEXT_MODE_STATS_FILE_RETENTION_DAYS` | `14` | Age at which per-session stats files are rolled up into the aggregate. `0` disables the roll-up. |

## Layer: retrieval — `ctx_find` (11)

The fused locator. One switch per signal, so a misbehaving source can be cut
without a rebuild.

| Flag | Default | When you would touch it |
|---|---|---|
| `CONTEXT_MODE_FIND` | on | `0` removes `ctx_find` from the tool surface entirely. Use when the host already has a locator you prefer. |
| `CONTEXT_MODE_FIND_FILENAME` | on | `0` drops the filename-match arm from the fusion. Debugging why a result ranked where it did. |
| `CONTEXT_MODE_FIND_CONTENT` | on | `0` drops the native grep arm. |
| `CONTEXT_MODE_FIND_LEXICAL` | on | `0` drops the FTS5 arm. |
| `CONTEXT_MODE_FIND_SEMANTIC` | on | `0` drops the vector arm — the cheapest way to test whether embeddings are helping or hurting. |
| `CONTEXT_MODE_FIND_GRAPH` | on | `0` drops the codegraph arm. Set when no codegraph index exists and the probe cost annoys you. |
| `CONTEXT_MODE_FIND_GRAPH_WEIGHT` | `0.5` (clamped `[0, 1]`) | How much the structural prior counts in the fusion. Above 1 the graph would outvote the text actually searched for, so it is clamped rather than trusted. |
| `CONTEXT_MODE_FIND_GRAPH_DEPTH` | `1` (clamped `[1, 3]`) | Hops the graph walk takes from each seed. `2` on a codebase where the interesting file is always one indirection away. |
| `CONTEXT_MODE_FIND_GRAPH_SEEDS` | `3` (clamped `[1, 10]`) | File candidates used as graph seeds. |
| `CONTEXT_MODE_FIND_TRACK` | on | `0` stops recording which result a `ctx_find` call was followed by. That feedback is what frecency ranks on. |
| `CONTEXT_MODE_FIND_TRACK_TTL_MS` | `900000` (15 min) | How long a query marker waits for its follow-up before expiring. |

## Layer: retrieval — `ctx_search` (7)

| Flag | Default | When you would touch it |
|---|---|---|
| `CONTEXT_MODE_SEARCH_WINDOW_MS` | `60000` | Rolling window the progressive search throttle counts in, **per actor context** (concurrent subagents get their own budgets). |
| `CONTEXT_MODE_SEARCH_MAX_RESULTS_AFTER` | `3` | Calls in the window after which results taper to one per query. |
| `CONTEXT_MODE_SEARCH_BLOCK_AFTER` | `8` | Calls in the window after which `ctx_search` refuses and demands batching. Raise only if you have measured that the batching advice is wrong for your workload. |
| `CONTEXT_MODE_SEARCH_COMPLETENESS` | on | `0` drops the "there are more matches than you were shown" reporting. |
| `CONTEXT_MODE_SEARCH_ESCALATION` | on | `0` drops the follow-up block that suggests the next, wider query. |
| `CONTEXT_MODE_SEARCH_DEDUP` | on | `0` returns near-duplicate chunks instead of collapsing them. Diagnosing a dedup false positive. |
| `CONTEXT_MODE_SEMANTIC_HINT` | on | `0` suppresses the one-time startup line about vector coverage. |

## Layer: retrieval — `ctx_pack` (1)

| Flag | Default | When you would touch it |
|---|---|---|
| `CONTEXT_MODE_PACK` | on | `0` removes `ctx_pack` from the tool surface entirely. Same shape as `CONTEXT_MODE_FIND` and `CONTEXT_MODE_GRAPH`: set it when the host already has a context-budgeting step you prefer. |

## Layer: retrieval — embeddings / semantic (13)

Off unless both a URL and a model are configured. No embedding traffic leaves
the machine without these two being set.

| Flag | Default | When you would touch it |
|---|---|---|
| `CONTEXT_MODE_EMBEDDINGS` | on | `0` / `off` / `false` disables the semantic layer regardless of the rest. |
| `CONTEXT_MODE_EMBEDDINGS_URL` | unset | OpenAI-compatible embeddings endpoint. Required — no URL, no semantic layer. |
| `CONTEXT_MODE_EMBEDDINGS_MODEL` | unset | Model name for that endpoint. Also required. |
| `CONTEXT_MODE_EMBEDDINGS_API_KEY` | unset | Bearer token, if the endpoint wants one. Redacted from anything the plugin indexes or logs. |
| `CONTEXT_MODE_EMBEDDINGS_AUTODETECT` | on | `0` stops probing well-known local endpoints (Ollama, LM Studio) when no URL is set. Set it on a machine where the probe is a firewall event. |
| `CONTEXT_MODE_EMBEDDINGS_TIMEOUT_MS` | `10000` | Per-query embedding timeout. Sized against a measured 3 281 ms model load (Ollama + bge-m3) rather than the warm ~180 ms: that load happens on the first query after the runtime restarts, and a budget that does not clear it fails 100% of the time — silently, with the semantic arm just dropping out of the ranking. A timed-out query is retried once (the load continues server-side, so the retry lands warm); a retry that also times out is read as a stalled endpoint and disables the retry for five minutes. Costs nothing on a healthy endpoint, which answers far inside the budget. Lower it only if you would rather lose semantic ranking than wait. |
| `CONTEXT_MODE_EMBEDDINGS_BACKFILL` | `64` | Chunks embedded per backfill batch. 64 is the measured throughput knee (10.7 ms/vector vs 17.2 at 16); a failed oversized batch is retried once at 16. Lower it for an endpoint with a small per-request input cap. |
| `CONTEXT_MODE_EMBEDDINGS_BACKFILL_TIMEOUT_MS` | `120000` (2 min) | Wall clock for one backfill pass. |
| `CONTEXT_MODE_EMBEDDINGS_QUANT` | on (`f32` disables) | Vectors are stored quantized. Set `f32` to keep full precision at 4× the disk. |
| `CONTEXT_MODE_DRAIN_BACKFILL` | on | `0` stops the session-end pass that embeds whatever was indexed but never vectorized. |
| `CONTEXT_MODE_DRAIN_BACKFILL_MS` | `60000` | Deadline for that session-end pass. |
| `CONTEXT_MODE_DRAIN_BACKFILL_MAX` | `2000` | Chunk ceiling for that pass. |
| `CONTEXT_MODE_VECTOR_SCAN` | two-phase (`brute` / `exact` / `full` force a full scan) | Forces the exact full vector scan instead of the coarse-code shortlist. The escape hatch for "I think the shortlist is dropping something": it restores the pre-two-phase behaviour exactly, with no reindex and no restart beyond the process reading it. Costs the full scan on every semantic query. |

## Layer: retrieval — fff native search (11)

| Flag | Default | When you would touch it |
|---|---|---|
| `CONTEXT_MODE_FFF` | on | `0` switches off the whole native layer — no addon load, no watcher, no file/grep signals. First thing to try when the native addon misbehaves on an unusual platform. |
| `CONTEXT_MODE_FFF_MMAP` | on | `off` trades the mmap warmup (what makes the second query fast) back for RAM. Large monorepos on small machines. |
| `CONTEXT_MODE_FFF_WATCH` | on | `0` keeps search but drops the filesystem event source. Set on a filesystem where watching is expensive or broken (some network mounts, some containers). |
| `CONTEXT_MODE_FFF_WATCH_DEBOUNCE_MS` | `150` (clamped `0…10000`) | Debounce window for the shared fs event bus. Raise if a noisy build churns the tree. |
| `CONTEXT_MODE_FFF_MAX_INSTANCES` | `2` (clamped `1…16`) | Finder instances kept alive across projects. Raise when you work in many repos in one session. |
| `CONTEXT_MODE_FFF_SCAN_TIMEOUT_MS` | `5000` (clamped `0…120000`) | How long `acquireFinder` waits for the initial scan before returning without it. Raise on a very large first-scan tree. |
| `CONTEXT_MODE_FFF_DIR` | `<CONTEXT_MODE_DIR>/fff` | Absolute override for the fff index directory alone. |
| `CONTEXT_MODE_FFF_LOG_DIR` | `$XDG_CACHE_HOME` or the platform cache dir | Where the native layer's logs land. Must be absolute. |
| `CONTEXT_MODE_FFF_LOG_MAX_AGE_DAYS` | `7` | Age cutoff for the log sweep. `0` deletes on every sweep. |
| `CONTEXT_MODE_FFF_LOG_SWEEP` | on | `0` keeps every log file forever. Reproducing an intermittent native failure. |
| `CONTEXT_MODE_DEBUG` | off (any value enables) | Writes native-layer diagnostics to stderr. Debugging only — noisy. |

## Layer: codegraph (15)

Read-only consumption of an external `codegraph` index. Every one of these
degrades to "no graph signal", never to an error.

| Flag | Default | When you would touch it |
|---|---|---|
| `CONTEXT_MODE_GRAPH` | on | `0` removes `ctx_graph` from the tool surface. |
| `CONTEXT_MODE_CODEGRAPH_BIN` | resolved from `$HOME` | Absolute path to the `codegraph` binary when it is not where the plugin looks. Ignored if the path does not exist. |
| `CONTEXT_MODE_GRAPH_POOL_MAX` | `4` | Long-lived read-only `codegraph.db` connections held open at once (LRU; evicted entries are closed). The bound is about file descriptors, not memory — each entry holds the db, its `-wal` and its `-shm` open, so an unbounded pool in a session that wanders across repositories ends in `EMFILE`. Raise when you work across more than a handful of checkouts in one session; `0` disables pooling and opens a fresh connection per call, which is the first thing to try when debugging a stale-index complaint. |
| `CONTEXT_MODE_GRAPH_CLI_FALLBACK` | on | `0` restricts `ctx_graph` to direct SQLite reads and never shells out to the CLI. Set where spawning is not allowed. |
| `CONTEXT_MODE_GRAPH_CLI_TIMEOUT_MS` | `60000` | Wall clock for one CLI fallback invocation. |
| `CONTEXT_MODE_GRAPH_DAEMON` | on | `0` stops supervising the codegraph daemon. The index then only moves when you run `codegraph` yourself. |
| `CONTEXT_MODE_GRAPH_SYNC` | on | `0` disables the `codegraph sync` queue fed by filesystem events. |
| `CONTEXT_MODE_GRAPH_SYNC_DEBOUNCE_MS` | `1500` | How long the sync queue waits for the tree to settle. |
| `CONTEXT_MODE_GRAPH_FRESHNESS` | on | `0` stops checking whether the index is behind the working tree. You lose the "graph is stale" warning. |
| `CONTEXT_MODE_GRAPH_FRESHNESS_MAX` | `5000` | Files the freshness check will stat before giving up on an answer. |
| `CONTEXT_MODE_GRAPH_FRESHNESS_TTL_MS` | `10000` | How long a freshness verdict is cached. |
| `CONTEXT_MODE_GRAPH_SCHEMA_MAX` | `8` | Highest codegraph schema version this fork will read. Raise **only** after checking that the newer schema still means what the queries assume. ⚠ do not touch in normal use. |
| `CONTEXT_MODE_GRAPH_EXPLORE_BUDGET` | `24000` bytes | Inline budget for `ctx_graph explore` before the rest goes to the index instead of into context. |
| `CONTEXT_MODE_GRAPH_EXPLORE_PASSTHROUGH` | on | `0` sends all explore output to the index and none inline. |
| `CONTEXT_MODE_GRAPH_BODY_BUDGET` | `8000` bytes | Byte budget for one symbol's source in `ctx_graph action: "body"`. Raise when you routinely ask for large classes and would rather pay the bytes than follow up; the slice is cut on a line boundary and says how many lines it dropped. No upper clamp — the escape hatch is meant to work. |

## Layer: fs-bus (7)

One flag per consumer on purpose: an operator who finds the FTS5 re-index too
eager must be able to turn only that off and keep the codegraph queue.

**Collapsed family.** The four consumer knobs are also reachable as one object
on the head name: `CONTEXT_MODE_FS_BUS={"enabled":true,"index":true,"graph":true,
"cache":true,"maxFiles":40}`. The head name kept its original scalar meaning —
a value that does not start with `{` is read as the master off-switch, so
`CONTEXT_MODE_FS_BUS=0` still turns the whole wiring off (and with the master
off no consumer runs, which is "all off"). The individual variables below win
over the matching JSON key.

| Flag | Default | When you would touch it |
|---|---|---|
| `CONTEXT_MODE_FS_BUS` | on | Master switch **and** family head. `0` installs an inert handle — no subscription, no finder acquired. A `{…}` value configures the consumers instead (`"enabled":false` is the same as `0`). |
| `CONTEXT_MODE_FS_BUS_INDEX` | on | `0` keeps the bus, drops FTS5 invalidation of `code:` sources. JSON key `index`. |
| `CONTEXT_MODE_FS_BUS_GRAPH` | on | `0` keeps the bus, drops the codegraph sync queue. JSON key `graph`. |
| `CONTEXT_MODE_FS_BUS_CACHE` | on | `0` keeps the bus, stops invalidating registered per-path caches. JSON key `cache`. |
| `CONTEXT_MODE_FS_BUS_MAX_FILES` | `40` (clamped `1…5000`) | Files re-indexed per delivered batch. A mass refactor moves thousands in one window; the overflow is left to the store's mtime-gated refresh. Raise only if that catch-up is visibly too slow. JSON key `maxFiles`. |
| `CONTEXT_MODE_READ_CACHE` | on | `0` disables the re-read cache — repeated reads of an unchanged file go back to disk. |
| `CONTEXT_MODE_READ_CACHE_MAX` | `512` (clamped `16…50000`) | Paths the re-read cache remembers. |

## Layer: executor & output shaping (14)

The sandbox `ctx_execute` runs in, and what happens to its stdout on the way
back.

| Flag | Default | When you would touch it |
|---|---|---|
| `CONTEXT_MODE_EXEC_MAX_OUTPUT_BYTES` | `33554432` (32 MB) | Hard cap on buffered child output. Far above what a human reads, far below what threatens the host process. |
| `CONTEXT_MODE_EXEC_IDLE_TIMEOUT_MS` | `0` (off) | Kill a command that has produced no output for N ms. Opt-in — a silent compile is not a hung compile. |
| `CONTEXT_MODE_EXEC_WALL_TIMEOUT_MS` | `0` (off) | Absolute wall clock per command. Opt-in, for callers who know what it costs. |
| `CONTEXT_MODE_EXEC_KILL_GRACE_MS` | `2000` | SIGTERM-to-SIGKILL grace on Unix, so a killed build can flush output and drop lock files. Windows has no equivalent. |
| `CONTEXT_MODE_EXEC_ENV_MODE` | inherit (`allowlist` inverts) | `allowlist` passes only the variables a runtime needs and no credentials. Recommended where the sandbox runs model-written scripts; it breaks any command that reads a secret from the environment, which is why it is opt-in. See ADR-0006. |
| `CONTEXT_MODE_EXEC_COMPRESS` | off (`1` enables, `0` forces off) | Fold repetitive stdout through `src/compress` and append the honest footer. Deliberately not applied to `ctx_batch_execute`, whose output is indexed verbatim. |
| `CONTEXT_MODE_COMPRESS_TESTS` | on | `0` stops folding test-runner output. Only meaningful when compression is on at all. |
| `CONTEXT_MODE_COMPRESS_ENV` | on | `0` stops folding environment dumps. |
| `CONTEXT_MODE_COMPRESS_ENV_VALUES` | on | `0` keeps environment *values* in a folded dump. Values are where the secrets are. ⚠ do not touch in normal use. |
| `CONTEXT_MODE_COMPRESS_REPEATS` | on | `0` stops collapsing repeated identical lines. |
| `CONTEXT_MODE_TRUNCATE_FOOTER` | on | `0` truncates without saying so. The footer is what makes a truncated result honest. ⚠ do not touch in normal use. |
| `CONTEXT_MODE_TRUNCATE_COUNTERS` | off (`1` enables) | Adds shown/total byte counters to the truncation marker. More informative, different string — off by default so snapshot assertions stay stable. |
| `CONTEXT_MODE_ALLOW_PROXY` | off (`1` enables) | Lets `ctx_fetch_and_index` honour `HTTPS_PROXY`/`HTTP_PROXY`. Off by default because a proxy is an exfiltration path the plugin did not choose. |
| `CONTEXT_MODE_FETCH_PASSTHROUGH` | built-in list only | Extra URLs only the host's native fetch can read. Entries separated by `\|\|\|`; each is a host suffix, or a regex over the whole URL when it starts with `^`. Malformed regexes are skipped. |

## Layer: hooks & routing (22)

The PreToolUse/SessionStart enforcement layer. These change what the model is
allowed to do, so they are the flags most worth understanding before setting.
The ones already documented in the README's *Routing-guidance* table are
repeated here for completeness.

| Flag | Default | When you would touch it |
|---|---|---|
| `CONTEXT_MODE_ROUTING_BLOCK` | `compact` (`full` restores prose) | `full` injects the authored routing block instead of the compact table. Diagnosing a routing rule the model appears not to have understood; costs context every session. |
| `CONTEXT_MODE_READ_DENY_BYTES` | `50000` | Size at or above which reading a whole file is refused and `ctx_execute_file` handed back. `0` disables the refusal and leaves the advisory. |
| `CONTEXT_MODE_READ_EDIT_WINDOW_MS` | `120000` (2 min) | How long after a refusal the same path may be read anyway — the read-before-edit escape hatch. |
| `CONTEXT_MODE_BASH_DENY_COMMANDS` | `npm test,docker logs,git log -p,find /(\s\|$)` | Comma-separated regexes for Bash commands whose output floods context. An entry that is not valid regex falls back to a case-insensitive substring test. Empty turns the list off. |
| `CONTEXT_MODE_BASH_NUDGE_MIN_COMMAND_BYTES` | `0` (off, bounded `[0, 100000]`) | When `N > 0`, an unbounded Bash command shorter than N bytes skips the generic nudge. Gates only the generic nudge — `curl`/`wget` and inline HTTP redirects fire earlier and are never relaxed. |
| `CONTEXT_MODE_GREP_ASK` | on | `0` stops `Grep`/`Glob` asking for confirmation. Only unbounded searches ask, and it is `ask`, never `deny`. |
| `CONTEXT_MODE_NUDGE_AFTER_CALLS` | `3` | Unrouted heavy calls per step of the escalation ladder: three buys the advisory, six a confirmation, nine a refusal. |
| `CONTEXT_MODE_NUDGE_AFTER_BYTES` | `102400` (100 KB) | The same ladder measured in leaked bytes. Whichever threshold is further along sets the step. |
| `CONTEXT_MODE_ESCALATION_WINDOW_MS` | `900000` (15 min) | How far back the ladder counts. A window with no heavy call returns the session to silence. |
| `CONTEXT_MODE_ESCALATION_DENY_MIN_BYTES` | `16384` (16 KB), floor — can only be raised | Size below which the ladder's DENY step refuses nothing. The `ask` step derives half this number, so the two steps cannot end up in the wrong order. |
| `CONTEXT_MODE_MISSED_REDIRECT_MIN_BYTES` | `2000` | Payload size at or above which an unrouted call is *recorded* as one. The collection floor everything else measures against. |
| `CONTEXT_MODE_COST_NOTICE` | on | `0` drops the line appended to an unrouted heavy result naming what it cost. Routed calls never carry it. |
| `CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY` | `10` (range `[1, 100]`) | Cadence at which the "wrap large external-MCP payloads" guidance is re-injected. `1` is every call (~250 tokens each). |
| `CONTEXT_MODE_SAFE_COMMANDS` | unset | Extra commands the routing layer treats as safe. Entries separated by `\|\|\|`. |
| `CONTEXT_MODE_SAFE_COMMANDS_FILE` | `<config-dir>/context-mode/safe-commands.txt` | File of the same, one per line. The maintainable form of the flag above. |
| `CONTEXT_MODE_SECURITY_BUNDLE_PATH` | bundled `security.bundle.mjs` | Absolute path to an alternative security bundle. Development of the security layer itself. ⚠ do not touch in normal use. |
| `CONTEXT_MODE_REQUIRE_SECURITY` | off (`1` enables) | Deny every routed call if the security bundle failed to load, instead of warning and continuing. Recommended for CI and shared machines: it converts a silent loss of deny patterns into a loud one. |
| `CONTEXT_MODE_SUPPRESS_SECURITY_WARNING` | off (any value enables) | Silences the stderr warning that deny patterns are NOT enforced. ⚠ do not set — this hides the exact failure `CONTEXT_MODE_REQUIRE_SECURITY` exists to catch. |
| `CONTEXT_MODE_HOOK_STDIN_IDLE_MS` | `1500` | How long a hook waits for stdin before giving up. Raise only if hooks time out on a very slow host. |
| `CONTEXT_MODE_MCP_SENTINEL_DIR` | `/tmp` (`os.tmpdir()` on Windows) | Where the MCP-ready sentinel files live. Set when `/tmp` is not writable or not shared with the server process. |
| `CONTEXT_MODE_TOOLSEARCH_HINT` | on (claude-code only) | `0` drops the ToolSearch bootstrap line from the SessionStart block. |
| `CONTEXT_MODE_SESSION_END_DRAIN` | on | `0` skips the SessionEnd drain (code-index queue, subagent queue, vector backfill). Work then waits for the next session. |

## Layer: session & analytics (22)

Session capture, the reuse detector, and what `ctx_stats` reports.

**Collapsed family.** The six `CONTEXT_MODE_REUSE_*` variables are also reachable
as one object: `CONTEXT_MODE_REUSE={"enabled":true,"threshold":0.3,
"stepWindow":20,"windowMs":900000,"minSamples":3,"statFiles":true}`. Each scalar
below still works and wins over the JSON key it overlaps.

| Flag | Default | When you would touch it |
|---|---|---|
| `CONTEXT_MODE_CODE_INDEX` | on | `0` disables draining the code-index queue at session end. |
| `CONTEXT_MODE_CODE_INDEX_BOOTSTRAP` | on | `0` skips the startup pass that seeds the code index. First-run cost on a very large repo. |
| `CONTEXT_MODE_CODE_INDEX_BOOTSTRAP_BATCH` | `15` | Files per bootstrap batch. Raise to seed faster at the cost of a longer startup pause. |
| `CONTEXT_MODE_CODE_INDEX_PROJECT_SCOPE` | on | `0` lets the code index cross the project boundary. ⚠ do not touch in normal use — the scope is a containment property, not a tuning knob. |
| `CONTEXT_MODE_SUBAGENT_CAPTURE` | on | `0` stops capturing subagent transcripts into the session store. |
| `CONTEXT_MODE_SESSION_SUFFIX` | derived from the worktree | Forces the session-DB suffix. Tests, and pinning two worktrees to one session DB on purpose. |
| `CONTEXT_MODE_REUSE` | unset | Family head for the six flags below, as a JSON object (`{"threshold":0.45,"statFiles":false}`). A non-`{` value is read as an off-switch for the whole detector, same as `CONTEXT_MODE_REUSE_DETECT=0`. Malformed JSON is ignored and the scalars apply. |
| `CONTEXT_MODE_REUSE_DETECT` | on | `0` disables the reuse detector entirely. JSON key `enabled`. |
| `CONTEXT_MODE_REUSE_THRESHOLD` | `0.30` | Fraction of repeated work above which a reuse signal fires. Percentage (`30`) or fraction (`0.3`). JSON key `threshold`. |
| `CONTEXT_MODE_REUSE_STEP_WINDOW` | `20` | Steps of history the detector looks back over. JSON key `stepWindow`. |
| `CONTEXT_MODE_REUSE_WINDOW_MS` | `900000` (15 min) | Time window bounding that history. JSON key `windowMs`. |
| `CONTEXT_MODE_REUSE_MIN_SAMPLES` | `3` | Minimum observations before the detector will claim anything. JSON key `minSamples`. |
| `CONTEXT_MODE_REUSE_STAT_FILES` | on | `0` stops the detector stat-ing candidate files to confirm a repeat. Cheaper, noisier. JSON key `statFiles`. |
| `CONTEXT_MODE_READ_WASTE` | on | `0` turns the read-waste metric off: no extra event types selected, no text scanned, no waste line in `ctx_stats`. Separate from `CONTEXT_MODE_REUSE_DETECT` on purpose — the reuse detector *changes* the savings numbers, this one only reports. |
| `CONTEXT_MODE_ADHERENCE_MIN_BYTES` | `2000`, clamped up to `CONTEXT_MODE_MISSED_REDIRECT_MIN_BYTES` | Heaviness line for the routing-adherence ratio. Measuring below the collection floor would flatter the ratio exactly where it should complain. |
| `CONTEXT_MODE_STATS_COST` | on | `0` drops the dollar figures from `ctx_stats`. |
| `CONTEXT_MODE_STATS_TEAM_EXTRAPOLATION` | off (`1` enables) | Adds the "extrapolated to 10 developers" line. Off by default because it is a projection, not a measurement. |
| `CONTEXT_MODE_TOKENIZER` | `heuristic` (`exact`, `bytes4`) | `exact` uses a real BPE tokenizer — accurate, slower. `bytes4` is the crude fallback. Set `exact` when you are auditing the savings numbers. |
| `CONTEXT_MODE_TOKENIZER_ENCODING` | derived from the model | `o200k_base` or `cl100k_base`. Only meaningful with `CONTEXT_MODE_TOKENIZER=exact`. |
| `CONTEXT_MODE_TOKENIZER_BYTES_PER_TOKEN` | `4` (accepted range `0.5 < n < 32`) | Divisor for the heuristic tokenizer. Tune against a measured corpus, or leave alone. |
| `CONTEXT_MODE_LOCALE` | detected | BCP-47 locale for number and date rendering in `ctx_stats`. Unusable values are ignored. |
| `CONTEXT_MODE_TZ` | detected | IANA timezone for the same. |

## Layer: delivery & platform (9)

| Flag | Default | When you would touch it |
|---|---|---|
| `CONTEXT_MODE_PLATFORM` | detected | Force `claude-code` or `codex`. Any other value is rejected. Useful when detection is wrong in a container. |
| `CONTEXT_MODE_PROJECT_DIR` | `process.cwd()` | Project root the server and graph daemon assume. Set when the server is started from somewhere other than the project. |
| `CONTEXT_MODE_UPGRADE_REPO` | derived from the plugin root | Git URL `ctx upgrade` pulls from. Pointing a fork at itself. |
| `CONTEXT_MODE_UPGRADE_TIMEOUT_MS` | `180000` (3 min) | Clone/fetch timeout for `ctx upgrade`. |
| `CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS` | off (`1` enables) | Tells the server it is embedded in another process, so it does not install its own `unhandledRejection` handlers. For embedders only. ⚠ do not set by hand. |
| `CONTEXT_MODE_TOOL_DESCRIPTIONS` | `compact` (`full` restores) | `full` sends the authored tool descriptions instead of the compact ones. Costs context on every request; useful when a model is misusing a tool and you suspect the compact description. |
| `CONTEXT_MODE_DOCTOR_LAYERS` | on | `0` drops the per-layer health section from `ctx doctor`. |
| `CONTEXT_MODE_BRIDGE_DEPTH` | `30000` | Queue depth for the stdio bridge. `0` or negative disables the bridge's depth limit path. |
| `CONTEXT_MODE_BRIDGE_IDLE_MS` | `0` (off) | Idle timeout for the bridge. Only consulted when a depth is set. |

---

## Flag families

Eleven places where a single concept was spread across three to eight variables.
Two have been collapsed; the other nine are still a shortlist, not a changelog.

The migration shape, which works for all of them: keep the existing scalar names
working, add a JSON form on the family's head name, and let a scalar override a
key set in the JSON. That way nobody's shell profile breaks. The shared reader
is `src/util/env-family.ts`; malformed JSON degrades to the scalars rather than
throwing, because an env var must not be able to take the server down.

### Collapsed

| Family | Head name | Documented under |
|---|---|---|
| **Reuse detector** — six variables | `CONTEXT_MODE_REUSE` (JSON only; a bare off-value disables the family) | Layer: session & analytics |
| **fs-bus consumers** — four variables | `CONTEXT_MODE_FS_BUS` (JSON **or** the master off-switch it already was) | Layer: fs-bus |

### Candidates

| Family | Flags | Collapsed form |
|---|---|---|
| **`ctx_find` signals** | `CONTEXT_MODE_FIND_FILENAME`, `_CONTENT`, `_LEXICAL`, `_SEMANTIC`, `_GRAPH` — five, all read through one `SIGNAL_ENV` record | `CONTEXT_MODE_FIND_SIGNALS={"filename":true,"content":true,"lexical":true,"semantic":true,"graph":true}` |
| **`ctx_find` graph tuning** | `CONTEXT_MODE_FIND_GRAPH_WEIGHT`, `_DEPTH`, `_SEEDS` — three | `CONTEXT_MODE_FIND_GRAPH={"enabled":true,"weight":0.5,"depth":1,"seeds":3}` — folds the signal switch in as `enabled` |
| **Embeddings** | `CONTEXT_MODE_EMBEDDINGS` + `_URL`, `_MODEL`, `_API_KEY`, `_AUTODETECT`, `_TIMEOUT_MS`, `_BACKFILL`, `_BACKFILL_TIMEOUT_MS`, `_QUANT` — nine | `CONTEXT_MODE_EMBEDDINGS={"url":"…","model":"…","autodetect":true,"timeoutMs":5000,"backfill":16,"backfillTimeoutMs":120000,"quant":"int8"}`. **Keep `_API_KEY` separate** — a secret does not belong in a blob that gets echoed into diagnostics. |
| **Output compression** | `CONTEXT_MODE_COMPRESS_TESTS`, `_ENV`, `_ENV_VALUES`, `_REPEATS` — four, already read by one `compressionToggles()` function | `CONTEXT_MODE_COMPRESS={"tests":true,"envDump":true,"envValues":true,"repeats":true}` |
| **Graph freshness** | `CONTEXT_MODE_GRAPH_FRESHNESS`, `_MAX`, `_TTL_MS` — three | `CONTEXT_MODE_GRAPH_FRESHNESS={"enabled":true,"maxFiles":5000,"ttlMs":10000}` — the head name already carries the boolean, so `0` must keep working |
| **Executor limits** | `CONTEXT_MODE_EXEC_MAX_OUTPUT_BYTES`, `_IDLE_TIMEOUT_MS`, `_WALL_TIMEOUT_MS`, `_KILL_GRACE_MS` — four | `CONTEXT_MODE_EXEC_LIMITS={"maxOutputBytes":33554432,"idleMs":0,"wallMs":0,"killGraceMs":2000}` |
| **Escalation ladder** | `CONTEXT_MODE_NUDGE_AFTER_CALLS`, `_AFTER_BYTES`, `CONTEXT_MODE_ESCALATION_WINDOW_MS`, `_DENY_MIN_BYTES` — four describing one ladder under two prefixes | `CONTEXT_MODE_ESCALATION={"afterCalls":3,"afterBytes":102400,"windowMs":900000,"denyMinBytes":16384}` — the prefix split is itself the bug here |
| **Tokenizer** | `CONTEXT_MODE_TOKENIZER`, `_ENCODING`, `_BYTES_PER_TOKEN` — three | `CONTEXT_MODE_TOKENIZER={"mode":"heuristic","encoding":"o200k_base","bytesPerToken":4}`, with the bare string `heuristic`/`exact`/`bytes4` still accepted |
| **fff logs** | `CONTEXT_MODE_FFF_LOG_DIR`, `_MAX_AGE_DAYS`, `_SWEEP` — three | `CONTEXT_MODE_FFF_LOGS={"dir":"…","maxAgeDays":7,"sweep":true}` |

The two collapses above already fold 10 variables into 2 head names. Doing the
remaining nine would fold another 37 into 9 — together roughly a third of the
surface — without removing a single capability.
