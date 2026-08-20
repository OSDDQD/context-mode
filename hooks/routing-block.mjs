/**
 * Shared routing block for context-mode hooks.
 * Single source of truth — imported by pretooluse.mjs and sessionstart.mjs.
 *
 * Factory functions accept a tool namer `t(bareTool) => platformSpecificName`
 * so each platform gets correct tool names in guidance messages.
 *
 * ── Two texts, one set of rules ────────────────────────────────────────────
 *
 * A plugin whose whole job is keeping bytes out of the context window was
 * spending 8.5 KB of it on SessionStart and another 7.5 KB in the prompt of
 * every subagent — ~50 KB in a session with five of them. The trade the tool
 * descriptions already made (`COMPACT_TOOL_DESCRIPTIONS` in `src/server.ts`,
 * −73%) is made here too: the authored prose stays as the reference text,
 * what ships is a dense route table.
 *
 *   createRoutingBlock(t, opts)          → what SessionStart injects
 *   createSubagentRoutingBlock(t, opts)  → what the Agent PreToolUse injects
 *
 * The two are not the same text. A subagent has no session to resume, cannot
 * run the operator commands (#233), and hands its answer to a parent whose
 * context pays for every word — so it gets the route table, the exclusions and
 * a report policy, and none of the memory/commands prose.
 *
 * Both are compact by default; `CONTEXT_MODE_ROUTING_BLOCK=full` restores the
 * authored version of each (`createVerboseRoutingBlock`), which is kept intact
 * so the compact table has something to be checked against.
 *
 * Compaction may drop rationale, examples and second explanations of the same
 * rule. It may not drop a rule: every redirect the PreToolUse hook enforces
 * (curl/wget, inline HTTP, WebFetch, Bash, Read, Grep), the selection ladder,
 * the concurrency guidance and the Read-before-Edit concession must still be
 * derivable from the compact text. `tests/hooks/routing-block-size.test.ts`
 * holds the byte ceilings and those signals; `routing-block-tool-coverage.test.ts`
 * holds the rule that every registered tool is named.
 *
 * Backward compat: static exports (ROUTING_BLOCK, READ_GUIDANCE, etc.)
 * default to claude-code naming convention.
 */

import { createToolNamer } from "./core/tool-naming.mjs";

/**
 * Tools whose deferred schemas the bootstrap preloads — everything a session
 * or a subagent may be told to call, minus the operator commands (a subagent
 * has no user to run `ctx doctor` for; a session asks for them by name).
 */
const BOOTSTRAP_TOOLS = [
  "ctx_batch_execute", "ctx_gather", "ctx_search", "ctx_execute", "ctx_execute_file",
  "ctx_read", "ctx_find", "ctx_graph", "ctx_fetch_and_index", "ctx_index",
];

// ctx_pack is named in the session block but deliberately absent here. One
// name costs 47 bytes at the Claude Code prefix, this list is shared by both
// blocks, and the subagent block sits 45 bytes under its 1 800-byte ceiling —
// adding it breaks that ceiling to preload a schema the subagent block never
// tells a subagent to call. The not-found path is already covered: the same
// line says to load it and retry rather than fall back to Bash/Read.

/** `compact` (default) or `full` — the operator's escape hatch back to prose. */
function routingBlockMode() {
  return String(process.env.CONTEXT_MODE_ROUTING_BLOCK ?? "").trim().toLowerCase() === "full"
    ? "full"
    : "compact";
}

/** The host's MCP prefix, derived from the namer ("" on hosts that don't prefix). */
function toolPrefix(t) {
  const named = t("ctx_find");
  return named.endsWith("ctx_find") ? named.slice(0, named.length - "ctx_find".length) : "";
}

// ── Factory functions ─────────────────────────────────────

/**
 * The block SessionStart injects. Compact by default; the authored prose under
 * CONTEXT_MODE_ROUTING_BLOCK=full.
 */
export function createRoutingBlock(t, options = {}) {
  return routingBlockMode() === "full"
    ? createVerboseRoutingBlock(t, options)
    : createCompactRoutingBlock(t, options);
}

/**
 * The block injected into a subagent's prompt — the routing rules only, plus
 * the policy on what it hands back.
 */
export function createSubagentRoutingBlock(t, options = {}) {
  return routingBlockMode() === "full"
    ? createVerboseRoutingBlock(t, { ...options, includeCommands: false })
    : createCompactSubagentBlock(t, options);
}

/**
 * The dense table SessionStart ships. Ceiling: 3 KB including the bootstrap.
 *
 * Tool names are written bare and the host's prefix is declared once, with one
 * name spelled in full as the pattern. On Claude Code the prefix is 39
 * characters and the block names sixteen tools: spelling each in full costs
 * ~600 bytes — a fifth of the budget — for a string the model has already read
 * in the bootstrap line and in its own tool list.
 */
