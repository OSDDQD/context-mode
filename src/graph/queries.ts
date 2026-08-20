/**
 * The six graph questions, answered in SQL against codegraph's own tables.
 *
 * Every function here takes a {@link GraphDbHandle} opened by `src/graph/db.ts`
 * and returns plain rows. No formatting, no MCP types, no I/O beyond the
 * read-only connection — the tool layer owns presentation and the ranking layer
 * (a later stage) consumes {@link related} as data.
 *
 * ## Why SQL and not `codegraph <subcommand>`
 *
 * `nodes.signature` and `nodes.docstring` are already populated by codegraph's
 * tree-sitter pass, so "map of a file" and "signatures only" are a `SELECT …
 * ORDER BY start_line`, not a re-parse. The graph walks are recursive CTEs over
 * `edges`, which is the same traversal the CLI performs, minus a process spawn
 * and minus the text round trip. What is NOT reproducible in SQL is `explore`
 * (it returns source bodies stitched to call paths) — that stays on the CLI,
 * see `src/tools/graph.ts`.
 *
 * ## Parameter binding
 *
 * Every value is bound, including the edge-kind lists, which are expanded to
 * `?` placeholders rather than interpolated. The kind sets are internal
 * constants today, but a bound parameter cannot become an injection when a
 * later caller makes them user-supplied.
 */

import { isAbsolute, relative, sep } from "node:path";

import type { GraphDbHandle } from "./db.js";

// ─────────────────────────────────────────────────────────
// Row shapes
// ─────────────────────────────────────────────────────────

export interface SymbolRow {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string | null;
  docstring: string | null;
}

export interface OutlineRow extends SymbolRow {
  isExported: boolean;
  isAsync: boolean;
}

/** One node reached by a graph walk, with the hop count that reached it. */
export interface WalkRow {
  id: string;
  kind: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  /** Hops from the seed. 1 = direct caller/callee. */
  depth: number;
}

// ─────────────────────────────────────────────────────────
// Edge-kind sets
// ─────────────────────────────────────────────────────────

/** Call graph proper. `references` is included: codegraph records a bare
 * identifier mention as `references`, and a caller that passes a function by
 * name is still a caller for impact purposes. */
export const CALL_KINDS = ["calls", "references"] as const;

/** Impact adds inheritance — changing a base class reaches every subclass. */
export const IMPACT_KINDS = ["calls", "references", "extends"] as const;

/** Default neighbourhood for `related`. */
export const RELATED_KINDS = ["imports", "calls"] as const;

/**
 * Per-edge contribution to a `related` score.
 *
 * A call is the strongest evidence two symbols belong to the same story; an
 * import is structural and slightly weaker; a bare reference is the weakest
 * signal that is still a signal. `contains` is near-zero because every symbol
 * in a file is "contained" by it — including it at full weight would rank the
 * seed file's own siblings above genuine collaborators.
 */
export const EDGE_WEIGHTS: Readonly<Record<string, number>> = {
  calls: 1.0,
  imports: 0.8,
  extends: 0.7,
  implements: 0.7,
  instantiates: 0.5,
  references: 0.4,
  contains: 0.1,
};

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function placeholders(n: number): string {
  return new Array(n).fill("?").join(", ");
}

/**
 * Turn free text into an FTS5 MATCH expression that cannot throw.
 *
 * User queries arrive with `::`, `()`, `-` and quotes in them; handing those to
 * FTS5 raw is a syntax error, and a syntax error here reads to the caller as
 * "codegraph is broken". Tokens are extracted, quoted, and prefix-matched, so
 * `store.index(` becomes `"store"* "index"*`.
 */
export function ftsQuery(raw: string): string | null {
  const tokens = String(raw ?? "")
    .split(/[^A-Za-z0-9_]+/)
    .filter(t => t.length > 0)
    .slice(0, 12);
  if (tokens.length === 0) return null;
  return tokens.map(t => `"${t.replace(/"/g, "")}"*`).join(" ");
}

/**
 * `files.path` and `nodes.file_path` are stored relative to the project root
 * with forward slashes. Callers hand us whatever they have.
 */
