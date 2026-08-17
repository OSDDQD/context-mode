#!/usr/bin/env node
import "./suppress-stderr.mjs";
import "./ensure-deps.mjs";
/**
 * Claude Code SessionEnd hook — close the session's books.
 *
 * SessionEnd is purely informational (it can block nothing), which makes it
 * the right place for cleanup the lazy paths otherwise defer to "whenever the
 * next server process opens the store":
 *
 *  1. a `session_end` timeline event (with the host's reason: clear, logout,
 *     prompt_input_exit, …) so cross-session recall sees where a session
 *     actually ended and why;
 *  2. the guidance-throttle marker directory for this session is removed —
 *     it is per-session state that would otherwise linger in tmp;
 *  3. a detached best-effort `context-mode drain` run, so the code-index and
 *     subagent-capture queues are indexed NOW, while the machine is idle,
 *     instead of adding latency to the first tool call of the NEXT session.
 *     Disable with CONTEXT_MODE_SESSION_END_DRAIN=0.
 */

import { readStdin, parseStdin, getSessionId, getSessionDBPath, getInputProjectDir } from "./session-helpers.mjs";
import { createSessionLoaders } from "./session-loaders.mjs";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HOOK_DIR, "..");
const { loadSessionDB } = createSessionLoaders(HOOK_DIR);

try {
  const raw = await readStdin();
  const input = parseStdin(raw);
  const projectDir = getInputProjectDir(input);
  const sessionId = getSessionId(input);

  // ─── 1. Timeline event ───
  try {
    const { SessionDB } = await loadSessionDB();
    const dbPath = getSessionDBPath(undefined, projectDir);
    const db = new SessionDB({ dbPath });
    db.ensureSession(sessionId, projectDir);
    db.insertEvent(sessionId, {
      type: "session_end",
      category: "session",
      data: JSON.stringify({
        reason: typeof input.reason === "string" ? input.reason : null,
      }),
      priority: 1,
    }, "SessionEnd");
    db.close();
  } catch { /* best-effort */ }

  // ─── 2. Drop this session's guidance-throttle markers ───
  try {
    const { resetGuidanceThrottle } = await import("./core/routing.mjs");
    resetGuidanceThrottle(sessionId);
  } catch { /* best-effort */ }

  // ─── 3. Detached queue drain (code index + subagent captures) ───
  // The MCP server that owned this session is shutting down with it, so the
  // queues would otherwise wait for the NEXT session's first tool call. A
  // detached CLI child pays that cost now instead. stdio is fully ignored and
  // the child is unref'd: the hook returns immediately either way.
  try {
    if (process.env.CONTEXT_MODE_SESSION_END_DRAIN !== "0") {
      const cli = [
        resolve(PLUGIN_ROOT, "cli.bundle.mjs"),
        resolve(PLUGIN_ROOT, "build", "cli.js"),
      ].find(p => existsSync(p));
      if (cli && projectDir) {
        const child = spawn(process.execPath, [cli, "drain", "--project", projectDir], {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
      }
    }
  } catch { /* best-effort */ }
} catch {
  // Claude Code hooks must not block session shutdown.
}

process.stdout.write("{}\n");
