import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isIndexableSource, isSensitivePath, codeIndexQueuePath, drainCodeIndexQueue,
  pruneDeletedCodeSources, pruneForeignCodeSources, bootstrapCodeIndex,
  CODE_INDEX_BOOTSTRAP_STATE,
} from "../../src/session/code-index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ctx-code-index-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("isIndexableSource", () => {
  test("accepts source files", () => {
    expect(isIndexableSource("/repo/src/server.ts")).toBe(true);
    expect(isIndexableSource("/repo/docs/adr/0003.md")).toBe(true);
    expect(isIndexableSource("/repo/Dockerfile")).toBe(true);
  });

  test("refuses lockfiles, vendored trees and binaries", () => {
    expect(isIndexableSource("/repo/package-lock.json")).toBe(false);
    expect(isIndexableSource("/repo/node_modules/foo/index.js")).toBe(false);
    expect(isIndexableSource("/repo/dist/bundle.js")).toBe(false);
    expect(isIndexableSource("/repo/assets/logo.png")).toBe(false);
  });

  test("refuses relative paths — the queue only ever holds absolute ones", () => {
    expect(isIndexableSource("src/server.ts")).toBe(false);
  });
});

describe("drainCodeIndexQueue", () => {
  function fakeStore() {
    const indexed: Array<{ path?: string; source?: string }> = [];
    return {
      indexed,
      index(opts: { path?: string; source?: string }) { indexed.push(opts); return {}; },
    };
  }

  test("returns 0 when there is no queue", () => {
    const store = fakeStore();
    expect(drainCodeIndexQueue({ store, sessionsDir: dir })).toBe(0);
  });

  test("indexes queued files once, deduped, and clears the queue", () => {
    const file = join(dir, "sample.ts");
    writeFileSync(file, "export const a = 1;\n");
    writeFileSync(codeIndexQueuePath(dir), [file, file, join(dir, "gone.ts")].join("\n") + "\n");

    const store = fakeStore();
    const count = drainCodeIndexQueue({ store, sessionsDir: dir, projectDir: dir });

    expect(count).toBe(1);
    expect(store.indexed).toHaveLength(1);
    expect(store.indexed[0].source).toBe("code:sample.ts");
    expect(existsSync(codeIndexQueuePath(dir))).toBe(false);
  });

  test("respects maxFiles and pushes the overflow back onto the queue", () => {
    const files = ["a.ts", "b.ts", "c.ts"].map(n => {
      const p = join(dir, n);
      writeFileSync(p, "export const x = 1;\n");
      return p;
    });
    writeFileSync(codeIndexQueuePath(dir), files.join("\n") + "\n");

    const store = fakeStore();
    const count = drainCodeIndexQueue({ store, sessionsDir: dir, projectDir: dir, maxFiles: 2 });

    expect(count).toBe(2);
    // Overflow lands in this project's backlog, not the shared inbox.
    const remaining = readFileSync(codeIndexQueuePath(dir, dir), "utf-8").trim();
    expect(remaining).toBe(files[2]);
    expect(existsSync(codeIndexQueuePath(dir))).toBe(false);
  });

  test("the backlog is drained on the next pass", () => {
    const files = ["a.ts", "b.ts", "c.ts"].map(n => {
      const p = join(dir, n);
      writeFileSync(p, "export const x = 1;\n");
      return p;
    });
    writeFileSync(codeIndexQueuePath(dir), files.join("\n") + "\n");

    const store = fakeStore();
    drainCodeIndexQueue({ store, sessionsDir: dir, projectDir: dir, maxFiles: 2 });
    expect(drainCodeIndexQueue({ store, sessionsDir: dir, projectDir: dir })).toBe(1);
    expect(store.indexed.map(i => i.source)).toEqual(["code:a.ts", "code:b.ts", "code:c.ts"]);
  });

  test("a throwing store does not abort the drain", () => {
    const good = join(dir, "good.ts");
    const bad = join(dir, "bad.ts");
    writeFileSync(good, "export const a = 1;\n");
    writeFileSync(bad, "export const b = 2;\n");
    writeFileSync(codeIndexQueuePath(dir), [bad, good].join("\n") + "\n");

    let calls = 0;
    const store = {
      index(opts: { path?: string }) {
        calls++;
        if (opts.path === bad) throw new Error("boom");
        return {};
      },
    };

    expect(drainCodeIndexQueue({ store, sessionsDir: dir, projectDir: dir })).toBe(1);
    expect(calls).toBe(2);
  });

  test("a file deleted before the drain evicts whatever the index still holds", () => {
    const gone = join(dir, "removed.ts");
    writeFileSync(codeIndexQueuePath(dir), gone + "\n");

    const deleted: string[] = [];
    const store = {
      index() { return {}; },
      listSources: () => [],
      deleteSource(label: string) { deleted.push(label); return 1; },
    };

    expect(drainCodeIndexQueue({ store, sessionsDir: dir, projectDir: dir })).toBe(0);
    expect(deleted).toEqual(["code:removed.ts"]);
  });
});

