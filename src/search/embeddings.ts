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
 * Deliberately dependency-free. No model is bundled, no ONNX runtime is
 * pulled in, nothing phones home to a vendor: either the operator points
 * CONTEXT_MODE_EMBEDDINGS_URL at an endpoint they already run (Ollama,
 * llama.cpp, LM Studio, or a hosted OpenAI-compatible API), or the layer
 * probes localhost once and adopts an embedding runtime that is already
 * there. Neither present → every function here no-ops and search behaves
 * exactly as it did before.
 */

/** Model assumed when a local runtime is adopted without an explicit choice. */
export const DEFAULT_EMBEDDING_MODEL = "bge-m3";

export interface EmbeddingConfig {
  url: string;
  model: string;
  apiKey?: string;
  /**
   * Budget for the query embedding — the caller is waiting on this one.
   *
   * Was 5 000 ms. Measured against the reference local setup (Ollama, bge-m3,
   * 566M params F16, 1024 dims): a warm query is ~180 ms, but the first query
   * against an unloaded model costs **3 281 ms** while Ollama pages the
   * weights in (measured by forcing the unload with `keep_alive: 0`, so it is
   * a real load, not an estimate).
   *
   * That load happens at least once per runtime lifetime — the first embedding
   * query after Ollama or the machine restarts — and again on any host that
   * has not raised `OLLAMA_KEEP_ALIVE` past its five-minute default. It is not
   * frequent. It does not need to be: 5 000 ms left 1.5x headroom over a
   * 3 281 ms load measured on a fast local model with warm page cache, so a
   * larger model, a slower disk, a cold cache or a busy GPU crosses it and
   * then fails 100% of the time, not intermittently.
   *
   * And the failure is silent. `embedTexts` returns null, the semantic arm
   * drops out of the fusion, and the answer still looks like an answer — there
   * is no error for the operator to notice and no degradation they can see.
   * A default that quietly turns retrieval lexical on the first query after a
   * reboot is the wrong default however rarely it fires.
   *
   * 10 000 ms is 3x the measured load. A generous budget is CHEAP precisely
   * because the event is rare: the budget is only ever consumed when something
   * is already wrong, and the common dead-endpoint case does not reach it at
   * all — a refused connection fails in ~1 ms, not at the budget.
   */
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
  /**
   * Chunks embedded per background pass.
   *
   * Was 16. Measured throughput per vector on the reference local setup, by
   * batch size: 8 → 49.6 ms, 16 → 17.2 ms, 32 → 13.2 ms, 64 → 10.7 ms,
   * 128 → 9.4 ms. The knee is 64 — a 1.6x throughput gain over 16, where 128
   * buys a further 12% for twice the request. In wall-clock terms one batch of
   * 64 is ~687 ms, which sits far inside {@link backfillTimeoutMs} (120 s), and
   * the session-end drain (`backfillVectorsUntil`, 2 000 chunks in a 60 s
   * budget) goes from ~34 s of embedding to ~21 s — the difference between a
   * drain that finishes and one that runs out of clock.
   *
   * A failed batch loses nothing: `backfillVectors` writes only on success and
   * the rows keep their missing vector, so the next pass picks them up again.
   * The one regression a bigger batch could introduce is an endpoint with a
   * lower per-request input cap than 64, which would fail *permanently* and
   * silently; `backfillVectors` guards that with one shrink-and-retry.
   */
  backfillBatch: number;
  /**
   * Store vectors as int8 rather than float32. Cosine similarity is invariant
   * under positive scaling, so quantising to the vector's own max magnitude
   * costs ~0.4% rank noise and buys a 4× smaller table — which matters because
   * every query walks the whole table. bge-m3 emits 1024 dims: 4 KB per chunk
   * as float32, 1 KB as int8. Set CONTEXT_MODE_EMBEDDINGS_QUANT=f32 to opt out.
   */
  quantize?: boolean;
}

/**
 * @returns Config when the operator has enabled embeddings explicitly, else
 *   null. This is the synchronous contract other code has always relied on:
 *   no URL, no embeddings. Autodetection lives in resolveEmbeddingConfigAsync.
 */
export function resolveEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig | null {
  if (embeddingsDisabled(env)) return null;
  const url = env.CONTEXT_MODE_EMBEDDINGS_URL?.trim();
  const model = env.CONTEXT_MODE_EMBEDDINGS_MODEL?.trim();
  if (!url || !model) return null;
  return buildConfig(url, model, env);
}

export function isEmbeddingsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveEmbeddingConfig(env) !== null;
}

/** Hard off switch — honoured by both the explicit and the autodetected path. */
function embeddingsDisabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.CONTEXT_MODE_EMBEDDINGS?.trim().toLowerCase();
  return raw === "0" || raw === "off" || raw === "false";
}

