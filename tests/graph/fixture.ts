/**
 * A synthetic codegraph index.
 *
 * Faithful to codegraph 1.5.0 where it matters to the queries under test: the
 * `nodes`/`edges` columns, the external-content `nodes_fts` table with its
 * AFTER INSERT trigger (without which every FTS query returns nothing), and
 * the `project_metadata`/`schema_versions` rows that `openGraphDb` gates on.
 *
 * Not a `.test.ts` file — vitest's `include` is `tests/**\/*.test.ts`, so this
 * is a helper, not a suite.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadDatabase } from "../../src/db-base.js";

export interface FixtureNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine?: number;
  signature?: string | null;
  docstring?: string | null;
  isExported?: boolean;
  isAsync?: boolean;
}

export interface FixtureEdge {
  source: string;
  target: string;
  kind: string;
}

export interface FixtureOptions {
  nodes?: FixtureNode[];
  edges?: FixtureEdge[];
  /** `project_metadata` rows. Defaults to `index_state = complete`. */
  metadata?: Record<string, string>;
  /** Highest `schema_versions.version`. Defaults to 8 (codegraph 1.5.0). */
  schemaVersion?: number;
  /** `files` rows: path → indexed_at (epoch ms). */
  files?: Record<string, number>;
  /** Skip the `nodes_fts` table entirely, to exercise the LIKE fallback. */
  withoutFts?: boolean;
}

export interface Fixture {
  projectDir: string;
  dbPath: string;
}

const SCHEMA = `
CREATE TABLE schema_versions (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  description TEXT
);
CREATE TABLE project_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  language TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  start_column INTEGER NOT NULL,
  end_column INTEGER NOT NULL,
  docstring TEXT,
  signature TEXT,
  visibility TEXT,
  is_exported INTEGER DEFAULT 0,
  is_async INTEGER DEFAULT 0,
  is_static INTEGER DEFAULT 0,
  is_abstract INTEGER DEFAULT 0,
  decorators TEXT,
  type_parameters TEXT,
  return_type TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  kind TEXT NOT NULL,
  metadata TEXT,
  line INTEGER,
  col INTEGER,
  provenance TEXT DEFAULT NULL
);
CREATE TABLE files (
  path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  language TEXT NOT NULL,
  size INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  node_count INTEGER DEFAULT 0,
  errors TEXT
);
`;

const FTS = `
CREATE VIRTUAL TABLE nodes_fts USING fts5(
  id, name, qualified_name, docstring, signature,
  content='nodes', content_rowid='rowid'
);
CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature)
  VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature);
END;
`;

/** Build a temp project directory containing `.codegraph/codegraph.db`. */
export function makeGraphFixture(opts: FixtureOptions = {}): Fixture {
  const projectDir = mkdtempSync(join(tmpdir(), "ctx-graph-"));
  const graphDir = join(projectDir, ".codegraph");
  mkdirSync(graphDir, { recursive: true });
  const dbPath = join(graphDir, "codegraph.db");

  const Database = loadDatabase();
  const db = new Database(dbPath);
  try {
    db.exec(SCHEMA);
    if (!opts.withoutFts) db.exec(FTS);

    const now = Date.now();
    db.prepare("INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)")
      .run(opts.schemaVersion ?? 8, now, "fixture");

    const metadata = opts.metadata ?? { index_state: "complete" };
    const metaStmt = db.prepare(
      "INSERT INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?)",
    );
    for (const [k, v] of Object.entries(metadata)) metaStmt.run(k, v, now);

    const nodeStmt = db.prepare(
      "INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, " +
      "start_column, end_column, docstring, signature, visibility, is_exported, is_async, is_static, " +
      "is_abstract, decorators, type_parameters, return_type, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, 'typescript', ?, ?, 0, 0, ?, ?, 'public', ?, ?, 0, 0, NULL, NULL, NULL, ?)",
    );
    for (const n of opts.nodes ?? []) {
      nodeStmt.run(
        n.id, n.kind, n.name, n.qualifiedName, n.filePath,
        n.startLine, n.endLine ?? n.startLine + 5,
        n.docstring ?? null, n.signature ?? null,
        n.isExported ? 1 : 0, n.isAsync ? 1 : 0, now,
      );
    }

    const edgeStmt = db.prepare("INSERT INTO edges (source, target, kind) VALUES (?, ?, ?)");
    for (const e of opts.edges ?? []) edgeStmt.run(e.source, e.target, e.kind);

    const fileStmt = db.prepare(
      "INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count) " +
      "VALUES (?, 'hash', 'typescript', 100, ?, ?, 1)",
    );
    for (const [path, indexedAt] of Object.entries(opts.files ?? {})) {
      fileStmt.run(path, indexedAt, indexedAt);
    }
  } finally {
    db.close();
  }

  return { projectDir, dbPath };
}

/** Materialise a real file inside the fixture project, for freshness tests. */
export function writeProjectFile(projectDir: string, relPath: string, content = "x"): string {
  const abs = join(projectDir, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
  return abs;
}

/** A small but non-trivial graph: two files, a call chain and an import. */
export function defaultFixture(): Fixture {
  return makeGraphFixture({
    nodes: [
      {
        id: "function:handler", kind: "function", name: "handleRequest",
        qualifiedName: "src/server.ts::handleRequest", filePath: "src/server.ts",
        startLine: 10, signature: "function handleRequest(req: Request): Response",
        docstring: "Entry point for every HTTP request.", isExported: true,
      },
      {
        id: "function:validate", kind: "function", name: "validateInput",
        qualifiedName: "src/validate.ts::validateInput", filePath: "src/validate.ts",
        startLine: 4, signature: "function validateInput(raw: unknown): Input",
      },
      {
        id: "function:parse", kind: "function", name: "parseBody",
        qualifiedName: "src/validate.ts::parseBody", filePath: "src/validate.ts",
        startLine: 20, signature: "function parseBody(raw: string): unknown", isAsync: true,
      },
      {
        id: "class:Base", kind: "class", name: "Base",
        qualifiedName: "src/base.ts::Base", filePath: "src/base.ts", startLine: 1,
      },
      {
        id: "class:Derived", kind: "class", name: "Derived",
        qualifiedName: "src/derived.ts::Derived", filePath: "src/derived.ts", startLine: 1,
      },
      {
        id: "import:zod", kind: "import", name: "zod",
        qualifiedName: "src/server.ts::zod", filePath: "src/server.ts", startLine: 1,
      },
    ],
    edges: [
      { source: "function:handler", target: "function:validate", kind: "calls" },
      { source: "function:validate", target: "function:parse", kind: "calls" },
      { source: "class:Derived", target: "class:Base", kind: "extends" },
      { source: "function:handler", target: "class:Base", kind: "references" },
      { source: "import:zod", target: "function:validate", kind: "imports" },
    ],
    files: { "src/server.ts": Date.now(), "src/validate.ts": Date.now() },
  });
}
