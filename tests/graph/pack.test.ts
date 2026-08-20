/**
 * `ctx_pack` — the context package, and the promises it makes about itself.
 *
 * The tool's whole value is that a caller can hand the output to a subagent
 * without reading it first. That trust rests on four properties, and each is
 * asserted here on the returned text rather than on internals:
 *
 * 1. **The budget holds.** `budget` counts tokens and is what the caller pays.
 *    A package that overruns it has failed at the one thing that separates it
 *    from `cat`-ing three files together.
 * 2. **Slack is reallocated, not wasted.** A section that underfills must raise
 *    the others' caps — otherwise a project with an empty knowledge base gets
 *    70% of a package and pays for 100%.
 * 3. **Degradation is stated.** No index, empty knowledge base, or both: the
 *    package says which half is missing and what to run. Silence there is the
 *    failure mode that makes the receiving agent act on a partial picture.
 * 4. **Nothing is printed twice.** A symbol whose body is in section 2 must not
 *    return as an excerpt in section 3.
 *
 * Plus determinism, because a package that reshuffles between identical calls
 * cannot be diffed, cached, or trusted to mean the same thing twice.
 */

import { describe, test, expect, afterEach } from "vitest";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { openGraphDb, type GraphDbHandle } from "../../src/graph/db.js";
import { countTokens } from "../../src/session/tokenizer.js";
import {
  buildPack,
  DEFAULT_PACK_BUDGET,
  MAX_PACK_BUDGET,
  MIN_PACK_BUDGET,
  packToolEnabled,
  type PackChunk,
} from "../../src/tools/pack.js";
import { makeGraphFixture, type Fixture } from "./fixture.js";

const open: Array<{ dir: string; handle: GraphDbHandle | null }> = [];

