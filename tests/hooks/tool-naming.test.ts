/**
 * Tool naming across the supported hosts.
 *
 * A tool name is what the agent has to type. Guidance naming `ctx_find` on a
 * host whose wire name is `mcp__plugin_context-mode_context-mode__ctx_find` is
 * guidance nobody can act on, so every message these hooks build goes through
 * a namer bound to the running host — and every one of those call sites is a
 * place where the binding can be forgotten.
 *
 * This file used to enumerate seventeen hosts with one hand-written example
 * each: `getToolName("zed", …)` equals this string, the Grep guidance for
 * OpenCode contains that one. Seventeen examples is not seventeen checks —
 * each factory was exercised on exactly one platform, so a factory that
 * ignored its namer everywhere except the platform someone happened to pick
 * would have passed.
 *
 * Two hosts made the enumeration cheap enough to replace with the property it
 * was standing in for: for EVERY factory and EVERY host, every ctx_* name in
 * the output is spelled the way that host spells it, and no name from the
 * other host leaks in. That runs the full cross-product, which the seventeen-
 * row version never did.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

interface Decision {
  action: string;
  reason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
}

let getToolName: (platform: string, bareTool: string) => string;
let createToolNamer: (platform: string) => (bareTool: string) => string;
let KNOWN_PLATFORMS: string[];
let routePreToolUse: (
  toolName: string,
  toolInput: Record<string, unknown>,
  projectDir?: string,
  platform?: string,
) => Decision | null;
let resetGuidanceThrottle: () => void;
let formatters: Record<string, unknown>;
let createRoutingBlock: (t: (tool: string) => string) => string;
let createReadGuidance: (t: (tool: string) => string) => string;
let createGrepGuidance: (t: (tool: string) => string) => string;
let createBashGuidance: (t: (tool: string) => string) => string;
let createExternalMcpGuidance: (t: (tool: string) => string) => string;
let ROUTING_BLOCK: string;
let READ_GUIDANCE: string;
let GREP_GUIDANCE: string;
let BASH_GUIDANCE: string;
let EXTERNAL_MCP_GUIDANCE: string;

beforeAll(async () => {
  const naming = await import("../../hooks/core/tool-naming.mjs");
  getToolName = naming.getToolName;
  createToolNamer = naming.createToolNamer;
  KNOWN_PLATFORMS = naming.KNOWN_PLATFORMS;

  const routing = await import("../../hooks/core/routing.mjs");
  routePreToolUse = routing.routePreToolUse;
  resetGuidanceThrottle = routing.resetGuidanceThrottle;

  formatters = (await import("../../hooks/core/formatters.mjs")).formatters;

  const block = await import("../../hooks/routing-block.mjs");
  createRoutingBlock = block.createRoutingBlock;
  createReadGuidance = block.createReadGuidance;
  createGrepGuidance = block.createGrepGuidance;
  createBashGuidance = block.createBashGuidance;
  createExternalMcpGuidance = block.createExternalMcpGuidance;
  ROUTING_BLOCK = block.ROUTING_BLOCK;
  READ_GUIDANCE = block.READ_GUIDANCE;
  GREP_GUIDANCE = block.GREP_GUIDANCE;
  BASH_GUIDANCE = block.BASH_GUIDANCE;
  EXTERNAL_MCP_GUIDANCE = block.EXTERNAL_MCP_GUIDANCE;
});

// MCP readiness sentinel — routing.mjs checks process.ppid in-process
const _sentinelDir = process.platform === "win32" ? tmpdir() : "/tmp";
const mcpSentinel = resolve(_sentinelDir, `context-mode-mcp-ready-${process.pid}`);

beforeEach(() => {
  if (typeof resetGuidanceThrottle === "function") resetGuidanceThrottle();
  writeFileSync(mcpSentinel, String(process.pid));
});

afterEach(() => {
  try { unlinkSync(mcpSentinel); } catch { /* already gone */ }
});

/** The wire shape each host gives an MCP tool. */
const EXPECTED_NAMES: Record<string, (tool: string) => string> = {
  "claude-code": (tool) => `mcp__plugin_context-mode_context-mode__${tool}`,
  "codex": (tool) => tool,
};
const PLATFORMS = Object.keys(EXPECTED_NAMES);

/** Enough tools to catch a namer applied to some arguments and not others. */
const TOOLS = [
  "ctx_execute",
  "ctx_execute_file",
  "ctx_search",
  "ctx_find",
  "ctx_graph",
  "ctx_batch_execute",
  "ctx_fetch_and_index",
];

/**
 * Every ctx_* mention in a piece of guidance, with its prefix intact.
 *
 * The lookbehind skips XML tags: the routing block wraps a section in
 * `<ctx_commands>`, which is markup the host never calls and which no namer
 * should ever have touched.
 */