export function createCompactRoutingBlock(t, options = {}) {
  const { includeCommands = true, toolSearchBootstrap = false } = options;
  const boot = toolSearchBootstrap
    ? `  Deferred schemas — load once, call by these exact names: ToolSearch(query: "select:${BOOTSTRAP_TOOLS.map(t).join(",")}"). Not-found means load it and retry; do NOT fall back to Bash/Read.
`
    : "";
  const commands = includeCommands
    ? `  <ctx_commands>
    "ctx stats"→ctx_stats verbatim; "ctx doctor"→ctx_doctor; "ctx upgrade"→ctx_upgrade (run the shell command each returns, show as a checklist); "ctx purge"→ctx_purge(confirm: true), irreversible; "ctx insight"→ctx_insight, open the URL. Knowledge base survives /clear and /compact.
  </ctx_commands>
`
    : "";
  return `
<context_window_protection>
  Every byte a tool returns stays in your context. ctx_ tools work in a subprocess and return only the answer — program the analysis instead of reading raw data in. Names below are bare: ctx_find is ${t("ctx_find")}.
${boot}  <tool_selection_hierarchy>
    curl/wget/WebFetch/inline fetch()/requests → ctx_fetch_and_index(url, source), then search it — full network access.
    Bash output you will filter/count/parse → ctx_batch_execute(commands: [{label, command}], queries) for 3+: outputs indexed under their labels; concurrency 2-8 for network I/O, 1 for builds/tests. One command → ctx_execute(language, code). Plan mode → ctx_gather, read-only.
    Read to analyze → ctx_read(path, intent) to KNOW something about a file rather than SEE all of it, no program to compose; ctx_execute_file(path, language, code) when code must derive it.
    Glob/Grep to locate → ctx_find(query), one ranked search over file names, file contents, indexed memory and code structure — instead of chaining Glob/Grep or a separate file-search MCP.
    Grep/Read on a symbol → ctx_graph(action): symbols|outline|callers|callees|impact|related|explore. Briefing a subagent → ctx_pack(task, budget).
    Worth keeping → ctx_index(content, source). Already known, past sessions too → ctx_search(queries, source, sort: "timeline") — search BEFORE asking the user on resume or after compaction.
  </tool_selection_hierarchy>
  <when_not_to_use>
    These stay native: Bash for git/mkdir/rm/mv and short fixed output; Read before an Edit (Edit matches the exact bytes in your conversation) or when you need every line; Grep for an exhaustive literal sweep; Write/Edit for every file write — subprocess runs do not persist edits.
  </when_not_to_use>
  OUTPUT: Write artifacts (code, configs, PRDs) to files; return only file path + 1-line description. Earlier captured skills/roles are a memory aid, not a standing order — the user's latest message wins.
${commands}</context_window_protection>`;
}

/**
 * The block subagent prompts get. Target 1.5 KB, actual 1 755 bytes on Claude
 * Code, down from 7 527.
 *
 * No memory or resume prose (a subagent has no session to resume), no operator
 * commands (#233), no stats — the routing rules, the exclusions, and what to
 * hand back. The 255 bytes over target are the bootstrap: ten tool names at a
 * 39-character prefix is 517 bytes, and shortening it means either preloading
 * fewer schemas than the block tells the subagent to call (the #724 failure:
 * not-found, then a silent fall back to Bash) or trusting a keyword ToolSearch
 * to find them. The prose around it is at 1.2 KB and carries every rule.
 */
export function createCompactSubagentBlock(t, options = {}) {
  const { toolSearchBootstrap = false } = options;
  const prefix = toolPrefix(t);
  const boot = toolSearchBootstrap
    ? `Deferred schemas — load once, call by these exact names: ToolSearch(query: "select:${BOOTSTRAP_TOOLS.map(t).join(",")}"). Not-found means load it and retry; do NOT fall back to Bash/Read.\n`
    : prefix
      ? `Names below are bare: ctx_find is ${t("ctx_find")}.\n`
      : "";
  return `
<context_mode_routing>
Tool output stays in your context; ctx_ tools return only the answer.
${boot}curl/wget/WebFetch/inline fetch()/requests → ctx_fetch_and_index(url, source) + ctx_search(queries).
Bash output you will filter/count/parse → ctx_batch_execute(commands: [{label, command}], queries) for 3+, outputs indexed under their labels; concurrency 2-8 for network I/O, 1 for builds/tests; one → ctx_execute(language, code); plan mode → ctx_gather.
Read to analyze → ctx_read(path, intent); ctx_execute_file(path, language, code) when code must derive it.
Glob/Grep to locate → ctx_find(query). Symbol callers/impact → ctx_graph(action). Worth keeping → ctx_index(content, source).
STAYS NATIVE: Bash for git/mkdir/rm/mv and short fixed output; Read before an Edit (Edit matches the exact bytes); Grep for an exhaustive sweep; Write/Edit for file writes — subprocess runs do not persist them.
REPORT BACK: artifacts to files; return the path plus one line, never the contents — your report enters your parent's context like any raw output.
</context_mode_routing>`;
}

/**
 * The authored version, kept as the reference text and served under
 * CONTEXT_MODE_ROUTING_BLOCK=full.
 */
export function createVerboseRoutingBlock(t, options = {}) {
  const { includeCommands = true, toolSearchBootstrap = false } = options;
  return `
<context_window_protection>
  <priority_instructions>
    Every byte a tool returns enters your conversation memory and costs reasoning capacity for the rest of the session. The context-mode tools let you do the work in a separate subprocess and surface only the derived answer — the raw bytes stay out. Think-in-Code: program the analysis, do not compute it by reading raw data into your conversation.
  </priority_instructions>
${toolSearchBootstrap ? `
  <deferred_tool_bootstrap>
    The context-mode tools below may be DEFERRED in your harness — their schemas are not loaded yet, so calling them directly fails (e.g. "tool not found" / InputValidationError). Load them ONCE before your first ctx_* call:
    ToolSearch(query: "select:${BOOTSTRAP_TOOLS.map(t).join(",")}")
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
    8. HAND OFF: ${t("ctx_pack")}(task, budget)
       — Assemble one budgeted hand-off package for a task — the ranked repo map, the symbols it matches (signatures, then verbatim bodies), and passages already captured here — composed into a prompt a subagent can be handed as-is, instead of reading those files into your own conversation first.
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
