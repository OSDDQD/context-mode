/**
 * ctx_read — the second read of a file nothing has touched.
 *
 * The first read of a file buys information. The second identical read buys
 * nothing and costs the same, and over a long session that repetition is one
 * of the largest single expenses in the context window. So `ctx_read` asks the
 * fs-bus re-read cache first and returns a one-line "unchanged" notice when it
 * gets a definite answer.
 *
 * Every case here exists because the short-circuit has exactly one failure
 * mode worth fearing: telling an agent "unchanged" about a file that did
 * change, so it reasons about bytes that are no longer on disk. The redundant
 * read a missed short-circuit costs is recoverable; that is not. Hence the
 * emphasis on the ways the answer must fall through — no watcher, a watcher
 * event, a different question, an explicit refresh.
 *
 * The wiring is real: `installFsWiring` over the fake native module from
 * `tests/fff/fake-native.ts`. Stubbing the cache would test this file against
 * a paraphrase of fs-bus rather than against fs-bus.
 */

import "../setup-home";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetFinderRegistryForTests } from "../../src/fff/finder.js";
import { __setFffLoaderForTests } from "../../src/fff/native.js";
import { resetSyncQueue, setSyncRunner } from "../../src/graph/daemon.js";
import {
  __resetPathCachesForTests,
  __resetReadCacheForTests,
  detachAllFsWiring,
  installFsWiring,
  readCacheStats,
} from "../../src/fs-bus/index.js";
import {
  registerCtxRead,
  type ExecuteFileArgs,
  type ReadToolDeps,
} from "../../src/tools/read.js";
import type { ToolResult } from "../../src/tools/shared/deps.js";
import { configureFakeNative, fakeLoader, fakeNativeState } from "../fff/fake-native.js";

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

interface Harness {
  call: Handler;
  /** Arguments every underlying `ctx_execute_file` call received. */
  seen: ExecuteFileArgs[];
  root: string;
}

let workspace: string;
let root: string;
let storageDir: string;

/**
 * Register the real tool against a stub executor that runs the generated
 * program for real, in-process, the way `src/executor.ts` binds it.
 *
 * `fail` makes the underlying call return an error result — a denied path, a
 * timeout, a crashed subprocess. No slice reached the caller in that case, so
 * nothing may be recorded as having been delivered.
 */
function harness(options: { fail?: boolean } = {}): Harness {
  const seen: ExecuteFileArgs[] = [];
  let handler: Handler | null = null;

  const deps = {
    server: {
      registerTool: (_name: string, _config: unknown, fn: Handler) => {
        handler = fn;
      },
    },
    getProjectDir: () => root,
    trackResponse: (_tool: string, response: ToolResult) => response,
    runExecuteFile: async (args: ExecuteFileArgs): Promise<ToolResult> => {
      seen.push(args);
      if (options.fail) {
        return { content: [{ type: "text" as const, text: "denied" }], isError: true };
      }
      const absolute = join(root, args.path);
      const printed: string[] = [];
      const fn = new Function(
        "FILE_CONTENT_PATH",
        "FILE_CONTENT",
        "console",
        "require",
        args.code,
      );
      fn(
        absolute,
        require("node:fs").readFileSync(absolute, "utf-8"),
        { log: (s: unknown) => printed.push(String(s)) },
        require,
      );
      return { content: [{ type: "text" as const, text: printed.join("\n") }] };
    },
  } as unknown as ReadToolDeps;

  registerCtxRead(deps);
  if (!handler) throw new Error("registerCtxRead never registered a handler");
  return { call: handler, seen, root };
}

/** Big enough that returning it a second time would be the failure. */
const SAMPLE = [
  'import { join } from "node:path";',
  "",
  "export function alpha(a: number): number {",
  "  return a + 1;",
  "}",
  "",
  "export function beta(b: string): string {",
  "  return b.trim();",
  "}",
  ...Array.from({ length: 120 }, (_, i) => `const filler${i} = ${i}; // padding ${i}`),
].join("\n");