function buildConfig(url: string, model: string, env: NodeJS.ProcessEnv): EmbeddingConfig {
  const num = (raw: string | undefined, fallback: number): number => {
    const parsed = Number.parseInt(raw ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    url,
    model,
    apiKey: env.CONTEXT_MODE_EMBEDDINGS_API_KEY?.trim() || undefined,
    // 5_000 → 10_000 and 16 → 64: see the field docs on EmbeddingConfig for
    // the measurements. Both were sized before the local-runtime numbers
    // existed, and both were costing the semantic layer silently.
    timeoutMs: num(env.CONTEXT_MODE_EMBEDDINGS_TIMEOUT_MS, 10_000),
    backfillTimeoutMs: num(env.CONTEXT_MODE_EMBEDDINGS_BACKFILL_TIMEOUT_MS, 120_000),
    backfillBatch: num(env.CONTEXT_MODE_EMBEDDINGS_BACKFILL, 64),
    quantize: env.CONTEXT_MODE_EMBEDDINGS_QUANT?.trim().toLowerCase() !== "f32",
  };
}

// ─────────────────────────────────────────────────────────
// Local runtime autodetection
// ─────────────────────────────────────────────────────────

/**
 * Endpoints probed when no URL is configured, in order of likelihood.
 *
 * Every candidate is loopback-only: an unconfigured install must never reach
 * out past the machine it runs on. `probe` is a cheap model listing, `embed`
 * is where the vectors come from.
 */
export const LOCAL_EMBEDDING_ENDPOINTS: ReadonlyArray<{
  name: string;
  probe: string;
  embed: string;
}> = [
  { name: "ollama", probe: "http://127.0.0.1:11434/api/tags", embed: "http://127.0.0.1:11434/api/embed" },
  { name: "lm-studio", probe: "http://127.0.0.1:1234/v1/models", embed: "http://127.0.0.1:1234/v1/embeddings" },
  { name: "llama.cpp", probe: "http://127.0.0.1:8080/v1/models", embed: "http://127.0.0.1:8080/v1/embeddings" },
];

/** Model names a listing endpoint reports, whatever shape it uses. */
export function parseModelListing(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const obj = payload as Record<string, unknown>;
  const out: string[] = [];
  // Ollama: {models: [{name: "bge-m3:latest"}]}
  if (Array.isArray(obj.models)) {
    for (const m of obj.models) {
      const name = (m as Record<string, unknown>)?.name ?? (m as Record<string, unknown>)?.model;
      if (typeof name === "string") out.push(name);
    }
  }
  // OpenAI-compatible: {data: [{id: "text-embedding-3-small"}]}
  if (Array.isArray(obj.data)) {
    for (const m of obj.data) {
      const id = (m as Record<string, unknown>)?.id;
      if (typeof id === "string") out.push(id);
    }
  }
  return out;
}

/**
 * Pick which of the listed models to embed with.
 *
 * Preference order: the operator's explicit choice, then bge-m3 (the model
 * this fork is tuned against — multilingual, so a Russian query matches an
 * English chunk), then anything that self-identifies as an embedding model.
 * A chat model would return garbage vectors, so "first model in the list" is
 * never an acceptable fallback.
 */
export function pickEmbeddingModel(available: string[], preferred?: string): string | null {
  if (available.length === 0) return null;
  const want = preferred?.trim();
  if (want) {
    const exact = available.find(m => m === want);
    if (exact) return exact;
    const tagged = available.find(m => m.split(":")[0] === want);
    if (tagged) return tagged;
    return null;
  }
  const bge = available.find(m => m.toLowerCase().startsWith(DEFAULT_EMBEDDING_MODEL));
  if (bge) return bge;
  const embedder = available.find(m => /embed|bge|gte|e5|minilm/i.test(m));
  return embedder ?? null;
}

/**
 * Probe the loopback endpoints for a usable embedding runtime.
 *
 * @returns The endpoint plus the model to use, or null when nothing local
 *   answers within the (deliberately tiny) budget.
 */
export async function detectLocalEmbeddingEndpoint(opts: {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  endpoints?: ReadonlyArray<{ name: string; probe: string; embed: string }>;
} = {}): Promise<{ name: string; url: string; model: string } | null> {
  const env = opts.env ?? process.env;
  const budget = opts.timeoutMs ?? 400;
  const preferred = env.CONTEXT_MODE_EMBEDDINGS_MODEL?.trim() || undefined;

  for (const endpoint of opts.endpoints ?? LOCAL_EMBEDDING_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      const res = await fetch(endpoint.probe, { signal: controller.signal });
      if (!res.ok) continue;
      const model = pickEmbeddingModel(parseModelListing(await res.json()), preferred);
      if (!model) continue;
      return { name: endpoint.name, url: endpoint.embed, model };
    } catch {
      continue;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** Memoised autodetection result. `null` means "probed, found nothing". */
let autoDetected: { config: EmbeddingConfig | null; atMs: number } | null = null;

/** Re-probe this often after a miss — a runtime started mid-session counts. */
const AUTODETECT_RETRY_MS = 5 * 60_000;

/** Test seam: forget both the probe result and the query cache. */
export function resetEmbeddingAutodetect(): void {
  autoDetected = null;
}

/**
 * Config for the answer path: the explicit one when set, otherwise whatever
 * local runtime answers a probe.
 *
 * Autodetection runs at most once per process (plus a retry window), and its
 * cost lands on the first hybrid search rather than on server startup —
 * a session that never searches never probes.
 */
export async function resolveEmbeddingConfigAsync(
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): Promise<EmbeddingConfig | null> {
  const explicit = resolveEmbeddingConfig(env);
  if (explicit) return explicit;
  if (embeddingsDisabled(env)) return null;
  if (env.CONTEXT_MODE_EMBEDDINGS_AUTODETECT === "0") return null;
  // An explicit URL that failed resolveEmbeddingConfig means only the model is
  // missing; probing a different endpoint would silently ignore the operator.
  if (env.CONTEXT_MODE_EMBEDDINGS_URL?.trim()) {
    return buildConfig(
      env.CONTEXT_MODE_EMBEDDINGS_URL.trim(),
      env.CONTEXT_MODE_EMBEDDINGS_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL,
      env,
    );
  }

  if (autoDetected && (autoDetected.config !== null || nowMs - autoDetected.atMs < AUTODETECT_RETRY_MS)) {
    return autoDetected.config;
  }

  const found = await detectLocalEmbeddingEndpoint({ env });
  const config = found ? buildConfig(found.url, found.model, env) : null;
  autoDetected = { config, atMs: nowMs };
  return config;
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

// ─────────────────────────────────────────────────────────
// Query embedding cache
// ─────────────────────────────────────────────────────────

/**
 * ctx_search takes an ARRAY of queries and agents re-ask the same question
 * across a session, so the same string is embedded repeatedly on the latency
 * path. A tiny LRU turns every repeat into a map lookup. Only single-text
 * (query) calls are cached — backfill batches are never repeated.
 */
const queryCache = new Map<string, number[]>();
const QUERY_CACHE_MAX = 256;

export function clearEmbeddingCache(): void {
  queryCache.clear();
}

export function embeddingCacheSize(): number {
  return queryCache.size;
}

function cacheGet(key: string): number[] | undefined {
  const hit = queryCache.get(key);
  if (!hit) return undefined;
  // Refresh recency.
  queryCache.delete(key);
  queryCache.set(key, hit);
  return hit;
}

function cacheSet(key: string, vec: number[]): void {
  queryCache.set(key, vec);
  while (queryCache.size > QUERY_CACHE_MAX) {
    const oldest = queryCache.keys().next().value;
    if (oldest === undefined) break;
    queryCache.delete(oldest);
  }
}

// ─────────────────────────────────────────────────────────
// Cold-start retry
// ─────────────────────────────────────────────────────────

/**
 * How long a stalled endpoint is denied the cold-start retry.
 *
 * The retry exists for one shape of failure: the model is not resident, the
 * runtime is loading it, and the request outlives
 * {@link EmbeddingConfig.timeoutMs}. That is worth one more attempt because
 * aborting the request does NOT abort the load — Ollama keeps paging the
 * weights in, so the second attempt lands on a model that is warm or nearly
 * warm and costs ~180 ms rather than another full 3 281 ms cold start.
 *
 * It pays off rarely — at most once per runtime lifetime, and only on a host
 * where the load outlasts a budget already sized at 3x the measured one. That
 * is affordable only because it costs NOTHING in the steady state: the retry
 * is reachable solely from a foreground timeout, and a warm query answers in
 * ~180 ms against a 10 000 ms budget, so on a healthy endpoint this branch is
 * never entered — no extra request, no extra latency, not even the clock read.
 *
 * An endpoint that accepts the connection and then never answers looks
 * identical on the first attempt, and there the retry is pure loss: it doubles
 * the stall on the latency path. So a retry that ALSO times out is treated as
 * proof of the second shape and switches the retry off for five minutes — long
 * enough that a hung endpoint costs the doubled stall once, not once per query.
 * The common dead-endpoint case never reaches any of this: a refused
 * connection rejects in about a millisecond, which is not a timeout.
 */
const COLD_START_RETRY_COOLDOWN_MS = 5 * 60_000;

/** Epoch ms before which no cold-start retry may fire. */
let coldStartRetryBlockedUntil = 0;

/** Test seam: forget that an endpoint was last seen stalling. */
export function resetColdStartRetry(): void {
  coldStartRetryBlockedUntil = 0;
}

/**
 * One request.
 *
 * `timedOut` is what separates "the budget expired" from every other failure,
 * and it is tracked on the timer rather than sniffed off the rejection: an
 * abort surfaces as a `DOMException`, a `TypeError` or a plain `Error`
 * depending on the runtime, and a retry policy must not hinge on which.
 */
async function embedOnce(
  texts: string[],
  config: EmbeddingConfig,
  budgetMs: number,
): Promise<{ vectors: number[][] | null; timedOut: boolean }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, budgetMs);
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
    if (!res.ok) return { vectors: null, timedOut: false };
    const parsed = parseEmbeddingResponse(await res.json());
    if (!parsed || parsed.length !== texts.length) return { vectors: null, timedOut: false };
    return { vectors: parsed, timedOut: false };
  } catch {
    return { vectors: null, timedOut };
  } finally {
    clearTimeout(timer);
  }
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

  const background = opts.background === true;
  const cacheable = !background && texts.length === 1;
  const cacheKey = cacheable ? `${config.model}\u0000${texts[0]}` : null;
  if (cacheKey) {
    const hit = cacheGet(cacheKey);
    if (hit) return [hit];
  }

  const budget = background ? config.backfillTimeoutMs : config.timeoutMs;
  let attempt = await embedOnce(texts, config, budget);

  // Background batches already carry a two-minute budget, so a cold start
  // hides inside it — only the latency path has anything left to retry.
  if (!attempt.vectors && attempt.timedOut && !background) {
    const now = Date.now();
    if (now >= coldStartRetryBlockedUntil) {
      attempt = await embedOnce(texts, config, budget);
      coldStartRetryBlockedUntil = !attempt.vectors && attempt.timedOut
        ? now + COLD_START_RETRY_COOLDOWN_MS
        : 0;
    }
  }

  if (!attempt.vectors) return null;
  if (cacheKey && attempt.vectors[0]?.length) cacheSet(cacheKey, attempt.vectors[0]);
  return attempt.vectors;
}

// ─────────────────────────────────────────────────────────
// Vector codec
// ─────────────────────────────────────────────────────────

/** Pack a vector for BLOB storage as float32 (4 bytes per dimension). */
export function encodeVector(vec: number[]): Buffer {
  const f32 = Float32Array.from(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/**
 * Pack a vector as int8, scaled to its own peak magnitude.
 *
 * The scale factor is deliberately NOT stored: cosine similarity divides by
 * both norms, so a per-vector positive scale cancels out. Dropping it keeps
 * the BLOB exactly `dim` bytes, which is what lets the decoder tell the two
 * formats apart without a schema migration.
 */
export function encodeVectorInt8(vec: number[]): Buffer {
  let peak = 0;
  for (const v of vec) {
    const abs = Math.abs(v);
    if (abs > peak) peak = abs;
  }
  const out = Buffer.allocUnsafe(vec.length);
  if (peak === 0) return out.fill(0);
  for (let i = 0; i < vec.length; i++) {
    // Clamp: rounding 127.4999 up must not wrap into -128.
    const q = Math.max(-127, Math.min(127, Math.round((vec[i] / peak) * 127)));
    out.writeInt8(q, i);
  }
  return out;
}

/** Unpack a stored float32 BLOB back into a Float32Array. */
export function decodeVector(buf: Buffer | Uint8Array): Float32Array {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  // Copy rather than view: better-sqlite3 buffers can share a pooled
  // ArrayBuffer whose byteOffset is not 4-aligned, which Float32Array rejects.
  const copy = Buffer.allocUnsafe(bytes.length);
  bytes.copy(copy);
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.length / 4));
}

/** Unpack a stored int8 BLOB. Values stay unscaled — cosine does not care. */
export function decodeVectorInt8(buf: Buffer | Uint8Array): Int8Array {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const copy = new Int8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) copy[i] = bytes.readInt8(i);
  return copy;
}

/**
 * Decode a stored vector of either format.
 *
 * Format is inferred from length against the `dim` the row already carries:
 * `dim` bytes is int8, `dim * 4` is float32. Rows written before quantisation
 * existed therefore keep working with no migration and no rewrite.
 */
export function decodeStoredVector(
  buf: Buffer | Uint8Array,
  dim?: number,
): Float32Array | Int8Array {
  const length = buf.length;
  if (dim && dim > 0) {
    if (length === dim) return decodeVectorInt8(buf);
    if (length === dim * 4) return decodeVector(buf);
  }
  // No usable dim: float32 blobs are always a multiple of 4 and int8 blobs
  // of a real model (768/1024 dims) are too, so fall back to the historical
  // format — a wrong guess scores 0 and simply drops the candidate.
  return decodeVector(buf);
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
