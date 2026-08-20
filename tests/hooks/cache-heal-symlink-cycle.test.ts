/**
 * The plugin cache symlink cycle — regression suite.
 *
 * What happened on a real machine:
 *
 *   ~/.claude/plugins/cache/context-mode/context-mode/ contained NOTHING but
 *   symlinks. `1.0.171 -> 1.0.169` and `1.0.169 -> 1.0.171` formed a two-node
 *   cycle, and seven older version names pointed into it. Meanwhile
 *   installed_plugins.json named 1.0.173, which existed nowhere. Claude Code
 *   could not resolve the plugin at all: the session came up with ZERO ctx_*
 *   tools and nothing anywhere said so.
 *
 * The old heal built that state and rebuilt it every boot:
 *
 *   1. The version list was filtered by NAME (`/^\d+\.\d+/`), so a symlink
 *      named like a version counted as a version directory — "newest" could BE
 *      a symlink, and linking a missing version at it produced a
 *      symlink-to-symlink.
 *   2. `existsSync()` follows symlinks: a cyclic link answers ELOOP and a
 *      dangling one ENOENT, so both read as "missing" and the heal re-created
 *      exactly the link that was the problem.
 *
 * Everything below is asserted twice, against both heal sites, because they
 * are deliberate twins: the helpers in hooks/cache-heal-utils.mjs (imported by
 * start.mjs's Self-heal Layer 1) and CACHE_HEAL_HOOK_SOURCE — the standalone
 * script deployed into <config>/hooks/, executed here as the exact bytes a
 * user receives. A fix that lands in only one of them fails this file.
 */

import { describe, expect, it, afterAll } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CACHE_HEAL_HOOK_SOURCE,
  cacheEntryState,
  healCacheInstallPath,
  isRealPluginDir,
  newestRealPluginDir,
  pruneBrokenPluginAliases,
} from "../../hooks/cache-heal-utils.mjs";

const PLUGIN_KEY = "context-mode@context-mode";
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

interface Fixture {
  /** Stands in for `$CLAUDE_CONFIG_DIR`. */
  configDir: string;
  /** `<config>/plugins/cache`. */
  cacheRoot: string;
  /** `<cache>/context-mode/context-mode` — the directory of version names. */
  versionsDir: string;
  registryPath: string;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "cm-cache-cycle-"));
  roots.push(root);
  const configDir = join(root, ".claude");
  const cacheRoot = join(configDir, "plugins", "cache");
  const versionsDir = join(cacheRoot, "context-mode", "context-mode");
  mkdirSync(versionsDir, { recursive: true });
  return { configDir, cacheRoot, versionsDir, registryPath: join(configDir, "plugins", "installed_plugins.json") };
}

/** A version directory that can actually boot: start.mjs + a readable manifest. */
function makeRealVersion(f: Fixture, version: string): string {
  const dir = join(f.versionsDir, version);
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, "start.mjs"), "// fixture\n");
  writeFileSync(
    join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "context-mode", version }) + "\n",
  );
  return dir;
}

/** A directory that looks like a version but cannot boot — a half unpack. */
function makeUnbootableVersion(f: Fixture, version: string): string {
  const dir = join(f.versionsDir, version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "carried forward by an interrupted unpack\n");
  return dir;
}

/** Point one version name at another (or at nothing, for a dangling link). */
function makeAlias(f: Fixture, name: string, target: string): string {
  const path = join(f.versionsDir, name);
  symlinkSync(join(f.versionsDir, target), path);
  return path;
}

function writeRegistry(f: Fixture, installPath: string, version: string): void {
  writeFileSync(
    f.registryPath,
    JSON.stringify({ plugins: { [PLUGIN_KEY]: [{ installPath, version }] } }, null, 2) + "\n",
  );
}

/**
 * Run the heal the way a user's machine does.
 *
 * `"hook"` writes CACHE_HEAL_HOOK_SOURCE to disk and executes it under a fake
 * `CLAUDE_CONFIG_DIR` — the deployed script, byte for byte. `"helpers"` calls
 * the module start.mjs's Layer 1 imports, in the same order Layer 1 calls
 * them: prune first, then heal the registry's installPath.
 */
function runHeal(f: Fixture, mode: "hook" | "helpers", installPath: string): void {
  if (mode === "helpers") {
    pruneBrokenPluginAliases(f.versionsDir);
    healCacheInstallPath({ installPath, cacheRoot: f.cacheRoot });
    return;
  }
  const scriptPath = join(f.configDir, "context-mode-cache-heal.mjs");
  writeFileSync(scriptPath, CACHE_HEAL_HOOK_SOURCE, { mode: 0o755 });
  const res = spawnSync(process.execPath, [scriptPath], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: f.configDir },
    encoding: "utf-8",
  });
  // The hook must never fail loudly — a broken cache is not a reason to break
  // the session start that is trying to fix it.
  expect(res.stderr ?? "").toBe("");
  expect(res.status).toBe(0);
}

