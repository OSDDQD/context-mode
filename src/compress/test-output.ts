/**
 * Sample 3 — folding the green tail of a test run.
 *
 * A test runner prints one line per passing file and twenty per failing
 * assertion. The reader wants the twenty and the summary; the hundred green
 * ticks are a progress bar that has already finished. This fold drops runs of
 * passing lines and keeps everything else — failures, diffs, stack frames,
 * counts — untouched, because "everything else" is where the answer is.
 *
 * Recognised: vitest, jest, pytest, `go test`. When no runner is recognised the
 * sample does nothing at all; a generic log is the repeats sample's job.
 */

import type { CompressionPass } from "./types.js";
import { noPass } from "./types.js";

export type TestRunner = "vitest" | "jest" | "pytest" | "go";

/** Signatures that identify the runner. First match wins. */
const RUNNER_SIGNATURES: ReadonlyArray<readonly [TestRunner, RegExp]> = [
  ["vitest", /^\s*(?:RUN|DEV)\s+v\d|^\s*Test Files\s+\d|^\s*(?:✓|❯|×)\s+\S+\.[cm]?[jt]sx?\b/m],
  ["jest", /^(?:PASS|FAIL)\s+\S|^Tests:\s+\d|^Test Suites:\s+\d/m],
  ["pytest", /=+\s*(?:test session starts|FAILURES|short test summary info)\s*=+|^\S+\.py\s+[.sFEx]+/m],
  ["go", /^(?:ok|FAIL|---\s+(?:PASS|FAIL|SKIP)|===\s+RUN)\b/m],
];

/** Lines that mean "this passed" and nothing else. */
const GREEN_LINE: ReadonlyArray<RegExp> = [
  // vitest / jest tick, optionally with a duration suffix
  /^\s*(?:✓|✔|√)\s+\S/,
  // jest per-suite banner
  /^\s*PASS\s+\S/,
  // go: package ok, per-test PASS/SKIP, RUN banners, bare PASS
  /^ok\s+\S/,
  /^\s*---\s+(?:PASS|SKIP):/,
  /^\s*===\s+(?:RUN|CONT|PAUSE)\b/,
  /^PASS$/,
  // pytest progress line with no failure markers, and -v result lines
  /^\S+\.py\s+[.s]+\s*(?:\[\s*\d+%\])?\s*$/,
  /^\S+::\S+\s+(?:PASSED|SKIPPED)\b/,
  /^\s*(?:PASSED|SKIPPED)\s+\S/,
];

/** Lines the reader is here for — counted so the footer can say they survived. */
const FAILURE_LINE = /^\s*(?:FAIL\b|FAILED\b|×\s|✗\s|✘\s|---\s+FAIL:|E\s{3})|\bAssertionError\b/;

export interface FoldTestOutputOptions {
  /** Green lines in a row before the run is folded. */
  minRun?: number;
  /** Force the runner instead of sniffing it (tests, callers that know). */
  runner?: TestRunner;
}

/** Which runner produced this output, or null when it is not test output. */
export function detectRunner(text: string): TestRunner | null {
  for (const [runner, re] of RUNNER_SIGNATURES) {
    if (re.test(text)) return runner;
  }
  return null;
}

function isGreen(line: string): boolean {
  return GREEN_LINE.some(re => re.test(line));
}

/** Fold runs of passing lines; keep failures, summaries and everything else. */
export function foldTestOutput(text: string, opts: FoldTestOutputOptions = {}): CompressionPass {
  if (!text) return noPass(text);
  const runner = opts.runner ?? detectRunner(text);
  if (!runner) return noPass(text);

  const minRun = Math.max(2, opts.minRun ?? 2);
  const lines = text.split("\n");
  const out: string[] = [];
  let folded = 0;
  let greenSeen = 0;
  let failureLines = 0;

  let i = 0;
  while (i < lines.length) {
    if (!isGreen(lines[i])) {
      if (FAILURE_LINE.test(lines[i])) failureLines++;
      out.push(lines[i]);
      i++;
      continue;
    }

    let j = i;
    while (j < lines.length && isGreen(lines[j])) j++;
    const run = j - i;
    greenSeen += run;

    if (run >= minRun) {
      out.push(`… x${run} passing line(s) folded`);
      folded += run - 1;
    } else {
      for (let k = i; k < j; k++) out.push(lines[k]);
    }
    i = j;
  }

  if (folded === 0) return noPass(text);

  return {
    text: out.join("\n"),
    note: {
      sample: "tests",
      label: "test output",
      foldedLines: folded,
      detail: `${runner}, ${greenSeen} green line(s), ${failureLines} failure line(s) kept`,
    },
  };
}
