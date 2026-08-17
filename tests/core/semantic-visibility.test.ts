/**
 * The semantic layer must be honest about whether it is answering.
 *
 * "Hybrid search is configured" and "hybrid search can answer" are different
 * states, and a cold index degrades silently to lexical — which looks exactly
 * like working. These tests pin the wording of each state and the fact that the
 * in-response hint stays a nudge (once per process) rather than a status bar.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentStore } from "../../src/store.js";
import {
  formatSemanticHint,
  semanticStatusHint,
  semanticCoverageAdvice,
  __resetSemanticHintLatch,
  formatBatchQueryResults,
} from "../../src/server.js";

describe("semanticCoverageAdvice — ctx_stats wording", () => {
  test("zero vectors with no embedder says how to turn it on, not that backfill is running", () => {
    const lines = semanticCoverageAdvice({ chunks: 1320, vectors: 0 });
    const text = lines.join("\n");
    expect(text).toContain("INACTIVE");
    expect(text).toContain("CONTEXT_MODE_EMBEDDINGS_URL");
    expect(text).not.toContain("background on every search");
  });

  test("zero vectors with an embedder points at the one-pass drain", () => {
    const text = semanticCoverageAdvice({ chunks: 1320, vectors: 0 }, "bge-m3").join("\n");
    expect(text).toContain("bge-m3");
    expect(text).toContain("context-mode drain");
    expect(text).not.toContain("CONTEXT_MODE_EMBEDDINGS_URL");
  });

  test("partial coverage describes both warm-up paths", () => {
    const text = semanticCoverageAdvice({ chunks: 1854, vectors: 480 }, "bge-m3").join("\n");
    expect(text).toContain("after each search");
    expect(text).toContain("session end");
    expect(text).toContain("context-mode drain");
  });

  test("full coverage says nothing", () => {
    expect(semanticCoverageAdvice({ chunks: 100, vectors: 100 }, "bge-m3")).toEqual([]);
  });
});

describe("formatSemanticHint — in-response nudge", () => {
  test("silent on a small index, where lexical search is enough", () => {
    expect(formatSemanticHint({ chunks: 199, vectors: 0 })).toBeNull();
  });

  test("silent at full coverage", () => {
    expect(formatSemanticHint({ chunks: 500, vectors: 500 })).toBeNull();
  });

  test("names the state at zero coverage", () => {
    const line = formatSemanticHint({ chunks: 1320, vectors: 0 });
    expect(line).toContain("inactive");
    expect(line).toContain("1,320");
    expect(line).toContain("context-mode drain");
  });

  test("reports the percentage at partial coverage", () => {
    expect(formatSemanticHint({ chunks: 1000, vectors: 250 })).toContain("25%");
  });
});

describe("semanticStatusHint — latch and opt-out", () => {
  let dir: string;
  let store: ContentStore;

  beforeEach(() => {
    __resetSemanticHintLatch();
    dir = mkdtempSync(join(tmpdir(), "ctx-semantic-hint-"));
    store = new ContentStore(join(dir, "content.db"));
    // 240 chunks — above the 200-chunk floor, no vectors.
    const sections = Array.from({ length: 240 }, (_, i) =>
      `# Section ${i}\n\nProbe body for section ${i} with enough words to index.`).join("\n\n");
    store.index({ content: sections, source: "batch:probe" });
  });

  afterEach(() => {
    try { store.cleanup(); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
    delete process.env.CONTEXT_MODE_SEMANTIC_HINT;
    __resetSemanticHintLatch();
  });

  test("fires once per process, then stays quiet", () => {
    expect(semanticStatusHint(store)).toContain("Semantic layer");
    expect(semanticStatusHint(store)).toBeNull();
  });

  test("CONTEXT_MODE_SEMANTIC_HINT=0 silences it", () => {
    process.env.CONTEXT_MODE_SEMANTIC_HINT = "0";
    expect(semanticStatusHint(store)).toBeNull();
  });

  test("batch scope never shows it; global scope does", async () => {
    const local = await formatBatchQueryResults(store, ["Section 3"], "batch:probe");
    expect(local.join("\n")).not.toContain("Semantic layer");

    const global = await formatBatchQueryResults(store, ["Section 3"], "batch:probe", undefined, "global");
    expect(global.join("\n")).toContain("Semantic layer");
  });
});
