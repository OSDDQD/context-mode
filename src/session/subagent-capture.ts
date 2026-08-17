/**
 * Subagent transcript capture.
 *
 * A subagent's context dies with the subagent: every tool output it saw is
 * discarded, and only the final report survives — in the parent's context.
 * When the parent later needs a detail the report omitted ("what did that
 * agent actually find in config.ts?"), the only options were to re-run the
 * exploration or ask the user. The transcript with the answer was sitting on
 * disk the whole time.
 *
 * Same split as code-index.ts: the SubagentStop hook appends one JSON line to
 * a queue file (<1ms, no SQLite load inside a hook), and the MCP server
 * drains the queue the next time it opens the content store — parsing the
 * subagent's transcript JSONL, distilling it to a markdown digest (task, tool
 * calls with truncated results, final report), and indexing it under
 * `subagent:<type>:<id>` so `ctx_search` can reach it.
 *
 * Best-effort by design, like every capture path here: a malformed queue
 * line, a vanished transcript, or an unparseable entry is skipped, never
 * surfaced into a tool call the user is waiting on.
 */

import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Queue filename, resolved inside the sessions storage dir. */
export const SUBAGENT_QUEUE = "subagent-capture-queue.jsonl";

/** Transcripts above this size are skipped — parsing them buys noise, not recall. */
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

/** Per-tool-result cap inside the digest. Enough to answer "what did it see". */
const DEFAULT_TOOL_RESULT_CAP = 2048;

/** Cap for the task prompt section. */
const TASK_PROMPT_CAP = 4096;

/** Cap for the final report section. */
const FINAL_REPORT_CAP = 16 * 1024;

/** Whole-digest cap — one runaway agent must not evict the rest of the index. */
const DEFAULT_TOTAL_CAP = 256 * 1024;

/** One line in the queue file, written by the SubagentStop hook. */
export interface SubagentQueueEntry {
  sessionId?: string;
  agentId?: string;
  agentType?: string;
  /** transcript_path as the hook received it (may be the MAIN transcript). */
  transcriptPath?: string;
  ts?: number;
}

/** Minimal surface of ContentStore this module needs. */
export interface SubagentIndexTarget {
  index(options: {
    content?: string;
    source?: string;
    attribution?: { sessionId?: string; eventId?: string };
  }): unknown;
}

/** @returns Absolute path of the queue file for a given sessions storage dir. */
export function subagentQueuePath(sessionsDir: string): string {
  return join(sessionsDir, SUBAGENT_QUEUE);
}

/** @returns The label a subagent digest is indexed under. */
export function subagentSourceLabel(entry: SubagentQueueEntry): string {
  const type = (entry.agentType ?? "agent").replace(/[^\w-]+/g, "-").slice(0, 40) || "agent";
  const id = (entry.agentId ?? "unknown").replace(/[^\w-]+/g, "-").slice(0, 24) || "unknown";
  return `subagent:${type}:${id}`;
}

/**
 * Find the transcript that actually belongs to the subagent.
 *
 * Claude Code's SubagentStop input carries `transcript_path`, but the docs do
 * not promise whose transcript that is. Current builds store subagent
 * transcripts as separate files next to the main one
 * (`<transcript-dir>/<sessionId>/subagents/agent-<agentId>.jsonl`); older
 * builds inlined them into the main transcript as sidechain entries. Try the
 * dedicated locations first, fall back to the given path — the extractor
 * filters sidechains when it gets a mixed file.
 *
 * @returns An existing transcript path, or null when nothing is on disk.
 */
