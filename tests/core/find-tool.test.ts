/**
 * `ctx_find` — the wiring, not the ranking.
 *
 * `tests/core/find.test.ts` owns the fusion; this file owns the two properties
 * that live only in the tool handler and cannot be observed from the pure
 * pipeline:
 *
 *  1. **fff is acquired lazily.** `type: "memory"` admits only the lexical and
 *     semantic signals, and acquiring a finder for it charged the call for a
 *     native index build and a full tree scan to serve signals fff does not
 *     provide. The handler no longer decides this itself — it hands `runFind` a
 *     seam and `runFind` calls it only when a signal fff serves survives the
 *     type table and the env switches. That indirection is exactly what this
 *     suite pins: it is invisible in the response, so only a call count proves
 *     it.
 *  2. **The response has a byte ceiling.** A tool that exists to keep raw
 *     output out of the context window must answer within a stated budget
 *     itself. 50 rows carrying whatever the store held is a page of text, and
 *     before the cap there was nothing between that and the conversation.
 */

import { describe, expect, test, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Counting acquisitions is the only way to see a call that does NOT happen, so
// the fff entry point is replaced before `src/tools/find.ts` resolves it.
const { acquireFinderMock } = vi.hoisted(() => ({
  acquireFinderMock: vi.fn(async () => ({
    ok: false as const,
    error: "stubbed finder",
    unavailable: true,
  })),
}));

vi.mock("../../src/fff/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/fff/index.js")>(
    "../../src/fff/index.js",
  );
  return { ...actual, acquireFinder: acquireFinderMock };
});

// Imported after vi.mock, so the handler closes over the stub.
import {
  budgetFindRows, registerCtxFind, FIND_MAX_TOTAL,
} from "../../src/tools/find.js";
import { CrossQueryDeduper } from "../../src/search/dedup.js";
import type { FindCandidate, FindStore } from "../../src/search/find.js";
import type { ToolDeps, ToolResult } from "../../src/tools/shared/deps.js";

// ─────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────

type Handler = (params: Record<string, unknown>) => Promise<ToolResult>;

function chunkRows(count: number, contentLength: number) {
  return Array.from({ length: count }, (_, i) => ({
    title: `Section ${i}`,
    source: "notes",
    content: `retry handling ${"x".repeat(contentLength)} ${i}`,
  }));
}

function fakeStore(rows: Array<Record<string, unknown>>): FindStore {
  return {
    searchWithFallbackMeta: () => ({
      results: rows,
      completeness: { shown: rows.length, poolSize: rows.length, saturated: false },
    }),
    rawDb: () => ({}),
  };
}

/**
 * Register the tool against a stub server and hand back its handler.
 *
 * The MCP server is three lines of it: `registerTool` is the entire surface
 * `registerCtxFind` touches, and a real server would only add a transport
 * between the assertion and the thing being asserted.
 */
function handlerFor(store: FindStore | null, snippetLimit?: number): Handler {
  let captured: Handler | null = null;
  const projectDir = mkdtempSync(join(tmpdir(), "ctx-find-tool-"));
  const deps = {
    server: {
      registerTool: (_name: string, _config: unknown, handler: Handler) => {
        captured = handler;
      },
    },
    getStore: () => {
      if (!store) throw new Error("no store");
      return store;
    },
    getProjectDir: () => projectDir,
    getSessionDbPath: () => join(projectDir, "session.db"),
    trackResponse: (_tool: string, response: ToolResult) => response,
    // Deliberately NOT the real window extractor: the budget must hold for a
    // caller-visible snippet of any size, and the real one would cap the body
    // at 300 bytes before the budget ever saw it.
    extractSnippet: (content: string) =>
      snippetLimit === undefined ? content : content.slice(0, snippetLimit),
  };
  registerCtxFind(deps as unknown as ToolDeps);
  if (!captured) throw new Error("ctx_find did not register");
  return captured;
}

function textOf(result: ToolResult): string {
  return result.content.map(c => c.text).join("");
}

function candidate(init: Partial<FindCandidate> & { title: string; content: string }): FindCandidate {
  return {
    key: `chunk:${init.title}`,
    kind: "chunk",
    source: "notes",
    signals: ["lexical"],
    ...init,
  } as FindCandidate;
}

// ─────────────────────────────────────────────────────────
// 1. Lazy acquisition
// ─────────────────────────────────────────────────────────

