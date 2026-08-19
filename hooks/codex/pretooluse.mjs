#!/usr/bin/env node
import "./platform.mjs";
import "../suppress-stderr.mjs";
/**
 * Codex CLI preToolUse hook for context-mode.
 *
 * Codex PreToolUse honors `permissionDecision:"deny"` on all builds, and
 * `permissionDecision:"allow" + updatedInput` / `additionalContext` on
 * codex-cli >= 0.141.0 (#845). Capability is detected at runtime by
 * codex-caps.mjs; older builds fail closed (redirect → deny). `ask` is still
 * unsupported. Source: codex-rs/hooks/src/engine/output_parser.rs
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readStdin, parseStdin, getInputProjectDir, getSessionId, CODEX_OPTS } from "../session-helpers.mjs";
import { routePreToolUse, initSecurity, writeRedirectMarker, writeAskMarker, callKeyFor } from "../core/routing.mjs";
import { formatDecision } from "../core/formatters.mjs";
import { codexSupportsUpdatedInput } from "../core/codex-caps.mjs";

const __hookDir = dirname(fileURLToPath(import.meta.url));
await initSecurity(resolve(__hookDir, "..", "..", "build"));

const raw = await readStdin();
const input = parseStdin(raw);
const tool = input.tool_name ?? "";
const toolInput = input.tool_input ?? {};
const projectDir = getInputProjectDir(input, CODEX_OPTS);

const decision = routePreToolUse(tool, toolInput, projectDir, "codex", getSessionId(input, CODEX_OPTS));
// #845: modify/context depend on Codex's rewrite capability. `ask` joins them
// because Codex cannot show a confirmation prompt — the formatter re-says a
// reasoned ask as guidance where the build accepts it, and that path needs the
// same probe. Detection is cached; deny and passthrough still skip it.
const needsCaps = decision
  && (decision.action === "modify" || decision.action === "context" || decision.action === "ask");
const response = formatDecision(
  "codex",
  decision,
  needsCaps ? { codexSupportsRewrite: codexSupportsUpdatedInput() } : {},
);
// The byte-accounting handshake, same as the Claude Code hook: PreToolUse
// cannot open SessionDB (the native module load breaks hook stdout), so a
// decision that needs recording is left in a marker for the next PostToolUse.
//
// Codex wrote no marker until now, which cost it both halves of the wave:
// nothing refused here ever reached ctx_stats as bytes avoided, and — worse —
// the read-before-edit retry arrived at PostToolUse looking like an ordinary
// heavy read, so taking the escape hatch the refusal had just offered counted
// as a fresh violation and pushed the escalation ladder up a step. The loop
// was fixed on Claude Code first; this is the same fix on the second host.
if (decision && decision.redirectMeta) {
  const denied = decision.action === "deny";
  writeRedirectMarker(getSessionId(input, CODEX_OPTS), decision.redirectMeta, {
    callKey: denied ? undefined : callKeyFor(input, decision.updatedInput),
    denied,
    denyPath: decision.redirectMeta.commandSummary,
  });
}

// Codex cannot show a confirmation prompt, so an `ask` reaches the model as
// guidance and the call runs. Recording it as consent anyway is the honest
// reading: nothing stood between the guidance and the call, so treating it as
// a violation would charge the session for a prompt the host never showed.
if (decision && decision.action === "ask") {
  try {
    writeAskMarker(getSessionId(input, CODEX_OPTS), callKeyFor(input));
  } catch { /* best-effort */ }
}

const output = response ?? {
  hookSpecificOutput: { hookEventName: "PreToolUse" },
};
process.stdout.write(JSON.stringify(output) + "\n");
