#!/usr/bin/env node
/**
 * Merge upstream into this fork without drowning in bundle conflicts.
 *
 * Eight `*.bundle.mjs` files are tracked because the plugin loader reads them
 * directly, and they are minified to a handful of enormous lines. Every
 * upstream merge therefore conflicts on all eight, in a form no human can
 * resolve by reading — a measured 25 conflict markers on the last attempt,
 * essentially all of them noise. But the resolution is mechanical: keep our
 * source-level merge, then rebuild the bundles from src/.
 *
 * This script encodes exactly that:
 *   1. register the `ours` merge driver .gitattributes asks for (git ships the
 *      attribute but not the driver, so it must be configured per clone);
 *   2. fetch and merge the requested upstream ref;
 *   3. report any conflicts left in real source files — those are yours;
 *   4. rebuild the bundles and stage them.
 *
 * Usage:
 *   npm run sync-upstream               # merges upstream/main
 *   npm run sync-upstream -- next       # merges upstream/next
 *   npm run sync-upstream -- --dry-run  # only reports what would conflict
 */

import { execFileSync, spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const branch = args.find(a => !a.startsWith("--")) ?? "main";
const remote = process.env.CONTEXT_MODE_UPSTREAM_REMOTE ?? "upstream";
const ref = `${remote}/${branch}`;

const git = (argv, opts = {}) =>
  execFileSync("git", argv, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();

const gitStatus = argv => spawnSync("git", argv, { encoding: "utf-8" });

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

// ── 0. Preconditions ─────────────────────────────────────────────────────
try {
  if (git(["status", "--porcelain"])) {
    fail("working tree is dirty — commit or stash first, a merge needs a clean tree.");
  }
} catch {
  fail("not a git repository.");
}

try {
  git(["remote", "get-url", remote]);
} catch {
  fail(`no '${remote}' remote. Add it: git remote add ${remote} https://github.com/mksglu/context-mode.git`);
}

// ── 1. The merge driver .gitattributes refers to ─────────────────────────
// `merge=ours` is inert unless a driver by that name exists in this clone's
// config. `true` is the entire implementation: succeed, leaving our version.
git(["config", "merge.ours.driver", "true"]);
console.log("✓ merge.ours driver registered (keeps our bundles during merges)");

// ── 2. Fetch + merge ─────────────────────────────────────────────────────
console.log(`→ fetching ${remote}…`);
git(["fetch", remote, "--tags"], { stdio: "inherit" });

const behind = git(["rev-list", "--count", `HEAD..${ref}`]);
if (behind === "0") {
  console.log(`✓ already up to date with ${ref}`);
  process.exit(0);
}
console.log(`→ ${behind} commit(s) to merge from ${ref}`);

if (dryRun) {
  const base = git(["merge-base", "HEAD", ref]);
  const tree = gitStatus(["merge-tree", base, "HEAD", ref]);
  const conflicted = [...(tree.stdout ?? "").matchAll(/^\+<<<<<<< /gm)].length;
  console.log(`  dry run: ${conflicted} conflict hunk(s) would appear before the bundle rebuild.`);
  process.exit(0);
}

const merge = gitStatus(["merge", "--no-edit", ref]);
process.stdout.write(merge.stdout ?? "");
process.stderr.write(merge.stderr ?? "");

// ── 3. What is actually still conflicted? ────────────────────────────────
const conflicts = git(["diff", "--name-only", "--diff-filter=U"])
  .split("\n")
  .filter(Boolean);
const realConflicts = conflicts.filter(f => !f.endsWith(".bundle.mjs"));

if (realConflicts.length > 0) {
  console.error("");
  console.error("✗ source conflicts need a human:");
  for (const f of realConflicts) console.error(`    ${f}`);
  console.error("");
  console.error("  Resolve them, `git add` each, then run: npm run build && git add *.bundle.mjs hooks/*.bundle.mjs && git commit");
  process.exit(1);
}

// ── 4. Rebuild the generated files ───────────────────────────────────────
console.log("→ rebuilding bundles from src/…");
const build = spawnSync("npm", ["run", "build"], { stdio: "inherit", shell: process.platform === "win32" });
if (build.status !== 0) fail("build failed — the merge is staged but the bundles are stale. Fix the build, then commit.");

const generated = git(["ls-files", "*.bundle.mjs"]).split("\n").filter(Boolean);
if (generated.length > 0) git(["add", ...generated]);

if (merge.status !== 0) {
  // Merge stopped for the bundles alone; finish it now that they are rebuilt.
  const commit = spawnSync("git", ["commit", "--no-edit"], { stdio: "inherit" });
  if (commit.status !== 0) fail("could not complete the merge commit.");
}

console.log(`✓ merged ${ref} and rebuilt bundles. Run \`npm test\` before pushing.`);
