# Context Mode — Benchmark Results

> Benchmarked against **real outputs** from popular Claude Code MCP servers, Skills, and dev tools.
> All fixtures captured from actual tool invocations — not synthetic data.

## Overview

| Metric | Value |
|--------|-------|
| Total scenarios | 21 |
| Tools benchmarked | `ctx_execute_file` (summarize) + `ctx_index`/`ctx_search` (knowledge retrieval) |
| Large output handling | Auto-externalize to FTS5 (>100 KB → pointer) |
| Total raw data processed | 376 KB |
| Total context consumed | 16.5 KB |
| Overall context savings | **96%** |
| Code examples preserved | **100%** (exact, not summarized) |
| Latency vs. native tools | 25–188 ms warm penalty per call; 0.2–1.4 s on the first call of a session ([Part 4](#part-4-latency--routed-call-vs-native-tool)) |

## Tool Decision Matrix

| Data Type | Best Tool | Why |
|-----------|-----------|-----|
| Documentation, API refs | `ctx_index` + `ctx_search` | Need exact code examples — not summaries |
| Skills prompts | `ctx_index` + `ctx_search` | Large prompts eat context; search on-demand |
| MCP tool signatures | `ctx_index` + `ctx_search` | Need exact tool names and parameters |
| Log files, test output | `ctx_execute_file` | Need aggregate stats, not raw lines |
| CSV data, analytics | `ctx_execute_file` | Need computed metrics |
| Build output | `ctx_execute_file` | Need error counts, not full logs |
| Browser snapshots | `ctx_execute_file` | Need page structure summary |

## Part 1: `ctx_execute_file` — Structured Data Processing

*Best for: logs, test output, CSV, build output — data where summaries are more useful than raw content.*

| Scenario | Source | Raw Size | Context | Savings | Time |
|----------|--------|----------|---------|---------|------|
| React useEffect docs | Context7 | 5.9 KB | 261 B | 96% | 18ms |
| Next.js App Router docs | Context7 | 6.5 KB | 249 B | 96% | 18ms |
| Tailwind CSS docs | Context7 | 4.0 KB | 186 B | 95% | 18ms |
| Page snapshot (Hacker News) | Playwright | 56.2 KB | 299 B | 99% | 16ms |
| Network requests | Playwright | 0.4 KB | 349 B | 13% | 16ms |
| PR list (vercel/next.js) | GitHub | 6.4 KB | 719 B | 89% | 16ms |
| Issues (facebook/react) | GitHub | 58.9 KB | 1,139 B | 98% | 16ms |
| Test output (30 suites) | vitest | 6.0 KB | 337 B | 95% | 16ms |
| TypeScript errors (50) | tsc | 4.9 KB | 347 B | 93% | 16ms |
| Build output (100+ lines) | next build | 6.4 KB | 405 B | 94% | 16ms |
| MCP tools (40 tools) | MCP tools/list | 17.0 KB | 742 B | 96% | 15ms |
| Access log (500 requests) | nginx | 45.1 KB | 155 B | 100% | 17ms |
| Git log (150+ commits) | git | 11.6 KB | 107 B | 99% | 16ms |
| Analytics CSV (500 rows) | analytics | 85.5 KB | 222 B | 100% | 32ms |

**Subtotal: 315 KB raw → 5.4 KB context (98% savings)** — 5,517 B summed over the 14 rows above, against 314.8 KB raw.

## Part 2: `ctx_index` + `ctx_search` — Knowledge Retrieval (FTS5 BM25)

*Best for: documentation, code examples, API references, Skills — content where you need EXACT text, not summaries.*

| Scenario | Source | Raw Size | Search Result (3 queries) | Savings | Chunks | Code Blocks |
|----------|--------|----------|---------------------------|---------|--------|-------------|
| Supabase Edge Functions | Context7 | 3.9 KB | 2,246 B | 44% | 5 | 4 |
| React useEffect docs | Context7 | 5.9 KB | 1,494 B | 75% | 16 | 4 |
| Next.js App Router docs | Context7 | 6.5 KB | 3,311 B | 50% | 5 | 5 |
| Tailwind CSS docs | Context7 | 4.0 KB | 620 B | 85% | 5 | 5 |
| Skill prompt (main) | context-mode | 4.4 KB | 932 B | 79% | 15 | 6 |
| Skill references (4 files) | context-mode | 33.2 KB | 2,412 B | 93% | 51 | 32 |

**Subtotal: 60.3 KB raw → 11.0 KB context (82% savings)**

**Key difference from `ctx_execute_file`:** Code examples are returned **exactly as written** — not summarized. A `useEffect` cleanup pattern comes back with the full code block intact.

### Why `ctx_index + ctx_search` savings are lower

`ctx_execute_file` achieves 95-100% savings because it compresses data into 1-2 line summaries. `ctx_index + ctx_search` achieves 50-93% savings because it returns **complete, exact chunks** — the actual code examples, not descriptions of them. This is by design:

- `ctx_execute_file` on React docs: `"5 code blocks, 3 sections about cleanup"` → **useless for coding**
- `ctx_index + ctx_search` on React docs: returns the full `useEffect(() => { ... }, [deps])` block → **actually useful**

## Part 3: Large Output Externalization (FTS5 Pointer)

*When output exceeds 100 KB, context-mode auto-indexes the full content into FTS5 and returns a pointer message instead of raw content. No data is discarded — the LLM queries it on demand via `ctx_search()`.*

| Before | After |
|---|---|
| Raw output floods context window | Output indexed into FTS5, pointer returned |
| LLM sees truncated/partial content | Full content preserved, queryable on demand |
| Large logs: **LOST** | Large logs: **FULLY INDEXED** |
| `"... [output truncated]"` | `"Indexed N sections from: execute:shell\nUse ctx_search(...) to query."` |

### Example

```
# ctx_execute output > 100 KB:

Indexed 42 sections (12 with code) from: execute:shell
Use ctx_search(queries: ["..."]) to query this content.
Use source: "execute:shell" to scope results.
```

The LLM retrieves only the relevant sections via `ctx_search()` — no context budget wasted on raw output.

## Part 4: Latency — routed call vs. native tool

*Everything above measures bytes saved. This part measures what those bytes cost in
time. A routed call that answers slower is paid for twice — by the user waiting and
by the model, which has every incentive to go back to `Grep` the moment the detour
feels expensive.*

### Method

| | |
|---|---|
| Machine | 13th Gen Intel Core i9-13900H, 20 threads, 30 GB RAM, Linux 7.0.0 |
| Repository under test | this one — 762 tracked files, 20 MB excluding `.git`/`node_modules` |
| Version measured | v1.0.170 (`server.bundle.mjs` as committed) |
| Node / ripgrep | v24.14.1 / ripgrep 15.2.0 |
| Routed side | child process running the committed `server.bundle.mjs`, driven over stdio JSON-RPC — the same path a host takes, no shortcut |
| Native side | `rg` measured **including** process spawn (the host spawns it too); `Read` measured as `readFileSync` plus the `cat -n` line prefixes that actually enter context |
| Runs | 5 cold, 7 warm per pair (after 2 unmeasured warmups), repeated as 3 independent runs |
| Statistic | median and p90, not mean — a single 2-second index build hides inside a mean, and it is exactly the outlier a user notices. The table reports the median across the 3 runs of each per-run statistic |
| Machine load | 1-minute load average 3.6–5.4 throughout (20 cores); the machine was not idle |
| Harness | [`tests/latency-benchmark.ts`](tests/latency-benchmark.ts) — `npx tsx tests/latency-benchmark.ts` |
| `ctx_read` rows | measured against an esbuild bundle of the same sources built to a temp path (`CTX_LATENCY_BUNDLE`), because `ctx_read` post-dates the committed `server.bundle.mjs`. Same flags, same execution path; the numbers are re-checked whenever the committed bundle catches up |

**Cold** = fresh server process against empty storage (`CONTEXT_MODE_DIR` and
`CONTEXT_MODE_FFF_DIR` under a fresh temp root), so the call pays for the MCP
handshake *and* for building whatever index it needs. **Warm** = one server whose
indexes are already built, which is the steady state of a session.

Three caveats stated up front. The OS page cache cannot be dropped without root, so
the native side has no true cold regime — `rg` first-touch and warm come out the
same, and that is a limitation of the measurement, not a property of ripgrep.
`CLAUDE_PROJECT_DIR` is pinned to the repo in the harness: without it the server
resolves the project from the most recent session log, and `ctx_find` answers with
files from whatever repository was open last. And the machine carried a steady
background load of 3.6–5.4 on 20 cores; a serial benchmark leaves most of that
capacity unused, but the sub-10 ms rows are close enough to scheduler noise that
they should be read as "single-digit milliseconds", not as three significant
figures.

### Results

| Pair | Call | Median | p90 | Context bytes |
|---|---|---:|---:|---:|
| **Locate a symbol** | `ctx_find` — cold | 624 ms | 698 ms | 1.5 KB |
| | `ctx_find` — warm | **160 ms** | 342 ms | 2.6 KB |
| | `rg -l` (Grep default) | **8 ms** | 10 ms | 0.7 KB |
| **Read one file's exports** | `ctx_execute_file` — cold | 269 ms | 289 ms | 529 B |
| | `ctx_execute_file` — warm | **26 ms** | 44 ms | 529 B |
| | `Read src/adapters/detect.ts` | **0.2 ms** | 0.4 ms | 34.0 KB |
| **The same file, no program written** | `ctx_read` — cold | 215 ms | 228 ms | 1.3 KB |
| | `ctx_read` — warm, structural slice | **25 ms** | 34 ms | 1.3 KB |
| | `ctx_read` — warm, `intent: "exports"` | **25 ms** | 30 ms | 2.5 KB |
| **Three questions, indexed content** | `ctx_search` — cold (incl. indexing `src/`) | 1,390 ms | 1,777 ms | 4.5 KB |
| | `ctx_search` — warm, 3 queries in one call | **214 ms** | 357 ms | 3.6 KB |
| | `rg -n` × 3 | **26 ms** | 28 ms | 34.6 KB |

Queries: `registerTool`, `detectPlatform`, `PLATFORM_ENV_VARS`.

Spread across the three runs, as per-run medians: `ctx_find` cold 585–647 ms, warm
146–190 ms; `ctx_execute_file` cold 239–274 ms, warm 20–36 ms; `ctx_read` cold
210–230 ms, warm 22–27 ms; `ctx_search` cold 1,336–1,643 ms, warm 212–300 ms;
`rg -l` 8–9 ms; `rg -n` × 3 26–28 ms. The
routed rows move by 20–40% run to run under background load, which is worth
knowing before treating any single number as precise — but the gap to the native
baseline is an order of magnitude wider than that spread, so the conclusions below
do not depend on which run is quoted.

### Reading the numbers honestly

**The routed call is slower in every pair, in every regime.** Warm, the penalty is
8× (`ctx_search`), 20× (`ctx_find`) and roughly 125–130× for both file-reading
tools (`ctx_execute_file` and `ctx_read`, against a `Read` that costs 0.2 ms).
There is no configuration in which routing is free.

**Relative multiples overstate it; absolute deltas are what a session feels.** Warm,
the detour costs 188 ms, 152 ms and 25–26 ms respectively. Against a model turn that
already runs into seconds, none of these is perceptible. The multiples look
alarming because the native baselines are 0.2–26 ms, not because the routed path
is slow.

**Cold is the real cost, and it lands on the first call of a session.** 0.62 s for
`ctx_find`, 1.39 s for `ctx_search` with a p90 of 1.78 s — and cold `ctx_search`
is the least stable row in the set, having reached a 4.1 s p90 on an earlier
build. This is the number to attack: it is paid exactly when the model is
deciding, for the rest of the session, whether the routed tool is worth using.

**`ctx_find` does not win on bytes, and should not be sold as if it did.** It
returns 2.6 KB against ripgrep's 0.7 KB — roughly 4× *more* context, because it
carries ranked snippets and graph relations rather than a bare path list. Its case
rests entirely on replacing a *sequence* (`rg -l`, then `Read` two or three
candidates at 30 KB each), not on beating a single `rg -l`. Where that sequence
does not happen, `ctx_find` is both slower and larger than the tool it replaces.

**`ctx_execute_file` is the best trade in the set — and that is the finding that
built `ctx_read`.** 26 ms warm buys a 98.5% byte reduction (34.0 KB → 529 B).
Latency is emphatically *not* why a model reaches for `Read` instead: 26 ms is
invisible. What it avoids is composing a program. That located the problem in the
call's ergonomics rather than its speed, which is what `ctx_read(path, intent)`
removes — the same handler, with the program supplied instead of demanded.

**`ctx_read` costs what `ctx_execute_file` costs, because it is that call.** 25 ms
warm against 26 ms, 215 ms cold against 269 ms — both differences sit inside the
run-to-run spread of either row, which is the expected result when one tool is
the other with a generated `code` argument. It returns 1.3 KB of structural slice, or 2.5 KB when
an `intent` selects matching regions, against `Read`'s 34.0 KB: a 96% reduction
for the structural slice, 93% with intent. Against `ctx_execute_file`'s 529 B it
is two to five times larger, which is the honest price of a program written
without knowing the question — a hand-written derivation that prints one number
will always beat a general slice, and the point of `ctx_read` is the calls where
nobody was going to write that program. (`ctx_execute_file` also accepts an
`intent` parameter, but it means the opposite end of the pipe: an *output*-side
hint that auto-indexes large stdout. `ctx_read`'s selects the *input*, and the
two are deliberately never forwarded into one another.)

**`ctx_search` earns its 8× warm penalty.** 214 ms for three questions answered in
one call, returning 3.6 KB against 34.6 KB from three greps — a 90% reduction for
the largest absolute saving in the set. Its problem is cold start, not steady
state.

## Context Window Impact

Claude's context window: **200,000 tokens**

### Scenario: Full debugging session

| Tool Calls | Without context-mode | With context-mode |
|---|---|---|
| Context7 docs (3 queries) | 16.4 KB | 5.6 KB |
| Playwright snapshot | 56.2 KB | 299 B |
| GitHub issues | 58.9 KB | 1,139 B |
| Test output | 6.0 KB | 337 B |
| Build output | 6.4 KB | 405 B |
| Skill prompt | 33.2 KB | 2.4 KB |
| **Total** | **177.1 KB** | **10.2 KB** |
| **Tokens** | **~45,300** | **~2,600** |
| **Context used** | **22.7%** | **1.3%** |

**Result: 94% more context available for actual problem solving.**

## Test Suite

| Suite | Tests | Status |
|-------|-------|--------|
| Executor (12 languages + edge cases) | 55 | All pass |
| ContentStore (FTS5 BM25) | 34 | All pass |
| MCP Integration (JSON-RPC) | 22 | All pass |
| Ecosystem Benchmark (14 scenarios) | 14 | All pass |
| **Total** | **125** | **All pass** |

## How to Reproduce

```bash
# Run individual test suites
npm run test              # Executor tests
npm run test:store        # FTS5 BM25 store tests
npm run test:ecosystem    # Ecosystem benchmark

# Run all tests
npm run test:all

# Live benchmark (requires Context7 fixture)
npx tsx tests/live-benchmark.ts

# Latency: routed call vs. native tool (Part 4)
npx tsx tests/latency-benchmark.ts
```

The latency harness needs `rg` on `PATH` and the committed `server.bundle.mjs`; it
writes only into a fresh temp root and never touches the real
`~/.claude/context-mode` store.

## Fixtures

All fixtures in `tests/fixtures/` are captured from real tool invocations:

| Fixture | Source | Size |
|---------|--------|------|
| `context7-react-docs.md` | Context7 MCP — React useEffect | 5.9 KB |
| `context7-nextjs-docs.md` | Context7 MCP — Next.js App Router | 6.5 KB |
| `context7-tailwind-docs.md` | Context7 MCP — Tailwind CSS | 4.0 KB |
| `context7-supabase-edge.md` | Context7 MCP — Supabase Edge Functions | 3.9 KB |
| `playwright-snapshot.txt` | Playwright MCP — page snapshot | 56.2 KB |
| `playwright-network.txt` | Playwright MCP — network requests | 0.4 KB |
| `github-prs.json` | `gh pr list --repo vercel/next.js` | 6.4 KB |
| `github-issues.json` | `gh issue list --repo facebook/react` | 58.9 KB |
| `test-output.txt` | vitest run (30 suites) | 6.0 KB |
| `tsc-errors.txt` | tsc --noEmit (50 errors) | 4.9 KB |
| `build-output.txt` | next build output | 6.4 KB |
| `mcp-tools.json` | MCP tools/list (40 tools) | 17.0 KB |
| `access.log` | nginx access log (500 requests) | 45.1 KB |
| `git-log.txt` | git log --oneline (153 commits) | 11.6 KB |
| `analytics.csv` | Event analytics (500 rows) | 85.5 KB |
