/**
 * One place that knows which files make up "the server source".
 *
 * Forty call sites across eight suites read `src/server.ts` as text and assert
 * on what they find — that a guard is present, that a handler calls a
 * particular function, that a dead flag is absent. Those assertions are about
 * the shipped server, not about one file, and today they are the main thing
 * standing between `src/server.ts` and being split up: every extraction would
 * silently pass a test that greps for text no longer in the file it reads.
 *
 * So the tests ask this helper instead. When a region moves out of
 * `src/server.ts`, its new home is added to `SERVER_SOURCE_FILES` and the
 * assertions keep meaning what they meant.
 *
 * Note the failure mode this guards against: a `not.toContain` assertion over
 * a shrinking file passes for the wrong reason. Concatenating every file the
 * server is built from keeps those honest too.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Files whose combined text is "the server", relative to the repo root.
 *
 * Order is stable so offsets in one file do not shift when another grows.
 */
export const SERVER_SOURCE_FILES: readonly string[] = [
  "src/server.ts",
  // Extracted from src/server.ts — see docs/adr and the split commits.
  // ctx_execute + ctx_execute_file register first, so they lead the list.
  "src/tools/execute.ts",
  "src/tools/index-content.ts",
  "src/tools/search.ts",
  // Registered next to ctx_search in src/server.ts; listed here so the
  // "the source registers exactly these names" guard can see them.
  "src/tools/find.ts",
  "src/tools/graph.ts",
  "src/tools/pack.ts",
  "src/tools/read.ts",
  // fetch before batch: assertions that slice "from the ctx_fetch_and_index
  // registration to the ctx_batch_execute one" rely on that order.
  "src/tools/fetch.ts",
  "src/tools/batch.ts",
  "src/tools/ops.ts",
  "src/tools/doctor.ts",
  "src/tools/upgrade.ts",
  "src/tools/purge.ts",
  // ctx_insight + the cross-platform process helpers (browserOpenArgv,
  // openBrowserSync, killProcessOnPort) that moved out with it.
  "src/tools/insight.ts",
  "src/tools/shared/state.ts",
  "src/search/dedup.ts",
];

/** Absolute path of the main server module. */
export function serverSourcePath(): string {
  return resolve(REPO_ROOT, SERVER_SOURCE_FILES[0]!);
}

/** Absolute paths of every file that makes up the server. */
export function serverSourcePaths(): string[] {
  return SERVER_SOURCE_FILES.map(f => resolve(REPO_ROOT, f));
}

let cached: string | null = null;

/**
 * The server's source as one string.
 *
 * Cached per test process: eight suites read it, several of them many times,
 * and it is 6,000+ lines.
 */
export function serverSource(): string {
  if (cached === null) {
    cached = serverSourcePaths()
      .map(p => readFileSync(p, "utf-8"))
      .join("\n");
  }
  return cached;
}

/** Read one named part on its own, for assertions that must not span files. */
export function serverSourceOf(relPath: string): string {
  if (!SERVER_SOURCE_FILES.includes(relPath)) {
    throw new Error(`${relPath} is not one of SERVER_SOURCE_FILES`);
  }
  return readFileSync(resolve(REPO_ROOT, relPath), "utf-8");
}

/**
 * The source text of one tool's `registerTool(...)` call, wherever it now lives.
 *
 * Assertions about a handler used to slice the combined source between two
 * literal anchors — `server.registerTool(\n  "ctx_upgrade"` up to the comment
 * that started the next tool. Both anchors are accidents of `src/server.ts`
 * layout: an extracted module writes `deps.server.registerTool(` one indent
 * level in, and the comment that used to follow the block stayed behind. So the
 * anchors are computed here instead, once: the registration line is matched with
 * the optional `deps.` prefix and any indentation, and the block ends at the
 * first line that closes a call at column 0-2, which is the `);` of the
 * registration itself in both layouts.
 *
 * Throws rather than returning "" — a slice that silently goes empty turns
 * every `toContain` over it into a false pass, which is the exact failure mode
 * SERVER_SOURCE_FILES exists to prevent.
 */
export function toolRegistrationBlock(toolName: string): string {
  const src = serverSource();
  const start = src.search(
    new RegExp(`(?:deps\\.)?server\\.registerTool\\(\\s*\\n?\\s*"${toolName}"`),
  );
  if (start < 0) throw new Error(`no registerTool call found for ${toolName}`);
  const rest = src.slice(start);
  const end = rest.search(/\n {0,2}\);\s*(\n|$)/);
  if (end < 0) throw new Error(`unterminated registerTool block for ${toolName}`);
  return rest.slice(0, end);
}
