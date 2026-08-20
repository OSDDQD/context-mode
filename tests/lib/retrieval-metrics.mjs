// Ranking metrics for the retrieval corpus, shared by the gate in
// tests/core/search.test.ts and the ranking assertions in tests/core/find.test.ts.
//
// One implementation on purpose: two copies of "what precision@1 means" would
// let those drift apart silently — which is exactly the failure a baseline gate
// exists to catch.
//
// A run is scored from rows of `{ cls, relevant, sources }`, where `sources` is
// the ranked list of source labels the search returned.

export const DEFAULT_LIMIT = 5;

/** Rank (1-based) of the first relevant source, or 0 when none is present. */
export function firstRelevantRank(sources, relevant) {
  for (let i = 0; i < sources.length; i++) if (relevant.includes(sources[i])) return i + 1;
  return 0;
}

/**
 * Macro-averaged precision@1, recall@k and MRR@k over the rows.
 *
 * Averaged per query rather than per relevant document, so a query with three
 * relevant sources does not outweigh three queries with one each.
 */
export function score(rows, limit = DEFAULT_LIMIT) {
  const n = rows.length;
  if (n === 0) return { queries: 0, precisionAt1: 0, recallAt5: 0, mrr: 0 };
  let p1 = 0, recall = 0, mrr = 0;
  for (const { sources, relevant } of rows) {
    if (relevant.includes(sources[0])) p1++;
    const top = sources.slice(0, limit);
    recall += relevant.filter((s) => top.includes(s)).length / relevant.length;
    const rank = firstRelevantRank(top, relevant);
    if (rank > 0) mrr += 1 / rank;
  }
  // Rounded to three places so a recorded baseline is comparable to a fresh
  // run without floating-point noise deciding the outcome.
  const round = (x) => Math.round((x / n) * 1000) / 1000;
  return { queries: n, precisionAt1: round(p1), recallAt5: round(recall), mrr: round(mrr) };
}

/** The same metrics, split by the `cls` label each query carries. */
export function byClass(rows, limit = DEFAULT_LIMIT) {
  const out = {};
  for (const cls of [...new Set(rows.map((r) => r.cls))].sort()) {
    out[cls] = score(rows.filter((r) => r.cls === cls), limit);
  }
  return out;
}

/** Queries for which nothing relevant came back within `limit`. */
export function misses(rows, limit = DEFAULT_LIMIT) {
  return rows.filter((r) => firstRelevantRank(r.sources.slice(0, limit), r.relevant) === 0).map((r) => r.id);
}
