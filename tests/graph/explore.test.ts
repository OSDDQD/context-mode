/**
 * `explore`, and the one branch that can leak.
 *
 * The passthrough branch returns CLI output without indexing it, which means
 * without `ContentStore.#screen` — the only place indexed content meets
 * `redactSecrets`. Since `codegraph explore` returns SOURCE CODE, that branch
 * is exactly where a hardcoded credential would reach the transcript. These
 * tests exist to make that impossible to regress: both branches, screened.
 */

import { describe, test, expect, afterEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContentStore } from "../../src/store.js";
import {
  exploreBudgetBytes,
  explorePassthroughEnabled,
  graphToolEnabled,
  runExplore,
  screen,
} from "../../src/tools/graph.js";
import { defaultFixture } from "./fixture.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) {
    try { cleanup.pop()!(); } catch { /* best effort */ }
  }
});

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
const AWS = "AKIAIOSFODNN7EXAMPLE";

/**
 * A stand-in for the codegraph binary.
 *
 * `runCodegraph` resolves `CONTEXT_MODE_CODEGRAPH_BIN` first, so a script here
 * is spawned exactly as the real CLI would be — argv, cwd, NO_COLOR and all.
 */
function fakeCodegraph(output: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ctx-graph-bin-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, "codegraph");
  const payload = join(dir, "payload.txt");
  writeFileSync(payload, output, "utf-8");
  writeFileSync(script, `#!/bin/sh\ncat "${payload}"\n`, "utf-8");
  chmodSync(script, 0o755);
  return script;
}

function makeDeps(bin: string, query: string, extraEnv: Record<string, string> = {}) {
  const fx = defaultFixture();
  cleanup.push(() => rmSync(fx.projectDir, { recursive: true, force: true }));
  const storeDir = mkdtempSync(join(tmpdir(), "ctx-graph-store-"));
  cleanup.push(() => rmSync(storeDir, { recursive: true, force: true }));
  const store = new ContentStore(join(storeDir, "content.db"));
  cleanup.push(() => { try { store.cleanup(); } catch { /* already closed */ } });

  const indexed: Array<{ bytes: number; source?: string }> = [];
  return {
    store,
    indexed,
    deps: {
      projectDir: fx.projectDir,
      query,
      store: () => store,
      trackIndexed: (bytes: number, source?: string) => { indexed.push({ bytes, source }); },
      attribution: () => undefined,
      env: {
        ...process.env,
        CONTEXT_MODE_CODEGRAPH_BIN: bin,
        ...extraEnv,
      } as NodeJS.ProcessEnv,
    },
  };
}

const canSpawnShell = process.platform !== "win32";

describe("screen", () => {
  test("is the content screener, and it fires on source-shaped secrets", () => {
    const out = screen(`const key = "${SECRET}";\nconst aws = "${AWS}";`);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(AWS);
    expect(out).toContain("[redacted:openai-key]");
    expect(out).toContain("[redacted:aws-access-key]");
  });

  test("leaves ordinary source untouched, by reference", () => {
    const src = "export function add(a: number, b: number) { return a + b; }";
    expect(screen(src)).toBe(src);
  });

  test("honours CONTEXT_MODE_INDEX_REDACT=0 like every other screening call site", () => {
    const out = screen(`const key = "${SECRET}";`, { CONTEXT_MODE_INDEX_REDACT: "0" } as NodeJS.ProcessEnv);
    expect(out).toContain(SECRET);
  });
});

describe.runIf(canSpawnShell)("runExplore", () => {
  test("passthrough branch redacts secrets before returning them", () => {
    const body = `function login() {\n  const apiKey = "${SECRET}";\n  return apiKey;\n}\n`;
    const { deps, indexed } = makeDeps(fakeCodegraph(body), "login");
    const result = runExplore(deps);
    const text = result.content[0].text;

    // The branch under test: small enough to return whole, so nothing indexed.
    expect(indexed).toHaveLength(0);
    expect(text).toContain("function login()");
    // …and the credential did not come with it.
    expect(text).not.toContain(SECRET);
    expect(text).toContain("[redacted:openai-key]");
  });

  test("over-budget output is indexed instead of returned, still screened", () => {
    const filler = "export function noise() { return 1; }\n".repeat(400);
    const body = `${filler}const apiKey = "${SECRET}";\n`;
    const { deps, indexed, store } = makeDeps(
      fakeCodegraph(body), "noise", { CONTEXT_MODE_GRAPH_EXPLORE_BUDGET: "500" },
    );
    const result = runExplore(deps);
    const text = result.content[0].text;

    expect(indexed).toHaveLength(1);
    expect(text).toContain("indexed as");
    expect(text).toContain('source "codegraph:explore:noise"');
    expect(text).toContain("ctx_search");
    expect(text).not.toContain(SECRET);

    // Nothing unscreened reached the store either.
    const hits = store.searchWithFallback("noise", 5, "codegraph:explore:noise");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map(h => h.content).join("\n")).not.toContain(SECRET);
  });

  test("CONTEXT_MODE_GRAPH_EXPLORE_PASSTHROUGH=0 forces indexing even when small", () => {
    const { deps, indexed } = makeDeps(
      fakeCodegraph("tiny output\n"), "tiny", { CONTEXT_MODE_GRAPH_EXPLORE_PASSTHROUGH: "0" },
    );
    const result = runExplore(deps);
    expect(indexed).toHaveLength(1);
    expect(result.content[0].text).toContain("indexed as");
  });

  test("an empty query is refused before anything is spawned", () => {
    const { deps } = makeDeps(fakeCodegraph("never runs"), "   ");
    const result = runExplore(deps);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("needs a `query`");
  });
});

describe("env switches", () => {
  test("defaults", () => {
    expect(graphToolEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(explorePassthroughEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(exploreBudgetBytes({} as NodeJS.ProcessEnv)).toBe(24_000);
  });

  test("overrides", () => {
    expect(graphToolEnabled({ CONTEXT_MODE_GRAPH: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(
      explorePassthroughEnabled({ CONTEXT_MODE_GRAPH_EXPLORE_PASSTHROUGH: "0" } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      exploreBudgetBytes({ CONTEXT_MODE_GRAPH_EXPLORE_BUDGET: "1234" } as NodeJS.ProcessEnv),
    ).toBe(1234);
    // A nonsense value falls back to the default rather than to zero budget.
    expect(
      exploreBudgetBytes({ CONTEXT_MODE_GRAPH_EXPLORE_BUDGET: "nope" } as NodeJS.ProcessEnv),
    ).toBe(24_000);
  });
});
