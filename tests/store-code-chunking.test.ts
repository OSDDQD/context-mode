/**
 * Code-aware chunking (P2.2).
 *
 * Source files used to be chunked as if they were markdown: `#chunkMarkdown`
 * looks for `#` headings and blank-line paragraphs, finds neither in a `.ts`
 * file, and cuts wherever the byte cap lands — mid-function, under the title
 * "Untitled (7)". These tests pin the replacement: cuts at declaration
 * boundaries, doc comments travelling with the declaration they describe,
 * a fallback for anything unrecognisable, and the byte cap holding throughout.
 *
 * RED/GREEN: setting CONTEXT_MODE_CODE_CHUNKING=0 (the documented escape
 * hatch, exercised by its own test below) turns every assertion here that is
 * about structure back into the old behaviour and fails the suite.
 */
import { describe, test, beforeEach, afterEach } from "vitest";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ContentStore } from "../src/store.js";
import { makeGraphFixture, type FixtureNode } from "./graph/fixture.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Mirrors the private MAX_CHUNK_BYTES in src/store.ts. */
const MAX_CHUNK_BYTES = 4096;

let workDir: string;
const stores: ContentStore[] = [];
/** Fixture projects carrying a `.codegraph/`; makeGraphFixture picks its own dir. */
const graphDirs: string[] = [];

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "context-mode-codechunk-"));
});

afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
  }
  rmSync(workDir, { recursive: true, force: true });
  // After the stores: closing one releases the read-only handle it holds on
  // that project's codegraph.db, and Windows refuses to unlink an open file.
  for (const dir of graphDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.CONTEXT_MODE_CODE_CHUNKING;
  delete process.env.CONTEXT_MODE_GRAPH_CHUNKING;
});

function newStore(): ContentStore {
  const store = new ContentStore(join(workDir, `store-${stores.length}.db`));
  stores.push(store);
  return store;
}

/** Write `source` to a file named `name` and return its stored chunks. */
function chunkFile(name: string, source: string): Array<{ title: string; content: string; contentType: string }> {
  const path = join(workDir, name);
  writeFileSync(path, source, "utf-8");
  const store = newStore();
  const { sourceId } = store.index({ path, source: name });
  return store.getChunksBySource(sourceId).map((c) => ({
    title: c.title,
    content: c.content,
    contentType: c.contentType,
  }));
}

/** Non-blank lines, trimmed — the unit content preservation is checked in. */
function significantLines(text: string): string[] {
  return text.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
}

// ─────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────

/**
 * A body long enough that its declaration fills a chunk on its own.
 *
 * Consecutive declarations are packed together until a chunk is big enough to
 * stand alone, so a fixture of three two-line functions comes back as one
 * chunk — correctly, and uselessly for a test about boundaries. Real functions
 * are this long; the fixtures are too.
 */
function body(tag: string, indent = "  "): string[] {
  return Array.from(
    { length: 20 },
    (_, i) => `${indent}const ${tag}${i} = compute(${i}, "${tag}-step-${i}", options);`,
  );
}

function pyBody(tag: string, indent = "    "): string[] {
  return Array.from(
    { length: 20 },
    (_, i) => `${indent}${tag}${i} = compute(${i}, "${tag}-step-${i}", options)`,
  );
}

const TS_SOURCE = [
  "/**",
  " * File header. Describes the module, not the first export.",
  " */",
  "",
  'import { readFileSync } from "node:fs";',
  "",
  "const RETRIES = 3;",
  "",
  "/**",
  " * Read a config file and parse it.",
  " */",
  "export function loadConfig(path: string): Config {",
  '  const raw = readFileSync(path, "utf-8");',
  ...body("load"),
  "  return JSON.parse(raw);",
  "}",
  "",
  "/** Persist the config back to disk. */",
  "export function saveConfig(path: string, cfg: Config): void {",
  ...body("save"),
  "  writeFileSync(path, JSON.stringify(cfg));",
  "}",
  "",
  "export class ConfigWatcher {",
  "  #path: string;",
  "",
  "  constructor(path: string) {",
  "    this.#path = path;",
  "  }",
  "",
  "  /** Start watching. */",
  "  watch(): void {",
  ...body("watch", "    "),
  "    watchFile(this.#path, () => this.reload());",
  "  }",
  "",
  "  reload(): void {",
  ...body("reload", "    "),
  "    this.#cache = loadConfig(this.#path);",
  "  }",
  "}",
].join("\n");

