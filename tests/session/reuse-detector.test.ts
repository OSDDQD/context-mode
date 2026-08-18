/**
 * C-02 — the returns detector.
 *
 * A `ctx_search` / `ctx_execute_file` / `ctx_batch_execute` call that hands the
 * model a compressed view of source X only saved context if the model then
 * worked from that view. When the model reads X whole a few steps later, the
 * compressed payload cost context instead of saving it — and until this
 * detector existed that loss was booked as a win.
 *
 * What is asserted here:
 *   - a return IS found (search → full read of the same file);
 *   - it is NOT found for a different file, for a read that PRECEDED the
 *     search, or for a repeat outside either window;
 *   - the four path shapes (absolute / relative / `code:` label / Windows)
 *     fold onto one key;
 *   - the threshold policy fires only above the line, on a real sample;
 *   - every env switch does what it says.
 */

import { afterEach, describe, expect, test } from "vitest";
import {
  DEFAULT_REUSE_THRESHOLD,
  detectReuse,
  extractCoveredSources,
  normalizeSourceKey,
  reuseDetectorEnabled,
  reuseMinSamples,
  reuseStepWindow,
  reuseThreshold,
  reuseWindowMs,
  shouldBypassCompression,
  sourcesMatch,
  summarizeReuse,
} from "../../src/session/reuse-detector.js";
import type { ReuseCandidateEvent } from "../../src/session/reuse-detector.js";
import { tokensFromBytes } from "../../src/session/tokenizer.js";

const ENV_KEYS = [
  "CONTEXT_MODE_REUSE_DETECT",
  "CONTEXT_MODE_REUSE_THRESHOLD",
  "CONTEXT_MODE_REUSE_STEP_WINDOW",
  "CONTEXT_MODE_REUSE_WINDOW_MS",
  "CONTEXT_MODE_REUSE_MIN_SAMPLES",
  "CONTEXT_MODE_REUSE_STAT_FILES",
];

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

const PROJECT = "/home/dev/proj";

let nextId = 1;
const at = (min: number): string => {
  const base = Date.UTC(2026, 0, 2, 10, 0, 0);
  return new Date(base + min * 60_000).toISOString().replace("T", " ").slice(0, 19);
};

function search(params: unknown, minute: number, tool = "ctx_search"): ReuseCandidateEvent {
  return {
    id: nextId++,
    type: "mcp_tool_call",
    data: JSON.stringify({
      tool_name: `mcp__plugin_context-mode_context-mode__${tool}`,
      params,
    }),
    created_at: at(minute),
    project_dir: PROJECT,
  };
}

function read(path: string, minute: number, bytes = 20_000): ReuseCandidateEvent {
  return {
    id: nextId++,
    type: "file_read",
    data: path,
    created_at: at(minute),
    project_dir: PROJECT,
    bytes_returned: bytes,
  };
}

function filler(n: number, minute: number): ReuseCandidateEvent[] {
  return Array.from({ length: n }, () => ({
    id: nextId++,
    type: "bash_outcome",
    data: "exit 0",
    created_at: at(minute),
    project_dir: PROJECT,
  }));
}

// No filesystem probing anywhere in this file — every read prices itself from
// `bytes_returned`, and the injected `sizeOf` is the only fallback.
const opts = { sizeOf: () => 0 };

