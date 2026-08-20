/**
 * Micro-benchmark for the semantic scan: what one query costs, and where.
 *
 * Run: `npx tsx tests/search/vector-scan-bench.ts [count] [dim]`
 *
 * The claim two-phase retrieval was made for is "query cost stops being linear
 * in the whole knowledge base". That claim is only worth what it measures, so
 * this reports four numbers rather than one:
 *
 *   brute (as shipped)   the exact scan the way it read vectors before —
 *                        a byte-at-a-time int8 copy per row
 *   brute (fast decode)  the same exact scan with the zero-copy decode, which
 *                        is a separate, exact, no-recall-cost improvement and
 *                        must not be credited to the shortlist
 *   coarse via SQL       phase one reading codes row by row out of SQLite —
 *                        the floor before the codes became resident, and what
 *                        a source-scoped query still pays
 *   two-phase            what an unscoped query actually costs now
 *
 * The middle number matters: without it, an improvement that came from fixing
 * the decoder would be reported as evidence for approximate retrieval.
 */

import Database from "better-sqlite3";

import {
  ensureCoarseColumns, ensureVectorTable, semanticCandidates, type HybridDb,
} from "../../src/search/hybrid.js";
import { COARSE_CODE_REV, coarseCode } from "../../src/search/coarse-scan.js";
import {
  cosineSimilarity, decodeStoredVector, encodeVectorInt8,
} from "../../src/search/embeddings.js";

const COUNT = Number(process.argv[2] ?? 25_000);
const DIM = Number(process.argv[3] ?? 1024);
const QUERIES = 20;
const K = 10;

function prng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

const rand = prng(20260820);
const gauss = (): number => {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

function unit(x: Float64Array): Float64Array {
  let n = 0;
  for (let i = 0; i < x.length; i++) n += x[i] * x[i];
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < x.length; i++) x[i] /= n;
  return x;
}

console.log(`building ${COUNT} x ${DIM}d corpus...`);
const topics = Math.max(20, Math.round(COUNT / 50));
const centres: Float64Array[] = [];
for (let t = 0; t < topics; t++) {
  const x = new Float64Array(DIM);
  for (let i = 0; i < DIM; i++) x[i] = gauss();
  centres.push(unit(x));
}
const docs: Int8Array[] = [];
for (let k = 0; k < COUNT; k++) {
  const c = centres[k % topics];
  const sd = Math.sqrt((1 / 0.7 ** 2 - 1) / DIM);
  const x = new Float64Array(DIM);
  for (let i = 0; i < DIM; i++) x[i] = c[i] + sd * gauss();
  docs.push(new Int8Array(encodeVectorInt8([...unit(x)])));
}
const queries: number[][] = [];
for (let q = 0; q < QUERIES; q++) {
  const base = docs[Math.floor(rand() * COUNT)];
  const sd = Math.sqrt((1 / 0.85 ** 2 - 1) / DIM);
  const x = new Float64Array(DIM);
  for (let i = 0; i < DIM; i++) x[i] = base[i] / 127 + sd * gauss();
  queries.push([...unit(x)]);
}

const raw = new Database(":memory:");
raw.exec(`
  CREATE TABLE sources (id INTEGER PRIMARY KEY, label TEXT NOT NULL);
  CREATE TABLE chunks (
    rowid INTEGER PRIMARY KEY, title TEXT, content TEXT,
    content_type TEXT, timestamp TEXT, session_id TEXT, source_id INTEGER
  );
  INSERT INTO sources (id, label) VALUES (1, 'bench');
`);
const db = raw as unknown as HybridDb;
ensureVectorTable(db);
ensureCoarseColumns(db);

const insChunk = raw.prepare("INSERT INTO chunks (rowid, title, content, source_id) VALUES (?,?,?,1)");
const insVec = raw.prepare(
  "INSERT INTO chunk_vectors (chunk_rowid, model, dim, vec, code, code_rev) VALUES (?,?,?,?,?,?)",
);
console.log("indexing + coding...");
raw.transaction(() => {
  docs.forEach((v, i) => {
    insChunk.run(i + 1, `chunk ${i + 1}`, `body ${i + 1}`);
    insVec.run(i + 1, "bench", v.length, Buffer.from(v.buffer, v.byteOffset, v.length),
      coarseCode(v), COARSE_CODE_REV);
  });
})();

/** The pre-change exact scan, decoder and all, kept here as the baseline. */
function bruteAsShipped(query: number[]): number[] {
  const stmt = raw.prepare("SELECT chunk_rowid, dim, vec FROM chunk_vectors");
  const scored: Array<{ rowid: number; score: number }> = [];
  for (const r of stmt.iterate() as Iterable<{ chunk_rowid: number; dim: number; vec: Buffer }>) {
    const score = cosineSimilarity(query, decodeStoredVector(r.vec, r.dim));
    if (score > 0) scored.push({ rowid: r.chunk_rowid, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, K).map(s => s.rowid);
}

/**
 * Phase one reading codes out of SQLite, one row at a time.
 *
 * The number that showed the shortlist alone could not win: iterating 25k code
 * rows costs ~40 ms and the Hamming arithmetic inside it costs ~1.6 ms of that.
 * Per-row Buffer and object allocation is the whole cost, which is why the
 * codes ended up resident instead.
 */
function coarseOnly(query: number[]): number {
  const stmt = raw.prepare("SELECT chunk_rowid, dim, code FROM chunk_vectors");
  let seen = 0;
  for (const _ of stmt.iterate() as Iterable<unknown>) seen++;
  void query;
  return seen;
}

function time(label: string, fn: () => void): number {
  fn(); // warm
  const started = process.hrtime.bigint();
  for (const q of queries) { void q; fn(); }
  const ms = Number(process.hrtime.bigint() - started) / 1e6 / queries.length;
  console.log(`  ${label.padEnd(22)} ${ms.toFixed(2)} ms/query`);
  return ms;
}

console.log(`\n${COUNT} vectors x ${DIM} dims, top-${K}:`);
let i = 0;
const shipped = time("brute (as shipped)", () => { bruteAsShipped(queries[i++ % QUERIES]); });
process.env.CONTEXT_MODE_VECTOR_SCAN = "brute";
const fastDecode = time("brute (fast decode)", () => { semanticCandidates(db, queries[i++ % QUERIES], { limit: K }); });
delete process.env.CONTEXT_MODE_VECTOR_SCAN;
const coarse = time("coarse via SQL (no cache)", () => { coarseOnly(queries[i++ % QUERIES]); });
const twoPhase = time("two-phase", () => { semanticCandidates(db, queries[i++ % QUERIES], { limit: K }); });

console.log(`\n  vs shipped brute force: ${(shipped / twoPhase).toFixed(1)}x`);
console.log(`  vs brute with the same decoder: ${(fastDecode / twoPhase).toFixed(1)}x`);
console.log(`  resident codes vs reading them per query: ${(coarse / twoPhase).toFixed(1)}x`);
raw.close();
