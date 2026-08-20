/**
 * Hybrid retrieval: fuse the lexical FTS5 ranking with semantic neighbours.
 *
 * Runs entirely beside the existing pipeline. `store.search()` is untouched;
 * this module takes the lexical results the handler already has, adds
 * semantic candidates, and fuses both lists with Reciprocal Rank Fusion —
 * the same fusion the lexical strategies use between themselves, so the
 * scoring story stays consistent.
 *
 * Vectors are backfilled lazily: each hybrid search embeds a small batch of
 * not-yet-embedded chunks in the background. A cold knowledge base therefore
 * behaves exactly like the lexical one and gets progressively better,
 * instead of demanding a blocking bulk-index pass before it is useful.
 *
 * The semantic side is two-phase (see ./coarse-scan.ts): a cheap Hamming pass
 * over one-bit-per-dimension codes shortlists a few hundred candidates, and
 * the exact cosine — unchanged, over the same stored vectors — ranks only
 * those. Every path that cannot shortlist safely falls back to the exact full
 * scan, so the worst case is the cost this replaced rather than a wrong answer.
 */

import {
  cosineSimilarity, decodeStoredVector, embedTexts, encodeVector, encodeVectorInt8,
  resolveEmbeddingConfigAsync, type EmbeddingConfig,
} from "./embeddings.js";
import {
  COARSE_CACHE_MAX_BYTES, COARSE_CODE_REV, COARSE_EXACT_CAP, CoarseCodeCache,
  ShortlistHeap, bruteForceScanForced, coarseCode, coarseCodeWords, coarseDistance,
  coarseShortlistSize,
} from "./coarse-scan.js";

/** Shape of the rows the lexical pipeline returns. */
export interface LexicalResult {
  title: string;
  content: string;
  /** Source label, named `source` to match ContentStore's result shape. */
  source: string;
  [key: string]: unknown;
}

interface VectorRow {
  chunk_rowid: number;
  dim: number | null;
  vec: Buffer;
}

/** What the coarse pass reads: a fraction of the bytes of a {@link VectorRow}. */
interface CoarseRow {
  chunk_rowid: number;
  dim: number | null;
  code: Buffer | null;
}

interface ChunkRow {
  rowid: number;
  title: string;
  content: string;
  content_type: string | null;
  timestamp: string | null;
  session_id: string | null;
  source: string;
}

/** Minimal better-sqlite3 surface used here. */
export interface HybridDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    /** Present on better-sqlite3; used to stream the vector scan. */
    iterate?(...params: unknown[]): Iterable<unknown>;
  };
  exec(sql: string): unknown;
}

/**
 * Identity of a chunk, independent of which strategy or which query surfaced it.
 *
 * Used to fuse a chunk that came back through both lexical and semantic search,
 * and to recognise the same chunk across the queries of one response
 * (see `CrossQueryDeduper` in server.ts). `source::title` alone is not enough:
 * a live index carries `Untitled (12)`, `… (1)`, `… (2)` — distinct chunks that
 * share a label and collide on title.
 */
export function chunkIdentity(r: { source: string; title: string; content: string }): string {
  return `${r.source} ${r.title} ${(r.content ?? "").slice(0, 120)}`;
}

/**
 * @returns true when the table is there to be used. Never throws: a store this
 *   process cannot write to (read-only handle, corrupt file, older schema) must
 *   degrade to lexical search, not fail the caller's tool call.
 */
