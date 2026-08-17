#!/usr/bin/env node
/**
 * What the content-hash index cache saves (ADR-0007).
 *
 * Indexes a set of real source files into a throwaway store, then indexes the
 * same unchanged files again — once with the cache on, once with it off — and
 * reports per-file cost for each. The baseline to beat is the ~12.5 ms/file
 * that the bootstrap pass budgets for.
 *
 * Also reports orphaned vectors, since that is the larger cost: `chunk_vectors`
 * is keyed on `chunks.rowid`, and re-indexing an unchanged file used to throw
 * its embeddings away.
 *
 * Usage:
 *   node scripts/measure-index-skip.mjs [--dir <path>] [--files N] [--json]
 *
 * Requires a build: `npm run build`.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const asJson = process.argv.includes("--json");
const repo = resolve(arg("dir", process.cwd()));
const maxFiles = Number(arg("files", 120));

let ContentStore, ensureVectorTable, pruneOrphanVectors;
try {
  ({ ContentStore } = await import("../build/store.js"));
  ({ ensureVectorTable, pruneOrphanVectors } = await import("../build/search/hybrid.js"));
} catch (err) {
  console.error(`Cannot load build/: ${err.message}\nRun \`npm run build\` first.`);
  process.exit(1);
}

/** Tracked source files, largest first — the ones indexing actually costs on. */
function trackedFiles() {
  const out = execFileSync("git", ["-C", repo, "ls-files"], { encoding: "utf-8" });
  return out.split("\n")
    .map(f => f.trim())
    .filter(f => /\.(ts|tsx|js|mjs|cjs|py|go|rs|md)$/.test(f))
    .map(f => join(repo, f))
    .filter(f => { try { return statSync(f).size < 512 * 1024; } catch { return false; } })
    .slice(0, maxFiles);
}

const files = trackedFiles();
if (files.length === 0) {
  console.error(`No tracked source files under ${repo}.`);
  process.exit(1);
}

/** Index every file once and return the wall-clock cost. */
function indexAll(store) {
  const started = process.hrtime.bigint();
  let skipped = 0;
  for (const path of files) {
    try {
      const r = store.index({ path, source: `code:${path}` });
      if (r.skipped) skipped++;
    } catch { /* unreadable file — not what this measures */ }
  }
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, skipped };
}

const work = mkdtempSync(join(tmpdir(), "ctx-index-skip-"));
try {
  const store = new ContentStore(join(work, "content.db"));

  const cold = indexAll(store);

  // Give every chunk a vector so the orphan count means something.
  const db = store.rawDb();
  ensureVectorTable(db);
  const rows = db.prepare("SELECT rowid FROM chunks").all();
  const ins = db.prepare("INSERT OR REPLACE INTO chunk_vectors (chunk_rowid, model, dim, vec) VALUES (?, 'measure', 4, ?)");
  for (const r of rows) ins.run(r.rowid, Buffer.from([1, 2, 3, 4]));

  delete process.env.CONTEXT_MODE_INDEX_HASH_SKIP;
  const warmCached = indexAll(store);
  const orphansAfterCached = pruneOrphanVectors(db);

  // Re-vector, then repeat with the cache off for the comparison arm.
  for (const r of db.prepare("SELECT rowid FROM chunks").all()) ins.run(r.rowid, Buffer.from([1, 2, 3, 4]));
  process.env.CONTEXT_MODE_INDEX_HASH_SKIP = "0";
  const warmRewrite = indexAll(store);
  const orphansAfterRewrite = pruneOrphanVectors(db);
  delete process.env.CONTEXT_MODE_INDEX_HASH_SKIP;

  store.close();

  const per = (r) => r.ms / files.length;
  const summary = {
    repo,
    files: files.length,
    chunks: rows.length,
    coldMsPerFile: per(cold),
    cachedMsPerFile: per(warmCached),
    rewriteMsPerFile: per(warmRewrite),
    cachedSkipped: warmCached.skipped,
    speedup: warmRewrite.ms / Math.max(1, warmCached.ms),
    orphanedVectorsCached: orphansAfterCached,
    orphanedVectorsRewrite: orphansAfterRewrite,
  };

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`repo: ${repo}`);
    console.log(`files: ${summary.files}, chunks: ${summary.chunks}\n`);
    console.log("| pass | ms/file | skipped | orphaned vectors |");
    console.log("|---|---|---|---|");
    console.log(`| first index (cold) | ${summary.coldMsPerFile.toFixed(2)} | 0 | — |`);
    console.log(`| re-index, cache on | ${summary.cachedMsPerFile.toFixed(2)} | ${summary.cachedSkipped} | ${summary.orphanedVectorsCached} |`);
    console.log(`| re-index, cache off | ${summary.rewriteMsPerFile.toFixed(2)} | 0 | ${summary.orphanedVectorsRewrite} |`);
    console.log(`\nspeedup on unchanged files: ${summary.speedup.toFixed(1)}x`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
