import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isIndexableSource, codeIndexQueuePath, drainCodeIndexQueue,
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
    const remaining = readFileSync(codeIndexQueuePath(dir), "utf-8").trim();
    expect(remaining).toBe(files[2]);
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
});