export function resolveAgentTranscriptPath(entry: SubagentQueueEntry): string | null {
  const tp = entry.transcriptPath;
  if (!tp) return null;

  // Already the subagent's own file.
  if (/[\\/]subagents[\\/]/.test(tp) || basename(tp).startsWith("agent-")) {
    return existsSync(tp) ? tp : null;
  }

  if (entry.agentId) {
    const dir = dirname(tp);
    const stem = basename(tp).replace(/\.jsonl$/, "");
    const candidates = [
      // <dir>/<sessionId>/subagents/agent-<id>.jsonl — sessionId-keyed layout.
      join(dir, stem, "subagents", `agent-${entry.agentId}.jsonl`),
      // <dir>/subagents/agent-<id>.jsonl — flat layout.
      join(dir, "subagents", `agent-${entry.agentId}.jsonl`),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }

  return existsSync(tp) ? tp : null;
}

interface TranscriptLine {
  type?: string;
  isSidechain?: boolean;
  agentId?: string;
  message?: { role?: string; content?: unknown };
}

interface ToolCall {
  name: string;
  brief: string;
  result: string;
}

/** Extracted digest of one subagent run. */
export interface SubagentCapture {
  markdown: string;
  toolCalls: number;
  finalText: string;
}

function asText(content: unknown, cap: number): string {
  if (typeof content === "string") return content.slice(0, cap);
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") parts.push(text);
      }
      if (parts.join("\n").length >= cap) break;
    }
    return parts.join("\n").slice(0, cap);
  }
  return "";
}

/** One-line summary of a tool_use input — becomes part of a section heading. */
function briefInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "pattern", "query", "url", "path", "prompt", "description"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.replace(/\s+/g, " ").trim().slice(0, 80);
    }
  }
  try {
    return JSON.stringify(record).slice(0, 80);
  } catch {
    return "";
  }
}

/**
 * Distill a subagent transcript into an indexable markdown digest.
 *
 * Selection rules, in order:
 *  - a file with no sidechain markers (the dedicated-file layout) is taken whole;
 *  - a mixed file keeps only sidechain entries, narrowed to `agentId` when the
 *    entries carry one;
 *  - when the entries carry no agent id, the LAST contiguous sidechain run is
 *    taken — SubagentStop fires right after the agent ends, so the tail run is
 *    the agent that just stopped. Parallel agents can interleave; a blended
 *    tail is the accepted cost of best-effort capture on the legacy layout.
 *
 * @returns The digest, or null when nothing attributable was found.
 */
export function extractSubagentCapture(
  jsonlText: string,
  opts: { agentId?: string; toolResultCap?: number; totalCap?: number } = {},
): SubagentCapture | null {
  const toolResultCap = opts.toolResultCap ?? DEFAULT_TOOL_RESULT_CAP;
  const totalCap = opts.totalCap ?? DEFAULT_TOTAL_CAP;

  const lines: TranscriptLine[] = [];
  for (const raw of jsonlText.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as TranscriptLine;
      if (parsed && typeof parsed === "object") lines.push(parsed);
    } catch { /* skip malformed line */ }
  }
  if (lines.length === 0) return null;

  const messageLines = lines.filter(l => l.message && (l.type === "user" || l.type === "assistant"));
  if (messageLines.length === 0) return null;

  let selected: TranscriptLine[];
  const sidechains = messageLines.filter(l => l.isSidechain === true);
  if (sidechains.length === 0) {
    // Dedicated subagent file — every entry is the agent's.
    selected = messageLines;
  } else if (opts.agentId && sidechains.some(l => l.agentId === opts.agentId)) {
    selected = sidechains.filter(l => l.agentId === opts.agentId);
  } else {
    // Legacy inline layout without ids: take the last contiguous sidechain run.
    let end = messageLines.length - 1;
    while (end >= 0 && messageLines[end].isSidechain !== true) end--;
    if (end < 0) return null;
    let start = end;
    while (start > 0 && messageLines[start - 1].isSidechain === true) start--;
    selected = messageLines.slice(start, end + 1);
  }
  if (selected.length === 0) return null;

  // Walk the selected messages: pair tool_use blocks with their results,
  // keep the first user text as the task and the last assistant text as the
  // final report.
  const toolCalls: ToolCall[] = [];
  const byToolUseId = new Map<string, ToolCall>();
  let taskPrompt = "";
  let finalText = "";

  for (const line of selected) {
    const content = line.message?.content;
    if (line.type === "user") {
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const typed = block as { type?: string; tool_use_id?: string; content?: unknown };
          if (typed.type === "tool_result" && typed.tool_use_id) {
            const call = byToolUseId.get(typed.tool_use_id);
            if (call && !call.result) call.result = asText(typed.content, toolResultCap);
          }
        }
      }
      if (!taskPrompt) taskPrompt = asText(content, TASK_PROMPT_CAP);
    } else if (line.type === "assistant") {
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const typed = block as { type?: string; id?: string; name?: string; input?: unknown };
          if (typed.type === "tool_use" && typed.name) {
            const call: ToolCall = { name: typed.name, brief: briefInput(typed.input), result: "" };
            toolCalls.push(call);
            if (typed.id) byToolUseId.set(typed.id, call);
          }
        }
      }
      const text = asText(content, FINAL_REPORT_CAP);
      if (text) finalText = text;
    }
  }

  if (toolCalls.length === 0 && !finalText) return null;

  const parts: string[] = [];
  if (taskPrompt) parts.push(`## Task prompt\n\n${taskPrompt}`);
  toolCalls.forEach((call, i) => {
    const heading = call.brief ? `${call.name}: ${call.brief}` : call.name;
    const body = call.result ? `\n\n${call.result}` : "";
    parts.push(`## ${i + 1}. ${heading}${body}`);
  });
  if (finalText) parts.push(`## Final report\n\n${finalText}`);

  const markdown = parts.join("\n\n").slice(0, totalCap);
  return { markdown, toolCalls: toolCalls.length, finalText };
}

