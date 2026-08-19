/**
 * version-freshness — guards the invariant that a changed delivery ships under
 * a new version number.
 *
 * The host does not run this repository. It runs an unpacked copy under
 * `~/.claude/plugins/cache/context-mode/context-mode/<version>/`, and the cache
 * key IS the version number. So a commit that changes `server.bundle.mjs`,
 * `cli.bundle.mjs`, `hooks/`, or the set of registered tools while leaving
 * `package.json:version` alone produces a failure with no error message
 * anywhere: everything builds, everything tests green, and every already
 * installed host keeps running the previous bundle forever.
 *
 * That is not hypothetical. d028f02 and c50eb66 both changed the tool surface
 * at a frozen 1.0.169, and the measured result was a live session serving 12
 * tools with `ctx_find` and `ctx_graph` missing entirely — the same class of
 * silent-invisibility failure as FORK-CHANGES entries 33 and 35, one layer
 * lower. `npm version patch` exists and works; it was simply not called. This
 * test replaces that act of memory with a check.
 *
 * Comparison baseline is the last git tag, and the version at that tag is read
 * from `package.json` as it stood there — not from the tag name, which is only
 * a label and can be missing, prefixed, or reused.
 *
 * When git is unavailable or the repository has no tags (a fresh clone with
 * `--depth 1`, a tarball export, a CI checkout without tags) there is no
 * baseline to compare against, so the guard skips rather than fails: a guard
 * that fails when it cannot see is a guard people delete.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");

/**
 * Everything the host actually executes. A change to any of these is a change
 * to what an installed user runs, and therefore needs a new cache key.
 * `src/` is deliberately absent — it is compiled into the bundles, so it only
 * reaches a host through them.
 */
const DELIVERY_PATHS = ["server.bundle.mjs", "cli.bundle.mjs", "hooks/"];

/** The bundle the host loads; the tool list is read out of it, not out of src/. */
const SERVER_BUNDLE = "server.bundle.mjs";

type GitResult = { ok: boolean; stdout: string };

function git(cwd: string, args: string[]): GitResult {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trim() };
}

/** Tool names as the shipped bundle registers them. */
function toolNames(bundleSource: string): string[] {
  return [...bundleSource.matchAll(/registerTool\(\s*"(ctx_[a-z_]+)"/g)]
    .map((m) => m[1])
    .sort();
}

/**
 * Numeric-core semver comparison — enough for this repo, which only ever ships
 * `x.y.z`. A prerelease suffix is ignored on both sides: `1.0.170-rc.1` still
 * counts as a bump away from `1.0.169`, which is the property under test.
 */
function isNewer(a: string, b: string): boolean {
  const core = (v: string) => v.split("-")[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [a1, a2, a3] = core(a);
  const [b1, b2, b3] = core(b);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 > b3;
}

type Freshness =
  | { status: "skip"; reason: string }
  | { status: "unchanged"; tag: string; tagVersion: string }
  | { status: "fresh"; tag: string; tagVersion: string; version: string; changes: string[] }
  | { status: "stale"; tag: string; tagVersion: string; version: string; changes: string[] };

/**
 * `version` is injectable so the invariant can be exercised in both directions
 * without mutating package.json: the real run passes the working-tree version,
 * the scratch-repo cases pass whatever they wrote.
 */
function evaluateFreshness(repoRoot: string, version: string): Freshness {
  if (!git(repoRoot, ["rev-parse", "--git-dir"]).ok) {
    return { status: "skip", reason: "not a git repository (or git unavailable)" };
  }

  const described = git(repoRoot, ["describe", "--tags", "--abbrev=0"]);
  if (!described.ok || described.stdout === "") {
    return { status: "skip", reason: "no reachable tag to compare against" };
  }
  const tag = described.stdout;

  const tagPkg = git(repoRoot, ["show", `${tag}:package.json`]);
  if (!tagPkg.ok) {
    return { status: "skip", reason: `no package.json at ${tag}` };
  }
  let tagVersion: string;
  try {
    tagVersion = String(JSON.parse(tagPkg.stdout).version ?? "");
  } catch {
    return { status: "skip", reason: `package.json at ${tag} is not readable JSON` };
  }
  if (!tagVersion) return { status: "skip", reason: `no version field at ${tag}` };

  const changes: string[] = [];

  // Working tree vs the tag — uncommitted edits count, because they are what
  // the next release would ship.
  const diff = git(repoRoot, ["diff", "--name-only", tag, "--", ...DELIVERY_PATHS]);
  if (diff.ok && diff.stdout !== "") {
    changes.push(...diff.stdout.split("\n").filter(Boolean));
  }

  // The tool list is checked separately rather than inferred from the bundle
  // diff, because it is the one difference a reader can act on directly: it
  // names the tools an installed host would not be able to see.
  const tagBundle = git(repoRoot, ["show", `${tag}:${SERVER_BUNDLE}`]);
  if (tagBundle.ok) {
    let current = "";
    try {
      current = readFileSync(join(repoRoot, SERVER_BUNDLE), "utf8");
    } catch {
      current = "";
    }
    if (current) {
      const before = new Set(toolNames(tagBundle.stdout));
      const after = new Set(toolNames(current));
      const added = [...after].filter((t) => !before.has(t));
      const removed = [...before].filter((t) => !after.has(t));
      if (added.length > 0) changes.push(`tools added: ${added.join(", ")}`);
      if (removed.length > 0) changes.push(`tools removed: ${removed.join(", ")}`);
    }
  }

  if (changes.length === 0) return { status: "unchanged", tag, tagVersion };
  const status = isNewer(version, tagVersion) ? "fresh" : "stale";
  return { status, tag, tagVersion, version, changes };
}

function staleMessage(r: Extract<Freshness, { status: "stale" }>): string {
  return [
    `Delivery changed since ${r.tag} but package.json:version is still ${r.version}.`,
    "The host runs an unpacked copy under ~/.claude/plugins/cache/context-mode/",
    "context-mode/<version>/ and the cache key IS the version number, so a frozen",
    "number means every installed host keeps running the previous bundle — no error,",
    "no warning, the change simply never arrives.",
    "Fix: run `npm version patch` (it calls scripts/version-sync.mjs) and commit.",
    "",
    "Changed:",
    ...r.changes.map((c) => `  - ${c}`),
  ].join("\n");
}

/**
 * A throwaway repo with one tagged commit and one delivery change on top. Lets
 * both directions of the invariant be asserted without touching this repo's
 * package.json or its tags.
 */
function scratchRepo(opts: { bump: boolean; touch?: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), "version-freshness-"));
  const run = (args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  };
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "test@example.invalid"]);
  run(["config", "user.name", "test"]);
  run(["config", "commit.gpgsign", "false"]);

  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.0.0" }, null, 2) + "\n");
  writeFileSync(join(dir, "server.bundle.mjs"), 'registerTool("ctx_search", {});\n');
  writeFileSync(join(dir, "cli.bundle.mjs"), "// cli\n");
  writeFileSync(join(dir, "hooks", "pretooluse.mjs"), "// hook\n");
  run(["add", "-A"]);
  run(["commit", "-qm", "release"]);
  run(["tag", "v1.0.0"]);

  if (opts.touch !== false) {
    // A new tool in the bundle: the exact shape of d028f02/c50eb66.
    writeFileSync(
      join(dir, "server.bundle.mjs"),
      'registerTool("ctx_search", {});\nregisterTool("ctx_find", {});\n',
    );
  }
  if (opts.bump) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.0.1" }, null, 2) + "\n");
  }
  return dir;
}

