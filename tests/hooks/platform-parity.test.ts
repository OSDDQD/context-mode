/**
 * The two remaining hosts get the same decisions.
 *
 * Cutting seventeen platforms to two was worth doing only if the two are
 * actually held together. Nothing in a normal session checks that: this
 * repository is developed inside Claude Code, so the Claude Code path is
 * exercised constantly and the Codex path is exercised never. Until now the
 * gap was covered by sheer weight of per-platform tests; those are gone, and
 * the drift they would have caught is exactly the kind nobody notices —
 * a decision that reaches one host and evaporates on the other, with no error
 * anywhere.
 *
 * It had already happened. Writing this file is what surfaced it: the Codex
 * PreToolUse hook wrote no redirect marker and its PostToolUse read none, so
 * on Codex nothing refused was ever counted as bytes avoided, and the
 * read-before-edit retry — the escape hatch the refusal itself offers —
 * arrived looking like a fresh violation and pushed the escalation ladder up a
 * step. The self-reinforcing loop had been fixed on one host and left running
 * on the other. Both halves are shared now (hooks/core/routing.mjs), and the
 * tests below are what keeps them shared.
 *
 * What is compared is MEANING, not bytes. The protocols genuinely differ —
 * that is what the formatters are for — so each response is reduced to what
 * the agent ends up experiencing (refused / asked / told / nothing) plus the
 * text, with the host's tool-naming convention normalised away. Where a host
 * genuinely cannot express something, the difference is asserted explicitly
 * with the reason, never smoothed over: a silent difference is precisely how
 * the plugin stopped working on half its hosts upstream.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  resetGuidanceThrottle,
  writeUnroutedTally,
  callKeyFor,
  redirectMarkerPathFor,
} from "../../hooks/core/routing.mjs";

const REPO_ROOT = resolve(__dirname, "..", "..");
const HOOKS = {
  "claude-code": {
    pre: join(REPO_ROOT, "hooks", "pretooluse.mjs"),
    post: join(REPO_ROOT, "hooks", "posttooluse.mjs"),
  },
  codex: {
    pre: join(REPO_ROOT, "hooks", "codex", "pretooluse.mjs"),
    post: join(REPO_ROOT, "hooks", "codex", "posttooluse.mjs"),
  },
} as const;

type Platform = keyof typeof HOOKS;
const PLATFORMS: Platform[] = ["claude-code", "codex"];

/** Codex's capability probe caches to this file; seeding it pins the regime. */
const CODEX_CAPS_CACHE = join(tmpdir(), "context-mode-codex-caps.json");

/**
 * What the agent actually experiences, with protocol details removed.
 *
 * `confirm` is a prompt to the user; `guidance` is text the agent reads while
 * the call proceeds; `silent` is nothing at all.
 */
interface Meaning {
  kind: "deny" | "confirm" | "guidance" | "silent";
  text: string;
}

/**
 * Strip the host's tool-naming convention so two texts that say the same thing
 * compare equal. Claude Code prefixes every MCP tool; Codex uses bare names.
 */
function denorm(text: string): string {
  return text.replace(/mcp__plugin_context-mode_context-mode__/g, "");
}

function meaningOf(stdout: string): Meaning {
  let out: Record<string, string> = {};
  try {
    out = JSON.parse(stdout).hookSpecificOutput ?? {};
  } catch {
    return { kind: "silent", text: "" };
  }
  if (out.permissionDecision === "deny") {
    return { kind: "deny", text: denorm(out.permissionDecisionReason ?? "") };
  }
  if (out.permissionDecision === "ask") {
    return { kind: "confirm", text: denorm(out.permissionDecisionReason ?? "") };
  }
  if (out.additionalContext) return { kind: "guidance", text: denorm(out.additionalContext) };
  return { kind: "silent", text: "" };
}

let scratch: string;
let sessionId: string;
let sentinelDir: string;
let counter = 0;

/**
 * A session id per host.
 *
 * The two hosts are two different sessions in real life, and sharing one id
 * here would let one host's state answer for the other: the Claude Code
 * refusal arms the read-before-edit window for a path, and the Codex run of
 * the same case would then take the promised-repeat branch and look like it
 * had refused nothing.
 */
function sessionFor(platform: Platform): string {
  return `${sessionId}-${platform}`;
}

/** Seed the unrouted tally for both hosts, so the ladder starts level. */
function seedTally(tally: { count: number; bytes: number }): void {
  for (const platform of PLATFORMS) writeUnroutedTally(sessionFor(platform), tally);
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "ctx-parity-"));
  sessionId = `parity-${process.pid}-${++counter}`;
  sentinelDir = mkdtempSync(join(tmpdir(), "ctx-parity-sentinel-"));
  writeFileSync(resolve(sentinelDir, `context-mode-mcp-ready-${process.pid}`), String(process.pid));
  for (const platform of PLATFORMS) resetGuidanceThrottle(`${sessionId}-${platform}`);
  // Pin the Codex capability regime instead of probing for a `codex` binary
  // that may or may not exist on the machine running the suite. Modern by
  // default; the "old build" cases seed it the other way.
  setCodexCaps(true);
});

