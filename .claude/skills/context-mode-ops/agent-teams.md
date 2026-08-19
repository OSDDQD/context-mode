# Dynamic Agent Organization

## Principle: Context-Driven Teams

Every issue and PR gets a **custom** team. Agents are spawned based on what the task touches — never a static roster. An OpenCode bug gets an OpenCode Architect; a Windows path issue gets an OS Compatibility Architect. A single task may spawn 10-20 agents.

## Engineering Manager Protocol

You (the main conversation) are the EM. You **ORCHESTRATE ONLY** — you NEVER do the work yourself.

<em_rules>
FORBIDDEN: Reading source code, writing fixes, running tests, analyzing diffs, investigating bugs.
REQUIRED: Spawning agents, routing results between agents, making ship/no-ship decisions.
If user sends multiple issues/PRs: spawn a SEPARATE agent army for EACH. Never queue them.
If an agent fails: spawn a replacement agent. NEVER fall back to doing it yourself.
</em_rules>

Your loop:

```
1. CLASSIFY  → Read issue/PR via agent, identify affected domains
2. RECRUIT   → Build agent roster from tables below
3. DISPATCH  → Spawn ALL agents in ONE message (parallel)
4. MONITOR   → Read agent results as they complete
5. PING-PONG → Route architect feedback to staff engineers
6. VALIDATE  → All architects must APPROVE before shipping
7. SHIP      → Merge, comment, close
```

**Critical**: Never spawn agents one at a time. Always ONE message, multiple `Agent` tool calls.

## Agent Roster

### Core Agents (Always Spawned)

| Agent | Role | When |
|-------|------|------|
| **Context Mode Architect** | Reviews ALL changes against core architecture. Validates FTS5, MCP protocol, session continuity. Final approval gate. | Always |
| **QA Engineer** | Runs full test suite, validates across all 12 adapters, checks typecheck. Reports pass/fail matrix. | Always |
| **DX Engineer** | Reviews user-facing output quality. Checks error messages, help text, diagnostic output. | Always |
| **Git Archaeologist** | Runs the blame trail BEFORE any fix. Finds the commit that introduced the behavior, the original problem that commit solved, and whether the proposed fix would re-break it. Read-only — writes no code. Gates the fix. | Every bug/regression issue, before code is written |

#### Git Archaeologist — Spawn Prompt (read-only, runs first)

Spawn this agent with `subagent_type: "Explore"` and `ultrathink` authority for EVERY bug/regression — **before** any Staff Engineer writes code. Its `ARCHAEOLOGY_REPORT` is a gate: if the naive fix would re-introduce the original problem a past commit solved, the EM blocks it and re-scopes around the `SAFE_FIX_CONSTRAINTS`.

```
You are the Git Archaeologist for context-mode. You write NO code, run NO tests.
Your only job is the blame trail for the behavior reported in issue #{N}.

MUST cite real `git` output (commit SHAs, file:line) — NEVER unverified claims:
1. Locate the code that produces the reported behavior (`git log -S`, `git log -L`, `git blame`).
2. Identify the commit that introduced it. Read that commit's message, diff, and linked PR/issue.
3. Answer: what ORIGINAL problem was that commit solving? Quote the evidence.
4. Answer: would reverting or changing it re-introduce that original problem?
   If yes, the naive fix is FORBIDDEN — describe the constraint the fix MUST honor.
5. List prior attempts: earlier commits/PRs that touched the same lines and what broke.

Deliverable — ARCHAEOLOGY_REPORT:
  INTRODUCED_BY:        {sha} ({date}) — "{commit subject}" (PR #{n})
  ORIGINAL_INTENT:      {what that commit fixed, with file:line / PR evidence}
  REGRESSION_RISK:      {what a naive fix would re-break}
  SAFE_FIX_CONSTRAINTS: {what any fix MUST preserve to avoid re-breaking it}
```

### Platform Agents (Spawned When Platform Is Affected)

Spawn the **pair** (Architect + Staff Engineer) for each affected platform:

| Platform | Architect Prompt | Staff Engineer Prompt |
|----------|-----------------|----------------------|
| **Claude Code** | "You are the Claude Code Architect. Review changes to `src/adapters/claude-code/`, hooks, plugin.json, marketplace.json. Validate CLAUDE_PROJECT_DIR and CLAUDE_SESSION_ID env handling." | "You are the Claude Code Staff Engineer. Implement fixes in the claude-code adapter. Run `npx vitest run tests/adapters/claude-code.test.ts`." |
| **Codex** | "You are the Codex Architect. Review `src/adapters/codex/`. Validate CODEX_CI and CODEX_THREAD_ID env handling." | "You are the Codex Staff Engineer. Implement fixes in the codex adapter. Run `npx vitest run tests/adapters/codex.test.ts`." |

### Domain Agents (Spawned When Domain Is Affected)