describe("drainCodeIndexQueue — project scope", () => {
  function fakeStore() {
    const indexed: Array<{ path?: string; source?: string }> = [];
    return {
      indexed,
      index(opts: { path?: string; source?: string }) { indexed.push(opts); return {}; },
    };
  }

  let other: string;

  beforeEach(() => {
    other = mkdtempSync(join(tmpdir(), "ctx-code-index-other-"));
  });

  afterEach(() => {
    rmSync(other, { recursive: true, force: true });
    delete process.env.CONTEXT_MODE_CODE_INDEX_PROJECT_SCOPE;
  });

  test("a file from another project is not indexed and stays claimable", () => {
    const mine = join(dir, "mine.ts");
    const theirs = join(other, "theirs.ts");
    writeFileSync(mine, "export const a = 1;\n");
    writeFileSync(theirs, "export const b = 2;\n");
    writeFileSync(codeIndexQueuePath(dir), [mine, theirs].join("\n") + "\n");

    const store = fakeStore();
    expect(drainCodeIndexQueue({ store, sessionsDir: dir, projectDir: dir })).toBe(1);
    expect(store.indexed.map(i => i.source)).toEqual(["code:mine.ts"]);

    // Handed back to the shared inbox — and the owning project picks it up.
    expect(readFileSync(codeIndexQueuePath(dir), "utf-8").trim()).toBe(theirs);
    const ownerStore = fakeStore();
    expect(drainCodeIndexQueue({ store: ownerStore, sessionsDir: dir, projectDir: other })).toBe(1);
    expect(ownerStore.indexed[0].source).toBe("code:theirs.ts");
  });

  test("labels for own files stay relative", () => {
    const mine = join(dir, "nested", "deep.ts");
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(mine, "export const a = 1;\n");
    writeFileSync(codeIndexQueuePath(dir), mine + "\n");

    const store = fakeStore();
    drainCodeIndexQueue({ store, sessionsDir: dir, projectDir: dir });
    expect(store.indexed[0].source).toBe(join("code:nested", "deep.ts"));
  });

  test("CONTEXT_MODE_CODE_INDEX_PROJECT_SCOPE=0 restores the shared behaviour", () => {
    process.env.CONTEXT_MODE_CODE_INDEX_PROJECT_SCOPE = "0";
    const theirs = join(other, "theirs.ts");
    writeFileSync(theirs, "export const b = 2;\n");
    writeFileSync(codeIndexQueuePath(dir), theirs + "\n");

    const store = fakeStore();
    expect(drainCodeIndexQueue({ store, sessionsDir: dir, projectDir: dir })).toBe(1);
    expect(store.indexed[0].source).toBe(`code:${theirs}`);
  });
});

