/**
 * Secret screening, as wired into ContentStore (P2.3b).
 *
 * `src/session/redact.ts` is covered by its own suite; this one is about the
 * plumbing, and everything it asserts about "the secret did not land" is read
 * back out of SQLite rather than taken from a return value. A screening
 * function that works and a store that indexes the unscreened copy would pass
 * every test that only inspects what `redactSecrets` returned.
 *
 * Three public entry points reach the index — `index`, `indexPlainText`,
 * `indexJSON` — and none of them goes through the others, so each is checked
 * separately. The fourth thing checked is the interaction with the content-hash
 * cache (P1.2): screening runs before the hash, so flipping the switch has to
 * invalidate the cached row instead of leaving it pointing at bytes that are no
 * longer what would be stored.
 */
import { describe, test, beforeEach, afterEach } from "vitest";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContentStore } from "../src/store.js";
import { loadDatabase } from "../src/db-base.js";

// Fixtures. Each is shaped to match a rule in redact.ts — a real key format,
// not a placeholder, because the rules are anchored on literals and lengths.
const OPENAI_KEY = "sk-proj-AbCdEf0123456789GhIjKlMnOpQr";
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const ASSIGNED = 'DATABASE_PASSWORD="s3cr3tvalu3fortesting01"';
const SECRET_VALUE = "s3cr3tvalu3fortesting01";

const SECRET_DOC = [
  "# Deployment notes",
  "",
  "Export the key before running the migration:",
  "",
  `  export OPENAI_API_KEY=${OPENAI_KEY}`,
  `  export AWS_ACCESS_KEY_ID=${AWS_KEY}`,
  `  ${ASSIGNED}`,
  "",
  "Then run `npm run migrate`.",
].join("\n");

let workDir: string;
const stores: ContentStore[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "context-mode-redact-wiring-"));
  savedEnv.CONTEXT_MODE_INDEX_REDACT = process.env.CONTEXT_MODE_INDEX_REDACT;
  savedEnv.CONTEXT_MODE_INDEX_ENTROPY_REDACT = process.env.CONTEXT_MODE_INDEX_ENTROPY_REDACT;
});

afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(workDir, { recursive: true, force: true });
});

/** The switch is read once, in the constructor — so it is set before this. */
function newStore(name = "store"): ContentStore {
  const store = new ContentStore(join(workDir, `${name}.db`));
  stores.push(store);
  return store;
}

/** Everything durable this store wrote, as one string to search for leaks. */
function storedText(dbPath: string): string {
  const Database = loadDatabase();
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = [
      ...(db.prepare("SELECT title, content FROM chunks").all() as Array<{ title: string; content: string }>),
      ...(db.prepare("SELECT title, content FROM chunks_trigram").all() as Array<{ title: string; content: string }>),
    ];
    const vocab = db.prepare("SELECT word FROM vocabulary").all() as Array<{ word: string }>;
    return [...rows.map((r) => `${r.title}\n${r.content}`), ...vocab.map((v) => v.word)].join("\n");
  } finally {
    db.close();
  }
}

function assertNoLeak(dbPath: string): void {
  const stored = storedText(dbPath);
  for (const secret of [OPENAI_KEY, AWS_KEY, SECRET_VALUE]) {
    assert.ok(!stored.includes(secret), `${secret.slice(0, 8)}… reached the database`);
  }
  assert.ok(stored.includes("[redacted:"), "nothing was marked as redacted");
}

// ─────────────────────────────────────────────────────────
// The three entry points
// ─────────────────────────────────────────────────────────

