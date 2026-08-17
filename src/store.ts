/**
 * ContentStore — FTS5 BM25-based knowledge base for context-mode.
 *
 * Chunks markdown content by headings (keeping code blocks intact),
 * stores in SQLite FTS5, and retrieves via BM25-ranked search.
 *
 * Use for documentation, API references, and any content where
 * you need EXACT text later — not summaries.
 */

import type { Database as DatabaseInstance } from "better-sqlite3";
import { loadDatabase, applyWALPragmas, closeDB, cleanOrphanedWALFiles, withRetry, deleteDBFiles, isSQLiteCorruptionError } from "./db-base.js";
import type { PreparedStatement } from "./db-base.js";
import { readFileSync, readdirSync, unlinkSync, existsSync, statSync, openSync, fstatSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkDirectoryDetailed, type WalkOptions } from "./store-directory.js";
import type { SearchCompleteness } from "./search/completeness.js";
export type { SearchCompleteness } from "./search/completeness.js";

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

interface Chunk {
  title: string;
  content: string;
  hasCode: boolean;
}

type SourceMatchMode = "like" | "exact";

type SearchRow = {
  title: string;
  content: string;
  content_type: string;
  timestamp: string | null;
  label: string;
  rank: number;
  highlighted: string;
  /** Attribution session_id (empty string for legacy unattributed chunks). */
  session_id: string;
};

import type { IndexResult, SearchResult, StoreStats } from "./types.js";
export type { IndexResult, SearchResult, StoreStats } from "./types.js";

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "has", "his", "how", "its", "may",
  "new", "now", "old", "see", "way", "who", "did", "get", "got", "let",
  "say", "she", "too", "use", "will", "with", "this", "that", "from",
  "they", "been", "have", "many", "some", "them", "than", "each", "make",
  "like", "just", "over", "such", "take", "into", "year", "your", "good",
  "could", "would", "about", "which", "their", "there", "other", "after",
  "should", "through", "also", "more", "most", "only", "very", "when",
  "what", "then", "these", "those", "being", "does", "done", "both",
  "same", "still", "while", "where", "here", "were", "much",
  // Common in code/changelogs
  "update", "updates", "updated", "deps", "dev", "tests", "test",
  "add", "added", "fix", "fixed", "run", "running", "using",
]);

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

/**
 * Remove case-insensitive duplicate tokens while preserving the first
 * occurrence's original casing. FTS5's unicode61 tokenizer lowercases on
 * both sides, so `"Error" OR "error"` produces no extra recall — just
 * redundant index lookups. Dedup keeps the compiled query minimal.
 */
