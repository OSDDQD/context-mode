/**
 * The host's own persistent memory — the files Claude Code writes and reloads
 * on every session, not the ones context-mode owns.
 *
 * These are two different stores that both call themselves "memory":
 *
 *   - `adapter.getMemoryDir()` → `<configDir>/memory/<sha256(projectDir)[:16]>`
 *     context-mode's own namespace, keyed by a hash.
 *   - Claude Code → `<configDir>/projects/<slugified-project-path>/memory/`
 *     curated `.md` files with frontmatter, plus a `MEMORY.md` index.
 *
 * `searchAutoMemory` only ever looked at the first path. Claude Code has never
 * written there, so on a normal install that directory does not exist at all
 * and every memory file the user curated was invisible to `ctx_search` — while
 * `ctx_stats` counted the same files correctly through a different code path
 * ("52 preferences picked up across 7 projects"). The system reported that it
 * had the memory and could not retrieve a word of it.
 *
 * This module resolves the host path so both halves finally agree.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Claude Code's project-directory naming: path separators become dashes.
 * `/home/u/projects/app` → `-home-u-projects-app`.
 *
 * `fold` also collapses the other characters the host rewrites — dots and
 * underscores. This is not cosmetic: `/home/u/projects/casino_front` is stored
 * as `-home-u-projects-casino-front`, so the unfolded slug misses it entirely.
 */
export function projectSlug(projectDir: string, fold = false): string {
  const normalized = projectDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const slug = normalized.replace(/\//g, "-");
  return fold ? slug.replace(/[._]/g, "-") : slug;
}

/**
 * Aggressive normalisation used to match a directory the host named under
 * rules this version may not know: everything that is not alphanumeric
 * becomes a single dash.
 */
function normalizeSlug(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/-+/g, "-").toLowerCase();
}

/**
 * @param configDir Host config root (`~/.claude` or `$CLAUDE_CONFIG_DIR`).
 * @param projectDir Absolute project path.
 * @returns Existing host memory directories for this project — usually one,
 *   empty when the user has never saved a memory here.
 */
export function resolveHostMemoryDirs(configDir: string, projectDir?: string): string[] {
  if (!configDir || !projectDir) return [];
  const projectsRoot = join(configDir, "projects");
  if (!existsSync(projectsRoot)) return [];

  const candidates = [
    join(projectsRoot, projectSlug(projectDir), "memory"),
    join(projectsRoot, projectSlug(projectDir, true), "memory"),
  ];

  const found = candidates.filter((dir, i) => candidates.indexOf(dir) === i && existsSync(dir));
  if (found.length > 0) return found;

  // Slug rules have shifted between Claude Code versions. Rather than encode
  // every past variant, match on the shape we know is stable: a directory
  // whose name is the project path with separators replaced by *something*.
  try {
    const wanted = normalizeSlug(projectDir);
    for (const entry of readdirSync(projectsRoot)) {
      if (normalizeSlug(entry) !== wanted) continue;
      const dir = join(projectsRoot, entry, "memory");
      if (existsSync(dir)) return [dir];
    }
  } catch { /* unreadable projects root */ }

  return [];
}

/**
 * @returns Absolute paths of the host's memory markdown files for this project.
 */
export function listHostMemoryFiles(configDir: string, projectDir?: string): string[] {
  const out: string[] = [];
  for (const dir of resolveHostMemoryDirs(configDir, projectDir)) {
    try {
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".md")) out.push(join(dir, f));
      }
    } catch { /* unreadable — skip this dir */ }
  }
  return out;
}

/** Minimal store surface needed to index memory files. */
export interface MemoryIndexTarget {
  index(options: { path?: string; source?: string; attribution?: { sessionId?: string; eventId?: string } }): unknown;
}

/**
 * Index the host's memory files into the FTS5 store.
 *
 * Plain file scanning (searchAutoMemory) already makes these searchable, but
 * only through its own substring pass. Indexing puts them in the same store as
 * everything else, which buys three things that scanning cannot:
 * `query_scope: "global"` inside ctx_batch_execute reaches them, the optional
 * semantic layer can match a paraphrase (or a Russian query against an English
 * memory file), and the content hash flags a memory as stale after an edit.
 *
 * Indexing only — never injection. The host already loads MEMORY.md into every
 * session's context; re-injecting the same bytes would spend context to
 * duplicate what is already there.
 *
 * Scoped to the current project (issue #663): a memory saved in one project
 * must not surface while working in another.
 *
 * @returns Number of memory files indexed.
 */
export function indexHostMemory(opts: {
  store: MemoryIndexTarget;
  configDir: string;
  projectDir?: string;
  attribution?: { sessionId?: string; eventId?: string };
}): number {
  const files = listHostMemoryFiles(opts.configDir, opts.projectDir);
  let indexed = 0;
  for (const file of files) {
    try {
      const name = file.split(/[\\/]/).pop() ?? file;
      opts.store.index({ path: file, source: `memory:${name}`, attribution: opts.attribution });
      indexed++;
    } catch { /* skip this file, keep going */ }
  }
  return indexed;
}
