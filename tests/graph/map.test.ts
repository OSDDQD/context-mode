/**
 * `ctx_graph action: "map"` — aider's repo map over codegraph's tables.
 *
 * Three properties make or break this action, and each is asserted on the
 * observable answer rather than on internals:
 *
 * 1. **Determinism.** A ranking that reshuffles between identical calls is a
 *    ranking nobody can act on, and float iteration plus Map ordering is exactly
 *    where that goes wrong.
 * 2. **The budget holds.** `budget` counts TOKENS and is what the caller pays.
 *    A map that overruns it has failed at the one job that distinguishes it from
 *    `ls -R`.
 * 3. **Focus actually steers.** Personalized PageRank is only worth its cost if
 *    a focus term moves its file above an unrelated hub.
 */

import { describe, test, expect, afterEach } from "vitest";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openGraphDb, notIndexedMessage, type GraphDbHandle } from "../../src/graph/db.js";
import {
  DEFAULT_BUDGET_TOKENS,
  MAX_ITERATIONS,
  renderRepoMap,
  repoMap,
} from "../../src/graph/map.js";
import { countTokens } from "../../src/session/tokenizer.js";
import { runSqlAction } from "../../src/tools/graph.js";
import { makeGraphFixture, type Fixture } from "./fixture.js";

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

/**
 * A repository with a deliberate shape:
 *
 * - `src/log.ts` is the HUB — three files call it, so plain PageRank puts it
 *   first. Nothing about it says "retry".
 * - `src/retry.ts` holds the retry machinery and is called only once, so it
 *   loses on connectivity alone and can only win on personalization.
 * - `src/unrelated.ts` is a leaf nobody calls, the control for both rankings.
 */
function repoFixture(): Fixture {
  return makeGraphFixture({
    nodes: [
      {
        id: "fn:retryRequest", kind: "function", name: "retryRequest",
        qualifiedName: "src/retry.ts::retryRequest", filePath: "src/retry.ts",
        startLine: 12, signature: "function retryRequest(fn: () => Promise<T>): Promise<T>",
        isExported: true,
      },
      {
        id: "cls:RetryBudget", kind: "class", name: "RetryBudget",
        qualifiedName: "src/retry.ts::RetryBudget", filePath: "src/retry.ts",
        startLine: 40, signature: "class RetryBudget", isExported: true,
      },
      {
        id: "fn:send", kind: "function", name: "sendRequest",
        qualifiedName: "src/http.ts::sendRequest", filePath: "src/http.ts",
        startLine: 5, signature: "function sendRequest(url: string): Promise<Response>",
        isExported: true,
      },
      {
        id: "fn:log", kind: "function", name: "log",
        qualifiedName: "src/log.ts::log", filePath: "src/log.ts",
        startLine: 3, signature: "function log(msg: string): void", isExported: true,
      },
      {
        id: "fn:parse", kind: "function", name: "parseConfig",
        qualifiedName: "src/config.ts::parseConfig", filePath: "src/config.ts",
        startLine: 7, signature: "function parseConfig(raw: string): Config", isExported: true,
      },
      {
        id: "fn:unused", kind: "function", name: "unusedHelper",
        qualifiedName: "src/unrelated.ts::unusedHelper", filePath: "src/unrelated.ts",
        startLine: 2, signature: "function unusedHelper(): void",
      },
    ],
    edges: [
      { source: "fn:send", target: "fn:retryRequest", kind: "calls" },
      { source: "fn:send", target: "fn:log", kind: "calls" },
      { source: "fn:parse", target: "fn:log", kind: "calls" },
      { source: "fn:retryRequest", target: "fn:log", kind: "calls" },
      { source: "fn:parse", target: "fn:send", kind: "imports" },
    ],
    files: {
      "src/retry.ts": Date.now() + 60_000,
      "src/http.ts": Date.now() + 60_000,
      "src/log.ts": Date.now() + 60_000,
      "src/config.ts": Date.now() + 60_000,
      "src/unrelated.ts": Date.now() + 60_000,
    },
  });
}

