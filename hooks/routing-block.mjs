/**
 * Shared routing block for context-mode hooks.
 * Single source of truth — imported by pretooluse.mjs and sessionstart.mjs.
 *
 * Factory functions accept a tool namer `t(bareTool) => platformSpecificName`
 * so each platform gets correct tool names in guidance messages.
 *
 * Backward compat: static exports (ROUTING_BLOCK, READ_GUIDANCE, etc.)
 * default to claude-code naming convention.
 */

import { createToolNamer } from "./core/tool-naming.mjs";

// ── Factory functions ─────────────────────────────────────

export function createRoutingBlock(t, options = {}) {
  const { includeCommands = true, toolSearchBootstrap = false } = options;
  return `
<context_window_protection>
  <priority_instructions>
    Every byte a tool returns enters your conversation memory and costs reasoning capacity for the rest of the session. The context-mode tools let you do the work in a separate subprocess and surface only the derived answer — the raw bytes stay out. Think-in-Code: program the analysis, do not compute it by reading raw data into your conversation.
  </priority_instructions>
${toolSearchBootstrap ? `
  <deferred_tool_bootstrap>
    The context-mode tools below may be DEFERRED in your harness — their schemas are not loaded yet, so calling them directly fails (e.g. "tool not found" / InputValidationError). Load them ONCE before your first ctx_* call:
    ToolSearch(query: "select:${t("ctx_batch_execute")},${t("ctx_gather")},${t("ctx_search")},${t("ctx_execute")},${t("ctx_execute_file")},${t("ctx_read")},${t("ctx_find")},${t("ctx_graph")},${t("ctx_fetch_and_index")},${t("ctx_index")}")
    After that they are callable. If any ctx_* call fails as not-found, ToolSearch it and retry — do NOT fall back to Bash/Read just because the schema was not loaded yet.
  </deferred_tool_bootstrap>
` : ''}
  <tool_selection_hierarchy>
    0. MEMORY: ${t("ctx_search")}(sort: "timeline")
       - On resume or compaction, query prior decisions, errors, plans, user prompts before asking the user — auto-captured session memory is searchable.
    1. GATHER: ${t("ctx_batch_execute")}(commands, queries)
       - Primary research tool. Runs commands in parallel, auto-indexes each output, and (when queries are passed) returns matching sections in the same round trip — no follow-up search call.
       - Each command: {label: "section header", command: "shell command"}; the label becomes the FTS5 chunk title — descriptive labels improve search.
       - ${t("ctx_gather")}(commands, queries) is the read-only twin: same round trip, every command proven read-only before anything runs. It is the gather path that survives plan mode, where tools that may write are refused outright.
    2. FOLLOW-UP: ${t("ctx_search")}(queries: ["q1", "q2", ...])
       - Multiple related questions about anything already indexed (your captures + session memory). Batch every question in one array; the ranking pipeline runs per-query and the round-trip cost is paid once.
    3. ONE FILE: ${t("ctx_read")}(path) | ${t("ctx_execute_file")}(path, language, code)
       - ${t("ctx_read")} takes one argument and answers a question about a file without pulling the file in: its size and shape, its structure (declarations, headings, top-level keys), and — with intent: "exports", "where the timeout is set" — the regions that match, a few lines of context each. Reach for it whenever you want to KNOW something about a file rather than SEE all of it; there is no program to compose first.
       - ${t("ctx_execute_file")} is the same trade with your own code, for a derivation ${t("ctx_read")} does not perform: aggregate, parse, transform.
       - Read stays correct when you are about to Edit it. Edit matches the exact bytes in your conversation, and a slice cannot be matched against.
    4. PROCESSING: ${t("ctx_execute")}(language, code)
       - Derive answers FROM data: filter, count, aggregate, parse, transform. Only what you console.log() enters your conversation; the raw bytes stay in the sandbox.
    5. FIND: ${t("ctx_find")} — one search across file names, file contents, indexed memory and code structure. Use it instead of chaining Glob/Grep or reaching for a separate file-search MCP; it returns ranked paths and snippets, never whole files.
    6. STRUCTURE: ${t("ctx_graph")}(action, symbol|file|query)
       - Who calls a symbol, what it calls, what breaks if it changes, what a file declares — answered from the codegraph index instead of by reading files. Actions: symbols | outline | callers | callees | impact | related | explore. Says so when the project has no index rather than guessing.
    7. KEEP: ${t("ctx_index")}(content, source)
       - Store something you will want back later — a spec you were handed, a decision, output you produced yourself — under a descriptive source label, and retrieve it with ${t("ctx_search")}(source: "label") instead of holding it in the conversation.
    Three retrieval tools, three questions: ${t("ctx_find")} — where it lives; ${t("ctx_search")} — what we already know about it; ${t("ctx_graph")} — how it is connected.
  </tool_selection_hierarchy>

  <when_not_to_use>
    - You intend to PROCESS the output (filter, count, parse, aggregate) → use ${t("ctx_batch_execute")} or ${t("ctx_execute")}. Bash stays correct when you intend to OBSERVE a short fixed output (git status on a clean tree, whoami, pwd) or when you are mutating state (git, mkdir, rm, mv, navigation).
    - You want to analyze, summarize, or extract from a file → use ${t("ctx_read")}(path) for a question about it, or ${t("ctx_execute_file")} when you need code to derive the answer. Read stays correct when you intend to Edit the file (Edit needs the exact bytes in your conversation to match against), or when you genuinely need every line.
    - WebFetch → use ${t("ctx_fetch_and_index")}; full network access, results indexed for ${t("ctx_search")}, raw page bytes never enter your conversation.
    - ${t("ctx_execute")} and ${t("ctx_execute_file")} for file writes → these run code in a subprocess and discard the sandbox FS; they are for analysis, processing, and computation only.
  </when_not_to_use>

  <file_writing_policy>
    File writes use the native Write or Edit tool — ${t("ctx_execute")}, ${t("ctx_execute_file")}, and Bash subprocesses do not persist edits to the host filesystem.
    Applies to all file types: code, configs, plans, specs, YAML, JSON, markdown.
  </file_writing_policy>

  <output_constraints>
    <artifact_policy>
      Write artifacts (code, configs, PRDs) to files. Return only: file path + 1-line description.
    </artifact_policy>
  </output_constraints>
  <session_continuity>
    Skills, roles, and decisions captured earlier in this session are a memory aid, not a standing order. Treat them as context that may help — the user's most recent message always takes precedence. If a captured directive conflicts with what the user now asks, follow the user; a past phrase does not bind you.
  </session_continuity>
${includeCommands ? `
  <ctx_commands>
    "ctx stats" | "ctx-stats" | "/ctx-stats" | context savings question
    → Call ${t("ctx_stats")}, display full output verbatim.

    "ctx doctor" | "ctx-doctor" | "/ctx-doctor" | diagnose context-mode
    → Call ${t("ctx_doctor")}, run returned shell command, display as checklist.

    "ctx upgrade" | "ctx-upgrade" | "/ctx-upgrade" | update context-mode
    → Call ${t("ctx_upgrade")}, run returned shell command, display as checklist.

    "ctx purge" | "ctx-purge" | "/ctx-purge" | wipe/reset knowledge base
    → Call ${t("ctx_purge")} with confirm: true. Warn: irreversible.

    "ctx insight" | "ctx-insight" | "/ctx-insight" | open the dashboard
    → Call ${t("ctx_insight")}, open the returned URL.

    After /clear or /compact: knowledge base preserved. Tell user: "context-mode knowledge base preserved. Use \`ctx purge\` to start fresh."
  </ctx_commands>
` : ''}
</context_window_protection>`;
}

