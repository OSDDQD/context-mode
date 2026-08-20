# Platform Support Matrix

This document provides a comprehensive comparison of all platforms supported by context-mode, including their hook paradigms, capabilities, configuration, and known limitations.

## Overview

context-mode supports one client platform:

| Paradigm | Platforms |
|----------|-----------|
| **JSON stdin/stdout** | Claude Code |

Fifteen further hosts were supported until 15a02cf and Codex CLI until v1.2.0
([ADR-0026](adr/0026-one-supported-host.md)). They are gone, and with them the
TS-plugin and MCP-only paradigms: what is left speaks JSON over stdin and
stdout, which is the paradigm the hooks were written against.

The MCP server layer is 100% portable and needs no adapter. Only the hook layer requires platform-specific adapters.

## Prerequisites

All platforms (except Claude Code plugin install) require a global install:

```bash
npm install -g context-mode
```

This puts the `context-mode` binary in PATH, which is required for:
- **MCP server:** `"command": "context-mode"` (replaces ephemeral `npx -y context-mode`)
- **Hook dispatcher:** `context-mode hook <platform> <event>` (replaces `node ./node_modules/...` paths)
- **Utility commands:** `context-mode doctor`, `context-mode upgrade`
- **Persistent upgrades:** `ctx-upgrade` updates the global binary in-place

---

## Main Comparison Table

| Feature | Claude Code |
| --- | --- |
| **Paradigm** | json-stdio |
| **PreToolUse equivalent** | `PreToolUse` |
| **PostToolUse equivalent** | `PostToolUse` |
| **PreCompact equivalent** | `PreCompact` |
| **SessionStart** | `SessionStart` |
| **Stop equivalent** | -- |
| **Can modify args** | Yes |
| **Can modify output** | Yes |
| **Can inject session context** | Yes |
| **Can block tools** | Yes |
| **Config location** | `~/.claude/settings.json` |
| **Session ID field** | `session_id` |
| **Project dir env** | `CLAUDE_PROJECT_DIR` |
| **MCP/tool naming** | `mcp__server__tool` |
| **Hook command format** | `context-mode hook claude-code <event>` |
| **Hook registration** | settings.json hooks object |
| **MCP server command** | `context-mode` (or plugin auto) |
| **Plugin distribution** | Claude plugin registry |
| **Session dir** | `~/.claude/context-mode/sessions/` |

### Legend

- Yes = Fully supported
- -- = Not supported
- (caveat) = Supported with known issues

---

## Platform Details

### Claude Code

**Status:** Fully supported (primary platform)

**Hook Paradigm:** JSON stdin/stdout

Claude Code is the primary platform for context-mode. All hooks communicate via JSON on stdin/stdout. The adapter reads raw JSON input, normalizes it into platform-agnostic events, and formats responses back into Claude Code's expected output format.

**Hook Names:**
- `PreToolUse` -- fires before a tool is executed
- `PostToolUse` -- fires after a tool completes
- `PreCompact` -- fires before context compaction
- `SessionStart` -- fires when a session starts, resumes, or compacts
- `UserPromptSubmit` -- fires when user submits a prompt
- `Stop` -- fires when the assistant turn is about to end

**Blocking:** `permissionDecision: "deny"` in response JSON

**Arg Modification:** `updatedInput` field at top level of response

**Output Modification:** `updatedMCPToolOutput` for MCP tools, `additionalContext` for appending

**Session ID Extraction Priority:**
1. UUID from `transcript_path` field
2. `session_id` field
3. `CLAUDE_SESSION_ID` environment variable
4. Parent process ID fallback

**Hook Commands:**
```
context-mode hook claude-code pretooluse
context-mode hook claude-code posttooluse
context-mode hook claude-code precompact
context-mode hook claude-code sessionstart
context-mode hook claude-code userpromptsubmit
```

**Known Issues:** None significant.

---

---

## Capability Matrix (Quick Reference)

