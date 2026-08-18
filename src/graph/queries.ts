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
  },
): RelatedResult {
  const seedFile = normalizeFilePath(handle.projectDir, opts.filePath);
  const depth = Math.max(1, Math.min(opts.depth ?? 1, 3));
  const limit = clampLimit(opts.limit, 40, 400);
  const kinds = (opts.kinds ?? RELATED_KINDS) as readonly string[];

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

  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const batch of chunk(frontier, 400)) {
      const batchSet = new Set(batch);
      for (const row of edgeBatch(handle, batch, kinds)) {
        // Which endpoint was the one we asked about decides the direction.
        // A Set, not `includes`: at 400 ids × 20k edges the linear scan is the
        // whole cost of the walk.
        const isOut = batchSet.has(row.source);
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
    return { seedFile, seedNodes: seedIds.size, nodes: [], files: [], truncated: false };
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
  };
}

interface EdgeRow { source: string; target: string; kind: string }

function edgeBatch(
  handle: GraphDbHandle,
  ids: string[],
  kinds: readonly string[],
): EdgeRow[] {
  const idPh = placeholders(ids.length);
  const kindPh = placeholders(kinds.length);
  const sql =
    "SELECT source, target, kind FROM edges " +
    `WHERE kind IN (${kindPh}) AND (source IN (${idPh}) OR target IN (${idPh})) ` +
    "LIMIT 20000";
  try {
    return handle.db
      .prepare(sql)
      .all(...kinds, ...ids, ...ids) as EdgeRow[];
  } catch {
    return [];
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