const PY_SOURCE = [
  '"""Module docstring."""',
  "",
  "import os",
  "",
  "",
  "def normalize(value):",
  '    """Strip and lowercase."""',
  ...pyBody("norm"),
  "    return value.strip().lower()",
  "",
  "",
  '@app.route("/health")',
  "def health():",
  ...pyBody("health"),
  '    return {"ok": True}',
  "",
  "",
  "class Loader:",
  "    def __init__(self, root):",
  ...pyBody("init", "        "),
  "        self.root = root",
  "",
  "    def load(self, name):",
  ...pyBody("load", "        "),
  "        return open(os.path.join(self.root, name)).read()",
].join("\n");

const PHP_SOURCE = [
  "<?php",
  "",
  "namespace App\\Service;",
  "",
  "/**",
  " * Resolves tokens against the store.",
  " */",
  "class TokenResolver",
  "{",
  "    private $store;",
  "",
  "    public function __construct($store)",
  "    {",
  "        $this->store = $store;",
  "    }",
  "",
  "    public function resolve($token)",
  "    {",
  "        return $this->store->get($token);",
  "    }",
  "}",
].join("\n");

// ─────────────────────────────────────────────────────────
// Boundaries
// ─────────────────────────────────────────────────────────

describe("#chunkCode: declaration boundaries", () => {
  test("a TypeScript file is cut at its top-level declarations", () => {
    const chunks = chunkFile("config.ts", TS_SOURCE);

    assert.ok(chunks.length >= 3, `expected several chunks, got ${chunks.length}`);
    const titles = chunks.map((c) => c.title);
    assert.ok(
      titles.some((t) => t.startsWith("export function loadConfig")),
      `no chunk titled after loadConfig: ${JSON.stringify(titles)}`,
    );
    assert.ok(
      titles.some((t) => t.startsWith("export class ConfigWatcher")),
      `no chunk titled after ConfigWatcher: ${JSON.stringify(titles)}`,
    );
  });

  test("chunk titles name the declaration, never 'Untitled'", () => {
    const chunks = chunkFile("config.ts", TS_SOURCE);
    for (const chunk of chunks) {
      assert.ok(
        !/^Untitled/.test(chunk.title),
        `chunk titled ${JSON.stringify(chunk.title)} — markdown chunking leaked through`,
      );
    }
  });

  test("Python: def and decorated def both open a block", () => {
    const chunks = chunkFile("loader.py", PY_SOURCE);
    const titles = chunks.map((c) => c.title);
    assert.ok(titles.some((t) => t.startsWith("def normalize")), JSON.stringify(titles));
    assert.ok(titles.some((t) => t.startsWith("class Loader")), JSON.stringify(titles));
  });

  test("PHP: the class and its docblock are one chunk", () => {
    const chunks = chunkFile("TokenResolver.php", PHP_SOURCE);
    const classChunk = chunks.find((c) => c.content.includes("class TokenResolver"));
    assert.ok(classChunk, "no chunk holds the class");
    assert.ok(
      classChunk!.content.includes("Resolves tokens against the store."),
      "the docblock did not travel with the class it describes",
    );
  });

  test("source files are typed as code, not prose", () => {
    const chunks = chunkFile("config.ts", TS_SOURCE);
    for (const chunk of chunks) {
      assert.equal(chunk.contentType, "code", `chunk ${JSON.stringify(chunk.title)} is not code`);
    }
  });
});

// ─────────────────────────────────────────────────────────
// Doc comments
// ─────────────────────────────────────────────────────────

