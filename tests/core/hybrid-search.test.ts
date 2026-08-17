import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  resolveEmbeddingConfig, isEmbeddingsEnabled, parseEmbeddingResponse,
  encodeVector, decodeVector, cosineSimilarity, embedTexts,
  encodeVectorInt8, decodeVectorInt8, decodeStoredVector,
  parseModelListing, pickEmbeddingModel, detectLocalEmbeddingEndpoint,
  resolveEmbeddingConfigAsync, resetEmbeddingAutodetect, clearEmbeddingCache,
  DEFAULT_EMBEDDING_MODEL,
} from "../../src/search/embeddings.js";
import {
  fuseRankings, hybridSearch, pruneOrphanVectors, pruneStaleModelVectors,
  vectorCoverage, semanticCandidates, backfillVectors, backfillVectorsUntil,
  getHybridTelemetry, resetHybridTelemetry,
} from "../../src/search/hybrid.js";

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

// ─────────────────────────────────────────────────────────
// int8 quantisation
// ─────────────────────────────────────────────────────────

describe("int8 vector storage", () => {
  test("a quantised vector keeps its direction", () => {
    // Cosine divides by both norms, so the per-vector scale cancels and only
    // rounding noise survives. That is the whole reason the scale is not stored.
    const vec = Array.from({ length: 256 }, (_, i) => Math.sin(i) * 0.37);
    const restored = decodeVectorInt8(encodeVectorInt8(vec));
    expect(cosineSimilarity(vec, restored)).toBeGreaterThan(0.999);
  });

  test("costs one byte per dimension instead of four", () => {
    const vec = Array.from({ length: 1024 }, () => 0.5);
    expect(encodeVectorInt8(vec)).toHaveLength(1024);
    expect(encodeVector(vec)).toHaveLength(4096);
  });

  test("an all-zero vector round-trips instead of dividing by zero", () => {
    const zeros = new Array(8).fill(0);
    expect([...decodeVectorInt8(encodeVectorInt8(zeros))]).toEqual(zeros);
  });

  test("decodeStoredVector tells the two formats apart by dim", () => {
    const vec = [0.5, -0.25, 1, 0];
    expect(decodeStoredVector(encodeVector(vec), 4)).toBeInstanceOf(Float32Array);
    expect(decodeStoredVector(encodeVectorInt8(vec), 4)).toBeInstanceOf(Int8Array);
    // Legacy rows written before quantisation existed still decode.
    expect([...decodeStoredVector(encodeVector(vec), 4)]).toEqual(vec);
  });
});

// ─────────────────────────────────────────────────────────
// Local runtime autodetection
// ─────────────────────────────────────────────────────────

describe("model listing", () => {
  test("reads Ollama and OpenAI-compatible shapes", () => {
    expect(parseModelListing({ models: [{ name: "bge-m3:latest" }, { name: "llama3" }] }))
      .toEqual(["bge-m3:latest", "llama3"]);
    expect(parseModelListing({ data: [{ id: "text-embedding-3-small" }] }))
      .toEqual(["text-embedding-3-small"]);
    expect(parseModelListing("nope")).toEqual([]);
  });
});

describe("pickEmbeddingModel", () => {
  test("prefers bge-m3 — the model this fork is tuned against", () => {
    expect(pickEmbeddingModel(["llama3:8b", "bge-m3:latest", "nomic-embed-text"]))
      .toBe("bge-m3:latest");
    expect(DEFAULT_EMBEDDING_MODEL).toBe("bge-m3");
  });

  test("honours an explicit choice, tag or no tag", () => {
    expect(pickEmbeddingModel(["bge-m3:latest", "nomic-embed-text"], "nomic-embed-text"))
      .toBe("nomic-embed-text");
    expect(pickEmbeddingModel(["mxbai-embed-large:335m"], "mxbai-embed-large"))
      .toBe("mxbai-embed-large:335m");
  });

  test("refuses to fall back to a chat model", () => {
    // A chat model answers the embed call with garbage vectors, which poisons
    // ranking silently — far worse than staying lexical.
    expect(pickEmbeddingModel(["llama3:8b", "qwen2.5-coder"])).toBeNull();
    expect(pickEmbeddingModel([])).toBeNull();
    expect(pickEmbeddingModel(["llama3:8b"], "bge-m3")).toBeNull();
  });
});

