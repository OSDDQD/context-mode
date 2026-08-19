/**
 * Compact tool descriptions (#1031).
 *
 * The authored descriptions are ~29.4K characters (~7.4K tokens) of steering
 * prose shipped on every request; the compact set measures ~5.6K characters
 * (~1.4K tokens). These tests pin the compact default and the escape hatch,
 * assert the compact text still carries the signals a cold model needs, and —
 * since the table silently fell out of step with the tool surface once — that
 * every registered tool is either in the table or exempt for a stated reason.
 */

import { describe, expect, test, afterEach } from "vitest";
import { resolveToolDescription, shouldServeFullDescriptions, REGISTERED_CTX_TOOLS } from "../../src/server.js";

const ORIGINAL = process.env.CONTEXT_MODE_TOOL_DESCRIPTIONS;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CONTEXT_MODE_TOOL_DESCRIPTIONS;
  else process.env.CONTEXT_MODE_TOOL_DESCRIPTIONS = ORIGINAL;
});

describe("resolveToolDescription", () => {
  test("compact by default", () => {
    delete process.env.CONTEXT_MODE_TOOL_DESCRIPTIONS;
    const out = resolveToolDescription("ctx_execute", "VERBOSE ORIGINAL");
    expect(out).not.toBe("VERBOSE ORIGINAL");
    // "separate subprocess", not "sandboxed subprocess" — ADR-0006.
    expect(String(out)).toContain("subprocess");
  });

  test("CONTEXT_MODE_TOOL_DESCRIPTIONS=full restores the authored text", () => {
    process.env.CONTEXT_MODE_TOOL_DESCRIPTIONS = "full";
    expect(resolveToolDescription("ctx_execute", "VERBOSE ORIGINAL")).toBe("VERBOSE ORIGINAL");
  });

  test("tools without a compact entry keep their original description", () => {
    delete process.env.CONTEXT_MODE_TOOL_DESCRIPTIONS;
    expect(resolveToolDescription("ctx_doctor", "DIAGNOSTICS")).toBe("DIAGNOSTICS");
  });
});

describe("shouldServeFullDescriptions (post-initialize upgrade)", () => {
  const cc = { name: "claude-code", version: "2.3.0" };

  test("auto (default): full for a schema-deferring Claude Code", () => {
    expect(shouldServeFullDescriptions(cc, {})).toBe(true);
    expect(shouldServeFullDescriptions(cc, { CONTEXT_MODE_TOOL_DESCRIPTIONS: "auto" })).toBe(true);
  });

  test("env=full always upgrades, env=compact never does", () => {
    expect(shouldServeFullDescriptions(undefined, { CONTEXT_MODE_TOOL_DESCRIPTIONS: "full" })).toBe(true);
    expect(shouldServeFullDescriptions(cc, { CONTEXT_MODE_TOOL_DESCRIPTIONS: "compact" })).toBe(false);
  });

  test("ENABLE_TOOL_SEARCH=false means schemas ship per-request — stay compact", () => {
    expect(shouldServeFullDescriptions(cc, { ENABLE_TOOL_SEARCH: "false" })).toBe(false);
  });

  test("pre-tool-search Claude Code stays compact", () => {
    expect(shouldServeFullDescriptions({ name: "claude-code", version: "2.0.14" }, {})).toBe(false);
  });

  test("other or unknown clients stay compact (no env-sniff fallback)", () => {
    expect(shouldServeFullDescriptions({ name: "cursor-vscode", version: "9.9.9" }, {})).toBe(false);
    expect(shouldServeFullDescriptions({ name: "some-new-host", version: "9.9.9" }, {})).toBe(false);
    expect(shouldServeFullDescriptions(undefined, {})).toBe(false);
    expect(shouldServeFullDescriptions({ name: "claude-code" }, {})).toBe(false);
  });
});

describe("shipped descriptions", () => {
  test("the compact set is materially smaller than the authored prose", () => {
    const shipped = REGISTERED_CTX_TOOLS
      .map(t => String((t.config as { description?: unknown }).description ?? ""))
      .join("");
    // The authored set is ~29.4K characters; what ships is ~5.6K. The ceiling
    // was 14,000 while eight tools still fell through to their full text —
    // slack wide enough that the hole this file now guards fitted inside it.
    // 8,000 keeps room for a new tool without room for a reverted one.
    expect(shipped.length).toBeLessThan(8_000);
  });

  test("each heavy tool still names its purpose in the compact text", () => {
    delete process.env.CONTEXT_MODE_TOOL_DESCRIPTIONS;
    const expectations: Record<string, string[]> = {
      ctx_execute: ["subprocess", "print"],
      ctx_execute_file: ["FILE_CONTENT"],
      ctx_batch_execute: ["indexed", "concurrency"],
      ctx_search: ["queries"],
      ctx_fetch_and_index: ["ctx_search"],
      ctx_gather: ["read-only"],
      ctx_find: ["grep", "glob"],
      ctx_graph: ["callers", "codegraph"],
      ctx_read: ["path", "intent"],
      ctx_purge: ["confirm"],
    };
    for (const [name, needles] of Object.entries(expectations)) {
      const desc = String(resolveToolDescription(name, ""));
      for (const needle of needles) {
        expect(desc.toLowerCase(), `${name} compact description missing "${needle}"`)
          .toContain(needle.toLowerCase());
      }
    }
  });
});