describe("credentials do not reach the database", () => {
  test("index({ content })", () => {
    const dbPath = join(workDir, "content.db");
    const store = new ContentStore(dbPath);
    stores.push(store);

    const result = store.index({ content: SECRET_DOC, source: "notes" });
    store.close();

    assert.equal(result.redactions, 3, "one openai key, one aws key, one assignment");
    assertNoLeak(dbPath);
  });

  test("index({ path })", () => {
    const dbPath = join(workDir, "path.db");
    const file = join(workDir, "deploy.md");
    writeFileSync(file, SECRET_DOC, "utf-8");
    const store = new ContentStore(dbPath);
    stores.push(store);

    const result = store.index({ path: file, source: "deploy.md" });
    store.close();

    assert.equal(result.redactions, 3);
    assertNoLeak(dbPath);
  });

  test("indexPlainText", () => {
    const dbPath = join(workDir, "plain.db");
    const store = new ContentStore(dbPath);
    stores.push(store);

    // Padded out so the line-group path runs, not the single-chunk one.
    const log = [SECRET_DOC, ...Array.from({ length: 60 }, (_, i) => `step ${i} ok`)].join("\n");
    const result = store.indexPlainText(log, "build-log");
    store.close();

    assert.equal(result.redactions, 3);
    assertNoLeak(dbPath);
  });

  test("indexJSON — the document still parses and the values are gone", () => {
    const dbPath = join(workDir, "json.db");
    const store = new ContentStore(dbPath);
    stores.push(store);

    const doc = JSON.stringify(
      {
        service: { name: "billing", region: "eu-west-1" },
        credentials: { openai: OPENAI_KEY, aws: AWS_KEY },
      },
      null,
      2,
    );
    const result = store.indexJSON(doc, "config");
    store.close();

    assert.ok((result.redactions ?? 0) >= 2, `expected redactions, got ${JSON.stringify(result)}`);
    const stored = storedText(dbPath);
    // Key paths survive — the parse ran on screened but still-valid JSON.
    assert.ok(stored.includes("credentials"), "the JSON walk did not run; it fell back to plain text");
    assert.ok(!stored.includes(OPENAI_KEY) && !stored.includes(AWS_KEY), "a key reached the database");
  });

  test("indexJSON — unparseable input falls back and still reports its count", () => {
    const dbPath = join(workDir, "badjson.db");
    const store = new ContentStore(dbPath);
    stores.push(store);

    // The fallback path screens once and hands the screened text on; the count
    // must survive that hand-off rather than being replaced by the second
    // pass's zero.
    const result = store.indexJSON(`{"broken": ${SECRET_DOC}`, "broken-config");
    store.close();

    assert.equal(result.redactions, 3);
    assertNoLeak(dbPath);
  });

  test("a source file is screened before it is chunked as code", () => {
    // The two features meet in index(): screening rewrites the text, and the
    // code chunker then cuts the rewritten copy. Titles come from chunk
    // content, so a secret on a declaration line would otherwise reach the
    // title column as well.
    const dbPath = join(workDir, "source.db");
    const file = join(workDir, "client.ts");
    writeFileSync(
      file,
      [
        "/** API client. */",
        "export function makeClient() {",
        `  const key = "${OPENAI_KEY}";`,
        "  return new Client(key);",
        "}",
      ].join("\n"),
      "utf-8",
    );
    const store = new ContentStore(dbPath);
    stores.push(store);

    const result = store.index({ path: file, source: "client.ts" });
    store.close();

    assert.equal(result.redactions, 1);
    const stored = storedText(dbPath);
    assert.ok(!stored.includes(OPENAI_KEY), "the key reached the database");
    assert.ok(stored.includes("export function makeClient"), "the code chunker stopped seeing the file");
  });

  test("a redacted secret cannot be found by searching for it", () => {
    const store = newStore("search");
    store.index({ content: SECRET_DOC, source: "notes" });

    assert.equal(store.search(OPENAI_KEY, 5).length, 0);
    assert.equal(store.search(SECRET_VALUE, 5).length, 0);
    // The surrounding prose is still indexed — screening is not deletion.
    assert.ok(store.search("migration", 5).length > 0, "the document itself stopped being searchable");
  });
});

// ─────────────────────────────────────────────────────────
// The switches
// ─────────────────────────────────────────────────────────

describe("CONTEXT_MODE_INDEX_REDACT=0", () => {
  test("restores the previous behaviour: the text is stored as given", () => {
    process.env.CONTEXT_MODE_INDEX_REDACT = "0";
    const dbPath = join(workDir, "off.db");
    const store = new ContentStore(dbPath);
    stores.push(store);

    const result = store.index({ content: SECRET_DOC, source: "notes" });
    store.close();

    assert.equal(result.redactions, undefined, "the field must be absent, not zero");
    const stored = storedText(dbPath);
    assert.ok(stored.includes(OPENAI_KEY), "the switch did not turn screening off");
    assert.ok(!stored.includes("[redacted:"), "something was still redacted");
  });

  test("a clean document reports nothing either way", () => {
    const store = newStore("clean");
    const result = store.index({ content: "# Notes\n\nNothing sensitive here.", source: "clean" });
    assert.equal(result.redactions, undefined);
  });
});

