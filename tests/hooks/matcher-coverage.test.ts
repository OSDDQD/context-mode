/**
 * The seventh sentinel: a rule the host never delivers is not a rule.
 *
 * Six defects in one wave shared a shape — a mechanism written, working, and
 * not wired to the surface that would reach it. The worst of them was `Glob`:
 * `hooks/core/routing.mjs` carried a dedicated `isUnboundedGlob` helper, a
 * decision branch, the replacement text and a comment explaining the policy,
 * while `PRE_TOOL_USE_MATCHERS` did not list `Glob`, so Claude Code never
 * delivered one. The branch ran nowhere.
 *
 * It was worse than a dead branch. `FLOODY_TOOLS` has always listed Glob, so a
 * big listing was charged on the way OUT — price line, unrouted tally,
 * escalation ladder, adherence denominator — while the matcher gave it no way
 * IN. Penalty without warning.
 *
 * And four test files "covered" the branch by calling `routePreToolUse`
 * directly with a payload no host would ever hand it, so everything was green
 * throughout. Those unit tests are fine and stay; what was missing is a test
 * that asks the question in the other direction — does anything actually
 * deliver this tool to the hook — plus one end-to-end case that runs the real
 * hook script the way the host runs it.
 *
 * Reading the lists out of source rather than importing them is deliberate:
 * the invariant is that two hand-maintained lists agree, so the test has to
 * read both as written. A new branch or a new matcher entry is picked up with
 * no edit here.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PRE_TOOL_USE_MATCHERS } from "../../src/adapters/claude-code/hooks.js";

const REPO_ROOT = resolve(__dirname, "..", "..");
const ROUTING_SRC = readFileSync(join(REPO_ROOT, "hooks", "core", "routing.mjs"), "utf-8");

// ── The three lists, read as written ──────────────────────────────────────

/**
 * Canonical tool names the PreToolUse router has a decision branch for.
 *
 * Two shapes: native tools are matched on the canonicalised name, and
 * context-mode's own tools go through `matchesContextModeTool`, which strips
 * the host's MCP prefix before comparing.
 */
const BRANCH_TOOLS: string[] = [
  ...new Set([...ROUTING_SRC.matchAll(/canonical === "([A-Za-z_.]+)"/g)].map((m) => m[1])),
].sort();

const CTX_BRANCH_TOOLS: string[] = [
  ...new Set(
    [...ROUTING_SRC.matchAll(/matchesContextModeTool\(toolName, "(ctx_[a-z_]+)"/g)].map((m) => m[1]),
  ),
].sort();

/** Native tools whose whole payload lands in the conversation. */
const FLOODY_TOOLS: string[] = (() => {
  const m = ROUTING_SRC.match(/const FLOODY_TOOLS = new Set\(\[([^\]]*)\]\)/);
  if (!m) throw new Error("FLOODY_TOOLS not found in hooks/core/routing.mjs");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
})();

/** Host-native tool name → canonical name, as the router normalises it. */
const TOOL_ALIASES: Record<string, string> = (() => {
  const m = ROUTING_SRC.match(/const TOOL_ALIASES = \{([\s\S]*?)\n\};/);
  if (!m) throw new Error("TOOL_ALIASES not found in hooks/core/routing.mjs");
  return Object.fromEntries(
    [...m[1].matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g)].map((x) => [x[1], x[2]]),
  );
})();

const HOSTS = [
  { name: "claude-code", matchers: [...PRE_TOOL_USE_MATCHERS] as string[] },
] as const;

/**
 * Does this host's matcher list deliver `tool` to the PreToolUse hook?
 *
 * Matchers are patterns tested against the tool name, which is why `mcp__`
 * catches every MCP tool by substring. The tool is checked under every name
 * the host might use for it, since the router canonicalises on the way in.
 */
function delivers(matchers: readonly string[], canonical: string): boolean {
  const names = [canonical, ...Object.entries(TOOL_ALIASES)
    .filter(([, c]) => c === canonical)
    .map(([raw]) => raw)];
  return matchers.some((m) => names.some((n) => new RegExp(m).test(n)));
}

