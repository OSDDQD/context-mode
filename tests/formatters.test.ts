import { describe, it, expect } from "vitest";
import { formatters, formatDecision, formatPostToolContext } from "../hooks/core/formatters.mjs";

/**
 * Field-name discipline in the response formatters.
 *
 * A hook response is a contract with the host, and the failure mode when it is
 * broken is silence: the host reads the object, does not find the field it
 * wants, and applies its default. Nothing throws, nothing logs, the redirect
 * just does not happen. `reason` instead of `permissionDecisionReason` is the
 * exact shape of that mistake, and it is invisible from inside the plugin.
 *
 * This file used to check the property on two named hosts and let the rest go
 * unexamined. With two hosts left it checks it on all of them, derived from
 * the registry rather than from a list written here — a formatter added later
 * is covered the day it is added.
 */

/**
 * The registry is an untyped .mjs object; index it through one alias rather
 * than casting at every call site.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose seam over .mjs
const registry = formatters as Record<string, Record<string, (...args: any[]) => any>>;
const PLATFORMS = Object.keys(registry);

describe("every formatter", () => {
  it("exists for both supported hosts and no others", () => {
    expect([...PLATFORMS].sort()).toEqual(["claude-code", "codex"]);
  });

  for (const platform of PLATFORMS) {
    describe(platform, () => {
      it("implements the whole decision interface", () => {
        // A missing branch is not a type error in an .mjs registry — it is a
        // TypeError at the moment routing produces that decision, inside a
        // hook whose failures are swallowed by design.
        for (const action of ["deny", "ask", "modify", "context"]) {
          expect(typeof registry[platform][action], `${platform}.${action}`).toBe("function");
        }
      });

      it("carries a deny reason in permissionDecisionReason, never in `reason`", () => {
        const result = registry[platform].deny("sandbox only") as Record<string, unknown>;
        const output = (result.hookSpecificOutput ?? result) as Record<string, unknown>;
        expect(output.permissionDecisionReason, `${platform} deny reason`).toBe("sandbox only");
        expect(output, `${platform} deny uses the host-ignored \`reason\` key`).not.toHaveProperty("reason");
      });

      it("labels its PreToolUse output with the PreToolUse event name", () => {
        // Both remaining hosts key on hookEventName; a PostToolUse label here
        // makes the host drop the decision without complaint.
        const result = registry[platform].deny("x") as Record<string, unknown>;
        const output = result.hookSpecificOutput as Record<string, unknown> | undefined;
        if (output) expect(output.hookEventName).toBe("PreToolUse");
      });
    });
  }
});

describe("claude-code formatter", () => {
  // Per 4bc292f: CC ignores updatedInput.command for Bash, so allow+updatedInput
  // never reaches the user. The forced-deny probe + echo payload in the reason
  // is the only way to surface a redirect; for non-Bash tools we drop the
  // explicit permissionDecision and let CC's default-allow path apply.
  it("modify with bash command emits forced-deny probe", () => {
    const result = formatters["claude-code"].modify({ command: "ls" });
    const output = result.hookSpecificOutput;
    expect(output.permissionDecision).toBe("deny");
    expect(output.permissionDecisionReason).toBeDefined();
  });

  it("modify with bash echo payload extracts the quoted message as deny reason", () => {
    const result = formatters["claude-code"].modify({ command: 'echo "use ctx_execute instead"' });
    const output = result.hookSpecificOutput;
    expect(output.permissionDecision).toBe("deny");
    expect(output.permissionDecisionReason).toBe("use ctx_execute instead");
  });

  it("modify with non-bash input returns updatedInput and lets CC default-allow", () => {
    const result = formatters["claude-code"].modify({ prompt: "modified" });
    const output = result.hookSpecificOutput;
    expect(output.updatedInput).toEqual({ prompt: "modified" });
    expect(output).not.toHaveProperty("permissionDecision");
  });

  it("ask carries its reason so the prompt says why", () => {
    const result = formatters["claude-code"].ask("because the search is unbounded");
    expect(result.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(result.hookSpecificOutput.permissionDecisionReason).toBe("because the search is unbounded");
  });
});

describe("codex formatter", () => {
  it("emits deny in the hookSpecificOutput shape Codex parses", () => {
    const result = formatters["codex"].deny("sandbox only");
    expect(result.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(result.hookSpecificOutput.permissionDecisionReason).toBe("sandbox only");
  });

  it("re-says a reasoned ask as guidance, since Codex has no prompt to show", () => {
    expect(formatters["codex"].ask("why", { codexSupportsRewrite: true })).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "why" },
    });
    expect(formatters["codex"].ask("why", {})).toBeNull();
    expect(formatters["codex"].ask(undefined, { codexSupportsRewrite: true })).toBeNull();
  });
});

describe("formatDecision integration", () => {
  it("claude-code deny flows through with correct field names", () => {
    const result = formatDecision("claude-code", { action: "deny", reason: "sandbox only" });
    expect(result.hookSpecificOutput.permissionDecisionReason).toBe("sandbox only");
    expect(result.hookSpecificOutput).not.toHaveProperty("reason");
  });

  it("claude-code modify with bash command flows through as forced-deny", () => {
    const result = formatDecision("claude-code", { action: "modify", updatedInput: { command: "echo hi" } });
    expect(result.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(result.hookSpecificOutput.permissionDecisionReason).toBeDefined();
  });

  it("threads capability hints into ask, not only into modify and context", () => {
    // The hint reaches `modify` and `context` by long-standing wiring; `ask`
    // was added later and would silently keep dropping without this.
    expect(formatDecision("codex", { action: "ask", reason: "why" }, { codexSupportsRewrite: true }))
      .toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "why" } });
  });

  it("returns null for an unknown platform rather than guessing a shape", () => {
    expect(formatDecision("nonexistent-host", { action: "deny", reason: "x" })).toBeNull();
    expect(formatPostToolContext("nonexistent-host", "x")).toBeNull();
  });
});

describe("formatPostToolContext", () => {
  it("labels the PostToolUse line for both hosts", () => {
    // Reusing the PreToolUse event name here is the failure that would make
    // the cost line vanish without a trace.
    for (const platform of PLATFORMS) {
      expect(formatPostToolContext(platform, "hello"), platform).toEqual({
        hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "hello" },
      });
    }
  });

  it("says nothing when there is nothing to say", () => {
    for (const platform of PLATFORMS) {
      expect(formatPostToolContext(platform, ""), platform).toBeNull();
    }
  });
});
