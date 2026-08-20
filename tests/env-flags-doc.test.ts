/**
 * `docs/env-flags.md` must list every `CONTEXT_MODE_*` flag the code reads.
 *
 * The reference exists because nobody could answer "which of these ~140
 * variables matters, what does it default to, and which layer owns it". A
 * hand-copied table answers that for about a week: flags are added in the
 * layer that needs them, never in a central registry, and the doc goes stale
 * silently. So the doc is checked against the source instead of trusted.
 *
 * Both directions are pinned:
 *
 *   1. A flag read in `src/` or `hooks/` and missing from the doc fails here.
 *      Fix by adding the row — with a real default and a real "when you would
 *      touch it", not a placeholder.
 *   2. A flag documented under a `## Layer:` heading that no longer exists in
 *      the source fails here too, so deletions clean the doc up.
 *
 * Detection deliberately does NOT grep for the bare name:
 *
 *   - Comment lines are skipped. A doc comment that wraps mid-identifier
 *     (`CONTEXT_MODE_FIND_` + `<SIGNAL>` across two lines in `src/search/
 *     find.ts`) would otherwise register as a flag that does not exist.
 *   - A name only counts when it appears as a string literal — the form every
 *     `const X_ENV = "CONTEXT_MODE_X"` declaration uses — or as a property
 *     read off an env object (`process.env.CONTEXT_MODE_X`, `env.CONTEXT_MODE_X`).
 *     `hooks/core/routing.mjs` has a plain JS constant literally named
 *     `CONTEXT_MODE_SUBSTRING` holding the string "context-mode"; it is an
 *     identifier, never an environment key, and this rule excludes it without
 *     needing an allowlist that would then need maintaining.
 *   - `PI_CONTEXT_MODE_*` (the host's own variables) is excluded by requiring
 *     no identifier character before `CONTEXT_MODE_`.
 *   - Generated `*.bundle.*` files are skipped: they duplicate their sources,
 *     and a stale bundle must not be able to keep a deleted flag "alive".
 *
 * The known gap: a flag assembled at runtime from a template literal is
 * invisible to this check. There are none today, and adding one should be
 * argued for on its own merits rather than smuggled past the reference.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, extname, relative } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const DOC_PATH = join(REPO_ROOT, "docs", "env-flags.md");
const SCAN_DIRS = ["src", "hooks"];
const SOURCE_EXTENSIONS = new Set([".ts", ".mts", ".mjs", ".js", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build"]);

const FLAG_NAME = String.raw`CONTEXT_MODE_[A-Z0-9_]*[A-Z0-9]`;
/** `"CONTEXT_MODE_X"` — how every `const X_ENV = …` declaration spells it. */
const AS_STRING_LITERAL = new RegExp(String.raw`(?<![A-Z0-9_])["'\`](${FLAG_NAME})["'\`]`, "g");
/** `process.env.CONTEXT_MODE_X` / `env.CONTEXT_MODE_X` — the direct read. */
const AS_ENV_PROPERTY = new RegExp(String.raw`\benv\.(${FLAG_NAME})(?![A-Z0-9_])`, "g");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      sourceFiles(full, out);
    } else if (SOURCE_EXTENSIONS.has(extname(entry.name)) && !entry.name.includes(".bundle.")) {
      out.push(full);
    }
  }
  return out;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*");
}

/** Every flag the source actually reads, mapped to where it was first seen. */
function flagsInSource(): Map<string, string> {
  const found = new Map<string, string>();
  for (const dir of SCAN_DIRS) {
    for (const file of sourceFiles(join(REPO_ROOT, dir))) {
      const rel = relative(REPO_ROOT, file);
      readFileSync(file, "utf-8").split("\n").forEach((line, index) => {
        if (isCommentLine(line)) return;
        for (const pattern of [AS_STRING_LITERAL, AS_ENV_PROPERTY]) {
          pattern.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = pattern.exec(line)) !== null) {
            if (!found.has(match[1])) found.set(match[1], `${rel}:${index + 1}`);
          }
        }
      });
    }
  }
  return found;
}

/**
 * Flags documented in the layer tables, grouped by the heading that owns them.
 * The "Flag families" section is excluded on purpose: it names flags that do
 * not exist yet, as proposals.
 */
function documentedByLayer(): Map<string, string[]> {
  const byLayer = new Map<string, string[]>();
  let heading: string | null = null;
  for (const line of readFileSync(DOC_PATH, "utf-8").split("\n")) {
    if (line.startsWith("## ")) {
      heading = line.startsWith("## Layer:") ? line.slice(3).trim() : null;
      if (heading) byLayer.set(heading, []);
      continue;
    }
    if (!heading || !line.startsWith("|")) continue;
    const firstCell = line.split("|")[1] ?? "";
    const match = firstCell.match(new RegExp(String.raw`\`(${FLAG_NAME})\``));
    if (match) byLayer.get(heading)?.push(match[1]);
  }
  return byLayer;
}

function flagsInDoc(): Set<string> {
  return new Set([...documentedByLayer().values()].flat());
}

describe("docs/env-flags.md stays honest", () => {
  it("has a readable layer table", () => {
    expect(statSync(DOC_PATH).isFile()).toBe(true);
    // A parser bug that silently matched nothing would make every other
    // assertion here vacuously pass.
    expect(flagsInDoc().size).toBeGreaterThan(100);
  });

  it("documents every CONTEXT_MODE_* flag the source reads", () => {
    const source = flagsInSource();
    const documented = flagsInDoc();
    const undocumented = [...source.entries()]
      .filter(([flag]) => !documented.has(flag))
      .map(([flag, where]) => `${flag} (${where})`)
      .sort();

    expect(
      undocumented,
      `New env flags are missing from docs/env-flags.md. Add a row under the ` +
      `owning "## Layer:" table with its real default and when an operator ` +
      `would set it:\n  ${undocumented.join("\n  ")}`,
    ).toEqual([]);
  });

  it("documents no flag the source has stopped reading", () => {
    const source = flagsInSource();
    const stale = [...flagsInDoc()].filter((flag) => !source.has(flag)).sort();

    expect(
      stale,
      `docs/env-flags.md documents flags that no longer exist in src/ or ` +
      `hooks/. Remove the rows:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
  });

  it("keeps the flag count in each layer heading truthful", () => {
    // The headings carry a count so a reader can see the shape of the surface
    // without counting rows. A count that drifts is worse than no count, and
    // nothing else in this suite would notice it moving.
    const wrong: string[] = [];
    for (const [heading, flags] of documentedByLayer()) {
      const claimed = heading.match(/\((\d+)\)\s*$/);
      if (!claimed) {
        wrong.push(`${heading} — heading carries no "(N)" count`);
        continue;
      }
      if (Number(claimed[1]) !== flags.length) {
        wrong.push(`${heading} — heading says ${claimed[1]}, table has ${flags.length}`);
      }
    }
    expect(wrong, `Layer headings in docs/env-flags.md disagree with their tables:\n  ${wrong.join("\n  ")}`).toEqual([]);
  });
});
