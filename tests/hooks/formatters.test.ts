import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Dynamic import for .mjs modules
let claudeCodeFormat: (decision: unknown) => unknown;

beforeAll(async () => {
  const ccMod = await import("../../hooks/formatters/claude-code.mjs");
  claudeCodeFormat = ccMod.formatDecision;

});

// ─── Shared test decisions ───────────────────────────────

const denyDecision = {
  action: "deny",
  reason: "WebFetch blocked. Use fetch_and_index instead.",
};

const askDecision = {
  action: "ask",
};

const modifyDecision = {
  action: "modify",
  updatedInput: {
    command: 'echo "context-mode: curl/wget blocked."',
  },
};

const contextDecision = {
  action: "context",
  additionalContext: "<context_guidance>Use execute_file instead</context_guidance>",
};

// ─────────────────────────────────────────────────────────

describe("formatDecision", () => {
  // ─── Claude Code formatter ─────────────────────────────

  describe("claude-code formatter", () => {
    it("formats deny with hookSpecificOutput.permissionDecision", () => {
      const result = claudeCodeFormat(denyDecision) as Record<string, unknown>;
      expect(result).not.toBeNull();

      const output = result.hookSpecificOutput as Record<string, unknown>;
      expect(output.hookEventName).toBe("PreToolUse");
      expect(output.permissionDecision).toBe("deny");
      expect(output.reason).toBe(denyDecision.reason);
    });

    it("formats ask with hookSpecificOutput.permissionDecision:'ask'", () => {
      const result = claudeCodeFormat(askDecision) as Record<string, unknown>;
      expect(result).not.toBeNull();

      const output = result.hookSpecificOutput as Record<string, unknown>;
      expect(output.hookEventName).toBe("PreToolUse");
      expect(output.permissionDecision).toBe("ask");
    });

    // CC v2.1.x Bash tool ignores `updatedInput.command` substitution under
    // `permissionDecision: "allow"` — original command runs unchanged. Verified
    // via /diagnose Phase 4 forced-deny probe: only `permissionDecision: "deny"`
    // is honored for Bash tool. Therefore the claude-code formatter MUST emit a
    // deny shape for modify intent, extracting the echo-payload message into
    // `permissionDecisionReason` so the user still sees the actionable guidance.
    it("formats modify as deny shape (CC Bash ignores updatedInput.command — #-cc-updatedinput-regression)", () => {
      const result = claudeCodeFormat(modifyDecision) as Record<string, unknown>;
      expect(result).not.toBeNull();

      const output = result.hookSpecificOutput as Record<string, unknown>;
      expect(output.hookEventName).toBe("PreToolUse");
      // MUST be deny — CC honors this and actually blocks the command.
      expect(output.permissionDecision).toBe("deny");
      // Reason extracted from `echo "..."` payload so the user sees the
      // redirect guidance verbatim.
      expect(output.permissionDecisionReason).toContain("context-mode: curl/wget blocked");
      // updatedInput MUST NOT appear — CC ignores it for Bash and emitting it
      // alongside deny is a contradictory shape.
      expect(output.updatedInput).toBeUndefined();
    });

    // Fallback fires only when updatedInput.command does not match the
    // `echo "..."` wrapper shape routing.mjs always produces. Even in this
    // rare path the message MUST follow ADR-0003 CASE A voice:
    //   - opens with "Redirected to <ctx_tool>" (affirmative, no "blocked")
    //   - names the alternative tool via an imperative call
    //   - affirms capability ("has full network access")
    //   - ends with the canonical transient-DNS retry hint
    //   - contains NO bare-NOT negations, no "blocked" / "BLOCKED"
    it("falls back to ADR-0003 CASE A voice when echo payload cannot be extracted", () => {
      const unparseable = { action: "modify", updatedInput: { command: "weird shape" } };
      const result = claudeCodeFormat(unparseable) as Record<string, unknown>;
      const output = result.hookSpecificOutput as Record<string, unknown>;
      const reason = String(output.permissionDecisionReason);

      // CASE A voice — REQUIRED affirmations.
      expect(reason).toMatch(/^Redirected to /); // affirmative opening verb
      expect(reason).toMatch(/Call ctx_execute\(/); // imperative call (alt 1)
      expect(reason).toMatch(/ctx_fetch_and_index\(/); // alternative tool name
      expect(reason).toContain("full network access"); // capability affirmation
      expect(reason).toContain("Retry the same call on a transient DNS error"); // canonical retry hint

      // CASE A voice — FORBIDDEN tokens (ADR-0003).
      expect(reason).not.toMatch(/\bblocked\b/i); // reserved for CASE B
      expect(reason).not.toMatch(/\bBLOCKED\b/); // bare-caps forbidden
      expect(reason).not.toMatch(/\bDo NOT\b/); // bare-NOT negation forbidden
      expect(reason).not.toMatch(/\bNOT a /); // bare-NOT negation forbidden
      expect(reason).not.toMatch(/for context-window efficiency|for performance/); // org-rationale preface forbidden
    });

    it("formats context with hookSpecificOutput.additionalContext", () => {
      const result = claudeCodeFormat(contextDecision) as Record<string, unknown>;
      expect(result).not.toBeNull();

      const output = result.hookSpecificOutput as Record<string, unknown>;
      expect(output.hookEventName).toBe("PreToolUse");
      expect(output.additionalContext).toBe(contextDecision.additionalContext);
    });

    it("returns null for null decision", () => {
      const result = claudeCodeFormat(null);
      expect(result).toBeNull();
    });

    // ─── Headless mode (--print, no TTY) — passthrough on ask ───
    describe("when CLAUDE_CODE_HEADLESS=1 (headless --print mode)", () => {
      let saved: string | undefined;
      beforeEach(() => {
        saved = process.env.CLAUDE_CODE_HEADLESS;
        process.env.CLAUDE_CODE_HEADLESS = "1";
      });
      afterEach(() => {
        if (saved === undefined) delete process.env.CLAUDE_CODE_HEADLESS;
        else process.env.CLAUDE_CODE_HEADLESS = saved;
      });

      it("returns null for ask (passthrough — no TTY to surface prompt, prevents --print hang)", () => {
        const result = claudeCodeFormat(askDecision);
        expect(result).toBeNull();
      });

      it("returns null for deny (passthrough — headless agents have no UI to reconsider)", () => {
        const result = claudeCodeFormat(denyDecision);
        expect(result).toBeNull();
      });

      it("returns null for modify (passthrough — modify rewrites silently break headless tool calls)", () => {
        const result = claudeCodeFormat(modifyDecision);
        expect(result).toBeNull();
      });

      it("still formats context normally (informational, doesn't block the tool)", () => {
        const result = claudeCodeFormat(contextDecision) as Record<string, unknown>;
        expect(result).not.toBeNull();
        const output = result.hookSpecificOutput as Record<string, unknown>;
        expect(output.additionalContext).toBe(contextDecision.additionalContext);
      });
    });
  });

});
