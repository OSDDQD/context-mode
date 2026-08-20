/**
 * The coarse half of two-phase vector retrieval.
 *
 * Every semantic query used to compute an exact cosine against every row of
 * `chunk_vectors`. At 1024 dimensions that is 1 KB read and ~1024 multiply-adds
 * per chunk, on the latency path, growing linearly with the knowledge base —
 * the last unbounded cost left in retrieval.
 *
 * This module supplies the cheap pass that shortlists candidates so the
 * expensive pass only has to look at a few hundred of them. Two properties
 * make it worth having:
 *
 *   - The coarse code is ONE BIT per dimension — exactly an eighth of the int8
 *     vector it stands in for. SQLite reads 128 bytes per row instead of 1 KB.
 *   - Ranking those codes is Hamming distance: 32 xor+popcount steps per 1024
 *     dimensions instead of 1024 multiply-adds. ~32x less arithmetic per row.
 *
 * The exact cosine still decides the answer — the coarse pass only decides who
 * gets looked at. So a coarse mistake costs recall, never correctness of the
 * scores, and the shortlist is sized (see {@link coarseShortlistSize}) from
 * measured recall rather than from a guess.
 *
 * ── Why signs of a ROTATED vector, not signs of the vector itself ──
 *
 * Taking sign(v[i]) directly is cheaper still, and it scores 100% recall on
 * isotropic data. It also collapses to ~3% recall the moment the embedding
 * space is anisotropic — some dimensions carrying far more magnitude than
 * others — because cosine is then dominated by a handful of large dimensions
 * while Hamming weighs all of them equally. Measured on synthetic corpora with
 * a 27x spread in per-dimension scale: raw sign 2.5%, rotated sign 99.9%.
 * A random rotation spreads the energy across every bit first, which is what
 * makes the bit budget comparable to a cosine.
 *
 * The rotation is a fast Johnson-Lindenstrauss transform — two rounds of
 * (random sign flip, Walsh-Hadamard) — rather than a dense random matrix.
 * A dense D x D projection costs D^2 = ~1M multiply-adds per vector and 1 MB
 * of resident matrix; this costs ~2 * P log P = ~20k adds and D bytes of sign
 * table, with measured recall equal or better (99.1-100% vs 96.7-100% at the
 * same shortlist).
 *
 * Deliberately dependency-free, like the rest of the semantic layer. sqlite-vec
 * would replace all of this with a real ANN index, but it is a native module
 * and this plugin ships as a bundle with three externals; a fourth is a
 * delivery problem before it is a search improvement.
 */

/**
 * Bumped whenever the code produced for a given vector would change.
 *
 * Stored codes are only comparable to a query code from the same revision:
 * a different rotation makes the Hamming distances meaningless, and the
 * failure is silent — search keeps working and quietly returns the wrong
 * neighbours. Rows carrying an older revision are therefore erased and
 * regenerated rather than trusted.
 */
export const COARSE_CODE_REV = 1;

/** Rounds of (sign flip + Hadamard). Two is the standard FJLT mixing depth. */
const ROTATION_ROUNDS = 2;

/**
 * Force the exact full scan.
 *
 * The escape hatch for "I think the shortlist is dropping something": setting
 * it restores the pre-two-phase behaviour exactly, with no reindex and no
 * restart of anything but the process reading it.
 */
export function bruteForceScanForced(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CONTEXT_MODE_VECTOR_SCAN?.trim().toLowerCase();
  return raw === "brute" || raw === "exact" || raw === "full";
}

// ─────────────────────────────────────────────────────────
// Rotation
// ─────────────────────────────────────────────────────────