/** Names still present in the versions dir, judged without following links. */
function namesByState(f: Fixture): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(f.versionsDir)) {
    out[name] = cacheEntryState(join(f.versionsDir, name));
  }
  return out;
}

for (const mode of ["helpers", "hook"] as const) {
  describe(`plugin cache heal (${mode})`, () => {
    it("(a) breaks a symlink cycle and relinks the registry at the real build", () => {
      const f = makeFixture();
      const real = makeRealVersion(f, "1.0.174");
      // The exact shape from the incident, one version lower.
      makeAlias(f, "1.0.171", "1.0.169");
      makeAlias(f, "1.0.169", "1.0.171");
      // The registry names a version that exists nowhere.
      const missing = join(f.versionsDir, "1.0.173");
      writeRegistry(f, missing, "1.0.173");

      runHeal(f, mode, missing);

      // R3: both members of the cycle are gone, not re-created.
      expect(existsSync(join(f.versionsDir, "1.0.171"))).toBe(false);
      expect(namesByState(f)["1.0.171"]).toBeUndefined();
      expect(namesByState(f)["1.0.169"]).toBeUndefined();
      // R1 + R2: the registry path now resolves, in one hop, to the real dir.
      expect(cacheEntryState(missing)).toBe("alias");
      expect(realpathSync(missing)).toBe(realpathSync(real));
      expect(lstatSync(realpathSync(missing)).isSymbolicLink()).toBe(false);
      expect(isRealPluginDir(realpathSync(missing))).toBe(true);
    });

    it("(b) with only symlinks and no real build, writes nothing at all", () => {
      const f = makeFixture();
      makeAlias(f, "1.0.171", "1.0.169");
      makeAlias(f, "1.0.169", "1.0.171");
      makeAlias(f, "1.0.170", "1.0.171"); // an old name pointing into the loop
      const missing = join(f.versionsDir, "1.0.173");
      writeRegistry(f, missing, "1.0.173");

      runHeal(f, mode, missing);

      // R5: nothing real to point at, so no link is invented. A missing
      // directory is diagnosable; a loop pointing back at itself is not.
      expect(existsSync(missing)).toBe(false);
      expect(cacheEntryState(missing)).toBe("missing");
      // R3: every unresolvable link is gone, including the one that merely
      // pointed into the cycle.
      expect(readdirSync(f.versionsDir)).toEqual([]);
    });

    it("(c) keeps the real newest build, drops stale links, spares healthy ones", () => {
      const f = makeFixture();
      const older = makeRealVersion(f, "1.0.169");
      const newest = makeRealVersion(f, "1.0.174");
      makeAlias(f, "1.0.170", "1.0.169"); // healthy alias — housekeeping, not a bug
      makeAlias(f, "1.0.172", "1.0.166"); // dangling — 1.0.166 was deleted
      const missing = join(f.versionsDir, "1.0.173");
      writeRegistry(f, missing, "1.0.173");

      runHeal(f, mode, missing);

      // R4: real directories are never removed.
      expect(isRealPluginDir(older)).toBe(true);
      expect(isRealPluginDir(newest)).toBe(true);
      // A resolvable alias is left exactly as found.
      expect(cacheEntryState(join(f.versionsDir, "1.0.170"))).toBe("alias");
      expect(realpathSync(join(f.versionsDir, "1.0.170"))).toBe(realpathSync(older));
      // The dangling one goes.
      expect(existsSync(join(f.versionsDir, "1.0.172"))).toBe(false);
      // And the registry lands on the newest REAL build, not on 1.0.170 —
      // which sorts lower but would have won under a name-only filter that
      // treated aliases as builds.
      expect(realpathSync(missing)).toBe(realpathSync(newest));
    });

    it("never points a version name at a half-unpacked directory", () => {
      const f = makeFixture();
      const real = makeRealVersion(f, "1.0.169");
      // Sorts newest, but has no start.mjs: linking at it loads the plugin
      // with no tools instead of failing where anyone can see it (R1).
      makeUnbootableVersion(f, "1.0.180");
      const missing = join(f.versionsDir, "1.0.173");
      writeRegistry(f, missing, "1.0.173");

      runHeal(f, mode, missing);

      expect(realpathSync(missing)).toBe(realpathSync(real));
      // R4 again: the half unpack is left where it is for the doctor to report.
      expect(existsSync(join(f.versionsDir, "1.0.180"))).toBe(true);
    });

    it("is idempotent — a second run changes nothing", () => {
      const f = makeFixture();
      makeRealVersion(f, "1.0.174");
      makeAlias(f, "1.0.171", "1.0.169");
      makeAlias(f, "1.0.169", "1.0.171");
      const missing = join(f.versionsDir, "1.0.173");
      writeRegistry(f, missing, "1.0.173");

      runHeal(f, mode, missing);
      const first = namesByState(f);
      runHeal(f, mode, missing);
      expect(namesByState(f)).toEqual(first);
      // The state that used to be re-created on every boot must stay absent.
      expect(first["1.0.171"]).toBeUndefined();
      expect(first["1.0.173"]).toBe("alias");
    });
  });
}