export function normalizeFilePath(projectDir: string, filePath: string): string {
  let p = String(filePath ?? "").trim();
  if (!p) return p;
  if (isAbsolute(p)) p = relative(projectDir, p);
  if (sep !== "/") p = p.split(sep).join("/");
  return p.replace(/^\.\//, "");
}

function mapSymbolRow(r: Record<string, unknown>): SymbolRow {
  return {
    id: String(r.id ?? ""),
    kind: String(r.kind ?? ""),
    name: String(r.name ?? ""),
    qualifiedName: String(r.qualified_name ?? ""),
    filePath: String(r.file_path ?? ""),
    startLine: Number(r.start_line ?? 0),
    endLine: Number(r.end_line ?? 0),
    signature: r.signature == null ? null : String(r.signature),
    docstring: r.docstring == null ? null : String(r.docstring),
  };
}

// ─────────────────────────────────────────────────────────
// symbols
// ─────────────────────────────────────────────────────────

/**
 * Full-text symbol search over `nodes_fts`.
 *
 * `nodes_fts` is an external-content table over `nodes`, so the join is on
 * `rowid`, not on the `id` column it also stores.
 */
export function symbols(
  handle: GraphDbHandle,
  opts: { query: string; limit?: number; kind?: string },
): SymbolRow[] {
  const match = ftsQuery(opts.query);
  if (!match) return [];
  const limit = clampLimit(opts.limit, 20, 200);

  const params: unknown[] = [match];
  let kindClause = "";
  if (opts.kind) {
    kindClause = " AND n.kind = ?";
    params.push(opts.kind);
  }
  params.push(limit);

  const sql =
    "SELECT n.id, n.kind, n.name, n.qualified_name, n.file_path, n.start_line, n.end_line, " +
    "n.signature, n.docstring " +
    "FROM nodes_fts f JOIN nodes n ON n.rowid = f.rowid " +
    `WHERE nodes_fts MATCH ?${kindClause} ` +
    "ORDER BY bm25(nodes_fts) LIMIT ?";

  try {
    const rows = handle.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(mapSymbolRow);
  } catch {
    // A malformed MATCH slipped through, or FTS5 is unavailable in this build.
    // Degrade to a LIKE scan rather than returning "search failed".
    return symbolsByName(handle, opts);
  }
}

/** Non-FTS fallback: prefix/substring match on `qualified_name`. */
export function symbolsByName(
  handle: GraphDbHandle,
  opts: { query: string; limit?: number; kind?: string },
): SymbolRow[] {
  const needle = `%${String(opts.query ?? "").replace(/[%_]/g, "")}%`;
  const limit = clampLimit(opts.limit, 20, 200);
  const params: unknown[] = [needle];
  let kindClause = "";
  if (opts.kind) {
    kindClause = " AND kind = ?";
    params.push(opts.kind);
  }
  params.push(limit);
  try {
    const rows = handle.db
      .prepare(
        "SELECT id, kind, name, qualified_name, file_path, start_line, end_line, signature, docstring " +
        `FROM nodes WHERE qualified_name LIKE ?${kindClause} ORDER BY length(qualified_name) LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map(mapSymbolRow);
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────
// outline
// ─────────────────────────────────────────────────────────

/**
 * Every symbol declared in one file, in source order.
 *
 * This is both the "file map" and the "signatures only" mode: the columns
 * needed for either are already in `nodes`, so the caller decides how much of
 * each row to render.
 */
export function outline(
  handle: GraphDbHandle,
  opts: { filePath: string; limit?: number; includeImports?: boolean },
): OutlineRow[] {
  const path = normalizeFilePath(handle.projectDir, opts.filePath);
  if (!path) return [];
  const limit = clampLimit(opts.limit, 400, 2_000);

  // `import` and `file` nodes are structural bookkeeping; they crowd out the
  // declarations an outline exists to show. Opt-in rather than default.
  const excluded = opts.includeImports ? [] : ["import", "file"];
  const where = excluded.length
    ? ` AND kind NOT IN (${placeholders(excluded.length)})`
    : "";

  try {
    const rows = handle.db
      .prepare(
        "SELECT id, kind, name, qualified_name, file_path, start_line, end_line, signature, docstring, " +
        "is_exported, is_async FROM nodes " +
        `WHERE file_path = ?${where} ORDER BY start_line LIMIT ?`,
      )
      .all(path, ...excluded, limit) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      ...mapSymbolRow(r),
      isExported: Number(r.is_exported ?? 0) === 1,
      isAsync: Number(r.is_async ?? 0) === 1,
    }));
  } catch {
    return [];
  }
}

/**
 * `files.indexed_at` for one path, or `null` when the file has no row.
 *
 * The distinction matters to `action: "body"`: a missing row means staleness is
 * unknowable, and "unknown" must not be rendered as "current" — a line range
 * quietly pointing at the wrong function is the one failure that looks exactly
 * like success.
 */
export function fileIndexedAt(handle: GraphDbHandle, filePath: string): number | null {
  const path = normalizeFilePath(handle.projectDir, filePath);
  if (!path) return null;
  try {
    const row = handle.db
      .prepare("SELECT indexed_at FROM files WHERE path = ?")
      .get(path) as { indexed_at?: number } | undefined;
    if (!row) return null;
    const n = Number(row.indexed_at ?? 0);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Distinct indexed file paths matching a fragment — for "did you mean". */
export function findFiles(handle: GraphDbHandle, fragment: string, limit = 10): string[] {
  const needle = `%${String(fragment ?? "").replace(/[%_]/g, "")}%`;
  try {
    const rows = handle.db
      .prepare("SELECT path FROM files WHERE path LIKE ? ORDER BY length(path) LIMIT ?")
      .all(needle, limit) as Array<{ path: string }>;
    return rows.map(r => String(r.path));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────
// Symbol resolution
// ─────────────────────────────────────────────────────────

export interface ResolvedSymbol {
  ids: string[];
  /** The rows behind `ids`, so the caller can say which node it walked. */
  matches: SymbolRow[];
  /** How the name was matched — surfaced so an ambiguous hit is visible. */
  via: "qualified" | "name" | "fts" | "none";
}

/**
 * Map a human-typed symbol to node ids.
 *
 * Exact `qualified_name` first, then exact `name`, then full text. Stopping at
 * the first tier that produces hits is what keeps `impact` on `save` from
 * walking forty unrelated `save`-ish symbols: if one qualified name matches
 * exactly, that is the answer.
 */
export function resolveSymbol(
  handle: GraphDbHandle,
  symbol: string,
  opts: { limit?: number; kind?: string } = {},
): ResolvedSymbol {
  const name = String(symbol ?? "").trim();
  if (!name) return { ids: [], matches: [], via: "none" };
  const limit = clampLimit(opts.limit, 10, 50);
  const cols =
    "id, kind, name, qualified_name, file_path, start_line, end_line, signature, docstring";

  const tiers: Array<{ sql: string; params: unknown[]; via: ResolvedSymbol["via"] }> = [
    {
      sql: `SELECT ${cols} FROM nodes WHERE qualified_name = ? LIMIT ?`,
      params: [name, limit],
      via: "qualified",
    },
    {
      sql: `SELECT ${cols} FROM nodes WHERE name = ? ORDER BY length(qualified_name) LIMIT ?`,
      params: [name, limit],
      via: "name",
    },
  ];

  for (const tier of tiers) {
    try {
      const rows = handle.db.prepare(tier.sql).all(...tier.params) as Array<Record<string, unknown>>;
      if (rows.length > 0) {
        const matches = rows.map(mapSymbolRow);
        return { ids: matches.map(m => m.id), matches, via: tier.via };
      }
    } catch { /* try the next tier */ }
  }

  const fts = symbols(handle, { query: name, limit, kind: opts.kind });
  if (fts.length > 0) return { ids: fts.map(m => m.id), matches: fts, via: "fts" };
  return { ids: [], matches: [], via: "none" };
}

// ─────────────────────────────────────────────────────────
// Graph walks
// ─────────────────────────────────────────────────────────

/**
 * Walk `edges` from a set of seed nodes and return everything reachable within
 * `depth` hops.
 *
 * `direction: "up"` follows edges backwards (who points at the seed → callers);
 * `"down"` follows them forwards (what the seed points at → callees).
 *
 * The CTE seeds from `SELECT id FROM nodes WHERE id IN (…)` rather than a temp
 * table on purpose: the connection is `query_only`, so it may not create even a
 * temp table, and a bound `IN` list keeps the whole statement parameterised.
 */
export function walk(
  handle: GraphDbHandle,
  opts: {
    roots: string[];
    direction: "up" | "down";
    depth?: number;
    kinds?: readonly string[];
    limit?: number;
  },
): WalkRow[] {
  const roots = (opts.roots ?? []).filter(Boolean).slice(0, 25);
  if (roots.length === 0) return [];
  // Depth is capped hard: `edges` is cyclic in every real codebase and the
  // recursive CTE materialises (node, depth) pairs, so an unbounded depth on a
  // 135k-edge graph is a memory event, not a slow query.
  const depth = Math.max(1, Math.min(opts.depth ?? 2, 5));
  const kinds = (opts.kinds ?? CALL_KINDS) as readonly string[];
  const limit = clampLimit(opts.limit, 100, 1_000);

  const step =
    opts.direction === "up"
      ? "SELECT e.source, w.depth + 1 FROM edges e JOIN w ON e.target = w.id"
      : "SELECT e.target, w.depth + 1 FROM edges e JOIN w ON e.source = w.id";

  const sql =
    "WITH RECURSIVE w(id, depth) AS (" +
    `SELECT id, 0 FROM nodes WHERE id IN (${placeholders(roots.length)}) ` +
    "UNION " +
    `${step} WHERE e.kind IN (${placeholders(kinds.length)}) AND w.depth < ?` +
    ") " +
    "SELECT n.id, n.kind, n.qualified_name, n.file_path, n.start_line, MIN(w.depth) AS depth " +
    "FROM w JOIN nodes n ON n.id = w.id " +
    "WHERE w.depth > 0 " +
    "GROUP BY n.id " +
    "ORDER BY depth, n.file_path, n.start_line LIMIT ?";

  const rootSet = new Set(roots);
  try {
    const rows = handle.db
      .prepare(sql)
      .all(...roots, ...kinds, depth, limit) as Array<Record<string, unknown>>;
    return rows
      // A cycle (a → b → a) brings the seed back at depth 2. It is true that
      // `a` transitively calls itself, and it is never the answer to "who
      // calls a" — so the seeds are dropped, not reported.
      .filter(r => !rootSet.has(String(r.id ?? "")))
      .map(r => ({
      id: String(r.id ?? ""),
      kind: String(r.kind ?? ""),
      qualifiedName: String(r.qualified_name ?? ""),
      filePath: String(r.file_path ?? ""),
      startLine: Number(r.start_line ?? 0),
      depth: Number(r.depth ?? 0),
    }));
  } catch {
    return [];
  }
}

/** Who calls (or references) this symbol, transitively. */
export function callers(
  handle: GraphDbHandle,
  opts: { roots: string[]; depth?: number; limit?: number },
): WalkRow[] {
  return walk(handle, { ...opts, direction: "up", kinds: CALL_KINDS });
}

/** What this symbol calls (or references), transitively. */
export function callees(
  handle: GraphDbHandle,
  opts: { roots: string[]; depth?: number; limit?: number },
): WalkRow[] {
  return walk(handle, { ...opts, direction: "down", kinds: CALL_KINDS });
}

/**
 * What breaks if this symbol changes: callers, referencers and subclasses.
 *
 * Same walk as {@link callers} with `extends` added and the direction still
 * upward — a subclass points at its base, so "who extends me" is an inbound
 * edge exactly as "who calls me" is.
 */
export function impact(
  handle: GraphDbHandle,
  opts: { roots: string[]; depth?: number; limit?: number },
): WalkRow[] {
  return walk(handle, { ...opts, direction: "up", kinds: IMPACT_KINDS });
}

// ─────────────────────────────────────────────────────────
// related
// ─────────────────────────────────────────────────────────

/**
 * One neighbour of the seed file, scored.
 *
 * This shape is the contract with the ranking layer, not a rendering detail:
 * `id` joins back to `nodes`, `weight` is comparable across calls on the same
 * project, and `distance` is the hop count so a consumer can re-decay with its
 * own curve instead of inheriting ours.
 */
export interface RelatedNode {
  id: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
  startLine: number;
  /** Hops from the seed file's own symbols. 1 = direct neighbour. */
  distance: number;
  /** Σ(edge weight) / distance, rounded to 4 places. Higher = more related. */
  weight: number;
  /** Distinct edges that produced this link. */
  edges: number;
  /** Edge kinds seen, sorted, e.g. `["calls", "imports"]`. */
  via: string[];
  /** `out` = seed points at it, `in` = it points at seed, `both` = mutual. */
  direction: "in" | "out" | "both";
}

/** The same signal aggregated per file, which is what a file ranker wants. */
export interface RelatedFile {
  filePath: string;
  weight: number;
  nodes: number;
  minDistance: number;
}

export interface RelatedResult {
  /** The normalised seed path actually queried. */
  seedFile: string;
  /** How many nodes the seed file contributed. 0 means "file not indexed". */
  seedNodes: number;
  nodes: RelatedNode[];
  files: RelatedFile[];
  /** True when the node list was cut at `limit`. */
  truncated: boolean;
  /**
   * True when the edge scan itself hit {@link EDGE_SCAN_CAP} — a different and
   * more serious cut than {@link truncated}: not "we showed you fewer of the
   * neighbours we found", but "we stopped looking". Optional so a caller that
   * builds a `RelatedResult` by hand (the ranking layer's fixtures) is not
   * forced to have an opinion about it.
   */
  edgesTruncated?: boolean;
}

/**
 * Neighbourhood of a file: what its symbols reach, and what reaches them.
 *
 * Returned as data rather than prose because this becomes a ranking signal —
 * "files the graph says are adjacent to the one you are editing" is exactly
 * the prior a lexical search cannot supply. The tool layer renders a summary;
 * the ranker consumes {@link RelatedResult.nodes} and
 * {@link RelatedResult.files} verbatim.
 *
 * BFS is done in JS over batched edge queries rather than as one recursive CTE
 * because the score needs the edge KIND at each hop, and a CTE that carries
 * kinds through the recursion loses the per-edge grouping the weights need.
 */
export function related(
  handle: GraphDbHandle,
  opts: {
    filePath: string;
    depth?: number;
    limit?: number;
    kinds?: readonly string[];
    /** Rows scanned per union arm per batch. Tests, and pathological graphs. */
    edgeScanCap?: number;
  },
): RelatedResult {
  const seedFile = normalizeFilePath(handle.projectDir, opts.filePath);
  const depth = Math.max(1, Math.min(opts.depth ?? 1, 3));
  const limit = clampLimit(opts.limit, 40, 400);
  const kinds = (opts.kinds ?? RELATED_KINDS) as readonly string[];
  const edgeScanCap = clampLimit(opts.edgeScanCap, EDGE_SCAN_CAP, EDGE_SCAN_CAP);

  const seedIds = new Set<string>();
  try {
    const rows = handle.db
      .prepare("SELECT id FROM nodes WHERE file_path = ? LIMIT 5000")
      .all(seedFile) as Array<{ id: string }>;
    for (const r of rows) seedIds.add(String(r.id));
  } catch { /* fall through to the empty result below */ }

  if (seedIds.size === 0) {
    return { seedFile, seedNodes: 0, nodes: [], files: [], truncated: false };
  }

  interface Acc {
    weight: number;
    edges: number;
    via: Set<string>;
    distance: number;
    out: boolean;
    in: boolean;
  }
  const acc = new Map<string, Acc>();
  const visited = new Set<string>(seedIds);
  let frontier = [...seedIds];
  let edgesTruncated = false;

  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const batch of chunk(frontier, 400)) {
      const scan = edgeBatch(handle, batch, kinds, edgeScanCap);
      if (scan.truncated) edgesTruncated = true;
      for (const row of scan.rows) {
        // The union arm that produced the row already knows which endpoint we
        // asked about, so the direction is read, not inferred.
        const isOut = row.direction === "out";
        const other = isOut ? row.target : row.source;
        if (!other || seedIds.has(other)) continue;
        const w = (EDGE_WEIGHTS[row.kind] ?? 0.3) / d;
        let entry = acc.get(other);
        if (!entry) {
          entry = { weight: 0, edges: 0, via: new Set(), distance: d, out: false, in: false };
          acc.set(other, entry);
        }
        entry.weight += w;
        entry.edges += 1;
        entry.via.add(row.kind);
        entry.distance = Math.min(entry.distance, d);
        if (isOut) entry.out = true; else entry.in = true;
        if (!visited.has(other)) {
          visited.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }

  if (acc.size === 0) {
    return { seedFile, seedNodes: seedIds.size, nodes: [], files: [], truncated: false, edgesTruncated };
  }

  const meta = nodeMeta(handle, [...acc.keys()]);
  const nodes: RelatedNode[] = [];
  for (const [id, entry] of acc) {
    const m = meta.get(id);
    if (!m) continue;
    nodes.push({
      id,
      qualifiedName: m.qualifiedName,
      kind: m.kind,
      filePath: m.filePath,
      startLine: m.startLine,
      distance: entry.distance,
      weight: Math.round(entry.weight * 10_000) / 10_000,
      edges: entry.edges,
      via: [...entry.via].sort(),
      direction: entry.out && entry.in ? "both" : entry.out ? "out" : "in",
    });
  }
  nodes.sort((a, b) => b.weight - a.weight || a.filePath.localeCompare(b.filePath));

  const byFile = new Map<string, RelatedFile>();
  for (const n of nodes) {
    if (!n.filePath || n.filePath === seedFile) continue;
    const f = byFile.get(n.filePath);
    if (f) {
      f.weight = Math.round((f.weight + n.weight) * 10_000) / 10_000;
      f.nodes += 1;
      f.minDistance = Math.min(f.minDistance, n.distance);
    } else {
      byFile.set(n.filePath, {
        filePath: n.filePath,
        weight: n.weight,
        nodes: 1,
        minDistance: n.distance,
      });
    }
  }
  const files = [...byFile.values()].sort((a, b) => b.weight - a.weight);

  return {
    seedFile,
    seedNodes: seedIds.size,
    nodes: nodes.slice(0, limit),
    files: files.slice(0, limit),
    truncated: nodes.length > limit,
    edgesTruncated,
  };
}

interface EdgeRow {
  source: string;
  target: string;
  kind: string;
  /** Which arm of the union produced the row: the seed was the `source`, or the `target`. */
  direction: "out" | "in";
}

/**
 * Rows scanned per union arm before the scan gives up.
 *
 * A cap is necessary — one frontier batch of 400 ids in a hub-shaped graph can
 * touch six figures of `references` edges — but a cap that is not reported is a
 * wrong answer wearing a right one's clothes, so {@link EdgeBatchResult}
 * carries the fact upward and `related` puts it in the response.
 */
export const EDGE_SCAN_CAP = 20_000;

interface EdgeBatchResult {
  rows: EdgeRow[];
  /** At least one arm hit {@link EDGE_SCAN_CAP}, so the neighbourhood is partial. */
  truncated: boolean;
}

/**
 * Every edge touching one frontier batch, as two index-friendly scans.
 *
 * The obvious spelling — `source IN (…) OR target IN (…)` — is the slow one:
 * SQLite cannot satisfy a disjunction of two different columns from one index
 * pass, so it degrades to a full scan of `edges` and the `LIMIT` then decides
 * which arbitrary 20 000 rows the answer is built from. Two separate scans,
 * each on a single column, each use their own index; `UNION ALL` (not `UNION`)
 * keeps them cheap, and per-arm limits inside subqueries mean one hub-heavy
 * direction cannot starve the other.
 *
 * The `direction` column is not bookkeeping for the union — it is the answer to
 * a question the caller could previously only guess at. Testing `batch.has(row.source)`
 * mislabels an edge whose two endpoints are BOTH in the frontier: such an edge
 * is genuinely outbound for one endpoint and inbound for the other, and the
 * union now yields it once per arm, correctly labelled each time.
 */
function edgeBatch(
  handle: GraphDbHandle,
  ids: string[],
  kinds: readonly string[],
  cap: number = EDGE_SCAN_CAP,
): EdgeBatchResult {
  const idPh = placeholders(ids.length);
  const kindPh = placeholders(kinds.length);
  // One row over the cap is fetched purely as evidence: if it comes back, the
  // arm had more to give and `truncated` is a fact rather than a suspicion.
  const probe = cap + 1;
  const arm = (column: "source" | "target", direction: "out" | "in"): string =>
    `SELECT * FROM (SELECT source, target, kind, '${direction}' AS direction FROM edges ` +
    `WHERE kind IN (${kindPh}) AND ${column} IN (${idPh}) LIMIT ${probe})`;
  const sql = `${arm("source", "out")} UNION ALL ${arm("target", "in")}`;

  try {
    const rows = handle.db
      .prepare(sql)
      .all(...kinds, ...ids, ...kinds, ...ids) as EdgeRow[];

    // One pass: count each arm, and drop only the probe row that proved the arm
    // was capped. The scores below are sums over edges, so keeping the probe
    // would make one edge count twice on a truncated batch.
    let out = 0;
    let inbound = 0;
    const kept: EdgeRow[] = [];
    for (const row of rows) {
      const seen = row.direction === "out" ? ++out : ++inbound;
      if (seen <= cap) kept.push(row);
    }
    return { rows: kept, truncated: out > cap || inbound > cap };
  } catch {
    return { rows: [], truncated: false };
  }
}

interface NodeMeta {
  qualifiedName: string;
  kind: string;
  filePath: string;
  startLine: number;
}

function nodeMeta(handle: GraphDbHandle, ids: string[]): Map<string, NodeMeta> {
  const out = new Map<string, NodeMeta>();
  for (const batch of chunk(ids, 400)) {
    try {
      const rows = handle.db
        .prepare(
          "SELECT id, kind, qualified_name, file_path, start_line FROM nodes " +
          `WHERE id IN (${placeholders(batch.length)})`,
        )
        .all(...batch) as Array<Record<string, unknown>>;
      for (const r of rows) {
        out.set(String(r.id), {
          qualifiedName: String(r.qualified_name ?? ""),
          kind: String(r.kind ?? ""),
          filePath: String(r.file_path ?? ""),
          startLine: Number(r.start_line ?? 0),
        });
      }
    } catch { /* skip this batch */ }
  }
  return out;
}

// ─────────────────────────────────────────────────────────
// Repo-map inputs
// ─────────────────────────────────────────────────────────

/** One declaration, as the repo map ranks it. */
export interface MapNodeRow {
  id: string;
  kind: string;
  name: string;
  filePath: string;
  startLine: number;
  signature: string | null;
  isExported: boolean;
}

/** One file→file link, already aggregated by SQLite. */
export interface FileEdgeRow {
  source: string;
  target: string;
  kind: string;
  count: number;
}

/** Rows the map scans before it stops. Two full-table reads, once per call. */
export const MAP_NODE_CAP = 60_000;
export const MAP_EDGE_CAP = 60_000;

export interface MapNodesResult {
  nodes: MapNodeRow[];
  /** Every node's file, INCLUDING the `import`/`file` rows dropped from `nodes`. */
  total: number;
  capped: boolean;
}

/**
 * Every declaration in the index, in one query.
 *
 * `import` and `file` rows are excluded here rather than in JS because they are
 * pure bookkeeping for a MAP: nobody wants "the most important symbol in
 * src/server.ts is the import of zod". They still contribute to the graph —
 * their edges are aggregated file-side by {@link fileEdges}, which joins
 * through `nodes` in SQL and therefore sees them.
 */
export function mapNodes(handle: GraphDbHandle, limit = MAP_NODE_CAP): MapNodesResult {
  const cap = clampLimit(limit, MAP_NODE_CAP, MAP_NODE_CAP);
  try {
    const rows = handle.db
      .prepare(
        "SELECT id, kind, name, file_path, start_line, signature, is_exported FROM nodes " +
        "WHERE kind NOT IN ('import', 'file') ORDER BY file_path, start_line LIMIT ?",
      )
      .all(cap + 1) as Array<Record<string, unknown>>;
    const capped = rows.length > cap;
    const kept = capped ? rows.slice(0, cap) : rows;
    return {
      nodes: kept.map(r => ({
        id: String(r.id ?? ""),
        kind: String(r.kind ?? ""),
        name: String(r.name ?? ""),
        filePath: String(r.file_path ?? ""),
        startLine: Number(r.start_line ?? 0),
        signature: r.signature == null ? null : String(r.signature),
        isExported: Number(r.is_exported ?? 0) === 1,
      })),
      total: kept.length,
      capped,
    };
  } catch {
    return { nodes: [], total: 0, capped: false };
  }
}

export interface FileEdgesResult {
  edges: FileEdgeRow[];
  capped: boolean;
}

/**
 * The file graph, aggregated in SQL rather than in JS.
 *
 * The naive version streams every row of `edges` into the process and groups
 * them there. On this repository that is hundreds of thousands of rows crossing
 * the driver boundary to produce a few thousand distinct file pairs — the work
 * is the same, the transfer is not. `GROUP BY` does it inside SQLite and hands
 * back only the pairs, which is why the map costs three queries total and never
 * one per file.
 *
 * `contains` is excluded: every symbol is contained by its own file, so those
 * edges are self-loops that carry no ranking signal at file granularity.
 */
export function fileEdges(handle: GraphDbHandle, limit = MAP_EDGE_CAP): FileEdgesResult {
  const cap = clampLimit(limit, MAP_EDGE_CAP, MAP_EDGE_CAP);
  try {
    const rows = handle.db
      .prepare(
        "SELECT ns.file_path AS src, nt.file_path AS dst, e.kind AS kind, COUNT(*) AS n " +
        "FROM edges e " +
        "JOIN nodes ns ON ns.id = e.source " +
        "JOIN nodes nt ON nt.id = e.target " +
        "WHERE e.kind <> 'contains' AND ns.file_path <> nt.file_path " +
        "GROUP BY src, dst, e.kind ORDER BY src, dst, e.kind LIMIT ?",
      )
      .all(cap + 1) as Array<Record<string, unknown>>;
    const capped = rows.length > cap;
    const kept = capped ? rows.slice(0, cap) : rows;
    return {
      edges: kept.map(r => ({
        source: String(r.src ?? ""),
        target: String(r.dst ?? ""),
        kind: String(r.kind ?? ""),
        count: Number(r.n ?? 0),
      })),
      capped,
    };
  } catch {
    return { edges: [], capped: false };
  }
}

/**
 * How many edges point AT each node, aggregated in SQL.
 *
 * This is the within-file importance signal: of the forty functions in a file,
 * the ones the rest of the repository actually calls are the ones a map should
 * spend its budget on.
 */
export function inboundEdgeCounts(handle: GraphDbHandle, limit = MAP_NODE_CAP): Map<string, number> {
  const cap = clampLimit(limit, MAP_NODE_CAP, MAP_NODE_CAP);
  const out = new Map<string, number>();
  try {
    const rows = handle.db
      .prepare(
        "SELECT target AS id, COUNT(*) AS n FROM edges WHERE kind <> 'contains' " +
        "GROUP BY target ORDER BY n DESC LIMIT ?",
      )
      .all(cap) as Array<Record<string, unknown>>;
    for (const r of rows) out.set(String(r.id ?? ""), Number(r.n ?? 0));
  } catch { /* an unranked map is still a map */ }
  return out;
}

// ─────────────────────────────────────────────────────────
// Small utilities
// ─────────────────────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/** Counts for the response header — cheap, and it tells the caller the index is real. */
export function graphStats(handle: GraphDbHandle): { nodes: number; edges: number; files: number } {
  const one = (sql: string): number => {
    try {
      const row = handle.db.prepare(sql).get() as { c?: number } | undefined;
      return Number(row?.c ?? 0);
    } catch {
      return 0;
    }
  };
  return {
    nodes: one("SELECT COUNT(*) AS c FROM nodes"),
    edges: one("SELECT COUNT(*) AS c FROM edges"),
    files: one("SELECT COUNT(*) AS c FROM files"),
  };
}
