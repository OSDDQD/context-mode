# Context Mode

> **This is a fork** of [mksglu/context-mode](https://github.com/mksglu/context-mode) (v1.0.169) with fifteen additions:
> a user-extensible bounded-command allowlist, missed-redirect telemetry in `ctx_stats`, a read-only `ctx_gather`
> tool that survives plan mode, compact tool descriptions (~3.4K tokens/request reclaimed), a code index that
> seeds itself from `git ls-files` and evicts deleted files (and never indexes credentials), hybrid semantic
> search that adopts a local bge-m3 runtime on its own and stores int8 vectors, an opt-in proxy for
> `ctx_fetch_and_index`, a WebFetch passthrough so claude.ai Artifact URLs reach the tool that can actually read
> them (upstream #938/#984/#1006), a fix that finally makes Claude Code's own memory files searchable from
> `ctx_search`, a `ctx upgrade` that pulls from *this* repo instead of silently reinstalling upstream over it,
> a one-command upstream merge that survives the tracked bundles, and a contract test for ADR-0003.
> New in fork rev 4: deferred-tool awareness for Claude Code's tool search (a ToolSearch bootstrap in the
> SessionStart block, plus descriptions that upgrade to the full text once the handshake shows schemas are
> deferred and free), SubagentStop transcript capture (`ctx_search` can answer from what a finished subagent
> saw, not just its report), a SessionEnd hook with a detached `context-mode drain` that warms the index while
> the machine is idle, the ctx-* utility skills rehomed as zero-standing-context plugin commands, and a
> `context-gather` subagent definition.
> It also carries upstream's **fetch extraction ladder** (merged from `next` ahead of `upstream/main`): a
> JavaScript-rendered shell is no longer reported as a successful fetch, the article is extracted instead of
> the whole page transliterated, and SPA pages are recovered browser-free via their `.md` sibling or the host's
> `llms.txt`.
> See **[docs/FORK-CHANGES.md](docs/FORK-CHANGES.md)** for the full rationale, env vars, and trade-offs.

**The other half of the context problem.**

[![GitHub stars](https://img.shields.io/github/stars/OSDDQD/context-mode?style=flat&color=yellow)](https://github.com/OSDDQD/context-mode/stargazers) [![GitHub forks](https://img.shields.io/github/forks/OSDDQD/context-mode?style=flat&color=blue)](https://github.com/OSDDQD/context-mode/network/members) [![Last commit](https://img.shields.io/github/last-commit/OSDDQD/context-mode?color=green)](https://github.com/OSDDQD/context-mode/commits) [![License: ELv2](https://img.shields.io/badge/License-ELv2-blue.svg)](LICENSE)
[![Discord](https://img.shields.io/discord/1478479412700909750?label=Discord&logo=discord&color=5865f2)](https://discord.gg/DCN9jUgN5v)


## The Problem

Every MCP tool call dumps raw data into your context window. A Playwright snapshot costs 56 KB. Twenty GitHub issues cost 59 KB. One access log — 45 KB. After 30 minutes, 40% of your context is gone. And when the agent compacts the conversation to free space, it forgets which files it was editing, what tasks are in progress, and what you last asked for. On top of that, the agent wastes output tokens on filler, pleasantries, and verbose explanations — burning context from both sides.

### How Context Mode Solves It

Context Mode is an MCP server that solves all four sides of this problem:

1. **Context Saving** — Sandbox tools keep raw data out of the context window. Across the 14 `ctx_execute_file` scenarios in [BENCHMARK.md](BENCHMARK.md), 315 KB of raw output comes back as 5.4 KB — a 98% reduction. That is a measured byte ratio over a named corpus, not a projection; `ctx stats` reports what your own sessions actually kept out.
2. **Session Continuity** — Every file edit, git operation, task, error, and user decision is tracked in SQLite. When the conversation compacts, context-mode doesn't dump this data back into context — it indexes events into FTS5 and retrieves only what's relevant via BM25 search. The model picks up exactly where you left off. If you don't `--continue`, previous session data is deleted immediately — a fresh session means a clean slate.
3. **Think in Code** — The LLM should program the analysis, not compute it. Instead of reading 50 files into context to count functions, the agent writes a script that does the counting and `console.log()`s only the result. One script replaces ten tool calls and saves 100x context. This is a mandatory paradigm on both supported clients: stop treating the LLM as a data processor, treat it as a code generator.

   ```js
   // Before: 47 × Read() = 700 KB.  After: 1 × ctx_execute() = 3.6 KB.
   ctx_execute("javascript", `
     const files = fs.readdirSync('src').filter(f => f.endsWith('.ts'));
     files.forEach(f => console.log(f + ': ' + fs.readFileSync('src/'+f,'utf8').split('\\n').length + ' lines'));
   `);
   ```
4. **No prose-style enforcement** — context-mode keeps raw data out of context but never dictates how the model writes its final answer. Brevity, completeness, formatting — your model's call (or yours via your own `CLAUDE.md` / `AGENTS.md`). Aggressive brevity prompts have been shown to degrade coding/reasoning benchmarks ([Moonshot AI on `kimi-k2.5`](https://github.com/anomalyco/opencode/issues/20258)) — the routing block stays focused on *where data goes*, not on *how the model talks*.

<a href="https://www.youtube.com/watch?v=QUHrntlfPo4">
  <picture>
    <img src="https://img.youtube.com/vi/QUHrntlfPo4/maxresdefault.jpg" alt="Watch context-mode demo on YouTube" width="100%">
  </picture>
</a>
<p align="center"><a href="https://www.youtube.com/watch?v=QUHrntlfPo4"><img src="https://img.shields.io/badge/%E2%96%B6%EF%B8%8F_Watch_Demo-YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="Watch on YouTube"></a></p>

## Install

Platforms are grouped by install complexity. Hook-capable platforms get automatic routing enforcement. Non-hook platforms need a one-time routing file copy.

<details open>
<summary><strong>Claude Code</strong> — plugin marketplace, fully automatic</summary>

**Prerequisites:** Claude Code v1.0.33+ (`claude --version`). If `/plugin` is not recognized, update first: `brew upgrade claude-code` or `npm update -g @anthropic-ai/claude-code`.

**Install:**

```bash
/plugin marketplace add OSDDQD/context-mode
/plugin install context-mode@context-mode
```

Restart Claude Code (or run `/reload-plugins`).

**Verify:**

```
/context-mode:ctx-doctor
```

All checks should show `[x]`. The doctor validates runtimes, hooks, FTS5, and plugin registration.

**Routing:** Automatic. The SessionStart hook injects routing instructions at runtime — no file is written to your project. The plugin registers all hooks (PreToolUse, PostToolUse, UserPromptSubmit, PreCompact, SessionStart, Stop, SubagentStop, SessionEnd) and 14 MCP tools — nine execution and retrieval tools (`ctx_batch_execute`, `ctx_gather`, `ctx_execute`, `ctx_execute_file`, `ctx_index`, `ctx_search`, `ctx_find`, `ctx_graph`, `ctx_fetch_and_index`) plus five meta-tools (`ctx_stats`, `ctx_doctor`, `ctx_upgrade`, `ctx_purge`, `ctx_insight`).

| Slash Command | What it does |
|---|---|
| `/context-mode:ctx-stats` | Context savings — per-tool breakdown, tokens consumed, savings ratio. |
| `/context-mode:ctx-doctor` | Diagnostics — runtimes, hooks, FTS5, plugin registration, versions. |
| `/context-mode:ctx-index` | Index a local file or directory into the persistent FTS5 knowledge base. |
| `/context-mode:ctx-search` | Search previously indexed content. |
| `/context-mode:ctx-upgrade` | Pull latest, rebuild, migrate cache, fix hooks. |
| `/context-mode:ctx-purge` | Permanently delete all indexed content from the knowledge base. |
| `/context-mode:ctx-insight` | Opens the hosted Insight dashboard ([context-mode.com/insight](https://context-mode.com/insight)) in your browser — org analytics for AI-assisted engineering teams. |

> **Note:** Slash commands are a Claude Code plugin feature. On other platforms, type `ctx stats`, `ctx doctor`, `ctx index`, `ctx search`, `ctx upgrade`, or `ctx insight` in the chat — the model calls the MCP tool automatically. See [Utility Commands](#utility-commands).

**Status line (optional):** Claude Code's plugin manifest cannot declare a status line, so this is a one-time manual edit to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "context-mode statusline"
  }
}
```

After saving, restart Claude Code. The bar shows `$ saved this session · $ saved across sessions · % efficient` so you can see savings accumulate in real time. The wiring is path-free — `context-mode statusline` resolves through the bundled CLI regardless of where the plugin cache lives.

<details>
<summary>Alternative — MCP-only install (no hooks or slash commands)</summary>

```bash
claude mcp add context-mode -- npx -y context-mode
```

This gives you all 15 MCP tools without automatic routing. The model can still use them — it just won't be nudged to prefer them over raw Bash/Read/WebFetch. Good for trying it out before committing to the full plugin.

</details>

</details>

<details>
<summary><strong>Codex CLI</strong> — MCP + hooks</summary>

**Prerequisites:** Node.js >= 22.5 (or Bun), Codex CLI installed.

**Install:**

1. Add the context-mode marketplace and install the plugin from Codex's plugin UI:

   ```bash
   codex plugin marketplace add OSDDQD/context-mode
   ```

2. Enable plugin-provided hooks while the Codex feature is still gated:

   ```toml
   [features]
   plugin_hooks = true
   hooks = true
   ```

   > **Feature flag note:** Current Codex builds expose hooks under `[features].hooks`
   > (or `codex --enable hooks`). Prefer `[features].hooks`; `[features].codex_hooks`
   > remains accepted as a legacy alias in current Codex builds. Bundled plugin hooks
   > additionally require `plugin_hooks` until Codex enables plugin hooks by default.

   **Custom storage location:** if Codex cannot write the adapter default storage directory, set
   `CONTEXT_MODE_DIR` to an absolute writable root in the environment that launches Codex. Sessions
   and stats use `<root>/sessions`; indexed content uses `<root>/content`.

   ```bash
   CONTEXT_MODE_DIR="$HOME/.codex-context-mode" codex
   ```

3. Restart Codex CLI and verify MCP with `ctx stats`.

   `ctx stats` proves the plugin MCP server is installed and reachable; it does
   not prove hooks are trusted or running.

4. Review and trust the context-mode plugin hooks if Codex prompts for hook
   approval. Plugin hooks are only active after both feature flags are enabled
   and Codex has accepted the hook commands.

The Codex plugin manifest provides MCP via `.codex-plugin/mcp.json`, skills via
`skills/`, and bundled hooks via `.codex-plugin/hooks.json`. No manual
`[mcp_servers.context-mode]` block or `$CODEX_HOME/hooks.json` is needed when
`plugin_hooks` is enabled and the plugin hooks are trusted.

> **Node/PATH note:** context-mode still needs `node` visible to the Codex process.
> The plugin removes manual Codex config, but it does not vendor Node or inherit
> login-shell PATH fixes automatically.

**Manual fallback for Codex builds without `plugin_hooks`:**

1. Install context-mode globally:

   ```bash
   npm install -g context-mode
   ```

2. Add to `~/.codex/config.toml`:

   ```toml
   [features]
   hooks = true

   [mcp_servers.context-mode]
   command = "context-mode"

   [mcp_servers.context-mode.env]
   CONTEXT_MODE_PLATFORM = "codex"
   ```

3. Create `$CODEX_HOME/hooks.json` (or `~/.codex/hooks.json` when `CODEX_HOME` is unset):

   ```json
   {
     "hooks": {
      "PreToolUse": [{ "matcher": "local_shell|shell|shell_command|exec_command|Bash|Shell|apply_patch|Edit|Write|grep_files|ctx_execute|ctx_execute_file|ctx_batch_execute|ctx_fetch_and_index|ctx_search|ctx_index|mcp__", "hooks": [{ "type": "command", "command": "context-mode hook codex pretooluse" }] }],
       "PostToolUse": [{ "hooks": [{ "type": "command", "command": "context-mode hook codex posttooluse" }] }],
       "SessionStart": [{ "hooks": [{ "type": "command", "command": "context-mode hook codex sessionstart" }] }],
       "PreCompact": [{ "hooks": [{ "type": "command", "command": "context-mode hook codex precompact" }] }],
       "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "context-mode hook codex userpromptsubmit" }] }],
       "Stop": [{ "hooks": [{ "type": "command", "command": "context-mode hook codex stop" }] }]
     }
   }
   ```

   `PreToolUse` enforces deny/block routing today and is prepared for input rewrites once Codex supports them. `PostToolUse` captures session events. `PreCompact` builds the resume snapshot before compaction. `SessionStart` restores state after compaction. `UserPromptSubmit` captures user decisions and corrections. `Stop` records turn-end state.

   > **Note:** Codex PreToolUse routing currently supports deny rules only (blocks dangerous commands). It still needs upstream `updatedInput` support before context-mode can rewrite tool input; track [openai/codex#18491](https://github.com/openai/codex/issues/18491). Context injection (`additionalContext`) is not supported in Codex PreToolUse — it works via PostToolUse and SessionStart instead. This is handled automatically.
   >
   > `PreCompact` support is runtime-gated: it is present in Codex CLI 0.130.0, while the public Codex hooks docs may lag the shipped hook-event list. Older Codex builds that do not emit `PreCompact` will not create pre-compaction snapshots.

4. Copy routing instructions (recommended even with hooks for full routing awareness):

   ```bash
   CM_ROOT="$(npm root -g)/context-mode"
   cp "$CM_ROOT/configs/codex/AGENTS.md" ./AGENTS.md
   ```

   For global use: `CM_ROOT="$(npm root -g)/context-mode"; cp "$CM_ROOT/configs/codex/AGENTS.md" ~/.codex/AGENTS.md`. Global applies to all projects. If both exist, Codex CLI merges them.

5. Restart Codex CLI.

**Verify:** Start a session and type `ctx stats` to verify MCP. To verify hook routing, confirm Codex lists/trusts the context-mode plugin hooks, then run a command that matches the routing rules.

**Routing:** MCP tools work after plugin install. Plugin hook routing is active only when `hooks` and `plugin_hooks` are enabled and Codex trusts the plugin hook commands. Manual hook routing is active when `$CODEX_HOME/hooks.json` or `~/.codex/hooks.json` is configured. The `AGENTS.md` file provides routing instructions for model awareness.

</details>

<details>
<summary><strong>Build Prerequisites</strong> <sup>(CentOS, RHEL, Alpine)</sup></summary>

Context Mode uses [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) on Node.js, which ships prebuilt native binaries for most platforms. On glibc >= 2.31 systems (Ubuntu 20.04+, Debian 11+, Fedora 34+, macOS, Windows), `npm install` works without any build tools.

**Linux + Node.js >= 22.5:** Context Mode automatically uses the built-in `node:sqlite` module instead of `better-sqlite3`. This eliminates the native addon entirely, avoiding [sporadic SIGSEGV crashes](https://github.com/nodejs/node/issues/62515) caused by V8's `madvise(MADV_DONTNEED)` corrupting the addon's `.got.plt` section on Linux. No configuration needed — detection is automatic. **Linux + Node < 22.5 is unsupported** ([#564](https://github.com/mksglu/context-mode/issues/564)) — `npm install` will fail with remediation instructions.

**Bun users:** No native compilation needed. Context Mode automatically detects Bun and uses the built-in `bun:sqlite` module via a compatibility adapter. `better-sqlite3` and all its build dependencies are skipped entirely.

On older glibc systems (CentOS 7/8, RHEL 8, Debian 10), prebuilt binaries don't load and better-sqlite3 **automatically falls back to compiling from source** via `prebuild-install || node-gyp rebuild --release`. This requires a C++20 compiler (GCC 10+), Make, and Python with setuptools.

**Windows / missing binding self-heal:** if `better_sqlite3.node` ends up missing after install (e.g. `prebuild-install` not on cmd.exe PATH, no MSVC toolchain), the postinstall script and the runtime hook automatically re-fetch the prebuild and repair the binding — no manual `npm rebuild` needed (#408).

**CentOS 8 / RHEL 8** (glibc 2.28):

```bash
dnf install -y gcc-toolset-10-gcc gcc-toolset-10-gcc-c++ make python3 python3-setuptools
scl enable gcc-toolset-10 'npm install -g context-mode'
```

**CentOS 7 / RHEL 7** (glibc 2.17):

```bash
yum install -y centos-release-scl
yum install -y devtoolset-10-gcc devtoolset-10-gcc-c++ make python3
pip3 install setuptools
scl enable devtoolset-10 'npm install -g context-mode'
```

**Alpine Linux:**

Alpine prebuilt binaries (musl) are available in better-sqlite3 v12.8.0+. With the `^12.6.2` dependency range, `npm install` resolves to the latest 12.x and works without build tools on Alpine. If you pin an older version:

```bash
apk add build-base python3 py3-setuptools
npm install -g context-mode
```

</details>

## Tools

| Tool | What it does | Context saved |
|---|---|---|
| `ctx_batch_execute` | Run multiple commands + search multiple queries in ONE call. Opt-in `concurrency: 1-8` for I/O-bound batches. | 986 KB → 62 KB |
| `ctx_gather` | The same engine behind `readOnlyHint: true`, with every command proved read-only first — usable in plan mode. | Same as `ctx_batch_execute` |
| `ctx_execute` | Run code in 12 languages. Only stdout enters context. | 56 KB → 299 B |
| `ctx_execute_file` | Process files in a separate subprocess. Raw content never leaves. | 45 KB → 155 B |
| `ctx_read` | **What is in this file?** `ctx_execute_file` with the program already written — one required argument, `path`. Returns a slice: size, structure (declarations, headings, JSON keys, CSV header), and the regions matching an optional `intent`, with line numbers. Same execution path as `ctx_execute_file`, so nothing about it is a shortcut except the missing `code` argument. | 34 KB → ~1 KB |
| `ctx_index` | Chunk markdown into FTS5 with BM25 ranking. | 60 KB → 40 B |
| `ctx_search` | Query indexed content with multiple queries in one call. | On-demand retrieval |
| `ctx_find` | **Where does this live?** One fused search: fuzzy file names (frecency-ranked), literal grep, the FTS5 knowledge base, chunk vectors, and the codegraph neighbourhood — five signals reciprocal-rank-fused into a single list, each row tagged with the signals that found it and blind signals reported. Confine with `scope` (directory prefix) or `type` (`all` \| `files` \| `code` \| `memory`). Replaces the Glob + Grep + `ctx_search` triad. | 3 calls → 1 |
| `ctx_graph` | **How is this connected?** Structural questions answered from the codegraph SQLite index instead of by reading files: `symbols` (where a name is defined), `outline` (a file's declarations in source order), `callers` / `callees` (transitive call-graph walk), `impact` (what breaks if a symbol changes), `related` (the graph neighbourhood of a file), `explore` (source bodies plus the call paths reaching them). Every answer states whether the index lags the working tree. Requires `codegraph init` once per project. | 15 × `Read` → a few rows |
| `ctx_pack` | **What does the next agent need to know?** One hand-off package for a task under a token budget: the personalized-PageRank repo map, the symbols the task matches (signatures, then verbatim bodies at stated line ranges), and passages already captured in this project's knowledge base. Every block is labelled SIGNATURE, BODY or EXCERPT, and a closing NOTES block states what was included, what was trimmed and what is absent. | Read-per-file briefing → 1 call |
| `ctx_fetch_and_index` | Fetch URL, chunk and index. Cache reuses content within TTL (default 24h, override per-call with `ttl: <ms>`). `ttl: 0` or `force: true` to bypass. Pass `requests: [{url, source}, ...]` + `concurrency: 1-8` for parallel multi-URL. | 60 KB → 40 B |
| `ctx_stats` | Show context savings, call counts, and session statistics. | — |
| `ctx_doctor` | Diagnose installation: runtimes, hooks, FTS5, versions. | — |
| `ctx_upgrade` | Upgrade to latest version from GitHub, rebuild, reconfigure hooks. | — |
| `ctx_purge` | Permanently deletes all indexed content from the knowledge base. | — |
| `ctx_insight` | Open the hosted Insight dashboard in the default browser. | — |

## How the Subprocess Boundary Works

Each `ctx_execute` call spawns a separate subprocess with its own process boundary. Scripts can't access each other's memory or state. The subprocess runs your code, captures stdout, and only that stdout enters the conversation context. The raw data — log files, API responses, snapshots — never enters your conversation.

That boundary is about **context**, not security: the subprocess runs with the project root as its working directory and inherits the parent's filesystem permissions and (by default) its environment. It is not an OS sandbox. See [ADR-0006](docs/adr/0006-execution-isolation-posture.md) for what is and is not promised, and `CONTEXT_MODE_EXEC_ENV_MODE=allowlist` for tightening the environment half.

Twelve language runtimes are available: JavaScript, TypeScript, Python, Shell, Ruby, Go, Rust, PHP, Perl, R, Elixir, and C#. Bun is auto-detected for 3-5x faster JS/TS execution.

Authenticated CLIs work through credential passthrough — `gh`, `aws`, `gcloud`, `kubectl`, `docker` inherit environment variables and config paths without exposing them to the conversation.

When output exceeds 5 KB and an `intent` is provided, Context Mode switches to intent-driven filtering: it indexes the full output into the knowledge base, searches for sections matching your intent, and returns only the relevant matches with a vocabulary of searchable terms for follow-up queries.

## How the Knowledge Base Works

The `ctx_index` tool chunks markdown content by headings while keeping code blocks intact, then stores them in a **SQLite FTS5** (Full-Text Search 5) virtual table. The SQLite backend is selected automatically at runtime: `bun:sqlite` on Bun, `node:sqlite` on Node.js >= 22.5, and `better-sqlite3` everywhere else. Search uses **BM25 ranking** — a probabilistic relevance algorithm that scores documents based on term frequency, inverse document frequency, and document length normalization. **Porter stemming** is applied at index time so "running", "runs", and "ran" match the same stem. Titles and headings are weighted **5x** in BM25 scoring for precise navigational queries.

When you call `ctx_search`, it returns relevant content snippets focused around matching query terms — not full documents, not approximations, the actual indexed content with smart extraction around what you're looking for. `ctx_fetch_and_index` extends this to URLs: fetch, convert HTML to markdown, chunk, index. The raw page never enters context. Use the `contentType` parameter to filter results by type (e.g. `code` or `prose`).

### Ranking: Reciprocal Rank Fusion

Search runs two parallel strategies and merges them with **Reciprocal Rank Fusion (RRF)**:

- **Porter stemming** — FTS5 MATCH with porter tokenizer. "caching" matches "cached", "caches", "cach".
- **Trigram substring** — FTS5 trigram tokenizer matches partial strings. "useEff" finds "useEffect", "authenticat" finds "authentication".

RRF merges both ranked lists into a single result set, so a document that ranks well in both strategies surfaces higher than one that ranks well in only one. This replaces the old cascading fallback approach where trigram results were only used if porter returned nothing.

### Proximity Reranking

Multi-term queries get an additional reranking pass. Results where query terms appear close together are boosted — `"session continuity"` ranks passages with adjacent terms higher than pages where "session" and "continuity" appear paragraphs apart.

### Fuzzy Correction

Levenshtein distance corrects typos before re-searching. "kuberntes" becomes "kubernetes", "autentication" becomes "authentication".

### Smart Snippets

Search results use intelligent extraction instead of truncation. Instead of returning the first N characters (which might miss the important part), Context Mode finds where your query terms appear in the content and returns windows around those matches.

### TTL Cache

Indexed content persists in a per-project SQLite database at `~/.context-mode/content/`. When `ctx_fetch_and_index` is called for a URL that was already indexed within its TTL window, the fetch is skipped entirely and the model searches the existing index directly.

- **Default TTL:** 24 hours. Override per-call with `ttl: <milliseconds>` (PR #666). Longer for stable specs, shorter for changelogs you want re-checked often.
- **Cache hit (within TTL):** Returns a cache hint (~0.3KB) instead of re-fetching (48KB+). Model proceeds to `ctx_search`.
- **Cache miss (TTL expired):** Re-fetches silently. No user action needed.
- **`ttl: 0`** or **`force: true`:** Bypasses cache and re-fetches regardless of freshness.
- **14-day cleanup:** Content databases and sources older than 14 days are removed on startup.

This means `--continue` sessions preserve indexed docs across restarts. No re-fetching, no wasted context tokens.

`ctx_stats` reports cache performance separately: hits, data avoided, network requests saved, and total context savings including cache.

### Progressive Throttling

- **Calls 1-3:** Normal results (2 per query)
- **Calls 4-8:** Reduced results (1 per query) + warning
- **Calls 9+:** Blocked — redirects to `ctx_batch_execute`

## Session Continuity

When the context window fills up, the agent compacts the conversation — dropping older messages to make room. Without session tracking, the model forgets which files it was editing, what tasks are in progress, what errors were resolved, and what you last asked for.

Context Mode captures every meaningful event during your session and persists them in a per-project SQLite database. When the conversation compacts (or you resume with `--continue`, `--resume`, or `/resume`), your working state is rebuilt automatically — the model continues from your last prompt without asking you to repeat anything.

> Resuming a non-latest session via `/resume <picker>` works the same way: the SessionStart hook detects the empty live-event table for the freshly issued session id and falls back to the most recent unconsumed snapshot for the project (`session_resume` table). The picker selects the conversation; context-mode rehydrates the prior working state.

Session continuity requires 5 hooks working together:

| Hook | Role | Claude Code | Codex CLI |
| --- | --- | :---: | :---: |
| **PreToolUse** | Enforces sandbox routing before tool execution | Yes | Yes |
| **PostToolUse** | Captures events after each tool call | Yes | Yes |
| **UserPromptSubmit** | Captures user decisions and corrections | Yes | Yes |
| **Stop** | Captures assistant turn-end state | Yes | Yes |
| **PreCompact** | Builds snapshot before compaction | Yes | Yes |
| **SessionStart** | Restores state after compaction or resume | Yes | Yes |
|  | **Session completeness** | **Full** | **Partial** |

> **Note:** Full session continuity (capture + snapshot + restore) works on **Claude Code**, where all six hooks fire. **Codex CLI** is partial: its hooks must be enabled with `[features].hooks = true`, and what they capture is listed per host below.

<details>
<summary><strong>What gets captured</strong></summary>

Every tool call passes through hooks that extract structured events:

| Category | Events | Priority | Captured By |
|---|---|---|---|
| **Files** | read, edit, write, glob, grep | Critical (P1) | PostToolUse |
| **Tasks** | create, update, complete | Critical (P1) | PostToolUse |
| **Plans** | enter, exit, approved, rejected, file write | Critical (P1) | PostToolUse |
| **Rules** | CLAUDE.md / AGENTS.md paths + content | Critical (P1) | SessionStart |
| **User Prompts** | Every user message (for last-prompt restore) | Critical (P1) | UserPromptSubmit |
| **Decisions** | User corrections, preferences ("use X instead", "don't do Y") | High (P2) | UserPromptSubmit |
| **Git** | checkout, commit, merge, rebase, stash, push, pull, diff, status | High (P2) | PostToolUse |
| **Errors** | Tool failures, non-zero exit codes | High (P2) | PostToolUse |
| **Error Resolution** | Error → fix pairs detected across sequential tool calls | High (P2) | PostToolUse |
| **Constraints** | Discovered limitations ("not supported", "permission denied") | High (P2) | PostToolUse |
| **Blockers** | "blocked on", "waiting for", "depends on" — tracked until resolved | High (P2) | UserPromptSubmit |
| **Rejected Approaches** | Tool calls denied by user (PreToolUse → PostToolUse marker) | High (P2) | PreToolUse |
| **Environment** | cwd changes, venv, nvm, conda, worktree, package installs | High (P2) | PostToolUse |
| **Agent Findings** | Completed subagent results (first 500 chars) | High (P2) | PostToolUse |
| **Iteration Loops** | Same tool called 3+ times with similar input (retry detection) | High (P2) | PostToolUse |
| **Latency** | Tool calls exceeding 5s (tool name + duration in ms) | Normal (P3) | PreToolUse |
| **MCP Tools** | All `mcp__*` tool calls with usage counts | Normal (P3) | PostToolUse |
| **Subagents** | Agent tool launches and completions | Normal (P3) | PostToolUse |
| **Skills** | Slash command invocations | Normal (P3) | PostToolUse |
| **External Refs** | URLs, GitHub issue references (#123), deduped | Normal (P3) | PostToolUse |
| **Role** | Persona / behavioral directives ("act as senior engineer") | Normal (P3) | UserPromptSubmit |
| **Intent** | Session mode classification (investigate, implement, review) | Low (P4) | UserPromptSubmit |
| **Data** | Large user-pasted data references (>1 KB) | Low (P4) | UserPromptSubmit |

</details>

<details>
<summary><strong>How sessions survive compaction</strong></summary>

```
PreCompact fires
  → Read all session events from SQLite
  → Build priority-tiered XML snapshot (≤2 KB)
  → Store snapshot in session_resume table

SessionStart fires (source: "compact")
  → Retrieve stored snapshot
  → Write structured events file → auto-indexed into FTS5
  → Build Session Guide with 15 categories
  → Inject <session_knowledge> directive into context
  → Model continues from last user prompt with full working state
```

The snapshot is built in priority tiers — if the 2 KB budget is tight, lower-priority events (intent, MCP tool counts) are dropped first while critical state (active files, tasks, rules, decisions) is always preserved.

After compaction, the model receives a **Session Guide** — a structured narrative with actionable sections:

- **Last Request** — user's last prompt, so the model continues without asking "what were we doing?"
- **Tasks** — checkbox format with completion status (`[x]` completed, `[ ]` pending)
- **Plans** — plan mode entries, exits, approvals, and rejections
- **Key Decisions** — user corrections and preferences ("use X instead", "don't do Y")
- **Files Modified** — all files touched during the session
- **Unresolved Errors** — errors that haven't been fixed, plus error→fix resolution pairs
- **Constraints** — discovered limitations and boundaries
- **Blockers** — open and resolved blockers ("blocked on X", "waiting for Y")
- **Git** — operations performed (checkout, commit, push, status)
- **Project Rules** — CLAUDE.md / AGENTS.md paths
- **MCP Tools Used** — tool names with call counts
- **Subagent Tasks** — delegated work summaries + agent findings
- **Skills Used** — slash commands invoked
- **Rejected Approaches** — tool calls the user denied
- **External References** — URLs and GitHub issue references
- **Environment** — working directory, env variables, worktrees
- **Data References** — large data pasted during the session
- **Session Intent** — mode classification (implement, investigate, review, discuss)
- **User Role** — behavioral directives set during the session

Detailed event data is also indexed into FTS5 for on-demand retrieval via `ctx_search()`.

</details>

<details>
<summary><strong>Per-platform details</strong></summary>

**Claude Code** — Full session support. All 5 hook types fire, capturing tool events, user decisions, building compaction snapshots, and restoring state after compaction, `--continue`, `--resume`, or `/resume`.

**Codex CLI** — MCP active, hooks require `[features].hooks = true`. Hook scripts (PreToolUse, PostToolUse, PreCompact, SessionStart, UserPromptSubmit, Stop) are implemented and tested; `PreCompact` remains runtime-gated on Codex builds that emit the event. PreToolUse deny routing works; input rewriting still depends on upstream `updatedInput` support ([openai/codex#18491](https://github.com/openai/codex/issues/18491)).

</details>

## Platform Compatibility

| Feature | Claude Code | Codex CLI |
| --- | :---: | :---: |
| MCP Server / Native Tools | Yes | Yes |
| PreToolUse Hook | Yes | Yes |
| PostToolUse Hook | Yes | Yes |
| SessionStart Hook | Yes | Yes |
| PreCompact Hook | Yes | Yes |
| Can Modify Args | Yes | -- |
| Can Block Tools | Yes | Yes |
| Utility Commands (ctx) | Yes | Yes |
| Slash Commands | Yes | -- |
| Plugin Marketplace | Yes | -- |

> **Codex CLI** hooks require `[features].hooks = true`. MCP tools work, and hook scripts activate through `$CODEX_HOME/hooks.json` or `~/.codex/hooks.json`. PreToolUse supports `permissionDecision: "deny"` only; input modification still needs upstream `updatedInput` support ([openai/codex#18491](https://github.com/openai/codex/issues/18491)). `additionalContext` is not supported in PreToolUse (context injection works via PostToolUse and SessionStart instead; the codex formatter handles this automatically). PreCompact stores resume snapshots before compaction on Codex builds that emit the event, SessionStart restores them, and UserPromptSubmit/Stop capture prompt and turn-end continuity events. See the Codex install section for setup.
>

### Routing Enforcement

Hooks intercept tool calls programmatically — they can block dangerous commands and redirect them to the sandbox before execution. Instruction files guide the model via prompt instructions but cannot block anything. **Always enable hooks where supported.**

> **Note:** Routing instruction files were previously auto-written to project directories on first session start. This was disabled to prevent git tree pollution ([#158](https://github.com/mksglu/context-mode/issues/158), [#164](https://github.com/mksglu/context-mode/issues/164)). Both supported platforms inject or enforce routing through hooks instead of writing a file into your tree.

| Platform | Hooks | Instruction File | With Hooks | Without Hooks |
|---|:---:|---|:---:|:---:|
| Claude Code | Yes (auto) | [`CLAUDE.md`](configs/claude-code/CLAUDE.md) | **~98% saved** | ~60% saved |
| Codex CLI | Yes | [`AGENTS.md`](configs/codex/AGENTS.md) | **~98% saved** | ~60% saved |

Without hooks, one unrouted `curl` or Playwright snapshot can dump 56 KB into context — wiping out an entire session's worth of savings.

See [`docs/platform-support.md`](docs/platform-support.md) for the full capability comparison.

## Utility Commands

**Inside any AI session** — just type the command. The LLM calls the MCP tool automatically:

```
ctx stats       → context savings, call counts, session report
ctx doctor      → diagnose runtimes, hooks, FTS5, versions
ctx index       → index a local file or directory for later search
ctx search      → search previously indexed content
ctx upgrade     → update from GitHub, rebuild, reconfigure hooks
ctx purge       → permanently delete all indexed content from the knowledge base
ctx insight     → opens the hosted Insight dashboard in your browser
```

**From your terminal** — run directly without an AI session:

```bash
context-mode doctor
context-mode index . --source project:my-app
context-mode search "authentication middleware" --source project:my-app
context-mode upgrade
context-mode insight          # opens the hosted Insight dashboard in browser
bash scripts/ctx-debug.sh    # full diagnostic report for bug reports
```

The debug script collects OS info, runtime versions, better-sqlite3 status, adapter detection, config files (redacted), hook validation, FTS5/SQLite test, executor test, process check, session databases, and environment variables into a single pasteable markdown report.

Works on **all platforms**. On Claude Code, slash commands (`/ctx-stats`, `/ctx-doctor`, `/ctx-index`, `/ctx-search`, `/ctx-upgrade`, `/ctx-purge`, `/ctx-insight`) are also available.

## Benchmarks

| Scenario | Raw | Context | Saved |
|---|---|---|---|
| Playwright snapshot | 56.2 KB | 299 B | 99% |
| GitHub Issues (20) | 58.9 KB | 1.1 KB | 98% |
| Access log (500 requests) | 45.1 KB | 155 B | 100% |
| Context7 React docs | 5.9 KB | 261 B | 96% |
| Analytics CSV (500 rows) | 85.5 KB | 222 B | 100% |
| Git log (153 commits) | 11.6 KB | 107 B | 99% |
| Test output (30 suites) | 6.0 KB | 337 B | 95% |
| Repo research (subagent) | 986 KB | 62 KB | 94% |

Summed over the 14 `ctx_execute_file` scenarios: 315 KB of raw output becomes 5.4 KB — 98% kept out. Session time extends from ~30 minutes to ~3 hours.

[Full benchmark data with 21 scenarios →](BENCHMARK.md)

## Try It

These prompts work out of the box. Run `/context-mode:ctx-stats` after each to see the savings.

**Deep repo research** — 5 calls, 62 KB context (raw: 986 KB, 94% saved)
```
Research https://github.com/modelcontextprotocol/servers — architecture, tech stack,
top contributors, open issues, and recent activity. Then run /context-mode:ctx-stats.
```

**Git history analysis** — 1 call, 5.6 KB context
```
Clone https://github.com/facebook/react and analyze the last 500 commits:
top contributors, commit frequency by month, and most changed files.
Then run /context-mode:ctx-stats.
```

**Web scraping** — 1 call, 3.2 KB context
```
Fetch the Hacker News front page, extract all posts with titles, scores,
and domains. Group by domain. Then run /context-mode:ctx-stats.
```

**Large JSON API** — 7.5 MB raw → 0.9 KB context (99% saved)
```
Create a local server that returns a 7.5 MB JSON with 20,000 records and a secret
hidden at index 13000. Fetch the endpoint, find the hidden record, and show me
exactly what's in it. Then run /context-mode:ctx-stats.
```

**Documentation search** — 2 calls, 1.8 KB context
```
Fetch the React useEffect docs, index them, and find the cleanup pattern
with code examples. Then run /context-mode:ctx-stats.
```

**Session continuity** — compaction recovery with full state
```
Start a multi-step task: "Create a REST API with Express — add routes, tests,
and error handling." After 20+ tool calls, type: ctx stats to see the session
event count. When context compacts, the model continues from your last prompt
with tasks, files, and decisions intact — no re-prompting needed.
```

## Privacy & Architecture

Context Mode is not a CLI output filter or a cloud analytics dashboard. It operates at the MCP protocol layer — raw data stays in a separate subprocess and never enters your context window. Web pages, API responses, file analysis, Playwright snapshots, log files — everything is processed out of context.

**Nothing leaves your machine.** No telemetry, no cloud sync, no usage tracking, no account required. Your code, your prompts, your session data — all local. The SQLite databases live in your home directory and die when you're done.

This is a deliberate architectural choice, not a missing feature. Context optimization should happen at the source, not in a dashboard behind a per-seat subscription. Privacy-first is our philosophy — and every design decision follows from it. [License →](#license)

## Security

Context Mode enforces the same permission rules you already use — but extends them to the MCP sandbox. If you block `sudo`, it's also blocked inside `ctx_execute`, `ctx_execute_file`, and `ctx_batch_execute`.

**Zero setup required.** If you haven't configured any permissions, nothing changes. This only activates when you add rules.

```json
{
  "permissions": {
    "deny": [
      "Bash(sudo *)",
      "Bash(rm -rf /*)",
      "Read(.env)",
      "Read(**/.env*)"
    ],
    "allow": [
      "Bash(git:*)",
      "Bash(npm:*)"
    ]
  }
}
```

Add this to your project's `.claude/settings.json` (or `~/.claude/settings.json` for global rules). Both platforms read security policies from Claude Code's settings format — Codex too, so one policy file covers the fork's whole surface.

The pattern is `Tool(what to match)` where `*` means "anything".

Commands chained with `&&`, `;`, or `|` are split — each part is checked separately. `echo hello && sudo rm -rf /tmp` is blocked because the `sudo` part matches the deny rule.

**deny** always wins over **allow**. More specific (project-level) rules override global ones.

### Project-boundary containment

`ctx_execute_file` is confined to the project root. A `path` that resolves **outside** the workspace — an absolute path like `/home/user/secrets`, a `../../` traversal, or a project-local symlink whose target escapes the project — is refused with a `File access blocked` error. This closes the [#852](https://github.com/mksglu/context-mode/issues/852) escape vector where an agent, denied an out-of-project read by the host sandbox, retried through the MCP sandbox (the host's MCP approval prompt cannot inspect the tool's input params, so the escape was invisible to the approver).

The guard is **on by default** and requires no configuration. To intentionally process a file outside the project (e.g. a shared log under `/var/log`), opt that path back in with the **same `permissions.allow` rule you already use for the host `Read` tool** — there is no context-mode-specific env flag:

```json
{
  "permissions": {
    "allow": ["Read(/var/log/**)"]
  }
}
```

context-mode honors that allow rule (read from your `.claude/settings.json` / `~/.claude/settings.json`) exactly as Claude Code does, so an out-of-project grant lives in one place and stays meaningful.

Reviewing the prompt: the `ctx_execute` / `ctx_execute_file` approval titles now read as code execution ("Run code in a separate process…", "Run code over a file…") so an unfamiliar reviewer can recognise the action class even though the MCP prompt renders only the tool title and raw arguments. `ctx_execute` and `ctx_batch_execute` run arbitrary code and still inherit the process's filesystem access, so the boundary guard is a defense-in-depth layer for the *file-read* tool, not a full OS sandbox — treat approving any execution tool as approving arbitrary code, and keep host-level sandboxing enabled.

### Network fetch hardening

`ctx_fetch_and_index` blocks dangerous URL targets by default:

- **Schemes**: only `http:` and `https:` allowed (no `file://`, `gopher://`, `javascript:`, `data:`).
- **Cloud metadata + link-local**: `169.254.0.0/16` (incl. AWS/GCP/Azure IMDS endpoint `169.254.169.254`) hard-blocked even if a hostname resolves to it (DNS-rebinding defense).
- **Multicast / reserved**: `224.0.0.0/4`, `0.0.0.0/8`, IPv6 `ff00::/8`, `fe80::/10` blocked.
- **Loopback + RFC1918** (`localhost`, `127.x`, `10.x`, `172.16-31.x`, `192.168.x`, IPv6 `::1`, `fc00::/7`) **allowed by default** so local dev servers + internal-network fetches keep working.

For hosted/CI environments where you want to block private targets too, set:

```bash
export CTX_FETCH_STRICT=1
```

That blocks loopback + RFC1918 + ULA in addition to the always-blocked ranges. Useful when context-mode runs as a shared service, not on a developer's own machine.

`tool_input` for any `mcp__*` tool call is also redacted before persistence — the regex matcher in `hooks/posttooluse.mjs` masks `authorization`, `auth_token`, `access_token`, `refresh_token`, `bearer`, `token`, `secret`, `password`, `passwd`, `pwd`, `api_key` / `apikey` / `x_api_key`, `cookie` / `set-cookie`, `signature`, `private_key`, and `client_secret` (case-insensitive, hyphen/underscore-insensitive) to `[REDACTED]` so credentials in MCP arguments don't end up in the session DB.

> The two tables below cover the flags most people touch. **[docs/env-flags.md](docs/env-flags.md)** is the complete reference — every `CONTEXT_MODE_*` flag with its default, its layer, and whether you should set it.

### Storage environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CONTEXT_MODE_DIR` | Adapter default, for example `~/.codex/context-mode` or `~/.claude/context-mode` | Since v1.0.147. Absolute writable root for context-mode storage. Sessions and stats use `<root>/sessions`; indexed content uses `<root>/content`. Empty or whitespace-only values are treated as unset and shown by `ctx_doctor`; non-empty values must be absolute. `~` is not expanded. |

### Routing-guidance environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CONTEXT_MODE_READ_DENY_BYTES` | `50000` | Size at or above which reading a whole file is refused and `ctx_execute_file` on the same path is handed back. The same number the byte accounting calls a large read, so what you are refused at and what `ctx_stats` reports as avoided stay one number. `0` disables the refusal and leaves the advisory. |
| `CONTEXT_MODE_READ_EDIT_WINDOW_MS` | `120000` (2 min) | How long after a refusal the same path may be read anyway. This window IS the read-before-edit escape hatch: `Edit` matches the exact bytes in the conversation and a summary is not those bytes, so repeating the call within the window goes through unchanged. |
| `CONTEXT_MODE_BASH_DENY_COMMANDS` | `npm test,docker logs,git log -p,find /(\s\|$)` | Comma-separated regexes for Bash commands whose output floods context; a match is refused with a ready `ctx_batch_execute`. An entry that is not valid regex falls back to a case-insensitive substring test. An empty value turns the list off. |
| `CONTEXT_MODE_GREP_ASK` | on | `0` stops `Grep`/`Glob` asking for confirmation. Only unbounded searches ask — no path, no glob, no `head_limit`, matching lines rather than names — and it is `ask`, never `deny`, because `ctx_find` ranks rather than enumerates and an exhaustive literal sweep is what `Grep` is for. |
| `CONTEXT_MODE_NUDGE_AFTER_CALLS` | `3` | Unrouted heavy calls per step of the escalation ladder. Three buys the advisory back, six turns it into a redirect, nine into a refusal; there is no step past refusing. What each step means depends on the tool: `Bash` redirects from the second step up (the replacement runs the same command, so there is nothing to confirm), `Read` confirms at the second and refuses at the third, `Grep` never goes past a confirmation. A session that routes its heavy work sits at step zero and never hears from the plugin. |
| `CONTEXT_MODE_BASH_ESCALATION_ASK` | off | `1` restores the confirmation prompt on Bash's escalation rung. It was the default until ADR-0025 and it was the one step whose two answers were both losses: "No" reached the model as a refusal with no replacement attached and ended the turn, "Yes" put the whole output in the window *and* booked the call as sanctioned, so the ladder stopped counting the bytes that had just arrived. |
| `CONTEXT_MODE_NUDGE_AFTER_BYTES` | `102400` (100 KB) | The same ladder measured in leaked bytes. Whichever of the two thresholds is further along sets the step. |
| `CONTEXT_MODE_ESCALATION_WINDOW_MS` | `900000` (15 min) | How far back the ladder counts. The step follows recent behaviour, not the session's history: a window with no heavy call returns the session to silence on its own. The session totals stay in the wording — the notice says what the session has spent, the ladder prices what it is doing now. |
| `CONTEXT_MODE_ESCALATION_DENY_MIN_BYTES` | `16384` (16 KB) | Size below which the ladder's DENY step refuses nothing. A refusal costs about a kilobyte of reason text and usually ends with the file being read anyway, so below this it is friction bought at a loss; the value can only be raised. The `ask` step gets the same rule at half the number (8 KB), derived from this one so the two steps cannot end up in the wrong order — below it the ladder keeps only its advisory. Distinct from `CONTEXT_MODE_MISSED_REDIRECT_MIN_BYTES`, which decides what is worth *recording*. |
| `CONTEXT_MODE_BASH_NUDGE_MIN_COMMAND_BYTES` | `0` (off) | When set to N>0, an unbounded Bash command shorter than N bytes skips the generic routing nudge. Opt-in, bounded to `[0, 100000]`; invalid values fall back to `0`. Gates only the generic nudge — `curl`/`wget`, inline HTTP and build-tool redirects fire earlier and are never relaxed. |
| `CONTEXT_MODE_MISSED_REDIRECT_MIN_BYTES` | `2000` | Payload size at or above which an unrouted call is recorded as one. This is the collection floor everything else measures against. |
| `CONTEXT_MODE_COST_NOTICE` | on | `0` drops the line appended to an unrouted heavy result naming what it cost and which call would have replaced it. Routed calls never carry it. |
| `CONTEXT_MODE_ADHERENCE_MIN_BYTES` | `2000` | Heaviness line for the routing-adherence ratio in `ctx_stats`. Clamped up to `CONTEXT_MODE_MISSED_REDIRECT_MIN_BYTES`: measuring below the collection floor would drop unrouted calls out of the denominator while routed ones stayed in, and the ratio would flatter exactly where it should complain. |
| `CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY` | `10` | Cadence (in tool calls) at which the PreToolUse hook re-injects the "wrap large external-MCP payloads in `ctx_execute`" guidance. The original implementation ([#529](https://github.com/mksglu/context-mode/pull/529)) fired only once per session, which got lost after context compaction in MCP-heavy sessions (e.g. 50+ Jira/Slack/Notion calls — see [#567](https://github.com/mksglu/context-mode/issues/567) follow-up). The default re-fires every 10th matching call, keeping the guidance in the model's recent window. Range `[1, 100]`; invalid values fall back to `10`. Set to `1` for "every call" (most aggressive — adds ~250 tokens/call) or to a larger value for less frequent reminders. |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and TDD guidelines.

```bash
git clone https://github.com/OSDDQD/context-mode.git
cd context-mode && npm install && npm test
```

## License

Licensed under [Elastic License 2.0](LICENSE) (source-available). You can use it, fork it, modify it, and distribute it. Two things you can't do: offer it as a hosted/managed service, or remove the licensing notices. We chose ELv2 over MIT because MIT permits repackaging the code as a competing closed-source SaaS — ELv2 prevents that while keeping the source available to everyone.