describe("ctx_find acquires fff only when a signal needs it", () => {
  test("type: \"memory\" never touches the finder", async () => {
    acquireFinderMock.mockClear();
    const handler = handlerFor(fakeStore(chunkRows(3, 20)));

    const result = await handler({ query: "retry handling", type: "memory" });

    expect(acquireFinderMock).not.toHaveBeenCalled();
    // And the call still answered — skipping fff must cost nothing the memory
    // signals could have provided.
    expect(textOf(result)).toContain("Section 0");
  });

  test("type: \"code\" does acquire it", async () => {
    acquireFinderMock.mockClear();
    const handler = handlerFor(fakeStore(chunkRows(3, 20)));

    await handler({ query: "retry handling", type: "code" });

    expect(acquireFinderMock).toHaveBeenCalledTimes(1);
  });

  test("one acquisition per call, shared by both fff arms", async () => {
    acquireFinderMock.mockClear();
    const handler = handlerFor(fakeStore(chunkRows(3, 20)));

    await handler({ query: "retry handling", type: "all" });

    expect(acquireFinderMock).toHaveBeenCalledTimes(1);
  });

  test("an unavailable finder degrades instead of failing the call", async () => {
    acquireFinderMock.mockClear();
    const handler = handlerFor(fakeStore(chunkRows(2, 20)));

    const result = await handler({ query: "retry handling", type: "all" });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Section 0");
  });
});

// ─────────────────────────────────────────────────────────
// 2. Byte budget and cross-row dedup
// ─────────────────────────────────────────────────────────

describe("budgetFindRows", () => {
  const snippet = (content: string) => content;

  test("admits rows in rank order until the cap, and says how many it dropped", () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      candidate({ title: `S${i}`, content: `${i} `.padEnd(1000, "y") }));

    const budgeted = budgetFindRows(rows, { query: "q", snippet, maxTotal: 4096 });

    expect(budgeted.rows.length).toBeGreaterThan(0);
    expect(budgeted.rows.length).toBeLessThan(rows.length);
    expect(budgeted.dropped).toBe(rows.length - budgeted.rows.length);
    // Rank order is preserved — the cap truncates the tail, it does not sample.
    expect(budgeted.rows[0].title).toBe("S0");
    expect(budgeted.rows[1].title).toBe("S1");
  });

  test("a single oversized row is still shown", () => {
    const rows = [candidate({ title: "huge", content: "z".repeat(200_000) })];

    const budgeted = budgetFindRows(rows, { query: "q", snippet, maxTotal: 1024 });

    // An empty answer would be the one outcome worse than an expensive one.
    expect(budgeted.rows).toHaveLength(1);
    expect(budgeted.dropped).toBe(0);
  });

  test("a byte-identical repeat becomes a pointer, and the footer accounts for it", () => {
    const body = "the same body twice";
    const rows = [
      candidate({ key: "file:src/a.ts", kind: "file", title: "src/a.ts", source: "file", content: body }),
      candidate({ key: "chunk:code:src/a.ts", title: "src/a.ts", source: "file", content: body }),
    ];

    const budgeted = budgetFindRows(rows, { query: "q", snippet });

    expect(budgeted.rows[0].content).toBe(body);
    expect(budgeted.rows[1].content).toBe(CrossQueryDeduper.pointerLine("q"));
    expect(budgeted.deduper.suppressedCount).toBe(1);
    expect(budgeted.deduper.footer()).toContain("Deduplicated");
  });

  test("a different window over the same chunk is kept and marked", () => {
    // Same chunk identity (source, title, first 120 bytes), different window —
    // the second row carries text the first did not show.
    const shared = "p".repeat(150);
    const rows = [
      candidate({ title: "src/a.ts", source: "file", content: `${shared} first window` }),
      candidate({ title: "src/a.ts", source: "file", content: `${shared} second window` }),
    ];

    const budgeted = budgetFindRows(rows, { query: "q", snippet });

    expect(budgeted.rows[1].content).toContain("second window");
    expect(budgeted.rows[1].content).toContain("further match");
    expect(budgeted.deduper.suppressedCount).toBe(0);
  });

  test("an empty body is left empty rather than replaced by a pointer", () => {
    const rows = [
      candidate({ title: "a", content: "" }),
      candidate({ title: "b", content: "" }),
    ];

    const budgeted = budgetFindRows(rows, { query: "q", snippet });

    expect(budgeted.rows.map(r => r.content)).toEqual(["", ""]);
    expect(budgeted.deduper.suppressedCount).toBe(0);
  });
});

describe("the ctx_find response stays inside its budget", () => {
  test("50 oversized rows are capped and the truncation is stated", async () => {
    const handler = handlerFor(fakeStore(chunkRows(60, 5000)));

    const result = await handler({ query: "retry handling", type: "memory", limit: 50 });
    const text = textOf(result);

    // Unbudgeted this response is ~300 KB. The tails (coverage, completeness,
    // the truncation note itself) sit outside the row budget, hence the slack.
    expect(text.length).toBeLessThan(FIND_MAX_TOTAL + 2048);
    expect(text).toContain("Output cap reached");
    expect(text).toContain("Section 0");
  });

  test("a small answer carries no cap note", async () => {
    const handler = handlerFor(fakeStore(chunkRows(3, 40)), 300);

    const text = textOf(await handler({ query: "retry handling", type: "memory" }));

    expect(text).not.toContain("Output cap reached");
    expect(text).not.toContain("Deduplicated");
  });
});