/** xorshift32 — deterministic, seeded per padded width so every dim differs. */
function prng(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Sign tables are a pure function of (width, revision) — build once, reuse. */
const signTables = new Map<number, Int8Array[]>();

function signsFor(padded: number): Int8Array[] {
  const cached = signTables.get(padded);
  if (cached) return cached;
  // Seeded from the width so a 768-dim model and a 1024-dim model get
  // different rotations, and from the revision so a bump really does change
  // the codes it claims to change.
  const rand = prng(0x5bf03635 ^ (padded * 2654435761) ^ (COARSE_CODE_REV * 40503));
  const rounds: Int8Array[] = [];
  for (let r = 0; r < ROTATION_ROUNDS; r++) {
    const table = new Int8Array(padded);
    for (let i = 0; i < padded; i++) table[i] = rand() < 0.5 ? -1 : 1;
    rounds.push(table);
  }
  signTables.set(padded, rounds);
  return rounds;
}

/** In-place Walsh-Hadamard transform. `a.length` must be a power of two. */
function walshHadamard(a: Float64Array): void {
  const n = a.length;
  for (let len = 1; len < n; len <<= 1) {
    for (let i = 0; i < n; i += len << 1) {
      for (let j = i; j < i + len; j++) {
        const u = a[j];
        const v = a[j + len];
        a[j] = u + v;
        a[j + len] = u - v;
      }
    }
  }
}

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Floor on the bit budget, independent of how wide the model is.
 *
 * The number of bits is the number of random hyperplanes the angle is
 * estimated from, so it — not the input dimension — is what sets coarse
 * accuracy. One bit per dimension is fine at 1024 dims and visibly too coarse
 * at 384: measured recall@10 against brute force on the same corpus was 100%
 * with 1024 bits and 94% with 384. A 384-dim model therefore still gets 1024
 * bits, which is 128 bytes against a 384-byte vector — a smaller saving than
 * at 1024 dims, and still the right trade, because a coarse pass that drops
 * true neighbours is not a saving at all.
 */
const COARSE_MIN_BITS = 1024;

/** Bits in a code for a `dim`-wide vector: a power of two, at least the floor. */
export function coarseCodeBits(dim: number): number {
  return Math.max(nextPowerOfTwo(dim), COARSE_MIN_BITS);
}

/** Bytes one code occupies. Always whole 32-bit words, so the scan reads aligned. */
export function coarseCodeBytes(dim: number): number {
  return coarseCodeBits(dim) / 8;
}

/**
 * The sign of the rotated vector, one bit per hyperplane, packed LSB-first.
 *
 * @returns A BLOB of {@link coarseCodeBytes} bytes, or null for a vector that
 *   cannot produce a meaningful code (empty, or all zeros — a degenerate
 *   vector that cosine would score 0 anyway).
 */
export function coarseCode(vec: ArrayLike<number>): Buffer | null {
  const dim = vec.length;
  if (dim === 0) return null;

  // The transform width is the bit budget: zero-padding a narrow model up to
  // it costs nothing (the Hadamard rounds mix the real values into every
  // output) and buys the extra hyperplanes the recall floor needs.
  const width = coarseCodeBits(dim);
  const work = new Float64Array(width);
  let nonZero = false;
  for (let i = 0; i < dim; i++) {
    const v = vec[i];
    work[i] = v;
    if (v !== 0) nonZero = true;
  }
  if (!nonZero) return null;

  for (const table of signsFor(width)) {
    for (let i = 0; i < width; i++) work[i] *= table[i];
    walshHadamard(work);
  }

  const out = Buffer.alloc(width / 8);
  for (let i = 0; i < width; i++) {
    if (work[i] > 0) {
      const byte = i >>> 3;
      out[byte] = out[byte] | (1 << (i & 7));
    }
  }
  return out;
}

/** The query side of the comparison, as 32-bit words for the popcount loop. */
export function coarseCodeWords(vec: ArrayLike<number>): Uint32Array | null {
  const code = coarseCode(vec);
  if (!code) return null;
  const words = new Uint32Array(code.length / 4);
  for (let w = 0; w < words.length; w++) words[w] = code.readUInt32LE(w * 4);
  return words;
}

// ─────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────

/** SWAR popcount — no Math.clz32 trickery, no lookup table to keep warm. */
function popcount(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(x, 0x01010101) >>> 24);
}