describe("cache-heal primitives", () => {
  it("cacheEntryState tells a cycle apart from a missing directory", () => {
    const f = makeFixture();
    makeAlias(f, "1.0.171", "1.0.169");
    makeAlias(f, "1.0.169", "1.0.171");
    // The whole bug in one assertion: existsSync collapses ELOOP to "not
    // there", so the old heal saw a missing version and re-created the link.
    expect(existsSync(join(f.versionsDir, "1.0.171"))).toBe(false);
    expect(cacheEntryState(join(f.versionsDir, "1.0.171"))).toBe("broken");
    expect(cacheEntryState(join(f.versionsDir, "9.9.9"))).toBe("missing");
  });

  it("newestRealPluginDir never returns a symlink, even when one sorts newest", () => {
    const f = makeFixture();
    const real = makeRealVersion(f, "1.0.169");
    makeAlias(f, "1.0.200", "1.0.169"); // resolvable, and the highest name
    const picked = newestRealPluginDir(f.versionsDir);
    expect(picked).toBe(realpathSync(real));
    expect(lstatSync(picked as string).isSymbolicLink()).toBe(false);
  });

  it("newestRealPluginDir answers null when nothing real is present", () => {
    const f = makeFixture();
    makeAlias(f, "1.0.171", "1.0.169");
    makeAlias(f, "1.0.169", "1.0.171");
    expect(newestRealPluginDir(f.versionsDir)).toBeNull();
  });

  it("healCacheInstallPath refuses to write outside the plugin cache", () => {
    const f = makeFixture();
    makeRealVersion(f, "1.0.174");
    const outside = join(f.configDir, "not-the-cache", "1.0.173");
    expect(healCacheInstallPath({ installPath: outside, cacheRoot: f.cacheRoot })).toBe("outside-cache");
    expect(existsSync(outside)).toBe(false);
  });

  it("healCacheInstallPath leaves a real install directory untouched", () => {
    const f = makeFixture();
    const real = makeRealVersion(f, "1.0.174");
    expect(healCacheInstallPath({ installPath: real, cacheRoot: f.cacheRoot })).toBe("ok");
    expect(cacheEntryState(real)).toBe("dir");
  });

  it("healCacheInstallPath re-points an alias that resolves to an unbootable tree", () => {
    const f = makeFixture();
    const real = makeRealVersion(f, "1.0.174");
    makeUnbootableVersion(f, "1.0.170");
    // Resolves fine — and is still a dead end, just one that fails later.
    const alias = makeAlias(f, "1.0.173", "1.0.170");
    expect(healCacheInstallPath({ installPath: alias, cacheRoot: f.cacheRoot })).toBe("linked");
    expect(realpathSync(alias)).toBe(realpathSync(real));
  });

  it("healCacheInstallPath reports no-target rather than inventing a link", () => {
    const f = makeFixture();
    const missing = join(f.versionsDir, "1.0.173");
    expect(healCacheInstallPath({ installPath: missing, cacheRoot: f.cacheRoot })).toBe("no-target");
    expect(existsSync(missing)).toBe(false);
  });

  it("preferredTarget is validated, not trusted", () => {
    const f = makeFixture();
    const real = makeRealVersion(f, "1.0.169");
    const bogus = makeUnbootableVersion(f, "0.0.1");
    const missing = join(f.versionsDir, "1.0.173");
    // start.mjs passes __dirname here; a tree that cannot boot must not become
    // the target just because the caller offered it.
    healCacheInstallPath({ installPath: missing, cacheRoot: f.cacheRoot, preferredTarget: bogus });
    expect(realpathSync(missing)).toBe(realpathSync(real));
  });

  it("pruneBrokenPluginAliases removes only symlinks", () => {
    const f = makeFixture();
    const real = makeRealVersion(f, "1.0.169");
    makeAlias(f, "1.0.172", "1.0.166"); // dangling
    const removed = pruneBrokenPluginAliases(f.versionsDir);
    expect(removed).toEqual([join(f.versionsDir, "1.0.172")]);
    expect(existsSync(real)).toBe(true);
  });
});
