/**
 * ctx_read — the argument-free read path.
 *
 * Two things have to hold for this tool to be worth having, and they pull in
 * opposite directions. It must return a *slice* — materially less than the
 * file, or it is Read with extra steps — and the slice must be *selected*, so
 * that `intent` changes what comes back rather than decorating it. A tool that
 * returns the first N lines satisfies the first and fails the second, which is
 * why "smaller than the file" is never asserted on its own here.
 *
 * The third thing is that it stays on the same execution path as
 * `ctx_execute_file`. That is not testable from the outside — it is enforced
 * by construction, `registerCtxRead` taking the handler as a dependency — so
 * these tests drive the real registered handler through a stub server and let
 * the deps record what the underlying call received.
 */

import "../setup-home";
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  registerCtxRead,
  buildDefaultProgram,
  intentTerms,
  READ_MAX_BYTES,
  type ReadToolDeps,
  type ExecuteFileArgs,
} from "../../src/tools/read.js";
import type { ToolResult } from "../../src/tools/shared/deps.js";

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

interface Harness {
  call: Handler;
  /** Every set of arguments the underlying ctx_execute_file handler received. */
  seen: ExecuteFileArgs[];
  root: string;
  cleanup: () => void;
}

/**
 * Register the real tool against a stub server and a stub execute_file.
 *
 * The stub records the arguments and runs the generated program for real, in
 * this process, with FILE_CONTENT bound the way the executor binds it. That
 * keeps the assertions about the default program honest — it is the shipped
 * source that runs, not a paraphrase — without spawning a subprocess per case.
 */