/**
 * Bits that differ between a query code and a stored code BLOB.
 *
 * Reads the BLOB word by word instead of materialising a typed array: this
 * runs once per row of the whole table, and a per-row allocation is exactly
 * the kind of cost the coarse pass exists to remove. `readUInt32LE` is used
 * rather than a `Uint32Array` view because better-sqlite3 hands back buffers
 * whose `byteOffset` is not 4-aligned, which the view constructor rejects.
 *
 * @returns Hamming distance, or -1 when the blob does not match the query's
 *   width — a row from a different model, which the exact pass would score 0.
 */
export function coarseDistance(code: Buffer | Uint8Array, query: Uint32Array): number {
  const words = query.length;
  if (code.length !== words * 4) return -1;
  const buf = Buffer.isBuffer(code) ? code : Buffer.from(code);
  let distance = 0;
  for (let w = 0; w < words; w++) {
    distance += popcount((buf.readUInt32LE(w * 4) ^ query[w]) >>> 0);
  }
  return distance;
}

// ─────────────────────────────────────────────────────────
// Shortlist sizing
// ─────────────────────────────────────────────────────────

/**
 * How many coarse candidates the exact pass rescores, for a request of `k`.
 *
 * Proportional to k, because the coarse ranking displaces true neighbours by
 * a roughly constant number of RANKS, so a request for 50 needs a proportionally
 * deeper cushion than a request for 5. The 16x ratio and the 512 floor both
 * come from measured recall against brute force, on synthetic corpora spanning
 * isotropic to 27x-anisotropic per-dimension scale (see tests/search/
 * coarse-scan-recall.test.ts, which pins the numbers):
 *
 *   shortlist  16x k (=160 at k=10)   ->  99.1 - 100%
 *   shortlist  512                    ->  100% in every regime measured
 *
 * The floor exists because coarse-rank error is absolute, not proportional:
 * at k=10 a pure 16x ratio leaves 160 rows, which was the only setting that
 * ever lost a neighbour. The cap exists so a pathological k cannot quietly
 * turn phase two back into the full scan this module was written to avoid.
 */
export const COARSE_SHORTLIST_RATIO = 16;
export const COARSE_SHORTLIST_MIN = 512;
export const COARSE_SHORTLIST_MAX = 8192;

export function coarseShortlistSize(k: number): number {
  const scaled = Math.max(1, Math.floor(k)) * COARSE_SHORTLIST_RATIO;
  return Math.min(COARSE_SHORTLIST_MAX, Math.max(COARSE_SHORTLIST_MIN, scaled));
}

/**
 * Rows the exact pass will rescore before two-phase stops being worth it.
 *
 * Rows with no code yet are added to the shortlist unconditionally — dropping
 * them would mean a chunk silently disappears from results because a
 * background backfill has not reached it, which is a far worse failure than a
 * slow query. Past this many such rows the shortlist is most of the table
 * anyway, so the caller falls back to the plain exact scan: same answer, one
 * pass instead of two, and no `IN (...)` list long enough to hit SQLite's
 * bound-parameter limit.
 */
export const COARSE_EXACT_CAP = 4096;

// ─────────────────────────────────────────────────────────
// The resident code table
// ─────────────────────────────────────────────────────────

/**
 * Ceiling on resident code bytes.
 *
 * 32 MB holds ~260k codes at 1024 bits. Past that the cache is refused and the
 * coarse pass falls back to reading codes out of SQLite — slower, still
 * two-phase, still correct. A memory cap is preferable to an OOM in a
 * long-lived MCP server that has no idea how big the user's store will get.
 */
export const COARSE_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Every coarse code, resident, in one contiguous typed array.
 *
 * Measured: iterating 25,000 code rows through better-sqlite3 costs ~42 ms per
 * query, and the Hamming arithmetic inside that loop costs 1.6 ms of it. The
 * bottleneck was never the maths — it is the per-row Buffer and object
 * better-sqlite3 has to allocate. A shortlist cannot fix that, because the
 * coarse pass still has to look at every row.
 *
 * So the codes are read out of SQLite once and scanned from memory afterwards:
 * the same 25,000 rows take 1.7 ms. That is what turns "linear in the store"
 * from a latency problem into a rounding error — a million vectors would scan
 * in ~70 ms, where the row-by-row version would need seven seconds.
 *
 * Nothing here decides an answer. The exact cosine still ranks the shortlist
 * this produces, so a stale cache costs recall on the rows it is stale about
 * and can never invent a score.
 */
