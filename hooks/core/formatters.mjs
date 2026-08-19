/**
 * Platform-specific response formatters.
 * Takes normalized decision from routing.mjs -> platform-specific JSON output.
 */

export const formatters = {
  "claude-code": {
    deny: (reason) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
    // Carry the reason when there is one. A confirmation prompt with no
    // explanation is a prompt the user answers by reflex and the model learns
    // nothing from — and the whole point of escalating a search to `ask`
    // rather than denying it is that the caller reads the tradeoff and
    // decides. Omitted when absent, so the security-policy `ask` path (which
    // carries no reason) keeps the exact shape it had.
    ask: (reason) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        ...(reason ? { permissionDecisionReason: reason } : {}),
      },
    }),
    // Tool-aware modify handling for claude-code:
    //
    // - Bash redirect (updatedInput.command): CC v2.1.x ignores
    //   `updatedInput.command` substitution under `permissionDecision: "allow"`
    //   — original command runs unchanged. Verified via /diagnose Phase 4
    //   forced-deny probe: only `permissionDecision: "deny"` is honored for
    //   Bash blocking. Emit deny + extract echo payload into
    //   `permissionDecisionReason`.
    //
    // - Agent prompt injection (updatedInput.prompt): CC honors
    //   allow+updatedInput for Agent tool — modified prompt reaches the
    //   subagent. Keep modify shape so subagent routing-block injection works.
    //
    // - Any other shape: pass through as modify and let CC decide.
    //
    // Other adapters (gemini-cli, vscode-copilot, etc.) keep their own modify
    // semantics — their hosts implement updatedInput differently or not at all.
    modify: (updatedInput) => {
      const ui = updatedInput ?? {};
      const isBashCommandRedirect = "command" in ui;
      if (!isBashCommandRedirect) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            updatedInput: ui,
          },
        };
      }
      // routing.mjs wraps the redirect guidance in `echo "..."` form.
      // Extract the quoted payload as the deny reason. Fall back to a generic
      // ADR-0003 CASE A message if the shape doesn't match.
      const cmd = ui.command ?? "";
      const m = cmd.match(/^echo\s+"(.+)"$/s);
      const reason = m
        ? m[1]
        : "Redirected to ctx_execute / ctx_fetch_and_index. Call ctx_execute(language, code) to fetch and derive your answer in one round trip, or call ctx_fetch_and_index(url, source) when you want to query the response later via ctx_search. Both have full network access. Retry the same call on a transient DNS error (EAI_AGAIN, ETIMEDOUT, ENETUNREACH).";
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      };
    },
    context: (additionalContext) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext,
      },
    }),
    // PostToolUse carries its own event name; reusing the PreToolUse shape
    // here would make the host drop the line.
    postToolContext: (additionalContext) => ({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext,
      },
    }),
  },

  "codex": {
    deny: (reason) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
    // Codex still rejects permissionDecision:"ask" in PreToolUse (verified
    // against codex-cli 0.141.0 output_parser.rs), so the confirmation itself
    // cannot be asked for here. Dropping the whole decision, though, put a
    // hole in the escalation ladder: a session that had earned a confirmation
    // got less back than one that had only earned an advisory, so severity
    // fell as behaviour worsened. Where this build accepts additionalContext,
    // say the same thing as guidance instead — weaker than a prompt, but never
    // weaker than the step below it. A reasonless ask (the security-policy
    // path) still drops, as it always has: there is nothing to say.
    ask: (reason, { codexSupportsRewrite } = {}) =>
      reason && codexSupportsRewrite
        ? { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: reason } }
        : null,
    // #845: modern Codex (>= 0.141.0) honors permissionDecision:"allow" +
    // updatedInput (command rewrite). Emit it when the running Codex supports
    // it; otherwise FAIL CLOSED — turn the redirect into an enforceable deny
    // carrying the same guidance, so the bytes-flood guard never silently
    // passes through. `codexSupportsRewrite` is detected at runtime by the
    // codex hook (hooks/core/codex-caps.mjs) and threaded in via formatDecision.
    modify: (updatedInput, { codexSupportsRewrite } = {}) => {
      if (codexSupportsRewrite) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            updatedInput,
          },
        };
      }
      const ui = updatedInput ?? {};
      // Only command redirects must fail closed. Non-command rewrites (e.g.
      // Agent prompt injection) are advisory — drop rather than block the tool.
      if (!("command" in ui)) return null;
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: codexRedirectReason(ui.command),
        },
      };
    },
    // #845: surface additionalContext on Codex builds that support it; older
    // builds ignore the field, so drop the advisory nudge rather than emit a
    // shape they reject.
    context: (additionalContext, { codexSupportsRewrite } = {}) =>
      codexSupportsRewrite
        ? { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext } }
        : null,
    // Ungated, unlike `context` above: PreToolUse additionalContext is gated
    // because an older Codex that drops it also drops the decision it came
    // with. PostToolUse carries no decision — the adapter's own
    // formatPostToolUseResponse emits this same shape unconditionally, and a
    // build that ignores the field just does not show the line.
    postToolContext: (additionalContext) => ({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext,
      },
    }),
  },
};