function write(name: string, body: string): string {
  const abs = join(root, name);
  writeFileSync(abs, body, "utf-8");
  return abs;
}

function textOf(result: ToolResult): string {
  return result.content.map((c) => c.text).join("");
}

async function install(): Promise<void> {
  await installFsWiring({
    projectDir: root,
    env: {
      ...process.env,
      CONTEXT_MODE_FFF: "1",
      CONTEXT_MODE_FFF_WATCH: "1",
      CONTEXT_MODE_FFF_MAX_INSTANCES: "4",
    },
    finderOptions: { storageDir, watchDebounceMs: 0 },
  });
}

/** Deliver a watcher event for `absolute`, as the native layer would. */
function watcherSaw(absolute: string): void {
  const finder = fakeNativeState().instances[0];
  if (!finder) throw new Error("no fake native instance to emit from");
  finder.emit([{ path: absolute, kind: "modified" }]);
}

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "ctx-read-cache-")));
  root = realpathSync(mkdtempSync(join(workspace, "proj-")));
  storageDir = join(workspace, "store");
  delete process.env.CONTEXT_MODE_FFF;
  delete process.env.CONTEXT_MODE_FFF_WATCH;
  delete process.env.CONTEXT_MODE_READ_CACHE;
  delete process.env.CONTEXT_MODE_READ_CACHE_MAX;
  configureFakeNative({});
  __setFffLoaderForTests(fakeLoader());
  __resetPathCachesForTests();
  __resetReadCacheForTests();
  resetSyncQueue();
});