describe("map — ranking", () => {
  test("without a focus, the file the repository leans on hardest ranks first", () => {
    const fx = repoFixture();
    const handle = openFixture(fx.projectDir);
    const result = repoMap(handle);

    expect(result.totalFiles).toBe(5);
    expect(result.files[0]!.filePath).toBe("src/log.ts");
    // Nothing points at the leaf, so it takes only its restart mass.
    const leaf = result.files.find(f => f.filePath === "src/unrelated.ts")!;
    expect(leaf.rank).toBeLessThan(result.files[0]!.rank);
  });

  test("a focus term lifts its file above the unrelated hub", () => {
    const fx = repoFixture();
    const handle = openFixture(fx.projectDir);

    const plain = repoMap(handle);
    const focused = repoMap(handle, { focus: "retry" });

    expect(focused.focusMatches).toBeGreaterThan(0);
    const rank = (r: typeof plain, path: string): number =>
      r.files.findIndex(f => f.filePath === path);

    // The premise: without the focus, retry.ts loses to the hub.
    expect(rank(plain, "src/retry.ts")).toBeGreaterThan(rank(plain, "src/log.ts"));
    // The claim: with it, retry.ts wins — and unrelated.ts still loses to both.
    expect(rank(focused, "src/retry.ts")).toBeLessThan(rank(focused, "src/log.ts"));
    expect(rank(focused, "src/retry.ts")).toBeLessThan(rank(focused, "src/unrelated.ts"));
  });

  test("rank flows outward: the focus's caller gains even though it never matched", () => {
    const fx = repoFixture();
    const handle = openFixture(fx.projectDir);

    const plain = repoMap(handle);
    const focused = repoMap(handle, { focus: "retry" });
    const of = (r: typeof plain, path: string): number =>
      r.files.find(f => f.filePath === path)!.rank;

    // src/http.ts contains no "retry" token; it calls the file that does. That
    // adjacency is the whole difference between personalized PageRank and a
    // grep for the focus term.
    expect(focused.files.find(f => f.filePath === "src/http.ts")!.focusMatch).toBe(false);

    // Ranks are a normalised distribution, so concentrating mass on the focus
    // lowers every other file in absolute terms — comparing absolute ranks
    // across the two runs would measure the normalisation, not the flow. The
    // real claim is relative: the caller of the focused file pulls AWAY from an
    // unconnected leaf, which is what "adjacent to the match" has to mean.
    const share = (r: typeof plain): number => of(r, "src/http.ts") / of(r, "src/unrelated.ts");
    expect(share(focused)).toBeGreaterThan(share(plain));
  });

  test("a focus that matches nothing degrades to the unpersonalized ranking, and says so", () => {
    const fx = repoFixture();
    const handle = openFixture(fx.projectDir);

    const plain = repoMap(handle);
    const missed = repoMap(handle, { focus: "quantumfoobar" });

    expect(missed.focusMatches).toBe(0);
    expect(missed.files.map(f => f.filePath)).toEqual(plain.files.map(f => f.filePath));

    const out = text(runSqlAction(handle, fx.projectDir, {
      action: "map", focus: "quantumfoobar",
    }));
    expect(out).toContain("matched no file path or symbol name");
  });

  test("within a file, the symbol the repository calls outranks the one it does not", () => {
    const fx = repoFixture();
    const handle = openFixture(fx.projectDir);
    const result = repoMap(handle);

    const retry = result.files.find(f => f.filePath === "src/retry.ts")!;
    expect(retry.symbols[0]!.name).toBe("retryRequest");
  });

  test("iteration is capped, and a converged run reports itself as converged", () => {
    const fx = repoFixture();
    const handle = openFixture(fx.projectDir);

    expect(repoMap(handle).converged).toBe(true);
    // The cap is a CPU ceiling on a tool call, so it must actually bind.
    const capped = repoMap(handle, { maxIterations: 1 });
    expect(capped.iterations).toBe(1);
    expect(capped.converged).toBe(false);
    expect(repoMap(handle, { maxIterations: 10_000 }).iterations).toBeLessThanOrEqual(MAX_ITERATIONS);
  });
});

describe("map — determinism", () => {
  test("two calls over the same index produce byte-identical output", () => {
    const fx = repoFixture();
    const handle = openFixture(fx.projectDir);

    const a = renderRepoMap(repoMap(handle, { focus: "retry" }), { budget: 400 });
    const b = renderRepoMap(repoMap(handle, { focus: "retry" }), { budget: 400 });
    expect(a.text).toBe(b.text);
    expect(a.tokens).toBe(b.tokens);
  });

  test("files with identical rank are ordered by path, not by insertion", () => {
    // Two files, no edges at all: every rank is exactly the restart mass, so
    // only the tie-break decides the order.
    const fx = makeGraphFixture({
      nodes: [
        { id: "n:z", kind: "function", name: "z", qualifiedName: "src/z.ts::z", filePath: "src/z.ts", startLine: 1 },
        { id: "n:a", kind: "function", name: "a", qualifiedName: "src/a.ts::a", filePath: "src/a.ts", startLine: 1 },
      ],
    });
    const handle = openFixture(fx.projectDir);
    expect(repoMap(handle).files.map(f => f.filePath)).toEqual(["src/a.ts", "src/z.ts"]);
  });
});