function scratchVersion(dir: string): string {
  return String(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version);
}

const REPO_VERSION = String(
  JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")).version,
);
const REPO_FRESHNESS = evaluateFreshness(REPO_ROOT, REPO_VERSION);

describe("version freshness (this repository)", () => {
  it.skipIf(REPO_FRESHNESS.status === "skip")(
    "does not ship a changed delivery under a frozen version",
    () => {
      if (REPO_FRESHNESS.status === "stale") {
        expect.fail(staleMessage(REPO_FRESHNESS));
      }
      expect(REPO_FRESHNESS.status).not.toBe("stale");
    },
  );

  it.skipIf(REPO_FRESHNESS.status === "skip")(
    "goes green on a version bump, without touching package.json",
    () => {
      // Proves the guard is releasable rather than permanently red: same tree,
      // same tag, one bumped number in memory. Without this a failing run is
      // ambiguous between "the version is frozen" and "the check is broken".
      if (REPO_FRESHNESS.status === "skip") return;
      const [maj, min, patch] = REPO_FRESHNESS.tagVersion.split(".").map(Number);
      const bumped = `${maj}.${min}.${patch + 1}`;
      expect(evaluateFreshness(REPO_ROOT, bumped).status).not.toBe("stale");
    },
  );

  it.skipIf(REPO_FRESHNESS.status !== "skip")("skips cleanly when there is no baseline", () => {
    // Not a failure: a shallow clone or a tarball export has nothing to compare
    // against, and a guard that fails when it cannot see is a guard people
    // delete. Asserted explicitly so the skip stays a deliberate branch.
    expect(REPO_FRESHNESS.status).toBe("skip");
  });
});

describe("version freshness (invariant, both directions)", () => {
  it("flags a changed delivery when the version stayed put", () => {
    const dir = scratchRepo({ bump: false });
    try {
      const r = evaluateFreshness(dir, scratchVersion(dir));
      expect(r.status).toBe("stale");
      if (r.status !== "stale") return;
      expect(r.tagVersion).toBe("1.0.0");
      expect(r.changes).toContain("server.bundle.mjs");
      expect(r.changes).toContain("tools added: ctx_find");
      expect(staleMessage(r)).toContain("npm version patch");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes once the version is bumped", () => {
    const dir = scratchRepo({ bump: true });
    try {
      const r = evaluateFreshness(dir, scratchVersion(dir));
      expect(r.status).toBe("fresh");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes when the delivery is untouched", () => {
    const dir = scratchRepo({ bump: false, touch: false });
    try {
      expect(evaluateFreshness(dir, scratchVersion(dir)).status).toBe("unchanged");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips instead of failing when the repository has no tags", () => {
    const dir = scratchRepo({ bump: false });
    try {
      spawnSync("git", ["tag", "-d", "v1.0.0"], { cwd: dir, encoding: "utf8" });
      const r = evaluateFreshness(dir, "1.0.0");
      expect(r.status).toBe("skip");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips instead of failing outside a git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "version-freshness-nogit-"));
    try {
      const r = evaluateFreshness(dir, "1.0.0");
      expect(r.status).toBe("skip");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