/**
 * Branches a host cannot reach, and why. An entry here is a statement that the
 * host HAS NO SUCH TOOL — not that the wiring is missing. Anything not listed
 * has to be delivered.
 */
const UNREACHABLE: Record<string, Record<string, string>> = {
  "claude-code": {},
};

/**
 * Gaps that are NOT design decisions — deliberately a separate table from
 * UNREACHABLE so neither can be mistaken for the other.
 *
 * An entry here says: this tool has a decision branch, the host may well emit
 * it, and the matcher does not deliver it. Frozen rather than required to be
 * empty so the suite stays green while the fact stays impossible to lose:
 * closing a gap fails this test (shrink the list), opening a new one fails it
 * too.
 *
 * Empty since the Codex removal: its `Read` gap was the only entry, found by
 * this file on its first run, and it left with the host. The table stays
 * because the shape of that finding is the point — a decision branch the host
 * never delivers is invisible to every unit test that calls the router
 * directly, which is how the Glob defect survived four of them.
 */
const KNOWN_GAPS: Record<string, readonly string[]> = {
  "claude-code": [],
};

/**
 * Matcher entries with no decision branch behind them, and why they are still
 * listed. A matcher costs a hook subprocess before every matching call, so an
 * entry that decides nothing is a latency bill with no payer — see the
 * non-overlap docblock on PRE_TOOL_USE_MATCHERS for the same argument.
 */
const MATCHER_WITHOUT_BRANCH: Record<string, Record<string, string>> = {
  "claude-code": {
    mcp__: "Catch-all for external MCP tools; the branch is in the hook body (isExternalMcpTool), not on a canonical name.",
  },
};

describe("every routed tool is delivered by the host that has it", () => {
  it("the router's branch list is non-trivial (guards the parse itself)", () => {
    // A regex that silently stops matching would make every assertion below
    // pass on an empty set — the exact failure shape this file exists to catch.
    expect(BRANCH_TOOLS).toContain("Glob");
    expect(BRANCH_TOOLS.length).toBeGreaterThanOrEqual(6);
    expect(FLOODY_TOOLS.length).toBeGreaterThanOrEqual(6);
    expect(Object.keys(TOOL_ALIASES).length).toBeGreaterThanOrEqual(6);
    expect(CTX_BRANCH_TOOLS).toContain("ctx_execute");
  });

  for (const host of HOSTS) {
    it(`${host.name}: every tool with a decision branch reaches the hook`, () => {
      const missing = BRANCH_TOOLS.filter(
        (tool) =>
          !delivers(host.matchers, tool) &&
          !UNREACHABLE[host.name][tool] &&
          !KNOWN_GAPS[host.name].includes(tool),
      );
      expect(
        missing,
        `${host.name} routes these tools but never delivers them:\n` +
          missing.map((t) => `  ${t} — add it to the matcher list, or to UNREACHABLE with the reason`).join("\n"),
      ).toEqual([]);
    });

    it(`${host.name}: every tool charged on the way out can be warned on the way in`, () => {
      // The Glob defect stated as an invariant: a tool in FLOODY_TOOLS is
      // counted against the session when it floods. Counting a tool the hook
      // is never asked about is a penalty with no possible warning.
      const canonicalFloody = [...new Set(FLOODY_TOOLS.map((t) => TOOL_ALIASES[t] ?? t))].sort();
      const charged = canonicalFloody.filter(
        (tool) =>
          !delivers(host.matchers, tool) &&
          !UNREACHABLE[host.name][tool] &&
          !KNOWN_GAPS[host.name].includes(tool),
      );
      expect(
        charged,
        `${host.name} charges these tools on the way out with no way to warn on the way in:\n` +
          charged.map((t) => `  ${t}`).join("\n"),
      ).toEqual([]);
    });

    it(`${host.name}: every matcher entry has a branch behind it, or a stated reason`, () => {
      // Reverse direction. Not a correctness bug on its own, which is why the
      // expected set is frozen rather than required to be empty: a new entry
      // that decides nothing has to be justified in writing, and removing a
      // listed one has to be deliberate.
      const unexplained = host.matchers.filter((m) => {
        const canonical = TOOL_ALIASES[m] ?? m;
        if (BRANCH_TOOLS.includes(canonical)) return false;
        if (CTX_BRANCH_TOOLS.includes(m)) return false;
        return !MATCHER_WITHOUT_BRANCH[host.name][m];
      });
      expect(
        unexplained,
        `${host.name} matcher entries that decide nothing:\n${unexplained.join("\n")}`,
      ).toEqual([]);

      const stale = Object.keys(MATCHER_WITHOUT_BRANCH[host.name]).filter(
        (m) => !host.matchers.includes(m),
      );
      expect(stale, `${host.name}: MATCHER_WITHOUT_BRANCH names entries that are gone`).toEqual([]);
    });

    it(`${host.name}: the known-gap list is exactly the gaps that still exist`, () => {
      // Both directions. A gap that got fixed must be removed from the list,
      // and a gap listed for a tool the host does deliver is a stale excuse.
      const stillMissing = KNOWN_GAPS[host.name].filter((t) => !delivers(host.matchers, t));
      expect(
        stillMissing,
        `${host.name}: a known gap was closed — delete it from KNOWN_GAPS`,
      ).toEqual([...KNOWN_GAPS[host.name]]);

      for (const tool of KNOWN_GAPS[host.name]) {
        expect(BRANCH_TOOLS, `${host.name}: ${tool} is listed as a gap but has no branch`).toContain(tool);
        expect(
          UNREACHABLE[host.name][tool],
          `${host.name}: ${tool} cannot be both a gap and a host that has no such tool`,
        ).toBeUndefined();
      }
    });
  }
});

