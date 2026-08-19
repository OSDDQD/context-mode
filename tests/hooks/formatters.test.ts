import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Dynamic import for .mjs modules
let claudeCodeFormat: (decision: unknown) => unknown;
// codex has no standalone formatter — central registry only. It takes an
// optional capability hint ({ codexSupportsRewrite }) threaded by the hook (#845).
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose test seams over .mjs
let codexFormat: (decision: unknown, opts?: any) => unknown;
// codex capability detection helpers (#845, hooks/core/codex-caps.mjs).
let parseCodexVersion: (raw: unknown) => number[] | null;
let versionGte: (a: number[], b: number[]) => boolean;
let codexSupportsUpdatedInput: (io?: any) => boolean;
let MIN_REWRITE_VERSION: number[];

beforeAll(async () => {
  const ccMod = await import("../../hooks/formatters/claude-code.mjs");
  claudeCodeFormat = ccMod.formatDecision;

  const coreMod = await import("../../hooks/core/formatters.mjs");
  codexFormat = (decision: unknown, opts?: Record<string, unknown>) =>
    coreMod.formatDecision("codex", decision as { action: string } | null, opts);

  const capsMod = await import("../../hooks/core/codex-caps.mjs");
  parseCodexVersion = capsMod.parseCodexVersion;
  versionGte = capsMod.versionGte;
  codexSupportsUpdatedInput = capsMod.codexSupportsUpdatedInput;
  MIN_REWRITE_VERSION = capsMod.MIN_REWRITE_VERSION;
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

// ─── Codex formatter (#845) ──────────────────────────────
// hooks/core/formatters.mjs owns Codex PreToolUse formatting → "Hook formatting"
// maps here per CONTRIBUTING.md. Capability detection (codex-caps.mjs) is part of
// the same #845 feature, so its unit tests live here too rather than a new file.
describe("codex formatter (#845)", () => {
  describe("modify", () => {
    it("capable Codex: emits permissionDecision:allow + updatedInput (command rewrite)", () => {
      const out = codexFormat(modifyDecision, { codexSupportsRewrite: true }) as {
        hookSpecificOutput: Record<string, unknown>;
      };
      expect(out.hookSpecificOutput).toEqual({
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command: 'echo "context-mode: curl/wget blocked."' },
      });
    });

    it("incapable Codex: FAILS CLOSED as a deny carrying the extracted guidance", () => {
      const out = codexFormat(modifyDecision, { codexSupportsRewrite: false }) as {
        hookSpecificOutput: Record<string, unknown>;
      };
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(out.hookSpecificOutput.permissionDecisionReason).toBe("context-mode: curl/wget blocked.");
      expect(out.hookSpecificOutput).not.toHaveProperty("updatedInput");
    });

    it("incapable Codex: never silently passes a command redirect through", () => {
      expect(codexFormat(modifyDecision, { codexSupportsRewrite: false })).not.toBeNull();
    });

    it("incapable Codex: non-command rewrite (Agent prompt) is dropped, not denied", () => {
      const promptModify = { action: "modify", updatedInput: { prompt: "routing block" } };
      expect(codexFormat(promptModify, { codexSupportsRewrite: false })).toBeNull();
    });

    it("defaults to fail-closed when no capability hint is given", () => {
      const out = codexFormat(modifyDecision) as { hookSpecificOutput: Record<string, unknown> };
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    });
  });

  describe("context", () => {
    it("capable Codex: surfaces additionalContext", () => {
      const out = codexFormat(contextDecision, { codexSupportsRewrite: true });
      expect(out).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: contextDecision.additionalContext,
        },
      });
    });

    it("incapable Codex: drops the advisory nudge (no rejected shape emitted)", () => {
      expect(codexFormat(contextDecision, { codexSupportsRewrite: false })).toBeNull();
    });
  });

  describe("deny / ask", () => {
    it("deny still emits permissionDecision:deny with the reason", () => {
      const out = codexFormat(denyDecision) as { hookSpecificOutput: Record<string, unknown> };
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(out.hookSpecificOutput.permissionDecisionReason).toBe(denyDecision.reason);
    });

    // Codex rejects permissionDecision:"ask" outright, so the prompt itself
    // cannot be asked for. Dropping the whole decision, though, put a hole in
    // the escalation ladder — a session that had earned a confirmation got
    // less back than one that had only earned an advisory. Where the build
    // accepts additionalContext, the same words are said as guidance instead.
    it("ask carries its reason as guidance where the build accepts it", () => {
      expect(
        codexFormat({ action: "ask", reason: "why this is being asked" }, { codexSupportsRewrite: true }),
      ).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: "why this is being asked",
        },
      });
    });

    it("ask still drops on a build that cannot take it, and when there is nothing to say", () => {
      // The second case is the security-policy ask, which carries no reason:
      // there is no sentence to re-say, so the decision drops as it always did.
      expect(codexFormat({ action: "ask", reason: "why" })).toBeNull();
      expect(codexFormat(askDecision, { codexSupportsRewrite: true })).toBeNull();
      expect(codexFormat(askDecision)).toBeNull();
    });
  });
});

// ─── Codex capability detection (#845) ───────────────────
describe("codexSupportsUpdatedInput (#845)", () => {
  let dir: string;
  let cachePath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cm-codex-caps-"));
    cachePath = join(dir, "caps.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("parseCodexVersion parses the version line, null on garbage", () => {
    expect(parseCodexVersion("codex-cli 0.141.0")).toEqual([0, 141, 0]);
    expect(parseCodexVersion("codex 0.139.2\n")).toEqual([0, 139, 2]);
    expect(parseCodexVersion("no version")).toBeNull();
  });

  it("versionGte compares major/minor/patch (equal → true)", () => {
    expect(versionGte([0, 141, 0], MIN_REWRITE_VERSION)).toBe(true);
    expect(versionGte([0, 140, 9], [0, 141, 0])).toBe(false);
    expect(versionGte([1, 0, 0], [0, 141, 0])).toBe(true);
  });

  it("true for a supported version, false (fail closed) for older", () => {
    expect(codexSupportsUpdatedInput({ runVersion: () => "codex-cli 0.141.0", now: () => 1000, cachePath })).toBe(true);
    rmSync(cachePath, { force: true });
    expect(codexSupportsUpdatedInput({ runVersion: () => "codex-cli 0.140.0", now: () => 1000, cachePath })).toBe(false);
  });

  it("fails closed when codex is absent / probe throws", () => {
    expect(
      codexSupportsUpdatedInput({ runVersion: () => { throw new Error("ENOENT"); }, now: () => 1000, cachePath }),
    ).toBe(false);
  });

  it("serves a fresh cached result without re-probing, re-probes after TTL", () => {
    codexSupportsUpdatedInput({ runVersion: () => "codex-cli 0.141.0", now: () => 1000, cachePath });
    expect(
      codexSupportsUpdatedInput({ runVersion: () => { throw new Error("must not run within TTL"); }, now: () => 1000 + 60_000, cachePath }),
    ).toBe(true);
    expect(
      codexSupportsUpdatedInput({ runVersion: () => "codex-cli 0.140.0", now: () => 1000 + 2 * 60 * 60 * 1000, cachePath }),
    ).toBe(false);
  });
});