describe("#chunkCode: a doc comment belongs to what it documents", () => {
  test("the JSDoc above a function is in the function's chunk", () => {
    const store = newStore();
    const path = join(workDir, "config.ts");
    writeFileSync(path, TS_SOURCE, "utf-8");
    const { sourceId } = store.index({ path, source: "config.ts" });
    const chunks = store.getChunksBySource(sourceId);

    const owner = chunks.find((c) => c.content.includes("export function loadConfig"));
    assert.ok(owner, "loadConfig is missing entirely");
    assert.ok(
      owner!.content.includes("Read a config file and parse it."),
      "loadConfig's JSDoc was left behind in the previous chunk",
    );

    const stranded = chunks.find(
      (c) => c.content.includes("Read a config file and parse it.") && !c.content.includes("loadConfig"),
    );
    assert.equal(stranded, undefined, "the JSDoc was duplicated into a chunk without its function");
  });

  test("the file header comment does not follow the first declaration around", () => {
    const chunks = chunkFile("config.ts", TS_SOURCE);
    const header = chunks.find((c) => c.content.includes("File header."));
    assert.ok(header, "the file header vanished");
    assert.ok(
      header!.content.startsWith("/**"),
      `the first chunk should open on the header comment, got ${JSON.stringify(header!.content.slice(0, 40))}`,
    );
  });
});

// ─────────────────────────────────────────────────────────
// Fallbacks
// ─────────────────────────────────────────────────────────

describe("#chunkCode: what it declines to handle", () => {
  test("a minified bundle falls back and still respects the byte cap", () => {
    // One line, no structure to find, three times the cap.
    const minified = `!function(){var a="${"x".repeat(MAX_CHUNK_BYTES * 3)}";return a}();`;
    const chunks = chunkFile("bundle.js", minified);

    assert.ok(chunks.length >= 2, `expected the oversized line to be split, got ${chunks.length}`);
    for (const chunk of chunks) {
      assert.ok(
        Buffer.byteLength(chunk.content) <= MAX_CHUNK_BYTES,
        `chunk of ${Buffer.byteLength(chunk.content)}B exceeds cap ${MAX_CHUNK_BYTES}`,
      );
    }
  });

  test("a markdown file keeps heading-aware chunking", () => {
    const md = ["# Title", "", "Intro paragraph.", "", "## Section", "", "Body text."].join("\n");
    const chunks = chunkFile("notes.md", md);
    const titles = chunks.map((c) => c.title);
    assert.ok(titles.some((t) => t.includes("Title")), JSON.stringify(titles));
    assert.ok(titles.some((t) => t.includes("Section")), JSON.stringify(titles));
  });

  test("content indexed without a path is untouched", () => {
    // No path means no extension means no gate to pass, whatever the content
    // looks like — the same bytes a .md file would produce.
    const store = newStore();
    const result = store.index({ content: TS_SOURCE, source: "pasted-snippet" });
    const pasted = store.getChunksBySource(result.sourceId).map((c) => c.content);

    assert.deepEqual(pasted, chunkFile("config.md", TS_SOURCE).map((c) => c.content));
  });
});

// ─────────────────────────────────────────────────────────
// Invariants
// ─────────────────────────────────────────────────────────

describe("#chunkCode: invariants", () => {
  test("every chunk of a large real source file stays under the byte cap", () => {
    const store = newStore();
    const { sourceId } = store.index({
      path: join(__dirname, "..", "src", "store.ts"),
      source: "src/store.ts",
    });
    const chunks = store.getChunksBySource(sourceId);
    assert.ok(chunks.length > 5, `expected a real split, got ${chunks.length} chunks`);
    for (const chunk of chunks) {
      assert.ok(
        Buffer.byteLength(chunk.content) <= MAX_CHUNK_BYTES,
        `chunk ${JSON.stringify(chunk.title)} is ${Buffer.byteLength(chunk.content)}B`,
      );
    }
  });

  test("no line of the file is lost or reordered", () => {
    const store = newStore();
    const path = join(__dirname, "..", "src", "session", "code-index.ts");
    const { sourceId } = store.index({ path, source: "code-index.ts" });
    const chunks = store.getChunksBySource(sourceId);

    const fromChunks = chunks.flatMap((c) => significantLines(c.content));
    const fromFile = significantLines(readFileSync(path, "utf-8"));
    assert.deepEqual(fromChunks, fromFile, "chunking dropped, duplicated or reordered lines");
  });
});