function dedupeTokens(tokens: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    const key = t.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

export function sanitizeQuery(query: string, mode: "AND" | "OR" = "AND"): string {
  const words = dedupeTokens(
    query
      .replace(/['"(){}[\]*:^~]/g, " ")
      .split(/\s+/)
      .filter(
        (w) =>
          w.length > 0 &&
          !["AND", "OR", "NOT", "NEAR"].includes(w.toUpperCase()),
      ),
  );

  if (words.length === 0) return '""';

  // Filter stopwords to improve BM25 ranking — common terms like "update",
  // "test", "fix" appear everywhere and dilute relevance scoring.
  // Fall back to unfiltered words if ALL terms are stopwords.
  const meaningful = words.filter((w) => !STOPWORDS.has(w.toLowerCase()));
  const final = meaningful.length > 0 ? meaningful : words;

  return final.map((w) => `"${w}"`).join(mode === "OR" ? " OR " : " ");
}

export function sanitizeTrigramQuery(query: string, mode: "AND" | "OR" = "AND"): string {
  const cleaned = query.replace(/["'(){}[\]*:^~]/g, "").trim();
  if (cleaned.length < 3) return "";
  const words = dedupeTokens(
    cleaned.split(/\s+/).filter((w) => w.length >= 3),
  );
  if (words.length === 0) return "";

  const meaningful = words.filter((w) => !STOPWORDS.has(w.toLowerCase()));
  const final = meaningful.length > 0 ? meaningful : words;

  return final.map((w) => `"${w}"`).join(mode === "OR" ? " OR " : " ");
}

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev = curr;
  }
  return prev[b.length];
}

function maxEditDistance(wordLength: number): number {
  if (wordLength <= 4) return 1;
  if (wordLength <= 12) return 2;
  return 3;
}

// Oversized chunks (e.g., a 50KB section between two headings) hurt BM25
// length normalization and produce unwieldy search results. Split at paragraph
// boundaries when a chunk exceeds this cap.
const MAX_CHUNK_BYTES = 4096;

// Blank-line sectioning is used only for output that is *naturally* sectioned:
// at least a few sections, not an unbounded explosion, and no single section so
// large that the split is clearly not the real structure (those fall back to
// line-grouping). Sections that pass the heuristic but still exceed
// MAX_CHUNK_BYTES are sub-split so no persisted chunk breaks the cap.
const MIN_BLANK_LINE_SECTIONS = 3;
const MAX_BLANK_LINE_SECTIONS = 200;
const BLANK_SECTION_STRATEGY_MAX_BYTES = 5000;

// Number of leading characters of a chunk's first line used as its title.
const CHUNK_TITLE_MAX_CHARS = 80;

// When byte-splitting an oversized single line, prefer to break at a whitespace
// boundary for readability — but only if that boundary is past this fraction of
// the slice, otherwise we'd waste too much of the byte budget.
const WHITESPACE_BREAK_RATIO = 0.5;

// ─────────────────────────────────────────────────────────
// ContentStore
// ─────────────────────────────────────────────────────────

/**
 * Remove stale DB files from previous sessions whose processes no longer exist.
 */
export function cleanupStaleDBs(): number {
  const dir = tmpdir();
  let cleaned = 0;
  try {
    const files = readdirSync(dir);
    for (const file of files) {
      const match = file.match(/^context-mode-(\d+)\.db$/);
      if (!match) continue;
      const pid = parseInt(match[1], 10);
      if (pid === process.pid) continue;
      try {
        process.kill(pid, 0);
      } catch {
        const base = join(dir, file);
        for (const suffix of ["", "-wal", "-shm"]) {
          try { unlinkSync(base + suffix); } catch { /* ignore */ }
        }
        cleaned++;
      }
    }
  } catch { /* ignore readdir errors */ }
  return cleaned;
}

/**
 * Check if a PID is still alive (not a zombie holding a WAL lock).
 * Returns true if the process exists, false if it's dead.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Default retention window for per-project content store DBs. */
export const CONTENT_RETENTION_DAYS_DEFAULT = 14;

/**
 * A WAL that has not been touched for this long is assumed to have no live
 * writer behind it. Used only as a *guard* against deleting a store whose
 * `.db` mtime looks old because every recent write landed in the WAL.
 */
const CONTENT_WAL_STALE_MS = 3600_000;

/** Retention window in days, overridable via CONTEXT_MODE_CONTENT_RETENTION_DAYS. */
export function contentRetentionDays(): number {
  const raw = Number.parseInt(process.env.CONTEXT_MODE_CONTENT_RETENTION_DAYS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : CONTENT_RETENTION_DAYS_DEFAULT;
}

/**
 * True when nothing suggests a live writer is still attached to this DB:
 * no WAL, an empty WAL, or a WAL untouched for CONTENT_WAL_STALE_MS.
 */
function contentWalIsStale(dbPath: string): boolean {
  const walPath = dbPath + "-wal";
  try {
    if (!existsSync(walPath)) return true;
    const walStat = statSync(walPath);
    if (walStat.size === 0) return true;
    return (Date.now() - walStat.mtimeMs) > CONTENT_WAL_STALE_MS;
  } catch {
    // Can't tell — assume a writer may still be there and keep the DB.
    return false;
  }
}

/**
 * Clean up stale per-project content store DBs older than maxAgeDays.
 * Scans the given directory for *.db files and checks mtime.
 *
 * Age is the ONLY reason a store is deleted. A non-empty, hour-old WAL used to
 * set the same flag as the age rule, which deleted knowledge bases minutes old
 * whenever a session ended without a checkpoint — the 14-day promise was
 * bypassed. The WAL now acts only *inside* the age rule, and only in the
 * protective direction: a DB past the cutoff whose WAL was written recently
 * still has a live owner (in WAL mode the `.db` mtime only moves on
 * checkpoint), so it is left alone.
 *
 * `maxAgeDays <= 0` means a forced purge (legacy directory migration) and skips
 * the WAL guard. Set CONTEXT_MODE_CONTENT_WAL_REAP=0 to drop the guard entirely
 * and go by `.db` mtime alone.
 */
export function cleanupStaleContentDBs(contentDir: string, maxAgeDays: number): number {
  let cleaned = 0;
  const walGuardEnabled = process.env.CONTEXT_MODE_CONTENT_WAL_REAP !== "0";
  try {
    if (!existsSync(contentDir)) return 0;
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const forcedPurge = maxAgeDays <= 0;
    const files = readdirSync(contentDir).filter(f => f.endsWith(".db"));
    for (const file of files) {
      try {
        const filePath = join(contentDir, file);
        const mtime = statSync(filePath).mtimeMs;
        if (mtime >= cutoff) continue;
        if (!forcedPurge && walGuardEnabled && !contentWalIsStale(filePath)) continue;

        for (const suffix of ["", "-wal", "-shm"]) {
          try { unlinkSync(filePath + suffix); } catch { /* ignore */ }
        }
        cleaned++;
      } catch { /* ignore per-file errors */ }
    }
  } catch { /* ignore readdir errors */ }
  return cleaned;
}

// ─────────────────────────────────────────────────────────
// Content store disk accounting
// ─────────────────────────────────────────────────────────

/** One project's content store on disk, sidecars included. */
export interface ContentStoreEntry {
  dbPath: string;
  /** `.db` + `-wal` + `-shm`. The WAL is not a rounding error: measured at 14%
   *  of the footprint across 328 stores (30.1 MB of 210.5 MB). */
  bytes: number;
  walBytes: number;
  /** Newest mtime across the three files — when this store was last touched. */
  lastUseMs: number;
}

export interface ContentStoreUsage {
  dir: string;
  stores: ContentStoreEntry[];
  totalBytes: number;
  walBytes: number;
}

/**
 * Measure what the knowledge base costs on disk.
 *
 * A plain `statSync` walk, no SQLite: this runs before any decision to open or
 * delete a store, and opening 328 databases to ask their size would cost more
 * than the answer is worth.
 */
export function contentStoreUsage(contentDir: string): ContentStoreUsage {
  const usage: ContentStoreUsage = { dir: contentDir, stores: [], totalBytes: 0, walBytes: 0 };
  let files: string[];
  try {
    if (!existsSync(contentDir)) return usage;
    files = readdirSync(contentDir).filter(f => f.endsWith(".db"));
  } catch {
    return usage;
  }

  for (const file of files) {
    const dbPath = join(contentDir, file);
    let bytes = 0;
    let walBytes = 0;
    let lastUseMs = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        const st = statSync(dbPath + suffix);
        bytes += st.size;
        if (suffix === "-wal") walBytes = st.size;
        if (st.mtimeMs > lastUseMs) lastUseMs = st.mtimeMs;
      } catch { /* sidecar absent — normal */ }
    }
    if (bytes === 0 && lastUseMs === 0) continue;
    usage.stores.push({ dbPath, bytes, walBytes, lastUseMs });
    usage.totalBytes += bytes;
    usage.walBytes += walBytes;
  }
  return usage;
}

export interface ContentBudgetResult {
  totalBytes: number;
  budgetBytes: number;
  /** Stores that were (or, in a dry run, would be) evicted. */
  evicted: string[];
  freedBytes: number;
  dryRun: boolean;
}

/**
 * Evict least-recently-used content stores until the directory fits its budget.
 *
 * Deliberately *not* wired into `getStore()`: deleting other projects' data on
 * the hot path of a tool call is the kind of thing that should happen where it
 * can be seen and where nothing is waiting on it. `context-mode drain` is that
 * place.
 *
 * Three things are never evicted, in order of how much damage the mistake would
 * do: the caller's own open store, a store with a live non-empty WAL (another
 * process is writing to it right now), and anything used inside `minAgeMs`.
 */
export function enforceContentBudget(opts: {
  contentDir: string;
  /** Absolute paths that must survive regardless — normally the caller's DB. */
  protectPaths?: string[];
  budgetBytes: number;
  /** Stores touched more recently than this are never candidates. */
  minAgeMs?: number;
  dryRun?: boolean;
}): ContentBudgetResult {
  const minAgeMs = opts.minAgeMs ?? 48 * 60 * 60 * 1000;
  const dryRun = opts.dryRun ?? false;
  const protectedSet = new Set(opts.protectPaths ?? []);
  const usage = contentStoreUsage(opts.contentDir);
  const result: ContentBudgetResult = {
    totalBytes: usage.totalBytes,
    budgetBytes: opts.budgetBytes,
    evicted: [],
    freedBytes: 0,
    dryRun,
  };
  if (usage.totalBytes <= opts.budgetBytes) return result;

  // Evict down to 90% of budget, not to exactly budget: stopping at the line
  // means the next store opened puts us straight back over it.
  const target = Math.floor(opts.budgetBytes * 0.9);
  const now = Date.now();
  const candidates = usage.stores
    .filter(s => !protectedSet.has(s.dbPath))
    .filter(s => s.walBytes === 0)
    .filter(s => now - s.lastUseMs >= minAgeMs)
    .sort((a, b) => a.lastUseMs - b.lastUseMs);

  let remaining = usage.totalBytes;
  for (const store of candidates) {
    if (remaining <= target) break;
    if (!dryRun) {
      let failed = false;
      for (const suffix of ["", "-wal", "-shm"]) {
        try { unlinkSync(store.dbPath + suffix); } catch (err) {
          // ENOENT on a sidecar is expected; anything else means we did not
          // actually free this store.
          if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") failed = true;
        }
      }
      if (failed) continue;
    }
    result.evicted.push(store.dbPath);
    result.freedBytes += store.bytes;
    remaining -= store.bytes;
  }
  return result;
}

// ── Proximity helpers (pure functions) ──

/** Find all positions of a term in text. */
function findAllPositions(text: string, term: string): number[] {
  const positions: number[] = [];
  let idx = text.indexOf(term);
  while (idx !== -1) {
    positions.push(idx);
    idx = text.indexOf(term, idx + 1);
  }
  return positions;
}

/**
 * Count matched adjacent pairs across consecutive query terms.
 * For each pair (term[i], term[i+1]), pairs each left position with at most one
 * right position whose offset falls within `gap` chars of `p + len(term[i])`.
 * `positionLists` must be sorted ascending (output of `findAllPositions` is).
 * Each right position is consumed by at most one left, so `"foo foo bar"`
 * counts 1 pair, not 2 — matches IR phrase-occurrence intent and avoids
 * inflating boosts for repeated-token queries.
 * Used by reranker to layer a frequency signal on top of minSpan proximity:
 * 30-char gap covers natural prose without rewarding distant matches.
 */
function countAdjacentPairs(
  positionLists: number[][],
  terms: string[],
  gap: number = 30,
): number {
  if (positionLists.length < 2 || terms.length < 2) return 0;
  let total = 0;
  const pairs = Math.min(positionLists.length, terms.length) - 1;
  for (let i = 0; i < pairs; i++) {
    const left = positionLists[i];
    const right = positionLists[i + 1];
    const leftLen = terms[i].length;
    let j = 0;
    for (const p of left) {
      const minStart = p + leftLen;
      const maxStart = minStart + gap;
      while (j < right.length && right[j] < minStart) j++;
      if (j < right.length && right[j] <= maxStart) {
        total++;
        j++;
      }
    }
  }
  return total;
}

/**
 * Find minimum span (window) covering at least one position from each list.
 * Uses a sweep-line approach: advance the pointer at the current minimum.
 */
function findMinSpan(positionLists: number[][]): number {
  if (positionLists.length === 0) return Infinity;
  if (positionLists.length === 1) return 0;

  const sorted = positionLists;
  const ptrs = new Array(sorted.length).fill(0);
  let minSpan = Infinity;

  while (true) {
    let curMin = Infinity;
    let curMax = -Infinity;
    let minIdx = 0;

    for (let i = 0; i < sorted.length; i++) {
      const val = sorted[i][ptrs[i]];
      if (val < curMin) {
        curMin = val;
        minIdx = i;
      }
      if (val > curMax) {
        curMax = val;
      }
    }

    const span = curMax - curMin;
    if (span < minSpan) minSpan = span;

    ptrs[minIdx]++;
    if (ptrs[minIdx] >= sorted[minIdx].length) break;
  }

  return minSpan;
}

export class ContentStore {
  #db: DatabaseInstance;
  #dbPath: string;
  // Optional deny-policy callback. When set (by server.ts at startup),
  // #refreshStaleSources consults it before re-reading file_path during
  // auto-refresh. This catches policy edits between initial indexing and
  // a later search: a file that was allowed at index time may have been
  // added to the Read deny list afterwards. Without this hook, refresh
  // would re-read and re-expose the file. See #442 round-3.
  #denyChecker?: (filePath: string) => boolean;

  // ── Cached Prepared Statements ──
  // Prepared once at construction, reused on every call to avoid
  // re-compiling SQL on each invocation.

  // Write path
  #stmtInsertSourceEmpty!: PreparedStatement;
  #stmtInsertSource!: PreparedStatement;
  #stmtInsertChunk!: PreparedStatement;
  #stmtInsertChunkTrigram!: PreparedStatement;
  #stmtInsertVocab!: PreparedStatement;

  // Dedup path (delete previous source with same label before re-indexing)
  #stmtDeleteChunksByLabel!: PreparedStatement;
  #stmtDeleteChunksTrigramByLabel!: PreparedStatement;
  #stmtDeleteSourcesByLabel!: PreparedStatement;
  /** Lazy: only the content-hash skip path uses it. */
  #stmtTouchSource?: PreparedStatement;

  // Search path (hot)
  #stmtSearchPorter!: PreparedStatement;
  #stmtSearchPorterFiltered!: PreparedStatement;
  #stmtSearchPorterExact!: PreparedStatement;
  #stmtSearchTrigram!: PreparedStatement;
  #stmtSearchTrigramFiltered!: PreparedStatement;
  #stmtSearchTrigramExact!: PreparedStatement;
  #stmtFuzzyVocab!: PreparedStatement;
  #stmtSearchPorterContentType!: PreparedStatement;
  #stmtSearchPorterFilteredContentType!: PreparedStatement;
  #stmtSearchPorterExactContentType!: PreparedStatement;
  #stmtSearchTrigramContentType!: PreparedStatement;
  #stmtSearchTrigramFilteredContentType!: PreparedStatement;
  #stmtSearchTrigramExactContentType!: PreparedStatement;

  // Read path
  #stmtListSources!: PreparedStatement;
  #stmtChunksBySource!: PreparedStatement;
  #stmtSourceChunkCount!: PreparedStatement;
  #stmtChunkContent!: PreparedStatement;
  #stmtStats!: PreparedStatement;
  #stmtSourceMeta!: PreparedStatement;

  // Cleanup path
  #stmtCleanupChunks!: PreparedStatement;
  #stmtCleanupChunksTrigram!: PreparedStatement;
  #stmtCleanupSources!: PreparedStatement;

  // FTS5 optimization: track inserts and optimize periodically to defragment
  // the index. FTS5 b-trees fragment over many insert/delete cycles, degrading
  // search performance. SQLite's built-in 'optimize' merges b-tree segments.
  #insertCount = 0;
  static readonly OPTIMIZE_EVERY = 50;

  /**
   * Widest fusion an exact-total request will run
   * (CONTEXT_MODE_SEARCH_EXACT_TOTALS=1). Past this the reported total stays a
   * lower bound — "500+" answers the reader's question as well as "1,214" does,
   * and costs a great deal less.
   */
  static readonly EXACT_TOTAL_CAP = 500;

  // Fuzzy correction cache (process-local LRU). fuzzyCorrect() hits the vocab
  // DB and runs levenshtein against every candidate within length tolerance,
  // which is CPU-linear in |candidates|. Repeated queries ("erro", "erro" …)
  // recompute the same answer. The vocabulary table is insert-only, so cache
  // entries only become stale when new words enter — we clear on actual insert.
  #fuzzyCache = new Map<string, string | null>();
  static readonly FUZZY_CACHE_SIZE = 256;

  constructor(dbPath?: string) {
    const Database = loadDatabase();
    this.#dbPath =
      dbPath ?? join(tmpdir(), `context-mode-${process.pid}.db`);
    cleanOrphanedWALFiles(this.#dbPath);
    let db: DatabaseInstance;
    try {
      db = new Database(this.#dbPath, { timeout: 30000 });
      applyWALPragmas(db);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isSQLiteCorruptionError(msg)) {
        deleteDBFiles(this.#dbPath);
        cleanOrphanedWALFiles(this.#dbPath);
        try {
          db = new Database(this.#dbPath, { timeout: 30000 });
          applyWALPragmas(db);
        } catch (retryErr) {
          throw new Error(
            `Failed to create fresh DB after deleting corrupt file: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
          );
        }
      } else {
        throw err;
      }
    }
    this.#db = db;
    this.#initSchema();
    this.#prepareStatements();
  }

  /**
   * Raw handle for the optional semantic layer (src/search/hybrid.ts).
   *
   * The vector table lives in this same DB so it is cleaned up, migrated,
   * and purged with the chunks it describes. Exposing the handle beats
   * threading a dozen vector-specific methods through this class for a
   * feature that is off by default.
   */
  rawDb(): DatabaseInstance {
    return this.#db;
  }

  /** Delete this session's DB files. Call on process exit. */
  cleanup(): void {
    try {
      this.#db.close();
    } catch { /* ignore */ }
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(this.#dbPath + suffix); } catch { /* ignore */ }
    }
  }

  // ── Schema ──

  #initSchema(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        code_chunk_count INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
        file_path TEXT,
        content_hash TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        title,
        content,
        source_id UNINDEXED,
        content_type UNINDEXED,
        source_category UNINDEXED,
        session_id UNINDEXED,
        event_id UNINDEXED,
        timestamp UNINDEXED,
        tokenize='porter unicode61'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram USING fts5(
        title,
        content,
        source_id UNINDEXED,
        content_type UNINDEXED,
        source_category UNINDEXED,
        session_id UNINDEXED,
        event_id UNINDEXED,
        timestamp UNINDEXED,
        tokenize='trigram'
      );

      CREATE TABLE IF NOT EXISTS vocabulary (
        word TEXT PRIMARY KEY
      );

      CREATE INDEX IF NOT EXISTS idx_sources_label ON sources(label);
    `);

    // FTS5 schema migration: old schema (4 cols) → new schema (8 cols).
    // FTS5 virtual tables do not support ALTER TABLE ADD COLUMN, so we must
    // DROP + re-CREATE. Detection: check for sentinel column `source_category`
    // via pragma_table_xinfo. Three states:
    //   1. No table          → CREATE above handled it (fresh DB)
    //   2. Old schema (4 cols) → DROP + CREATE new
    //   3. New schema (8 cols) → do nothing
    try {
      const cols = this.#db.prepare(
        "SELECT name FROM pragma_table_xinfo('chunks')"
      ).all() as Array<{ name: string }>;
      const colNames = new Set(cols.map(c => c.name));
      if (cols.length > 0 && !colNames.has("source_category")) {
        // Old schema detected — drop both FTS5 tables and re-create with new columns
        this.#db.exec("DROP TABLE IF EXISTS chunks");
        this.#db.exec("DROP TABLE IF EXISTS chunks_trigram");
        this.#db.exec(`
          CREATE VIRTUAL TABLE chunks USING fts5(
            title,
            content,
            source_id UNINDEXED,
            content_type UNINDEXED,
            source_category UNINDEXED,
            session_id UNINDEXED,
            event_id UNINDEXED,
            timestamp UNINDEXED,
            tokenize='porter unicode61'
          );
          CREATE VIRTUAL TABLE chunks_trigram USING fts5(
            title,
            content,
            source_id UNINDEXED,
            content_type UNINDEXED,
            source_category UNINDEXED,
            session_id UNINDEXED,
            event_id UNINDEXED,
            timestamp UNINDEXED,
            tokenize='trigram'
          );
        `);
      }
    } catch { /* pragma_table_xinfo may fail if table doesn't exist yet — safe to ignore */ }

    // Stale detection columns — safe for existing DBs (ALTER is O(1) in SQLite)
    try { this.#db.exec("ALTER TABLE sources ADD COLUMN file_path TEXT"); } catch { /* already exists */ }
    try { this.#db.exec("ALTER TABLE sources ADD COLUMN content_hash TEXT"); } catch { /* already exists */ }
  }

  #prepareStatements(): void {
    // Write path
    this.#stmtInsertSourceEmpty = this.#db.prepare(
      "INSERT INTO sources (label, chunk_count, code_chunk_count, file_path, content_hash) VALUES (?, 0, 0, ?, ?)",
    );
    this.#stmtInsertSource = this.#db.prepare(
      "INSERT INTO sources (label, chunk_count, code_chunk_count, file_path, content_hash) VALUES (?, ?, ?, ?, ?)",
    );
    this.#stmtInsertChunk = this.#db.prepare(
      "INSERT INTO chunks (title, content, source_id, content_type, source_category, session_id, event_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.#stmtInsertChunkTrigram = this.#db.prepare(
      "INSERT INTO chunks_trigram (title, content, source_id, content_type, source_category, session_id, event_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.#stmtInsertVocab = this.#db.prepare(
      "INSERT OR IGNORE INTO vocabulary (word) VALUES (?)",
    );

    // Dedup path: delete previous source with same label before re-indexing
    // Prevents stale outputs from accumulating in iterative workflows (build-fix-build)
    this.#stmtDeleteChunksByLabel = this.#db.prepare(
      "DELETE FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE label = ?)",
    );
    this.#stmtDeleteChunksTrigramByLabel = this.#db.prepare(
      "DELETE FROM chunks_trigram WHERE source_id IN (SELECT id FROM sources WHERE label = ?)",
    );
    this.#stmtDeleteSourcesByLabel = this.#db.prepare(
      "DELETE FROM sources WHERE label = ?",
    );

    // Search path (hot)
    this.#stmtSearchPorter = this.#db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted,
        chunks.session_id
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchPorterFiltered = this.#db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted,
        chunks.session_id
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label LIKE ? ESCAPE '\\'
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchPorterExact = this.#db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted,
        chunks.session_id
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label = ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchTrigram = this.#db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted,
        chunks_trigram.session_id
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchTrigramFiltered = this.#db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted,
        chunks_trigram.session_id
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label LIKE ? ESCAPE '\\'
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchTrigramExact = this.#db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted,
        chunks_trigram.session_id
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label = ?
      ORDER BY rank
      LIMIT ?
    `);

    // Content-type filtered variants
    this.#stmtSearchPorterContentType = this.#db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted,
        chunks.session_id
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND chunks.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchPorterFilteredContentType = this.#db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted,
        chunks.session_id
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label LIKE ? ESCAPE '\\' AND chunks.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchPorterExactContentType = this.#db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted,
        chunks.session_id
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label = ? AND chunks.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchTrigramContentType = this.#db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted,
        chunks_trigram.session_id
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND chunks_trigram.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchTrigramFilteredContentType = this.#db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted,
        chunks_trigram.session_id
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label LIKE ? ESCAPE '\\' AND chunks_trigram.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchTrigramExactContentType = this.#db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted,
        chunks_trigram.session_id
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label = ? AND chunks_trigram.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);

    // Fuzzy path
    this.#stmtFuzzyVocab = this.#db.prepare(
      "SELECT word FROM vocabulary WHERE length(word) BETWEEN ? AND ?",
    );

    // Read path
    this.#stmtListSources = this.#db.prepare(
      "SELECT label, chunk_count as chunkCount FROM sources ORDER BY id DESC",
    );
    this.#stmtChunksBySource = this.#db.prepare(
      `SELECT c.title, c.content, c.content_type, s.label
       FROM chunks c
       JOIN sources s ON s.id = c.source_id
       WHERE c.source_id = ?
       ORDER BY c.rowid`,
    );
    this.#stmtSourceChunkCount = this.#db.prepare(
      "SELECT chunk_count FROM sources WHERE id = ?",
    );
    this.#stmtChunkContent = this.#db.prepare(
      "SELECT content FROM chunks WHERE source_id = ?",
    );
    this.#stmtSourceMeta = this.#db.prepare(
      "SELECT label, chunk_count, code_chunk_count, indexed_at, file_path, content_hash FROM sources WHERE label = ?",
    );
    this.#stmtStats = this.#db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM sources) AS sources,
        (SELECT COUNT(*) FROM chunks) AS chunks,
        (SELECT COUNT(*) FROM chunks WHERE content_type = 'code') AS codeChunks
    `);

    // Cleanup path — cached to avoid recompiling SQL on each periodic call
    this.#stmtCleanupChunks = this.#db.prepare(
      "DELETE FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE datetime(indexed_at) < datetime('now', '-' || ? || ' days'))",
    );
    this.#stmtCleanupChunksTrigram = this.#db.prepare(
      "DELETE FROM chunks_trigram WHERE source_id IN (SELECT id FROM sources WHERE datetime(indexed_at) < datetime('now', '-' || ? || ' days'))",
    );
    this.#stmtCleanupSources = this.#db.prepare(
      "DELETE FROM sources WHERE datetime(indexed_at) < datetime('now', '-' || ? || ' days')",
    );
  }

  // ── Deny Policy Hook ──

  /**
   * Register a deny-policy checker. When set, #refreshStaleSources
   * calls it before re-reading any file_path during auto-refresh.
   * Returning `true` causes the source to be skipped (kept in cache,
   * not re-indexed). server.ts wires this to the Read deny patterns.
   */
  setDenyChecker(fn: ((filePath: string) => boolean) | undefined): void {
    this.#denyChecker = fn;
  }

  // ── Index ──

  index(options: {
    content?: string;
    path?: string;
    source?: string;
    /**
     * Optional FK metadata recorded on each indexed chunk so per-session
     * honest-savings stats can join chunks → session_events. When omitted,
     * chunks fall back to empty-string columns (legacy behaviour).
     */
    attribution?: { sessionId?: string; eventId?: string };
  }): IndexResult {
    const { content, path, source, attribution } = options;

    // Treat empty string as "no content" so an empty `content` paired with a
    // valid `path` falls back to reading the file. Some MCP clients
    // materialize optional string fields as `""` and the previous
    // `content ?? readFileSync(path)` kept the empty string, indexing 0
    // chunks. See issue #350.
    const hasContent = typeof content === "string" && content.length > 0;

    if (!hasContent && !path) {
      throw new Error("Either content or path must be provided");
    }

    // Read file via fd to close the TOCTOU window between the security
    // gate (security.ts evaluateFilePath calls realpathSync) and the read
    // here. Lexical re-read by path string allowed an attacker to swap a
    // symlink to a denied target (e.g. ~/.ssh/id_rsa) AFTER gate passed.
    // openSync + fstat + readFileSync(fd) binds the read to the inode
    // captured at gate-time. fstat also rejects non-regular files
    // (directories, character devices) which would otherwise read as ""
    // or throw inconsistently. See #442 round-3.
    let text: string;
    if (hasContent) {
      text = content!;
    } else {
      const fd = openSync(path!, "r");
      try {
        const st = fstatSync(fd);
        if (!st.isFile()) {
          throw new Error(`refusing to index ${path}: not a regular file`);
        }
        text = readFileSync(fd, "utf-8");
      } finally {
        closeSync(fd);
      }
    }
    const label = source ?? path ?? "untitled";

    // Stale detection: file_path + SHA-256. Hashed for EVERY source, not only
    // file-backed ones — a batch command re-run with identical output is just
    // as skippable as an unchanged file, and that is the common case for the
    // command captures that dominate this index.
    const filePath = path ?? undefined;
    const contentHash = createHash("sha256").update(text).digest("hex");

    const unchanged = this.#skipUnchanged(label, filePath, contentHash);
    if (unchanged) return unchanged;

    const chunks = this.#chunkMarkdown(text);
    return withRetry(() => this.#insertChunks(chunks, label, text, filePath, contentHash, attribution));
  }

  /**
   * Return the existing result when this exact content is already indexed.
   *
   * Re-indexing was unconditional even though `content_hash` was already being
   * written — the column was used for staleness detection and never consulted
   * on the write path. Skipping buys two things beyond the FTS5 work avoided:
   *
   * - `indexed_at` moves forward, so `#refreshStaleSources` stops re-reading
   *   the file on every single search (its mtime gate compares against it);
   * - the chunk rowids survive, and `chunk_vectors` is keyed on `chunks.rowid`.
   *   Every re-index of an unchanged file used to orphan its embeddings and
   *   make the backfill compute them again.
   *
   * The trade, accepted explicitly in ADR-0007: a skipped chunk keeps the
   * `session_id` of the session that first indexed it. Re-attributing means an
   * UPDATE on an FTS5 column, which changes the rowid and destroys the very
   * saving this exists for. First writer wins;
   * `CONTEXT_MODE_INDEX_HASH_SKIP_REATTRIBUTE=1` forces the rewrite for anyone
   * who needs per-session attribution more than they need the cache.
   *
   * @returns The unchanged source's result, or null when indexing must proceed.
   */
  #skipUnchanged(label: string, filePath: string | undefined, contentHash: string): IndexResult | null {
    if (process.env.CONTEXT_MODE_INDEX_HASH_SKIP === "0") return null;
    if (process.env.CONTEXT_MODE_INDEX_HASH_SKIP_REATTRIBUTE === "1") return null;
    try {
      const meta = this.getSourceMeta(label);
      if (!meta) return null;
      // Legacy rows carry no hash: index once more to record one, then skip.
      if (!meta.contentHash || meta.contentHash !== contentHash) return null;
      // A label that moved to a different file is a different source.
      if ((meta.filePath ?? null) !== (filePath ?? null)) return null;

      this.#touchSource(label);
      return {
        sourceId: -1,
        label,
        totalChunks: meta.chunkCount,
        codeChunks: meta.codeChunkCount,
        skipped: true,
      };
    } catch {
      // Any doubt — index it. A redundant re-index costs milliseconds; a
      // wrongly skipped one loses the content.
      return null;
    }
  }

  /** Move `indexed_at` forward without touching the chunks. */
  #touchSource(label: string): void {
    try {
      this.#stmtTouchSource ??= this.#db.prepare(
        "UPDATE sources SET indexed_at = CURRENT_TIMESTAMP WHERE label = ?",
      );
      this.#stmtTouchSource.run(label);
    } catch { /* the skip is still valid without the touch */ }
  }

  // ── Index Directory (#687) ──

  /**
   * Index every file under a directory by walking it with `walkDirectory` and
   * delegating each discovered file to `this.index({ path })`. The per-file
   * `openSync + fstatSync.isFile()` security gate at line ~845 stays active
   * for every file — directory support never bypasses the TOCTOU defense
   * from #442 round-3.
   *
   * Reported by @matiasduartee in #687.
   */
  indexDirectory(opts: {
    path: string;
    source?: string;
    attribution?: { sessionId?: string; eventId?: string };
    /** Optional per-file deny check — runs INSIDE the walk loop so a denied
     *  file does not even open a fd. Returns true to deny. */
    perFileDeny?: (absPath: string) => boolean;
  } & WalkOptions): {
    filesIndexed: number;
    totalChunks: number;
    capped: boolean;
    totalSeen: number;
    denied: number;
    failed: number;
    label: string;
  } {
    const { path: rootPath, source, attribution, perFileDeny, ...walkOpts } = opts;
    const walked = walkDirectoryDetailed(rootPath, walkOpts);

    let filesIndexed = 0;
    let totalChunks = 0;
    let denied = 0;
    let failed = 0;

    for (const file of walked.files) {
      if (perFileDeny && perFileDeny(file)) {
        denied++;
        continue;
      }
      try {
        // Per-file source label so ctx_search(source: "<file>") still works.
        const fileSource = source ? `${source}:${file}` : file;
        const r = this.index({ path: file, source: fileSource, attribution });
        filesIndexed++;
        totalChunks += r.totalChunks;
      } catch {
        // Per-file failure (e.g. fd-bound fstat rejection of a non-regular
        // file that races between walk and read) — count + continue.
        failed++;
      }
    }

    return {
      filesIndexed,
      totalChunks,
      capped: walked.capped,
      totalSeen: walked.totalSeen,
      denied,
      failed,
      label: source ?? rootPath,
    };
  }

  // ── Index Plain Text ──

  /**
   * Index plain-text output (logs, build output, test results) by splitting
   * into fixed-size line groups. Unlike markdown indexing, this does not
   * look for headings — it chunks by line count with overlap.
   */
  indexPlainText(
    content: string,
    source: string,
    linesPerChunk: number = 20,
    attribution?: { sessionId?: string; eventId?: string },
    maxChunkBytes: number = MAX_CHUNK_BYTES,
  ): IndexResult {
    if (!content || content.trim().length === 0) {
      return this.#insertChunks([], source, "", undefined, undefined, attribution);
    }

    const chunks = this.#chunkPlainText(content, linesPerChunk, maxChunkBytes);

    return withRetry(() => this.#insertChunks(
      chunks.map((c) => ({ ...c, hasCode: false })),
      source,
      content,
      undefined,
      undefined,
      attribution,
    ));
  }

  // ── Index JSON ──

  /**
   * Index JSON content by walking the object tree and using key paths
   * as chunk titles (analogous to heading hierarchy in markdown). Objects
   * recurse by key; arrays batch items by size.
   *
   * Falls back to `indexPlainText` if the content is not valid JSON.
   */
  indexJSON(
    content: string,
    source: string,
    maxChunkBytes: number = MAX_CHUNK_BYTES,
    attribution?: { sessionId?: string; eventId?: string },
  ): IndexResult {
    if (!content || content.trim().length === 0) {
      return this.indexPlainText("", source, undefined, attribution, maxChunkBytes);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return this.indexPlainText(content, source, undefined, attribution, maxChunkBytes);
    }

    const chunks: Chunk[] = [];
    this.#walkJSON(parsed, [], chunks, maxChunkBytes);

    if (chunks.length === 0) {
      return this.indexPlainText(content, source, undefined, attribution, maxChunkBytes);
    }

    return withRetry(() => this.#insertChunks(chunks, source, content, undefined, undefined, attribution));
  }

  // ── Shared DB Insertion ──

  /**
   * Shared DB insertion logic for all index methods. Inserts chunks
   * into both FTS5 tables within a transaction and extracts vocabulary.
   * Uses cached prepared statements from #prepareStatements().
   */
  #insertChunks(
    chunks: Chunk[],
    label: string,
    text: string,
    filePath?: string,
    contentHash?: string,
    attribution?: { sessionId?: string; eventId?: string },
  ): IndexResult {
    const codeChunks = chunks.filter((c) => c.hasCode).length;
    // FK columns on chunks. Empty-string fallback preserves the FTS5-friendly
    // "not-null but unattributed" sentinel used by legacy rows.
    const sessionIdCol = attribution?.sessionId ?? "";
    const eventIdCol = attribution?.eventId ?? "";

    // Atomic dedup + insert: delete previous source with same label,
    // then insert new content — all within a single transaction.
    // Prevents stale results in iterative workflows. (See: GitHub issue #67)
    const transaction = this.#db.transaction(() => {
      this.#stmtDeleteChunksByLabel.run(label);
      this.#stmtDeleteChunksTrigramByLabel.run(label);
      this.#stmtDeleteSourcesByLabel.run(label);

      if (chunks.length === 0) {
        const info = this.#stmtInsertSourceEmpty.run(label, filePath ?? null, contentHash ?? null);
        return Number(info.lastInsertRowid);
      }

      const info = this.#stmtInsertSource.run(label, chunks.length, codeChunks, filePath ?? null, contentHash ?? null);
      const sourceId = Number(info.lastInsertRowid);

      const now = new Date().toISOString();
      for (const chunk of chunks) {
        const ct = chunk.hasCode ? "code" : "prose";
        this.#stmtInsertChunk.run(chunk.title, chunk.content, sourceId, ct, null, sessionIdCol, eventIdCol, now);
        this.#stmtInsertChunkTrigram.run(chunk.title, chunk.content, sourceId, ct, null, sessionIdCol, eventIdCol, now);
      }

      return sourceId;
    });

    const sourceId = transaction();
    if (text) this.#extractAndStoreVocabulary(text);

    // Periodically optimize FTS5 indexes to merge b-tree segments.
    // Fragmentation accumulates over insert/delete cycles (dedup re-indexes
    // every source on update). The 'optimize' command merges segments into
    // a single b-tree, improving search latency for long-running sessions.
    this.#insertCount++;
    if (this.#insertCount % ContentStore.OPTIMIZE_EVERY === 0) {
      this.#optimizeFTS();
    }

    return {
      sourceId,
      label,
      totalChunks: chunks.length,
      codeChunks,
    };
  }

  // ── Search ──

  #mapSearchRows(rows: SearchRow[]): SearchResult[] {
    return rows.map((r) => ({
      title: r.title,
      content: r.content,
      source: r.label,
      rank: r.rank,
      contentType: r.content_type as "code" | "prose",
      highlighted: r.highlighted,
      timestamp: r.timestamp ?? undefined,
      sessionId: r.session_id ?? "",
    }));
  }

  #sourceFilterParam(source: string, sourceMatchMode: SourceMatchMode): string {
    if (sourceMatchMode === "exact") return source;
    // Escape SQLite LIKE metacharacters so user-supplied source labels
    // containing `_`, `%`, or `\` are matched literally rather than as
    // wildcards. Backslash must be replaced first (otherwise subsequent
    // escapes would themselves be re-escaped). Paired with `ESCAPE '\'`
    // in the four prepared LIKE statements (#stmtSearchPorter*,
    // #stmtSearchTrigram*). Regression: #646.
    const escaped = source
      .replace(/\\/g, "\\\\")
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_");
    return `%${escaped}%`;
  }

  search(
    query: string,
    limit: number = 3,
    source?: string,
    mode: "AND" | "OR" = "AND",
    contentType?: "code" | "prose",
    sourceMatchMode: SourceMatchMode = "like",
  ): SearchResult[] {
    const sanitized = sanitizeQuery(query, mode);

    let stmt: PreparedStatement;
    let params: unknown[];

    if (source && contentType) {
      stmt = sourceMatchMode === "exact"
        ? this.#stmtSearchPorterExactContentType
        : this.#stmtSearchPorterFilteredContentType;
      params = [sanitized, this.#sourceFilterParam(source, sourceMatchMode), contentType, limit];
    } else if (source) {
      stmt = sourceMatchMode === "exact"
        ? this.#stmtSearchPorterExact
        : this.#stmtSearchPorterFiltered;
      params = [sanitized, this.#sourceFilterParam(source, sourceMatchMode), limit];
    } else if (contentType) {
      stmt = this.#stmtSearchPorterContentType;
      params = [sanitized, contentType, limit];
    } else {
      stmt = this.#stmtSearchPorter;
      params = [sanitized, limit];
    }

    return withRetry(() => this.#mapSearchRows(stmt.all(...params) as SearchRow[]));
  }

  // ── Trigram Search (Layer 2) ──

  searchTrigram(
    query: string,
    limit: number = 3,
    source?: string,
    mode: "AND" | "OR" = "AND",
    contentType?: "code" | "prose",
    sourceMatchMode: SourceMatchMode = "like",
  ): SearchResult[] {
    const sanitized = sanitizeTrigramQuery(query, mode);
    if (!sanitized) return [];

    let stmt: PreparedStatement;
    let params: unknown[];

    if (source && contentType) {
      stmt = sourceMatchMode === "exact"
        ? this.#stmtSearchTrigramExactContentType
        : this.#stmtSearchTrigramFilteredContentType;
      params = [sanitized, this.#sourceFilterParam(source, sourceMatchMode), contentType, limit];
    } else if (source) {
      stmt = sourceMatchMode === "exact"
        ? this.#stmtSearchTrigramExact
        : this.#stmtSearchTrigramFiltered;
      params = [sanitized, this.#sourceFilterParam(source, sourceMatchMode), limit];
    } else if (contentType) {
      stmt = this.#stmtSearchTrigramContentType;
      params = [sanitized, contentType, limit];
    } else {
      stmt = this.#stmtSearchTrigram;
      params = [sanitized, limit];
    }

    return withRetry(() => this.#mapSearchRows(stmt.all(...params) as SearchRow[]));
  }

  // ── Fuzzy Correction (Layer 3) ──

  fuzzyCorrect(query: string): string | null {
    const word = query.toLowerCase().trim();
    if (word.length < 3) return null;

    // Cache hit: promote to tail (Map preserves insertion order → LRU).
    if (this.#fuzzyCache.has(word)) {
      const cached = this.#fuzzyCache.get(word) ?? null;
      this.#fuzzyCache.delete(word);
      this.#fuzzyCache.set(word, cached);
      return cached;
    }

    const maxDist = maxEditDistance(word.length);

    const candidates = this.#stmtFuzzyVocab.all(
      word.length - maxDist,
      word.length + maxDist,
    ) as Array<{ word: string }>;

    let bestWord: string | null = null;
    let bestDist = maxDist + 1;
    let exactMatch = false;

    for (const { word: candidate } of candidates) {
      if (candidate === word) {
        exactMatch = true;
        break;
      }
      const dist = levenshtein(word, candidate);
      if (dist < bestDist) {
        bestDist = dist;
        bestWord = candidate;
      }
    }

    const result = exactMatch ? null : bestDist <= maxDist ? bestWord : null;

    // Evict the oldest entry before insert if we hit the size cap.
    if (this.#fuzzyCache.size >= ContentStore.FUZZY_CACHE_SIZE) {
      const oldestKey = this.#fuzzyCache.keys().next().value;
      if (oldestKey !== undefined) this.#fuzzyCache.delete(oldestKey);
    }
    this.#fuzzyCache.set(word, result);

    return result;
  }

  // ── Reciprocal Rank Fusion (Cormack et al. 2009) ──

  #rrfSearch(
    query: string,
    limit: number,
    source?: string,
    contentType?: "code" | "prose",
    sourceMatchMode: SourceMatchMode = "like",
  ): SearchResult[] {
    return this.#rrfSearchWithPool(query, limit, source, contentType, sourceMatchMode).results;
  }

  /**
   * RRF fusion, plus what the fusion knew and used to throw away.
   *
   * `scoreMap.size` is the number of distinct chunks that matched before the
   * limit was applied — the honest answer to "how many are there". It is a
   * lower bound, not a count: when either layer returned exactly its fetch
   * limit the pool was truncated by the fetch, so the real total is larger.
   * `saturated` records that, and every caller must err towards it.
   */
  #rrfSearchWithPool(
    query: string,
    limit: number,
    source?: string,
    contentType?: "code" | "prose",
    sourceMatchMode: SourceMatchMode = "like",
  ): { results: SearchResult[]; poolSize: number; saturated: boolean } {
    const K = 60; // Standard RRF constant
    const fetchLimit = Math.max(limit * 2, 10);

    const porterResults = this.search(query, fetchLimit, source, "OR", contentType, sourceMatchMode);
    const trigramResults = this.searchTrigram(query, fetchLimit, source, "OR", contentType, sourceMatchMode);

    const scoreMap = new Map<string, { result: SearchResult; score: number }>();
    const key = (r: SearchResult) => `${r.source}::${r.title}`;

    for (const [i, r] of porterResults.entries()) {
      const k = key(r);
      const existing = scoreMap.get(k);
      if (existing) {
        existing.score += 1 / (K + i + 1);
      } else {
        scoreMap.set(k, { result: r, score: 1 / (K + i + 1) });
      }
    }

    for (const [i, r] of trigramResults.entries()) {
      const k = key(r);
      const existing = scoreMap.get(k);
      if (existing) {
        existing.score += 1 / (K + i + 1);
      } else {
        scoreMap.set(k, { result: r, score: 1 / (K + i + 1) });
      }
    }

    const results = Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ result, score }) => ({ ...result, rank: -score }));

    let poolSize = scoreMap.size;
    let saturated = porterResults.length >= fetchLimit || trigramResults.length >= fetchLimit;

    // Exact totals, opt-in. The fused pool is fetch-limited by design — asking
    // for the true count means a second, much wider fusion, which is real work
    // on a large index and buys only a nicer number. Off by default, and still
    // bounded: past EXACT_TOTAL_CAP the answer stays a lower bound.
    if (saturated && process.env.CONTEXT_MODE_SEARCH_EXACT_TOTALS === "1" && limit < ContentStore.EXACT_TOTAL_CAP) {
      try {
        const wide = this.#rrfSearchWithPool(
          query, ContentStore.EXACT_TOTAL_CAP, source, contentType, sourceMatchMode,
        );
        poolSize = Math.max(poolSize, wide.poolSize);
        saturated = wide.saturated;
      } catch { /* keep the lower bound */ }
    }

    return { results, poolSize, saturated };
  }

  // ── Proximity Reranking ──

  #applyProximityReranking(
    results: SearchResult[],
    query: string,
  ): SearchResult[] {
    const allTerms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 2);
    // Exclude stopwords from proximity/title scoring — they match everywhere
    // and inflate boosts for irrelevant chunks. Keep all terms as fallback.
    const filtered = allTerms.filter((w) => !STOPWORDS.has(w));
    const terms = filtered.length > 0 ? filtered : allTerms;

    return results
      .map((r) => {
        // Title-match boost: query terms found in the chunk title get a boost.
        // Code chunks get a stronger title boost (function/class names are high
        // signal) while prose chunks get a moderate one (headings are useful but
        // body carries more weight).
        const titleLower = r.title.toLowerCase();
        const titleHits = terms.filter((t) => titleLower.includes(t)).length;
        const titleWeight = r.contentType === "code" ? 0.6 : 0.3;
        const titleBoost = titleHits > 0 ? titleWeight * (titleHits / terms.length) : 0;

        // Proximity boost for multi-term queries. minSpan picks the single
        // tightest window — frequency doesn't move it, so a long doc with one
        // tight occurrence outranks a short doc with several. Phrase-frequency
        // reward layers a saturating frequency signal on top: cap 0.5 (below
        // proximity max ≈1.0, in title-boost range), saturates at 4 hits.
        let proximityBoost = 0;
        let phraseBoost = 0;
        if (terms.length >= 2) {
          const content = r.content.toLowerCase();
          const positions = terms.map((t) => findAllPositions(content, t));

          if (!positions.some((p) => p.length === 0)) {
            const minSpan = findMinSpan(positions);
            proximityBoost = 1 / (1 + minSpan / Math.max(content.length, 1));

            const adjacentPairs = countAdjacentPairs(positions, terms);
            phraseBoost = 0.5 * Math.min(1, adjacentPairs / 4);
          }
        }

        return { result: r, boost: titleBoost + proximityBoost + phraseBoost };
      })
      .sort((a, b) => b.boost - a.boost || a.result.rank - b.result.rank)
      .map(({ result }) => result);
  }

  // ── Unified Fallback Search ──

  searchWithFallback(
    query: string,
    limit: number = 3,
    source?: string,
    contentType?: "code" | "prose",
    sourceMatchMode: SourceMatchMode = "like",
    sessionIdAllowSet?: Set<string>,
  ): SearchResult[] {
    return this.searchWithFallbackMeta(
      query, limit, source, contentType, sourceMatchMode, sessionIdAllowSet,
    ).results;
  }

  /**
   * `searchWithFallback`, plus how much of the match set the caller is seeing.
   *
   * Split out rather than folded in so no existing call site or test has to
   * change: the old signature delegates here and drops the metadata.
   */
  searchWithFallbackMeta(
    query: string,
    limit: number = 3,
    source?: string,
    contentType?: "code" | "prose",
    sourceMatchMode: SourceMatchMode = "like",
    sessionIdAllowSet?: Set<string>,
  ): { results: SearchResult[]; completeness: SearchCompleteness } {
    // Step 0: Auto-refresh stale file-backed sources before searching
    this.#refreshStaleSources();

    // When a session-id allow-set is in play (issue #737 project filter),
    // fetch a larger candidate pool from the FTS5 layers so the post-filter
    // can still deliver `limit` matches even if many candidates are excluded.
    // The cap is bounded — even at the largest installs the chunk count
    // dwarfs `limit * 8`, and the surplus is dropped on the post-filter.
    const fetchLimit = sessionIdAllowSet ? Math.max(limit * 8, 40) : limit;
    const sessionFilter = this.#makeSessionFilter(sessionIdAllowSet);

    // A session filter drops candidates after the pool is counted, so the pool
    // is no longer an honest total — report it as a lower bound.
    const filtered = !!sessionFilter;

    // Step 1: RRF fusion (porter OR + trigram OR → merge)
    const rrf = this.#rrfSearchWithPool(query, fetchLimit, source, contentType, sourceMatchMode);
    const rrfFiltered = sessionFilter ? rrf.results.filter(sessionFilter) : rrf.results;
    if (rrfFiltered.length > 0) {
      const shown = Math.min(limit, rrfFiltered.length);
      const reranked = this.#applyProximityReranking(rrfFiltered.slice(0, limit), query);
      return {
        results: reranked.map((r) => ({ ...r, matchLayer: "rrf" as const })),
        completeness: {
          shown,
          poolSize: filtered ? rrfFiltered.length : rrf.poolSize,
          saturated: rrf.saturated || filtered,
        },
      };
    }

    // Step 2: Fuzzy correction → RRF re-run
    // Skip stopwords — they'll be filtered by sanitizeQuery anyway, and each
    // fuzzyCorrect call hits the vocab DB + runs levenshtein comparisons.
    const words = query
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
    const original = words.join(" ");
    const correctedWords = words.map((w) => this.fuzzyCorrect(w) ?? w);
    const correctedQuery = correctedWords.join(" ");

    if (correctedQuery !== original) {
      const fuzzy = this.#rrfSearchWithPool(correctedQuery, fetchLimit, source, contentType, sourceMatchMode);
      const fuzzyFiltered = sessionFilter ? fuzzy.results.filter(sessionFilter) : fuzzy.results;
      if (fuzzyFiltered.length > 0) {
        const shown = Math.min(limit, fuzzyFiltered.length);
        const reranked = this.#applyProximityReranking(fuzzyFiltered.slice(0, limit), correctedQuery);
        return {
          results: reranked.map((r) => ({ ...r, matchLayer: "rrf-fuzzy" as const })),
          completeness: {
            shown,
            poolSize: filtered ? fuzzyFiltered.length : fuzzy.poolSize,
            saturated: fuzzy.saturated || filtered,
          },
        };
      }
    }

    return { results: [], completeness: { shown: 0, poolSize: 0, saturated: false } };
  }

  /**
   * Build the session-id post-filter for the FTS5 candidate pool. Legacy
   * chunks indexed before per-session attribution carry `session_id=''` and
   * stay visible across projects so user-indexed content remains reachable
   * after opting into the shared-DB mode (#737).
   */
  #makeSessionFilter(
    allowSet: Set<string> | undefined,
  ): ((r: SearchResult) => boolean) | null {
    if (!allowSet) return null;
    return (r: SearchResult) => {
      const sid = r.sessionId ?? "";
      return sid === "" || allowSet.has(sid);
    };
  }

  /** Number of sources auto-refreshed in the last searchWithFallback call. */
  lastRefreshCount = 0;

  /**
   * Check all file-backed sources for staleness and auto re-index changed files.
   * Uses mtime as a fast gate — only computes SHA-256 when mtime has advanced
   * past indexed_at. Gracefully skips deleted files and non-file sources.
   */
  #refreshStaleSources(): void {
    this.lastRefreshCount = 0;
    const sources = this.#db.prepare(
      "SELECT label, file_path, content_hash, indexed_at FROM sources WHERE file_path IS NOT NULL",
    ).all() as Array<{ label: string; file_path: string; content_hash: string; indexed_at: string }>;

    for (const src of sources) {
      try {
        if (!existsSync(src.file_path)) continue; // file deleted — keep cached results
        // Re-check deny policy before re-reading. The Read deny list may
        // have been edited after this source was originally indexed; a
        // file that was allowed then may now be denied. Without this
        // gate, refresh would happily re-read and re-expose it. #442 r3.
        if (this.#denyChecker && this.#denyChecker(src.file_path)) continue;
        const mtime = statSync(src.file_path).mtime;
        const indexedAt = new Date(src.indexed_at + "Z");
        if (mtime <= indexedAt) continue; // file unchanged — fast path

        // mtime advanced — fd-bound read for hash + indexing in one go.
        // Open once, fstat, read from fd. Closes the swap-mid-flight
        // window between hash read and re-index. #442 round-3.
        const fd = openSync(src.file_path, "r");
        let newContent: string;
        try {
          const st = fstatSync(fd);
          if (!st.isFile()) continue; // skip non-regular targets
          newContent = readFileSync(fd, "utf-8");
        } finally {
          closeSync(fd);
        }
        const newHash = createHash("sha256").update(newContent).digest("hex");
        if (newHash === src.content_hash) {
          // Content identical — the mtime moved without the bytes changing
          // (a touch, a checkout, a formatter that rewrote the same text).
          // Move indexed_at forward so the mtime gate above catches it next
          // time instead of re-reading the file on every single search.
          this.#touchSource(src.label);
          continue;
        }

        // File genuinely changed — re-index using already-read content
        // (avoids a second open/read race) but preserve file_path/hash
        // by going through index() which stores them. Since we pass
        // content, index() does NOT re-read; the bytes hashed above
        // are exactly the bytes indexed.
        this.index({ content: newContent, path: src.file_path, source: src.label });
        this.lastRefreshCount++;
      } catch {
        // Graceful degradation — never break search for stale detection
      }
    }
  }

  // ── Sources ──

  getSourceMeta(label: string): { label: string; chunkCount: number; codeChunkCount: number; indexedAt: string; filePath: string | null; contentHash: string | null } | null {
    const row = this.#stmtSourceMeta.get(label) as { label: string; chunk_count: number; code_chunk_count: number; indexed_at: string; file_path: string | null; content_hash: string | null } | undefined;
    if (!row) return null;
    return { label: row.label, chunkCount: row.chunk_count, codeChunkCount: row.code_chunk_count, indexedAt: row.indexed_at, filePath: row.file_path ?? null, contentHash: row.content_hash ?? null };
  }

  listSources(): Array<{ label: string; chunkCount: number }> {
    return this.#stmtListSources.all() as Array<{
      label: string;
      chunkCount: number;
    }>;
  }

  /**
   * Aggregate snapshot of the persistent content store. Returns total
   * chunk count, source count, and the most recent indexed_at timestamp.
   * Used by ctx_stats so callers can see observability state in the same
   * round trip instead of inferring it from snapshot diffs.
   */
  getIndexState(): { totalChunks: number; totalSources: number; lastIndexedAt?: string } {
    const row = (this.#db
      .prepare("SELECT COALESCE(SUM(chunk_count), 0) AS total_chunks, COUNT(*) AS total_sources, MAX(indexed_at) AS last_indexed_at FROM sources")
      .get() as {
        total_chunks: number;
        total_sources: number;
        last_indexed_at: string | null;
      });
    return {
      totalChunks: row.total_chunks ?? 0,
      totalSources: row.total_sources ?? 0,
      lastIndexedAt: row.last_indexed_at ?? undefined,
    };
  }

  /**
   * Get all chunks for a given source by ID — bypasses FTS5 MATCH entirely.
   * Use this for inventory/listing where you need all sections, not search.
   */
  getChunksBySource(sourceId: number): SearchResult[] {
    const rows = this.#stmtChunksBySource.all(sourceId) as Array<{
      title: string;
      content: string;
      content_type: string;
      label: string;
    }>;

    return rows.map((r) => ({
      title: r.title,
      content: r.content,
      source: r.label,
      rank: 0,
      contentType: r.content_type as "code" | "prose",
    }));
  }

  // ── Vocabulary ──

  getDistinctiveTerms(sourceId: number, maxTerms: number = 40): string[] {
    const stats = this.#stmtSourceChunkCount.get(sourceId) as
      | { chunk_count: number }
      | undefined;

    if (!stats || stats.chunk_count < 3) return [];

    const totalChunks = stats.chunk_count;
    const minAppearances = 2;
    const maxAppearances = Math.max(3, Math.ceil(totalChunks * 0.4));

    // Stream chunks one at a time to avoid loading all content into memory
    // Count document frequency (how many sections contain each word)
    const docFreq = new Map<string, number>();

    for (const row of this.#stmtChunkContent.iterate(sourceId) as Iterable<{ content: string }>) {
      const words = new Set(
        row.content
          .toLowerCase()
          .split(/[^\p{L}\p{N}_-]+/u)
          .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
      );
      for (const word of words) {
        docFreq.set(word, (docFreq.get(word) ?? 0) + 1);
      }
    }

    const filtered = Array.from(docFreq.entries())
      .filter(([, count]) => count >= minAppearances && count <= maxAppearances);

    // Score: IDF (rarity) + length bonus + identifier bonus (underscore/camelCase)
    const scored = filtered.map(([word, count]: [string, number]) => {
      const idf = Math.log(totalChunks / count);
      const lenBonus = Math.min(word.length / 20, 0.5);
      const hasSpecialChars = /[_]/.test(word);
      const isCamelOrLong = word.length >= 12;
      const identifierBonus = hasSpecialChars ? 1.5 : isCamelOrLong ? 0.8 : 0;
      return { word, score: idf + lenBonus + identifierBonus };
    });

    return scored
      .sort((a: { word: string; score: number }, b: { word: string; score: number }) => b.score - a.score)
      .slice(0, maxTerms)
      .map((s: { word: string; score: number }) => s.word);
  }

  // ── Stats ──

  getStats(): StoreStats {
    const row = this.#stmtStats.get() as {
      sources: number;
      chunks: number;
      codeChunks: number;
    } | undefined;

    return {
      sources: row?.sources ?? 0,
      chunks: row?.chunks ?? 0,
      codeChunks: row?.codeChunks ?? 0,
    };
  }

  // ── Cleanup ──

  /**
   * Delete sources (and their chunks) older than maxAgeDays.
   * Returns count of deleted sources.
   */
  cleanupStaleSources(maxAgeDays: number): number {
    const cleanup = this.#db.transaction((days: number) => {
      this.#stmtCleanupChunks.run(days);
      this.#stmtCleanupChunksTrigram.run(days);
      return this.#stmtCleanupSources.run(days);
    });
    const info = cleanup(maxAgeDays);
    return info.changes;
  }

  /**
   * Delete one source and every chunk that belongs to it.
   *
   * Needed by the code index: a file deleted on disk must stop answering
   * searches, and "wait for the 14-day staleness sweep" is not an answer when
   * the agent is acting on the result today.
   *
   * @returns Number of source rows removed (0 or 1).
   */
  deleteSource(label: string): number {
    const remove = this.#db.transaction((lbl: string) => {
      const row = this.#db.prepare("SELECT id FROM sources WHERE label = ?").get(lbl) as
        | { id: number }
        | undefined;
      if (!row) return 0;
      this.#db.prepare("DELETE FROM chunks WHERE source_id = ?").run(row.id);
      this.#db.prepare("DELETE FROM chunks_trigram WHERE source_id = ?").run(row.id);
      this.#db.prepare("DELETE FROM sources WHERE id = ?").run(row.id);
      return 1;
    });
    try {
      return remove(label) as number;
    } catch {
      return 0;
    }
  }

  /** Get DB file size in bytes. */
  getDBSizeBytes(): number {
    try {
      return statSync(this.#dbPath).size;
    } catch {
      return 0;
    }
  }

  /**
   * Reclaim free pages with VACUUM — but only when there is something to
   * reclaim and the file is small enough for it to be quick.
   *
   * VACUUM rewrites the whole database, so it is wrong on `close()` (a session
   * ending should not pay seconds of I/O) and wrong when the freelist is a few
   * pages. Called from `context-mode drain`, where latency is free.
   *
   * @returns Bytes reclaimed, or 0 when the vacuum was skipped or gained
   *   nothing.
   */
  compact(): number {
    try {
      // Fold the WAL in first. Without this the `.db` file can be a single page
      // while megabytes sit in the WAL, and every size test below reads a
      // number that has nothing to do with what the store costs.
      try { this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* busy — sizes below still hold */ }
      const before = this.getDBSizeBytes();
      if (before === 0) return 0;

      const maxBytes = Number.parseInt(process.env.CONTEXT_MODE_VACUUM_MAX_BYTES ?? "", 10);
      const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 256 * 1024 * 1024;
      if (before > cap) return 0;

      const freelist = (this.#db.prepare("PRAGMA freelist_count").get() as { freelist_count?: number } | undefined)?.freelist_count ?? 0;
      const pageSize = (this.#db.prepare("PRAGMA page_size").get() as { page_size?: number } | undefined)?.page_size ?? 4096;
      const reclaimable = freelist * pageSize;
      // Worth a full rewrite only when the waste is material both absolutely
      // and relative to the file.
      if (reclaimable <= Math.max(1024 * 1024, before * 0.2)) return 0;

      this.#db.exec("VACUUM");
      try { this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* best-effort */ }
      const after = this.getDBSizeBytes();
      return Math.max(0, before - after);
    } catch {
      return 0;
    }
  }

  /** Merge FTS5 b-tree segments for both porter and trigram indexes. */
  #optimizeFTS(): void {
    try {
      this.#db.exec("INSERT INTO chunks(chunks) VALUES('optimize')");
      this.#db.exec("INSERT INTO chunks_trigram(chunks_trigram) VALUES('optimize')");
    } catch { /* best effort — don't block indexing */ }
  }

  close(): void {
    this.#optimizeFTS(); // defragment before close
    closeDB(this.#db); // WAL checkpoint before close — important for persistent DBs
  }

  // ── Vocabulary Extraction ──

  #extractAndStoreVocabulary(content: string): void {
    const words = content
      .toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w));

    const unique = [...new Set(words)];

    let inserted = 0;
    this.#db.transaction(() => {
      for (const word of unique) {
        const info = this.#stmtInsertVocab.run(word);
        inserted += info.changes;
      }
    })();

    // Invalidate fuzzy cache when new vocab words actually land. INSERT OR
    // IGNORE reports changes=0 for duplicates, so re-indexing identical
    // content does not thrash the cache during iterative workflows.
    if (inserted > 0) this.#fuzzyCache.clear();
  }

  // ── Chunking ──

  #chunkMarkdown(text: string, maxChunkBytes: number = MAX_CHUNK_BYTES): Chunk[] {
    const chunks: Chunk[] = [];
    const lines = text.split("\n");
    const headingStack: Array<{ level: number; text: string }> = [];
    let currentContent: string[] = [];
    let currentHeading = "";

    const flush = () => {
      const joined = currentContent.join("\n").trim();
      if (joined.length === 0) return;

      const title = this.#buildTitle(headingStack, currentHeading);
      const hasCode = currentContent.some((l) => /^`{3,}/.test(l));

      // If under the cap, emit as-is (fast path — most chunks hit this)
      if (Buffer.byteLength(joined) <= maxChunkBytes) {
        chunks.push({ title, content: joined, hasCode });
        currentContent = [];
        return;
      }

      // Split oversized chunk at paragraph boundaries (double newlines)
      const paragraphs = joined.split(/\n\n+/);
      let accumulator: string[] = [];
      let partIndex = 1;

      const flushAccumulator = () => {
        if (accumulator.length === 0) return;
        const part = accumulator.join("\n\n").trim();
        if (part.length === 0) return;
        const partTitle = paragraphs.length > 1 ? `${title} (${partIndex})` : title;
        partIndex++;
        chunks.push({
          title: partTitle,
          content: part,
          hasCode: part.includes("```"),
        });
        accumulator = [];
      };

      for (const para of paragraphs) {
        accumulator.push(para);
        const candidate = accumulator.join("\n\n");
        if (Buffer.byteLength(candidate) > maxChunkBytes && accumulator.length > 1) {
          accumulator.pop();
          flushAccumulator();
          accumulator = [para];
        }
      }
      flushAccumulator();

      currentContent = [];
    };

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // Horizontal rule separator (Context7 uses long dashes)
      if (/^[-_*]{3,}\s*$/.test(line)) {
        flush();
        i++;
        continue;
      }

      // Heading (H1-H4)
      const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
      if (headingMatch) {
        flush();

        const level = headingMatch[1].length;
        const heading = headingMatch[2].trim();

        // Pop deeper levels from stack
        while (
          headingStack.length > 0 &&
          headingStack[headingStack.length - 1].level >= level
        ) {
          headingStack.pop();
        }
        headingStack.push({ level, text: heading });
        currentHeading = heading;

        currentContent.push(line);
        i++;
        continue;
      }

      // Code block — collect entire block as a unit
      const codeMatch = line.match(/^(`{3,})(.*)?$/);
      if (codeMatch) {
        const fence = codeMatch[1];
        const codeLines: string[] = [line];
        i++;

        while (i < lines.length) {
          codeLines.push(lines[i]);
          if (lines[i].startsWith(fence) && lines[i].trim() === fence) {
            i++;
            break;
          }
          i++;
        }

        currentContent.push(...codeLines);
        continue;
      }

      // Regular line
      currentContent.push(line);
      i++;
    }

    // Flush remaining content
    flush();

    return chunks;
  }

  /**
   * Return the largest prefix of `str` whose UTF-8 byte length does not exceed
   * `maxBytes`, walking by Unicode code point so multibyte sequences (CJK) and
   * surrogate pairs (emoji) are never cut mid-character. Guarantees forward
   * progress: if even the first code point exceeds `maxBytes`, it is still
   * returned whole (a 1-4 byte overshoot beats an infinite loop).
   */
  #byteCappedPrefix(str: string, maxBytes: number): string {
    if (Buffer.byteLength(str) <= maxBytes) return str;
    let prefix = "";
    let bytes = 0;
    for (const char of str) {
      const charBytes = Buffer.byteLength(char);
      if (bytes + charBytes > maxBytes) break;
      prefix += char;
      bytes += charBytes;
    }
    // Defensive: a single code point wider than the cap (only possible with a
    // pathologically small maxBytes) still advances by one character.
    if (prefix.length === 0) return [...str][0] ?? "";
    return prefix;
  }

  /**
   * Split a single oversized plain-text chunk into byte-capped sub-chunks
   * by accumulating lines until the byte count would exceed maxChunkBytes.
   * Falls back to byte-accurate splitting for extremely long single lines.
   */
  #splitOversizedPlainChunk(
    lines: string[],
    titlePrefix: string,
    maxChunkBytes: number,
  ): Array<{ title: string; content: string }> {
    const subChunks: Array<{ title: string; content: string }> = [];
    let accumulator: string[] = [];
    let partIndex = 1;

    const flushAccumulator = () => {
      if (accumulator.length === 0) return;
      const content = accumulator.join("\n");
      const partTitle = partIndex === 1 ? titlePrefix : `${titlePrefix} (${partIndex})`;
      subChunks.push({ title: partTitle, content });
      partIndex++;
      accumulator = [];
    };

    for (const line of lines) {
      // If a single line itself exceeds the cap (even as first line),
      // split it by character before accumulating
      if (Buffer.byteLength(line) > maxChunkBytes) {
        flushAccumulator();
        // Split the long line into byte-capped pieces
        let remaining = line;
        let linePart = 1;
        while (remaining.length > 0) {
          // Byte-accurate slice: never exceeds the cap, never cuts a multibyte
          // character (CJK) or surrogate pair (emoji) in half.
          let slice = this.#byteCappedPrefix(remaining, maxChunkBytes);
          // Try to break at a whitespace boundary near the end for readability,
          // but only when text remains after this slice.
          if (slice.length < remaining.length) {
            const lastSpace = slice.lastIndexOf(" ");
            const lastNewline = slice.lastIndexOf("\n");
            const breakPoint = Math.max(lastSpace, lastNewline);
            if (breakPoint > slice.length * WHITESPACE_BREAK_RATIO) {
              slice = slice.slice(0, breakPoint);
            }
          }
          const linePartTitle = partIndex === 1 && linePart === 1
            ? titlePrefix
            : `${titlePrefix} (${partIndex}.${linePart})`;
          subChunks.push({ title: linePartTitle, content: slice });
          remaining = remaining.slice(slice.length);
          linePart++;
          partIndex++;
        }
        continue;
      }

      const candidate = accumulator.length > 0
        ? accumulator.join("\n") + "\n" + line
        : line;

      // If adding this line would exceed the cap, flush accumulator first
      if (Buffer.byteLength(candidate) > maxChunkBytes && accumulator.length > 0) {
        flushAccumulator();
      }
      accumulator.push(line);
    }
    flushAccumulator();
    return subChunks;
  }

  #chunkPlainText(
    text: string,
    linesPerChunk: number,
    maxChunkBytes: number = MAX_CHUNK_BYTES,
  ): Array<{ title: string; content: string }> {
    // Try blank-line splitting first for naturally-sectioned output
    const sections = text.split(/\n\s*\n/);
    if (
      sections.length >= MIN_BLANK_LINE_SECTIONS &&
      sections.length <= MAX_BLANK_LINE_SECTIONS &&
      sections.every((s) => Buffer.byteLength(s) < BLANK_SECTION_STRATEGY_MAX_BYTES)
    ) {
      return sections.flatMap((section, i) => {
        const trimmed = section.trim();
        if (trimmed.length === 0) return [];
        const title = trimmed.split("\n")[0].slice(0, CHUNK_TITLE_MAX_CHARS) || `Section ${i + 1}`;
        // A section may pass the strategy guard yet still exceed the byte cap
        // (4097–4999B band): sub-split it so no stored chunk breaks the cap.
        if (Buffer.byteLength(trimmed) <= maxChunkBytes) {
          return [{ title, content: trimmed }];
        }
        return this.#splitOversizedPlainChunk(trimmed.split("\n"), title, maxChunkBytes);
      });
    }

    const lines = text.split("\n");

    // Small enough for a single chunk — but still enforce byte cap
    if (lines.length <= linesPerChunk) {
      if (Buffer.byteLength(text) <= maxChunkBytes) {
        return [{ title: "Output", content: text }];
      }
      return this.#splitOversizedPlainChunk(lines, "Output", maxChunkBytes);
    }

    // Fixed-size line groups with 2-line overlap
    const chunks: Array<{ title: string; content: string }> = [];
    const overlap = 2;
    const step = Math.max(linesPerChunk - overlap, 1);

    for (let i = 0; i < lines.length; i += step) {
      const slice = lines.slice(i, i + linesPerChunk);
      if (slice.length === 0) break;
      const startLine = i + 1;
      const endLine = Math.min(i + slice.length, lines.length);
      const firstLine = slice[0]?.trim().slice(0, CHUNK_TITLE_MAX_CHARS);
      const joined = slice.join("\n");

      // Enforce byte cap: sub-split oversized line-group chunks
      if (Buffer.byteLength(joined) <= maxChunkBytes) {
        chunks.push({
          title: firstLine || `Lines ${startLine}-${endLine}`,
          content: joined,
        });
      } else {
        const subChunks = this.#splitOversizedPlainChunk(
          slice,
          firstLine || `Lines ${startLine}-${endLine}`,
          maxChunkBytes,
        );
        chunks.push(...subChunks);
      }
    }

    return chunks;
  }

  #walkJSON(
    value: unknown,
    path: string[],
    chunks: Chunk[],
    maxChunkBytes: number,
  ): void {
    const title = path.length > 0 ? path.join(" > ") : "(root)";
    const serialized = JSON.stringify(value, null, 2);

    // Small enough — emit as a single chunk
    if (Buffer.byteLength(serialized) <= maxChunkBytes) {
      // Exception: objects with nested structure (object/array values) always
      // recurse so that key paths become chunk titles for searchability —
      // even when the subtree fits in one chunk. Flat objects (all primitive
      // values) stay as a single chunk since there's no hierarchy to expose.
      const shouldRecurse =
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.values(value).some(
          (v) => typeof v === "object" && v !== null,
        );

      if (!shouldRecurse) {
        chunks.push({ title, content: serialized, hasCode: true });
        return;
      }
    }

    // Object — recurse into each key
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const entries = Object.entries(value);
      if (entries.length > 0) {
        for (const [key, val] of entries) {
          this.#walkJSON(val, [...path, key], chunks, maxChunkBytes);
        }
        return;
      }
      // Empty object — emit as-is
      chunks.push({ title, content: serialized, hasCode: true });
      return;
    }

    // Array — batch by size with identity-field-aware titles
    if (Array.isArray(value)) {
      this.#chunkJSONArray(value, path, chunks, maxChunkBytes);
      return;
    }

    // Primitive that exceeds maxChunkBytes (e.g., very long string)
    chunks.push({ title, content: serialized, hasCode: false });
  }

  /**
   * Scan the first element of an array of objects for a recognizable
   * identity field. Returns the field name or null.
   */
  #findIdentityField(arr: unknown[]): string | null {
    if (arr.length === 0) return null;
    const first = arr[0];
    if (typeof first !== "object" || first === null || Array.isArray(first)) return null;

    const candidates = ["id", "name", "title", "path", "slug", "key", "label"];
    const obj = first as Record<string, unknown>;
    for (const field of candidates) {
      if (field in obj && (typeof obj[field] === "string" || typeof obj[field] === "number")) {
        return field;
      }
    }
    return null;
  }

  #jsonBatchTitle(
    prefix: string,
    startIdx: number,
    endIdx: number,
    batch: unknown[],
    identityField: string | null,
  ): string {
    const sep = prefix ? `${prefix} > ` : "";

    if (!identityField) {
      return startIdx === endIdx
        ? `${sep}[${startIdx}]`
        : `${sep}[${startIdx}-${endIdx}]`;
    }

    const getId = (item: unknown) =>
      String((item as Record<string, unknown>)[identityField]);

    if (batch.length === 1) {
      return `${sep}${getId(batch[0])}`;
    }
    if (batch.length <= 3) {
      return sep + batch.map(getId).join(", ");
    }
    return `${sep}${getId(batch[0])}\u2026${getId(batch[batch.length - 1])}`;
  }

  #chunkJSONArray(
    arr: unknown[],
    path: string[],
    chunks: Chunk[],
    maxChunkBytes: number,
  ): void {
    const prefix = path.length > 0 ? path.join(" > ") : "(root)";
    const identityField = this.#findIdentityField(arr);

    let batch: unknown[] = [];
    let batchStart = 0;

    const flushBatch = (batchEnd: number) => {
      if (batch.length === 0) return;
      const title = this.#jsonBatchTitle(prefix, batchStart, batchEnd, batch, identityField);
      chunks.push({
        title,
        content: JSON.stringify(batch, null, 2),
        hasCode: true,
      });
    };

    for (let i = 0; i < arr.length; i++) {
      batch.push(arr[i]);
      const candidate = JSON.stringify(batch, null, 2);

      if (Buffer.byteLength(candidate) > maxChunkBytes && batch.length > 1) {
        batch.pop();
        flushBatch(i - 1);
        batch = [arr[i]];
        batchStart = i;
      }
    }

    // Flush remaining
    flushBatch(batchStart + batch.length - 1);
  }

  #buildTitle(
    headingStack: Array<{ level: number; text: string }>,
    currentHeading: string,
  ): string {
    if (headingStack.length === 0) {
      return currentHeading || "Untitled";
    }
    return headingStack.map((h) => h.text).join(" > ");
  }
}
