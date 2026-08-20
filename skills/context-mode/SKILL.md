---
name: context-mode
description: |
  Use context-mode tools (ctx_execute, ctx_execute_file, ctx_batch_execute) instead of
  Bash/cat/Read when processing, analyzing, filtering, or summarizing data that may
  exceed ~20 lines: logs, test/build output, git history, JSON/API responses, browser
  or Playwright snapshots, dependency trees, docs fetches, codebase statistics.
  Also use ctx_find instead of Glob+Grep to locate where something lives in a project,
  and ctx_graph instead of reading files to answer structural questions (who calls a
  symbol, what breaks if it changes, what a file declares).
  Also triggers on ANY MCP tool output that may exceed 20 lines.
---

# Context Mode: Default for All Large Output

## The rule

Default to context-mode for **all** commands. Use Bash only where the output is
guaranteed small: file mutations (`mkdir`, `mv`, `cp`, `rm`, `touch`, `chmod`), git
writes (`git add|commit|push|checkout|branch|merge`), navigation (`cd`, `pwd`, `which`),
process control (`kill`, `pkill`), package installs (`npm|pip install`), `echo`/`printf`.

Everything else goes through `ctx_execute` / `ctx_execute_file` — anything that reads,
queries, fetches, lists, logs, tests, builds, diffs, inspects or calls an external
service, every CLI included (gh, aws, kubectl, docker, terraform, …). **When uncertain,
use context-mode.** Every KB of needless context costs the whole session.

## Pick the tool

| You are about to | Use |
|---|---|
| Run a command, hit an API, run tests | `ctx_execute` |
| Read a file to analyze, not to edit | `ctx_execute_file` (arrives as `FILE_CONTENT`) |
| Fetch web docs or an HTML page | `ctx_fetch_and_index` → `ctx_search` |
| Take a Playwright snapshot / big MCP output | the tool's `filename` param → `ctx_index(path:)` or `ctx_execute_file(path:)` |
| Find where something lives | `ctx_find` |
| Ask how code is connected | `ctx_graph` |
| Ask what we already captured | `ctx_search` |

Three retrieval tools, three questions. `ctx_find` — where it lives (file names, grep,
FTS5, vectors, codegraph fused into one ranked list; replaces Glob + Grep + `ctx_search`).
`ctx_graph` — how it is connected (`symbols|outline|callers|callees|impact|related|
explore`; needs `codegraph init` once). `ctx_search` — what we already captured (FTS5).

## Critical rules

1. **Always `console.log` / `print` your findings.** stdout is all that enters context; no output = wasted call.
2. **Analyze, don't dump.** Not `console.log(JSON.stringify(data))` — print conclusions.
3. **Be specific.** IDs, line numbers, exact values — not just counts.
4. **Files you will EDIT** → plain `Read`. context-mode is for analysis.
5. **Bash only for the whitelist above**; everything else through context-mode.
6. **Never `ctx_index(content: <large data>)`** — use `ctx_index(path: ...)`, read server-side; `content` is for small inline text only.
7. **Always pass `filename`** to `browser_snapshot` / `browser_console_messages` / `browser_network_requests` — else the output floods context.
8. **Don't re-index data already in context** — use it directly, or save it to a file first.
9. **Batch searches**: every question in ONE `ctx_search(queries: [...])` call, scoped with `source:`.

Subagents get this routing automatically via a PreToolUse hook — write natural task
descriptions, no tool names.

## References (load on demand)

- `references/command-routing.md` — decision tree, Bash whitelist, tool-by-situation table, trigger phrases, language choice.
- `references/retrieval-and-search.md` — the three retrieval tools in depth, BM25 query strategy, `source` scoping, external docs.
- `references/browser-and-mcp-output.md` — Playwright / large MCP payloads: file → server-side read, workflows A–C, cost table.
- `references/starter-examples.md` — API debugging, test output, `gh pr list`, large-file analysis.
- `references/patterns-javascript.md`, `-python.md`, `-shell.md` — per-language recipes.
- `references/anti-patterns.md` — habits that flood context, plus the routing anti-pattern list (§9).