describe("pruneForeignCodeSources", () => {
  test("evicts absolute code: labels from outside the project, keeps the rest", () => {
    const deleted: string[] = [];
    const store = {
      index() { return {}; },
      listSources: () => [
        { label: "code:src/server.ts", chunkCount: 3 },
        { label: "code:/elsewhere/other-project/src/app.py", chunkCount: 5 },
        { label: `code:${join(dir, "inside.ts")}`, chunkCount: 1 },
        { label: "batch:some command", chunkCount: 2 },
      ],
      deleteSource(label: string) { deleted.push(label); return 1; },
    };

    expect(pruneForeignCodeSources({ store, projectDir: dir })).toBe(1);
    expect(deleted).toEqual(["code:/elsewhere/other-project/src/app.py"]);
  });

  test("does nothing without a project dir", () => {
    const store = {
      index() { return {}; },
      listSources: () => [{ label: "code:/elsewhere/app.py", chunkCount: 1 }],
      deleteSource() { return 1; },
    };
    expect(pruneForeignCodeSources({ store })).toBe(0);
  });
});

describe("isSensitivePath", () => {
  test("refuses credential files whatever their extension", () => {
    expect(isSensitivePath("/repo/.env")).toBe(true);
    expect(isSensitivePath("/repo/.env.production")).toBe(true);
    expect(isSensitivePath("/home/u/.ssh/id_ed25519")).toBe(true);
    expect(isSensitivePath("/home/u/.aws/credentials")).toBe(true);
    expect(isSensitivePath("/repo/certs/server.pem")).toBe(true);
    expect(isSensitivePath("/repo/service-account-prod.json")).toBe(true);
    expect(isSensitivePath("/repo/config/secrets.yml")).toBe(true);
    expect(isSensitivePath("/repo/deploy/api-keys.json")).toBe(true);
  });

  test("leaves ordinary code alone even when the name mentions secrets", () => {
    // Excluding these would blind search to the exact modules people ask
    // about — "where do we refresh the token" is a normal question.
    expect(isSensitivePath("/repo/src/auth/token-service.ts")).toBe(false);
    expect(isSensitivePath("/repo/src/password_reset.py")).toBe(false);
    expect(isSensitivePath("/repo/docs/secrets-rotation.md")).toBe(false);
  });

  test("isIndexableSource inherits the refusal", () => {
    expect(isIndexableSource("/repo/.env")).toBe(false);
    expect(isIndexableSource("/repo/config/credentials.json")).toBe(false);
    expect(isIndexableSource("/repo/src/auth/token-service.ts")).toBe(true);
  });
});

describe("pruneDeletedCodeSources", () => {
  test("evicts code sources whose file is gone and keeps the rest", () => {
    const alive = join(dir, "alive.ts");
    writeFileSync(alive, "export const a = 1;\n");

    const deleted: string[] = [];
    const store = {
      index() { return {}; },
      listSources: () => [
        { label: "code:alive.ts", chunkCount: 1 },
        { label: "code:vanished.ts", chunkCount: 1 },
        { label: "batch:git log", chunkCount: 4 },
      ],
      deleteSource(label: string) { deleted.push(label); return 1; },
    };

    expect(pruneDeletedCodeSources({ store, projectDir: dir })).toBe(1);
    expect(deleted).toEqual(["code:vanished.ts"]);
  });

  test("a store without the optional methods is a no-op, not a crash", () => {
    expect(pruneDeletedCodeSources({ store: { index() { return {}; } }, projectDir: dir })).toBe(0);
  });
});