// #845: routing wraps redirect guidance as `echo "<guidance>"`. Unwrap a command
// that is exactly `echo "<inner>"` (with optional surrounding whitespace) and
// return the inner string, or null when the shape doesn't match. Greedy: inner
// runs from the first `"` after `echo` to the last `"` before trailing space.
function unwrapEcho(command) {
  const s = String(command ?? "");
  // Match the regex `\s` class exactly: space, tab, newline, carriage return,
  // form feed, vertical tab (so behavior is identical to /^echo\s+"…"\s*$/).
  const isWs = (c) =>
    c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
  if (!s.startsWith("echo")) return null;
  let i = 4;
  if (i >= s.length || !isWs(s[i])) return null; // `echo` must be followed by whitespace
  while (i < s.length && isWs(s[i])) i++;
  if (s[i] !== "\"") return null; // payload must open with a quote
  let end = s.length;
  while (end > 0 && isWs(s[end - 1])) end--; // drop trailing whitespace
  if (end <= i + 1 || s[end - 1] !== "\"") return null; // must close with a quote
  return s.slice(i + 1, end - 1);
}

// Reverse the shell double-quote escaping routing applied: `\"` → `"`, `\\` → `\`.
function unescapeDquote(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && (s[i + 1] === "\"" || s[i + 1] === "\\")) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

// When Codex cannot rewrite the command we surface that guidance as the deny
// reason instead (mirrors the claude-code echo extraction).
function codexRedirectReason(command) {
  const inner = unwrapEcho(command);
  if (inner !== null) return unescapeDquote(inner);
  return "context-mode: command redirected. Use the context-mode MCP tools (ctx_execute / ctx_fetch_and_index / ctx_search) so raw output stays out of the conversation.";
}

/**
 * Apply a formatter to a normalized routing decision.
 * Returns the platform-specific JSON response, or null for passthrough.
 *
 * `opts` carries optional per-platform capability hints (e.g. codex
 * `codexSupportsRewrite`). Formatters that ignore the extra argument are
 * unaffected.
 */
/**
 * Format a line to append to a finished tool's result (PostToolUse).
 *
 * Separate from formatDecision because PostToolUse is not a decision: there is
 * nothing to allow, deny or rewrite, only something to say. Platforms that
 * have no PostToolUse context channel return null and print nothing — the two
 * that do are the two whose PostToolUse hook actually measures a payload.
 *
 * @returns {object | null} platform-specific JSON, or null for "say nothing"
 */
export function formatPostToolContext(platform, additionalContext) {
  if (!additionalContext) return null;
  const fmt = formatters[platform];
  if (!fmt || typeof fmt.postToolContext !== "function") return null;
  return fmt.postToolContext(additionalContext);
}

export function formatDecision(platform, decision, opts = {}) {
  if (!decision) return null;

  const fmt = formatters[platform];
  if (!fmt) return null;

  switch (decision.action) {
    case "deny": return fmt.deny(decision.reason);
    // Pass the reason and the capability hints to ask() too: Claude Code
    // surfaces the reason in the prompt, and Codex — which cannot show a
    // prompt at all — needs the hints to decide whether it can say it as
    // guidance instead of dropping it.
    case "ask": return fmt.ask(decision.reason, opts);
    // "allow": routing decided the call goes through untouched, but attached a
    // redirectMeta so PostToolUse knows it was already accounted for (the
    // read-before-edit retry). There is nothing to tell the host — the marker
    // is written by the hook before this call — so the response is a
    // passthrough, exactly as if routing had returned null.
    case "allow": return null;
    case "modify": return fmt.modify(decision.updatedInput, opts);
    case "context": return fmt.context(decision.additionalContext, opts);
    default: return null;
  }
}
