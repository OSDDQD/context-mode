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
 *
 * Edits alone leave two gaps, both closed here: a session that has not
 * written anything yet has an empty code index (bootstrapCodeIndex seeds it
 * from `git ls-files`), and a file deleted after indexing keeps answering
 * searches forever (pruneDeletedCodeSources evicts it).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, extname, isAbsolute, basename } from "node:path";

/** Queue filename, resolved inside the sessions storage dir. */
export const CODE_INDEX_QUEUE = "code-index-queue.txt";

/** Bookkeeping for the one-time seed pass, resolved inside the sessions dir. */
export const CODE_INDEX_BOOTSTRAP_STATE = "code-index-bootstrap.json";

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
  ".ini", ".conf", ".tf", ".dockerfile", ".gradle", ".r", ".pl",
]);

const EXCLUDED_BASENAMES = new Set([
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb",
  "Cargo.lock", "composer.lock", "poetry.lock", "Gemfile.lock",
]);

/**
 * Paths that must never reach the index, whatever their extension.
 *
 * The knowledge base is a plaintext SQLite file that search returns snippets
 * from; a `.env` or a private key indexed once will resurface in some future
 * `ctx_search` answer and land in a context window — possibly a subagent's,
 * possibly a transcript. Cheap to exclude, expensive to undo.
 */
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /(^|[\\/])\.env($|\.)/i,
  /(^|[\\/])\.(ssh|aws|gnupg|gpg|kube|docker|azure|config\/gcloud)([\\/]|$)/i,
  /(^|[\\/])\.?(npmrc|netrc|pgpass|htpasswd|dockercfg)$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|ppk|asc|kdbx)$/i,
  /(^|[\\/])service[-_]?account[^\\/]*\.json$/i,
  /(^|[\\/])(credentials|secrets?)\.(json|ya?ml|toml|ini|conf)$/i,
];

/**
 * Config-ish files get a second, name-based screen. Source files do not:
 * `token-service.ts` and `auth/password.py` are ordinary code, and excluding
 * them would blind search to the exact modules people ask about.
 */
const CONFIGISH_EXTENSIONS = new Set([
  ".json", ".yaml", ".yml", ".toml", ".ini", ".conf", ".txt", ".properties",
]);

const SENSITIVE_NAME_HINT = /(secret|credential|password|passwd|apikey|api[-_]key|private[-_]?key|token)/i;

/** Files above this size cost more search noise than they repay. */
const MAX_INDEXABLE_BYTES = 512 * 1024;

/** Minimal surface of ContentStore this module needs. Keeps the import light. */
export interface IndexTarget {
  index(options: { path?: string; source?: string; attribution?: { sessionId?: string; eventId?: string } }): unknown;
  /** Optional: lets the prune pass find and evict sources for deleted files. */
  listSources?(): Array<{ label: string; chunkCount: number }>;
  deleteSource?(label: string): number;
}

/**
 * @param filePath Absolute path of a candidate file.
 * @returns true when the file carries credentials rather than code.
 */
export function isSensitivePath(filePath: string): boolean {
  if (SENSITIVE_PATH_PATTERNS.some(re => re.test(filePath))) return true;
  const ext = extname(filePath).toLowerCase();
  if (CONFIGISH_EXTENSIONS.has(ext) && SENSITIVE_NAME_HINT.test(basename(filePath))) return true;
  return false;
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
  if (isSensitivePath(filePath)) return false;
  const ext = extname(filePath).toLowerCase();
  // Extensionless dotfiles like `Dockerfile` / `Makefile` are still useful.
  if (!ext) return base === "Dockerfile" || base === "Makefile";
  return INDEXABLE_EXTENSIONS.has(ext);
}

/** @returns Absolute path of the queue file for a given sessions storage dir. */
export function codeIndexQueuePath(sessionsDir: string): string {
  return join(sessionsDir, CODE_INDEX_QUEUE);
}

