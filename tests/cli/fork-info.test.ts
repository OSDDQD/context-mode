import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readForkInfo, getForkInfo, resolveUpgradeRepo, sameGitRepo, describeInstall,
  UPSTREAM_REPO,
} from "../../src/util/fork-info.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ctx-fork-info-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function pkg(contents: Record<string, unknown>): string {
  writeFileSync(join(dir, "package.json"), JSON.stringify(contents));
  return dir;
}

describe("readForkInfo", () => {
  test("reads a well-formed fork block", () => {
    const info = readForkInfo({
      fork: {
        name: "OSDDQD/context-mode",
        repo: "https://github.com/OSDDQD/context-mode.git",
        upstream: "https://github.com/mksglu/context-mode.git",
        version: "1",
      },
    });
    expect(info?.repo).toBe("https://github.com/OSDDQD/context-mode.git");
    expect(info?.version).toBe("1");
  });

  test("an upstream package.json has no fork block", () => {
    expect(readForkInfo({ name: "context-mode", version: "1.0.169" })).toBeNull();
    expect(readForkInfo({ fork: { version: "1" } })).toBeNull();
    expect(readForkInfo(null)).toBeNull();
  });
});

describe("resolveUpgradeRepo", () => {
  test("a fork install upgrades from the fork, not from upstream", () => {
    // The bug this exists to prevent: /ctx-upgrade cloning upstream over a
    // fork install, which silently deletes every local addition.
    const root = pkg({ fork: { repo: "https://github.com/OSDDQD/context-mode.git" } });
    const resolved = resolveUpgradeRepo({ pluginRoot: root, env: {} as NodeJS.ProcessEnv });
    expect(resolved.url).toBe("https://github.com/OSDDQD/context-mode.git");
    expect(resolved.reason).toBe("fork-marker");
  });

  test("the env override beats everything", () => {
    const root = pkg({ fork: { repo: "https://github.com/OSDDQD/context-mode.git" } });
    const resolved = resolveUpgradeRepo({
      pluginRoot: root,
      env: { CONTEXT_MODE_UPGRADE_REPO: "https://example.com/mine.git" } as NodeJS.ProcessEnv,
    });
    expect(resolved).toEqual({ url: "https://example.com/mine.git", reason: "env" });
  });

  test("falls back to the installed tree's git origin", () => {
    const root = pkg({ name: "context-mode" });
    const resolved = resolveUpgradeRepo({
      pluginRoot: root,
      env: {} as NodeJS.ProcessEnv,
      originUrl: "git@github.com:someone/context-mode.git",
    });
    expect(resolved).toEqual({ url: "git@github.com:someone/context-mode.git", reason: "git-origin" });
  });

  test("an unforked install still upgrades from upstream", () => {
    const root = pkg({ name: "context-mode" });
    const resolved = resolveUpgradeRepo({ pluginRoot: root, env: {} as NodeJS.ProcessEnv, originUrl: null });
    expect(resolved).toEqual({ url: UPSTREAM_REPO, reason: "upstream" });
  });
});

describe("sameGitRepo", () => {
  test("sees through scheme, suffix and trailing-slash noise", () => {
    expect(sameGitRepo("https://github.com/a/b.git", "https://github.com/a/b")).toBe(true);
    expect(sameGitRepo("git@github.com:a/b.git", "https://github.com/a/b")).toBe(true);
    expect(sameGitRepo("https://github.com/a/b/", "https://github.com/a/b")).toBe(true);
  });

  test("different repos stay different", () => {
    expect(sameGitRepo("https://github.com/OSDDQD/context-mode", "https://github.com/mksglu/context-mode")).toBe(false);
    expect(sameGitRepo(null, "https://github.com/a/b")).toBe(false);
    expect(sameGitRepo("", "")).toBe(false);
  });
});

describe("describeInstall", () => {
  test("names the fork and its revision", () => {
    const root = pkg({ fork: { name: "OSDDQD/context-mode", repo: "https://github.com/OSDDQD/context-mode.git", version: "1" } });
    expect(describeInstall(root, "1.0.169")).toBe("context-mode v1.0.169 · fork OSDDQD/context-mode rev 1");
  });

  test("says upstream when there is no fork block", () => {
    const root = pkg({ name: "context-mode" });
    expect(describeInstall(root, "1.0.169")).toBe("context-mode v1.0.169 (upstream)");
    expect(getForkInfo(root)).toBeNull();
  });

  test("a missing package.json does not throw", () => {
    expect(describeInstall(join(dir, "nope"), "1.0.169")).toContain("upstream");
  });
});

describe("this repository's own marker", () => {
  test("package.json declares the fork so installs are identifiable", () => {
    // Fork and upstream ship the same `version`; without this block, "which
    // tree is installed?" has no answer and /ctx-upgrade has no safe default.
    const info = getForkInfo(process.cwd());
    expect(info?.repo).toContain("OSDDQD/context-mode");
    expect(info?.upstream).toBe(UPSTREAM_REPO);
  });
});