/**
 * The third guard of the same family as the bundle scan and the routing-block
 * check: a mechanism that is wired to only part of the surface it was written
 * for, with nothing saying so.
 *
 * `resolveToolDescription` falls back to the authored text for any tool the
 * compact table omits — silently, by design, so nothing fails when a tool is
 * added and the table is not. That fallback let the table sit at seven entries
 * while fifteen tools were registered: the eight omitted ones shipped their
 * long form on every request, and they were the newest and wordiest of the set.
 */
describe("compact table covers the registered surface", () => {
  /** Sentinel that comes back only when `name` has no compact entry. */
  const NO_ENTRY = "__NO_COMPACT_ENTRY__";

  /**
   * Tools allowed to ship their authored text, and why: it is already about as
   * short as a compact rewrite would be, so an entry would buy nothing and
   * leave two texts to keep in sync. The ceiling below is what makes this an
   * exemption rather than a hole — let either description grow past it and the
   * test demands a compact entry.
   */
  const EXEMPT: Record<string, string> = {
    ctx_stats: "authored text is ~184 characters",
    ctx_doctor: "authored text is ~196 characters",
  };
  const EXEMPT_MAX_CHARS = 400;

  test("every registered tool has a compact entry or a stated exemption", () => {
    delete process.env.CONTEXT_MODE_TOOL_DESCRIPTIONS;
    const missing: string[] = [];
    for (const tool of REGISTERED_CTX_TOOLS) {
      if (tool.name in EXEMPT) continue;
      if (resolveToolDescription(tool.name, NO_ENTRY) === NO_ENTRY) missing.push(tool.name);
    }
    expect(
      missing,
      `no compact description for: ${missing.join(", ")}. Each ships its full text on every ` +
      `request. Add an entry to COMPACT_TOOL_DESCRIPTIONS, or add it to EXEMPT here with the reason.`,
    ).toEqual([]);
  });

  test("an exempt tool's authored description stays short enough to justify the exemption", () => {
    delete process.env.CONTEXT_MODE_TOOL_DESCRIPTIONS;
    for (const [name, reason] of Object.entries(EXEMPT)) {
      const tool = REGISTERED_CTX_TOOLS.find((t) => t.name === name);
      expect(tool, `${name} is exempt from the compact table but is not registered`).toBeDefined();
      const shipped = String((tool!.config as { description?: unknown }).description ?? "");
      expect(
        shipped.length,
        `${name} is exempt because ${reason}, but it now ships ${shipped.length} characters. ` +
        `Either shorten it or give it a compact entry.`,
      ).toBeLessThanOrEqual(EXEMPT_MAX_CHARS);
    }
  });

  test("no compact entry grows into prose of its own", () => {
    // The table is not a second place to write long descriptions. The authored
    // text is not reachable from here — `resolveToolDescription` only returns
    // the fallback it is handed — so this bounds the compact side directly.
    // The largest entry today is ctx_graph at ~730 characters, and it is large
    // because it has to name seven actions; 900 leaves room without leaving
    // room for a second copy of the authored prose.
    delete process.env.CONTEXT_MODE_TOOL_DESCRIPTIONS;
    for (const tool of REGISTERED_CTX_TOOLS) {
      if (tool.name in EXEMPT) continue;
      const compact = String(resolveToolDescription(tool.name, NO_ENTRY));
      if (compact === NO_ENTRY) continue; // reported by the test above
      expect(
        compact.length,
        `${tool.name}: compact description is ${compact.length} characters — that is prose, not a summary`,
      ).toBeLessThanOrEqual(900);
    }
  });

  test("the routed alternatives still name the native tool they displace", () => {
    // D5's whole point. Compaction may drop examples, enumerations and the
    // RETURNS block; it may not drop "instead of Grep" / "instead of Read",
    // because that sentence is what the model reads at the moment it chooses.
    delete process.env.CONTEXT_MODE_TOOL_DESCRIPTIONS;
    const displaces: Record<string, RegExp> = {
      ctx_find: /instead of grep/i,
      ctx_graph: /instead of grep/i,
      ctx_read: /instead of read/i,
      ctx_execute_file: /read tool instead|instead of read/i,
    };
    for (const [name, pattern] of Object.entries(displaces)) {
      const desc = String(resolveToolDescription(name, ""));
      expect(desc, `${name} compact description no longer names the tool it displaces`).toMatch(pattern);
    }
  });

  test("the routed alternatives keep an honest exclusion", () => {
    // A description that only says when to reach for the tool is an
    // advertisement. Read-before-edit is the exclusion that matters most:
    // Edit matches the exact bytes in the conversation, and a slice is not
    // those bytes.
    delete process.env.CONTEXT_MODE_TOOL_DESCRIPTIONS;
    for (const name of ["ctx_find", "ctx_graph", "ctx_read"]) {
      const desc = String(resolveToolDescription(name, ""));
      expect(desc, `${name} compact description dropped its read-before-edit exclusion`)
        .toMatch(/NOT (when you intend to edit|before an edit)|Read the file, because Edit|Read first, because Edit/i);
    }
  });
});