/** @returns The label a file is indexed under, relative to the project root. */
export function codeSourceLabel(filePath: string, projectDir?: string): string {
  return projectDir && filePath.startsWith(projectDir)
    ? `code:${relative(projectDir, filePath)}`
    : `code:${filePath}`;
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
      if (!isIndexableSource(filePath)) continue;
      if (!existsSync(filePath)) {
        // Deleted between the edit and this drain: evict whatever the index
        // still holds for it instead of leaving a ghost answer behind.
        evictCodeSource(store, codeSourceLabel(filePath, projectDir));
        continue;
      }
      if (statSync(filePath).size > MAX_INDEXABLE_BYTES) continue;
      store.index({ path: filePath, source: codeSourceLabel(filePath, projectDir), attribution });
      indexed++;
    } catch { /* skip this file, keep draining */ }
  }

  // Anything past the cap goes back so the next drain picks it up.
  if (overflow.length > 0) {
    try { writeFileSync(queuePath, overflow.join("\n") + "\n", "utf-8"); } catch { /* best-effort */ }
  }

  return indexed;
}

function evictCodeSource(store: IndexTarget, label: string): void {
  try { store.deleteSource?.(label); } catch { /* best-effort */ }
}

/**
 * Drop `code:` sources whose file no longer exists.
 *
 * Without this, a deleted or renamed module keeps answering searches from the
 * index — the single worst failure mode for a retrieval layer, because a stale
 * answer is indistinguishable from a correct one until the agent acts on it.
 *
 * @returns Number of sources evicted.
 */
export function pruneDeletedCodeSources(opts: {
  store: IndexTarget;
  projectDir?: string;
}): number {
  const { store, projectDir } = opts;
  if (!store.listSources || !store.deleteSource) return 0;
  let sources: Array<{ label: string }>;
  try {
    sources = store.listSources();
  } catch {
    return 0;
  }

  let removed = 0;
  for (const { label } of sources) {
    if (!label.startsWith("code:")) continue;
    const rel = label.slice("code:".length);
    const abs = isAbsolute(rel) ? rel : (projectDir ? join(projectDir, rel) : rel);
    // A relative label with no project dir cannot be resolved — leave it be
    // rather than guess and delete something that is still there.
    if (!isAbsolute(abs)) continue;
    try {
      if (existsSync(abs)) continue;
      store.deleteSource(label);
      removed++;
    } catch { /* skip, keep pruning */ }
  }
  return removed;
}

/**
 * Seed the code index from the project's tracked files, once per project.
 *
 * The queue only ever holds files the agent already touched, so a fresh
 * session starts blind: `ctx_search("where is retry handled")` returns
 * nothing until something is edited, which is precisely when the agent needs
 * it least. Seeding from `git ls-files` fixes that with the repo's own notion
 * of "source file" — no .gitignore parsing, no directory walk into
 * node_modules, and nothing untracked.
 *
 * Bounded on purpose: newest files first, capped at maxFiles and maxBytes, so
 * the first tool call of a session pays milliseconds, not seconds. The rest of
 * the tree still gets indexed the moment it is edited.
 *
 * @returns Number of files indexed by this pass (0 when already seeded).
 */