afterEach(() => {
  detachAllFsWiring();
  __resetReadCacheForTests();
  __resetPathCachesForTests();
  __resetFinderRegistryForTests();
  __setFffLoaderForTests(null);
  resetSyncQueue();
  setSyncRunner(null);
  delete process.env.CONTEXT_MODE_READ_CACHE;
  rmSync(workspace, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────
// The hit
// ─────────────────────────────────────────────────────────

describe("repeated ctx_read of an unchanged file", () => {
  it("returns the slice the first time and records the read", async () => {
    write("app.ts", SAMPLE);
    await install();
    const h = harness();

    const first = textOf(await h.call({ path: "app.ts" }));

    expect(first).toContain("STRUCTURE");
    expect(first).not.toContain("unchanged since your last read");
    expect(readCacheStats().records).toBe(1);
  });

  it("answers the identical second call with one line instead of the slice", async () => {
    write("app.ts", SAMPLE);
    await install();
    const h = harness();

    await h.call({ path: "app.ts" });
    const second = textOf(await h.call({ path: "app.ts" }));

    expect(second).toMatch(/unchanged since your last read \(hash [0-9a-f]{12}, \d+ lines, \d+ bytes\)/);
    expect(second).toContain("refresh: true");
    expect(second).not.toContain("STRUCTURE");
    // The point is not a shorter answer, it is an answer that costs no
    // subprocess and no bytes: the executor must not have run a second time.
    expect(h.seen).toHaveLength(1);
  });

  it("reports the same line count the first read printed", async () => {
    write("app.ts", SAMPLE);
    await install();
    const h = harness();

    const first = textOf(await h.call({ path: "app.ts" }));
    const second = textOf(await h.call({ path: "app.ts" }));

    const printed = /^(\d+) lines, (\d+) bytes/m.exec(first);
    const echoed = /\(hash [0-9a-f]+, (\d+) lines, (\d+) bytes\)/.exec(second);
    expect(printed).not.toBeNull();
    expect(echoed).not.toBeNull();
    expect(echoed?.[1]).toBe(printed?.[1]);
    expect(echoed?.[2]).toBe(printed?.[2]);
  });
});

// ─────────────────────────────────────────────────────────
// The fall-through — every one of these must hand back content
// ─────────────────────────────────────────────────────────

describe("ctx_read falls through to a real read", () => {
  it("when the watcher has seen the file change", async () => {
    const abs = write("app.ts", SAMPLE);
    await install();
    const h = harness();

    await h.call({ path: "app.ts" });
    writeFileSync(abs, `${SAMPLE}\nexport const added = 1;\n`, "utf-8");
    watcherSaw(abs);

    const after = textOf(await h.call({ path: "app.ts" }));
    expect(after).toContain("STRUCTURE");
    expect(after).toContain("added");
    expect(h.seen).toHaveLength(2);
  });

  it("when no live watcher covers the path, so the cache answers 'unknown'", async () => {
    write("app.ts", SAMPLE);
    await install();
    const h = harness();

    await h.call({ path: "app.ts" });
    // Nothing is watching any more: an entry recorded under the old wiring can
    // no longer promise anything, and 'unknown' is not 'unchanged'.
    detachAllFsWiring();

    const second = textOf(await h.call({ path: "app.ts" }));
    expect(second).toContain("STRUCTURE");
    expect(h.seen).toHaveLength(2);
    expect(readCacheStats().unchanged).toBe(0);
  });

  it("with no wiring at all, where every answer is 'unknown'", async () => {
    write("app.ts", SAMPLE);
    const h = harness();

    const first = textOf(await h.call({ path: "app.ts" }));
    const second = textOf(await h.call({ path: "app.ts" }));

    expect(first).toContain("STRUCTURE");
    expect(second).toContain("STRUCTURE");
    expect(h.seen).toHaveLength(2);
  });

  it("when the intent differs, because that is a different question", async () => {
    write("app.ts", SAMPLE);
    await install();
    const h = harness();

    await h.call({ path: "app.ts" });
    const withIntent = textOf(await h.call({ path: "app.ts", intent: "exports" }));

    // Same file, same hash, unchanged on disk — and still owed an answer,
    // because the caller has never been shown the regions it just asked for.
    expect(withIntent).toContain("MATCHES");
    expect(h.seen).toHaveLength(2);

    // The intent variant short-circuits on its own repeat, not on the other's.
    const repeated = textOf(await h.call({ path: "app.ts", intent: "exports" }));
    expect(repeated).toContain("unchanged since your last read");
    expect(repeated).toContain('intent "exports"');
    expect(h.seen).toHaveLength(2);
  });

  it("when the caller passes refresh: true", async () => {
    write("app.ts", SAMPLE);
    await install();
    const h = harness();

    await h.call({ path: "app.ts" });
    expect(textOf(await h.call({ path: "app.ts" }))).toContain("unchanged since your last read");

    const forced = textOf(await h.call({ path: "app.ts", refresh: true }));
    expect(forced).toContain("STRUCTURE");
    expect(forced).not.toContain("unchanged since your last read");
    expect(h.seen).toHaveLength(2);

    // And the forced read re-arms the cache rather than disabling it.
    expect(textOf(await h.call({ path: "app.ts" }))).toContain("unchanged since your last read");
  });

  it("when CONTEXT_MODE_READ_CACHE=0 switches the cache off entirely", async () => {
    process.env.CONTEXT_MODE_READ_CACHE = "0";
    write("app.ts", SAMPLE);
    await install();
    const h = harness();

    expect(textOf(await h.call({ path: "app.ts" }))).toContain("STRUCTURE");
    expect(textOf(await h.call({ path: "app.ts" }))).toContain("STRUCTURE");
    expect(h.seen).toHaveLength(2);
    expect(readCacheStats().records).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────
// What must never be recorded
// ─────────────────────────────────────────────────────────

describe("ctx_read records only what it delivered", () => {
  it("does not record a failed underlying call", async () => {
    write("app.ts", SAMPLE);
    await install();
    const h = harness({ fail: true });

    await h.call({ path: "app.ts" });
    expect(readCacheStats().records).toBe(0);

    // The next call must reach the executor: nothing was ever handed over.
    await h.call({ path: "app.ts" });
    expect(h.seen).toHaveLength(2);
  });

  it("does not record a path that never got as far as the executor", async () => {
    await install();
    const h = harness();

    const missing = await h.call({ path: "nope.ts" });
    expect(missing.isError).toBe(true);
    expect(h.seen).toHaveLength(0);
    expect(readCacheStats().records).toBe(0);
  });
});