// ── End-to-end: the real hook script, on a real Glob payload ──────────────

describe("Glob: wired, and answered by the hook the host actually runs", () => {
  const HOOK = join(REPO_ROOT, "hooks", "pretooluse.mjs");
  let scratch: string;
  let sentinelDir: string;

  function run(toolInput: Record<string, unknown>): { permissionDecision?: string; permissionDecisionReason?: string } {
    const home = join(scratch, "home");
    const r = spawnSync("node", [HOOK], {
      input: JSON.stringify({
        session_id: `matcher-coverage-${process.pid}`,
        cwd: scratch,
        tool_name: "Glob",
        tool_input: toolInput,
      }),
      encoding: "utf-8",
      timeout: 60_000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        CLAUDE_PROJECT_DIR: scratch,
        CLAUDE_SESSION_ID: `matcher-coverage-${process.pid}`,
        CONTEXT_MODE_SESSION_SUFFIX: "",
        CONTEXT_MODE_MCP_SENTINEL_DIR: sentinelDir,
      },
    });
    try {
      return JSON.parse((r.stdout ?? "").trim()).hookSpecificOutput ?? {};
    } catch {
      return {};
    }
  }

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "ctx-glob-"));
    sentinelDir = mkdtempSync(join(tmpdir(), "ctx-glob-sentinel-"));
    writeFileSync(resolve(sentinelDir, `context-mode-mcp-ready-${process.pid}`), String(process.pid));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(sentinelDir, { recursive: true, force: true });
  });

  it("Glob is in the matcher list the host is handed", () => {
    // Without this the two cases below prove nothing: they invoke the hook
    // themselves, which is exactly how the defect stayed green for so long.
    expect([...PRE_TOOL_USE_MATCHERS]).toContain("Glob");
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, "hooks", "hooks.json"), "utf-8"),
    ) as { hooks: { PreToolUse: Array<{ matcher: string }> } };
    expect(manifest.hooks.PreToolUse.map((e) => e.matcher)).toContain("Glob");
  });

  it("an unbounded Glob is asked about, naming ctx_find", () => {
    const out = run({ pattern: "**/*" });
    expect(out.permissionDecision).toBe("ask");
    expect(out.permissionDecisionReason ?? "").toContain("ctx_find");
  });

  it("a bounded Glob passes through untouched", () => {
    const out = run({ pattern: "**/*.ts", path: "src" });
    expect(out.permissionDecision).toBeUndefined();
  });

});