afterEach(() => {
  while (open.length) {
    const entry = open.pop()!;
    try { entry.handle?.close(); } catch { /* already closed */ }
    try { rmSync(entry.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function openFixture(dir: string): GraphDbHandle {
  const result = openGraphDb(dir);
  if (!result.ok) throw new Error(`fixture did not open: ${result.reason}`);
  open.push({ dir, handle: result.handle });
  return result.handle;
}

/**
 * A repository with real files on disk, because `readSymbolBody` slices the
 * FILE, not the index — a fixture with rows but no files exercises only the
 * error path and would let a body bug through.
 */
function packFixture(): Fixture {
  const now = Date.now();
  const fixture = makeGraphFixture({
    nodes: [
      {
        id: "fn:retry", kind: "function", name: "retryRequest",
        qualifiedName: "src/retry.ts::retryRequest", filePath: "src/retry.ts",
        startLine: 1, endLine: 6,
        signature: "function retryRequest(req: Request, budget: number): Promise<Response>",
        isExported: true,
      },
      {
        id: "fn:backoff", kind: "function", name: "backoffDelay",
        qualifiedName: "src/retry.ts::backoffDelay", filePath: "src/retry.ts",
        startLine: 8, endLine: 11,
        signature: "function backoffDelay(attempt: number): number",
      },
      {
        id: "fn:log", kind: "function", name: "logLine",
        qualifiedName: "src/log.ts::logLine", filePath: "src/log.ts",
        startLine: 1, endLine: 3,
        signature: "function logLine(msg: string): void",
      },
      {
        id: "fn:handler", kind: "function", name: "handleRequest",
        qualifiedName: "src/server.ts::handleRequest", filePath: "src/server.ts",
        startLine: 1, endLine: 4,
        signature: "function handleRequest(req: Request): Response",
      },
    ],
    edges: [
      { source: "fn:handler", target: "fn:retry", kind: "calls" },
      { source: "fn:retry", target: "fn:backoff", kind: "calls" },
      { source: "fn:retry", target: "fn:log", kind: "calls" },
      { source: "fn:handler", target: "fn:log", kind: "calls" },
    ],
    // Indexed AFTER the files are written below, so `stale` is false and the
    // body blocks do not carry a staleness caveat that would confuse a reader.
    files: {
      "src/retry.ts": now + 60_000,
      "src/log.ts": now + 60_000,
      "src/server.ts": now + 60_000,
    },
  });

  mkdirSync(join(fixture.projectDir, "src"), { recursive: true });
  writeFileSync(
    join(fixture.projectDir, "src/retry.ts"),
    [
      "export async function retryRequest(req: Request, budget: number) {",
      "  for (let attempt = 0; attempt < budget; attempt++) {",
      "    const res = await fetch(req);",
      "    if (res.ok) return res;",
      "    await sleep(backoffDelay(attempt));",
      "  }",
      "}",
      "export function backoffDelay(attempt: number): number {",
      "  return Math.min(30_000, 2 ** attempt * 100);",
      "}",
      "",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(
    join(fixture.projectDir, "src/log.ts"),
    "export function logLine(msg: string): void {\n  process.stderr.write(msg + '\\n');\n}\n",
    "utf-8",
  );
  writeFileSync(
    join(fixture.projectDir, "src/server.ts"),
    "export function handleRequest(req: Request): Response {\n  return new Response('ok');\n}\n",
    "utf-8",
  );
  return fixture;
}

/**
 * A repository too wide to fit any one section's share.
 *
 * The small fixture above saturates: three files and four symbols fill the
 * structural sections long before a 3 000-token budget runs out, so extra
 * budget buys nothing and reallocation is invisible. Reallocation is only
 * observable when a section is BUDGET-limited rather than MATERIAL-limited,
 * which is what this fixture is for. No files on disk — the map and the
 * signature lines come from the index alone, and bodies are not the point here.
 */
function wideFixture(files = 60): Fixture {
  const nodes = [];
  const edges = [];
  for (let i = 0; i < files; i++) {
    const file = `src/mod${String(i).padStart(2, "0")}.ts`;
    nodes.push({
      id: `fn:run${i}`, kind: "function", name: `runStep${i}`,
      qualifiedName: `${file}::runStep${i}`, filePath: file,
      startLine: 1, endLine: 9,
      signature: `function runStep${i}(input: StepInput, ctx: RunContext): Promise<StepResult>`,
      isExported: true,
    });
    nodes.push({
      id: `fn:check${i}`, kind: "function", name: `checkStep${i}`,
      qualifiedName: `${file}::checkStep${i}`, filePath: file,
      startLine: 12, endLine: 18,
      signature: `function checkStep${i}(result: StepResult): boolean`,
    });
    if (i > 0) edges.push({ source: `fn:run${i}`, target: `fn:run${i - 1}`, kind: "calls" });
    edges.push({ source: `fn:run${i}`, target: `fn:check${i}`, kind: "calls" });
  }
  return makeGraphFixture({ nodes, edges });
}

function chunk(title: string, text: string, source = "notes"): PackChunk {
  return { title, source, text };
}

/** Excerpts big enough to actually consume a section's share of the budget. */
function bulkChunks(count = 8): PackChunk[] {
  const out: PackChunk[] = [];
  for (let i = 0; i < count; i++) {
    out.push(chunk(
      `Captured note ${i}`,
      `Observation ${i}: the pipeline stage reported a partial result and the supervisor `
      + "retried it without clearing the previous attempt's buffer, which is why the "
      + "downstream consumer saw duplicated records under load. The fix is to reset the "
      + `buffer at stage entry rather than at stage exit. Recorded during run ${i}.`,
      "capture",
    ));
  }
  return out;
}

/** Three ordinary excerpts that share nothing with the fixture's sources. */
function unrelatedChunks(): PackChunk[] {
  return [
    chunk(
      "Deploy runbook",
      "The staging deploy runs from CI. Roll back with `make rollback` and wait for the " +
      "health check to go green before announcing anything in the channel.",
    ),
    chunk(
      "Decision: retry budget",
      "We decided the retry budget belongs on the host config rather than the client, " +
      "because two clients against the same host must not each get a full budget.",
      "decision",
    ),
    chunk(
      "Open blocker",
      "The flake in the integration suite is still unexplained; it reproduces only under " +
      "concurrency above four.",
      "blocker",
    ),
  ];
}

describe("ctx_pack — the budget", () => {
  test("the assembled package never exceeds the stated budget", () => {
    const fixture = packFixture();
    const handle = openFixture(fixture.projectDir);

    // Swept across the range, because the failure mode is at the extremes: a
    // small budget is mostly frame, a large one lets every section fill.
    for (const budget of [512, 800, 1_500, 4_096, 12_000]) {
      const packed = buildPack({
        task: "retry request budget",
        budget,
        projectDir: fixture.projectDir,
        handle,
        chunks: unrelatedChunks(),
        chunkCount: 40,
      });
      expect(packed.tokens, `budget ${budget}`).toBeLessThanOrEqual(budget);
      // Measured on the returned bytes, not on the reported number — the
      // report and the payload disagreeing is exactly the bug this catches.
      expect(countTokens(packed.text), `text at budget ${budget}`).toBeLessThanOrEqual(budget);
    }
  });

  test("budget is clamped to the documented range rather than honoured blindly", () => {
    const fixture = packFixture();
    const handle = openFixture(fixture.projectDir);
    const base = {
      task: "retry", projectDir: fixture.projectDir, handle,
      chunks: [] as PackChunk[], chunkCount: 0,
    };

    expect(buildPack({ ...base, budget: 10 }).budget).toBe(MIN_PACK_BUDGET);
    expect(buildPack({ ...base, budget: 999_999 }).budget).toBe(MAX_PACK_BUDGET);
    expect(buildPack({ ...base, budget: 0 }).budget).toBe(DEFAULT_PACK_BUDGET);
  });

  test("a bigger budget buys more package, not the same package", () => {
    const fixture = packFixture();
    const handle = openFixture(fixture.projectDir);
    const at = (budget: number) => buildPack({
      task: "retry request", budget, projectDir: fixture.projectDir, handle,
      chunks: unrelatedChunks(), chunkCount: 40,
    });

    const small = at(600);
    const large = at(6_000);
    expect(large.tokens).toBeGreaterThan(small.tokens);
    expect(large.signaturesShown + large.bodiesShown + large.chunksShown)
      .toBeGreaterThanOrEqual(small.signaturesShown + small.bodiesShown + small.chunksShown);
  });
});

describe("ctx_pack — slack reallocation", () => {
  test("an empty knowledge base gives its share to the structural sections", () => {
    // Wide fixture on purpose: every section here has more material than its
    // share, so a section that underfills can only be underfilling because of
    // the budget, and the slack has somewhere to go.
    const fixture = wideFixture();
    const handle = openFixture(fixture.projectDir);
    const budget = 3_000;

    const withChunks = buildPack({
      task: "runStep pipeline", budget, projectDir: fixture.projectDir, handle,
      chunks: bulkChunks(), chunkCount: 400,
    });
    const withoutChunks = buildPack({
      task: "runStep pipeline", budget, projectDir: fixture.projectDir, handle,
      chunks: [], chunkCount: 0,
    });

    expect(withChunks.chunkTokens).toBeGreaterThan(0);
    expect(withoutChunks.chunkTokens).toBe(0);
    // The 30% the excerpts did not take must show up somewhere structural —
    // otherwise it was silently dropped, which is the bug.
    expect(withoutChunks.mapTokens + withoutChunks.symbolTokens)
      .toBeGreaterThan(withChunks.mapTokens + withChunks.symbolTokens);
    // And it must not have been spent twice.
    expect(withoutChunks.tokens).toBeLessThanOrEqual(budget);
  });

  test("a section that underfills raises the NEXT section's cap, not just the map", () => {
    // The forward flow, isolated: the same budget and the same excerpts, with
    // and without a graph. Without one, the map and symbol shares (70%) are
    // handed forward and the excerpt section must visibly grow on them.
    const fixture = wideFixture();
    const handle = openFixture(fixture.projectDir);
    const chunks = bulkChunks(60);

    const structural = buildPack({
      task: "runStep pipeline", budget: 2_400, projectDir: fixture.projectDir,
      handle, chunks, chunkCount: 400,
    });
    const chunksOnly = buildPack({
      task: "runStep pipeline", budget: 2_400, projectDir: fixture.projectDir,
      handle: null, chunks, chunkCount: 400,
    });

    expect(chunksOnly.chunkTokens).toBeGreaterThan(structural.chunkTokens);
    expect(chunksOnly.chunksShown).toBeGreaterThan(structural.chunksShown);
  });

  test("no index gives the map and symbol shares to the excerpts", () => {
    const fixture = packFixture();
    const handle = openFixture(fixture.projectDir);
    const budget = 3_000;
    const chunks = unrelatedChunks();

    const full = buildPack({
      task: "retry", budget, projectDir: fixture.projectDir, handle, chunks, chunkCount: 40,
    });
    const chunksOnly = buildPack({
      task: "retry", budget, projectDir: fixture.projectDir, handle: null, chunks, chunkCount: 40,
    });

    expect(chunksOnly.mapTokens).toBe(0);
    expect(chunksOnly.symbolTokens).toBe(0);
    expect(chunksOnly.chunksShown).toBeGreaterThanOrEqual(full.chunksShown);
    expect(chunksOnly.tokens).toBeLessThanOrEqual(budget);
  });

  test("leftover after all three sections widens the map rather than evaporating", () => {
    const fixture = packFixture();
    const handle = openFixture(fixture.projectDir);

    // A large budget against a four-symbol fixture: every section runs out of
    // material long before the budget runs out, so the wrap is the only thing
    // that can spend the remainder.
    const packed = buildPack({
      task: "retry", budget: 20_000, projectDir: fixture.projectDir, handle,
      chunks: unrelatedChunks(), chunkCount: 40,
    });
    // Every ranked file made it into the map — the wrap round re-rendered it at
    // the larger budget instead of leaving it at its 30% slice.
    expect(packed.filesMapped).toBe(3);
    expect(packed.tokens).toBeLessThanOrEqual(20_000);
  });
});

describe("ctx_pack — honest degradation", () => {
  test("no codegraph index: map and symbols drop out, and the package says so", () => {
    const packed = buildPack({
      task: "retry request", budget: 2_000, projectDir: "/nonexistent",
      handle: null, chunks: unrelatedChunks(), chunkCount: 40,
    });

    expect(packed.mapTokens).toBe(0);
    expect(packed.bodiesShown).toBe(0);
    expect(packed.chunksShown).toBeGreaterThan(0);
    expect(packed.degraded.join("\n")).toMatch(/No codegraph index/);
    expect(packed.text).toMatch(/codegraph init/);
    // The absent sections must not be advertised by a heading with nothing
    // under it — a heading is a claim about content.
    expect(packed.text).not.toContain("## 1. REPO MAP");
    expect(packed.text).not.toContain("## 2. SYMBOLS");
    expect(packed.text).toContain("## 3. EXCERPTS");
  });

  test("empty knowledge base: excerpts drop out, and the package names that", () => {
    const fixture = packFixture();
    const handle = openFixture(fixture.projectDir);
    const packed = buildPack({
      task: "retry request", budget: 3_000, projectDir: fixture.projectDir,
      handle, chunks: [], chunkCount: 0,
    });

    expect(packed.chunksShown).toBe(0);
    expect(packed.degraded.join("\n")).toMatch(/knowledge base for this project is empty/i);
    expect(packed.text).not.toContain("## 3. EXCERPTS");
    // Structure is still there — the empty half must not take the other down.
    expect(packed.text).toContain("## 1. REPO MAP");
    expect(packed.mapTokens).toBeGreaterThan(0);
  });

  test("an empty index is not reported as an empty knowledge base", () => {
    // A miss against a populated base and an empty base are different problems
    // with different fixes; telling a user to index what they already indexed
    // sends them the wrong way.
    const fixture = packFixture();
    const handle = openFixture(fixture.projectDir);
    const packed = buildPack({
      task: "retry", budget: 2_000, projectDir: fixture.projectDir,
      handle, chunks: [], chunkCount: 500,
    });
    expect(packed.degraded.join("\n")).toMatch(/nothing in it matches/);
    expect(packed.degraded.join("\n")).not.toMatch(/is empty, so section 3 is absent/);
  });

  test("both halves missing: the package admits it is empty rather than posing", () => {
    const packed = buildPack({
      task: "anything", budget: 1_000, projectDir: "/nonexistent",
      handle: null, chunks: [], chunkCount: 0,
    });
    expect(packed.degraded).toHaveLength(2);
    expect(packed.text).toMatch(/No codegraph index/);
    expect(packed.text).toMatch(/knowledge base for this project is empty/i);
    expect(packed.text).not.toContain("## 1. REPO MAP");
    expect(packed.text).not.toContain("## 3. EXCERPTS");
  });
});

describe("ctx_pack — deduplication", () => {
  test("an excerpt repeating a printed body is dropped, and the drop is stated", () => {
    const fixture = packFixture();
    const handle = openFixture(fixture.projectDir);

    // Verbatim the source of `backoffDelay`, re-indented — dedup must be
    // whitespace-insensitive, because a capture rarely preserves indentation.
    const duplicate = chunk(
      "src/retry.ts capture",
      "export function backoffDelay(attempt: number): number {\n" +
      "        return Math.min(30_000, 2 ** attempt * 100);\n" +
      "}",
      "capture",
    );

    const packed = buildPack({
      task: "backoffDelay retry", budget: 4_096, projectDir: fixture.projectDir,
      handle, chunks: [duplicate, ...unrelatedChunks()], chunkCount: 40,
    });

    expect(packed.bodiesShown).toBeGreaterThan(0);
    expect(packed.chunksSuppressed).toBeGreaterThanOrEqual(1);
    // The body's text appears exactly once in the package.
    const occurrences = packed.text.split("2 ** attempt * 100").length - 1;
    expect(occurrences).toBe(1);
    expect(packed.text).toMatch(/already printed above as a symbol body/);
  });

  test("unrelated excerpts survive dedup", () => {
    const fixture = packFixture();
    const handle = openFixture(fixture.projectDir);
    const packed = buildPack({
      task: "retry request", budget: 6_000, projectDir: fixture.projectDir,
      handle, chunks: unrelatedChunks(), chunkCount: 40,
    });
    expect(packed.chunksSuppressed).toBe(0);
    expect(packed.chunksShown).toBe(3);
  });
});

describe("ctx_pack — the package is a prompt", () => {
  test("each block names its own kind, so nothing can be mistaken for source", () => {
    const fixture = packFixture();
    const handle = openFixture(fixture.projectDir);
    const packed = buildPack({
      task: "retry request budget", budget: 6_000, projectDir: fixture.projectDir,
      handle, chunks: unrelatedChunks(), chunkCount: 40,
    });

    expect(packed.text).toContain("# Context package");
    expect(packed.text).toContain("TASK: retry request budget");
    expect(packed.text).toMatch(/^SIGNATURE {2}/m);
    expect(packed.text).toMatch(/^BODY {2}/m);
    expect(packed.text).toMatch(/^EXCERPT {2}/m);
    // The legend that lets the receiving agent tell them apart.
    expect(packed.text).toContain("SIGNATURE — a declaration only");
    expect(packed.text).toContain("BODY — verbatim source");
    expect(packed.text).toContain("EXCERPT — text captured earlier");
    // Bodies carry their line range, so a claim can be checked against the file.
    expect(packed.text).toMatch(/BODY {2}src\/retry\.ts::\w+ {2}src\/retry\.ts:\d+-\d+/);
  });

  test("the notes account for the budget and point at the next tool", () => {
    const fixture = packFixture();
    const handle = openFixture(fixture.projectDir);
    const packed = buildPack({
      task: "retry", budget: 4_096, projectDir: fixture.projectDir,
      handle, chunks: unrelatedChunks(), chunkCount: 40,
    });
    expect(packed.text).toContain("## NOTES");
    expect(packed.text).toMatch(/Budget 4096 tokens\. Map \d+, symbols \d+/);
    expect(packed.text).toMatch(/ctx_graph|ctx_find|ctx_search/);
  });
});

describe("ctx_pack — determinism", () => {
  test("the same inputs produce byte-identical output", () => {
    const fixture = packFixture();
    const handle = openFixture(fixture.projectDir);
    const call = () => buildPack({
      task: "retry request budget", budget: 4_096, projectDir: fixture.projectDir,
      handle, chunks: unrelatedChunks(), chunkCount: 40,
    });

    const a = call();
    const b = call();
    const c = call();
    expect(b.text).toBe(a.text);
    expect(c.text).toBe(a.text);
    expect(b.tokens).toBe(a.tokens);
  });

  test("a different task produces a different package", () => {
    const fixture = packFixture();
    const handle = openFixture(fixture.projectDir);
    const at = (task: string) => buildPack({
      task, budget: 4_096, projectDir: fixture.projectDir,
      handle, chunks: unrelatedChunks(), chunkCount: 40,
    }).text;

    expect(at("retry backoff")).not.toBe(at("logLine stderr"));
  });
});

describe("ctx_pack — the env switch", () => {
  test("CONTEXT_MODE_PACK=0 takes the tool off the surface", () => {
    expect(packToolEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(packToolEnabled({ CONTEXT_MODE_PACK: "0" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(packToolEnabled({ CONTEXT_MODE_PACK: "1" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
});