describe("detectLocalEmbeddingEndpoint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetEmbeddingAutodetect();
  });

  test("adopts the first loopback runtime that lists an embedding model", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("11434")) throw new Error("ECONNREFUSED");
      return { ok: true, json: async () => ({ data: [{ id: "bge-m3" }] }) };
    }));

    const found = await detectLocalEmbeddingEndpoint({ env: {} as NodeJS.ProcessEnv });
    expect(found?.name).toBe("lm-studio");
    expect(found?.model).toBe("bge-m3");
  });

  test("returns null when nothing local answers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await detectLocalEmbeddingEndpoint({ env: {} as NodeJS.ProcessEnv })).toBeNull();
  });
});

describe("resolveEmbeddingConfigAsync", () => {
  beforeEach(() => resetEmbeddingAutodetect());
  afterEach(() => {
    vi.unstubAllGlobals();
    resetEmbeddingAutodetect();
  });

  test("an explicit endpoint wins without probing anything", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const cfg = await resolveEmbeddingConfigAsync({
      CONTEXT_MODE_EMBEDDINGS_URL: "http://x/v1/embeddings",
      CONTEXT_MODE_EMBEDDINGS_MODEL: "bge-m3",
    } as NodeJS.ProcessEnv);
    expect(cfg?.url).toBe("http://x/v1/embeddings");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a URL without a model defaults to bge-m3 rather than staying off", async () => {
    const cfg = await resolveEmbeddingConfigAsync({
      CONTEXT_MODE_EMBEDDINGS_URL: "http://x/v1/embeddings",
    } as NodeJS.ProcessEnv);
    expect(cfg?.model).toBe("bge-m3");
  });

  test("CONTEXT_MODE_EMBEDDINGS=0 is a hard off switch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await resolveEmbeddingConfigAsync({
      CONTEXT_MODE_EMBEDDINGS: "0",
      CONTEXT_MODE_EMBEDDINGS_URL: "http://x/v1/embeddings",
      CONTEXT_MODE_EMBEDDINGS_MODEL: "bge-m3",
    } as NodeJS.ProcessEnv)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("autodetection is memoised — one probe per process, not per search", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ models: [{ name: "bge-m3:latest" }] }) }));
    vi.stubGlobal("fetch", fetchSpy);

    const first = await resolveEmbeddingConfigAsync({} as NodeJS.ProcessEnv);
    const second = await resolveEmbeddingConfigAsync({} as NodeJS.ProcessEnv);
    expect(first?.model).toBe("bge-m3:latest");
    expect(second?.model).toBe("bge-m3:latest");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("opting out of autodetection keeps an unconfigured install lexical", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await resolveEmbeddingConfigAsync({
      CONTEXT_MODE_EMBEDDINGS_AUTODETECT: "0",
    } as NodeJS.ProcessEnv)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("query embedding cache", () => {
  beforeEach(() => clearEmbeddingCache());
  afterEach(() => {
    vi.unstubAllGlobals();
    clearEmbeddingCache();
  });

  const config = {
    url: "http://x/v1/embeddings", model: "bge-m3",
    timeoutMs: 500, backfillTimeoutMs: 500, backfillBatch: 4,
  };

  test("the same query embeds once, however often it is asked", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ embeddings: [[1, 2, 3]] }) }));
    vi.stubGlobal("fetch", fetchSpy);

    expect(await embedTexts(["retry logic"], config)).toEqual([[1, 2, 3]]);
    expect(await embedTexts(["retry logic"], config)).toEqual([[1, 2, 3]]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("backfill batches are never served from cache", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ embeddings: [[1, 2, 3]] }) }));
    vi.stubGlobal("fetch", fetchSpy);

    await embedTexts(["a"], config, { background: true });
    await embedTexts(["a"], config, { background: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────
// Vector table maintenance
// ─────────────────────────────────────────────────────────

/** Records every SQL string prepared, so pushdown can be asserted. */
function recordingDb(rows: Record<string, unknown[]>, counts: Record<string, number> = {}) {
  const sqls: string[] = [];
  return {
    sqls,
    exec: () => undefined,
    prepare: (sql: string) => {
      sqls.push(sql);
      const key = Object.keys(rows).find(k => sql.includes(k));
      const countKey = Object.keys(counts).find(k => sql.includes(k));
      return {
        all: () => (key ? rows[key] : []),
        run: () => ({}),
        get: () => (countKey ? { c: counts[countKey] } : { c: 0 }),
      };
    },
  };
}

describe("pruneStaleModelVectors", () => {
  test("evicts vectors from a model that is no longer in use", () => {
    // Same-dimension vectors from a different model score plausible nonsense —
    // worse than scoring 0, because nothing looks broken.
    let deleted = "";
    const db = {
      exec: () => undefined,
      prepare: (sql: string) => ({
        get: () => ({ c: sql.includes("COUNT") ? 7 : 0 }),
        run: () => { if (sql.startsWith("DELETE")) deleted = sql; return {}; },
        all: () => [],
      }),
    };
    expect(pruneStaleModelVectors(db, "bge-m3")).toBe(7);
    expect(deleted).toContain("model != ?");
  });

  test("does nothing when every vector is current", () => {
    const db = {
      exec: () => undefined,
      prepare: () => ({ get: () => ({ c: 0 }), run: () => ({}), all: () => [] }),
    };
    expect(pruneStaleModelVectors(db, "bge-m3")).toBe(0);
  });
});

describe("vectorCoverage", () => {
  test("reports how much of the store is actually embedded", () => {
    const db = {
      exec: () => undefined,
      prepare: (sql: string) => ({
        get: () => (sql.includes("FROM chunks")
          ? { c: 100 }
          : { c: 40, b: 40 * 1024 }),
        all: () => [{ model: "bge-m3" }],
        run: () => ({}),
      }),
    };
    expect(vectorCoverage(db)).toEqual({ chunks: 100, vectors: 40, models: ["bge-m3"], bytes: 40960 });
  });

  test("a store without the table reports zeroes instead of throwing", () => {
    const db = { exec: () => { throw new Error("no db"); }, prepare: () => { throw new Error("no db"); } };
    expect(vectorCoverage(db).vectors).toBe(0);
  });
});

describe("backfillVectors", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("writes int8 blobs by default and float32 when asked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ embeddings: [[0.1, 0.2, 0.3, 0.4]] }),
    })));

    const written: unknown[][] = [];
    const db = {
      exec: () => undefined,
      prepare: (sql: string) => ({
        all: () => (sql.includes("LEFT JOIN chunk_vectors")
          ? [{ rowid: 1, title: "t", content: "c" }]
          : []),
        get: () => ({ c: 0 }),
        run: (...params: unknown[]) => { if (sql.startsWith("INSERT")) written.push(params); return {}; },
      }),
    };
    const base = { url: "http://x", model: "bge-m3", timeoutMs: 500, backfillTimeoutMs: 500, backfillBatch: 1 };

    expect(await backfillVectors(db, base, 1)).toBe(1);
    expect((written[0][3] as Buffer).length).toBe(4); // int8: 1 byte per dim

    written.length = 0;
    expect(await backfillVectors(db, { ...base, quantize: false }, 1)).toBe(1);
    expect((written[0][3] as Buffer).length).toBe(16); // float32
  });
});

