/**
 * truncate — Pure string truncation and escaping utilities for context-mode.
 *
 * These helpers are used by the core ContentStore (chunking) and
 * SessionDB (snapshot building). They are extracted here so any
 * consumer can import them without pulling in the full store or executor.
 *
 * Honest truncation
 * -----------------
 * A bare `... [truncated]` tells the reader that something was lost but not
 * whether it was two lines or two thousand — and that difference decides
 * whether they need to go get the rest. The retrieval side fixed the same bug
 * with `src/search/completeness.ts`; the footer below is its output-side twin
 * and deliberately copies its shape (`> ` prefixed, "showing X of Y", one line
 * per fact) so a reader who has learned one has learned both.
 *
 * `truncateJSON` and `capBytes` keep their historic markers byte-for-byte:
 * their callers (and `tests/truncate.test.ts`) pin the exact string, and a
 * display marker is not worth an API break. `truncateJSON` can opt into the
 * counted marker per call or via `CONTEXT_MODE_TRUNCATE_COUNTERS=1`.
 */

// ─────────────────────────────────────────────────────────
// Internal: byte-safe prefix
// ─────────────────────────────────────────────────────────

/**
 * Return the longest character-prefix of `str` whose UTF-8 encoding is at
 * most `maxBytes` bytes. Uses binary search to avoid O(n²) scanning. Returns
 * "" when `maxBytes` is <= 0 so callers never exceed their budget.
 *
 * Guards against splitting a UTF-16 surrogate pair: if the prefix would end
 * on a lone high surrogate, back off one code unit so the result round-trips
 * through UTF-8 without producing a U+FFFD replacement character.
 */
function byteSafePrefix(str: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(str) <= maxBytes) return str;

  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(str.slice(0, mid)) <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  // If we landed between a high and low surrogate, back off so the prefix
  // ends on a valid code point boundary.
  if (lo > 0) {
    const code = str.charCodeAt(lo - 1);
    if (code >= 0xd800 && code <= 0xdbff) lo -= 1;
  }
  return str.slice(0, lo);
}

// ─────────────────────────────────────────────────────────
// Char-count prefix (UTF-16 surrogate-safe)
// ─────────────────────────────────────────────────────────

/**
 * Return a prefix of `str` no longer than `maxChars` UTF-16 code units, with
 * the cut backed off by one unit if it would split a surrogate pair. Mirrors
 * the surrogate-safety semantics of the internal `byteSafePrefix`, but uses
 * a character budget rather than a byte budget.
 *
 * Use this instead of bare `str.slice(0, n)` whenever the result is later
 * JSON-encoded for an RFC 8259-strict consumer (e.g. tool_result payloads
 * sent back to the host LLM API). `JSON.stringify` will emit a lone high
 * surrogate as a literal `\uD8xx` escape, which is invalid JSON.
 *
 * @param str      - Input string.
 * @param maxChars - Hard cap in UTF-16 code units.
 */
export function charSafePrefix(str: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (str.length <= maxChars) return str;

  let end = maxChars;
  const code = str.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return str.slice(0, end);
}

// ─────────────────────────────────────────────────────────
// JSON truncation
// ─────────────────────────────────────────────────────────

/**
 * Serialize a value to JSON, then truncate the result to `maxBytes` bytes.
 * If truncation occurs, the string is cut at a UTF-8-safe boundary and
 * "... [truncated]" is appended. The result is NOT guaranteed to be valid
 * JSON after truncation — it is suitable only for display/logging.
 *
 * The returned string is always <= `maxBytes` bytes. When `maxBytes` is
 * smaller than the marker, the marker itself is byte-safely truncated.
 *
 * @param value    - Any JSON-serializable value.
 * @param maxBytes - Maximum byte length of the returned string.
 * @param indent   - JSON indentation spaces (default 2). Pass 0 for compact.
 */
