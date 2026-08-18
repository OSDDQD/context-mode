import "../setup-home";
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// @ts-expect-error — plain .mjs build script, no type declarations.
import { extractBundleOutfiles } from "../../scripts/plugin-cache-integrity.mjs";

/**
 * Bundle-manifest invariant.
 *
 * `hooks/session-attribution.bundle.mjs` shipped for four months as an
 * orphan: 270a56f added the file and the source it was built from, but
 * never touched `scripts.bundle`. The source then changed three times
 * (79e0d7e, 92997e4, 2e7a543) while the bundle stayed at its April build,
 * so the Bug 8 fix in 2e7a543 was dead at runtime — every hook loads the
 * bundle first (hooks/session-loaders.mjs:41-53) while every test imports
 * `src/`. Nothing caught it: `assert-bundle` scans an explicit list, and
 * `plugin-cache-integrity` checks existence only, with the file explicitly
 * whitelisted into SOFT_FALLBACK_BUNDLES.
 *
 * The invariant that would have caught it: whatever bundle sits in `hooks/`
 * is produced by the build, scanned by assert-bundle, and committed by CI.
 * `scripts.bundle` is the single source of truth — the same one
 * `getRequiredRuntimeSiblings()` parses for the boot gate.
 */

const ROOT = resolve(__dirname, "../..");

function pkg(): Record<string, any> {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
}

/** Bundles produced by `npm run bundle`, as POSIX-relative paths. */
function producedBundles(): string[] {
  return extractBundleOutfiles(pkg());
}

/** `hooks/*.bundle.mjs` actually present in the tree, as POSIX-relative paths. */
function bundlesInTree(): string[] {
  return readdirSync(join(ROOT, "hooks"))
    .filter((f) => f.endsWith(".bundle.mjs"))
    .map((f) => `hooks/${f}`)
    .sort();
}

describe("bundle manifest", () => {
  // Guard the guard: every assertion below is "X is a member of
  // producedBundles()". A parser regression returning [] would make all of
  // them pass vacuously, so pin the parser against known literals first.
  it("extractBundleOutfiles parses scripts.bundle (parser sanity)", () => {
    const produced = producedBundles();
    expect(produced).toContain("server.bundle.mjs");
    expect(produced).toContain("cli.bundle.mjs");
    expect(produced.length).toBeGreaterThanOrEqual(7);
  });

  it("every hooks/*.bundle.mjs in the tree is produced by npm run bundle", () => {
    const produced = new Set(producedBundles());
    const orphans = bundlesInTree().filter((b) => !produced.has(b));
    expect(
      orphans,
      `orphan bundle(s) — present in hooks/ but no --outfile= in package.json scripts.bundle. ` +
        `They will never be rebuilt and will silently drift from src/: ${orphans.join(", ")}`,
    ).toEqual([]);
  });

  it("every hook bundle the build produces exists in the tree", () => {
    // Runs after `pretest: npm run build`, so absence means the build
    // chain claims an output it does not actually write.
    const missing = producedBundles()
      .filter((b) => b.startsWith("hooks/"))
      .filter((b) => !existsSync(join(ROOT, b)));
    expect(missing, `declared but not built: ${missing.join(", ")}`).toEqual([]);
  });

  it("every produced bundle is scanned by npm run assert-bundle", () => {
    const assertScript = String(pkg().scripts["assert-bundle"] ?? "");
    const unscanned = producedBundles().filter((b) => !assertScript.includes(b));
    expect(
      unscanned,
      `built but not scanned by assert-bundle (the #511 shim would ship undetected): ${unscanned.join(", ")}`,
    ).toEqual([]);
  });

  it("every produced bundle is committed by the CI bundle workflow", () => {
    const workflow = readFileSync(join(ROOT, ".github/workflows/bundle.yml"), "utf-8");
    const addLine = workflow.split("\n").find((l) => l.includes("git add -f"));
    expect(addLine, "no `git add -f` step found in .github/workflows/bundle.yml").toBeDefined();
    const uncommitted = producedBundles().filter((b) => !addLine!.includes(b));
    expect(
      uncommitted,
      `rebuilt by CI but never committed — the stale copy in git wins on every install: ${uncommitted.join(", ")}`,
    ).toEqual([]);
  });
});