export class CoarseCodeCache {
  private readonly codes: Uint32Array;
  private readonly rowids: Int32Array;
  private size = 0;
  /**
   * Rows with no code, or a code of the wrong width.
   *
   * Force-included in every shortlist. A row the backfill has not reached must
   * not vanish from results because of it.
   */
  readonly uncoded: number[] = [];

  constructor(readonly words: number, capacity: number) {
    this.codes = new Uint32Array(words * capacity);
    this.rowids = new Int32Array(capacity);
  }

  get length(): number {
    return this.size;
  }

  /** @returns false when the code does not belong in this cache's width. */
  add(rowid: number, code: Buffer | Uint8Array | null): boolean {
    if (!code || code.length !== this.words * 4) {
      this.uncoded.push(rowid);
      return false;
    }
    if (this.size >= this.rowids.length) return false;
    const buf = Buffer.isBuffer(code) ? code : Buffer.from(code);
    const base = this.size * this.words;
    for (let w = 0; w < this.words; w++) this.codes[base + w] = buf.readUInt32LE(w * 4);
    this.rowids[this.size] = rowid;
    this.size++;
    return true;
  }

  /** Nearest `size` rowids by Hamming distance, plus every uncoded row. */
  shortlist(query: Uint32Array, size: number): number[] {
    const heap = new ShortlistHeap(size);
    const words = this.words;
    for (let r = 0; r < this.size; r++) {
      const base = r * words;
      let distance = 0;
      for (let w = 0; w < words; w++) {
        distance += popcount((this.codes[base + w] ^ query[w]) >>> 0);
      }
      heap.push(this.rowids[r], distance);
    }
    return [...heap.drain(), ...this.uncoded];
  }
}

/**
 * Keep the `size` smallest-distance rowids without sorting the whole table.
 *
 * A full sort of N scored rows is O(N log N) and would eat the win the coarse
 * pass just bought: at 50k vectors the sort costs more than the popcounts did.
 * This keeps a bounded max-heap of the best `size` instead, so the scan stays
 * O(N log size) with a tiny log.
 */
export class ShortlistHeap {
  /** Max-heap on distance: the worst kept candidate sits at index 0. */
  private readonly dist: number[] = [];
  private readonly rowid: number[] = [];

  constructor(private readonly size: number) {}

  get length(): number {
    return this.dist.length;
  }

  /** @returns true when the candidate was kept. */
  push(rowid: number, distance: number): boolean {
    if (this.dist.length < this.size) {
      this.dist.push(distance);
      this.rowid.push(rowid);
      this.siftUp(this.dist.length - 1);
      return true;
    }
    if (distance >= this.dist[0]) return false;
    this.dist[0] = distance;
    this.rowid[0] = rowid;
    this.siftDown(0);
    return true;
  }

  /** Kept rowids, nearest first. */
  drain(): number[] {
    const pairs = this.rowid.map((id, i) => ({ id, d: this.dist[i] }));
    pairs.sort((a, b) => a.d - b.d);
    return pairs.map(p => p.id);
  }

  private siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.dist[parent] >= this.dist[i]) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  private siftDown(i: number): void {
    const n = this.dist.length;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let largest = i;
      if (left < n && this.dist[left] > this.dist[largest]) largest = left;
      if (right < n && this.dist[right] > this.dist[largest]) largest = right;
      if (largest === i) return;
      this.swap(largest, i);
      i = largest;
    }
  }

  private swap(a: number, b: number): void {
    const d = this.dist[a]; this.dist[a] = this.dist[b]; this.dist[b] = d;
    const r = this.rowid[a]; this.rowid[a] = this.rowid[b]; this.rowid[b] = r;
  }
}
