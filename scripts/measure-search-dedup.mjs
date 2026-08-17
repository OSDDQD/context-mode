#!/usr/bin/env node
/**
 * Measure what cross-query deduplication actually saves.
 *
 * A multi-query search answers every query independently, so a chunk that is a
 * good answer to several of them is rendered several times. This harness runs
 * the real `formatBatchQueryResults` over a real knowledge base twice — dedup
 * off (CONTEXT_MODE_SEARCH_DEDUP=0), dedup on — and reports the byte delta.
 *
 * Queries are the section headers of each batch source's own output, which is
 * the shape a real `ctx_batch_execute` call asks: several related questions
 * about one captured blob, each ranked independently.
 *
 * The live DB is copied to a temp directory first; nothing here writes to the
 * knowledge base it measures.
 *
 * Usage:
 *   node scripts/measure-search-dedup.mjs [--db <path>] [--sources N] [--queries N] [--json]
 *
 * Requires a build: `npm run build`.
 */

import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const asJson = process.argv.includes("--json");
const MAX_SOURCES = Number(arg("sources", 5));
const MAX_QUERIES = Number(arg("queries", 8));

/** Every content DB the plugin keeps, largest first. */
function candidateDbs() {
  const out = [];
  for (const dir of [
    join(homedir(), ".claude", "context-mode", "content"),
    join(homedir(), ".context-mode", "content"),
  ]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".db")) continue;
      const p = join(dir, f);
      out.push({ path: p, size: statSync(p).size });
    }
  }
  return out.sort((a, b) => b.size - a.size).map(d => d.path);
}

let ContentStore, formatBatchQueryResults, Database;
try {
  ({ ContentStore } = await import("../build/store.js"));
  ({ formatBatchQueryResults } = await import("../build/server.js"));
  Database = require("better-sqlite3");
} catch (err) {
  console.error(`Cannot load build/: ${err.message}\nRun \`npm run build\` first.`);
  process.exit(1);
}

/** Batch sources of one DB with the section headers that will act as queries. */
function readPlan(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    // Alias is `n`, not `chunks`: `chunks` is a table name in this schema.
    const sources = db.prepare(`
      SELECT s.label AS label, COUNT(*) AS n
      FROM chunks ch JOIN sources s ON s.id = ch.source_id
      WHERE s.label LIKE 'batch:%'
      GROUP BY s.label HAVING n >= 3
      ORDER BY n DESC LIMIT ?
    `).all(MAX_SOURCES);
    const titleStmt = db.prepare(`
      SELECT DISTINCT ch.title AS title
      FROM chunks ch JOIN sources s ON s.id = ch.source_id
      WHERE s.label = ? LIMIT 200
    `);
    return sources.map(s => ({
      label: s.label,
      chunks: s.n,
      queries: titleStmt.all(s.label)
        .map(r => r.title)
        .filter(t => t && !/^Untitled/.test(t))
        .slice(0, MAX_QUERIES),
    })).filter(s => s.queries.length >= 2);
  } finally {
    db.close();
  }
}

const explicit = arg("db", null);
const candidates = explicit ? [explicit] : candidateDbs();
let chosen = null;
for (const path of candidates) {
  if (!existsSync(path)) continue;
  try {
    const plan = readPlan(path);
    if (plan.length > 0) { chosen = { path, plan }; break; }
  } catch { /* unreadable or older schema — try the next */ }
}
if (!chosen) {
  console.error("No content DB with usable batch: sources found. Pass --db <path>.");
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "ctx-dedup-measure-"));
const dbCopy = join(work, "content.db");
copyFileSync(chosen.path, dbCopy);

/** Render every query of one source and total the bytes handed to the model. */
async function render(store, source, queries) {
  const lines = await formatBatchQueryResults(store, queries, source);
  const text = lines.join("\n");
  return { bytes: Buffer.byteLength(text, "utf8"), text };
}

try {
  const store = new ContentStore(dbCopy);
  const rows = [];
  for (const src of chosen.plan) {
    process.env.CONTEXT_MODE_SEARCH_DEDUP = "0";
    const before = await render(store, src.label, src.queries);
    delete process.env.CONTEXT_MODE_SEARCH_DEDUP;
    const after = await render(store, src.label, src.queries);

    rows.push({
      source: src.label,
      chunks: src.chunks,
      queries: src.queries.length,
      bytesBefore: before.bytes,
      bytesAfter: after.bytes,
      suppressed: (after.text.match(/not repeated\)/g) ?? []).length,
      further: (after.text.match(/— further match/g) ?? []).length,
      savedPct: before.bytes ? ((before.bytes - after.bytes) / before.bytes) * 100 : 0,
    });
  }
  store.close();

  const totalBefore = rows.reduce((n, r) => n + r.bytesBefore, 0);
  const totalAfter = rows.reduce((n, r) => n + r.bytesAfter, 0);
  const summary = {
    db: chosen.path,
    sources: rows.length,
    bytesBefore: totalBefore,
    bytesAfter: totalAfter,
    suppressed: rows.reduce((n, r) => n + r.suppressed, 0),
    further: rows.reduce((n, r) => n + r.further, 0),
    savedPct: totalBefore ? ((totalBefore - totalAfter) / totalBefore) * 100 : 0,
    rows,
  };

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`DB: ${chosen.path}\n`);
    console.log("| source | chunks | queries | bytes before | bytes after | suppressed | further | saved |");
    console.log("|---|---|---|---|---|---|---|---|");
    for (const r of rows) {
      console.log(
        `| \`${r.source.slice(0, 46)}\` | ${r.chunks} | ${r.queries} | ${r.bytesBefore} | ` +
        `${r.bytesAfter} | ${r.suppressed} | ${r.further} | ${r.savedPct.toFixed(1)}% |`,
      );
    }
    console.log(
      `\nTOTAL: ${totalBefore} → ${totalAfter} bytes, ` +
      `${summary.suppressed} section(s) suppressed, ${summary.further} further-match render(s), ` +
      `savedPct ${summary.savedPct.toFixed(1)}%`,
    );
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
