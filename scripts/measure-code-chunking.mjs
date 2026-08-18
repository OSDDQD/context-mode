#!/usr/bin/env node
/**
 * How often does a stored code chunk start where a declaration starts?
 *
 * The chunker used to be told nothing about code: every source file went
 * through `#chunkMarkdown`, which looks for `#` headings and blank-line
 * paragraphs. On a `.ts` file that means the cut lands wherever the byte cap
 * happens to fall — usually the middle of a function. Two things pay for it:
 * BM25, because a chunk's title is its first line, and embeddings, because
 * half a function embeds as half a thought.
 *
 * This script measures the damage and the repair on one fixed corpus of real
 * source files from this repository, indexed through the real `ContentStore`
 * into a throwaway database. `--flat` forces the old behaviour via
 * CONTEXT_MODE_CODE_CHUNKING=0, so before/after come from the same code and
 * the same files.
 *
 * Corpus (fully determined by the tree, no hand-picked list):
 *   `git ls-files` → paths under src/, scripts/, tests/, hooks/ with a code
 *   extension → 2 KB ≤ size ≤ 200 KB → drop generated bundles and anything
 *   minified → sorted by path → an even spread of CORPUS_FILES entries across
 *   that sorted list. The spread matters: a plain `slice(0, n)` of a sorted
 *   list is all `hooks/` and `scripts/`, and the sample has to see the
 *   class-heavy `src/` and the test suites too.
 *
 * The alignment test itself lives in scripts/lib/code-chunk-boundary.mjs and
 * scores both arms identically.
 *
 * Usage:
 *   node scripts/measure-code-chunking.mjs [--flat] [--json] [--by-file]
 *
 * Requires a build: `npx tsc`.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { alignmentRatio } from "./lib/code-chunk-boundary.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");

const asJson = process.argv.includes("--json");
const byFile = process.argv.includes("--by-file");
const flat = process.argv.includes("--flat");

if (flat) process.env.CONTEXT_MODE_CODE_CHUNKING = "0";

/** Extensions sampled. Kept to what this repository actually contains. */
const CORPUS_EXTENSIONS = new Set([".ts", ".mjs", ".cjs", ".js", ".sh"]);
const CORPUS_ROOTS = ["src/", "scripts/", "tests/", "hooks/"];
const CORPUS_MIN_BYTES = 2_048;
const CORPUS_MAX_BYTES = 200_000;
/** Tuned so the sample lands near the 400 chunks the plan measured. */
const CORPUS_FILES = 120;
/** Generated output is not source; a bundle would score whatever esbuild felt like. */
const GENERATED = /\.bundle\.(m?js)$|(^|\/)(build|dist|vendor)\//;
/** No line this long occurs in hand-written code — the file is minified. */
const MINIFIED_LINE_CHARS = 2_000;

let ContentStore;
try {
  ({ ContentStore } = await import("../build/store.js"));
} catch (err) {
  console.error(`Cannot load build/: ${err.message}\nRun \`npx tsc\` first.`);
  process.exit(1);
}

function corpusFiles() {
  const tracked = execFileSync("git", ["ls-files"], { cwd: repo, encoding: "utf-8" })
    .split("\n")
    .filter(Boolean);

  const eligible = tracked
    .filter((p) => CORPUS_ROOTS.some((root) => p.startsWith(root)))
    .filter((p) => CORPUS_EXTENSIONS.has(extname(p).toLowerCase()))
    .filter((p) => !GENERATED.test(p))
    .filter((p) => {
      try {
        const abs = join(repo, p);
        const size = statSync(abs).size;
        if (size < CORPUS_MIN_BYTES || size > CORPUS_MAX_BYTES) return false;
        const text = readFileSync(abs, "utf-8");
        return !text.split("\n").some((l) => l.length > MINIFIED_LINE_CHARS);
      } catch {
        return false;
      }
    })
    .sort();

  if (eligible.length <= CORPUS_FILES) return eligible;
  // Even spread across the sorted list — deterministic, and it reaches every
  // root instead of stopping inside the first one.
  const picked = [];
  for (let i = 0; i < CORPUS_FILES; i++) {
    picked.push(eligible[Math.round((i * (eligible.length - 1)) / (CORPUS_FILES - 1))]);
  }
  return [...new Set(picked)];
}

