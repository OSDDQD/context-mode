#!/usr/bin/env node
import "./suppress-stderr.mjs";
import "./ensure-deps.mjs";
/**
 * Claude Code SubagentStop hook — enqueue the subagent's transcript for capture.
 *
 * A subagent's context is discarded when it stops; only its final report
 * survives, in the parent's context. This hook makes the rest recoverable:
 * it appends one JSON line to a queue file, and the MCP server drains that
 * queue on its next store open — parsing the transcript, distilling it, and
 * indexing it under `subagent:<type>:<id>` for ctx_search
 * (src/session/subagent-capture.ts).
 *
 * Same budget discipline as the code-index queue: the hook does a one-line
 * append plus one SessionDB event insert, and never parses the transcript
 * itself. Disable with CONTEXT_MODE_SUBAGENT_CAPTURE=0.
 */

import { readStdin, parseStdin, getSessionId, getSessionDBPath, getInputProjectDir } from "./session-helpers.mjs";
import { createSessionLoaders } from "./session-loaders.mjs";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB } = createSessionLoaders(HOOK_DIR);

try {
  if (process.env.CONTEXT_MODE_SUBAGENT_CAPTURE !== "0") {
    const raw = await readStdin();
    const input = parseStdin(raw);
    const projectDir = getInputProjectDir(input);
    const sessionId = getSessionId(input);
    const dbPath = getSessionDBPath(undefined, projectDir);

    // ─── Enqueue for the server-side drain (one line, no transcript parse) ───
    try {
      const entry = {
        sessionId,
        agentId: typeof input.agent_id === "string" ? input.agent_id : undefined,
        agentType: typeof input.agent_type === "string" ? input.agent_type : undefined,
        transcriptPath: typeof input.transcript_path === "string" ? input.transcript_path : undefined,
        ts: Date.now(),
      };
      if (entry.transcriptPath) {
        appendFileSync(
          resolve(dirname(dbPath), "subagent-capture-queue.jsonl"),
          JSON.stringify(entry) + "\n",
          "utf-8",
        );
      }
    } catch { /* best-effort — capture must never block the agent */ }

    // ─── Timeline event so `ctx_search(sort: "timeline")` sees the boundary ───
    try {
      const { SessionDB } = await loadSessionDB();
      const db = new SessionDB({ dbPath });
      db.ensureSession(sessionId, projectDir);
      db.insertEvent(sessionId, {
        type: "subagent_end",
        category: "session",
        data: JSON.stringify({
          agent_id: typeof input.agent_id === "string" ? input.agent_id : null,
          agent_type: typeof input.agent_type === "string" ? input.agent_type : null,
          last_assistant_message: typeof input.last_assistant_message === "string"
            ? input.last_assistant_message.slice(0, 2000)
            : null,
        }),
        priority: 1,
      }, "SubagentStop");
      db.close();
    } catch { /* best-effort */ }
  }
} catch {
  // Claude Code hooks must not block the session.
}

process.stdout.write("{}\n");
