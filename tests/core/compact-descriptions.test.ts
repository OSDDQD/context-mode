/**
 * Compact tool descriptions (#1031).
 *
 * The verbose descriptions are ~4.7K tokens of steering prose shipped on every
 * request; the compact set measures ~1.2K. These tests pin the compact default
 * and the escape hatch, and assert the compact text still carries the signals
 * a cold model needs.
 */

import { describe, expect, test, afterEach } from "vitest";
import { resolveToolDescription, REGISTERED_CTX_TOOLS } from "../../src/server.js";

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
    expect(String(out)).toContain("sandbox");
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

describe("shipped descriptions", () => {
  test("the compact set is materially smaller than the authored prose", () => {
    const shipped = REGISTERED_CTX_TOOLS
      .map(t => String((t.config as { description?: unknown }).description ?? ""))
      .join("");
    // The verbose set is ~24K characters; the compact one must be a fraction
    // of that. A generous ceiling — this guards against silently reverting to
    // the long form, not against every future word.
    expect(shipped.length).toBeLessThan(14_000);
  });

  test("each heavy tool still names its purpose in the compact text", () => {
    delete process.env.CONTEXT_MODE_TOOL_DESCRIPTIONS;
    const expectations: Record<string, string[]> = {
      ctx_execute: ["sandbox", "print"],
      ctx_execute_file: ["FILE_CONTENT"],
      ctx_batch_execute: ["indexed", "concurrency"],
      ctx_search: ["queries"],
      ctx_fetch_and_index: ["ctx_search"],
      ctx_gather: ["read-only"],
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