function chunksFor(store, relPath) {
  const abs = join(repo, relPath);
  const { sourceId } = store.index({ path: abs, source: relPath });
  return store.getChunksBySource(sourceId).map((c) => ({ title: c.title, content: c.content }));
}

const files = corpusFiles();
const dbDir = mkdtempSync(join(tmpdir(), "context-mode-chunkmeasure-"));
const store = new ContentStore(join(dbDir, "measure.db"));

const perFile = [];
const all = [];
try {
  for (const rel of files) {
    const chunks = chunksFor(store, rel);
    all.push(...chunks);
    perFile.push({ file: rel, ...alignmentRatio(chunks) });
  }
} finally {
  store.close();
  rmSync(dbDir, { recursive: true, force: true });
}

const overall = alignmentRatio(all);
const byExtension = {};
for (const entry of perFile) {
  const ext = extname(entry.file).toLowerCase();
  byExtension[ext] ??= { total: 0, aligned: 0, strict: 0 };
  byExtension[ext].total += entry.total;
  byExtension[ext].aligned += entry.aligned;
  byExtension[ext].strict += entry.strict;
}
for (const stat of Object.values(byExtension)) {
  stat.ratio = stat.total === 0 ? 0 : stat.aligned / stat.total;
  stat.strictRatio = stat.total === 0 ? 0 : stat.strict / stat.total;
}

const sizes = all.map((c) => Buffer.byteLength(c.content)).sort((a, b) => a - b);
const median = sizes.length === 0 ? 0 : sizes[Math.floor(sizes.length / 2)];
const report = {
  mode: flat ? "flat (CONTEXT_MODE_CODE_CHUNKING=0)" : "code-aware",
  files: files.length,
  chunks: overall.total,
  aligned: overall.aligned,
  ratio: Number(overall.ratio.toFixed(4)),
  strict: overall.strict,
  strictRatio: Number(overall.strictRatio.toFixed(4)),
  untitledChunks: all.filter((c) => /^Untitled(\s|$)/.test(c.title)).length,
  medianChunkBytes: median,
  maxChunkBytes: sizes.length === 0 ? 0 : sizes[sizes.length - 1],
  byExtension,
};

if (asJson) {
  console.log(JSON.stringify(byFile ? { ...report, perFile } : report, null, 2));
} else {
  console.log(`mode:            ${report.mode}`);
  console.log(`files:           ${report.files}`);
  console.log(`chunks:          ${report.chunks}`);
  console.log(`starts at decl:  ${report.aligned} (${(report.ratio * 100).toFixed(1)}%)`);
  console.log(`  strict reading: ${report.strict} (${(report.strictRatio * 100).toFixed(1)}%)`);
  console.log(`"Untitled" chunks: ${report.untitledChunks}`);
  console.log(`chunk bytes:     median ${report.medianChunkBytes}, max ${report.maxChunkBytes}`);
  console.log("by extension:");
  for (const [ext, stat] of Object.entries(byExtension).sort()) {
    console.log(
      `  ${ext.padEnd(6)} ${String(stat.aligned).padStart(4)}/${String(stat.total).padEnd(4)} ` +
      `${(stat.ratio * 100).toFixed(1).padStart(5)}%  (strict ${(stat.strictRatio * 100).toFixed(1)}%)`,
    );
  }
  if (byFile) {
    console.log("by file:");
    for (const entry of perFile) {
      console.log(`  ${(entry.ratio * 100).toFixed(0).padStart(3)}%  ${String(entry.aligned)}/${entry.total}  ${entry.file}`);
    }
  }
}