function ctxMentions(text: string): string[] {
  return [...text.matchAll(/(?<![<\/])(?:mcp__[A-Za-z0-9_-]*__)?ctx_[a-z_]+/g)].map((m) => m[0]);
}

/**
 * The property every guidance factory has to satisfy on every host: each ctx_*
 * name is spelled that host's way, and nothing spelled the other host's way
 * appears at all.
 */
function expectNamedFor(platform: string, text: string, label: string): void {
  const name = EXPECTED_NAMES[platform];
  const mentions = ctxMentions(text);
  expect(mentions.length, `${label} on ${platform} names no ctx_* tool at all`).toBeGreaterThan(0);
  for (const mention of mentions) {
    const bare = mention.replace(/^mcp__[A-Za-z0-9_-]*__/, "");
    expect(mention, `${label} on ${platform}: "${mention}" is not how ${platform} spells it`).toBe(name(bare));
  }
  for (const other of PLATFORMS.filter((p) => p !== platform)) {
    // Only meaningful when the other host's spelling is distinguishable —
    // Codex's bare names are a substring of every prefixed name, so the leak
    // check runs in the direction that can actually detect one.
    const sample = EXPECTED_NAMES[other]("ctx_execute");
    if (sample.startsWith("mcp__")) {
      expect(text, `${label} on ${platform} leaks ${other} naming`).not.toContain("mcp__");
    }
  }
}

describe("getToolName", () => {
  for (const platform of PLATFORMS) {
    it(`spells every tool the ${platform} way`, () => {
      for (const tool of TOOLS) {
        expect(getToolName(platform, tool)).toBe(EXPECTED_NAMES[platform](tool));
      }
    });
  }

  it("falls back to claude-code for an unknown platform", () => {
    // A host we have never heard of gets the convention most likely to work
    // rather than a bare name that resolves to nothing.
    expect(getToolName("nonexistent-host", "ctx_execute")).toBe(
      "mcp__plugin_context-mode_context-mode__ctx_execute",
    );
    expect(getToolName(undefined as unknown as string, "ctx_execute")).toBe(
      "mcp__plugin_context-mode_context-mode__ctx_execute",
    );
  });
});

describe("createToolNamer", () => {
  it("agrees with getToolName for every host and every tool", () => {
    // The namer is what the factories are handed; a divergence between the two
    // entry points would show up as guidance that is wrong on one code path
    // and right on the other.
    for (const platform of [...PLATFORMS, "nonexistent-host"]) {
      const namer = createToolNamer(platform);
      for (const tool of TOOLS) {
        expect(namer(tool)).toBe(getToolName(platform, tool));
      }
    }
  });
});

describe("KNOWN_PLATFORMS", () => {
  it("is exactly the supported set", () => {
    expect([...KNOWN_PLATFORMS].sort()).toEqual([...PLATFORMS].sort());
  });

  it("has a response formatter for every host it can name", () => {
    // The gap the old per-platform enumeration left open: a host could have a
    // namer and no formatter, and every naming test would still pass while the
    // hook emitted nothing the host understood.
    for (const platform of KNOWN_PLATFORMS) {
      expect(formatters[platform], `${platform} has a namer but no formatter`).toBeDefined();
    }
    for (const platform of Object.keys(formatters)) {
      expect(
        KNOWN_PLATFORMS,
        `${platform} has a formatter but no namer — its guidance would fall back to claude-code names`,
      ).toContain(platform);
    }
  });
});

describe("guidance factories name tools the host's way", () => {
  const factories: Array<[string, () => (t: (tool: string) => string) => string]> = [
    ["createRoutingBlock", () => createRoutingBlock],
    ["createReadGuidance", () => createReadGuidance],
    ["createGrepGuidance", () => createGrepGuidance],
    ["createBashGuidance", () => createBashGuidance],
    ["createExternalMcpGuidance", () => createExternalMcpGuidance],
  ];

  // The full cross-product — the thing seventeen one-off examples never ran.
  for (const [name, get] of factories) {
    for (const platform of PLATFORMS) {
      it(`${name} × ${platform}`, () => {
        expectNamedFor(platform, get()(createToolNamer(platform)), name);
      });
    }
  }

  it("createExternalMcpGuidance still states what to do with a large payload", () => {
    for (const platform of PLATFORMS) {
      const text = createExternalMcpGuidance(createToolNamer(platform));
      expect(text).toMatch(/filter|count|aggregate/i);
      expect(text).toContain(getToolName(platform, "ctx_execute"));
    }
  });
});