describe("CONTEXT_MODE_INDEX_ENTROPY_REDACT", () => {
  // A long opaque token with no literal marker: invisible to the pattern layer
  // by design, and caught only by the opt-in entropy heuristic.
  const OPAQUE = "Zk9pQ3RmVmoyaHM4b0xkQnhXcU5lUjdU";
  const doc = `# Build\n\nartifact digest ${OPAQUE} recorded\n`;

  test("off by default: an opaque token survives", () => {
    const dbPath = join(workDir, "entropy-off.db");
    const store = new ContentStore(dbPath);
    stores.push(store);
    store.index({ content: doc, source: "build" });
    store.close();

    assert.ok(storedText(dbPath).includes(OPAQUE), "the entropy layer ran without being asked");
  });

  test("=1 screens it", () => {
    process.env.CONTEXT_MODE_INDEX_ENTROPY_REDACT = "1";
    const dbPath = join(workDir, "entropy-on.db");
    const store = new ContentStore(dbPath);
    stores.push(store);
    const result = store.index({ content: doc, source: "build" });
    store.close();

    assert.ok((result.redactions ?? 0) >= 1, "the opt-in layer did not fire");
    assert.ok(!storedText(dbPath).includes(OPAQUE));
  });
});

// ─────────────────────────────────────────────────────────
// Interaction with the content-hash cache (P1.2)
// ─────────────────────────────────────────────────────────

describe("content-hash cache", () => {
  test("an unchanged file is still skipped on re-index", () => {
    const file = join(workDir, "deploy.md");
    writeFileSync(file, SECRET_DOC, "utf-8");
    const store = newStore("stable");

    const first = store.index({ path: file, source: "deploy.md" });
    const second = store.index({ path: file, source: "deploy.md" });

    assert.equal(first.redactions, 3);
    assert.ok(second.skipped, "screening made the hash unstable across identical reads");
    // Nothing was written this time, so nothing is reported as redacted —
    // the count describes work done, not work that would have been done.
    assert.equal(second.redactions, undefined);
  });

  test("flipping the switch re-indexes instead of trusting a stale hash", () => {
    const dbPath = join(workDir, "flip.db");
    const file = join(workDir, "deploy.md");
    writeFileSync(file, SECRET_DOC, "utf-8");

    const screened = new ContentStore(dbPath);
    assert.equal(screened.index({ path: file, source: "deploy.md" }).redactions, 3);
    screened.close();
    assert.ok(!storedText(dbPath).includes(OPENAI_KEY));

    // Same file, same bytes on disk, screening off. The hash on the row
    // describes screened bytes; what would be stored now does not match it.
    process.env.CONTEXT_MODE_INDEX_REDACT = "0";
    const raw = new ContentStore(dbPath);
    const reindexed = raw.index({ path: file, source: "deploy.md" });
    raw.close();

    assert.ok(!reindexed.skipped, "the stale hash was trusted and the file was not re-indexed");
    assert.ok(storedText(dbPath).includes(OPENAI_KEY), "the row still holds the screened copy");

    // And back: turning screening on has to remove it again.
    delete process.env.CONTEXT_MODE_INDEX_REDACT;
    const rescreened = new ContentStore(dbPath);
    const cleaned = rescreened.index({ path: file, source: "deploy.md" });
    rescreened.close();

    assert.ok(!cleaned.skipped);
    assert.equal(cleaned.redactions, 3);
    assert.ok(!storedText(dbPath).includes(OPENAI_KEY), "the secret survived re-screening");
  });

  test("a clean file's hash is unaffected by screening being on", () => {
    const dbPath = join(workDir, "cleanhash.db");
    const file = join(workDir, "readme.md");
    writeFileSync(file, "# Readme\n\nNo credentials in here.\n", "utf-8");

    const screened = new ContentStore(dbPath);
    screened.index({ path: file, source: "readme.md" });
    screened.close();

    process.env.CONTEXT_MODE_INDEX_REDACT = "0";
    const raw = new ContentStore(dbPath);
    const second = raw.index({ path: file, source: "readme.md" });
    raw.close();

    assert.ok(second.skipped, "screening changed the hash of a file with nothing to screen");
  });
});
