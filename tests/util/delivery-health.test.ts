/**
 * The delivery check — the one thing `ctx_doctor` could not see.
 *
 * Measured in a live session: the host was running
 * `~/.claude/plugins/cache/context-mode/context-mode/1.0.169/start.mjs`, that
 * unpacked bundle registered twelve tools, and `ctx_find` / `ctx_graph` — both
 * present in the repository bundle and in the marketplace clone — did not
 * exist in the session at all. Nothing threw. The doctor reported health.
 *
 * These tests pin the three things that make the failure visible: the running
 * `start.mjs` and its build time, the tools that build actually registers, and
 * the missing ones named individually. Plus the cache sweep `/ctx-upgrade`
 * needs so a frozen version number stops meaning a frozen install.
 */

import { describe, it, expect, vi } from "vitest";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  EXPECTED_CTX_TOOLS,
  collectDeliveryHealth,
  discoverRunningStartPaths,
  purgePluginCache,
  renderDeliveryHealth,
  resolvePluginCacheOwnerDir,
  resolvePluginCacheVersionsDir,
  scanBundleTools,
} from "../../src/util/delivery-health.js";
import { serverSource } from "../shared/server-source.js";

const CLI_SRC = readFileSync(resolve(import.meta.dirname, "../../src/cli.ts"), "utf-8");
// The whole server, not one file: ctx_doctor now registers from
// src/tools/doctor.ts, and an assertion pinned to src/server.ts alone would
// pass or fail on where the handler lives rather than on what it does.
const SERVER_SRC = serverSource();

/** A cache tree shaped exactly like the host's, with a bundle we control. */
function fakeInstall(opts: { tools: readonly string[]; version: string; builtAt?: Date }): {
  configDir: string;
  versionDir: string;
  startPath: string;
  env: NodeJS.ProcessEnv;
} {
  const home = mkdtempSync(join(tmpdir(), "ctx-delivery-"));
  const configDir = join(home, ".claude");
  const versionDir = join(configDir, "plugins", "cache", "context-mode", "context-mode", opts.version);
  mkdirSync(join(versionDir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(versionDir, "start.mjs"), "// boot\n");
  writeFileSync(
    join(versionDir, "server.bundle.mjs"),
    opts.tools.map((t) => `server.registerTool("${t}", {}, async () => {});`).join("\n"),
  );
  writeFileSync(
    join(versionDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "context-mode", version: opts.version }),
  );
  if (opts.builtAt) {
    utimesSync(join(versionDir, "server.bundle.mjs"), opts.builtAt, opts.builtAt);
  }
  return {
    configDir,
    versionDir,
    startPath: join(versionDir, "start.mjs"),
    env: { CLAUDE_CONFIG_DIR: configDir },
  };
}