export function bootstrapCodeIndex(opts: {
  store: IndexTarget;
  sessionsDir: string;
  projectDir?: string;
  attribution?: { sessionId?: string; eventId?: string };
  maxFiles?: number;
  maxBytes?: number;
  /** Files indexed per pass. The rest waits for the next store open. */
  batchSize?: number;
  /** Re-run even when this project was already seeded. */
  force?: boolean;
}): number {
  const { store, sessionsDir, projectDir, attribution } = opts;
  if (!projectDir || !existsSync(projectDir)) return 0;
  const maxFiles = opts.maxFiles ?? 200;
  const maxBytes = opts.maxBytes ?? 4 * 1024 * 1024;
  // 15 files ≈ 190ms of FTS5 insert work on this machine (measured: ~12.5ms
  // per file, porter + trigram indexes). Small enough to disappear into a tool
  // call, large enough to finish a 200-file seed inside the first few calls.
  const batchSize = opts.batchSize ?? 15;

  const statePath = join(sessionsDir, CODE_INDEX_BOOTSTRAP_STATE);
  let state: BootstrapState = {};
  try {
    if (existsSync(statePath)) state = JSON.parse(readFileSync(statePath, "utf-8")) as BootstrapState;
  } catch { state = {}; }

  const existing = opts.force ? undefined : state[projectDir];
  if (existing?.done) return 0;

  // Plan on the first pass, then work through the plan a batch at a time.
  // Measured on this repo, seeding 200 files costs ~1.3s — too much to spend
  // inside one tool call, and unnecessary: 40 files per pass amortises it over
  // the first few calls, exactly as vector backfill already does for chunks.
  let pending = existing?.pending;
  if (!pending) {
    const planned = planBootstrap(projectDir, maxFiles, maxBytes);
    if (planned === null) {
      // Not a git repo, git missing, or a repo too large to list in 10s. Mark it
      // done anyway: retrying the same failure on every server start is pure cost.
      persistBootstrapState(statePath, state, projectDir, { pending: [], files: 0, done: true });
      return 0;
    }
    pending = planned;
  }

  const batch = pending.slice(0, batchSize);
  const rest = pending.slice(batchSize);

  let indexed = 0;
  for (const rel of batch) {
    const abs = join(projectDir, rel);
    try {
      if (!existsSync(abs)) continue;
      store.index({ path: abs, source: codeSourceLabel(abs, projectDir), attribution });
      indexed++;
    } catch { /* skip this file, keep seeding */ }
  }

  persistBootstrapState(statePath, state, projectDir, {
    pending: rest,
    files: (existing?.files ?? 0) + indexed,
    done: rest.length === 0,
  });
  return indexed;
}

interface BootstrapEntry {
  atMs: number;
  /** Project-relative paths still to index. */
  pending: string[];
  /** Files indexed so far across passes. */
  files: number;
  done: boolean;
}

type BootstrapState = Record<string, BootstrapEntry>;

/**
 * @returns Project-relative paths to seed, newest first, or null when the
 *   project's tracked-file list cannot be obtained.
 */
function planBootstrap(projectDir: string, maxFiles: number, maxBytes: number): string[] | null {
  let tracked: string[];
  try {
    const out = execFileSync("git", ["-C", projectDir, "ls-files", "-z"], {
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    tracked = out.split("\0").filter(Boolean);
  } catch {
    return null;
  }

  const candidates: Array<{ rel: string; size: number; mtimeMs: number }> = [];
  for (const rel of tracked) {
    const abs = join(projectDir, rel);
    if (!isIndexableSource(abs)) continue;
    try {
      const st = statSync(abs);
      if (!st.isFile() || st.size > MAX_INDEXABLE_BYTES) continue;
      candidates.push({ rel, size: st.size, mtimeMs: st.mtimeMs });
    } catch { /* vanished between ls-files and stat */ }
  }

  // Recency is the best cheap proxy for relevance: whatever the team touched
  // last week is what this session will ask about.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const planned: string[] = [];
  let bytes = 0;
  for (const file of candidates) {
    if (planned.length >= maxFiles || bytes + file.size > maxBytes) break;
    planned.push(file.rel);
    bytes += file.size;
  }
  return planned;
}

function persistBootstrapState(
  statePath: string,
  state: BootstrapState,
  projectDir: string,
  entry: Omit<BootstrapEntry, "atMs">,
): void {
  try {
    state[projectDir] = { atMs: Date.now(), ...entry };
    writeFileSync(statePath, JSON.stringify(state), "utf-8");
  } catch { /* best-effort — a lost marker only costs a repeat pass */ }
}
