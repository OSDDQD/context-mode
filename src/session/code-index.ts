/**
 * Incremental code indexing.
 *
 * Until now the knowledge base only ever held command OUTPUT — whatever the
 * agent happened to pipe through a ctx_* tool. The source tree itself, the
 * thing every session is actually about, was searchable only if someone had
 * previously cat'ed it into a batch command. So `ctx_search("where is the
 * retry handled")` came back empty on a fresh session and the agent fell back
 * to grep + Read, which is exactly the flood this project exists to prevent.
 *
 * The PostToolUse hook appends every file it sees written or edited to a
 * queue file; the MCP server drains that queue the next time it opens the
 * store. The split matters: the hook stays a one-line append (<1ms, no
 * SQLite, no better-sqlite3 load), and the indexing cost lands in a process
 * that already has the store open.
 */

import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, extname, isAbsolute } from "node:path";

/** Queue filename, resolved inside the sessions storage dir. */
export const CODE_INDEX_QUEUE = "code-index-queue.txt";

/**
 * Extensions worth indexing. Binary and lockfile noise is excluded — a
 * 3 MB `package-lock.json` would evict genuinely useful chunks from search
 * results while answering no question anyone asks.
 */
const INDEXABLE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs",
  ".java", ".kt", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".php",
  ".ex", ".exs", ".erl", ".scala", ".sh", ".bash", ".zsh", ".fish", ".sql",
  ".graphql", ".proto", ".vue", ".svelte", ".css", ".scss", ".less",
  ".html", ".md", ".mdx", ".rst", ".txt", ".json", ".yaml", ".yml", ".toml",
  ".ini", ".conf", ".env", ".tf", ".dockerfile", ".gradle", ".r", ".pl",
]);

const EXCLUDED_BASENAMES = new Set([
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb",
  "Cargo.lock", "composer.lock", "poetry.lock", "Gemfile.lock",
]);

/** Files above this size cost more search noise than they repay. */
const MAX_INDEXABLE_BYTES = 512 * 1024;

/** Minimal surface of ContentStore this module needs. Keeps the import light. */
export interface IndexTarget {
  index(options: { path?: string; source?: string; attribution?: { sessionId?: string; eventId?: string } }): unknown;
}

/**
 * @param filePath Absolute path of a file the agent just wrote or edited.
 * @returns true when the file is worth putting in the search index.
 */
export function isIndexableSource(filePath: string): boolean {
  if (!filePath || !isAbsolute(filePath)) return false;
  const base = filePath.split(/[\\/]/).pop() ?? "";
  if (EXCLUDED_BASENAMES.has(base)) return false;
  if (/(^|[\\/])(node_modules|\.git|dist|build|coverage|\.next|target|vendor)([\\/]|$)/.test(filePath)) {
    return false;
  }
  const ext = extname(filePath).toLowerCase();
  // Extensionless dotfiles like `Dockerfile` / `Makefile` are still useful.
  if (!ext) return base === "Dockerfile" || base === "Makefile";
  return INDEXABLE_EXTENSIONS.has(ext);
}

/** @returns Absolute path of the queue file for a given sessions storage dir. */
export function codeIndexQueuePath(sessionsDir: string): string {
  return join(sessionsDir, CODE_INDEX_QUEUE);
}

/**
 * Index every queued file into `store`, then clear the queue.
 *
 * Best-effort by design: a queued file may have been deleted, renamed, or
 * grown past the cap since it was enqueued. Those are skipped silently —
 * indexing must never surface an error into a tool call the user is waiting on.
 *
 * @returns Number of files actually indexed.
 */
export function drainCodeIndexQueue(opts: {
  store: IndexTarget;
  sessionsDir: string;
  projectDir?: string;
  attribution?: { sessionId?: string; eventId?: string };
  /** Cap per drain so a mass refactor can't stall a tool call. */
  maxFiles?: number;
}): number {
  const { store, sessionsDir, projectDir, attribution } = opts;
  const maxFiles = opts.maxFiles ?? 50;
  const queuePath = codeIndexQueuePath(sessionsDir);
  if (!existsSync(queuePath)) return 0;

  let paths: string[];
  try {
    const raw = readFileSync(queuePath, "utf-8");
    // Newest wins: a file edited five times this turn is indexed once.
    paths = [...new Set(raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean))];
  } catch {
    return 0;
  }

  // Clear the queue BEFORE indexing. If indexing throws halfway, the next
  // edit re-enqueues the file — better than replaying a poisoned queue on
  // every store open.
  try { unlinkSync(queuePath); } catch { /* raced with another drain */ }

  const overflow = paths.slice(maxFiles);
  let indexed = 0;
  for (const filePath of paths.slice(0, maxFiles)) {
    try {
      if (!isIndexableSource(filePath) || !existsSync(filePath)) continue;
      if (statSync(filePath).size > MAX_INDEXABLE_BYTES) continue;
      const label = projectDir && filePath.startsWith(projectDir)
        ? `code:${relative(projectDir, filePath)}`
        : `code:${filePath}`;
      store.index({ path: filePath, source: label, attribution });
      indexed++;
    } catch { /* skip this file, keep draining */ }
  }

  // Anything past the cap goes back so the next drain picks it up.
  if (overflow.length > 0) {
    try { writeFileSync(queuePath, overflow.join("\n") + "\n", "utf-8"); } catch { /* best-effort */ }
  }

  return indexed;
}
