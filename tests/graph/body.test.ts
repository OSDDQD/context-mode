/**
 * `ctx_graph action: "body"` — the third level of answer.
 *
 * The failure this action exists to prevent is a Read of a whole file to see
 * one function. The failures IT can introduce are subtler and are what these
 * tests pin down: returning the wrong lines from a stale index, returning four
 * bodies for an ambiguous name, and returning a two-thousand-line class as if
 * that were an improvement on the Read.
 */

import { describe, test, expect, afterEach } from "vitest";
import { rmSync, utimesSync } from "node:fs";

import { openGraphDb, type GraphDbHandle } from "../../src/graph/db.js";
import { readSymbolBody } from "../../src/graph/body.js";
import { runSqlAction } from "../../src/tools/graph.js";
import { makeGraphFixture, writeProjectFile } from "./fixture.js";

const open: Array<{ dir: string; handle: GraphDbHandle }> = [];

afterEach(() => {
  while (open.length) {
    const entry = open.pop()!;
    try { entry.handle.close(); } catch { /* already closed */ }
    try { rmSync(entry.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function openFixture(dir: string): GraphDbHandle {
  const result = openGraphDb(dir);
  if (!result.ok) throw new Error(`fixture did not open: ${result.reason}`);
  open.push({ dir, handle: result.handle });
  return result.handle;
}

function text(result: { content: Array<{ text: string }> }): string {
  return result.content.map(c => c.text).join("\n");
}

/** Lines 1..n of a file, each one identifiable by its own number. */
function numbered(n: number, prefix = "line"): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n");
}

describe("body — resolution", () => {
  test("a uniquely resolved symbol returns exactly its indexed line range", () => {
    const fx = makeGraphFixture({
      nodes: [{
        id: "fn:target", kind: "function", name: "target",
        qualifiedName: "src/a.ts::target", filePath: "src/a.ts",
        startLine: 3, endLine: 5, signature: "function target(): void",
      }],
      files: { "src/a.ts": Date.now() + 60_000 },
    });
    writeProjectFile(fx.projectDir, "src/a.ts", numbered(8));
    const handle = openFixture(fx.projectDir);

    const out = text(runSqlAction(handle, fx.projectDir, { action: "body", symbol: "target" }));
    expect(out).toContain("line 3");
    expect(out).toContain("line 5");
    // The lines outside the range are the whole point — they must not be here.
    expect(out).not.toContain("line 2");
    expect(out).not.toContain("line 6");
  });

  test("an ambiguous name lists the candidates instead of picking or concatenating", () => {
    const fx = makeGraphFixture({
      nodes: [
        {
          id: "fn:save-a", kind: "function", name: "save",
          qualifiedName: "src/a.ts::save", filePath: "src/a.ts", startLine: 1, endLine: 2,
        },
        {
          id: "fn:save-b", kind: "function", name: "save",
          qualifiedName: "src/b.ts::save", filePath: "src/b.ts", startLine: 1, endLine: 2,
        },
      ],
    });
    writeProjectFile(fx.projectDir, "src/a.ts", "ALPHA_BODY\nALPHA_TAIL\n");
    writeProjectFile(fx.projectDir, "src/b.ts", "BETA_BODY\nBETA_TAIL\n");
    const handle = openFixture(fx.projectDir);

    const out = text(runSqlAction(handle, fx.projectDir, { action: "body", symbol: "save" }));
    expect(out).toContain("matches 2 symbols");
    expect(out).toContain("src/a.ts::save");
    expect(out).toContain("src/b.ts::save");
    // Neither body is returned: an arbitrary pick is wrong, and both is a flood.
    expect(out).not.toContain("ALPHA_BODY");
    expect(out).not.toContain("BETA_BODY");
  });

  test("an unknown symbol says so and points at the action that finds names", () => {
    const fx = makeGraphFixture({
      nodes: [{
        id: "fn:a", kind: "function", name: "alpha",
        qualifiedName: "src/a.ts::alpha", filePath: "src/a.ts", startLine: 1, endLine: 2,
      }],
    });
    const handle = openFixture(fx.projectDir);

    const out = text(runSqlAction(handle, fx.projectDir, { action: "body", symbol: "zzzNotHere" }));
    expect(out).toContain("No symbol named");
    expect(out).toContain("symbols");
  });

  test("`body` without a symbol is a caller error, not an empty answer", () => {
    const fx = makeGraphFixture({});
    const handle = openFixture(fx.projectDir);
    const result = runSqlAction(handle, fx.projectDir, { action: "body" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("needs a `symbol`");
  });
});

describe("body — staleness", () => {
  test("a file modified after indexing is flagged, not silently sliced", () => {
    const indexedAt = Date.now() - 60_000;
    const fx = makeGraphFixture({
      nodes: [{
        id: "fn:target", kind: "function", name: "target",
        qualifiedName: "src/a.ts::target", filePath: "src/a.ts", startLine: 2, endLine: 3,
      }],
      files: { "src/a.ts": indexedAt },
    });
    writeProjectFile(fx.projectDir, "src/a.ts", numbered(6));
    const handle = openFixture(fx.projectDir);

    const body = readSymbolBody(handle, {
      id: "fn:target", kind: "function", name: "target",
      qualifiedName: "src/a.ts::target", filePath: "src/a.ts",
      startLine: 2, endLine: 3, signature: null, docstring: null,
    });
    expect(body.stale).toBe(true);

    const out = text(runSqlAction(handle, fx.projectDir, { action: "body", symbol: "target" }));
    expect(out).toContain("modified since it was indexed");
    // The lines are still returned — the caller is warned, not stonewalled.
    expect(out).toContain("line 2");
  });

  test("a file older than its index row carries no staleness warning", () => {
    const fx = makeGraphFixture({
      nodes: [{
        id: "fn:target", kind: "function", name: "target",
        qualifiedName: "src/a.ts::target", filePath: "src/a.ts", startLine: 1, endLine: 2,
      }],
      files: { "src/a.ts": Date.now() + 60_000 },
    });
    const abs = writeProjectFile(fx.projectDir, "src/a.ts", numbered(4));
    const past = new Date(Date.now() - 300_000);
    utimesSync(abs, past, past);
    const handle = openFixture(fx.projectDir);

    const out = text(runSqlAction(handle, fx.projectDir, { action: "body", symbol: "target" }));
    expect(out).not.toContain("modified since it was indexed");
    expect(out).not.toContain("cannot confirm");
  });

  test("a file with no `files` row reports staleness as unknown, never as current", () => {
    const fx = makeGraphFixture({
      nodes: [{
        id: "fn:target", kind: "function", name: "target",
        qualifiedName: "src/a.ts::target", filePath: "src/a.ts", startLine: 1, endLine: 2,
      }],
      // No `files` entry at all.
    });
    writeProjectFile(fx.projectDir, "src/a.ts", numbered(4));
    const handle = openFixture(fx.projectDir);

    const out = text(runSqlAction(handle, fx.projectDir, { action: "body", symbol: "target" }));
    expect(out).toContain("cannot confirm");
  });

  test("a symbol whose file has vanished names the file rather than crashing", () => {
    const fx = makeGraphFixture({
      nodes: [{
        id: "fn:gone", kind: "function", name: "gone",
        qualifiedName: "src/gone.ts::gone", filePath: "src/gone.ts", startLine: 1, endLine: 2,
      }],
      files: { "src/gone.ts": Date.now() },
    });
    const handle = openFixture(fx.projectDir);

    const out = text(runSqlAction(handle, fx.projectDir, { action: "body", symbol: "gone" }));
    expect(out).toContain("could not be read");
    expect(out).toContain("codegraph index");
  });
});

describe("body — budget", () => {
  test("an oversized body is cut at the byte budget with an honest notice", () => {
    const fx = makeGraphFixture({
      nodes: [{
        id: "class:Big", kind: "class", name: "Big",
        qualifiedName: "src/big.ts::Big", filePath: "src/big.ts", startLine: 1, endLine: 2_000,
      }],
      files: { "src/big.ts": Date.now() + 60_000 },
    });
    // ~20 bytes per line × 2 000 lines — comfortably past any sane budget.
    writeProjectFile(fx.projectDir, "src/big.ts", numbered(2_000, "padded-source-line"));
    const handle = openFixture(fx.projectDir);

    const body = readSymbolBody(handle, {
      id: "class:Big", kind: "class", name: "Big",
      qualifiedName: "src/big.ts::Big", filePath: "src/big.ts",
      startLine: 1, endLine: 2_000, signature: null, docstring: null,
    }, { maxBytes: 500 });

    expect(body.truncated).toBe(true);
    expect(body.bytes).toBeLessThanOrEqual(500);
    expect(body.lastLine).toBeLessThan(2_000);
    // Whole lines only — a cut mid-line would leave a fragment with no newline
    // before it, and the last line here must still be a complete one.
    expect(body.text.split("\n").at(-1)).toMatch(/^padded-source-line \d+$/);

    const out = text(runSqlAction(handle, fx.projectDir, { action: "body", symbol: "Big" }));
    expect(out).toContain("cut at the");
    expect(out).toMatch(/showing lines 1-\d+ of 1-2000/);
  });

  test("a single line longer than the budget is returned rather than dropped", () => {
    const fx = makeGraphFixture({
      nodes: [{
        id: "fn:long", kind: "function", name: "long",
        qualifiedName: "src/long.ts::long", filePath: "src/long.ts", startLine: 1, endLine: 1,
      }],
      files: { "src/long.ts": Date.now() + 60_000 },
    });
    writeProjectFile(fx.projectDir, "src/long.ts", `${"x".repeat(4_000)}\n`);
    const handle = openFixture(fx.projectDir);

    const body = readSymbolBody(handle, {
      id: "fn:long", kind: "function", name: "long",
      qualifiedName: "src/long.ts::long", filePath: "src/long.ts",
      startLine: 1, endLine: 1, signature: null, docstring: null,
    }, { maxBytes: 100 });
    expect(body.text.length).toBe(4_000);
    expect(body.truncated).toBe(false);
  });

  test("a range beyond the end of the file says the file is shorter", () => {
    const fx = makeGraphFixture({
      nodes: [{
        id: "fn:over", kind: "function", name: "over",
        qualifiedName: "src/short.ts::over", filePath: "src/short.ts", startLine: 2, endLine: 40,
      }],
      files: { "src/short.ts": Date.now() + 60_000 },
    });
    writeProjectFile(fx.projectDir, "src/short.ts", numbered(4));
    const handle = openFixture(fx.projectDir);

    const out = text(runSqlAction(handle, fx.projectDir, { action: "body", symbol: "over" }));
    expect(out).toContain("the file ended at line 4");
    expect(out).not.toContain("cut at the");
  });

  test("a credential in the body is screened before it reaches the transcript", () => {
    // `body` reads straight off disk, so it bypasses `ContentStore.#screen` for
    // exactly the content most likely to hold a secret: the source someone
    // asked to see. The screening in `formatBody` is the only thing between a
    // hardcoded key and the conversation.
    const fx = makeGraphFixture({
      nodes: [{
        id: "fn:cfg", kind: "function", name: "cfg",
        qualifiedName: "src/cfg.ts::cfg", filePath: "src/cfg.ts", startLine: 1, endLine: 3,
      }],
      files: { "src/cfg.ts": Date.now() + 60_000 },
    });
    const secret = `sk-ant-api03-${"A1b2C3d4E5f6".repeat(8)}`;
    writeProjectFile(fx.projectDir, "src/cfg.ts", `const key = "${secret}";\nexport function cfg() {}\n`);
    const handle = openFixture(fx.projectDir);

    const out = text(runSqlAction(handle, fx.projectDir, { action: "body", symbol: "cfg" }));
    expect(out).toContain("const key");
    expect(out).not.toContain(secret);
  });

  test("a body containing a markdown fence cannot break out of the code block", () => {
    const fx = makeGraphFixture({
      nodes: [{
        id: "fn:fenced", kind: "function", name: "fenced",
        qualifiedName: "src/f.ts::fenced", filePath: "src/f.ts", startLine: 1, endLine: 3,
      }],
      files: { "src/f.ts": Date.now() + 60_000 },
    });
    writeProjectFile(fx.projectDir, "src/f.ts", "const doc = `\n```\n`;\n");
    const handle = openFixture(fx.projectDir);

    const out = text(runSqlAction(handle, fx.projectDir, { action: "body", symbol: "fenced" }));
    expect(out).toContain("````");
  });
});