afterEach(() => {
  // resetGuidanceThrottle drops each host's whole marker directory — refusals,
  // accounted-for calls and consent markers alike — so no leftover from one
  // case can be swept into the next one's accounting.
  for (const platform of PLATFORMS) resetGuidanceThrottle(`${sessionId}-${platform}`);
  try { unlinkSync(CODEX_CAPS_CACHE); } catch { /* gone */ }
  rmSync(scratch, { recursive: true, force: true });
  rmSync(sentinelDir, { recursive: true, force: true });
});

function setCodexCaps(supported: boolean): void {
  writeFileSync(CODEX_CAPS_CACHE, JSON.stringify({ at: Date.now(), supported }));
}

function envFor(platform: Platform, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const home = join(scratch, platform);
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_PROJECT_DIR: scratch,
    CLAUDE_SESSION_ID: sessionFor(platform),
    CONTEXT_MODE_SESSION_SUFFIX: "",
    CONTEXT_MODE_MCP_SENTINEL_DIR: sentinelDir,
    ...extra,
  };
}

function runHook(
  hookPath: string,
  platform: Platform,
  payload: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): string {
  const r = spawnSync("node", [hookPath], {
    input: JSON.stringify({ session_id: sessionFor(platform), cwd: scratch, ...payload }),
    encoding: "utf-8",
    timeout: 60_000,
    env: envFor(platform, extraEnv),
  });
  return (r.stdout ?? "").trim();
}

function pre(
  platform: Platform,
  tool: string,
  toolInput: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): Meaning {
  return meaningOf(runHook(HOOKS[platform].pre, platform, { tool_name: tool, tool_input: toolInput }, extraEnv));
}

function post(
  platform: Platform,
  tool: string,
  toolInput: Record<string, unknown>,
  responseBytes: number,
): string {
  const stdout = runHook(HOOKS[platform].post, platform, {
    tool_name: tool,
    tool_input: toolInput,
    tool_response: "x".repeat(responseBytes),
  });
  try {
    return denorm(JSON.parse(stdout).hookSpecificOutput?.additionalContext ?? "");
  } catch {
    return "";
  }
}

function makeFile(name: string, size: number): string {
  const path = join(scratch, name);
  writeFileSync(path, "x".repeat(size));
  return path;
}

/** Run one PreToolUse case on both hosts. */
function both(
  tool: string,
  toolInput: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): Record<Platform, Meaning> {
  return {
    "claude-code": pre("claude-code", tool, toolInput, extraEnv),
    codex: pre("codex", tool, toolInput, extraEnv),
  };
}

describe("refusals reach both hosts, with the same replacement", () => {
  it("D2: a large Read is refused on both, naming the same tool and path", () => {
    const file = makeFile("big.ts", 120_000);
    const m = both("Read", { file_path: file });

    for (const platform of PLATFORMS) {
      expect(m[platform].kind, `${platform} did not refuse`).toBe("deny");
      expect(m[platform].text).toContain("ctx_execute_file");
      expect(m[platform].text).toContain(file);
      expect(m[platform].text, `${platform} dropped the escape hatch`).toMatch(/Read again/i);
    }
    // Same words, once the naming convention is normalised away. Anything
    // weaker would pass while one host quietly said something else.
    expect(m.codex.text).toBe(m["claude-code"].text);
  });

  it("D2: a heavy Bash command is refused on both, with the same ready call", () => {
    const m = both("Bash", { command: "npm test" });
    for (const platform of PLATFORMS) {
      expect(m[platform].kind, `${platform} did not refuse`).toBe("deny");
      expect(m[platform].text).toContain("ctx_batch_execute");
      expect(m[platform].text).toContain(JSON.stringify("npm test"));
    }
    expect(m.codex.text).toBe(m["claude-code"].text);
  });

  it("D1: the top of the ladder refuses on both", () => {
    seedTally({ count: 9, bytes: 400_000 });
    const m = both("Bash", { command: "ps aux" });
    for (const platform of PLATFORMS) {
      expect(m[platform].kind, `${platform} did not refuse at the top of the ladder`).toBe("deny");
      expect(m[platform].text).toContain("ctx_batch_execute");
    }
    expect(m.codex.text).toBe(m["claude-code"].text);
  });
});

