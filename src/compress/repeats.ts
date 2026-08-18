/**
 * Sample 1 — folding repeated (and near-repeated) log lines.
 *
 * A retry loop that prints the same line 400 times with a fresh timestamp is
 * 400 lines of context for one fact. The fold keeps the first line of a run and
 * replaces the rest with a counted marker, so the reader still sees the shape
 * of the log and knows exactly how many lines stand behind the marker.
 *
 * "Near-repeated" is defined by normalization, not by edit distance: two lines
 * belong to the same run when they are identical after timestamps, uuids, hex
 * ids and bare numbers are replaced by placeholders. That is cheap, ordering-
 * stable, and — unlike a similarity threshold — never folds two lines that
 * differ in a word.
 */

import type { CompressionPass } from "./types.js";
import { noPass } from "./types.js";

/**
 * Applied in order. Longest/most specific patterns first so a full ISO
 * timestamp is not eaten piecemeal by the bare-number rule.
 */
const NORMALIZERS: ReadonlyArray<readonly [RegExp, string]> = [
  // 2026-08-18T11:22:33.456Z / 2026-08-18 11:22:33,456+02:00
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>"],
  // 2026-08-18 and 18/08/2026
  [/\d{4}-\d{2}-\d{2}/g, "<date>"],
  [/\d{2}\/\d{2}\/\d{4}/g, "<date>"],
  // 11:22:33.456
  [/\d{2}:\d{2}:\d{2}(?:[.,]\d+)?/g, "<time>"],
  // uuid
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>"],
  // 0xdeadbeef and long hex runs (object ids, sha prefixes)
  [/0x[0-9a-f]+/gi, "<hex>"],
  [/\b[0-9a-f]{7,40}\b/gi, "<hex>"],
  // durations, sizes, percentages — the counter case
  [/\d+(?:\.\d+)?\s?(?:ms|µs|us|ns|s|%|[KMGT]i?B)\b/gi, "<num><unit>"],
  // anything else numeric
  [/\d+(?:\.\d+)?/g, "<num>"],
];

/**
 * Collapse a line to its shape. Exported because the normalization rule is the
 * whole contract of this sample and deserves its own tests.
 */
export function normalizeLogLine(line: string): string {
  let out = line;
  for (const [re, repl] of NORMALIZERS) out = out.replace(re, repl);
  return out;
}

export interface FoldRepeatsOptions {
  /**
   * Minimum run length before a fold happens. 3 is the smallest value where
   * the marker is shorter than the lines it replaces.
   */
  minRun?: number;
}

/** Leading whitespace of a line, so the marker lines up with the run. */
function indentOf(line: string): string {
  return /^\s*/.exec(line)?.[0] ?? "";
}

/**
 * Fold consecutive runs of identical / near-identical lines.
 *
 * Only *consecutive* runs fold. Folding across the whole text would reorder
 * the log, and a log whose order is a lie is worse than a long one.
 */
export function foldRepeatedLines(text: string, opts: FoldRepeatsOptions = {}): CompressionPass {
  const minRun = Math.max(2, opts.minRun ?? 3);
  if (!text) return noPass(text);

  const lines = text.split("\n");
  if (lines.length < minRun) return noPass(text);

  const out: string[] = [];
  let folded = 0;
  let runs = 0;
  let longest = 0;

  let i = 0;
  while (i < lines.length) {
    const first = lines[i];
    const key = normalizeLogLine(first);
    let j = i + 1;
    while (j < lines.length && normalizeLogLine(lines[j]) === key) j++;

    const runLength = j - i;
    if (runLength >= minRun) {
      const exact = lines.slice(i, j).every(l => l === first);
      out.push(first);
      out.push(
        `${indentOf(first)}… x${runLength - 1} more ` +
        `${exact ? "identical" : "near-identical"} line(s) folded` +
        `${exact ? "" : " (differ only in timestamp/counter)"}`,
      );
      folded += runLength - 2; // run - 1 dropped lines, + 1 marker line added
      runs++;
      if (runLength > longest) longest = runLength;
    } else {
      for (let k = i; k < j; k++) out.push(lines[k]);
    }
    i = j;
  }

  if (runs === 0) return noPass(text);

  return {
    text: out.join("\n"),
    note: {
      sample: "repeats",
      label: "repeats",
      foldedLines: folded,
      detail: `${runs} run(s), longest x${longest}`,
    },
  };
}
