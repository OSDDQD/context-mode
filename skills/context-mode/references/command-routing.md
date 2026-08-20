# Command Routing: Bash vs context-mode

The full routing surface. The SKILL body carries the one-line rule; this file is
the tree, the per-situation table, the trigger phrases and the language choice.

---

## Mandatory rule

<context_mode_logic>
  <mandatory_rule>
    Default to context-mode for ALL commands. Only use Bash for guaranteed-small-output operations.
  </mandatory_rule>
</context_mode_logic>

---

## Bash whitelist (safe to run directly)

- **File mutations**: `mkdir`, `mv`, `cp`, `rm`, `touch`, `chmod`
- **Git writes**: `git add`, `git commit`, `git push`, `git checkout`, `git branch`, `git merge`
- **Navigation**: `cd`, `pwd`, `which`
- **Process control**: `kill`, `pkill`
- **Package management**: `npm install`, `npm publish`, `pip install`
- **Simple output**: `echo`, `printf`

**Everything else → `ctx_execute` or `ctx_execute_file`.** Any command that reads, queries, fetches, lists, logs, tests, builds, diffs, inspects, or calls an external service. This includes ALL CLIs (gh, aws, kubectl, docker, terraform, wrangler, fly, heroku, gcloud, etc.) — there are thousands and we cannot list them all.

**When uncertain, use context-mode.** Every KB of unnecessary context reduces the quality and speed of the entire session.

---

## Decision tree

```
About to run a command / read a file / call an API?
│
├── Command is on the Bash whitelist (file mutations, git writes, navigation, echo)?
│   └── Use Bash
│
├── Output MIGHT be large or you're UNSURE?
│   └── Use context-mode ctx_execute or ctx_execute_file
│
├── Fetching web documentation or HTML page?
│   └── Use ctx_fetch_and_index → ctx_search
│
├── Using Playwright (navigate, snapshot, console, network)?
│   └── ALWAYS use filename parameter to save to file, then:
│       browser_snapshot(filename) → ctx_index(path) or ctx_execute_file(path)
│       browser_console_messages(filename) → ctx_execute_file(path)
│       browser_network_requests(filename) → ctx_execute_file(path)
│       ⚠ browser_navigate returns a snapshot automatically — ignore it,
│         use browser_snapshot(filename) for any inspection.
│       ⚠ Playwright MCP uses a SINGLE browser instance — NOT parallel-safe.
│         For parallel browser ops, use agent-browser via execute instead.
│
├── Using agent-browser (parallel-safe browser automation)?
│   └── Run via execute (shell) — each call gets its own subprocess:
│       execute("agent-browser open example.com && agent-browser snapshot -i -c")
│       ✓ Supports sessions for isolated browser instances
│       ✓ Safe for parallel subagent execution
│       ✓ Lightweight accessibility tree with ref-based interaction
│
├── Processing output from another MCP tool (Context7, GitHub API, etc.)?
│   ├── Output already in context from a previous tool call?
│   │   └── Use it directly. Do NOT re-index with ctx_index(content: ...).
│   ├── Need to search the output multiple times?
│   │   └── Save to file via ctx_execute, then ctx_index(path) → ctx_search
│   └── One-shot extraction?
│       └── Save to file via ctx_execute, then ctx_execute_file(path)
│
└── Reading a file to analyze/summarize (not edit)?
    └── Use ctx_execute_file (file loads into FILE_CONTENT, not context)
```

---

## When to use each tool

| Situation | Tool | Example |
|-----------|------|---------|
| Hit an API endpoint | `ctx_execute` | `fetch('http://localhost:3000/api/orders')` |
| Run CLI that returns data | `ctx_execute` | `gh pr list`, `aws s3 ls`, `kubectl get pods` |
| Run tests | `ctx_execute` | `npm test`, `pytest`, `go test ./...` |
| Git operations | `ctx_execute` | `git log --oneline -50`, `git diff HEAD~5` |
| Docker/K8s inspection | `ctx_execute` | `docker stats --no-stream`, `kubectl describe pod` |
| Read a log file | `ctx_execute_file` | Parse access.log, error.log, build output |
| Read a data file | `ctx_execute_file` | Analyze CSV, JSON, YAML, XML |
| Read source code to analyze | `ctx_execute_file` | Count functions, find patterns, extract metrics |
| Fetch web docs | `ctx_fetch_and_index` | Index React/Next.js/Zod docs, then search |
| Playwright snapshot | `browser_snapshot(filename)` → `ctx_index(path)` → `ctx_search` | Save to file, index server-side, query |
| Playwright snapshot (one-shot) | `browser_snapshot(filename)` → `ctx_execute_file(path)` | Save to file, extract in sandbox |
| Playwright console/network | `browser_*(filename)` → `ctx_execute_file(path)` | Save to file, analyze in sandbox |
| MCP output (already in context) | Use directly | Don't re-index — it's already loaded |
| MCP output (need multi-query) | `ctx_execute` to save → `ctx_index(path)` → `ctx_search` | Save to file first, index server-side |
| Wipe indexed KB content | `ctx_purge(confirm: true)` | Permanently deletes all indexed content |
| Locate a file or symbol | `ctx_find` | "where does the session DB path get built?" |
| Structural question about code | `ctx_graph` | "who calls `ContentStore.index`?" |

---

## Automatic triggers

Use context-mode for ANY of these, without being asked:

- **API debugging**: "hit this endpoint", "call the API", "check the response", "find the bug in the response"
- **Log analysis**: "check the logs", "what errors", "read access.log", "debug the 500s"
- **Test runs**: "run the tests", "check if tests pass", "test suite output"
- **Git history**: "show recent commits", "git log", "what changed", "diff between branches"
- **Data inspection**: "look at the CSV", "parse the JSON", "analyze the config"
- **Infrastructure**: "list containers", "check pods", "S3 buckets", "show running services"
- **Dependency audit**: "check dependencies", "outdated packages", "security audit"
- **Build output**: "build the project", "check for warnings", "compile errors"
- **Code metrics**: "count lines", "find TODOs", "function count", "analyze codebase"
- **Web docs lookup**: "look up the docs", "check the API reference", "find examples"
- **Locating code** (`ctx_find`): "where is X handled", "which file does Y", "find the config for Z"
- **Structural questions** (`ctx_graph`): "who calls this", "what does this call", "what breaks if I change it", "what's in this file"

---

## Language selection

| Situation | Language | Why |
|-----------|----------|-----|
| HTTP/API calls, JSON | `javascript` | Native fetch, JSON.parse, async/await |
| Data analysis, CSV, stats | `python` | csv, statistics, collections, re |
| Shell commands with pipes | `shell` | grep, awk, jq, native tools |
| File pattern matching | `shell` | find, wc, sort, uniq |

Per-language recipes live in `patterns-javascript.md`, `patterns-python.md` and `patterns-shell.md`.

---

## Subagent usage

Subagents automatically receive context-mode tool routing via a PreToolUse hook. You do NOT need to manually add tool names to subagent prompts — the hook injects them. Just write natural task descriptions.
