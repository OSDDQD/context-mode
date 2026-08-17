/**
 * Cross-query deduplication: a multi-query response must not hand the model the
 * same bytes twice.
 *
 * The safety property under test is narrow on purpose — only text that is
 * byte-identical to something already printed above in the same response is
 * replaced, and only by a pointer to where it was printed. Headings always
 * survive, and a different snippet window over the same chunk is new
 * information that must still be rendered in full.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentStore } from "../../src/store.js";
import {
  formatBatchQueryResults,
  CrossQueryDeduper,
  searchDedupEnabled,
} from "../../src/server.js";

let dir: string;
let store: ContentStore;

const SOURCE = "batch:deploy notes";

/**
 * A chunk long enough for extractSnippet to window it (>3000 chars on the batch
 * path) but under MAX_CHUNK_BYTES so it stays a single chunk, with two rare
 * terms far enough apart that their ±300 windows cannot merge.
 */
function longChunk(): string {
  const filler = (n: number) => "lorem ipsum dolor sit amet consectetur. ".repeat(n);
  return `# Runbook\n\n${filler(10)}zephyrmarker ${filler(65)}quasarmarker ${filler(10)}`;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ctx-search-dedup-"));
  store = new ContentStore(join(dir, "content.db"));
  store.index({
    content: "# Deploy failures\n\nThe build step exits 137 when the runner runs out of memory.",
    source: SOURCE,
  });
});

afterEach(() => {
  try { store.cleanup(); } catch { /* already gone */ }
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CONTEXT_MODE_SEARCH_DEDUP;
});

describe("CrossQueryDeduper", () => {
  test("first render passes, a byte-identical repeat is suppressed", () => {
    const d = new CrossQueryDeduper(true);
    const chunk = { source: "s", title: "t", content: "body" };
    expect(d.consider(chunk, "snippet", "first query").kind).toBe("render");
    const second = d.consider(chunk, "snippet", "second query");
    expect(second).toEqual({ kind: "suppress", firstQuery: "first query" });
    expect(d.suppressedCount).toBe(1);
    expect(d.savedBytes).toBe("snippet".length);
  });

  test("a different snippet window over the same chunk is a further match, not a repeat", () => {
    const d = new CrossQueryDeduper(true);
    const chunk = { source: "s", title: "t", content: "body" };
    d.consider(chunk, "window A", "q1");
    expect(d.consider(chunk, "window B", "q2").kind).toBe("further");
    expect(d.suppressedCount).toBe(0);
    expect(d.footer()).toBeNull();
  });

  test("chunks that share source and title but differ in body are distinct", () => {
    // A live index carries `Untitled (1)`, `Untitled (2)` — a source::title key
    // would collapse them and lose real results.
    const d = new CrossQueryDeduper(true);
    d.consider({ source: "s", title: "Untitled", content: "alpha body" }, "snippet", "q1");
    const other = d.consider({ source: "s", title: "Untitled", content: "beta body" }, "snippet", "q2");
    expect(other.kind).toBe("render");
  });

  test("disabled deduper never suppresses and never adds a footer", () => {
    const d = new CrossQueryDeduper(false);
    const chunk = { source: "s", title: "t", content: "body" };
    d.consider(chunk, "snippet", "q1");
    expect(d.consider(chunk, "snippet", "q2").kind).toBe("render");
    expect(d.footer()).toBeNull();
  });

  test("searchDedupEnabled is on by default and off at CONTEXT_MODE_SEARCH_DEDUP=0", () => {
    delete process.env.CONTEXT_MODE_SEARCH_DEDUP;
    expect(searchDedupEnabled()).toBe(true);
    process.env.CONTEXT_MODE_SEARCH_DEDUP = "0";
    expect(searchDedupEnabled()).toBe(false);
    process.env.CONTEXT_MODE_SEARCH_DEDUP = "1";
    expect(searchDedupEnabled()).toBe(true);
  });
});

describe("formatBatchQueryResults — dedup", () => {
  test("the second query keeps its heading and points at the first", async () => {
    const lines = await formatBatchQueryResults(store, ["exits 137", "runner out of memory"], SOURCE);
    const out = lines.join("\n");
    // Both queries are answered by the same chunk.
    expect(out.match(/### Deploy failures/g)?.length).toBe(2);
    // The body appears exactly once.
    expect(out.match(/The build step exits 137/g)?.length).toBe(1);
    expect(out).toContain('(identical to the section shown under "exits 137" — not repeated)');
    // Never mistaken for an empty result.
    expect(out).not.toContain("No matching sections found.");
  });

  test("the footer reports what was withheld", async () => {
    const lines = await formatBatchQueryResults(store, ["exits 137", "runner out of memory"], SOURCE);
    expect(lines.join("\n")).toMatch(/> Deduplicated 1 repeated section\(s\) \(.+ not repeated\)\./);
  });

  test("a distinct second hit is rendered in full and adds no footer", async () => {
    // One index() call: re-indexing a label replaces it, so both sections must
    // arrive together.
    store.index({
      content: "# Deploy failures\n\nThe build step exits 137 when the runner runs out of memory."
        + "\n\n# Cache warmup\n\nThe warmup job seeds redis before traffic is shifted.",
      source: SOURCE,
    });
    const lines = await formatBatchQueryResults(store, ["exits 137", "warmup seeds redis"], SOURCE);
    const out = lines.join("\n");
    expect(out).toContain("The build step exits 137");
    expect(out).toContain("The warmup job seeds redis");
    expect(out).not.toContain("not repeated");
  });

  test("a different window over one chunk renders in full, marked as a further match", async () => {
    store.index({ content: longChunk(), source: SOURCE }); // replaces the label's content
    const lines = await formatBatchQueryResults(store, ["zephyrmarker", "quasarmarker"], SOURCE);
    const out = lines.join("\n");
    expect(out).toContain("zephyrmarker");
    expect(out).toContain("quasarmarker");
    expect(out).toContain("— further match");
    expect(out).not.toContain("not repeated");
  });

  test("CONTEXT_MODE_SEARCH_DEDUP=0 restores the byte-for-byte previous output", async () => {
    process.env.CONTEXT_MODE_SEARCH_DEDUP = "0";
    const lines = await formatBatchQueryResults(store, ["exits 137", "runner out of memory"], SOURCE);
    const out = lines.join("\n");
    expect(out.match(/The build step exits 137/g)?.length).toBe(2);
    expect(out).not.toContain("not repeated");
    expect(out).not.toContain("Deduplicated");
    expect(out).not.toContain("further match");
  });
});
