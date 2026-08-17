/**
 * "Showing 3 of N" — and the rule that decides whether N can be trusted.
 *
 * The claim "complete" is only ever made when the candidate pool is provably
 * not truncated. Everywhere else the total is `N+`. Erring towards "there may
 * be more" costs a character; erring the other way tells the reader to stop
 * looking when there was more to find.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentStore } from "../../src/store.js";
import {
  formatCompletenessLine,
  formatEscalationBlock,
  hasMore,
} from "../../src/search/completeness.js";
import { formatBatchQueryResults } from "../../src/server.js";

afterEach(() => {
  delete process.env.CONTEXT_MODE_SEARCH_COMPLETENESS;
  delete process.env.CONTEXT_MODE_SEARCH_ESCALATION;
});

describe("formatCompletenessLine", () => {
  test("claims completeness only when the pool is not truncated", () => {
    const line = formatCompletenessLine("retry", { shown: 4, poolSize: 4, saturated: false });
    expect(line).toBe("> Complete: all 4 matching section(s) shown.");
  });

  test("reports an exact total when the pool is known and larger", () => {
    const line = formatCompletenessLine("retry", { shown: 3, poolSize: 11, saturated: false });
    expect(line).toContain("Showing 3 of 11 matching section(s)");
    expect(line).toContain('ctx_search(queries: ["retry"]');
  });

  test("a saturated pool is reported as a lower bound, never as a count", () => {
    const line = formatCompletenessLine("retry", { shown: 3, poolSize: 20, saturated: true });
    expect(line).toContain("of 20+");
  });

  test("a saturated pool never claims completeness even when the counts agree", () => {
    const info = { shown: 3, poolSize: 3, saturated: true };
    expect(hasMore(info)).toBe(true);
    expect(formatCompletenessLine("retry", info)).not.toContain("Complete");
  });

  test("says nothing when the query matched nothing", () => {
    expect(formatCompletenessLine("retry", { shown: 0, poolSize: 0, saturated: false })).toBeNull();
  });

  test("quotes in the query survive the round trip into the suggestion", () => {
    const line = formatCompletenessLine('the "retry" path', { shown: 1, poolSize: 9, saturated: false });
    expect(line).toContain('\\"retry\\"');
  });

  test("CONTEXT_MODE_SEARCH_COMPLETENESS=0 silences it", () => {
    process.env.CONTEXT_MODE_SEARCH_COMPLETENESS = "0";
    expect(formatCompletenessLine("retry", { shown: 3, poolSize: 11, saturated: false })).toBeNull();
  });
});

describe("formatEscalationBlock", () => {
  test("counts only the queries that had more to give", () => {
    const block = formatEscalationBlock([
      { shown: 3, poolSize: 11, saturated: false },
      { shown: 2, poolSize: 2, saturated: false },
      { shown: 3, poolSize: 3, saturated: true },
    ]);
    expect(block).toContain("2 query(s) had more matches");
  });

  test("stays quiet when every query was complete", () => {
    expect(formatEscalationBlock([{ shown: 2, poolSize: 2, saturated: false }])).toBeNull();
  });

  test("CONTEXT_MODE_SEARCH_ESCALATION=0 silences it", () => {
    process.env.CONTEXT_MODE_SEARCH_ESCALATION = "0";
    expect(formatEscalationBlock([{ shown: 3, poolSize: 11, saturated: false }])).toBeNull();
  });
});

describe("searchWithFallbackMeta", () => {
  let dir: string;
  let store: ContentStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctx-completeness-"));
    store = new ContentStore(join(dir, "content.db"));
  });

  afterEach(() => {
    try { store.cleanup(); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  });

  test("a small corpus reports the true pool, not the limit", () => {
    store.index({
      content: [
        "# Retry one\n\nThe retry handler backs off.",
        "# Retry two\n\nThe retry handler logs.",
        "# Retry three\n\nThe retry handler gives up.",
        "# Retry four\n\nThe retry handler resets.",
      ].join("\n\n"),
      source: "batch:notes",
    });

    const { results, completeness } = store.searchWithFallbackMeta("retry handler", 2, "batch:notes");
    expect(results).toHaveLength(2);
    expect(completeness.shown).toBe(2);
    expect(completeness.poolSize).toBeGreaterThanOrEqual(4);
  });

  test("a big corpus saturates the fetch and says so", () => {
    const sections = Array.from({ length: 60 }, (_, i) =>
      `# Retry ${i}\n\nThe retry handler variant ${i} backs off before retrying.`).join("\n\n");
    store.index({ content: sections, source: "batch:many" });

    const { completeness } = store.searchWithFallbackMeta("retry handler", 3, "batch:many");
    expect(completeness.saturated).toBe(true);
    expect(hasMore(completeness)).toBe(true);
  });

  test("CONTEXT_MODE_SEARCH_EXACT_TOTALS=1 turns the lower bound into a count", () => {
    const sections = Array.from({ length: 60 }, (_, i) =>
      `# Retry ${i}\n\nThe retry handler variant ${i} backs off before retrying.`).join("\n\n");
    store.index({ content: sections, source: "batch:many" });

    const bounded = store.searchWithFallbackMeta("retry handler", 3, "batch:many").completeness;
    process.env.CONTEXT_MODE_SEARCH_EXACT_TOTALS = "1";
    try {
      const exact = store.searchWithFallbackMeta("retry handler", 3, "batch:many").completeness;
      expect(exact.poolSize).toBeGreaterThan(bounded.poolSize);
      expect(exact.saturated).toBe(false);
    } finally {
      delete process.env.CONTEXT_MODE_SEARCH_EXACT_TOTALS;
    }
  });

  test("no matches means no claim either way", () => {
    store.index({ content: "# Unrelated\n\nNothing here.", source: "batch:notes" });
    const { results, completeness } = store.searchWithFallbackMeta("zzzznomatch", 3, "batch:notes");
    expect(results).toHaveLength(0);
    expect(completeness).toEqual({ shown: 0, poolSize: 0, saturated: false });
  });

  test("searchWithFallback still returns a bare array", () => {
    store.index({ content: "# Retry\n\nThe retry handler backs off.", source: "batch:notes" });
    const results = store.searchWithFallback("retry", 3, "batch:notes");
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });
});

describe("the batch response carries the line", () => {
  let dir: string;
  let store: ContentStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctx-completeness-batch-"));
    store = new ContentStore(join(dir, "content.db"));
    store.index({
      content: Array.from({ length: 8 }, (_, i) =>
        `# Deploy ${i}\n\nThe deploy step ${i} exits 137 under memory pressure.`).join("\n\n"),
      source: "batch:deploy",
    });
  });

  afterEach(() => {
    try { store.cleanup(); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  });

  test("per-query line plus one escalation block", async () => {
    const text = (await formatBatchQueryResults(store, ["deploy step exits 137"], "batch:deploy")).join("\n");
    expect(text).toMatch(/> Showing \d+ of \d+\+? matching section\(s\)/);
    expect(text).toMatch(/query\(s\) had more matches than shown/);
  });

  test("silenced wholesale by CONTEXT_MODE_SEARCH_COMPLETENESS=0", async () => {
    process.env.CONTEXT_MODE_SEARCH_COMPLETENESS = "0";
    const text = (await formatBatchQueryResults(store, ["deploy step exits 137"], "batch:deploy")).join("\n");
    expect(text).not.toContain("matching section(s)");
    expect(text).not.toContain("had more matches");
  });
});