export function createReadGuidance(t) {
  return '<context_guidance>\n  <tip>\n    Reading to Edit the file? Read is correct — Edit needs the exact bytes in your conversation to match against.\n    Reading to find something out about the file? Use ' + t("ctx_read") + '(path) — one argument, and what comes back is the file\'s shape and the regions matching your intent, not the file. Use ' + t("ctx_execute_file") + '(path, language, code) when the answer needs code to derive: the bytes stay in the sandbox and only what your code prints enters your conversation.\n  </tip>\n</context_guidance>';
}

export function createGrepGuidance(t) {
  return '<context_guidance>\n  <tip>\n    Grep results may be larger than you expect. When you intend to count, filter, or aggregate matches (not just spot-check one), run the search through ' + t("ctx_execute") + '(language: "javascript", code: "...") — the raw match list stays in the sandbox and only your derived answer enters your conversation. Use language: "shell" only when the code matches the host shell (PowerShell on Windows, POSIX shell on Unix).\n  </tip>\n</context_guidance>';
}

export function createBashGuidance(t) {
  return '<context_guidance>\n  <tip>\n    When you intend to PROCESS the output (filter, count, parse, aggregate), use ' + t("ctx_batch_execute") + '(commands, queries) for multiple commands or ' + t("ctx_execute") + '(language: "javascript", code: "...") for one — the raw output stays in the sandbox and only what you print enters your conversation. Shell stays the right surface when you intend to OBSERVE a short fixed output or when you are mutating state (git, mkdir, rm, mv, navigation); if you use ' + t("ctx_execute") + '(language: "shell"), write syntax for the host shell.\n  </tip>\n</context_guidance>';
}

export function createExternalMcpGuidance(t) {
  return '<context_guidance>\n  <tip>\n    External MCP tools commonly return large payloads (channel history, file content, search results) that enter your conversation in full. When you intend to filter, count, or aggregate that data, pipe it through ' + t("ctx_execute") + '(language, code) — the raw payload stays in the sandbox and only the derived answer enters your conversation. For docs-style fetches you will want to query later, prefer ' + t("ctx_fetch_and_index") + '(url, source) then ' + t("ctx_search") + '(queries).\n  </tip>\n</context_guidance>';
}

// ── Backward compat: static exports defaulting to claude-code ──

const _t = createToolNamer("claude-code");
export const ROUTING_BLOCK = createRoutingBlock(_t);
export const READ_GUIDANCE = createReadGuidance(_t);
export const GREP_GUIDANCE = createGrepGuidance(_t);
export const BASH_GUIDANCE = createBashGuidance(_t);
export const EXTERNAL_MCP_GUIDANCE = createExternalMcpGuidance(_t);