describe("normalizeSourceKey — four shapes, one key", () => {
  test("absolute path passes through normalized", () => {
    expect(normalizeSourceKey("/home/dev/proj/src/a.ts")).toBe("/home/dev/proj/src/a.ts");
  });

  test("relative path resolves against the anchor", () => {
    expect(normalizeSourceKey("src/a.ts", PROJECT)).toBe("/home/dev/proj/src/a.ts");
  });

  test("`code:` source label is stripped, then resolved", () => {
    expect(normalizeSourceKey("code:src/a.ts", PROJECT)).toBe("/home/dev/proj/src/a.ts");
  });

  test("backslashes fold to forward slashes", () => {
    expect(normalizeSourceKey("src\\session\\a.ts", PROJECT)).toBe("/home/dev/proj/src/session/a.ts");
  });

  test("`..` segments collapse", () => {
    expect(normalizeSourceKey("src/../src/a.ts", PROJECT)).toBe("/home/dev/proj/src/a.ts");
  });

  test("URLs and globs are not source keys", () => {
    expect(normalizeSourceKey("https://example.com/x.ts")).toBe("");
    expect(normalizeSourceKey("src/**/*.ts", PROJECT)).toBe("");
    expect(normalizeSourceKey("")).toBe("");
  });

  test("anchor-less relative meets its absolute via the suffix rule", () => {
    expect(sourcesMatch("src/a.ts", "/home/dev/proj/src/a.ts")).toBe(true);
    expect(sourcesMatch("/home/dev/proj/src/a.ts", "src/a.ts")).toBe(true);
    expect(sourcesMatch("a.ts", "/home/dev/proj/src/a.ts")).toBe(true);
  });

  test("suffix rule respects segment boundaries", () => {
    // `notes.ts` must NOT match `release-notes.ts`.
    expect(sourcesMatch("notes.ts", "/proj/release-notes.ts")).toBe(false);
    expect(sourcesMatch("/proj/src/a.ts", "/proj/src/b.ts")).toBe(false);
  });
});

describe("extractCoveredSources", () => {
  test("ctx_execute_file names its path", () => {
    const c = extractCoveredSources(JSON.stringify({
      tool_name: "mcp__x__ctx_execute_file",
      params: { path: "src/session/db.ts", language: "javascript" },
    }));
    expect(c.compressing).toBe(true);
    expect(c.tool).toBe("ctx_execute_file");
    expect(c.sources).toContain("src/session/db.ts");
  });

  test("ctx_batch_execute surfaces paths buried in shell commands", () => {
    const c = extractCoveredSources(JSON.stringify({
      tool_name: "mcp__x__ctx_batch_execute",
      params: { commands: [{ label: "grep", command: "grep -n foo /home/dev/proj/src/a.ts" }] },
    }));
    expect(c.compressing).toBe(true);
    expect(c.sources).toContain("/home/dev/proj/src/a.ts");
  });

  test("ctx_search queries are prose, not sources", () => {
    const c = extractCoveredSources(JSON.stringify({
      tool_name: "mcp__x__ctx_search",
      params: { queries: ["how does analytics.ts compute savings"] },
    }));
    expect(c.compressing).toBe(true);
    expect(c.sources).toEqual([]);
  });

  test("a `source` filter IS a source, bare filename included", () => {
    const c = extractCoveredSources(JSON.stringify({
      tool_name: "mcp__x__ctx_search",
      params: { queries: ["x"], source: "code:src/a.ts" },
    }));
    expect(c.sources.some((s) => s.includes("src/a.ts"))).toBe(true);
  });

  test("truncated params are scanned as text", () => {
    const c = extractCoveredSources(JSON.stringify({
      tool_name: "mcp__x__ctx_batch_execute",
      params_raw: '{"commands":[{"command":"wc -l src/session/analytics.ts"',
      truncated: true,
    }));
    expect(c.sources).toContain("src/session/analytics.ts");
  });

  test("a non-compressing MCP call covers nothing", () => {
    const c = extractCoveredSources(JSON.stringify({
      tool_name: "mcp__other__do_thing",
      params: { path: "src/a.ts" },
    }));
    expect(c.compressing).toBe(false);
    expect(c.sources).toEqual([]);
  });

  test("garbage data never throws", () => {
    expect(extractCoveredSources("not json").sources).toEqual([]);
    expect(extractCoveredSources("").sources).toEqual([]);
  });
});