describe("expected tool surface", () => {
  it("matches the registerTool calls in the server source", () => {
    // The constant is what a running bundle is measured against, so it has to
    // track the source that produces those bundles — not a list someone
    // remembers to update.
    const fromSource = new Set(
      [...serverSource().matchAll(/registerTool\(\s*\n?\s*"(ctx_[a-z_]+)"/g)].map((m) => m[1]),
    );
    expect([...fromSource].sort()).toEqual([...EXPECTED_CTX_TOOLS].sort());
  });
});

describe("scanBundleTools", () => {
  it("reads the tool names out of a built bundle", () => {
    const { versionDir } = fakeInstall({ tools: ["ctx_search", "ctx_find"], version: "1.0.170" });
    expect(scanBundleTools(join(versionDir, "server.bundle.mjs"))?.sort()).toEqual(["ctx_find", "ctx_search"]);
  });

  it("returns undefined instead of throwing when there is no bundle", () => {
    expect(scanBundleTools(join(tmpdir(), "definitely-not-here", "server.bundle.mjs"))).toBeUndefined();
  });
});

describe("discoverRunningStartPaths", () => {
  it("pulls pid and script path out of a pgrep -af listing", () => {
    const out = [
      "4242 node /home/u/.claude/plugins/cache/context-mode/context-mode/1.0.169/start.mjs",
      "4243 bun /home/u/.claude/plugins/marketplaces/context-mode/start.mjs --flag",
      "",
    ].join("\n");
    const found = discoverRunningStartPaths({ platform: "linux", runCommand: () => out });
    expect(found).toEqual([
      { pid: 4242, startPath: "/home/u/.claude/plugins/cache/context-mode/context-mode/1.0.169/start.mjs" },
      { pid: 4243, startPath: "/home/u/.claude/plugins/marketplaces/context-mode/start.mjs" },
    ]);
  });

  it("degrades to an empty list when no process tool exists", () => {
    const found = discoverRunningStartPaths({
      platform: "linux",
      runCommand: () => { throw new Error("ENOENT pgrep"); },
    });
    expect(found).toEqual([]);
  });

  it("ignores start.mjs paths belonging to some other plugin", () => {
    const found = discoverRunningStartPaths({
      platform: "linux",
      runCommand: () => "7 node /opt/other-plugin/start.mjs",
    });
    expect(found).toEqual([]);
  });
});

describe("collectDeliveryHealth", () => {
  const noProcesses: () => string = () => "";

  it("names the tools the running build is missing, with its build date and version", () => {
    const builtAt = new Date("2026-08-18T02:23:00");
    const stale = EXPECTED_CTX_TOOLS.filter((t) => t !== "ctx_find" && t !== "ctx_graph");
    const install = fakeInstall({ tools: stale, version: "1.0.169", builtAt });

    const health = collectDeliveryHealth({
      env: install.env,
      argv: ["node", install.startPath],
      pid: 4242,
      liveTools: stale,
      runCommand: noProcesses,
      pluginRoot: install.versionDir,
    });

    expect(health.status).toBe("fail");
    expect(health.missingTools).toEqual(["ctx_find", "ctx_graph"]);

    const text = renderDeliveryHealth(health).join("\n");
    expect(text).toContain("ctx_find, ctx_graph");
    expect(text).toContain(install.startPath);
    expect(text).toContain("2026-08-18 02:23");
    expect(text).toContain("v1.0.169");
  });

  it("falls back to the running bundle when the caller has no live tool list", () => {
    const stale = EXPECTED_CTX_TOOLS.filter((t) => t !== "ctx_graph");
    const install = fakeInstall({ tools: stale, version: "1.0.169" });

    const health = collectDeliveryHealth({
      env: install.env,
      argv: ["node", install.startPath],
      runCommand: noProcesses,
    });

    expect(health.liveTools).toBeUndefined();
    expect(health.missingTools).toEqual(["ctx_graph"]);
    expect(health.running[0].tools).toHaveLength(stale.length);
  });

  it("passes when the running build carries every expected tool", () => {
    const install = fakeInstall({ tools: EXPECTED_CTX_TOOLS, version: "1.0.170" });
    const health = collectDeliveryHealth({
      env: install.env,
      argv: ["node", install.startPath],
      liveTools: EXPECTED_CTX_TOOLS,
      runCommand: noProcesses,
      pluginRoot: install.versionDir,
    });
    expect(health.status).toBe("ok");
    expect(health.missingTools).toEqual([]);
    expect(renderDeliveryHealth(health).join("\n")).toContain(`all ${EXPECTED_CTX_TOOLS.length} expected ctx_* tools present`);
  });

  it("lists unpacked cache versions newest first and marks the running one", () => {
    const install = fakeInstall({
      tools: EXPECTED_CTX_TOOLS,
      version: "1.0.169",
      builtAt: new Date("2026-08-18T02:23:00"),
    });
    // A second, newer unpacked version the host has not switched to.
    const otherDir = join(resolvePluginCacheVersionsDir(install.env), "1.0.170");
    mkdirSync(join(otherDir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(otherDir, "server.bundle.mjs"), 'server.registerTool("ctx_search", {}, () => {});');
    writeFileSync(
      join(otherDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "context-mode", version: "1.0.170" }),
    );

    const health = collectDeliveryHealth({
      env: install.env,
      argv: ["node", install.startPath],
      liveTools: EXPECTED_CTX_TOOLS,
      runCommand: noProcesses,
    });

    expect(health.cacheEntries.map((e) => e.version)).toEqual(["1.0.170", "1.0.169"]);
    expect(health.cacheEntries.find((e) => e.running)?.version).toBe("1.0.169");
    // Running an older unpacked copy than the newest one on disk is exactly
    // the state that produced the missing-tool session.
    expect(health.status).toBe("warn");
    expect(renderDeliveryHealth(health).join("\n")).toContain("RUNNING");
  });

  it("folds several pids on one start.mjs into a single finding", () => {
    // Four live servers on the same script is the normal state of a machine
    // that has resumed a few sessions — one build, one line.
    const install = fakeInstall({ tools: EXPECTED_CTX_TOOLS, version: "1.0.169" });
    const health = collectDeliveryHealth({
      env: install.env,
      argv: ["node", install.startPath],
      pid: 100,
      platform: "linux",
      runCommand: () => [100, 101, 102, 103].map((pid) => `${pid} node ${install.startPath}`).join("\n"),
    });
    expect(health.running).toHaveLength(1);
    expect(health.running[0].pids).toEqual([100, 101, 102, 103]);
    expect(health.running[0].self).toBe(true);
  });

  it("counts a symlinked version name as an alias, not as another build", () => {
    // Heal scripts point old version names at the surviving tree. Following
    // them reported the same build eight times and made the newest-build
    // comparison meaningless.
    const install = fakeInstall({ tools: EXPECTED_CTX_TOOLS, version: "1.0.169" });
    const alias = join(resolvePluginCacheVersionsDir(install.env), "1.0.168");
    symlinkSync(install.versionDir, alias);

    const health = collectDeliveryHealth({
      env: install.env,
      argv: ["node", install.startPath],
      liveTools: EXPECTED_CTX_TOOLS,
      runCommand: noProcesses,
    });

    expect(health.cacheEntries.filter((e) => !e.aliasOf).map((e) => e.version)).toEqual(["1.0.169"]);
    expect(health.cacheEntries.find((e) => e.version === "1.0.168")?.aliasOf).toBe(install.versionDir);
    // An alias is housekeeping, not a stale build.
    expect(health.status).toBe("ok");
    expect(renderDeliveryHealth(health).join("\n")).toContain("1 alias(es): 1.0.168");
  });

  it("reports the process-table sighting when this process is not the server", () => {
    const install = fakeInstall({ tools: EXPECTED_CTX_TOOLS, version: "1.0.169" });
    const health = collectDeliveryHealth({
      env: install.env,
      argv: ["node", "/usr/local/bin/cli.bundle.mjs"], // the CLI, not the server
      pid: 100,
      platform: "linux",
      runCommand: () => `555 node ${install.startPath}`,
    });
    expect(health.running).toHaveLength(1);
    expect(health.running[0].pids).toEqual([555]);
    expect(health.running[0].self).toBe(false);
    expect(health.running[0].version).toBe("1.0.169");
    expect(health.running[0].origin).toBe("cache");
  });

  it("never throws when nothing can be observed", () => {
    const health = collectDeliveryHealth({
      env: { CLAUDE_CONFIG_DIR: join(tmpdir(), "ctx-delivery-absent") },
      argv: ["node", "/nowhere/cli.mjs"],
      runCommand: () => { throw new Error("no pgrep"); },
    });
    expect(health.running).toEqual([]);
    expect(health.missingTools).toEqual([]);
    expect(health.status).toBe("ok");
    expect(renderDeliveryHealth(health).join("\n")).toContain("not observed");
  });
});

describe("resolvePluginCacheOwnerDir", () => {
  it("honors CLAUDE_CONFIG_DIR", () => {
    expect(resolvePluginCacheOwnerDir({ CLAUDE_CONFIG_DIR: "/tmp/cc" }))
      .toBe(join("/tmp/cc", "plugins", "cache", "context-mode"));
  });

  it("expands a tilde against HOME", () => {
    expect(resolvePluginCacheOwnerDir({ CLAUDE_CONFIG_DIR: "~/cfg", HOME: "/home/u" }))
      .toBe(join("/home/u", "cfg", "plugins", "cache", "context-mode"));
  });

  it("treats a whitespace-only CLAUDE_CONFIG_DIR as unset", () => {
    expect(resolvePluginCacheOwnerDir({ CLAUDE_CONFIG_DIR: "   ", HOME: "/home/u" }))
      .toBe(join("/home/u", ".claude", "plugins", "cache", "context-mode"));
  });

  it("refuses to guess when there is no usable home", async () => {
    // os.homedir() answers "" when HOME is unset and the passwd lookup fails;
    // resolve("", ".claude") would then point inside the user's project, and
    // this path is a deletion target.
    vi.resetModules();
    vi.doMock("node:os", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:os")>()),
      homedir: () => "",
    }));
    const mod = await import("../../src/util/delivery-health.js");
    expect(() => mod.resolvePluginCacheOwnerDir({})).toThrow(/HOME/);
    expect(mod.purgePluginCache({ env: {} }).error).toMatch(/HOME/);
    vi.doUnmock("node:os");
    vi.resetModules();
  });
});

