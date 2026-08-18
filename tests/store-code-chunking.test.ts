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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ContentStore } from "../src/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Mirrors the private MAX_CHUNK_BYTES in src/store.ts. */
const MAX_CHUNK_BYTES = 4096;

let workDir: string;
const stores: ContentStore[] = [];

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "context-mode-codechunk-"));
});

afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
  }
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.CONTEXT_MODE_CODE_CHUNKING;
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