export function truncateJSON(
  value: unknown,
  maxBytes: number,
  indent: number = 2,
  opts: { counters?: boolean } = {},
): string {
  const serialized = JSON.stringify(value, null, indent) ?? "null";
  const fullBytes = Buffer.byteLength(serialized);
  if (fullBytes <= maxBytes) return serialized;

  const marker = "... [truncated]";
  const markerBytes = Buffer.byteLength(marker);

  // Counted marker, when asked for. Opt-in rather than default because the
  // plain marker is pinned by existing callers and tests; the counted form is
  // strictly more informative but is a different string.
  const counted = opts.counters ?? (process.env.CONTEXT_MODE_TRUNCATE_COUNTERS === "1");
  if (counted) {
    // Two passes: the marker's own length depends on how much is shown, so
    // size it against a first estimate and re-check that the result still fits.
    let shownBytes = Math.max(0, maxBytes - markerBytes);
    for (let i = 0; i < 4; i++) {
      const m = countedMarker(shownBytes, fullBytes);
      const mBytes = Buffer.byteLength(m);
      if (mBytes > maxBytes) break; // no room for the counted form at all
      const room = maxBytes - mBytes;
      const body = byteSafePrefix(serialized, room);
      const bodyBytes = Buffer.byteLength(body);
      if (bodyBytes === shownBytes) return body + m;
      shownBytes = bodyBytes;
    }
  }

  // Degenerate budget: can't fit serialized content + marker. Fit as much of
  // the marker as we can so the return still honors `maxBytes`.
  if (maxBytes <= markerBytes) return byteSafePrefix(marker, maxBytes);

  return byteSafePrefix(serialized, maxBytes - markerBytes) + marker;
}

/** `... [truncated: 84 of 5,300 bytes shown, 5,216 dropped]` */
function countedMarker(shownBytes: number, totalBytes: number): string {
  const dropped = Math.max(0, totalBytes - shownBytes);
  return `... [truncated: ${int(shownBytes)} of ${int(totalBytes)} bytes shown, ` +
    `${int(dropped)} dropped]`;
}

// ─────────────────────────────────────────────────────────
// XML / HTML escaping
// ─────────────────────────────────────────────────────────

/**
 * Escape a string for safe embedding in an XML or HTML attribute or text node.
 * Replaces the five XML-reserved characters: `&`, `<`, `>`, `"`, `'`.
 *
 * Used by the resume snapshot template builder to embed user content in
 * `<tool_response>` and `<user_message>` XML tags without breaking the
 * structured prompt format.
 */
