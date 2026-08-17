import { describe, test, expect } from "vitest";
import {
  resolveEmbeddingConfig, isEmbeddingsEnabled, parseEmbeddingResponse,
  encodeVector, decodeVector, cosineSimilarity, embedTexts,
} from "../../src/search/embeddings.js";
import { fuseRankings, hybridSearch, pruneOrphanVectors } from "../../src/search/hybrid.js";

describe("embedding config", () => {
  test("stays disabled until both url and model are set", () => {
    expect(isEmbeddingsEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isEmbeddingsEnabled({ CONTEXT_MODE_EMBEDDINGS_URL: "http://x/v1/embeddings" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isEmbeddingsEnabled({
      CONTEXT_MODE_EMBEDDINGS_URL: "http://x/v1/embeddings",
      CONTEXT_MODE_EMBEDDINGS_MODEL: "nomic-embed-text",
    } as NodeJS.ProcessEnv)).toBe(true);
  });

  test("falls back to a sane timeout on garbage input", () => {
    const cfg = resolveEmbeddingConfig({
      CONTEXT_MODE_EMBEDDINGS_URL: "http://x/v1/embeddings",
      CONTEXT_MODE_EMBEDDINGS_MODEL: "m",
      CONTEXT_MODE_EMBEDDINGS_TIMEOUT_MS: "not-a-number",
    } as NodeJS.ProcessEnv);
    expect(cfg?.timeoutMs).toBe(5_000);
  });

  test("background backfill gets its own, much larger budget", () => {
    // A single query against bge-m3 on CPU is ~230ms; a batch of 32 real
    // chunks is ~14s. One shared timeout would abort every backfill and the
    // index would never warm — silently, since search just degrades.
    const cfg = resolveEmbeddingConfig({
      CONTEXT_MODE_EMBEDDINGS_URL: "http://x/v1/embeddings",
      CONTEXT_MODE_EMBEDDINGS_MODEL: "m",
    } as NodeJS.ProcessEnv);
    expect(cfg?.timeoutMs).toBe(5_000);
    expect(cfg?.backfillTimeoutMs).toBe(120_000);
    expect(cfg?.backfillBatch).toBe(16);
  });

  test("both budgets and the batch size are overridable", () => {
    const cfg = resolveEmbeddingConfig({
      CONTEXT_MODE_EMBEDDINGS_URL: "http://x/v1/embeddings",
      CONTEXT_MODE_EMBEDDINGS_MODEL: "m",
      CONTEXT_MODE_EMBEDDINGS_TIMEOUT_MS: "800",
      CONTEXT_MODE_EMBEDDINGS_BACKFILL_TIMEOUT_MS: "300000",
      CONTEXT_MODE_EMBEDDINGS_BACKFILL: "64",
    } as NodeJS.ProcessEnv);
    expect(cfg?.timeoutMs).toBe(800);
    expect(cfg?.backfillTimeoutMs).toBe(300_000);
    expect(cfg?.backfillBatch).toBe(64);
  });
});

describe("parseEmbeddingResponse", () => {
  test("reads the OpenAI shape", () => {
    expect(parseEmbeddingResponse({ data: [{ embedding: [1, 2] }, { embedding: [3, 4] }] }))
      .toEqual([[1, 2], [3, 4]]);
  });

  test("reads both Ollama shapes", () => {
    expect(parseEmbeddingResponse({ embeddings: [[1, 2]] })).toEqual([[1, 2]]);
    expect(parseEmbeddingResponse({ embedding: [1, 2] })).toEqual([[1, 2]]);
  });

  test("returns null on anything else", () => {
    expect(parseEmbeddingResponse({ oops: true })).toBeNull();
    expect(parseEmbeddingResponse(null)).toBeNull();
  });
});

describe("vector codec", () => {
  test("round-trips through the BLOB encoding", () => {
    const vec = [0.5, -0.25, 1, 0];
    const decoded = decodeVector(encodeVector(vec));
    expect([...decoded]).toEqual(vec);
  });

  test("cosine similarity is 1 for identical and 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  test("mismatched dimensions score 0 instead of throwing", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0);
  });
});

describe("embedTexts", () => {
  test("returns null when disabled", async () => {
    expect(await embedTexts(["hi"], null)).toBeNull();
  });
});

describe("fuseRankings", () => {
  const row = (source: string, title: string, content: string) => ({ source, title, content });

  test("a document found by both strategies outranks one found by either alone", () => {
    const shared = row("docs", "retry", "retry the request");
    const lexicalOnly = row("docs", "cache", "cache invalidation");
    const semanticOnly = row("docs", "backoff", "exponential backoff");

    const fused = fuseRankings(
      [lexicalOnly, shared],
      [semanticOnly, shared],
      { limit: 3 },
    );

    expect(fused[0]).toEqual(shared);
    expect(fused).toHaveLength(3);
  });

  test("honours the limit", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row("s", `t${i}`, `c${i}`));
    expect(fuseRankings(rows, [], { limit: 4 })).toHaveLength(4);
  });
});

describe("pruneOrphanVectors", () => {
  test("removes vectors whose chunk no longer exists", () => {
    // Re-indexing an FTS5 source deletes and re-inserts its rows with fresh
    // rowids; without pruning, the old vectors survive and the brute-force
    // scan walks them on every query.
    const rows = [{ chunk_rowid: 1 }, { chunk_rowid: 2 }, { chunk_rowid: 3 }];
    const deleted: string[] = [];
    let count = rows.length;
    const db = {
      exec: () => undefined,
      prepare: (sql: string) => ({
        get: () => ({ c: count }),
        run: () => { deleted.push(sql); count = 1; return {}; },
        all: () => [],
      }),
    };
    expect(pruneOrphanVectors(db)).toBe(2);
    expect(deleted[0]).toContain("DELETE FROM chunk_vectors");
  });

  test("a broken DB returns 0 instead of throwing", () => {
    const db = { exec: () => undefined, prepare: () => { throw new Error("gone"); } };
    expect(pruneOrphanVectors(db)).toBe(0);
  });
});

describe("hybridSearch", () => {
  const lexical = [{ source: "docs", title: "a", content: "alpha" }];

  test("passes lexical results through untouched when embeddings are disabled", async () => {
    const db = { prepare: () => ({ all: () => [], run: () => undefined, get: () => undefined }), exec: () => undefined };
    const out = await hybridSearch({ db, query: "alpha", lexical, limit: 3, config: null });
    expect(out).toBe(lexical);
  });

  test("a throwing DB degrades to lexical instead of failing the search", async () => {
    const db = {
      prepare: () => { throw new Error("db gone"); },
      exec: () => { throw new Error("db gone"); },
    };
    const out = await hybridSearch({
      db,
      query: "alpha",
      lexical,
      limit: 3,
      config: { url: "http://127.0.0.1:1/v1/embeddings", model: "m", timeoutMs: 50 },
    });
    expect(out).toEqual(lexical);
  });
});