// ─────────────────────────────────────────────────────────
// Escape hatch
// ─────────────────────────────────────────────────────────

describe("CONTEXT_MODE_CODE_CHUNKING=0", () => {
  test("restores the previous chunking byte for byte", () => {
    process.env.CONTEXT_MODE_CODE_CHUNKING = "0";
    const asCode = chunkFile("config.ts", TS_SOURCE);
    // A .md file has never gone anywhere but #chunkMarkdown. With the flag
    // off, the .ts file must come out of the same function with the same
    // bytes — that is what "restores the previous behaviour" means.
    const asMarkdown = chunkFile("config.md", TS_SOURCE);

    assert.deepEqual(
      asCode.map((c) => c.content),
      asMarkdown.map((c) => c.content),
      "the flag did not restore the markdown path",
    );
  });

  test("without the flag the same file chunks differently", () => {
    const asCode = chunkFile("config.ts", TS_SOURCE);
    const asMarkdown = chunkFile("config.md", TS_SOURCE);
    assert.notDeepEqual(
      asCode.map((c) => c.content),
      asMarkdown.map((c) => c.content),
      "code chunking made no difference — the gate is not wired up",
    );
  });
});

// ─────────────────────────────────────────────────────────
// Symbol boundaries from the codegraph index (§3.3)
// ─────────────────────────────────────────────────────────

/**
 * The line heuristic above guesses where declarations start. When the project
 * carries a codegraph index it does not have to guess: `nodes` holds every
 * symbol's start_line/end_line, written by a real parser.
 *
 * These tests pin the difference with a file the heuristic is provably wrong
 * about — a template literal whose text contains a line reading
 * `export function ...` at column zero. The heuristic cuts there, mid-string;
 * the graph knows the whole literal is one `const`. Every other test below
 * pins the conditions under which the graph is refused and the heuristic path
 * comes back unchanged, because indexing must never depend on the graph.
 */

/** A line long enough that a few dozen of them clear CODE_CHUNK_MIN_BYTES. */
function filler(tag: string, i: number): string {
  return `  const ${tag}${i} = compute(${i}, "${tag}-step-${i}", options, fallback);`;
}

/**
 * A source file plus the symbol spans a parser would report for it.
 *
 * Built line by line rather than written out, because the node rows have to
 * carry the real 1-based line numbers and a hand-counted fixture goes wrong
 * the first time somebody inserts a line.
 */
function graphSource(): { text: string; nodes: FixtureNode[] } {
  const lines: string[] = [];
  const push = (...ls: string[]) => { lines.push(...ls); return lines.length; };

  // Leading gap: header, import, a top-level const with no node of its own.
  // None of it belongs to a symbol, and all of it has to survive chunking.
  push("/**", " * Module header. Belongs to the file, not to the first export.", " */", "");
  push('import { readFileSync } from "node:fs";', "");
  push('const LICENSE_MARKER = "gap-line-must-survive";', "");

  const templateStart = lines.length + 1;
  push("const TEMPLATE = `");
  for (let i = 0; i < 30; i++) push(filler("pre", i));
  // The trap. At column zero, opening with `export function`, and pure data.
  push("export function generatedInsideATemplate(): void {", "  return;", "}");
  for (let i = 0; i < 30; i++) push(filler("post", i));
  const templateEnd = push("`;");
  push("");

  push("/** Load the config off disk. */");
  const loadStart = lines.length + 1;
  push("export function loadConfig(path: string): string {");
  for (let i = 0; i < 20; i++) push(filler("load", i));
  const loadEnd = push('  return readFileSync(path, "utf-8");', "}") - 0;

  return {
    text: lines.join("\n"),
    nodes: [
      {
        id: "variable:TEMPLATE", kind: "variable", name: "TEMPLATE",
        qualifiedName: "src/config.ts::TEMPLATE", filePath: "src/config.ts",
        startLine: templateStart, endLine: templateEnd,
      },
      {
        id: "function:loadConfig", kind: "function", name: "loadConfig",
        qualifiedName: "src/config.ts::loadConfig", filePath: "src/config.ts",
        startLine: loadStart, endLine: loadEnd, isExported: true,
      },
    ],
  };
}