describe("purgePluginCache", () => {
  it("removes unpacked version directories and reports each path", () => {
    const install = fakeInstall({ tools: EXPECTED_CTX_TOOLS, version: "1.0.169" });
    const other = join(resolvePluginCacheVersionsDir(install.env), "1.0.168");
    mkdirSync(other, { recursive: true });

    const result = purgePluginCache({ env: install.env });

    expect(result.removed.sort()).toEqual([other, install.versionDir].sort());
    expect(existsSync(install.versionDir)).toBe(false);
    expect(existsSync(other)).toBe(false);
    // The owner directory itself survives — the host writes into it next.
    expect(existsSync(resolvePluginCacheOwnerDir(install.env))).toBe(true);
  });

  it("keeps the tree the upgrade just installed into", () => {
    const install = fakeInstall({ tools: EXPECTED_CTX_TOOLS, version: "1.0.170" });
    const stale = join(resolvePluginCacheVersionsDir(install.env), "1.0.169");
    mkdirSync(stale, { recursive: true });

    const result = purgePluginCache({ env: install.env, keep: [install.versionDir] });

    expect(result.removed).toEqual([stale]);
    expect(result.kept).toEqual([{ path: install.versionDir, reason: "in use by a live install" }]);
    expect(existsSync(install.versionDir)).toBe(true);
  });

  it("protects the real build when the plugin root was reached through an alias", () => {
    // getPluginRoot() answers with the path the host used. If that is a
    // symlinked version name, sparing only the literal string would delete
    // the build it points at — the tree running the upgrade.
    const install = fakeInstall({ tools: EXPECTED_CTX_TOOLS, version: "1.0.169" });
    const alias = join(resolvePluginCacheVersionsDir(install.env), "1.0.168");
    symlinkSync(install.versionDir, alias);

    const result = purgePluginCache({ env: install.env, keep: [alias] });

    expect(existsSync(install.versionDir)).toBe(true);
    expect(result.removed).toEqual([]);
  });

  it("unlinks stale alias names without following them", () => {
    const install = fakeInstall({ tools: EXPECTED_CTX_TOOLS, version: "1.0.169" });
    const outside = mkdtempSync(join(tmpdir(), "ctx-delivery-outside-"));
    writeFileSync(join(outside, "keepme.txt"), "not ours to delete");
    const alias = join(resolvePluginCacheVersionsDir(install.env), "1.0.167");
    symlinkSync(outside, alias);

    const result = purgePluginCache({ env: install.env, keep: [install.versionDir] });

    expect(result.removed).toEqual([alias]);
    expect(existsSync(alias)).toBe(false);
    // The link went; what it pointed at did not.
    expect(existsSync(join(outside, "keepme.txt"))).toBe(true);
  });

  it("spares the tree a live server is running from", () => {
    // The MCP server resolves dynamic imports against its own directory, so
    // deleting it mid-session breaks the very session running the upgrade —
    // and buys nothing, since the bumped version is already a new cache key.
    const install = fakeInstall({ tools: EXPECTED_CTX_TOOLS, version: "1.0.169" });
    const fresh = join(resolvePluginCacheVersionsDir(install.env), "1.0.170");
    const abandoned = join(resolvePluginCacheVersionsDir(install.env), "1.0.166");
    mkdirSync(fresh, { recursive: true });
    mkdirSync(abandoned, { recursive: true });

    const result = purgePluginCache({
      env: install.env,
      keep: [fresh, install.versionDir], // fresh = just installed, 1.0.169 = running
    });

    expect(result.removed).toEqual([abandoned]);
    expect(existsSync(install.versionDir)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
  });

  it("touches nothing under dryRun", () => {
    const install = fakeInstall({ tools: EXPECTED_CTX_TOOLS, version: "1.0.169" });
    const result = purgePluginCache({ env: install.env, dryRun: true });
    expect(result.removed).toEqual([install.versionDir]);
    expect(existsSync(install.versionDir)).toBe(true);
  });

  it("stays inside this plugin's own cache directory", () => {
    const install = fakeInstall({ tools: EXPECTED_CTX_TOOLS, version: "1.0.169" });
    // A co-resident plugin's cache must be invisible to this sweep.
    const foreign = join(install.configDir, "plugins", "cache", "other-plugin", "other-plugin", "9.9.9");
    mkdirSync(foreign, { recursive: true });

    const result = purgePluginCache({ env: install.env });

    expect(result.root).toBe(join(install.configDir, "plugins", "cache", "context-mode"));
    expect(result.removed).not.toContain(foreign);
    expect(existsSync(foreign)).toBe(true);
  });

  it("is a no-op when the host never unpacked anything", () => {
    const configDir = mkdtempSync(join(tmpdir(), "ctx-delivery-empty-"));
    const result = purgePluginCache({ env: { CLAUDE_CONFIG_DIR: configDir } });
    expect(result.removed).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it("records a directory it could not remove instead of throwing", () => {
    const install = fakeInstall({ tools: EXPECTED_CTX_TOOLS, version: "1.0.169" });
    const result = purgePluginCache({
      env: install.env,
      remove: () => { throw new Error("EACCES"); },
    });
    expect(result.removed).toEqual([]);
    expect(result.kept[0].reason).toContain("EACCES");
    expect(existsSync(install.versionDir)).toBe(true);
  });
});

describe("wiring", () => {
  it("ctx_doctor renders the delivery section from the live registration list", () => {
    expect(SERVER_SRC).toMatch(/collectDeliveryHealth\(\{[\s\S]{0,200}liveTools:\s*REGISTERED_CTX_TOOLS/);
    expect(SERVER_SRC).toContain("renderDeliveryHealth(delivery)");
  });

  it("cli doctor() renders the delivery section and counts a failure as critical", () => {
    const body = CLI_SRC.slice(CLI_SRC.indexOf("async function doctor"), CLI_SRC.indexOf("async function insight"));
    expect(body).toContain("collectDeliveryHealth(");
    expect(body).toContain("renderDeliveryHealth(");
    expect(body).toMatch(/delivery\.status === "fail"[\s\S]{0,80}criticalFails\+\+/);
  });

  it("cli upgrade() sweeps the plugin cache while keeping the trees still in use", () => {
    const body = CLI_SRC.slice(CLI_SRC.indexOf("async function upgrade"));
    // Both the tree just installed into and any tree a live server runs from.
    expect(body).toMatch(/purgePluginCache\(\{\s*keep:\s*\[pluginRoot,\s*\.\.\.liveRoots\]\s*\}\)/);
    expect(body).toContain("discoverRunningStartPaths()");
    // The user has to be told what disappeared, or a cache wipe is unfalsifiable.
    expect(body).toContain("purge.removed.join");
  });
});