describe("detectReuse — the return is found", () => {
  test("search then full read of the same file is a return", () => {
    const r = detectReuse([
      search({ path: "src/a.ts" }, 0, "ctx_execute_file"),
      read("/home/dev/proj/src/a.ts", 1, 20_000),
    ], opts);

    expect(r.returnedReads).toBe(1);
    expect(r.coveredSources).toBe(1);
    expect(r.returnedSources).toBe(1);
    expect(r.returnedBytes).toBe(20_000);
    expect(r.ratio).toBe(1);
    expect(r.detections[0].source).toBe("/home/dev/proj/src/a.ts");
    expect(r.detections[0].coverTool).toBe("ctx_execute_file");
    expect(r.detections[0].steps).toBe(1);
  });

  test("returnedTokens goes through the honest tokenizer, not bytes/4", () => {
    const r = detectReuse([
      search({ path: "src/a.ts" }, 0, "ctx_execute_file"),
      read("/home/dev/proj/src/a.ts", 1, 40_000),
    ], opts);
    // The measured bytes-per-token for the payload mix context-mode redirects
    // is BELOW 4, so the honest count is strictly ABOVE the prose rule of
    // thumb — which is the whole point: `bytes / 4` understates the real cost.
    // Pinning the direction is what keeps a `/4` regression visible.
    expect(r.returnedTokens).toBe(Math.round(tokensFromBytes(40_000)));
    expect(r.returnedTokens).toBeGreaterThan(40_000 / 4);
  });

  test("a relative cover meets an absolute read (no anchor on the cover row)", () => {
    const cover = search({ path: "src/a.ts" }, 0, "ctx_execute_file");
    delete cover.project_dir;
    const r = detectReuse([cover, read("/home/dev/proj/src/a.ts", 1)], opts);
    expect(r.returnedReads).toBe(1);
  });

  test("a `code:` labelled source meets its file read", () => {
    const r = detectReuse([
      search({ queries: ["x"], source: "code:src/a.ts" }, 0),
      read("/home/dev/proj/src/a.ts", 1),
    ], opts);
    expect(r.returnedReads).toBe(1);
  });

  test("two reads of one covered file are two returns of one source", () => {
    const r = detectReuse([
      search({ path: "src/a.ts" }, 0, "ctx_execute_file"),
      read("/home/dev/proj/src/a.ts", 1, 10_000),
      read("/home/dev/proj/src/a.ts", 2, 10_000),
    ], opts);
    expect(r.returnedReads).toBe(2);
    expect(r.returnedSources).toBe(1);
    expect(r.returnedBytes).toBe(20_000);
  });

  test("bytes fall back to the injected sizer when the event carries none", () => {
    const ev = read("/home/dev/proj/src/a.ts", 1);
    delete ev.bytes_returned;
    const r = detectReuse(
      [search({ path: "src/a.ts" }, 0, "ctx_execute_file"), ev],
      { sizeOf: () => 7_777 },
    );
    expect(r.returnedBytes).toBe(7_777);
  });
});

