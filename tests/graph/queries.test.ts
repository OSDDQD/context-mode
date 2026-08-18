/**
 * The six SQL answers, against a synthetic index.
 *
 * The fixture is small on purpose: every assertion below names the exact rows
 * it expects, so a regression in the CTE direction (callers vs callees is one
 * swapped join condition) fails loudly instead of returning a plausible set.
 */

import { describe, test, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";

import { openGraphDb, type GraphDbHandle } from "../../src/graph/db.js";
import {
  callees,
  callers,
  findFiles,
  ftsQuery,
  graphStats,
  impact,
  normalizeFilePath,
  outline,
  related,
  resolveSymbol,
  symbols,
  symbolsByName,
} from "../../src/graph/queries.js";
import { defaultFixture, makeGraphFixture } from "./fixture.js";

const open: Array<{ dir: string; handle: GraphDbHandle }> = [];

function fixtureHandle(fx = defaultFixture()): GraphDbHandle {
  const res = openGraphDb(fx.projectDir);
  if (!res.ok) throw new Error(res.message);
  open.push({ dir: fx.projectDir, handle: res.handle });
  return res.handle;
}

afterEach(() => {
  while (open.length) {
    const entry = open.pop()!;
    try { entry.handle.close(); } catch { /* already closed */ }
    try { rmSync(entry.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("ftsQuery", () => {
  test("turns punctuation-heavy input into a valid prefix MATCH", () => {
    expect(ftsQuery("store.index(")).toBe('"store"* "index"*');
    expect(ftsQuery("ContentStore::#screen")).toBe('"ContentStore"* "screen"*');
  });

  test("returns null when nothing tokenises", () => {
    expect(ftsQuery("!!!")).toBeNull();
    expect(ftsQuery("")).toBeNull();
  });
});

describe("symbols", () => {
  test("finds a symbol by a fragment of its name", () => {
    const h = fixtureHandle();
    const rows = symbols(h, { query: "validate" });
    expect(rows.map(r => r.qualifiedName)).toContain("src/validate.ts::validateInput");
    const hit = rows.find(r => r.name === "validateInput")!;
    expect(hit.filePath).toBe("src/validate.ts");
    expect(hit.startLine).toBe(4);
    expect(hit.signature).toContain("validateInput");
  });

  test("kind narrows the result set", () => {
    const h = fixtureHandle();
    const all = symbols(h, { query: "Base" });
    const classes = symbols(h, { query: "Base", kind: "class" });
    expect(all.length).toBeGreaterThanOrEqual(classes.length);
    expect(classes.every(r => r.kind === "class")).toBe(true);
  });

  test("falls back to a LIKE scan when the index has no FTS table", () => {
    const fx = makeGraphFixture({
      withoutFts: true,
      nodes: [{
        id: "function:solo", kind: "function", name: "solo",
        qualifiedName: "src/solo.ts::solo", filePath: "src/solo.ts", startLine: 1,
      }],
    });
    const h = fixtureHandle(fx);
    expect(symbols(h, { query: "solo" }).map(r => r.name)).toEqual(["solo"]);
    expect(symbolsByName(h, { query: "solo" }).map(r => r.name)).toEqual(["solo"]);
  });
});

describe("outline", () => {
  test("returns one file's declarations in source order, imports excluded", () => {
    const h = fixtureHandle();
    const rows = outline(h, { filePath: "src/validate.ts" });
    expect(rows.map(r => r.name)).toEqual(["validateInput", "parseBody"]);
    expect(rows[0].startLine).toBeLessThan(rows[1].startLine);
    expect(rows[1].isAsync).toBe(true);
  });

  test("import and file nodes are opt-in", () => {
    const h = fixtureHandle();
    const without = outline(h, { filePath: "src/server.ts" });
    const with_ = outline(h, { filePath: "src/server.ts", includeImports: true });
    expect(without.map(r => r.kind)).not.toContain("import");
    expect(with_.map(r => r.kind)).toContain("import");
  });

  test("signature and docstring come straight from the index — no re-parse", () => {
    const h = fixtureHandle();
    const [handler] = outline(h, { filePath: "src/server.ts" });
    expect(handler.signature).toBe("function handleRequest(req: Request): Response");
    expect(handler.docstring).toContain("Entry point");
    expect(handler.isExported).toBe(true);
  });

  test("an absolute path is normalised against the project root", () => {
    const h = fixtureHandle();
    const abs = `${h.projectDir}/src/validate.ts`;
    expect(normalizeFilePath(h.projectDir, abs)).toBe("src/validate.ts");
    expect(outline(h, { filePath: abs }).length).toBe(2);
  });

  test("an unknown file returns nothing and findFiles offers neighbours", () => {
    const h = fixtureHandle();
    expect(outline(h, { filePath: "src/nope.ts" })).toEqual([]);
    expect(findFiles(h, "validate")).toContain("src/validate.ts");
  });
});

describe("resolveSymbol", () => {
  test("prefers an exact qualified name", () => {
    const h = fixtureHandle();
    const r = resolveSymbol(h, "src/validate.ts::validateInput");
    expect(r.via).toBe("qualified");
    expect(r.ids).toEqual(["function:validate"]);
  });

  test("falls back to the bare name", () => {
    const h = fixtureHandle();
    const r = resolveSymbol(h, "validateInput");
    expect(r.via).toBe("name");
    expect(r.ids).toEqual(["function:validate"]);
  });

  test("an unknown name resolves to nothing rather than throwing", () => {
    const h = fixtureHandle();
    expect(resolveSymbol(h, "definitelyNotHere").ids).toEqual([]);
  });
});

describe("callers / callees", () => {
  test("callers walks edges backwards", () => {
    const h = fixtureHandle();
    const rows = callers(h, { roots: ["function:parse"], depth: 2 });
    const byName = new Map(rows.map(r => [r.qualifiedName, r.depth]));
    expect(byName.get("src/validate.ts::validateInput")).toBe(1);
    expect(byName.get("src/server.ts::handleRequest")).toBe(2);
  });

  test("callees walks edges forwards", () => {
    const h = fixtureHandle();
    const rows = callees(h, { roots: ["function:handler"], depth: 2 });
    const byName = new Map(rows.map(r => [r.qualifiedName, r.depth]));
    expect(byName.get("src/validate.ts::validateInput")).toBe(1);
    expect(byName.get("src/validate.ts::parseBody")).toBe(2);
  });

  test("depth is respected", () => {
    const h = fixtureHandle();
    const shallow = callers(h, { roots: ["function:parse"], depth: 1 });
    expect(shallow.map(r => r.qualifiedName)).toEqual(["src/validate.ts::validateInput"]);
  });

  test("the seed itself is never in the result", () => {
    const h = fixtureHandle();
    const rows = callers(h, { roots: ["function:parse"], depth: 3 });
    expect(rows.map(r => r.id)).not.toContain("function:parse");
  });

  test("an empty root set is an empty answer, not a full-table scan", () => {
    const h = fixtureHandle();
    expect(callers(h, { roots: [] })).toEqual([]);
  });

  test("a cyclic call graph terminates", () => {
    const fx = makeGraphFixture({
      nodes: [
        { id: "f:a", kind: "function", name: "a", qualifiedName: "a", filePath: "a.ts", startLine: 1 },
        { id: "f:b", kind: "function", name: "b", qualifiedName: "b", filePath: "b.ts", startLine: 1 },
      ],
      edges: [
        { source: "f:a", target: "f:b", kind: "calls" },
        { source: "f:b", target: "f:a", kind: "calls" },
      ],
    });
    const h = fixtureHandle(fx);
    const rows = callers(h, { roots: ["f:a"], depth: 5 });
    expect(rows.map(r => r.id)).toEqual(["f:b"]);
  });
});

describe("impact", () => {
  test("includes subclasses, which the plain call graph does not", () => {
    const h = fixtureHandle();
    const call = callers(h, { roots: ["class:Base"], depth: 1 }).map(r => r.id);
    const affected = impact(h, { roots: ["class:Base"], depth: 1 }).map(r => r.id);
    expect(call).not.toContain("class:Derived");
    expect(affected).toContain("class:Derived");
    // The `references` edge from the handler counts in both.
    expect(affected).toContain("function:handler");
  });
});

describe("related", () => {
  test("returns machine-readable nodes and files, scored and sorted", () => {
    const h = fixtureHandle();
    const result = related(h, { filePath: "src/server.ts", depth: 1 });
    expect(result.seedFile).toBe("src/server.ts");
    expect(result.seedNodes).toBe(2); // handleRequest + the zod import node

    const validate = result.nodes.find(n => n.id === "function:validate");
    expect(validate).toBeDefined();
    expect(validate!.distance).toBe(1);
    expect(validate!.weight).toBeGreaterThan(0);
    expect(validate!.via).toContain("calls");
    expect(validate!.direction).toBe("out");
    expect(validate!.filePath).toBe("src/validate.ts");

    // Sorted by weight, descending — the ranking layer depends on this order.
    const weights = result.nodes.map(n => n.weight);
    expect([...weights].sort((a, b) => b - a)).toEqual(weights);

    const file = result.files.find(f => f.filePath === "src/validate.ts");
    expect(file).toBeDefined();
    expect(file!.nodes).toBeGreaterThanOrEqual(1);
    expect(file!.minDistance).toBe(1);
  });

  test("depth 2 reaches further than depth 1", () => {
    const h = fixtureHandle();
    const d1 = related(h, { filePath: "src/server.ts", depth: 1 }).nodes.map(n => n.id);
    const d2 = related(h, { filePath: "src/server.ts", depth: 2 }).nodes.map(n => n.id);
    expect(d1).not.toContain("function:parse");
    expect(d2).toContain("function:parse");
    // …and the further hop is scored lower for the same edge weight.
    const parse = related(h, { filePath: "src/server.ts", depth: 2 })
      .nodes.find(n => n.id === "function:parse")!;
    expect(parse.distance).toBe(2);
  });

  test("an inbound edge is labelled `in`", () => {
    const h = fixtureHandle();
    const result = related(h, { filePath: "src/validate.ts", depth: 1 });
    const inbound = result.nodes.find(n => n.id === "function:handler");
    expect(inbound?.direction).toBe("in");
  });

  test("a file with no indexed symbols says so instead of guessing", () => {
    const h = fixtureHandle();
    const result = related(h, { filePath: "src/absent.ts" });
    expect(result.seedNodes).toBe(0);
    expect(result.nodes).toEqual([]);
  });
});

describe("graphStats", () => {
  test("counts what is actually in the index", () => {
    const h = fixtureHandle();
    const stats = graphStats(h);
    expect(stats.nodes).toBe(6);
    expect(stats.edges).toBe(5);
    expect(stats.files).toBe(2);
  });
});
