/**
 * Host memory integration.
 *
 * The bug this pins: `searchAutoMemory` looked in context-mode's own
 * hash-keyed namespace (`<config>/memory/<hash>`), which Claude Code never
 * writes to, while the user's real memory lives in
 * `<config>/projects/<slug>/memory/`. ctx_stats counted those files correctly
 * through a different path, so the system claimed a memory it could not read.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectSlug, resolveHostMemoryDirs, listHostMemoryFiles, indexHostMemory,
} from "../../src/session/host-memory.js";
import { searchAutoMemory } from "../../src/search/auto-memory.js";

let root: string;
let configDir: string;
const projectDir = "/home/dev/projects/app";

function seedMemory(slug: string, files: Record<string, string>): string {
  const dir = join(configDir, "projects", slug, "memory");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body, "utf-8");
  }
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ctx-host-memory-"));
  configDir = join(root, ".claude");
  mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("projectSlug", () => {
  test("mirrors Claude Code's separator-to-dash naming", () => {
    expect(projectSlug("/home/dev/projects/app")).toBe("-home-dev-projects-app");
    expect(projectSlug("/home/dev/projects/app/")).toBe("-home-dev-projects-app");
    expect(projectSlug("C:\\work\\app")).toBe("C:-work-app");
  });

  test("folded form collapses dots and underscores", () => {
    expect(projectSlug("/home/dev/.config/app", true)).toBe("-home-dev--config-app");
    expect(projectSlug("/home/dev/projects/casino_front", true)).toBe("-home-dev-projects-casino-front");
  });
});

describe("resolveHostMemoryDirs", () => {
  test("finds the plain slug directory", () => {
    const dir = seedMemory("-home-dev-projects-app", { "a.md": "x" });
    expect(resolveHostMemoryDirs(configDir, projectDir)).toEqual([dir]);
  });

  test("finds the dot-folded variant", () => {
    const dir = seedMemory("-home-dev--config-app", { "a.md": "x" });
    expect(resolveHostMemoryDirs(configDir, "/home/dev/.config/app")).toContain(dir);
  });

  test("finds a directory the host renamed underscores in (the casino_front case)", () => {
    const dir = seedMemory("-home-dev-projects-casino-front", { "a.md": "x" });
    expect(resolveHostMemoryDirs(configDir, "/home/dev/projects/casino_front")).toContain(dir);
  });

  test("returns nothing when the project has no memory", () => {
    seedMemory("-home-dev-projects-other", { "a.md": "x" });
    expect(resolveHostMemoryDirs(configDir, projectDir)).toEqual([]);
  });

  test("never throws on a missing config tree", () => {
    expect(resolveHostMemoryDirs(join(root, "nope"), projectDir)).toEqual([]);
    expect(resolveHostMemoryDirs("", projectDir)).toEqual([]);
    expect(resolveHostMemoryDirs(configDir, undefined)).toEqual([]);
  });
});

describe("listHostMemoryFiles", () => {
  test("lists markdown only", () => {
    seedMemory("-home-dev-projects-app", {
      "MEMORY.md": "- [Deploy](deploy.md)",
      "deploy.md": "deploy notes",
      "notes.txt": "ignored",
    });
    const files = listHostMemoryFiles(configDir, projectDir).map(f => f.split("/").pop());
    expect(files.sort()).toEqual(["MEMORY.md", "deploy.md"]);
  });
});

describe("searchAutoMemory reaches host memory", () => {
  test("a curated memory file is findable — the regression this fixes", () => {
    seedMemory("-home-dev-projects-app", {
      "cache-ttl.md": "---\nname: cache-ttl\n---\n\nWe decided the fetch cache TTL is 5 seconds.",
    });

    const adapter = {
      getConfigDir: () => configDir,
      getInstructionFiles: () => ["CLAUDE.md"],
      // The historical namespace — deliberately pointed somewhere empty, which
      // is exactly the production situation.
      getMemoryDir: () => join(configDir, "memory", "deadbeefdeadbeef"),
    };

    const hits = searchAutoMemory(["cache TTL"], 5, projectDir, configDir, adapter);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toContain("5 seconds");
    expect(hits[0].origin).toBe("auto-memory");
  });

  test("memory from another project stays invisible (#663 scoping)", () => {
    seedMemory("-home-dev-projects-other", {
      "secret.md": "The other project's cache TTL is 99 seconds.",
    });
    const adapter = {
      getConfigDir: () => configDir,
      getInstructionFiles: () => ["CLAUDE.md"],
      getMemoryDir: () => join(configDir, "memory", "deadbeefdeadbeef"),
    };
    const hits = searchAutoMemory(["cache TTL"], 5, projectDir, configDir, adapter);
    expect(hits.every(h => !h.content.includes("99 seconds"))).toBe(true);
  });
});

describe("indexHostMemory", () => {
  test("indexes each memory file under a memory: label", () => {
    seedMemory("-home-dev-projects-app", { "a.md": "alpha", "MEMORY.md": "- [A](a.md)" });
    const calls: Array<{ path?: string; source?: string }> = [];
    const store = { index: (o: { path?: string; source?: string }) => { calls.push(o); return {}; } };

    expect(indexHostMemory({ store, configDir, projectDir })).toBe(2);
    expect(calls.map(c => c.source).sort()).toEqual(["memory:MEMORY.md", "memory:a.md"]);
  });

  test("a throwing store does not abort the pass", () => {
    seedMemory("-home-dev-projects-app", { "a.md": "alpha", "b.md": "beta" });
    let seen = 0;
    const store = {
      index: (o: { path?: string }) => {
        seen++;
        if (o.path?.endsWith("a.md")) throw new Error("boom");
        return {};
      },
    };
    expect(indexHostMemory({ store, configDir, projectDir })).toBe(1);
    expect(seen).toBe(2);
  });

  test("no memory dir means no work and no error", () => {
    const store = { index: () => { throw new Error("should not be called"); } };
    expect(indexHostMemory({ store, configDir, projectDir })).toBe(0);
  });
});