describe("backfillVectorsUntil", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A store of `total` chunks that remembers which ones got a vector. */
  function fakeStore(total: number) {
    const embedded = new Set<number>();
    const db = {
      exec: () => undefined,
      prepare: (sql: string) => ({
        all: (...params: unknown[]) => {
          if (!sql.includes("LEFT JOIN chunk_vectors")) return [];
          const limit = Number(params[0] ?? 0);
          const out: Array<{ rowid: number; title: string; content: string }> = [];
          for (let i = 1; i <= total && out.length < limit; i++) {
            if (!embedded.has(i)) out.push({ rowid: i, title: `t${i}`, content: `c${i}` });
          }
          return out;
        },
        get: () => ({ c: 0 }),
        run: (...params: unknown[]) => {
          if (sql.startsWith("INSERT")) embedded.add(Number(params[0]));
          return {};
        },
      }),
    };
    return { db, embedded };
  }

  /** OpenAI/Ollama-shaped responder, optionally slow. */
  function stubEmbedder(delayMs = 0) {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      const input = JSON.parse(init.body).input as string[];
      return { ok: true, json: async () => ({ embeddings: input.map(() => [0.1, 0.2, 0.3, 0.4]) }) };
    }));
  }

  const config = { url: "http://x", model: "bge-m3", timeoutMs: 500, backfillTimeoutMs: 500, backfillBatch: 10 };

  test("stops at maxChunks instead of embedding the whole store", async () => {
    stubEmbedder();
    const { db, embedded } = fakeStore(100);
    expect(await backfillVectorsUntil(db, config, { maxChunks: 25, deadlineMs: 30_000 })).toBe(25);
    expect(embedded.size).toBe(25);
  });

  test("covers the store when the caps are generous — one pass, not 83 searches", async () => {
    stubEmbedder();
    const { db } = fakeStore(45);
    expect(await backfillVectorsUntil(db, config, { maxChunks: 2000, deadlineMs: 30_000 })).toBe(45);
  });

  test("stops at the deadline with partial progress rather than running on", async () => {
    stubEmbedder(40);
    const { db } = fakeStore(1000);
    const started = Date.now();
    const done = await backfillVectorsUntil(db, { ...config, backfillBatch: 1 }, {
      maxChunks: 1000,
      deadlineMs: 120,
    });
    expect(done).toBeGreaterThan(0);
    expect(done).toBeLessThan(1000);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("an endpoint that refuses yields 0 instead of spinning", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const { db } = fakeStore(50);
    expect(await backfillVectorsUntil(db, config, { maxChunks: 50, deadlineMs: 5_000 })).toBe(0);
  });

  test("zeroed bounds are an off switch", async () => {
    stubEmbedder();
    const { db } = fakeStore(50);
    expect(await backfillVectorsUntil(db, config, { maxChunks: 0 })).toBe(0);
    expect(await backfillVectorsUntil(db, config, { deadlineMs: 0 })).toBe(0);
  });
});