describe("detectReuse — no false positives", () => {
  test("reading a DIFFERENT file is not a return", () => {
    const r = detectReuse([
      search({ path: "src/a.ts" }, 0, "ctx_execute_file"),
      read("/home/dev/proj/src/b.ts", 1),
    ], opts);
    expect(r.returnedReads).toBe(0);
    expect(r.coveredSources).toBe(1);
    expect(r.ratio).toBe(0);
  });

  test("reading BEFORE the search is not a return", () => {
    const r = detectReuse([
      read("/home/dev/proj/src/a.ts", 0),
      search({ path: "src/a.ts" }, 1, "ctx_execute_file"),
    ], opts);
    expect(r.returnedReads).toBe(0);
  });

  test("a read beyond the STEP window is not a return", () => {
    const r = detectReuse([
      search({ path: "src/a.ts" }, 0, "ctx_execute_file"),
      ...filler(30, 1),
      read("/home/dev/proj/src/a.ts", 2),
    ], { ...opts, stepWindow: 20, windowMs: 60 * 60_000 });
    expect(r.returnedReads).toBe(0);
  });

  test("a read beyond the TIME window is not a return", () => {
    const r = detectReuse([
      search({ path: "src/a.ts" }, 0, "ctx_execute_file"),
      read("/home/dev/proj/src/a.ts", 120),
    ], { ...opts, stepWindow: 100, windowMs: 15 * 60_000 });
    expect(r.returnedReads).toBe(0);
  });

  test("a read just inside both windows still counts", () => {
    const r = detectReuse([
      search({ path: "src/a.ts" }, 0, "ctx_execute_file"),
      ...filler(5, 1),
      read("/home/dev/proj/src/a.ts", 10),
    ], { ...opts, stepWindow: 20, windowMs: 15 * 60_000 });
    expect(r.returnedReads).toBe(1);
  });

  test("a plain Read with no preceding retrieval is not a return", () => {
    const r = detectReuse([read("/home/dev/proj/src/a.ts", 0)], opts);
    expect(r.returnedReads).toBe(0);
    expect(r.coveredSources).toBe(0);
  });

  test("a non-compressing MCP call does not create coverage", () => {
    const r = detectReuse([
      {
        id: 1,
        type: "mcp_tool_call",
        data: JSON.stringify({ tool_name: "mcp__x__Read", params: { path: "src/a.ts" } }),
        created_at: at(0),
        project_dir: PROJECT,
      },
      read("/home/dev/proj/src/a.ts", 1),
    ], opts);
    expect(r.coveredSources).toBe(0);
    expect(r.returnedReads).toBe(0);
  });

  test("empty and malformed streams return the zero report, never throw", () => {
    expect(detectReuse([], opts).returnedReads).toBe(0);
    expect(detectReuse([{ type: "file_read", data: "" }], opts).returnedReads).toBe(0);
    expect(detectReuse(undefined as unknown as ReuseCandidateEvent[], opts).returnedReads).toBe(0);
  });
});

describe("shouldBypassCompression — the feedback policy", () => {
  test("fires above the default 30% line on a real sample", () => {
    expect(shouldBypassCompression({ covered: 10, returned: 4 })).toBe(true);
  });

  test("does NOT fire below the line", () => {
    expect(shouldBypassCompression({ covered: 10, returned: 2 })).toBe(false);
  });

  test("does NOT fire exactly AT the line — the contract is 'above'", () => {
    expect(shouldBypassCompression({ covered: 10, returned: 3 })).toBe(false);
    expect(DEFAULT_REUSE_THRESHOLD).toBe(0.30);
  });

  test("does NOT fire on too small a sample, however bad the ratio", () => {
    expect(shouldBypassCompression({ covered: 1, returned: 1 })).toBe(false);
    expect(shouldBypassCompression({ covered: 2, returned: 2, minSamples: 3 })).toBe(false);
    expect(shouldBypassCompression({ covered: 3, returned: 3, minSamples: 3 })).toBe(true);
  });

  test("no scope, no counts, no verdict → no bypass", () => {
    expect(shouldBypassCompression(null)).toBe(false);
    expect(shouldBypassCompression({})).toBe(false);
    expect(shouldBypassCompression({ covered: 0, returned: 0 })).toBe(false);
  });

  test("accepts a summary straight out of detectReuse", () => {
    const r = detectReuse([
      search({ path: "src/a.ts" }, 0, "ctx_execute_file"),
      read("/home/dev/proj/src/a.ts", 1),
      search({ path: "src/b.ts" }, 2, "ctx_execute_file"),
      search({ path: "src/c.ts" }, 3, "ctx_execute_file"),
    ], opts);
    expect(r.coveredSources).toBe(3);
    expect(r.returnedSources).toBe(1);
    expect(shouldBypassCompression({ stats: summarizeReuse(r) })).toBe(true);
  });

  test("a per-call threshold override wins over the default", () => {
    expect(shouldBypassCompression({ covered: 10, returned: 4, threshold: 0.5 })).toBe(false);
    expect(shouldBypassCompression({ covered: 10, returned: 4, threshold: 50 })).toBe(false);
    expect(shouldBypassCompression({ covered: 10, returned: 4, threshold: 0.1 })).toBe(true);
  });

  test("a stats object from a disabled detector never fires", () => {
    expect(shouldBypassCompression({
      stats: { enabled: false, ratio: 1, coveredSources: 10, returnedSources: 10 },
    })).toBe(false);
  });
});