describe("map — budget", () => {
  test("the packed map never exceeds the token budget it was given", () => {
    const fx = repoFixture();
    const handle = openFixture(fx.projectDir);
    const result = repoMap(handle);

    for (const budget of [64, 128, 400, DEFAULT_BUDGET_TOKENS]) {
      const rendered = renderRepoMap(result, { budget });
      expect(rendered.tokens).toBeLessThanOrEqual(budget);
      // And the count it reports is the real cost of the text it returned.
      expect(rendered.tokens).toBe(countTokens(rendered.text));
    }
  });

  test("a larger budget shows strictly more, and a small one says what it hid", () => {
    const fx = repoFixture();
    const handle = openFixture(fx.projectDir);
    const result = repoMap(handle);

    const small = renderRepoMap(result, { budget: 80 });
    const large = renderRepoMap(result, { budget: 4_000 });

    expect(large.filesShown).toBeGreaterThan(small.filesShown);
    expect(large.filesShown).toBe(result.files.length);
    expect(small.text).toContain("raise `budget` for more");
    expect(large.text).not.toContain("raise `budget` for more");
  });

  test("every emitted line is whole — the budget never cuts a signature in half", () => {
    const fx = repoFixture();
    const handle = openFixture(fx.projectDir);
    const rendered = renderRepoMap(repoMap(handle), { budget: 90 });

    // Each line is either a file header `path  (rank)`, an indented symbol
    // line, a footer in parentheses, or blank. A mid-signature cut matches none
    // of these, because the packer only ever appends complete lines.
    for (const line of rendered.text.split("\n")) {
      if (line === "") continue;
      expect(line).toMatch(/^(\S.*\s\(\d\.\d{4}(, focus)?\)|\s+\d+\s{2}.+|\(.*\))$/);
    }
  });

  test("the budget buys breadth before depth", () => {
    const fx = repoFixture();
    const handle = openFixture(fx.projectDir);
    const result = repoMap(handle);

    // src/retry.ts is the only file with two symbols. A depth-first packer
    // would spend the budget listing both before it ever named the second
    // file; a map has to name the files first. At a budget that fits three
    // entries, that means three FILES, not one file and its two symbols.
    const rendered = renderRepoMap(result, { budget: 120 });
    expect(rendered.filesShown).toBeGreaterThanOrEqual(2);
    expect(rendered.symbolsShown).toBe(rendered.filesShown);

    // With room to spare, the second symbol of the deep file does appear.
    const roomy = renderRepoMap(result, { budget: 4_000 });
    expect(roomy.symbolsShown).toBeGreaterThan(roomy.filesShown);
  });

  test("the last file shown is never a bare path with no symbol under it", () => {
    const fx = repoFixture();
    const handle = openFixture(fx.projectDir);

    // Sweep the budget range where the cut lands mid-file, so the header/symbol
    // admission rule is exercised at every boundary rather than at one.
    for (let budget = 60; budget <= 300; budget += 5) {
      const rendered = renderRepoMap(repoMap(handle), { budget });
      if (rendered.filesShown === 0) continue;
      const lines = rendered.text.split("\n").filter(l => l !== "" && !l.startsWith("("));
      expect(lines.at(-1)).toMatch(/^\s+\d+\s{2}/);
    }
  });
});

describe("map — degradation", () => {
  test("an index with no declarations refuses honestly and names `codegraph init`", () => {
    const fx = makeGraphFixture({});
    const handle = openFixture(fx.projectDir);

    const result = runSqlAction(handle, fx.projectDir, { action: "map" });
    expect(result.isError).toBe(true);
    const out = text(result);
    expect(out).toContain("no declarations");
    expect(out).toContain("codegraph init");
  });

  test("a project with no index at all gets the existing run-codegraph-init message", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-graph-noindex-"));
    try {
      const opened = openGraphDb(dir);
      expect(opened.ok).toBe(false);
      expect(opened.ok === false && opened.reason).toBe("no-index");
      expect(notIndexedMessage(dir)).toContain("codegraph init");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("`import` and `file` nodes never occupy a map's budget", () => {
    const fx = makeGraphFixture({
      nodes: [
        {
          id: "import:zod", kind: "import", name: "zod",
          qualifiedName: "src/a.ts::zod", filePath: "src/a.ts", startLine: 1,
        },
        {
          id: "fn:real", kind: "function", name: "realWork",
          qualifiedName: "src/a.ts::realWork", filePath: "src/a.ts", startLine: 10,
          signature: "function realWork(): void",
        },
      ],
    });
    const handle = openFixture(fx.projectDir);
    const rendered = renderRepoMap(repoMap(handle), { budget: 4_000 });
    expect(rendered.text).toContain("realWork");
    expect(rendered.text).not.toContain("zod");
  });
});
