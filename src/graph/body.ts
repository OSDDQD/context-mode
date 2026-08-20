/**
 * The third level of answer: the source of ONE symbol.
 *
 * `ctx_graph action: "outline"` gives a file's silhouette — every declaration,
 * no bodies. Below that silhouette there was nothing, so "show me function X"
 * degraded into a Read of the whole file: 2 000 lines entering context to
 * deliver the 30 that were asked for. That is the single largest remaining
 * leak in this plugin, and it is entirely avoidable — codegraph already stores
 * `file_path`, `start_line` and `end_line` for every node.
 *
 * This module owns the one thing `src/graph/queries.ts` deliberately does not:
 * file I/O. Its header promises "no I/O beyond the read-only connection", and
 * that promise is worth keeping, so the SQL stays there and the disk read lives
 * here.
 *
 * ## Two failure modes this code refuses to paper over
 *
 * 1. **Stale index.** `start_line`/`end_line` were true when the file was
 *    indexed. If the file has been edited since, those numbers now point at
 *    whatever moved into that range — plausible-looking source belonging to a
 *    different function. Returning it silently is worse than returning nothing,
 *    because the caller has no way to tell. {@link readSymbolBody} stats the
 *    file and reports the mismatch as data.
 * 2. **A huge body.** A 2 000-line class is not an answer, it is a Read wearing
 *    a different tool's name. The slice is cut at a byte budget and says so.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { GraphDbHandle } from "./db.js";
import { fileIndexedAt, normalizeFilePath, type SymbolRow } from "./queries.js";

/** Bytes of symbol source returned before the slice is cut. */
export const BODY_BUDGET_BYTES = 8_000;

/**
 * Same slack `checkFreshness` uses: the daemon writes `indexed_at` after
 * reading the file, so an equal-second mtime is not evidence of an edit.
 */
const STALE_TOLERANCE_MS = 1_000;

/** Read granularity. Large enough that a typical body is one or two reads. */
const CHUNK_BYTES = 64 * 1024;

/** `CONTEXT_MODE_GRAPH_BODY_BUDGET` overrides {@link BODY_BUDGET_BYTES}. */
export function bodyBudgetBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CONTEXT_MODE_GRAPH_BODY_BUDGET;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : BODY_BUDGET_BYTES;
}

export interface SymbolBody {
  /** Project-relative path, as stored in the index. */
  filePath: string;
  /** First line of the symbol, 1-based, as the index recorded it. */
  startLine: number;
  /** Last line of the symbol per the index. */
  endLine: number;
  /** Last line actually included — below {@link endLine} when cut. */
  lastLine: number;
  /** The source, newline-joined, without a trailing newline. */
  text: string;
  /** True when the byte budget cut the slice short. */
  truncated: boolean;
  /** UTF-8 bytes of {@link text}. */
  bytes: number;
  /**
   * `true` — the file's mtime is newer than its `files.indexed_at` row, so the
   * line range may name different code than it did at index time.
   * `false` — the index is demonstrably current for this file.
   * `null` — the file has no `files` row, so staleness is unknowable; that is
   * reported as unknown rather than guessed in either direction.
   */
  stale: boolean | null;
  /** Set when the file could not be opened or read at all. */
  error?: string;
}

/**
 * Slice one symbol's lines out of its file.
 *
 * Reads forward in fixed chunks and stops at `endLine` (or at the budget),
 * so a 40-line function inside a 4 MB generated file costs one 64 KB read —
 * never the whole file in the server's memory, which is the shape
 * `readFileSync(...).split("\n")` would have had.
 */
export function readSymbolBody(
  handle: GraphDbHandle,
  row: SymbolRow,
  opts: { maxBytes?: number; env?: NodeJS.ProcessEnv } = {},
): SymbolBody {
  const env = opts.env ?? process.env;
  const maxBytes = opts.maxBytes ?? bodyBudgetBytes(env);
  const filePath = normalizeFilePath(handle.projectDir, row.filePath);
  // A node with a broken range still deserves an answer: clamp rather than
  // throw, and let the caller see the (possibly single-line) result.
  const from = Math.max(1, Math.floor(row.startLine) || 1);
  const to = Math.max(from, Math.floor(row.endLine) || from);

  const base: SymbolBody = {
    filePath,
    startLine: from,
    endLine: to,
    lastLine: from - 1,
    text: "",
    truncated: false,
    bytes: 0,
    stale: null,
  };

  const abs = isAbsolute(filePath) ? filePath : join(handle.projectDir, filePath);

  // Staleness is decided BEFORE the read, from the same two facts the freshness
  // sweep uses, so the verdict describes the bytes we are about to hand over.
  const indexedAt = fileIndexedAt(handle, filePath);
  try {
    const st = statSync(abs);
    if (indexedAt !== null) base.stale = st.mtimeMs > indexedAt + STALE_TOLERANCE_MS;
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const slice = readLineRange(abs, from, to, maxBytes);
    return {
      ...base,
      text: slice.lines.join("\n"),
      lastLine: slice.lastLine,
      truncated: slice.truncated,
      bytes: slice.bytes,
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

interface LineRange {
  lines: string[];
  lastLine: number;
  truncated: boolean;
  bytes: number;
}

/**
 * Lines `[from, to]` of a file, streamed.
 *
 * `StringDecoder` rather than `buf.toString()` because a chunk boundary lands
 * mid-codepoint often enough to matter: a naive per-chunk decode turns one
 * multi-byte character into two replacement characters, and the corruption is
 * invisible until someone copies the snippet back into a file.
 */
function readLineRange(abs: string, from: number, to: number, maxBytes: number): LineRange {
  const fd = openSync(abs, "r");
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  const decoder = new StringDecoder("utf8");
  const lines: string[] = [];
  let lineNo = 1;
  let pending = "";
  let bytes = 0;
  let truncated = false;
  let done = false;

  /** @returns false when the caller should stop reading entirely. */
  const take = (raw: string): boolean => {
    if (lineNo > to) return false;
    if (lineNo >= from) {
      // `\r` is stripped so a CRLF checkout does not smuggle a carriage return
      // into every line of the answer.
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      const cost = Buffer.byteLength(line, "utf-8") + 1;
      // Cut BEFORE appending: a budget enforced after the fact is not a budget.
      // The first line is always kept, so a single over-long line yields the
      // line rather than an empty body with a truncation notice.
      if (lines.length > 0 && bytes + cost > maxBytes) {
        truncated = true;
        return false;
      }
      lines.push(line);
      bytes += cost;
    }
    lineNo++;
    return true;
  };

  try {
    while (!done) {
      const n = readSync(fd, buf, 0, CHUNK_BYTES, null);
      pending += n > 0 ? decoder.write(buf.subarray(0, n)) : decoder.end();
      const eof = n <= 0;

      let idx = pending.indexOf("\n");
      while (idx >= 0) {
        const raw = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        if (!take(raw)) { done = true; break; }
        idx = pending.indexOf("\n");
      }
      if (done) break;

      if (eof) {
        // A final line without a trailing newline is still a line.
        if (pending.length > 0) take(pending);
        break;
      }
    }
  } finally {
    closeSync(fd);
  }

  // `truncated` stays strictly "the byte budget cut it". A short `lastLine`
  // with `truncated: false` means the file ended before the indexed range did
  // — a different fact, with a different remedy (reindex, not raise the
  // budget), so the two are never merged into one flag.
  const lastLine = lines.length > 0 ? from + lines.length - 1 : from - 1;
  return { lines, lastLine, truncated, bytes };
}
