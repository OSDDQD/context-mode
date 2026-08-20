/**
 * The plugin's own output budget, on the two `ctx_graph` paths that had none.
 *
 * 1. `related` printed prose trimmed to 15 files / 20 symbols and then, in the
 *    same response, a JSON block carrying all 400 of each. The context-saving
 *    tool was the flood.
 * 2. `edgeBatch` capped its scan and said nothing, so a partial neighbourhood
 *    read exactly like a complete one.
 *
 * Both are asserted on the honest signal, not on the wording: the JSON is
 * parsed back and counted, and the truncation flag is followed from SQL to the
 * rendered answer.
 */

import { describe, test, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";

import {
  MISSING_INDEX_CONSEQUENCE,
  __resetMissingIndexNoticesForTests,
  firstMissingIndexNotice,
  notIndexedMessage,
  openGraphDb,
  type GraphDbHandle,
} from "../../src/graph/db.js";
import { related, type RelatedResult } from "../../src/graph/queries.js";
import {
  RELATED_FILE_LINES,
  RELATED_NODE_LINES,
  formatRelated,
} from "../../src/tools/graph.js";
import { defaultFixture } from "./fixture.js";

const open: Array<{ dir: string; handle: GraphDbHandle }> = [];

afterEach(() => {
  __resetMissingIndexNoticesForTests();
  while (open.length) {
    const entry = open.pop()!;
    try { entry.handle.close(); } catch { /* already closed */ }
    try { rmSync(entry.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function handle(): GraphDbHandle {
  const fx = defaultFixture();
  const res = openGraphDb(fx.projectDir);
  if (!res.ok) throw new Error(res.message);
  open.push({ dir: fx.projectDir, handle: res.handle });
  return res.handle;
}

/** A result far larger than either render limit, built without a 400-node fixture. */
function bigResult(nodeCount = 60, fileCount = 40): RelatedResult {
  return {
    seedFile: "src/seed.ts",
    seedNodes: 3,
    truncated: false,
    nodes: Array.from({ length: nodeCount }, (_, i) => ({
      id: `n${i}`,
      qualifiedName: `src/n${i}.ts::fn${i}`,
      kind: "function",
      filePath: `src/n${i}.ts`,
      startLine: i + 1,
      distance: 1,
      weight: (nodeCount - i) / 10,
      edges: 1,
      via: ["calls"],
      direction: "out" as const,
    })),
    files: Array.from({ length: fileCount }, (_, i) => ({
      filePath: `src/f${i}.ts`,
      weight: (fileCount - i) / 10,
      nodes: 1,
      minDistance: 1,
    })),
  };
}

/** Pull the fenced JSON block back out of the rendered answer. */
function parseBlock(rendered: string): RelatedResult {
  const match = rendered.match(/```json\n([\s\S]*?)\n```/);
  if (!match) throw new Error("no JSON block in the rendered output");
  return JSON.parse(match[1]!) as RelatedResult;
}

describe("related output budget", () => {
  test("the JSON block carries exactly the rows the prose showed", () => {
    const rendered = formatRelated(bigResult());
    const json = parseBlock(rendered);
    expect(json.nodes).toHaveLength(RELATED_NODE_LINES);
    expect(json.files).toHaveLength(RELATED_FILE_LINES);
    // Same rows, in the same order — a trimmed block that reordered would be a
    // different answer, not a shorter one.
    expect(json.nodes[0]!.id).toBe("n0");
    expect(json.files[0]!.filePath).toBe("src/f0.ts");
  });

  test("a trimmed block reports itself truncated and names the escape hatch", () => {
    const rendered = formatRelated(bigResult());
    expect(parseBlock(rendered).truncated).toBe(true);
    expect(rendered).toContain("showing 20/60 symbols and 15/40 files");
    expect(rendered).toContain("fullJson: true");
  });

  test("trimming is what keeps the answer small", () => {
    const trimmed = formatRelated(bigResult());
    const full = formatRelated(bigResult(), { full: true });
    expect(parseBlock(full).nodes).toHaveLength(60);
    expect(parseBlock(full).files).toHaveLength(40);
    // The untrimmed block was the majority of the response, which is the whole
    // reason this default changed.
    expect(trimmed.length).toBeLessThan(full.length / 2);
  });

  test("a result that fits is not annotated as trimmed", () => {
    const small = bigResult(3, 2);
    const rendered = formatRelated(small);
    expect(parseBlock(rendered).truncated).toBe(false);
    expect(rendered).not.toContain("fullJson: true");
    expect(parseBlock(rendered).nodes).toHaveLength(3);
  });

  test("an edge-capped walk says so in prose and in the JSON", () => {
    const rendered = formatRelated({ ...bigResult(2, 1), edgesTruncated: true });
    expect(rendered).toContain("edge scan hit its cap");
    expect(parseBlock(rendered).edgesTruncated).toBe(true);
  });
});

describe("edge scan truncation", () => {
  test("a complete scan reports edgesTruncated: false", () => {
    const result = related(handle(), { filePath: "src/server.ts", depth: 1 });
    expect(result.edgesTruncated).toBe(false);
    expect(result.nodes.length).toBeGreaterThan(0);
  });

  test("a capped scan admits the neighbourhood is partial", () => {
    // The seed file owns two outbound edges; a cap of one cannot see both.
    const capped = related(handle(), { filePath: "src/server.ts", depth: 1, edgeScanCap: 1 });
    expect(capped.edgesTruncated).toBe(true);

    // Both of those edges land on the same neighbour here, so the loss shows
    // up as evidence per neighbour rather than as a missing row — which is
    // exactly why the flag has to be carried explicitly.
    const complete = related(handle(), { filePath: "src/server.ts", depth: 1 });
    const edgesOf = (r: RelatedResult) => r.nodes.reduce((n, x) => n + x.edges, 0);
    expect(edgesOf(capped)).toBeLessThan(edgesOf(complete));
  });

  test("the cap trims the probe row rather than double-counting it", () => {
    // The probe fetches cap+1 rows to prove the arm was capped; if it survived
    // into the accumulator, one edge would be scored twice.
    const capped = related(handle(), { filePath: "src/server.ts", depth: 1, edgeScanCap: 1 });
    for (const node of capped.nodes) expect(node.edges).toBe(1);
  });

  test("an unindexed seed file reports no truncation of any kind", () => {
    const result = related(handle(), { filePath: "src/absent.ts" });
    expect(result.seedNodes).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.edgesTruncated).toBeFalsy();
  });

  test("both endpoints in the frontier are scored in both directions", () => {
    // `src/validate.ts` holds validateInput and parseBody, and validateInput
    // calls parseBody. Walking from the file must still reach handleRequest,
    // which calls into it — the inbound arm of the union.
    const result = related(handle(), { filePath: "src/validate.ts", depth: 1 });
    const ids = result.nodes.map(n => n.id);
    expect(ids).toContain("function:handler");
    expect(result.nodes.find(n => n.id === "function:handler")!.direction).toBe("in");
  });
});

describe("missing index is announced, not swallowed", () => {
  test("the first ask about an unindexed project explains what else goes blind", () => {
    expect(firstMissingIndexNotice("/tmp/never-indexed")).toBe(true);
    // Once per project: repeating the paragraph on every call would be the
    // plugin flooding the context it exists to protect.
    expect(firstMissingIndexNotice("/tmp/never-indexed")).toBe(false);
    expect(firstMissingIndexNotice("/tmp/other-project")).toBe(true);
  });

  test("the notice names the command and the collateral damage", () => {
    expect(notIndexedMessage("/tmp/p")).toContain("codegraph init /tmp/p");
    expect(MISSING_INDEX_CONSEQUENCE).toContain("ctx_find");
  });
});
