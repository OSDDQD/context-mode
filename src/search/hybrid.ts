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
 */

import {
  cosineSimilarity, decodeStoredVector, embedTexts, encodeVector, encodeVectorInt8,
  resolveEmbeddingConfigAsync, type EmbeddingConfig,
} from "./embeddings.js";

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
  const vectors = await embedTexts(texts, config, { background: true });
  if (!vectors) return 0;

  const quantize = config.quantize !== false;
  try {
    const stmt = db.prepare(
      "INSERT OR REPLACE INTO chunk_vectors (chunk_rowid, model, dim, vec) VALUES (?, ?, ?, ?)",
    );
    for (let i = 0; i < rows.length; i++) {
      const blob = quantize ? encodeVectorInt8(vectors[i]) : encodeVector(vectors[i]);
      stmt.run(rows[i].rowid, config.model, vectors[i].length, blob);
    }
  } catch {
    return 0;
  }
  return rows.length;
}

/**
 * Semantic neighbours of `queryVec`, scanned in memory.
 *
 * A brute-force scan is the right call at this scale, but two things keep it
 * from degenerating as the store grows: a source filter is pushed down into
 * SQL so a scoped search never walks the whole table, and the scan streams
 * rows through `iterate()` instead of materialising every BLOB at once.
 */
export function semanticCandidates(
  db: HybridDb,
  queryVec: number[],
  opts: { limit: number; sourceFilter?: string },
): ChunkRow[] {
  if (!ensureVectorTable(db)) return [];

  // Push the source filter into the scan itself. Filtering afterwards meant a
  // search scoped to one label still paid for cosine over every vector in the
  // store, and could return nothing at all when the top-K global neighbours
  // all belonged to other sources.
  const scanSql = opts.sourceFilter
    ? `SELECT cv.chunk_rowid AS chunk_rowid, cv.dim AS dim, cv.vec AS vec
       FROM chunk_vectors cv
       JOIN chunks ON chunks.rowid = cv.chunk_rowid
       JOIN sources ON sources.id = chunks.source_id
       WHERE sources.label LIKE ? ESCAPE '\\'`
    : "SELECT chunk_rowid, dim, vec FROM chunk_vectors";
  const scanParams = opts.sourceFilter ? [`%${opts.sourceFilter}%`] : [];

  const scored: Array<{ rowid: number; score: number }> = [];
  try {
    const stmt = db.prepare(scanSql);
    const rows: Iterable<unknown> = typeof stmt.iterate === "function"
      ? stmt.iterate(...scanParams)
      : (stmt.all(...scanParams) as unknown[]);
    for (const raw of rows) {
      const row = raw as VectorRow;
      const score = cosineSimilarity(queryVec, decodeStoredVector(row.vec, row.dim ?? undefined));
      if (score > 0) scored.push({ rowid: row.chunk_rowid, score });
    }
  } catch {
    return [];
  }
  if (scored.length === 0) return [];

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, opts.limit);

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
 * Fuse lexical and semantic rankings with RRF.
 *
 * @param k RRF damping constant. 60 is the value the original RRF paper
 *   settled on and what the lexical fusion in this codebase already assumes.
 */
export function fuseRankings<T extends LexicalResult>(
  lexical: T[],
  semantic: T[],
  opts: { limit: number; k?: number },
): T[] {
  const k = opts.k ?? 60;
  const scores = new Map<string, { score: number; row: T }>();

  const add = (rows: T[]) => {
    rows.forEach((row, i) => {
      const key = chunkIdentity(row);
      const contribution = 1 / (k + i + 1);
      const prev = scores.get(key);
      if (prev) prev.score += contribution;
      else scores.set(key, { score: contribution, row });
    });
  };

  add(lexical);
  add(semantic);

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit)
    .map(e => e.row);
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
