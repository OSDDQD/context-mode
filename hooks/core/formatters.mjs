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

};

/**
 * Apply a formatter to a normalized routing decision.
 * Returns the platform-specific JSON response, or null for passthrough.
 *
 * `opts` carries optional per-platform capability hints. Formatters that
 * ignore the extra argument are unaffected.
 */
/**
 * Format a line to append to a finished tool's result (PostToolUse).
 *
 * Separate from formatDecision because PostToolUse is not a decision: there is
 * nothing to allow, deny or rewrite, only something to say. Platforms that
 * have no PostToolUse context channel return null and print nothing.
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