describe("semanticCandidates", () => {
  test("pushes the source filter into the scan instead of filtering after", () => {
    // Filtering afterwards meant a scoped search still paid cosine over every
    // vector in the store — and could return nothing when the global top-K all
    // belonged to other sources.
    const db = recordingDb({});
    semanticCandidates(db, [1, 0], { limit: 5, sourceFilter: "code:" });
    const scan = db.sqls.find(s => s.includes("chunk_vectors"));
    expect(scan).toContain("JOIN sources");
    expect(scan).toContain("sources.label LIKE ?");
  });

  test("scans the whole table only when no filter is given", () => {
    const db = recordingDb({});
    semanticCandidates(db, [1, 0], { limit: 5 });
    expect(db.sqls.some(s => s === "SELECT chunk_rowid, dim, vec FROM chunk_vectors")).toBe(true);
  });

  test("streams through iterate() when the driver offers it", () => {
    let iterated = false;
    const db = {
      exec: () => undefined,
      prepare: () => ({
        all: () => [],
        get: () => ({ c: 0 }),
        run: () => ({}),
        iterate: () => { iterated = true; return []; },
      }),
    };
    semanticCandidates(db, [1, 0], { limit: 5 });
    expect(iterated).toBe(true);
  });
});

describe("hybrid telemetry", () => {
  beforeEach(() => {
    resetHybridTelemetry();
    clearEmbeddingCache();
  });
  afterEach(() => vi.unstubAllGlobals());

  test("counts a pass that changed the ranking", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ embeddings: [[1, 0]] }),
    })));

    const vec = encodeVectorInt8([1, 0]);
    const db = {
      exec: () => undefined,
      prepare: (sql: string) => ({
        all: () => {
          if (sql.includes("FROM chunk_vectors")) return [{ chunk_rowid: 9, dim: 2, vec }];
          if (sql.includes("FROM chunks")) {
            return [{
              rowid: 9, title: "backoff", content: "exponential backoff",
              content_type: null, timestamp: null, session_id: null, source: "docs",
            }];
          }
          return [];
        },
        get: () => ({ c: 0 }),
        run: () => ({}),
      }),
    };

    const out = await hybridSearch({
      db,
      query: "why does it keep retrying",
      lexical: [{ source: "docs", title: "cache", content: "cache invalidation" }],
      limit: 3,
      backfillBatch: 0,
      config: { url: "http://x", model: "bge-m3", timeoutMs: 500, backfillTimeoutMs: 500, backfillBatch: 0 },
    });

    expect(out).toHaveLength(2);
    const t = getHybridTelemetry();
    expect(t.searches).toBe(1);
    expect(t.withCandidates).toBe(1);
    expect(t.changedRanking).toBe(1);
  });
});