describe("the price line reaches both hosts", () => {
  it("D3: an unrouted heavy call is charged on both, in the same words", () => {
    const notices: Record<string, string> = {};
    for (const platform of PLATFORMS) {
      notices[platform] = post(platform, "Read", { file_path: "/a.ts" }, 43_008);
      expect(notices[platform], `${platform} charged nothing`).toContain("42.0 KB");
      expect(notices[platform]).toContain("ctx_execute_file");
    }
    expect(notices.codex).toBe(notices["claude-code"]);
  });

  it("D3: a routed session is charged nothing on either host", () => {
    for (const platform of PLATFORMS) {
      expect(post(platform, "Write", { file_path: "/x.ts" }, 43_008), platform).toBe("");
    }
  });
});

describe("the read-before-edit escape hatch works on both hosts", () => {
  // The bug this file found. On Codex the retry used to be recorded as a fresh
  // violation because no marker was written or read, so using the way out the
  // refusal offered made the next refusal harsher.
  for (const platform of PLATFORMS) {
    it(`${platform}: the promised repeat goes through and is not a violation`, () => {
      const file = makeFile(`mid-${platform}.ts`, 20_000);
      const env = { CONTEXT_MODE_READ_DENY_BYTES: "10000" };
      const toolInput = { file_path: file };

      expect(pre(platform, "Read", toolInput, env).kind).toBe("deny");
      expect(pre(platform, "Read", toolInput, env).kind, "the repeat must go through").toBe("silent");

      // The repeat expects its own PostToolUse, so its marker is filed under
      // the key both hooks derive from the same call — ask routing.mjs for the
      // path rather than spelling it, or the test pins yesterday's layout.
      const markerPath = redirectMarkerPathFor(sessionFor(platform), {
        callKey: callKeyFor({ tool_name: "Read", tool_input: toolInput }),
      });
      expect(existsSync(markerPath), `${platform} wrote no accounted-for marker`).toBe(true);
      expect(readFileSync(markerPath, "utf-8").startsWith("Read:read-edit-exempt:0:")).toBe(true);

      // And PostToolUse must consume it rather than charge the read.
      expect(post(platform, "Read", { file_path: file }, 20_000), `${platform} charged the promised repeat`).toBe("");
    });
  }
});

describe("known differences, stated rather than smoothed over", () => {
  it("a confirmation becomes guidance on Codex — it has no prompt to show", () => {
    // Codex rejects permissionDecision:"ask" outright (codex-rs
    // output_parser.rs), so the confirmation cannot be asked for. What must
    // NOT happen is the decision vanishing: the same sentence is delivered as
    // guidance, which is weaker than a prompt but stronger than silence.
    const m = both("Grep", { pattern: "handleRequest", output_mode: "content" });

    expect(m["claude-code"].kind).toBe("confirm");
    expect(m.codex.kind).toBe("guidance");
    expect(m.codex.text).toBe(m["claude-code"].text);
  });

  it("on a Codex build too old for additionalContext, guidance is dropped — and only guidance", () => {
    // The honest limit. Pre-0.141 Codex ignores additionalContext in
    // PreToolUse, so advisory steps have nowhere to go. Refusals still land,
    // which is why the ladder never becomes softer as it climbs on that build:
    // it goes silent, silent, silent, deny rather than inverting.
    setCodexCaps(false);

    const advisory = pre("codex", "Grep", { pattern: "x", output_mode: "content" });
    expect(advisory.kind, "an old build cannot show guidance").toBe("silent");

    const refusal = pre("codex", "Bash", { command: "npm test" });
    expect(refusal.kind, "refusals must land on every build").toBe("deny");
    expect(refusal.text).toContain("ctx_batch_execute");
  });

  it("the PostToolUse price line has a channel on both hosts", () => {
    // Worth pinning because it is the one place the two protocols agree
    // exactly, and a future divergence here would silently delete the
    // feedback the whole wave is built on.
    const notice = post("codex", "Read", { file_path: "/big.ts" }, 43_008);
    expect(notice).toContain("42.0 KB");
  });
});

describe("the ladder climbs identically on both hosts", () => {
  const steps: Array<[string, { count: number; bytes: number }, Meaning["kind"]]> = [
    ["silent", { count: 1, bytes: 5_000 }, "silent"],
    ["advise", { count: 3, bytes: 40_000 }, "guidance"],
    ["redirect", { count: 6, bytes: 80_000 }, "deny"],
    ["deny", { count: 9, bytes: 120_000 }, "deny"],
  ];

  for (const [label, tally, codexKind] of steps) {
    it(`${label}: same step, same text`, () => {
      seedTally(tally);
      const m = both("Bash", { command: "ps aux" });

      // Claude Code's extra gear — the confirmation prompt — belongs to Grep
      // now, not to Bash: since ADR-0025 the Bash rung redirects on both
      // hosts, so kind and text agree the whole way up.
      expect(m.codex.kind, `codex at step ${label}`).toBe(codexKind);
      expect(m["claude-code"].kind, `claude-code at step ${label}`).toBe(codexKind);

      expect(m.codex.text, `step ${label} says different things on the two hosts`)
        .toBe(m["claude-code"].text);
    });
  }
});
