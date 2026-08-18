/**
 * Sample 2 — folding environment dumps.
 *
 * `env`, `printenv`, `docker inspect --format '{{.Config.Env}}'` and every
 * "print my environment" debug block share one shape: dozens of `NAME=value`
 * lines of which the reader wanted two. Worse, the values are the single most
 * likely place in a shell transcript for a live credential to appear.
 *
 * So the fold does two things at once: it shows a small head and replaces the
 * tail with names only, and it screens every value it *does* print through the
 * existing credential screener in `src/session/redact.ts`. No second detector
 * is written here on purpose — one screener, one place to fix a miss.
 */

import { redactSecrets } from "../session/redact.js";
import type { CompressionPass } from "./types.js";
import { noPass } from "./types.js";

/** `NAME=` at the start of a line — the shape `env` prints. */
const ASSIGNMENT_LINE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Names listed in the marker before it gives up and prints a count. */
const MAX_NAMES_LISTED = 30;

export interface FoldEnvOptions {
  /** Run length that triggers a fold. Below this, the dump is not the problem. */
  minVars?: number;
  /** Assignments shown in full (screened) before the fold starts. */
  head?: number;
  /**
   * Print values for the head at all. `CONTEXT_MODE_COMPRESS_ENV_VALUES=0`
   * turns this off for callers who would rather see nothing than a screener
   * miss.
   */
  values?: boolean;
}

function nameOf(line: string): string {
  const eq = line.indexOf("=");
  return eq === -1 ? line : line.slice(0, eq);
}

/**
 * Screen one assignment line. Line-at-a-time on purpose: `redactSecrets` has
 * multi-line PEM handling that can change the line count, and an env run must
 * come back with exactly the lines it went in with.
 */
function screen(line: string): { line: string; hits: number } {
  const r = redactSecrets(line, { patterns: true, entropy: true });
  const screened = r.text.split("\n")[0] ?? line;
  return { line: screened, hits: r.count };
}

/**
 * Fold consecutive runs of `NAME=value` lines.
 *
 * Only consecutive runs count, so a single `FOO=bar` inside a build log is
 * left exactly where it was.
 */
export function foldEnvDump(text: string, opts: FoldEnvOptions = {}): CompressionPass {
  const minVars = Math.max(2, opts.minVars ?? 12);
  const head = Math.max(0, opts.head ?? 8);
  const showValues = opts.values !== false;
  if (!text) return noPass(text);

  const lines = text.split("\n");
  const out: string[] = [];
  let folded = 0;
  let vars = 0;
  let shown = 0;
  let hits = 0;
  let runs = 0;

  let i = 0;
  while (i < lines.length) {
    if (!ASSIGNMENT_LINE.test(lines[i])) {
      out.push(lines[i]);
      i++;
      continue;
    }

    let j = i;
    while (j < lines.length && ASSIGNMENT_LINE.test(lines[j])) j++;
    const run = lines.slice(i, j);

    if (run.length < minVars) {
      out.push(...run);
      i = j;
      continue;
    }

    const headCount = Math.min(head, run.length);
    for (let k = 0; k < headCount; k++) {
      if (showValues) {
        const s = screen(run[k]);
        hits += s.hits;
        out.push(s.line);
      } else {
        out.push(`${nameOf(run[k])}=[value hidden]`);
      }
    }

    const rest = run.slice(headCount);
    const names = rest.map(nameOf);
    const listed = names.slice(0, MAX_NAMES_LISTED);
    const extra = names.length - listed.length;
    out.push(
      `… x${rest.length} more env var(s) folded (names only): ` +
      listed.join(", ") +
      (extra > 0 ? `, +${extra} more` : ""),
    );

    folded += rest.length - 1; // rest dropped, one marker line added
    vars += run.length;
    shown += headCount;
    runs++;
    i = j;
  }

  if (runs === 0) return noPass(text);

  return {
    text: out.join("\n"),
    note: {
      sample: "env",
      label: "env dump",
      foldedLines: folded,
      detail:
        `${vars} var(s), ${shown} shown` +
        (showValues
          ? hits > 0 ? `, ${hits} secret value(s) redacted` : ""
          : ", values hidden"),
    },
  };
}
