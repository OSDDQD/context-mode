/**
 * No test may load the code under test from `build/`.
 *
 * The finding this closes: `tests/security.test.ts` imported
 * `../build/security.js` — the tsc output, not the source. `build/` is
 * gitignored and refreshed only by `npm run build`, which `pretest` runs but
 * nothing else does: CI runs `npx vitest run` directly, and so does everyone
 * working locally. So the directory sat on disk holding a compilation from
 * before fifteen adapters were deleted, and eleven parity tests kept passing
 * against adapters that no longer existed in `src/`. Nothing failed. The
 * checks were green because they were looking at a stale artifact, not because
 * the behaviour was there — the same failure shape as a plugin cache keyed on
 * a version number that never moved.
 *
 * Two properties follow, and this file pins both:
 *
 *   1. Tests import from `src/` (vitest transpiles TS directly, so there is
 *      nothing to gain from the intermediate) or spawn `server.bundle.mjs` —
 *      the artifact `start.mjs` actually imports, committed to the repo and
 *      covered by `assert-bundle` plus the version-freshness guard.
 *   2. Nothing under `tests/` names the repo's own `build/` output as a module
 *      source or a spawn target.
 *
 * `pretest` is deliberately left alone: making `build/` fresh would fix the
 * symptom for `npm test` and leave `npx vitest run` — the way the suite is
 * actually invoked, including in CI — exactly as exposed.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(__dirname, "..");
const testsRoot = join(repoRoot, "tests");

/**
 * Files allowed to name a `build` path segment, each with the reason.
 * A silent exclusion is how the stale import survived in the first place, so
 * an entry here has to say what it is pointing at and why that is not the
 * repo's tsc output.
 */
const ALLOWED: ReadonlyArray<readonly [file: string, reason: string]> = [
  [
    "tests/no-stale-build-imports.test.ts",
    "this file — it has to spell the forbidden shapes out (in its own doc " +
      "comment and its own regexes) in order to look for them anywhere else.",
  ],
];

const ALLOWED_FILES = new Set(ALLOWED.map(([f]) => f));

/** Every .ts/.mts file under tests/, test or helper. */
function walkTests(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkTests(full, acc);
      continue;
    }
    if (/\.(ts|mts)$/.test(entry)) acc.push(full);
  }
  return acc;
}

/**
 * References that LOAD the repo's own build output — not every mention of the
 * word. Two shapes cover it, and the narrowness is deliberate:
 *
 *   A. a module specifier that walks up into `build/` (`from "../build/x.js"`,
 *      `import("../../build/x.js")`);
 *   B. a path anchored at the repo via `__dirname` that includes a `"build"`
 *      segment — how a spawn target is built (`resolve(__dirname, "..",
 *      "build", "server.js")`).
 *
 * What is deliberately NOT flagged: prose and test titles that name
 * `build/security.js` (hooks/core/routing.mjs really does fall back to it, and
 * tests/hooks/require-security.test.ts exists to pin that fallback), and
 * fixture trees that create a `build` dir under a temp plugin root — those
 * assert on a path, they do not load this repo's compiler output.
 */
function buildReferences(text: string): string[] {
  const hits: string[] = [];
  const specifiers =
    text.match(/(?:\bfrom\s*|\bimport\(\s*|\brequire\(\s*)["'][^"'\n]*\.\.\/build\/[^"'\n]*["']/g) ?? [];
  const anchored = text.match(/(?:join|resolve)\([^)\n]*__dirname[^)\n]*["']build["'][^)\n]*\)/g) ?? [];
  for (const hit of [...specifiers, ...anchored]) {
    if (hit.includes("node_modules")) continue;
    hits.push(hit);
  }
  return hits;
}

describe("test suite loads the code under test, not a stale artifact", () => {
  const files = walkTests(testsRoot);

  it("finds test files to check at all", () => {
    // A walk that silently returns nothing would make every assertion below
    // vacuous — the exact failure mode this file exists to catch.
    expect(files.length).toBeGreaterThan(100);
  });

  it("never names the repo's build/ output under tests/", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const rel = relative(repoRoot, file).replace(/\\/g, "/");
      if (ALLOWED_FILES.has(rel)) continue;
      const hits = buildReferences(readFileSync(file, "utf-8"));
      if (hits.length > 0) offenders.push(`${rel}: ${hits.join(", ")}`);
    }

    expect(
      offenders,
      "these files load or spawn the repo's build/ output. build/ is gitignored " +
        "and only `npm run build` refreshes it, so a check pointed there can pass " +
        "against code deleted from src/. Import from src/ (vitest transpiles TS) " +
        "or spawn server.bundle.mjs, which is committed and freshness-guarded.",
    ).toEqual([]);
  });

  it("keeps an explicit reason on every exclusion", () => {
    for (const [file, reason] of ALLOWED) {
      expect(reason.length, `${file} is excluded without a reason`).toBeGreaterThan(40);
      // An exclusion for a file that no longer exists is a stale rule of the
      // same family — it makes the list look considered when it is not.
      expect(files.map((f) => relative(repoRoot, f).replace(/\\/g, "/"))).toContain(file);
    }
  });
});
