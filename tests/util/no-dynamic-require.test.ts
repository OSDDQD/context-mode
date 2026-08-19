/**
 * Anti-regression guard for issue #511: "Dynamic require of \"node:fs\" is not supported".
 *
 * Background: package.json declares "type": "module", and esbuild bundles
 * src/cli.ts and src/server.ts as ESM. Any inline `require("node:...")` in
 * the call graph is rewritten by esbuild to a `__require` shim that throws
 * `Dynamic require of "node:..." is not supported` at runtime under both
 * Node ESM and Bun.
 *
 * The fix pattern is `createRequire(import.meta.url)` (see src/server.ts:4,
 * src/db-base.ts:11, src/util/claude-config.ts:26 for the established
 * pattern). PR #513 already fixed src/util/project-dir.ts; this suite covers
 * the remaining sites.
 *
 * Tests assert the SOURCE pattern (cheap, deterministic, runs without
 * rebuilding bundles). Bundle integrity itself is enforced by the build
 * pipeline (`npm run build` regenerates bundles before `npm test` runs via
 * the `pretest` script).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");

function readSrc(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf-8");
}

/**
 * Every TypeScript source under src/, found rather than listed.
 *
 * This used to be two hand-picked files, and one of them was
 * `src/adapters/qwen-code/index.ts`. When that adapter was deleted with its
 * platform the test did not report a shrinking guard — it reported ENOENT,
 * which is the good version of this failure. The bad version is the one where
 * the file is quietly dropped from the list and the suite stays green while
 * covering less. A sweep cannot shrink by deletion: it covers whatever exists.
 */
function allSources(dir = resolve(ROOT, "src"), out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) allSources(full, out);
    else if (entry.name.endsWith(".ts")) out.push(relative(ROOT, full));
  }
  return out;
}

/**
 * Match top-level (non-string-literal) inline `require("node:...")` calls.
 *
 * The lookbehind `(?<![`'])` excludes occurrences inside template strings
 * or quoted strings (e.g. subprocess CJS code returned by
 * src/server.ts::buildFetchCode), which are spawned as separate Node CJS
 * processes and never bundled.
 */
const INLINE_NODE_REQUIRE = /(?<!\/\/[^\n]*)require\(["']node:[^"']+["']\)/g;

function findInlineNodeRequires(src: string): string[] {
  const hits: string[] = [];
  // Strip backtick template literals so embedded `require('node:dns')` in
  // child-process source strings (server.ts buildFetchCode) is ignored.
  const stripped = src.replace(/`[\s\S]*?`/g, "``");
  for (const m of stripped.matchAll(INLINE_NODE_REQUIRE)) {
    hits.push(m[0]);
  }
  return hits;
}

describe("issue #511 — no inline require('node:...') in ESM-bundled sources", () => {
  it("src/cli.ts contains no inline require('node:...')", () => {
    const src = readSrc("src/cli.ts");
    expect(findInlineNodeRequires(src)).toEqual([]);
  });

  it("src/cli.ts uses createRequire(import.meta.url) when require is needed", () => {
    const src = readSrc("src/cli.ts");
    // Either no `require(` calls at all, or every one is preceded by a
    // createRequire binding. We assert the import is present whenever the
    // file mentions `require(` in non-template context.
    const stripped = src.replace(/`[\s\S]*?`/g, "``");
    if (/\brequire\(/.test(stripped)) {
      expect(src).toMatch(/createRequire\s*\(\s*import\.meta\.url\s*\)/);
    }
  });

  it("no file under src/ contains an inline require('node:...')", () => {
    const offenders: string[] = [];
    for (const rel of allSources()) {
      const hits = findInlineNodeRequires(readSrc(rel));
      if (hits.length > 0) offenders.push(`${rel}: ${hits.join(", ")}`);
    }
    expect(
      offenders,
      "esbuild rewrites these to a __require shim that throws at runtime; " +
        "use createRequire(import.meta.url) instead:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("sweeps a non-trivial number of sources", () => {
    // Guards the guard: a walker that silently returns [] would make the
    // assertion above vacuous, which is the exact failure mode the file list
    // it replaced had.
    expect(allSources().length).toBeGreaterThan(50);
  });
});