export function escapeXML(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ─────────────────────────────────────────────────────────
// Honest truncation footer
// ─────────────────────────────────────────────────────────

/** Thousands-grouped integer, locale-independent (env can move the locale). */
function int(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** `980 B` / `8.0 KB` / `1.2 MB` — one decimal above the byte range. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** What a truncation actually cost. Every field is measured, none estimated. */
export interface TruncationStats {
  /** Lines in the returned body. */
  shownLines: number;
  /** Lines the body was cut from. */
  totalLines: number;
  /** Bytes in the returned body. */
  shownBytes: number;
  /** Bytes the body was cut from. */
  totalBytes: number;
}

/**
 * One compression sample's contribution to the footer.
 *
 * Structurally identical to `CompressionNote` in `src/compress/types.ts` —
 * declared separately so `truncate.ts` stays a leaf module with no imports.
 */
export interface OutputFooterNote {
  /** Short name of the sample, e.g. "env dump". */
  label: string;
  /** Lines the sample removed. */
  foldedLines: number;
  /** Optional parenthesised detail. */
  detail?: string;
}

/** The footer is on unless CONTEXT_MODE_TRUNCATE_FOOTER=0. */
export function truncationFooterEnabled(): boolean {
  return process.env.CONTEXT_MODE_TRUNCATE_FOOTER !== "0";
}

/**
 * The honest footer: what was shown, what was dropped, what was folded.
 *
 * Returns null when there is nothing to report (nothing dropped, nothing
 * folded) or when the footer is switched off. Shape mirrors
 * `formatCompletenessLine` in `src/search/completeness.ts`.
 */
export function formatTruncationFooter(
  stats: TruncationStats,
  notes: OutputFooterNote[] = [],
): string | null {
  if (!truncationFooterEnabled()) return null;

  const droppedLines = Math.max(0, stats.totalLines - stats.shownLines);
  const droppedBytes = Math.max(0, stats.totalBytes - stats.shownBytes);
  const folded = notes.filter(n => n.foldedLines > 0);
  if (droppedLines === 0 && droppedBytes === 0 && folded.length === 0) return null;

  const lines: string[] = [];
  if (droppedLines > 0 || droppedBytes > 0) {
    lines.push(
      `> Showing ${int(stats.shownLines)} of ${int(stats.totalLines)} line(s), ` +
      `${formatBytes(stats.shownBytes)} of ${formatBytes(stats.totalBytes)} — dropped ` +
      `${int(droppedLines)} line(s) / ${formatBytes(droppedBytes)}.`,
    );
  } else if (folded.length > 0) {
    lines.push(`> Complete: all ${int(stats.shownLines)} line(s) shown.`);
  }

  if (folded.length > 0) {
    const parts = folded.map(n =>
      `${n.label} -${int(n.foldedLines)} line(s)` + (n.detail ? ` (${n.detail})` : ""),
    );
    lines.push(`> Folded: ${parts.join("; ")}.`);
  }

  return lines.join("\n");
}

export interface TruncateOutputOptions {
  /** Hard cap on lines kept, before the byte budget is applied. */
  maxLines?: number;
  /** Fold notes from the compression layer, rendered into the same footer. */
  notes?: OutputFooterNote[];
  /** Force the footer on/off; defaults to `truncationFooterEnabled()`. */
  footer?: boolean;
}

/**
 * Truncate command output on line boundaries and append the honest footer.
 *
 * Unlike `capBytes`, the cut lands between lines (a half-line of JSON reads as
 * corruption) and the byte budget covers the footer too, so the returned string
 * still honours `maxBytes`. If even the footer alone does not fit, the footer
 * is byte-capped — a caller who set a budget gets that budget.
 *
 * `maxBytes` defaults to `Infinity`: calling this with only `notes` is the
 * "nothing was dropped, but something was folded" path.
 */
export function truncateOutput(
  text: string,
  maxBytes: number = Infinity,
  opts: TruncateOutputOptions = {},
): { text: string; stats: TruncationStats; footer: string | null } {
  const notes = opts.notes ?? [];
  const wantFooter = opts.footer ?? truncationFooterEnabled();
  const maxLines = opts.maxLines ?? Infinity;

  const lines = text.split("\n");
  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(text);

  // Cumulative bytes of the first n lines, joined by "\n".
  const prefix: number[] = new Array(totalLines + 1);
  prefix[0] = 0;
  for (let i = 0; i < totalLines; i++) {
    prefix[i + 1] = prefix[i] + Buffer.byteLength(lines[i]) + (i > 0 ? 1 : 0);
  }

  const build = (shown: number) => {
    const stats: TruncationStats = {
      shownLines: shown,
      totalLines,
      shownBytes: prefix[shown],
      totalBytes,
    };
    const footer = wantFooter ? formatTruncationFooter(stats, notes) : null;
    return { stats, footer };
  };

  // Fast path — everything fits, footer included. The footer counts against
  // the budget too: a caller who asked for N bytes and got N + 200 has no
  // budget at all.
  if (totalBytes <= maxBytes && totalLines <= maxLines) {
    const { stats, footer } = build(totalLines);
    const joined = footer ? `${text}\n${footer}` : text;
    if (Buffer.byteLength(joined) <= maxBytes) return { text: joined, stats, footer };
  }

  // Largest head within the line cap, then shrink until body + footer fit.
  let shown = Math.min(totalLines, maxLines === Infinity ? totalLines : Math.max(0, maxLines));
  while (shown > 0 && prefix[shown] > maxBytes) shown--;

  let built = build(shown);
  while (shown > 0) {
    const footerBytes = built.footer ? Buffer.byteLength(built.footer) + 1 : 0;
    if (prefix[shown] + footerBytes <= maxBytes) break;
    shown--;
    built = build(shown);
  }

  const body = lines.slice(0, shown).join("\n");
  if (!built.footer) return { text: body, stats: built.stats, footer: null };

  const joined = shown > 0 ? `${body}\n${built.footer}` : built.footer;
  return {
    text: Buffer.byteLength(joined) <= maxBytes ? joined : capBytes(joined, maxBytes),
    stats: built.stats,
    footer: built.footer,
  };
}

// ─────────────────────────────────────────────────────────
// maxBytes guard
// ─────────────────────────────────────────────────────────

/**
 * Return `str` unchanged if it fits within `maxBytes`, otherwise return a
 * byte-safe slice with an ellipsis appended. Useful for single-value fields
 * (e.g., tool response strings) where head+tail splitting is not needed.
 *
 * The returned string is always <= `maxBytes` bytes. When `maxBytes` is
 * smaller than the ellipsis marker, the marker itself is byte-safely truncated.
 *
 * @param str      - Input string.
 * @param maxBytes - Hard byte cap.
 */
export function capBytes(str: string, maxBytes: number): string {
  if (Buffer.byteLength(str) <= maxBytes) return str;

  const marker = "...";
  const markerBytes = Buffer.byteLength(marker);

  if (maxBytes <= markerBytes) return byteSafePrefix(marker, maxBytes);

  return byteSafePrefix(str, maxBytes - markerBytes) + marker;
}