describe("env switches", () => {
  test("CONTEXT_MODE_REUSE_DETECT=0 disables detection and the bypass", () => {
    process.env.CONTEXT_MODE_REUSE_DETECT = "0";
    expect(reuseDetectorEnabled()).toBe(false);

    const r = detectReuse([
      search({ path: "src/a.ts" }, 0, "ctx_execute_file"),
      read("/home/dev/proj/src/a.ts", 1, 20_000),
    ], { sizeOf: () => 0 });
    expect(r.enabled).toBe(false);
    expect(r.returnedReads).toBe(0);
    expect(r.returnedBytes).toBe(0);

    expect(shouldBypassCompression({ covered: 10, returned: 10 })).toBe(false);
  });

  test("CONTEXT_MODE_REUSE_DETECT accepts the usual off spellings", () => {
    for (const v of ["0", "false", "off", "no", "FALSE"]) {
      process.env.CONTEXT_MODE_REUSE_DETECT = v;
      expect(reuseDetectorEnabled()).toBe(false);
    }
    for (const v of ["1", "true", "on", ""]) {
      process.env.CONTEXT_MODE_REUSE_DETECT = v;
      expect(reuseDetectorEnabled()).toBe(true);
    }
  });

  test("CONTEXT_MODE_REUSE_THRESHOLD takes a percentage or a fraction", () => {
    process.env.CONTEXT_MODE_REUSE_THRESHOLD = "50";
    expect(reuseThreshold()).toBeCloseTo(0.5);
    expect(shouldBypassCompression({ covered: 10, returned: 4 })).toBe(false);

    process.env.CONTEXT_MODE_REUSE_THRESHOLD = "0.1";
    expect(reuseThreshold()).toBeCloseTo(0.1);
    expect(shouldBypassCompression({ covered: 10, returned: 4 })).toBe(true);
  });

  test("a nonsense threshold falls back to the default", () => {
    for (const v of ["", "abc", "-5", "1000"]) {
      process.env.CONTEXT_MODE_REUSE_THRESHOLD = v;
      expect(reuseThreshold()).toBe(DEFAULT_REUSE_THRESHOLD);
    }
  });

  test("CONTEXT_MODE_REUSE_STEP_WINDOW narrows the step window", () => {
    process.env.CONTEXT_MODE_REUSE_STEP_WINDOW = "2";
    expect(reuseStepWindow()).toBe(2);

    const events = [
      search({ path: "src/a.ts" }, 0, "ctx_execute_file"),
      ...filler(5, 0),
      read("/home/dev/proj/src/a.ts", 1),
    ];
    expect(detectReuse(events, opts).returnedReads).toBe(0);

    delete process.env.CONTEXT_MODE_REUSE_STEP_WINDOW;
    expect(detectReuse(events, opts).returnedReads).toBe(1);
  });

  test("CONTEXT_MODE_REUSE_WINDOW_MS narrows the time window", () => {
    process.env.CONTEXT_MODE_REUSE_WINDOW_MS = "60000";
    expect(reuseWindowMs()).toBe(60_000);

    const events = [
      search({ path: "src/a.ts" }, 0, "ctx_execute_file"),
      read("/home/dev/proj/src/a.ts", 5),
    ];
    expect(detectReuse(events, opts).returnedReads).toBe(0);

    delete process.env.CONTEXT_MODE_REUSE_WINDOW_MS;
    expect(detectReuse(events, opts).returnedReads).toBe(1);
  });

  test("CONTEXT_MODE_REUSE_MIN_SAMPLES gates the bypass", () => {
    process.env.CONTEXT_MODE_REUSE_MIN_SAMPLES = "10";
    expect(reuseMinSamples()).toBe(10);
    expect(shouldBypassCompression({ covered: 5, returned: 5 })).toBe(false);
    expect(shouldBypassCompression({ covered: 10, returned: 10 })).toBe(true);
  });
});
