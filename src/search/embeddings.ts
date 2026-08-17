/**
 * Optional semantic layer over the FTS5 knowledge base.
 *
 * The existing pipeline is purely lexical: a Porter matcher and a trigram
 * matcher fused with RRF. That is excellent at "find the chunk containing
 * `useEffect`" and blind to "why does the deploy keep failing" when the
 * chunk says "build step exits 137". Adding embeddings closes that gap
 * without replacing anything — semantic hits are fused into the same RRF
 * the lexical strategies already use, so a bad embedding model degrades
 * ranking slightly instead of breaking search.
 *
 * Deliberately dependency-free and OFF by default. No model is bundled, no
 * ONNX runtime is pulled in, nothing phones home: the operator points
 * CONTEXT_MODE_EMBEDDINGS_URL at an endpoint they already run (Ollama,
 * llama.cpp, LM Studio, or a hosted OpenAI-compatible API) and the layer
 * turns itself on. Unset → every function here no-ops and search behaves
 * exactly as it did before.
 */

export interface EmbeddingConfig {
  url: string;
  model: string;
  apiKey?: string;
  /** Budget for the query embedding — the caller is waiting on this one. */
  timeoutMs: number;
  /**
   * Budget for background backfill batches, which are an order of magnitude
   * slower than a single query: measured against bge-m3 on CPU, one query is
   * ~230ms while a batch of 32 real chunks takes ~14s. Sharing the query
   * timeout would abort every backfill before it wrote a single vector, and
   * the index would stay permanently cold while search silently degraded to
   * lexical — the failure mode is invisible, which is what makes it bad.
   */
  backfillTimeoutMs: number;
  /** Chunks embedded per background pass. */
  backfillBatch: number;
}

/**
 * @returns Config when the operator has enabled embeddings, else null.
 */
export function resolveEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig | null {
  const url = env.CONTEXT_MODE_EMBEDDINGS_URL?.trim();
  const model = env.CONTEXT_MODE_EMBEDDINGS_MODEL?.trim();
  if (!url || !model) return null;
  const num = (raw: string | undefined, fallback: number): number => {
    const parsed = Number.parseInt(raw ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    url,
    model,
    apiKey: env.CONTEXT_MODE_EMBEDDINGS_API_KEY?.trim() || undefined,
    timeoutMs: num(env.CONTEXT_MODE_EMBEDDINGS_TIMEOUT_MS, 5_000),
    backfillTimeoutMs: num(env.CONTEXT_MODE_EMBEDDINGS_BACKFILL_TIMEOUT_MS, 120_000),
    backfillBatch: num(env.CONTEXT_MODE_EMBEDDINGS_BACKFILL, 16),
  };
}

export function isEmbeddingsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveEmbeddingConfig(env) !== null;
}

/**
 * Parse the two response shapes worth supporting: OpenAI
 * (`{data:[{embedding:[…]}]}`) and Ollama native (`{embeddings:[[…]]}`).
 */
export function parseEmbeddingResponse(payload: unknown): number[][] | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;

  if (Array.isArray(obj.data)) {
    const out: number[][] = [];
    for (const row of obj.data) {
      const emb = (row as Record<string, unknown>)?.embedding;
      if (!Array.isArray(emb)) return null;
      out.push(emb as number[]);
    }
    return out;
  }

  if (Array.isArray(obj.embeddings)) {
    const rows = obj.embeddings as unknown[];
    if (rows.every(r => Array.isArray(r))) return rows as number[][];
  }

  // Single-vector Ollama `/api/embeddings` response.
  if (Array.isArray(obj.embedding)) return [obj.embedding as number[]];

  return null;
}

/**
 * Embed a batch of texts.
 *
 * @returns One vector per input, or null when embeddings are disabled or the
 *   endpoint failed. Callers treat null as "fall back to lexical only" —
 *   a search must never fail because an optional side-car is down.
 */
export async function embedTexts(
  texts: string[],
  config: EmbeddingConfig | null = resolveEmbeddingConfig(),
  opts: { background?: boolean } = {},
): Promise<number[][] | null> {
  if (!config || texts.length === 0) return null;

  const budget = opts.background ? config.backfillTimeoutMs : config.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  try {
    const res = await fetch(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: config.model, input: texts }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const parsed = parseEmbeddingResponse(await res.json());
    if (!parsed || parsed.length !== texts.length) return null;
    return parsed;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Pack a vector for BLOB storage. */
export function encodeVector(vec: number[]): Buffer {
  const f32 = Float32Array.from(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/** Unpack a stored BLOB back into a Float32Array view. */
export function decodeVector(buf: Buffer | Uint8Array): Float32Array {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  // Copy rather than view: better-sqlite3 buffers can share a pooled
  // ArrayBuffer whose byteOffset is not 4-aligned, which Float32Array rejects.
  const copy = Buffer.allocUnsafe(bytes.length);
  bytes.copy(copy);
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.length / 4));
}

/**
 * @returns Cosine similarity in [-1, 1]; 0 when either vector is degenerate
 *   or the dimensions disagree (mixed models in one DB).
 */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