function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "ctx-read-test-"));
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
      const absolute = join(root, args.path.replace(/^.*[/\\]/, ""));
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
        // Matches the executor's wrapper: utf-8, replacement chars and all.
        require("node:fs").readFileSync(absolute, "utf-8"),
        { log: (s: unknown) => printed.push(String(s)) },
        require,
      );
      return { content: [{ type: "text" as const, text: printed.join("\n") }] };
    },
  } as unknown as ReadToolDeps;

  registerCtxRead(deps);
  if (!handler) throw new Error("registerCtxRead never registered a handler");

  return {
    call: handler,
    seen,
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A source file big enough that returning it whole would be the failure. */
const SAMPLE = [
  "// header comment",
  'import { join } from "node:path";',
  "",
  "export function alpha(a: number): number {",
  "  return a + 1;",
  "}",
  "",
  "export function beta(b: string): string {",
  "  try {",
  "    return b.trim();",
  "  } catch (err) {",
  "    throw new Error(`beta failed: ${err}`);",
  "  }",
  "}",
  "",
  "class Gamma {",
  "  private value = 0;",
  "}",
  "",
  ...Array.from({ length: 200 }, (_, i) => `const filler${i} = ${i}; // padding line ${i}`),
].join("\n");

function withFile(h: Harness, name: string, body: string): string {
  const p = join(h.root, name);
  writeFileSync(p, body);
  return name;
}

function textOf(result: ToolResult): string {
  return result.content.map((c) => c.text).join("");
}

describe("ctx_read", () => {
  it("returns a slice materially smaller than the file", async () => {
    const h = harness();
    try {
      const name = withFile(h, "sample.ts", SAMPLE);
      const out = textOf(await h.call({ path: name }));
      expect(out.length).toBeLessThan(SAMPLE.length / 2);
      // And it is a slice of the right kind: the padding never comes back.
      expect(out).not.toContain("filler42");
      expect(out).toContain("STRUCTURE");
    } finally {
      h.cleanup();
    }
  });

  it("names the file's declarations rather than its first lines", async () => {
    const h = harness();
    try {
      const name = withFile(h, "sample.ts", SAMPLE);
      const out = textOf(await h.call({ path: name }));
      for (const decl of ["alpha", "beta", "Gamma"]) {
        expect(out, `structure omits ${decl}`).toContain(decl);
      }
      // The first N lines would have carried the import; the structure does not.
      expect(out).not.toContain('import { join }');
    } finally {
      h.cleanup();
    }
  });

  it("lets intent change which regions come back", async () => {
    const h = harness();
    try {
      const name = withFile(h, "sample.ts", SAMPLE);
      const errors = textOf(await h.call({ path: name, intent: "error handling" }));
      const padding = textOf(await h.call({ path: name, intent: "filler7" }));

      expect(errors).toContain("MATCHES");
      expect(errors).toContain("beta failed");
      expect(errors).not.toContain("padding line 7");

      expect(padding).toContain("padding line 7");
      expect(padding).not.toContain("beta failed");
    } finally {
      h.cleanup();
    }
  });

  it("gives a structural slice and says so when no intent is passed", async () => {
    const h = harness();
    try {
      const name = withFile(h, "sample.ts", SAMPLE);
      const out = textOf(await h.call({ path: name }));
      expect(out).toContain("STRUCTURE");
      expect(out).toContain("No intent given");
      expect(out).not.toContain("MATCHES");
    } finally {
      h.cleanup();
    }
  });

  it("reports an intent that matches nothing instead of returning the file", async () => {
    const h = harness();
    try {
      const name = withFile(h, "sample.ts", SAMPLE);
      const out = textOf(await h.call({ path: name, intent: "zzzznotpresent" }));
      expect(out).toContain("none of");
      expect(out.length).toBeLessThan(SAMPLE.length / 2);
    } finally {
      h.cleanup();
    }
  });

  it("reads structure out of markdown, JSON and CSV, not just code", async () => {
    const h = harness();
    try {
      const md = withFile(h, "doc.md", "# Title\n\nprose\n\n## Section A\n\nmore\n\n### Deep\n");
      expect(textOf(await h.call({ path: md }))).toContain("## Section A");

      const json = withFile(h, "data.json", JSON.stringify({ a: [1, 2, 3], b: { c: 1 }, d: "x" }));
      const jsonOut = textOf(await h.call({ path: json }));
      expect(jsonOut).toContain("a: array[3]");
      expect(jsonOut).toContain("b: object{1}");

      const csv = withFile(h, "rows.csv", "id,name,value\n1,a,2\n2,b,3\n");
      const csvOut = textOf(await h.call({ path: csv }));
      expect(csvOut).toContain("columns: 3");
      expect(csvOut).toContain("rows: 2");
    } finally {
      h.cleanup();
    }
  });

  it("refuses a missing path in one line, naming what it looked for", async () => {
    const h = harness();
    try {
      const result = await h.call({ path: "does/not/exist.ts" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("no such file");
      expect(textOf(result)).toContain("does/not/exist.ts");
      // The point of the pre-check: no subprocess was spent on it.
      expect(h.seen).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it("refuses a directory and points at the tool that handles trees", async () => {
    const h = harness();
    try {
      const result = await h.call({ path: "." });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("is a directory");
      expect(h.seen).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it("requires a path", async () => {
    const h = harness();
    try {
      const result = await h.call({});
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("`path` is required");
    } finally {
      h.cleanup();
    }
  });

  it("survives a binary file instead of printing its bytes", async () => {
    const h = harness();
    try {
      const p = join(h.root, "blob.bin");
      writeFileSync(p, Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x7f, 0x80]));
      const out = textOf(await h.call({ path: "blob.bin" }));
      expect(out).toContain("not text");
      expect(out).not.toContain("\0");
      expect(out.length).toBeLessThan(500);
    } finally {
      h.cleanup();
    }
  });

  it("refuses a file too large to slice, rather than loading it", async () => {
    const h = harness();
    try {
      // Sparse write: the size check reads stat, so the bytes need not exist.
      const p = join(h.root, "huge.log");
      const fd = require("node:fs").openSync(p, "w");
      require("node:fs").ftruncateSync(fd, READ_MAX_BYTES + 1);
      require("node:fs").closeSync(fd);

      const result = await h.call({ path: "huge.log" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("over the");
      expect(textOf(result)).toContain("ctx_execute_file");
      expect(h.seen).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it("clips a slice that would still be large, with a marker", async () => {
    const h = harness();
    try {
      // Every line is a declaration, so the structure block cannot be short.
      const dense = Array.from({ length: 4000 }, (_, i) => `export function fn${i}() {}`).join("\n");
      const name = withFile(h, "dense.ts", dense);
      const out = textOf(await h.call({ path: name }));
      expect(out).toContain("more");
      expect(out.length).toBeLessThan(dense.length / 4);
    } finally {
      h.cleanup();
    }
  });

  it("hands the underlying execute_file a program and never an intent", async () => {
    const h = harness();
    try {
      const name = withFile(h, "sample.ts", SAMPLE);
      await h.call({ path: name, intent: "exports" });
      expect(h.seen).toHaveLength(1);
      const args = h.seen[0];
      expect(args.language).toBe("javascript");
      expect(args.code.length).toBeGreaterThan(100);
      expect(args.toolName).toBe("ctx_read");
      // The two `intent` parameters mean different things — ctx_read's selects
      // the input, ctx_execute_file's indexes the output. Forwarding it would
      // swap one for the other silently.
      expect(args.intent).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });
});

describe("intentTerms", () => {
  it("drops noise words and keeps the specific ones", () => {
    expect(intentTerms("where is the timeout set")).toContain("timeout");
    expect(intentTerms("where is the timeout set")).not.toContain("is");
  });

  it("expands the handful of intents that match no literal token", () => {
    // "errors" never appears in the code that throws them.
    expect(intentTerms("errors")).toEqual(expect.arrayContaining(["catch", "throw"]));
  });

  it("is empty for no intent, which is what selects the structural slice", () => {
    expect(intentTerms(undefined)).toEqual([]);
    expect(intentTerms("")).toEqual([]);
  });
});

describe("buildDefaultProgram", () => {
  it("is plain source with no template-literal escaping hazards", () => {
    const program = buildDefaultProgram("exports");
    expect(program).not.toContain("`");
    expect(program).toContain("FILE_CONTENT");
    expect(program).toContain("STRUCTURE");
  });

  it("embeds the resolved terms rather than the raw intent string", () => {
    expect(buildDefaultProgram("errors")).toContain('"throw"');
  });
});