| Capability | Claude Code |
| ----------- | :-----------: |
| PreToolUse | Yes |
| PostToolUse | Yes |
| PreCompact | Yes |
| SessionStart | Yes |
| Stop | -- |
| Modify Args | Yes |
| Modify Output | Yes |
| Inject Context | Yes |
| Block Tools | Yes |
| MCP/native tool support | Yes |

\*\*\* Codex CLI PreToolUse supports deny only (no `additionalContext`); context injection works via PostToolUse and SessionStart
\*\*\*\* Codex CLI PreCompact is runtime-gated on builds that emit the event

---

## Hook Response Format Comparison

### Blocking a Tool

| Platform | Response Format |
|----------|----------------|
| Claude Code | `{ "permissionDecision": "deny", "reason": "..." }` |

### Modifying Tool Input

| Platform | Response Format |
|----------|----------------|
| Claude Code | `{ "updatedInput": { ... } }` |

### Injecting Additional Context (PostToolUse)

| Platform | Response Format |
|----------|----------------|
| Claude Code | `{ "additionalContext": "..." }` |

---

## CLI Hook Dispatcher

All hook-based platforms use the CLI dispatcher pattern instead of direct `node` paths:

```
context-mode hook <platform> <event>
```

The dispatcher resolves the hook script relative to the installed package and dynamically imports it. Stdin/stdout flow through naturally since it runs in the same process.

**Advantages over `node ./node_modules/...` paths:**
- Works from any directory (no per-project `npm install` needed)
- Single global install serves all projects
- `context-mode upgrade` updates hooks in-place
- Short, portable command strings in settings files

**Supported dispatches:**

| Platform | Events |
|----------|--------|
| `claude-code` | `pretooluse`, `posttooluse`, `precompact`, `sessionstart`, `userpromptsubmit` |

Both platforms go through the same CLI dispatcher; there is no second wiring paradigm left to describe.

---

## SQLite Backend Selection

context-mode automatically selects the best SQLite backend at runtime based on the environment:

| Priority | Condition | Backend | Why |
|----------|-----------|---------|-----|
| 1 | Bun runtime | `bun:sqlite` | Built-in, no native addon |
| 2 | Linux + Node.js >= 22.5 | `node:sqlite` | Built-in, avoids [SIGSEGV from V8 madvise bug](https://github.com/nodejs/node/issues/62515) |
| 3 | All other environments | `better-sqlite3` | Mature native addon, prebuilt binaries |

**Why node:sqlite on Linux?** Node.js's V8 garbage collector can call `madvise(MADV_DONTNEED)` on memory ranges that overlap `better-sqlite3`'s native addon `.got.plt` section, corrupting resolved symbol addresses and causing sporadic SIGSEGV crashes (1-4/hour on Node v22-v24). `node:sqlite` is compiled into the Node.js binary itself — no separate `.node` file, no `dlopen()`, no `.got.plt` to corrupt.

**Fallback:** If `node:sqlite` is unavailable (Node < 22.5), context-mode silently falls back to `better-sqlite3`. No user configuration needed.

**Override:** Not currently supported — backend selection is automatic. If you need to force a specific backend, open an issue.

---

## Utility Commands

All platforms support utility commands via MCP meta-tools:

| Command | What it does |
|---------|-------------|
| `ctx stats` | Show context savings, call counts, and session statistics |
| `ctx doctor` | Diagnose installation: runtimes, hooks, FTS5, versions |
| `ctx upgrade` | Update from GitHub, rebuild, reconfigure hooks |
| `ctx purge` | Permanently deletes all indexed content from the knowledge base |

**How they work:** The MCP server exposes `stats`, `doctor`, `upgrade`, and `purge` tools. The `<ctx_commands>` section in routing instructions (CLAUDE.md, AGENTS.md) maps natural language triggers to MCP tool calls. The `doctor` and `upgrade` tools return shell commands that the LLM executes and formats as a checklist. The `purge` tool permanently deletes all indexed content from the knowledge base and is the sole reset mechanism.