/**
 * Index one file inside a throwaway project that does (or does not) carry a
 * codegraph index, and return its chunks.
 *
 * `indexedAt` defaults to a minute in the future: the file is written after
 * the fixture db, so a `Date.now()` stamp would race the staleness gate on a
 * slow filesystem and make the suite flaky for the wrong reason.
 */
function chunkInProject(opts: {
  rel: string;
  text: string;
  nodes?: FixtureNode[];
  /** Omit to leave the file out of the graph's `files` table entirely. */
  indexedAt?: number | null;
}): Array<{ title: string; content: string }> {
  const { projectDir } = makeGraphFixture({
    nodes: opts.nodes ?? [],
    files: opts.indexedAt === null ? {} : { [opts.rel]: opts.indexedAt ?? Date.now() + 60_000 },
  });
  graphDirs.push(projectDir);
  const abs = join(projectDir, opts.rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, opts.text, "utf-8");

  const store = newStore();
  const { sourceId } = store.index({ path: abs, source: `code:${opts.rel}` });
  return store.getChunksBySource(sourceId).map((c) => ({ title: c.title, content: c.content }));
}

/** The same file indexed where no ancestor directory holds a `.codegraph/`. */
function chunkWithoutGraph(rel: string, text: string): Array<{ title: string; content: string }> {
  const abs = join(workDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, "utf-8");
  const store = newStore();
  const { sourceId } = store.index({ path: abs, source: `code:${rel}` });
  return store.getChunksBySource(sourceId).map((c) => ({ title: c.title, content: c.content }));
}

/** True when some chunk is titled after the declaration hiding in the string. */
function cutInsideTemplate(chunks: Array<{ title: string }>): boolean {
  return chunks.some((c) => c.title.startsWith("export function generatedInsideATemplate"));
}

describe("#chunkCodeBySymbols: boundaries come from the graph", () => {
  test("a declaration that only looks like one does not open a chunk", () => {
    const { text, nodes } = graphSource();

    const withoutGraph = chunkWithoutGraph("src/config.ts", text);
    assert.ok(
      cutInsideTemplate(withoutGraph),
      "the line heuristic no longer cuts inside the template — the fixture stopped proving anything",
    );

    const withGraph = chunkInProject({ rel: "src/config.ts", text, nodes });
    assert.ok(
      !cutInsideTemplate(withGraph),
      "the graph's symbol spans were ignored: a chunk still starts inside a string literal",
    );
    const template = withGraph.find((c) => c.title.startsWith("const TEMPLATE"));
    assert.ok(template, "the const holding the literal did not become a chunk of its own");
    assert.ok(
      template!.content.includes("export function generatedInsideATemplate"),
      "the literal was split anyway — the span was not honoured end to end",
    );
  });

  test("code between symbols is indexed, not dropped", () => {
    const { text, nodes } = graphSource();
    const chunks = chunkInProject({ rel: "src/config.ts", text, nodes });
    const all = chunks.map((c) => c.content).join("\n");

    // Imports, the file header and a top-level const belong to no symbol. They
    // are also exactly what someone searching for `readFileSync` will look for.
    assert.ok(all.includes('import { readFileSync } from "node:fs";'), "the import gap was dropped");
    assert.ok(all.includes("gap-line-must-survive"), "a top-level statement between symbols was dropped");
    assert.ok(all.includes("Module header."), "the file header was dropped");
  });

  test("no line of the file is lost or reordered", () => {
    const { text, nodes } = graphSource();
    const chunks = chunkInProject({ rel: "src/config.ts", text, nodes });
    assert.deepEqual(
      chunks.flatMap((c) => significantLines(c.content)),
      significantLines(text),
      "symbol-boundary chunking dropped, duplicated or reordered lines",
    );
  });

  test("the doc comment above a symbol travels with it", () => {
    const { text, nodes } = graphSource();
    const chunks = chunkInProject({ rel: "src/config.ts", text, nodes });
    const owner = chunks.find((c) => c.content.includes("export function loadConfig"));
    assert.ok(owner, "loadConfig went missing");
    assert.ok(
      owner!.content.includes("/** Load the config off disk. */"),
      "the docblock stayed behind in the gap instead of moving to what it documents",
    );
  });
});

