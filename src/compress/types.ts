/**
 * Shared vocabulary for the output-compression samples.
 *
 * Every sample obeys the same contract: it returns the shortened text *and* a
 * note saying how many lines it removed. A fold that cannot say what it cost
 * is indistinguishable from data loss, which is the exact failure mode
 * `src/search/completeness.ts` fixed on the retrieval side.
 */

/** What one compression sample did to the text. */
export interface CompressionNote {
  /** Stable id of the sample, for tests and for programmatic consumers. */
  sample: "tests" | "env" | "repeats";
  /** Short human label used in the footer. */
  label: string;
  /** Lines removed from the output by this sample. Never negative. */
  foldedLines: number;
  /** One-liner detail rendered inside the footer parentheses. */
  detail: string;
}

/** Result of a single sample pass. `note` is null when the sample did nothing. */
export interface CompressionPass {
  text: string;
  note: CompressionNote | null;
}

/** Unchanged text, no note — the "sample did not fire" result. */
export function noPass(text: string): CompressionPass {
  return { text, note: null };
}
