#!/usr/bin/env node
import "./platform.mjs";
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * Codex CLI postToolUse hook — session event capture.
 */

import { readStdin, parseStdin, getSessionId, getSessionDBPath, getInputProjectDir, CODEX_OPTS } from "../session-helpers.mjs";
import { createSessionLoaders, attributeAndInsertEvents } from "../session-loaders.mjs";
import {
  describeMissedRedirect,
  readMissedRedirectTally,
  buildMissedRedirectNotice,
  writeUnroutedTally,
} from "../core/routing.mjs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB, loadExtract, loadProjectAttribution } = createSessionLoaders(HOOK_DIR);
const OPTS = CODEX_OPTS;

// Set only by an unrouted heavy call; the stdout payload below carries it.
let costNotice = null;

function normalizeToolName(toolName) {
  // Keep Codex-native tool names like apply_patch intact; only normalize
  // legacy shell aliases that should route through the Bash extractors.
  if (toolName === "Shell") return "Bash";
  return toolName;
}

try {
  const raw = await readStdin();
  const input = parseStdin(raw);
  const projectDir = getInputProjectDir(input, OPTS);

  const { extractEvents } = await loadExtract();
  const { resolveProjectAttributions } = await loadProjectAttribution();
  const { SessionDB } = await loadSessionDB();

  const dbPath = getSessionDBPath(OPTS, projectDir);
  const db = new SessionDB({ dbPath });
  const sessionId = getSessionId(input, OPTS);

  db.ensureSession(sessionId, projectDir);

  const normalizedInput = {
    tool_name: normalizeToolName(input.tool_name ?? ""),
    tool_input: input.tool_input ?? {},
    tool_response: typeof input.tool_response === "string"
      ? input.tool_response
      : JSON.stringify(input.tool_response ?? ""),
    tool_output: input.tool_output
      ? {
        ...input.tool_output,
        isError: input.tool_output.isError === true || input.tool_output.is_error === true,
      }
      : undefined,
  };

  const events = extractEvents(normalizedInput);

  attributeAndInsertEvents(db, sessionId, events, input, projectDir, "PostToolUse", resolveProjectAttributions);

  // ─── Missed-redirect telemetry + cost notice ───
  // Same classification, same floor and same tally as the Claude Code hook —
  // the whole point of keeping it in hooks/core/routing.mjs is that a second
  // host costs a call, not a copy. Codex has no PreToolUse redirect marker to
  // consult, so `routed` stays false: a redirect on Codex is a deny, and a
  // denied call has no payload to weigh.
  try {
    const missed = describeMissedRedirect(normalizedInput);
    if (missed) {
      attributeAndInsertEvents(
        db,
        sessionId,
        [{
          type: "missed_redirect",
          category: "missed-redirect",
          data: `${missed.toolName}: ${missed.bytes} bytes unrouted — ${missed.summary}`,
          priority: 3,
        }],
        input,
        projectDir,
        "PostToolUse",
        resolveProjectAttributions,
      );
      const tally = readMissedRedirectTally(db, sessionId);
      // Same hop as the Claude Code hook: PreToolUse reads these two numbers
      // instead of counting events on its own budget.
      writeUnroutedTally(sessionId, tally);
      costNotice = buildMissedRedirectNotice({
        toolName: missed.toolName,
        displayName: input.tool_name,
        bytes: missed.bytes,
        tally,
        platform: "codex",
      });
    }
  } catch { /* telemetry is best-effort — never block the hook */ }

  db.close();
} catch {
  // Swallow errors — hook must not fail
}

// Codex PostToolUse requires hookEventName in hookSpecificOutput.
// The payload is emitted either way; the notice fills it only after an
// unrouted heavy call, so a routed session sees exactly what it saw before.
process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: costNotice ?? "" },
}) + "\n");