describe("backward compat static exports", () => {
  const statics: Array<[string, () => string]> = [
    ["ROUTING_BLOCK", () => ROUTING_BLOCK],
    ["READ_GUIDANCE", () => READ_GUIDANCE],
    ["GREP_GUIDANCE", () => GREP_GUIDANCE],
    ["BASH_GUIDANCE", () => BASH_GUIDANCE],
    ["EXTERNAL_MCP_GUIDANCE", () => EXTERNAL_MCP_GUIDANCE],
  ];

  for (const [name, get] of statics) {
    it(`${name} defaults to claude-code naming`, () => {
      expectNamedFor("claude-code", get(), name);
    });
  }

  it("each static equals its factory bound to claude-code", () => {
    const t = createToolNamer("claude-code");
    expect(ROUTING_BLOCK).toBe(createRoutingBlock(t));
    expect(READ_GUIDANCE).toBe(createReadGuidance(t));
    expect(GREP_GUIDANCE).toBe(createGrepGuidance(t));
    expect(BASH_GUIDANCE).toBe(createBashGuidance(t));
    expect(EXTERNAL_MCP_GUIDANCE).toBe(createExternalMcpGuidance(t));
  });
});

describe("routePreToolUse names tools the host's way", () => {
  /** Every routed path that puts a tool name in front of the agent. */
  const paths: Array<[string, string, Record<string, unknown>, (d: Decision) => string]> = [
    ["curl redirect", "Bash", { command: "curl https://example.com" },
      (d) => String((d.updatedInput as Record<string, string>)?.command ?? d.reason ?? "")],
    ["inline HTTP redirect", "Bash", { command: 'python -c "requests.get(\'http://example.com\')"' },
      (d) => String((d.updatedInput as Record<string, string>)?.command ?? d.reason ?? "")],
    ["build tool redirect", "Bash", { command: "./gradlew build" },
      (d) => String((d.updatedInput as Record<string, string>)?.command ?? d.reason ?? "")],
    ["WebFetch deny", "WebFetch", { url: "https://example.com" }, (d) => String(d.reason ?? "")],
    ["Bash advisory", "Bash", { command: "ps aux" }, (d) => String(d.additionalContext ?? "")],
    ["Read advisory", "Read", { file_path: "/tmp/does-not-exist.ts" }, (d) => String(d.additionalContext ?? "")],
    ["Grep advisory", "Grep", { pattern: "TODO" }, (d) => String(d.additionalContext ?? "")],
  ];

  for (const [label, tool, input, extract] of paths) {
    for (const platform of PLATFORMS) {
      it(`${label} × ${platform}`, () => {
        resetGuidanceThrottle();
        const decision = routePreToolUse(tool, input, "/tmp", platform);
        expect(decision, `${label} on ${platform} produced no decision`).not.toBeNull();
        expectNamedFor(platform, extract(decision!), label);
      });
    }
  }

  it("defaults to claude-code naming when the platform is omitted", () => {
    const decision = routePreToolUse("Bash", { command: "curl https://example.com" }, "/tmp");
    const command = String((decision!.updatedInput as Record<string, string>).command);
    expect(command).toContain("mcp__plugin_context-mode_context-mode__ctx_fetch_and_index");
  });

  it("Task is not routed (#241)", () => {
    for (const platform of PLATFORMS) {
      expect(routePreToolUse("Task", { prompt: "Analyze the code" }, "/tmp", platform)).toBeNull();
    }
  });
});

describe("native tool names route through the canonical aliases", () => {
  // Codex names its executor several ways across releases, and all of them
  // have to land on the Bash branch — an alias that stops resolving does not
  // fail loudly, it just quietly stops enforcing anything on that host.
  const bashAliases = ["shell", "shell_command", "exec_command", "container.exec", "local_shell", "Shell"];

  for (const alias of bashAliases) {
    it(`${alias} routes as Bash`, () => {
      resetGuidanceThrottle();
      const decision = routePreToolUse(alias, { command: "curl https://example.com" }, "/tmp", "codex");
      expect(decision, `${alias} did not reach the Bash branch`).not.toBeNull();
      // Codex cannot rewrite a command unconditionally, so the decision shape
      // varies; what must hold is that the redirect names the replacement.
      const text = String(
        (decision!.updatedInput as Record<string, string>)?.command ?? decision!.reason ?? "",
      );
      expect(text).toContain("ctx_fetch_and_index");
    });
  }

  it("grep_files routes as Grep", () => {
    resetGuidanceThrottle();
    const decision = routePreToolUse("grep_files", { pattern: "TODO" }, "/tmp", "codex");
    expect(decision).not.toBeNull();
    expect(String(decision!.additionalContext ?? decision!.reason ?? "")).toContain("ctx_execute");
  });
});