describe("bootstrapCodeIndex", () => {
  function gitRepo(root: string, files: Record<string, string>): void {
    execFileSync("git", ["init", "-q", root], { stdio: "ignore" });
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
    }
    execFileSync("git", ["-C", root, "add", "-A"], { stdio: "ignore" });
  }

  test("seeds the index from tracked files, skipping noise and secrets", () => {
    const project = join(dir, "project");
    mkdirSync(project);
    gitRepo(project, {
      "src/server.ts": "export const server = 1;\n",
      "README.md": "# hi\n",
      ".env": "SECRET=1\n",
      "package-lock.json": "{}\n",
    });

    const indexed: string[] = [];
    const store = { index(o: { source?: string }) { indexed.push(o.source ?? ""); return {}; } };

    const count = bootstrapCodeIndex({ store, sessionsDir: dir, projectDir: project });

    expect(count).toBe(2);
    expect(indexed.sort()).toEqual(["code:README.md", "code:src/server.ts"]);
  });

  test("runs once per project — the marker stops a repeat pass", () => {
    const project = join(dir, "once");
    mkdirSync(project);
    gitRepo(project, { "a.ts": "export const a = 1;\n" });

    const store = { calls: 0, index() { this.calls++; return {}; } };
    expect(bootstrapCodeIndex({ store, sessionsDir: dir, projectDir: project })).toBe(1);
    expect(bootstrapCodeIndex({ store, sessionsDir: dir, projectDir: project })).toBe(0);
    expect(store.calls).toBe(1);
    expect(existsSync(join(dir, CODE_INDEX_BOOTSTRAP_STATE))).toBe(true);

    // force re-runs it, for an explicit re-seed.
    expect(bootstrapCodeIndex({ store, sessionsDir: dir, projectDir: project, force: true })).toBe(1);
  });

  test("honours the file budget", () => {
    const project = join(dir, "budget");
    mkdirSync(project);
    gitRepo(project, {
      "a.ts": "export const a = 1;\n",
      "b.ts": "export const b = 2;\n",
      "c.ts": "export const c = 3;\n",
    });

    const store = { calls: 0, index() { this.calls++; return {}; } };
    expect(bootstrapCodeIndex({ store, sessionsDir: dir, projectDir: project, maxFiles: 2 })).toBe(2);
  });

  test("spreads the seed across passes instead of stalling one tool call", () => {
    // Measured on this repo, seeding 200 files in one pass costs ~1.3s. The
    // plan is computed once and worked through a batch at a time, so no single
    // tool call pays for the whole tree.
    const project = join(dir, "batched");
    mkdirSync(project);
    gitRepo(project, Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`f${i}.ts`, `export const f${i} = ${i};\n`]),
    ));

    const store = { calls: 0, index() { this.calls++; return {}; } };
    expect(bootstrapCodeIndex({ store, sessionsDir: dir, projectDir: project, batchSize: 2 })).toBe(2);
    expect(bootstrapCodeIndex({ store, sessionsDir: dir, projectDir: project, batchSize: 2 })).toBe(2);
    expect(bootstrapCodeIndex({ store, sessionsDir: dir, projectDir: project, batchSize: 2 })).toBe(1);
    // Plan exhausted — further passes are free.
    expect(bootstrapCodeIndex({ store, sessionsDir: dir, projectDir: project, batchSize: 2 })).toBe(0);
    expect(store.calls).toBe(5);
  });

  test("the plan survives a restart — git ls-files runs once, not per pass", () => {
    const project = join(dir, "resume");
    mkdirSync(project);
    gitRepo(project, { "a.ts": "export const a = 1;\n", "b.ts": "export const b = 2;\n" });

    const store = { calls: 0, index() { this.calls++; return {}; } };
    bootstrapCodeIndex({ store, sessionsDir: dir, projectDir: project, batchSize: 1 });

    const state = JSON.parse(readFileSync(join(dir, CODE_INDEX_BOOTSTRAP_STATE), "utf-8"));
    expect(state[project].pending).toHaveLength(1);
    expect(state[project].done).toBe(false);
  });

  test("a non-git directory is marked seeded instead of retried forever", () => {
    const project = join(dir, "plain");
    mkdirSync(project);
    writeFileSync(join(project, "a.ts"), "export const a = 1;\n");

    const store = { calls: 0, index() { this.calls++; return {}; } };
    expect(bootstrapCodeIndex({ store, sessionsDir: dir, projectDir: project })).toBe(0);
    const state = JSON.parse(readFileSync(join(dir, CODE_INDEX_BOOTSTRAP_STATE), "utf-8"));
    expect(state[project]).toBeTruthy();
  });
});