export function ensureVectorTable(db: HybridDb): boolean {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chunk_vectors (
        chunk_rowid INTEGER PRIMARY KEY,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vec BLOB NOT NULL
      )
    `);
    return true;
  } catch {
    return false;
  }
}

/** Databases whose stale-revision purge has already run in this process. */
const coarsePurged = new WeakSet<object>();

/**
 * Add the coarse-code columns, and erase codes written by an older revision.
 *
 * `ALTER TABLE ... ADD COLUMN` is the whole migration: a store that predates
 * two-phase retrieval gains two NULL columns, and every one of its rows is
 * then treated as "no code yet" — which forces it into the shortlist rather
 * than dropping it, so an unmigrated store answers exactly as it did before
 * while the background backfill fills the codes in.
 *
 * The stale-revision purge goes through `exec` with the revision inlined
 * (an integer constant, never user input) so it costs no prepared statement,
 * and runs once per process per handle: a code from a different rotation is
 * not merely worse, it is meaningless, and the resulting bad neighbours would
 * look exactly like good ones.
 *
 * @returns true when the columns are usable.
 */
export function ensureCoarseColumns(db: HybridDb): boolean {
  if (!ensureVectorTable(db)) return false;
  try {
    // Each ALTER is separate: the second must still run when the first throws
    // "duplicate column name" on an already-migrated store.
    for (const sql of [
      "ALTER TABLE chunk_vectors ADD COLUMN code BLOB",
      "ALTER TABLE chunk_vectors ADD COLUMN code_rev INTEGER",
    ]) {
      try { db.exec(sql); } catch { /* already present */ }
    }
    if (!coarsePurged.has(db as unknown as object)) {
      coarsePurged.add(db as unknown as object);
      db.exec(
        `UPDATE chunk_vectors SET code = NULL, code_rev = NULL
         WHERE code IS NOT NULL AND (code_rev IS NULL OR code_rev != ${COARSE_CODE_REV})`,
      );
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Codes computed per background pass.
 *
 * One code is two Walsh-Hadamard passes over the padded dimension — ~20k adds
 * at 1024 dims, so this batch is tens of milliseconds of work plus half a
 * megabyte of blob reads. Small enough to hide behind a response, large enough
 * that a store warms up in a handful of searches rather than a hundred.
 */
export const COARSE_BACKFILL_BATCH = 512;

/**
 * Compute coarse codes for up to `limit` vectors that have none.
 *
 * Runs off the answer path, beside the embedding backfill, for the same
 * reason: the user waits for the search, not for the index to catch up. Until
 * a row has a code it is force-included in every shortlist, so this is purely
 * a speed backfill — a row it has not reached yet is slow to rank, never
 * missing from results.
 *
 * @returns Number of codes written.
 */
export function backfillCoarseCodes(db: HybridDb, limit = COARSE_BACKFILL_BATCH): number {
  if (limit <= 0) return 0;
  if (!ensureCoarseColumns(db)) return 0;
  try {
    const rows = db.prepare(
      "SELECT chunk_rowid, dim, vec FROM chunk_vectors WHERE code IS NULL LIMIT ?",
    ).all(limit) as VectorRow[];
    if (rows.length === 0) return 0;
    const stmt = db.prepare(
      "UPDATE chunk_vectors SET code = ?, code_rev = ? WHERE chunk_rowid = ?",
    );
    let written = 0;
    for (const row of rows) {
      const code = coarseCode(decodeStoredVector(row.vec, row.dim ?? undefined));
      // A degenerate vector gets no code and would be force-included forever,
      // so it is marked at the current revision with a NULL code left in
      // place — `code IS NULL` still selects it, which is the honest state:
      // there is nothing to rank it by cheaply. Bounded by construction: a
      // zero vector is what an embedding endpoint returns when it fails, and
      // those rows are rare.
      if (!code) continue;
      stmt.run(code, COARSE_CODE_REV, row.chunk_rowid);
      written++;
    }
    if (written > 0) invalidateCoarseCache(db);
    return written;
  } catch {
    return 0;
  }
}

/**
 * Drop vectors whose chunk is gone.
 *
 * `chunks` is an FTS5 table: re-indexing a source deletes and re-inserts its
 * rows, and the new rows get new rowids. Vectors keyed to the old ones are
 * then dead weight that the brute-force scan still walks on every query —
 * measured on a fresh store, a single re-index left twice as many vectors as
 * chunks.
 *
 * @returns Number of orphaned vectors removed.
 */
export function pruneOrphanVectors(db: HybridDb): number {
  if (!ensureVectorTable(db)) return 0;
  try {
    const before = (db.prepare("SELECT COUNT(*) c FROM chunk_vectors").get() as { c: number }).c;
    db.prepare(
      "DELETE FROM chunk_vectors WHERE chunk_rowid NOT IN (SELECT rowid FROM chunks)",
    ).run();
    const after = (db.prepare("SELECT COUNT(*) c FROM chunk_vectors").get() as { c: number }).c;
    if (after !== before) invalidateCoarseCache(db);
    return before - after;
  } catch {
    return 0;
  }
}

/**
 * Drop vectors produced by a different model.
 *
 * Two models' vectors are not comparable — different dimensionality scores 0
 * (harmless but dead weight), and same dimensionality scores *plausible
 * nonsense*, which is worse. Switching CONTEXT_MODE_EMBEDDINGS_MODEL therefore
 * evicts the old vectors and lets the normal lazy backfill re-embed, rather
 * than leaving the store permanently half-degraded with no visible symptom.
 *
 * @returns Number of stale vectors removed.
 */
export function pruneStaleModelVectors(db: HybridDb, model: string): number {
  if (!ensureVectorTable(db)) return 0;
  try {
    const before = (db.prepare(
      "SELECT COUNT(*) c FROM chunk_vectors WHERE model != ?",
    ).get(model) as { c: number }).c;
    if (before === 0) return 0;
    db.prepare("DELETE FROM chunk_vectors WHERE model != ?").run(model);
    invalidateCoarseCache(db);
    return before;
  } catch {
    return 0;
  }
}

/**
 * How much of the knowledge base is actually embedded.
 *
 * ctx_stats reports this because "hybrid search is on" and "hybrid search can
 * answer" are different states, and the gap between them is invisible
 * otherwise: a cold index degrades silently to lexical.
 */
export function vectorCoverage(db: HybridDb): {
  chunks: number;
  vectors: number;
  models: string[];
  bytes: number;
} {
  if (!ensureVectorTable(db)) return { chunks: 0, vectors: 0, models: [], bytes: 0 };
  try {
    const chunks = (db.prepare("SELECT COUNT(*) c FROM chunks").get() as { c: number }).c;
    const stat = db.prepare(
      "SELECT COUNT(*) c, COALESCE(SUM(LENGTH(vec)), 0) b FROM chunk_vectors",
    ).get() as { c: number; b: number };
    const models = (db.prepare(
      "SELECT DISTINCT model FROM chunk_vectors",
    ).all() as Array<{ model: string }>).map(r => r.model);
    return { chunks, vectors: stat.c, models, bytes: stat.b };
  } catch {
    return { chunks: 0, vectors: 0, models: [], bytes: 0 };
  }
}

/**
 * Batch size the backfill falls back to when a larger one fails outright.
 *
 * This is the historical default (`CONTEXT_MODE_EMBEDDINGS_BACKFILL` was 16
 * before the throughput measurements moved it to 64), which makes it the
 * largest batch that is known to have worked against every endpoint this has
 * ever run on. It only matters for an endpoint with a per-request input cap
 * between the two: without the fallback such an endpoint would fail EVERY
 * backfill pass, the semantic index would never warm, and search would degrade
 * to lexical without saying so.
 */
const BACKFILL_FALLBACK_BATCH = 16;

/**
 * Embed up to `limit` chunks that have no vector yet.
 *
 * @returns Number of chunks embedded.
 */
export async function backfillVectors(
  db: HybridDb,
  config: EmbeddingConfig,
  limit = config.backfillBatch,
): Promise<number> {
  if (!ensureVectorTable(db)) return 0;
  pruneOrphanVectors(db);
  pruneStaleModelVectors(db, config.model);
  // Top up coarse codes for vectors written before two-phase retrieval existed.
  // Runs here rather than in `semanticCandidates` because both callers of the
  // semantic path (`hybridSearch` and `ctx_find`'s provider) already fire this
  // after answering — so a legacy store converges through ordinary use, and no
  // write lands on the latency path.
  backfillCoarseCodes(db);
  let rows: Array<{ rowid: number; title: string; content: string }>;
  try {
    rows = db.prepare(`
      SELECT chunks.rowid AS rowid, chunks.title AS title, chunks.content AS content
      FROM chunks
      LEFT JOIN chunk_vectors ON chunk_vectors.chunk_rowid = chunks.rowid
      WHERE chunk_vectors.chunk_rowid IS NULL
      LIMIT ?
    `).all(limit) as Array<{ rowid: number; title: string; content: string }>;
  } catch {
    return 0;
  }
  if (rows.length === 0) return 0;

  // Title carries the section heading — prepending it gives the model the
  // context a bare content slice would lack.
  const texts = rows.map(r => `${r.title ?? ""}\n${(r.content ?? "").slice(0, 4000)}`.trim());
  let vectors = await embedTexts(texts, config, { background: true });
  // One shrink-and-retry, and only downward past the size that has always
  // worked (see BACKFILL_FALLBACK_BATCH). An endpoint that is simply down pays
  // for a second request here, but it fails on connect rather than on the
  // budget, and this whole path is background work fired after the answer.
  if (!vectors && rows.length > BACKFILL_FALLBACK_BATCH) {
    rows = rows.slice(0, BACKFILL_FALLBACK_BATCH);
    vectors = await embedTexts(texts.slice(0, BACKFILL_FALLBACK_BATCH), config, { background: true });
  }
  if (!vectors) return 0;

  const quantize = config.quantize !== false;
  // Code at insert time: the vector is already in memory, so a fresh row never
  // enters the store code-less and never has to be force-rescored later.
  const coded = ensureCoarseColumns(db);
  try {
    const stmt = coded
      ? db.prepare(
        "INSERT OR REPLACE INTO chunk_vectors (chunk_rowid, model, dim, vec, code, code_rev) VALUES (?, ?, ?, ?, ?, ?)",
      )
      : db.prepare(
        "INSERT OR REPLACE INTO chunk_vectors (chunk_rowid, model, dim, vec) VALUES (?, ?, ?, ?)",
      );
    for (let i = 0; i < rows.length; i++) {
      const blob = quantize ? encodeVectorInt8(vectors[i]) : encodeVector(vectors[i]);
      if (coded) {
        stmt.run(rows[i].rowid, config.model, vectors[i].length, blob,
          coarseCode(vectors[i]), COARSE_CODE_REV);
      } else {
        stmt.run(rows[i].rowid, config.model, vectors[i].length, blob);
      }
    }
  } catch {
    return 0;
  }
  invalidateCoarseCache(db);
  return rows.length;
}

/**
 * Embed repeatedly until the index is covered, the deadline passes, or
 * `maxChunks` chunks have been embedded.
 *
 * The per-search backfill is sized for the hot path — one small batch, so a
 * search never pays for a bulk index. That makes it a warm-up, not a way to
 * reach full coverage: a 1,320-chunk store at 16 chunks per search needs ~83
 * searches. This is the bounded bulk pass, called from `context-mode drain`
 * (which the SessionEnd hook already runs detached), where latency is free.
 *
 * Bounded on both axes on purpose: a wall clock so a detached drain cannot run
 * forever, and a chunk cap so a huge cold store cannot monopolise a local
 * embedding endpoint.
 *
 * @returns Number of chunks embedded across all batches.
 */
export async function backfillVectorsUntil(
  db: HybridDb,
  config: EmbeddingConfig,
  opts: { deadlineMs?: number; maxChunks?: number } = {},
): Promise<number> {
  const deadlineMs = opts.deadlineMs ?? 60_000;
  const maxChunks = opts.maxChunks ?? 2000;
  if (deadlineMs <= 0 || maxChunks <= 0) return 0;
  if (!ensureVectorTable(db)) return 0;

  const started = Date.now();
  let total = 0;
  while (total < maxChunks && Date.now() - started < deadlineMs) {
    const batch = Math.min(config.backfillBatch, maxChunks - total);
    const done = await backfillVectors(db, config, batch);
    // 0 means either "nothing left to embed" or "the endpoint refused" — both
    // are reasons to stop rather than spin.
    if (done === 0) break;
    total += done;
  }

  // Codes for anything the embedding loop did not touch. A store that is
  // fully embedded but predates two-phase retrieval exits the loop above on
  // the first iteration, so without this the drain would never finish the
  // migration and every search would keep force-rescoring the whole table.
  // Same two bounds, for the same reasons.
  let codes = 0;
  while (codes < maxChunks && Date.now() - started < deadlineMs) {
    const done = backfillCoarseCodes(db, Math.min(COARSE_BACKFILL_BATCH, maxChunks - codes));
    if (done === 0) break;
    codes += done;
  }

  return total;
}

/**
 * The source filter, pushed into the scan itself.
 *
 * Filtering afterwards meant a search scoped to one label still paid for
 * cosine over every vector in the store, and could return nothing at all when
 * the top-K global neighbours all belonged to other sources. Both phases share
 * this so the shortlist is drawn from the same population the answer is.
 */
function scopedScanSql(columns: string, sourceFilter?: string): string {
  if (!sourceFilter) return `SELECT ${columns} FROM chunk_vectors`;
  const qualified = columns.split(", ").map(c => `cv.${c} AS ${c}`).join(", ");
  return `SELECT ${qualified}
       FROM chunk_vectors cv
       JOIN chunks ON chunks.rowid = cv.chunk_rowid
       JOIN sources ON sources.id = chunks.source_id
       WHERE sources.label LIKE ? ESCAPE '\\'`;
}

/**
 * Unpack a stored vector for scoring.
 *
 * Identical values to {@link decodeStoredVector}, but the int8 case is a view
 * over the driver's buffer instead of a byte-at-a-time copy. `Int8Array` has
 * no alignment requirement — only the float32 path needs the copy — and that
 * copy was a per-row allocation plus ~1024 `readInt8` calls on the hot scan.
 */
function decodeForScan(buf: Buffer, dim?: number): Float32Array | Int8Array {
  if (dim && dim > 0 && buf.length === dim) {
    return new Int8Array(buf.buffer, buf.byteOffset, buf.length);
  }
  return decodeStoredVector(buf, dim);
}

/** Exact cosine over whatever rows `stmt` yields, kept in similarity order. */
function exactScan(
  stmt: ReturnType<HybridDb["prepare"]>,
  params: unknown[],
  queryVec: number[],
  limit: number,
): Array<{ rowid: number; score: number }> {
  const scored: Array<{ rowid: number; score: number }> = [];
  const rows: Iterable<unknown> = typeof stmt.iterate === "function"
    ? stmt.iterate(...params)
    : (stmt.all(...params) as unknown[]);
  for (const raw of rows) {
    const row = raw as VectorRow;
    const score = cosineSimilarity(queryVec, decodeForScan(row.vec, row.dim ?? undefined));
    if (score > 0) scored.push({ rowid: row.chunk_rowid, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ─────────────────────────────────────────────────────────
// Resident codes
// ─────────────────────────────────────────────────────────

interface CachedCodes {
  cache: CoarseCodeCache;
  /** Vector dimension this cache was built for — a different model needs its own. */
  dim: number;
  /** Validity witnesses, both O(1)-ish, checked before every reuse. */
  rows: number;
  dataVersion: number;
}

const codeCaches = new WeakMap<object, CachedCodes>();

/**
 * Forget the resident codes for this store.
 *
 * Called from every function here that writes to `chunk_vectors`, because
 * `PRAGMA data_version` deliberately does not move for writes made on the
 * connection doing the reading — it reports OTHER connections' commits. Our
 * own writes therefore have to say so themselves.
 */
export function invalidateCoarseCache(db: HybridDb): void {
  codeCaches.delete(db as unknown as object);
}

/**
 * The two cheap witnesses that the cache still describes the table.
 *
 * `data_version` catches anything another connection committed — the detached
 * `context-mode drain` embedding in the background is the concrete case.
 * `COUNT(*)` catches inserts and deletes made on this connection by code
 * outside this module (a re-index through `ContentStore` orphans vectors).
 * Measured at 25k rows: 0.14 ms for the count, ~1 µs for the pragma, against
 * a 42 ms scan — worth paying on every query to never serve a stale shortlist.
 */
function coarseTableWitness(db: HybridDb): { rows: number; dataVersion: number } | null {
  try {
    const rows = (db.prepare("SELECT COUNT(*) c FROM chunk_vectors").get() as { c: number }).c;
    const pragma = db.prepare("PRAGMA data_version").get() as Record<string, number> | undefined;
    const dataVersion = pragma ? Number(Object.values(pragma)[0] ?? 0) : 0;
    return { rows, dataVersion };
  } catch {
    return null;
  }
}

/**
 * Every code for `dim`, resident and ready to scan.
 *
 * @returns null when the cache is unusable — the table is empty, it would
 *   exceed {@link COARSE_CACHE_MAX_BYTES}, or the read failed. The caller then
 *   reads codes out of SQLite instead, which is the same algorithm at the
 *   pre-cache price.
 *
 * Rebuilt in full whenever the witnesses move, which during an active backfill
 * is every search — one extra full scan, the cost the whole query used to be,
 * on a store that is still warming up. Incremental updates would remove that,
 * at the price of a second way for the cache to be wrong about a table it does
 * not own; a transient warm-up cost is the better trade.
 */
function residentCodes(db: HybridDb, dim: number, words: number): CoarseCodeCache | null {
  const witness = coarseTableWitness(db);
  if (!witness || witness.rows === 0) return null;

  const hit = codeCaches.get(db as unknown as object);
  if (hit && hit.dim === dim && hit.cache.words === words
      && hit.rows === witness.rows && hit.dataVersion === witness.dataVersion) {
    return hit.cache;
  }
  if (witness.rows * words * 4 > COARSE_CACHE_MAX_BYTES) return null;

  const cache = new CoarseCodeCache(words, witness.rows);
  try {
    const stmt = db.prepare("SELECT chunk_rowid, dim, code FROM chunk_vectors");
    const rows: Iterable<unknown> = typeof stmt.iterate === "function"
      ? stmt.iterate()
      : (stmt.all() as unknown[]);
    for (const raw of rows) {
      const row = raw as CoarseRow;
      // Another model's vectors are not comparable at all — the exact pass
      // scores them 0. Leaving them out entirely beats spending shortlist
      // slots on rows that are guaranteed to be dropped.
      if (row.dim != null && row.dim > 0 && row.dim !== dim) continue;
      cache.add(row.chunk_rowid, row.code);
    }
  } catch {
    return null;
  }
  codeCaches.set(db as unknown as object, { cache, dim, ...witness });
  return cache;
}

/**
 * Phase one: shortlist by Hamming distance over the one-bit-per-dimension
 * codes, and collect every row that has no code yet.
 *
 * @returns null when the coarse pass cannot be trusted to shortlist — no codes
 *   at all (an unmigrated store, or one whose backfill has not started), a
 *   query vector too degenerate to code, or more code-less rows than the exact
 *   pass would want to rescore. Every one of those means "fall back to the
 *   full exact scan", which is the same answer at the old price.
 */
function coarseShortlist(
  db: HybridDb,
  queryVec: number[],
  opts: { limit: number; sourceFilter?: string },
): number[] | null {
  if (!ensureCoarseColumns(db)) return null;
  const queryCode = coarseCodeWords(queryVec);
  if (!queryCode) return null;
  const size = coarseShortlistSize(opts.limit);

  // An unscoped query is the common one and the expensive one, and it is the
  // only one the resident cache can answer: the cache holds no source, so a
  // scoped search would have to filter afterwards — which is exactly the bug
  // `scopedScanSql` exists to prevent. Scoped searches take the SQL path,
  // where they are already narrower by construction.
  if (!opts.sourceFilter) {
    const resident = residentCodes(db, queryVec.length, queryCode.length);
    if (resident) {
      // The cache is authoritative once it exists: it was built from the same
      // scan the SQL path would run, so falling through to that path could only
      // spend a second full scan to reach the same verdict.
      if (resident.length === 0 || resident.uncoded.length > COARSE_EXACT_CAP) return null;
      const shortlist = resident.shortlist(queryCode, size);
      return shortlist.length > COARSE_EXACT_CAP ? null : shortlist;
    }
  }

  const params = opts.sourceFilter ? [`%${opts.sourceFilter}%`] : [];
  const heap = new ShortlistHeap(size);
  // Rows without a code cannot be ranked cheaply, so they are rescored
  // exactly rather than dropped. A missing code is a backfill that has not
  // caught up; it must never be the reason a chunk vanishes from results.
  const uncoded: number[] = [];
  try {
    const stmt = db.prepare(scopedScanSql("chunk_rowid, dim, code", opts.sourceFilter));
    const rows: Iterable<unknown> = typeof stmt.iterate === "function"
      ? stmt.iterate(...params)
      : (stmt.all(...params) as unknown[]);
    for (const raw of rows) {
      const row = raw as CoarseRow;
      // A row from a different model is not comparable — the exact pass scores
      // it 0 and drops it. Skipping it here keeps it from eating a shortlist
      // slot; two models can share a code width once the bit floor rounds both
      // up, so length alone no longer tells them apart.
      if (row.dim != null && row.dim > 0 && row.dim !== queryVec.length) continue;
      if (!row.code || row.code.length === 0) {
        uncoded.push(row.chunk_rowid);
        if (uncoded.length > COARSE_EXACT_CAP) return null;
        continue;
      }
      const distance = coarseDistance(row.code, queryCode);
      // -1 is a width mismatch: a vector from a different model, which the
      // exact pass scores 0 and drops anyway.
      if (distance >= 0) heap.push(row.chunk_rowid, distance);
    }
  } catch {
    return null;
  }

  if (heap.length === 0) return null;
  const fromSql = [...heap.drain(), ...uncoded];
  return fromSql.length > COARSE_EXACT_CAP ? null : fromSql;
}

/**
 * Semantic neighbours of `queryVec`.
 *
 * Two-phase: a coarse Hamming pass over 1-bit codes picks a few hundred
 * candidates, then the exact cosine — the same function, over the same stored
 * vectors, producing the same scores as before — ranks only those. The exact
 * full scan remains the fallback and the escape hatch, so the worst case is
 * the behaviour this replaced rather than a wrong answer.
 */
export function semanticCandidates(
  db: HybridDb,
  queryVec: number[],
  opts: { limit: number; sourceFilter?: string },
): ChunkRow[] {
  if (!ensureVectorTable(db)) return [];

  const shortlist = bruteForceScanForced() ? null : coarseShortlist(db, queryVec, opts);

  let top: Array<{ rowid: number; score: number }>;
  try {
    if (shortlist) {
      const placeholders = shortlist.map(() => "?").join(",");
      top = exactScan(
        db.prepare(
          `SELECT chunk_rowid, dim, vec FROM chunk_vectors WHERE chunk_rowid IN (${placeholders})`,
        ),
        shortlist,
        queryVec,
        opts.limit,
      );
    } else {
      top = exactScan(
        db.prepare(scopedScanSql("chunk_rowid, dim, vec", opts.sourceFilter)),
        opts.sourceFilter ? [`%${opts.sourceFilter}%`] : [],
        queryVec,
        opts.limit,
      );
    }
  } catch {
    return [];
  }
  if (top.length === 0) return [];

  const placeholders = top.map(() => "?").join(",");
  try {
    const rows = db.prepare(`
      SELECT chunks.rowid AS rowid, chunks.title AS title, chunks.content AS content,
             chunks.content_type AS content_type, chunks.timestamp AS timestamp,
             chunks.session_id AS session_id, sources.label AS source
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks.rowid IN (${placeholders})
    `).all(...top.map(t => t.rowid)) as ChunkRow[];
    // Restore similarity order — SQLite returns rows in storage order.
    const rank = new Map(top.map((t, i) => [t.rowid, i]));
    return rows.sort((a, b) => (rank.get(a.rowid) ?? 0) - (rank.get(b.rowid) ?? 0));
  } catch {
    return [];
  }
}

/**
 * One ranked list entering a fusion.
 *
 * `weight` is the only knob a caller needs to say "this signal is a hint, not
 * an answer". It multiplies the list's RRF contribution, so a list at 0.5
 * cannot outvote two lists at 1.0 no matter how confident its own ranking is —
 * which is exactly the property a structural signal needs before it is allowed
 * anywhere near a lexical ranking.
 */
export interface RankedList<T> {
  rows: T[];
  /** Multiplier on this list's contribution. Defaults to 1. `<= 0` skips it. */
  weight?: number;
  /** Per-list damping override. Defaults to the fusion's `k`. */
  k?: number;
}

/**
 * Fuse any number of ranked lists with weighted RRF.
 *
 * This is the one fusion in the codebase; {@link fuseRankings} is the two-list
 * spelling of it and `ctx_find` is the five-list one. Adding a signal means
 * appending a list here, never writing a second ranker.
 *
 * @param opts.k RRF damping constant. 60 is the value the original RRF paper
 *   settled on and what the lexical fusion in this codebase already assumes.
 * @param opts.identity How two rows are recognised as the same thing. Defaults
 *   to {@link chunkIdentity}. `ctx_find` overrides it so that the same FILE
 *   found by a filename match, a grep match and a graph edge fuses into one
 *   row, while indexed chunks stay individually addressable.
 */
export function fuseRankedLists<T extends LexicalResult>(
  lists: Array<RankedList<T>>,
  opts: { limit: number; k?: number; identity?: (row: T) => string },
): T[] {
  const k = opts.k ?? 60;
  const identity = opts.identity ?? ((row: T) => chunkIdentity(row));
  const scores = new Map<string, { score: number; row: T }>();

  for (const list of lists) {
    const weight = list.weight ?? 1;
    if (!(weight > 0)) continue;
    const listK = list.k ?? k;
    list.rows.forEach((row, i) => {
      const key = identity(row);
      const contribution = weight / (listK + i + 1);
      const prev = scores.get(key);
      if (prev) prev.score += contribution;
      else scores.set(key, { score: contribution, row });
    });
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit)
    .map(e => e.row);
}

/**
 * Fuse lexical and semantic rankings with RRF.
 *
 * Kept as the two-argument spelling every existing caller uses; the mechanism
 * itself lives in {@link fuseRankedLists}. Both lists are unweighted, so the
 * numbers are bit-for-bit what they were before the generalisation.
 *
 * @param k RRF damping constant. 60 is the value the original RRF paper
 *   settled on and what the lexical fusion in this codebase already assumes.
 */
export function fuseRankings<T extends LexicalResult>(
  lexical: T[],
  semantic: T[],
  opts: { limit: number; k?: number },
): T[] {
  return fuseRankedLists([{ rows: lexical }, { rows: semantic }], opts);
}

// ─────────────────────────────────────────────────────────
// Telemetry — is the semantic layer earning its round trip?
// ─────────────────────────────────────────────────────────

const telemetry = {
  /** Searches that reached the semantic path (config resolved, query embedded). */
  searches: 0,
  /** Searches where at least one semantic candidate came back. */
  withCandidates: 0,
  /** Searches where fusion changed the returned list vs lexical alone. */
  changedRanking: 0,
};

export type HybridTelemetry = typeof telemetry;

export function getHybridTelemetry(): HybridTelemetry {
  return { ...telemetry };
}

export function resetHybridTelemetry(): void {
  telemetry.searches = 0;
  telemetry.withCandidates = 0;
  telemetry.changedRanking = 0;
}

function rankingChanged<T extends LexicalResult>(before: T[], after: T[]): boolean {
  if (before.length !== after.length) return true;
  for (let i = 0; i < before.length; i++) {
    if (chunkIdentity(before[i]) !== chunkIdentity(after[i])) return true;
  }
  return false;
}

/**
 * Full hybrid pass for one query.
 *
 * @returns The re-fused result list, or `lexical` unchanged when embeddings
 *   are disabled or unavailable. Never throws.
 */
export async function hybridSearch<T extends LexicalResult>(
  opts: {
    db: HybridDb;
    query: string;
    lexical: T[];
    limit: number;
    sourceFilter?: string;
    /** Chunks to embed in the background per call. 0 disables backfill. */
    backfillBatch?: number;
    config?: EmbeddingConfig | null;
  },
): Promise<T[]> {
  // `undefined` means "decide for me" (explicit env, else a local runtime);
  // an explicit `null` means the caller already decided embeddings are off.
  const config = opts.config === undefined ? await resolveEmbeddingConfigAsync() : opts.config;
  if (!config) return opts.lexical;

  try {
    const queryVectors = await embedTexts([opts.query], config);
    if (!queryVectors) return opts.lexical;
    telemetry.searches++;

    const candidates = semanticCandidates(opts.db, queryVectors[0], {
      limit: Math.max(opts.limit * 3, 15),
      sourceFilter: opts.sourceFilter,
    });
    if (candidates.length > 0) telemetry.withCandidates++;

    const fused = candidates.length > 0
      ? fuseRankings(opts.lexical, candidates as unknown as T[], { limit: opts.limit })
      : opts.lexical;
    if (fused !== opts.lexical && rankingChanged(opts.lexical.slice(0, opts.limit), fused)) {
      telemetry.changedRanking++;
    }

    // Backfill AFTER answering — the user waits for the search, not for the
    // index to catch up. Errors are swallowed by backfillVectors itself.
    const batch = opts.backfillBatch ?? config.backfillBatch;
    if (batch > 0) void backfillVectors(opts.db, config, batch);

    return fused;
  } catch {
    return opts.lexical;
  }
}