/**
 * Index every queued subagent transcript into `store`, then clear the queue.
 *
 * Mirrors drainCodeIndexQueue: the queue is cleared BEFORE processing so a
 * poisoned entry cannot replay on every store open, overflow past the cap is
 * written back for the next drain, and every per-entry failure is swallowed.
 *
 * @returns Number of subagent digests actually indexed.
 */
export function drainSubagentQueue(opts: {
  store: SubagentIndexTarget;
  sessionsDir: string;
  /** Cap per drain so a burst of agents can't stall a tool call. */
  maxAgents?: number;
}): number {
  const { store, sessionsDir } = opts;
  const maxAgents = opts.maxAgents ?? 8;
  const queuePath = subagentQueuePath(sessionsDir);
  if (!existsSync(queuePath)) return 0;

  let entries: SubagentQueueEntry[];
  try {
    const raw = readFileSync(queuePath, "utf-8");
    entries = raw
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => {
        try { return JSON.parse(l) as SubagentQueueEntry; } catch { return null; }
      })
      .filter((e): e is SubagentQueueEntry => e !== null && typeof e === "object");
  } catch {
    return 0;
  }

  // Last entry wins per agent — an agent resumed and stopped again this
  // session is captured once, from its final transcript state.
  const byAgent = new Map<string, SubagentQueueEntry>();
  for (const entry of entries) byAgent.set(subagentSourceLabel(entry), entry);
  const deduped = [...byAgent.values()];

  try { unlinkSync(queuePath); } catch { /* raced with another drain */ }

  const overflow = deduped.slice(maxAgents);
  let indexed = 0;
  for (const entry of deduped.slice(0, maxAgents)) {
    try {
      const transcriptPath = resolveAgentTranscriptPath(entry);
      if (!transcriptPath) continue;
      if (statSync(transcriptPath).size > MAX_TRANSCRIPT_BYTES) continue;
      const capture = extractSubagentCapture(readFileSync(transcriptPath, "utf-8"), {
        agentId: entry.agentId,
      });
      if (!capture) continue;
      const header = `# Subagent: ${entry.agentType ?? "agent"} (${entry.agentId ?? "unknown"})\n\n`;
      store.index({
        content: header + capture.markdown,
        source: subagentSourceLabel(entry),
        attribution: entry.sessionId ? { sessionId: entry.sessionId } : undefined,
      });
      indexed++;
    } catch { /* skip this agent, keep draining */ }
  }

  if (overflow.length > 0) {
    try {
      writeFileSync(queuePath, overflow.map(e => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    } catch { /* best-effort */ }
  }

  return indexed;
}
