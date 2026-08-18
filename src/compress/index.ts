/**
 * The output-compression layer.
 *
 * Three samples, run in order, each of which must say what it cost:
 *
 *   1. `test-output` — structural: keep failures and the summary, fold the
 *      green tail. Runs first because it knows what the whole document is.
 *   2. `env-dump`    — fold `NAME=value` blocks to a screened head plus names.
 *   3. `repeats`     — generic: fold runs of identical / near-identical lines.
 *
 * Everything a sample removes is reported through the same honest footer as a
 * byte-budget truncation (`formatTruncationFooter` in `src/truncate.ts`), so
 * the reader sees one accounting, not two.
 *
 * WHERE THIS MUST NOT RUN
 * -----------------------
 * `ctx_batch_execute` never returns raw command output — it indexes it into
 * FTS5 and answers the caller's queries from the index (see
 * `src/tools/batch.ts`). Compressing before that would delete the very lines a
 * later `ctx_search` is expected to find, and the section byte sizes printed in
 * the response would describe folded text rather than what is stored. So the
 * layer is opt-in per call and off by default: nothing on the indexing path
 * asks for it. `CONTEXT_MODE_EXEC_COMPRESS=1` turns it on process-wide, which
 * *does* reach the batch path — that is the documented cost of the switch.
 */

import type { ExecResult } from "../types.js";
import { formatTruncationFooter, truncateOutput } from "../truncate.js";
import type { OutputFooterNote } from "../truncate.js";
import { foldEnvDump } from "./env-dump.js";
import { foldRepeatedLines } from "./repeats.js";
import { foldTestOutput } from "./test-output.js";
import type { CompressionNote } from "./types.js";

export type { CompressionNote, CompressionPass } from "./types.js";
export { foldRepeatedLines, normalizeLogLine } from "./repeats.js";
export { foldEnvDump } from "./env-dump.js";
export { foldTestOutput, detectRunner } from "./test-output.js";

export interface CompressOptions {
  /** Fold the green tail of a recognised test runner. Default: on. */
  tests?: boolean;
  /** Fold `NAME=value` blocks. Default: on. */
  envDump?: boolean;
  /** Fold repeated / near-repeated lines. Default: on. */
  repeats?: boolean;
  /** Show (screened) values for the head of an env dump. Default: on. */
  envValues?: boolean;
  /** Consecutive repeats before the repeats sample folds. Default: 3. */
  minRun?: number;
  /** Consecutive assignments before the env sample folds. Default: 12. */
  minEnvVars?: number;
}

export interface CompressResult {
  text: string;
  notes: CompressionNote[];
  /** Total lines removed across all samples. */
  foldedLines: number;
}

/**
 * Per-sample switches, all defaulting to on *within* the layer. They only
 * matter once something has decided to run the layer at all — see
 * `outputCompressionEnabled`.
 */
export function compressOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): CompressOptions {
  return {
    tests: env.CONTEXT_MODE_COMPRESS_TESTS !== "0",
    envDump: env.CONTEXT_MODE_COMPRESS_ENV !== "0",
    repeats: env.CONTEXT_MODE_COMPRESS_REPEATS !== "0",
    envValues: env.CONTEXT_MODE_COMPRESS_ENV_VALUES !== "0",
  };
}

/**
 * Should this call be compressed at all?
 *
 * `CONTEXT_MODE_EXEC_COMPRESS=0` is a hard kill switch — it beats an explicit
 * opt-in, so one env var disables the feature everywhere when a fold turns out
 * to be wrong. Otherwise the per-call flag decides, and when the caller says
 * nothing the answer is "only if `CONTEXT_MODE_EXEC_COMPRESS=1`".
 */
export function outputCompressionEnabled(
  optIn?: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.CONTEXT_MODE_EXEC_COMPRESS === "0") return false;
  if (optIn !== undefined) return optIn;
  return env.CONTEXT_MODE_EXEC_COMPRESS === "1";
}

/** Run the samples. Pure: no env reads beyond what the caller resolved. */
export function compressOutput(text: string, opts: CompressOptions = {}): CompressResult {
  const notes: CompressionNote[] = [];
  let out = text;

  if (opts.tests !== false) {
    const pass = foldTestOutput(out);
    out = pass.text;
    if (pass.note) notes.push(pass.note);
  }

  if (opts.envDump !== false) {
    const pass = foldEnvDump(out, {
      minVars: opts.minEnvVars,
      values: opts.envValues !== false,
    });
    out = pass.text;
    if (pass.note) notes.push(pass.note);
  }

  if (opts.repeats !== false) {
    const pass = foldRepeatedLines(out, { minRun: opts.minRun });
    out = pass.text;
    if (pass.note) notes.push(pass.note);
  }

  return {
    text: out,
    notes,
    foldedLines: notes.reduce((n, note) => n + note.foldedLines, 0),
  };
}

/** Compression notes in the shape the truncation footer consumes. */
export function toFooterNotes(notes: CompressionNote[]): OutputFooterNote[] {
  return notes.map(n => ({ label: n.label, foldedLines: n.foldedLines, detail: n.detail }));
}

export interface CompressTextOptions extends CompressOptions {
  /** Byte budget for the returned text, footer included. Default: unbounded. */
  maxBytes?: number;
  /** Line budget for the returned text. Default: unbounded. */
  maxLines?: number;
}

/**
 * Compress, then truncate, then footer — the whole pipeline for one blob of
 * command output. The footer reports both halves in one place.
 */
export function compressAndTruncate(
  text: string,
  opts: CompressTextOptions = {},
): { text: string; notes: CompressionNote[] } {
  const compressed = compressOutput(text, opts);
  const { text: out } = truncateOutput(compressed.text, opts.maxBytes ?? Infinity, {
    maxLines: opts.maxLines,
    notes: toFooterNotes(compressed.notes),
  });
  return { text: out, notes: compressed.notes };
}

/**
 * Executor hook: fold `result.stdout` and append the footer, or hand the
 * result back untouched (same object) when compression is not enabled.
 *
 * Only stdout is folded. stderr carries the executor's own kill/cap notes and
 * is short by construction; folding it would risk eating the one line that
 * explains why a run ended.
 */
export function compressExecResult(
  result: ExecResult,
  optIn?: boolean,
  env: NodeJS.ProcessEnv = process.env,
): ExecResult {
  if (!outputCompressionEnabled(optIn, env)) return result;
  if (!result.stdout) return result;

  const compressed = compressOutput(result.stdout, compressOptionsFromEnv(env));
  if (compressed.notes.length === 0) return result;

  const stats = {
    shownLines: compressed.text.split("\n").length,
    totalLines: compressed.text.split("\n").length,
    shownBytes: Buffer.byteLength(compressed.text),
    totalBytes: Buffer.byteLength(compressed.text),
  };
  const footer = formatTruncationFooter(stats, toFooterNotes(compressed.notes));
  return {
    ...result,
    stdout: footer ? `${compressed.text}\n${footer}` : compressed.text,
  };
}