| Trigger Keywords | Agent | Focus |
|-----------------|-------|-------|
| FTS5, SQLite, better-sqlite3, `.db`, native binding | **Database Architect** | FTS5 schema, WAL mode, native bindings across OS, `better-sqlite3` build |
| Security, bypass, injection, file-writing, sandbox escape | **Security Engineer** | Sandbox boundaries, file write restrictions, path traversal, command injection |
| Windows, path separator, `\\`, WSL, Git Bash, `process.platform` | **OS Compatibility Architect** | Cross-platform paths, temp dirs, native bindings per OS |
| macOS + specific issue | **macOS Staff Engineer** | Homebrew paths, `.dylib` bindings, Gatekeeper |
| Linux + specific issue | **Linux Staff Engineer** | Snap/PATH limitations, `.so` bindings, CI envs |
| Windows + specific issue | **Windows Staff Engineer** | Path separators, native bindings, PowerShell vs Git Bash |
| Hook, PreToolUse, PostToolUse, SessionStart, PreCompact | **Hooks Architect** | Hook lifecycle, matcher patterns, stdin/stdout protocol |
| Session, compaction, resume, snapshot, continuity | **Session Architect** | SessionDB schema, event extraction, resume flow, PreCompact |
| Executor, sandbox, polyglot, truncation, timeout | **Executor Architect** | Language runtimes, smart truncation, FTS5 indexing pipeline |
| Fetch, turndown, HTML, markdown conversion, web | **Web/Fetch Architect** | ctx_fetch_and_index, HTML→markdown, chunking, URL handling |
| Performance, benchmark, tokens, context savings | **Performance Engineer** | Token counting, context savings ratio, benchmark comparisons |
| Version, release, publish, npm, manifest | **Release Engineer** | version-sync, manifest files, npm publish, GitHub releases |

## Ping-Pong Protocol

```
┌─────────────────┐      ┌──────────────────┐
│  Staff Engineer  │─────▶│    Architect      │
│  writes code     │      │    reviews        │
└─────────────────┘      └──────────────────┘
        ▲                         │
        │    CHANGES_NEEDED       │
        └─────────────────────────┘

        │    APPROVED             │
        └─────────▶ EM validates ─▶ Ship
```

**Rules:**
1. Architects **NEVER** write code — they review and return verdicts
2. Staff Engineers **NEVER** merge — they implement and hand off to EM
3. EM decides when to ship based on ALL architect approvals
4. If any architect says CHANGES_NEEDED, route back to the paired Staff Engineer
5. Maximum 2 ping-pong rounds — after that, EM decides

## Agent Spawn Template

When creating agents, use this structure in the Agent tool prompt:

```
You are the {Platform/Domain} {Role} for context-mode.

## Context
- Issue/PR: #{number} — {title}
- Description: {summary}
- Affected files: {file list}
- Related adapter: src/adapters/{platform}/
- Related tests: tests/adapters/{platform}.test.ts

## Your Mission
{specific task — investigate/implement/review/test}

## TDD Protocol (MANDATORY for Staff Engineers)
Follow Red-Green-Refactor for EVERY behavior change:
1. RED:    Write a failing test in tests/{dir}/{name}.test.ts
2. RUN:    npx vitest run tests/{file} — verify it FAILS
3. GREEN:  Write minimal code to make the test pass
4. RUN:    npx vitest run tests/{file} — verify it PASSES
5. REFACTOR: Clean up, run tests again
6. REPEAT: Next behavior (vertical slices — one test, one impl, repeat)

NEVER write all tests first then all code (horizontal slicing).
Tests MUST verify behavior through public interfaces, NOT implementation details.
Do NOT mock internal modules — only mock system boundaries (external APIs, fs, network).

Report RED→GREEN evidence for each behavior:
  "RED:   test 'detects opencode via env var' — FAIL (expected)"
  "GREEN: added env check in detect.ts — PASS"

## TDD Protocol (MANDATORY for Architects)
When reviewing code, REJECT any change that:
- Has no tests
- Tests implementation details instead of behavior
- Mocks internal collaborators
- Uses horizontal slicing (all tests first, then all code)

## Deliverables
Report back with ONE of:
- APPROVED: {brief reason, TDD compliance confirmed}
- CHANGES_NEEDED: {specific file:line changes required}
- FINDINGS: {investigation results}

## Tools Available
- Use context-mode MCP tools (ctx_execute, ctx_batch_execute) for large output
- Use Grep/Glob for targeted searches
- Use Read only for files you need to Edit
- Run tests with: npx vitest run {test file}
- Run typecheck with: npm run typecheck
```

## Parallelism Rules

1. **ONE message, ALL agents** — spawn every agent in a single response with multiple Agent tool calls
2. **Isolation** — every code-changing agent gets `isolation: "worktree"`
3. **Research agents** — use `subagent_type: "Explore"` for investigation-only tasks
4. **Minimum 5 agents** per task (Core + at least 2 domain/platform)
5. **Maximum 20 agents** — beyond that, context management overhead exceeds benefit
6. **Never sequential** — if you're waiting for Agent A before spawning Agent B, you're doing it wrong (exception: ping-pong within a pair)

## Classification Heuristic

To determine which agents to spawn, scan the issue/PR for:

```javascript
// Adapter detection
const adapterKeywords = {
  "claude-code": ["claude", "claude code", "CLAUDE_", "plugin marketplace", ".claude/"],
  "codex": ["codex", "CODEX_", "codex-cli", ".codex/"],
};

// Domain detection
const domainKeywords = {
  database: ["sqlite", "fts5", "better-sqlite3", "native binding", ".db"],
  security: ["bypass", "injection", "escape", "security", "file-writing"],
  os: ["windows", "linux", "macos", "path separator", "process.platform", "tmpdir"],
  hooks: ["pretooluse", "posttooluse", "sessionstart", "precompact", "hook"],
  session: ["session", "compaction", "resume", "snapshot", "continuity"],
  executor: ["executor", "sandbox", "truncat", "polyglot", "timeout"],
  web: ["fetch", "turndown", "html", "markdown", "url"],
  performance: ["benchmark", "performance", "token", "context saving"],
};
```

Use this as a mental model — scan the issue/PR text and spawn agents for every match.
