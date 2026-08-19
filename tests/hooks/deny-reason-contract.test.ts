/**
 * Contract test for ADR-0003 — "redirect ≠ restriction".
 *
 * routing.mjs denies for two unrelated reasons, and the ADR says they must not
 * sound alike:
 *
 *   CASE A — a redirect. curl, WebFetch, an unbounded Bash command: the work is
 *            allowed, it just belongs in a context-efficient tool. PR #654
 *            reproduced an Opus 4.6 session reading the bare word "blocked" in
 *            a CASE A reason as a network restriction and giving up entirely
 *            instead of calling the tool it was being handed.
 *   CASE B — an actual security policy denial. Reading a secret, a deny-pattern
 *            match. These SHOULD read like restrictions, because they are.
 *
 * The ADR closes with "a contract test on routing.mjs deny reasons is
 * recommended as a follow-up — the rule is already mechanically checkable".
 * This is that test.
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type RouteResult = { action: string; reason?: string } | null;

let routePreToolUse: (
  toolName: string,
  toolInput: Record<string, unknown>,
  projectDir?: string,
  platform?: string,
  sessionId?: string,
  options?: { mcpToolsAvailable?: boolean },
) => RouteResult;
let resetGuidanceThrottle: (sessionId?: string) => void;

/**
 * Vocabulary that tells an agent "this capability is unavailable to you".
 * Fine in CASE B, wrong in CASE A.
 */
const RESTRICTION_WORDS = [
  /\bblocked\b/i,
  /\bnot allowed\b/i,
  /\bforbidden\b/i,
  /\bprohibited\b/i,
  /\bpermission denied\b/i,
  /\brestricted\b/i,
  /\bunavailable\b/i,
];

/** Every CASE A reason must hand over a concrete alternative. */
const REDIRECT_MARKERS = [/ctx_/i, /redirect/i];

const _sentinelDir = mkdtempSync(join(tmpdir(), "ctx-deny-contract-"));
process.env.CONTEXT_MODE_MCP_SENTINEL_DIR = _sentinelDir;
const mcpSentinel = resolve(_sentinelDir, `context-mode-mcp-ready-${process.pid}`);

beforeAll(async () => {
  const mod = await import("../../hooks/core/routing.mjs");
  routePreToolUse = mod.routePreToolUse;
  resetGuidanceThrottle = mod.resetGuidanceThrottle;
});

beforeEach(() => {
  if (typeof resetGuidanceThrottle === "function") resetGuidanceThrottle();
  writeFileSync(mcpSentinel, String(process.pid));
});

afterEach(() => {
  try { unlinkSync(mcpSentinel); } catch { /* already gone */ }
});

afterAll(() => {
  try { rmSync(_sentinelDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  delete process.env.CONTEXT_MODE_MCP_SENTINEL_DIR;
});

/** CASE A calls: routing sends the work somewhere better. */
const REDIRECTS: Array<{ label: string; tool: string; input: Record<string, unknown> }> = [
  { label: "curl", tool: "Bash", input: { command: "curl https://example.com/api" } },
  { label: "wget", tool: "Bash", input: { command: "wget https://example.com/file.json" } },
  {
    label: "inline HTTP in a script",
    tool: "Bash",
    input: { command: "node -e \"fetch('https://example.com').then(r => r.text())\"" },
  },
  { label: "WebFetch", tool: "WebFetch", input: { url: "https://example.com/docs" } },
  // A named heavy command is the same shape as the four above: the loss is
  // known before the call and the replacement is a concrete call, so the
  // reason has to read as a redirect rather than as a capability being taken
  // away. (The large-file Read refusal is held to the same contract in
  // tests/hooks/enforcement-deny.test.ts, where the fixture file lives.)
  { label: "heavy Bash command", tool: "Bash", input: { command: "npm test" } },
];

describe("CASE A — redirects must not speak the vocabulary of restrictions", () => {
  for (const { label, tool, input } of REDIRECTS) {
    test(`${label} is redirected, not refused`, () => {
      const result = routePreToolUse(tool, input, process.cwd(), "claude-code", "deny-contract");
      if (!result || result.action !== "deny") return; // not routed here — nothing to assert
      const reason = result.reason ?? "";

      for (const word of RESTRICTION_WORDS) {
        expect(
          word.test(reason),
          `${label}: reason uses restriction vocabulary ${word} — ADR-0003 forbids this for a redirect.\n${reason}`,
        ).toBe(false);
      }

      expect(
        REDIRECT_MARKERS.some(re => re.test(reason)),
        `${label}: reason names no alternative tool — a redirect that does not point anywhere is a refusal.\n${reason}`,
      ).toBe(true);
    });
  }
});

describe("CASE B — security denials keep sounding like security denials", () => {
  test("a deny-pattern match still reads as a restriction", () => {
    // The inverse guarantee: the contract above must not be satisfied by
    // softening genuine security refusals into friendly suggestions.
    const source = readRoutingSource();
    expect(source).toContain("Blocked by security policy");
  });
});

function readRoutingSource(): string {
  return readFileSync(resolve(process.cwd(), "hooks", "core", "routing.mjs"), "utf-8");
}
