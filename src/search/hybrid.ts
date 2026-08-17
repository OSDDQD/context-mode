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
  cosineSimilarity, decodeVector, embedTexts, encodeVector,
  resolveEmbeddingConfig, type EmbeddingConfig,
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
  };
  exec(sql: string): unknown;
}

/** Identity used to fuse a chunk that surfaced through both strategies. */
function fusionKey(r: { source: string; title: string; content: string }): string {
  return `${r.source} ${r.title} ${(r.content ?? "").slice(0, 120)}`;
}

export function ensureVectorTable(db: HybridDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunk_vectors (
      chunk_rowid INTEGER PRIMARY KEY,
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vec BLOB NOT NULL
    )
  `);
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
  ensureVectorTable(db);
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
 * Embed up to `limit` chunks that have no vector yet.
 *
 * @returns Number of chunks embedded.
 */
export async function backfillVectors(
  db: HybridDb,
  config: EmbeddingConfig,
  limit = config.backfillBatch,
): Promise<number> {
  ensureVectorTable(db);
  pruneOrphanVectors(db);
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

  try {
    const stmt = db.prepare(
      "INSERT OR REPLACE INTO chunk_vectors (chunk_rowid, model, dim, vec) VALUES (?, ?, ?, ?)",
    );
    for (let i = 0; i < rows.length; i++) {
      stmt.run(rows[i].rowid, config.model, vectors[i].length, encodeVector(vectors[i]));
    }
  } catch {
    return 0;
  }
  return rows.length;
}

/**
 * Semantic neighbours of `queryVec`, scanned in memory.
 *
 * A brute-force scan is the right call here: these DBs hold thousands of
 * chunks, not millions, and a scan over 10k × 768 floats costs single-digit
 * milliseconds — far less than the ANN index it would take to avoid it.
 */
export function semanticCandidates(
  db: HybridDb,
  queryVec: number[],
  opts: { limit: number; sourceFilter?: string },
): ChunkRow[] {
  ensureVectorTable(db);
  let vectors: VectorRow[];
  try {
    vectors = db.prepare("SELECT chunk_rowid, vec FROM chunk_vectors").all() as VectorRow[];
  } catch {
    return [];
  }
  if (vectors.length === 0) return [];

  const scored: Array<{ rowid: number; score: number }> = [];
  for (const row of vectors) {
    const score = cosineSimilarity(queryVec, decodeVector(row.vec));
    if (score > 0) scored.push({ rowid: row.chunk_rowid, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, opts.limit);
  if (top.length === 0) return [];

  const placeholders = top.map(() => "?").join(",");
  const filterSql = opts.sourceFilter ? " AND sources.label LIKE ? ESCAPE '\\'" : "";
  try {
    const rows = db.prepare(`
      SELECT chunks.rowid AS rowid, chunks.title AS title, chunks.content AS content,
             chunks.content_type AS content_type, chunks.timestamp AS timestamp,
             chunks.session_id AS session_id, sources.label AS source
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks.rowid IN (${placeholders})${filterSql}
    `).all(...top.map(t => t.rowid), ...(opts.sourceFilter ? [`%${opts.sourceFilter}%`] : [])) as ChunkRow[];
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
      const key = fusionKey(row);
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
  const config = opts.config ?? resolveEmbeddingConfig();
  if (!config) return opts.lexical;

  try {
    const queryVectors = await embedTexts([opts.query], config);
    if (!queryVectors) return opts.lexical;

    const candidates = semanticCandidates(opts.db, queryVectors[0], {
      limit: Math.max(opts.limit * 3, 15),
      sourceFilter: opts.sourceFilter,
    });

    const fused = candidates.length > 0
      ? fuseRankings(opts.lexical, candidates as unknown as T[], { limit: opts.limit })
      : opts.lexical;

    // Backfill AFTER answering — the user waits for the search, not for the
    // index to catch up. Errors are swallowed by backfillVectors itself.
    const batch = opts.backfillBatch ?? config.backfillBatch;
    if (batch > 0) void backfillVectors(opts.db, config, batch);

    return fused;
  } catch {
    return opts.lexical;
  }
}