describe("#chunkCodeBySymbols: size caps are still the packer's", () => {
  test("a single symbol larger than the cap is still split", () => {
    const lines = ["export function huge(): void {"];
    for (let i = 0; i < 220; i++) lines.push(filler("huge", i));
    lines.push("}");
    const text = lines.join("\n");
    assert.ok(Buffer.byteLength(text) > MAX_CHUNK_BYTES * 2, "fixture is not actually oversized");

    const chunks = chunkInProject({
      rel: "src/huge.ts",
      text,
      nodes: [{
        id: "function:huge", kind: "function", name: "huge",
        qualifiedName: "src/huge.ts::huge", filePath: "src/huge.ts",
        startLine: 1, endLine: lines.length,
      }],
    });

    assert.ok(chunks.length > 1, "one symbol became one oversized chunk");
    for (const chunk of chunks) {
      assert.ok(
        Buffer.byteLength(chunk.content) <= MAX_CHUNK_BYTES,
        `chunk ${JSON.stringify(chunk.title)} is ${Buffer.byteLength(chunk.content)}B`,
      );
    }
  });

  test("a run of tiny symbols is packed, not filed one chunk each", () => {
    const names = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta"];
    const text = names.map((n) => `export type ${n} = string;`).join("\n");
    const nodes: FixtureNode[] = names.map((n, i) => ({
      id: `type:${n}`, kind: "type_alias", name: n,
      qualifiedName: `src/types.ts::${n}`, filePath: "src/types.ts",
      startLine: i + 1, endLine: i + 1, isExported: true,
    }));

    const chunks = chunkInProject({ rel: "src/types.ts", text, nodes });
    assert.ok(
      chunks.length < names.length,
      `each one-line type became its own chunk (${chunks.length} chunks for ${names.length} symbols)`,
    );
  });
});

describe("#chunkCodeBySymbols: when the graph is refused", () => {
  test("no codegraph index — the text strategy is unchanged", () => {
    const { text } = graphSource();
    const withoutGraph = chunkWithoutGraph("src/config.ts", text);
    // Same file, same absence of an index, via the fixture's own project dir
    // (which has a `.codegraph/` but no row for this file, see next test) is a
    // different case. Here the point is that the pre-existing path is intact.
    assert.ok(cutInsideTemplate(withoutGraph), "the heuristic path changed shape");
    assert.ok(withoutGraph.length > 1, "the heuristic stopped splitting the file at all");
  });

  test("a file the index does not know falls back", () => {
    const { text, nodes } = graphSource();
    const chunks = chunkInProject({ rel: "src/config.ts", text, nodes, indexedAt: null });
    assert.deepEqual(
      chunks.map((c) => c.content),
      chunkWithoutGraph("src/config.ts", text).map((c) => c.content),
      "a file absent from the graph's `files` table was chunked from its symbols anyway",
    );
  });

  test("an index older than the file falls back", () => {
    const { text, nodes } = graphSource();
    const chunks = chunkInProject({
      rel: "src/config.ts", text, nodes, indexedAt: Date.now() - 3_600_000,
    });
    assert.deepEqual(
      chunks.map((c) => c.content),
      chunkWithoutGraph("src/config.ts", text).map((c) => c.content),
      "boundaries from a stale index were used — they describe the previous revision",
    );
  });

  test("an empty symbol table falls back", () => {
    const { text } = graphSource();
    const chunks = chunkInProject({ rel: "src/config.ts", text, nodes: [] });
    assert.deepEqual(
      chunks.map((c) => c.content),
      chunkWithoutGraph("src/config.ts", text).map((c) => c.content),
      "a file with no symbols produced something other than the text chunking",
    );
  });

  test("inline content is never chunked from a path's symbols", () => {
    const { text, nodes } = graphSource();
    const { projectDir } = makeGraphFixture({
      nodes, files: { "src/config.ts": Date.now() + 60_000 },
    });
    graphDirs.push(projectDir);
    const abs = join(projectDir, "src/config.ts");
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, "utf-8");

    // Caller-supplied content is not the file on disk, whatever the path says.
    const store = newStore();
    const { sourceId } = store.index({ content: text, path: abs, source: "code:src/config.ts" });
    const chunks = store.getChunksBySource(sourceId);
    assert.ok(
      cutInsideTemplate(chunks),
      "line numbers from the graph were applied to content that never came from that file",
    );
  });
});

describe("CONTEXT_MODE_GRAPH_CHUNKING=0", () => {
  test("restores the line heuristic on a file the graph covers", () => {
    const { text, nodes } = graphSource();
    process.env.CONTEXT_MODE_GRAPH_CHUNKING = "0";
    const off = chunkInProject({ rel: "src/config.ts", text, nodes });
    assert.deepEqual(
      off.map((c) => c.content),
      chunkWithoutGraph("src/config.ts", text).map((c) => c.content),
      "the flag did not restore the previous chunking",
    );
  });

  test("without the flag the same file chunks differently", () => {
    const { text, nodes } = graphSource();
    assert.notDeepEqual(
      chunkInProject({ rel: "src/config.ts", text, nodes }).map((c) => c.content),
      chunkWithoutGraph("src/config.ts", text).map((c) => c.content),
      "symbol boundaries made no difference — the graph path is not wired up",
    );
  });
});

describe("#chunkCodeBySymbols: one graph handle per project", () => {
  test("a second file in the same project still gets symbol boundaries", () => {
    // The handle is opened once and held for the store's lifetime. If it were
    // opened and closed per file, or memoised as a failure after the first
    // use, the second file would silently drop to the text path — and the only
    // symptom would be worse retrieval, months later.
    const { text, nodes } = graphSource();
    const second = ["export type Marker = string;", "", "export function only(): void {}"].join("\n");

    const { projectDir } = makeGraphFixture({
      nodes: [
        ...nodes,
        {
          id: "function:only", kind: "function", name: "only",
          qualifiedName: "src/second.ts::only", filePath: "src/second.ts",
          startLine: 3, endLine: 3, isExported: true,
        },
      ],
      files: { "src/config.ts": Date.now() + 60_000, "src/second.ts": Date.now() + 60_000 },
    });
    graphDirs.push(projectDir);
    for (const [rel, body] of [["src/config.ts", text], ["src/second.ts", second]] as const) {
      const abs = join(projectDir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body, "utf-8");
    }

    const store = newStore();
    const first = store.index({ path: join(projectDir, "src/config.ts"), source: "code:src/config.ts" });
    assert.ok(!cutInsideTemplate(store.getChunksBySource(first.sourceId)), "first file did not use the graph");

    const next = store.index({ path: join(projectDir, "src/second.ts"), source: "code:src/second.ts" });
    const chunks = store.getChunksBySource(next.sourceId);
    assert.ok(chunks.length > 0, "the second file produced no chunks at all");
    assert.ok(
      chunks.some((c) => c.content.includes("export type Marker")),
      "the second file lost the gap line above its only symbol",
    );
  });
});
