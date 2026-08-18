/**
 * The honest truncation footer.
 *
 * Two things are under test here. First, that a truncation now says what it
 * cost — how many lines and bytes were dropped, out of how many. Second, that
 * the historic markers did NOT move: `truncateJSON` and `capBytes` are pinned
 * byte-for-byte by `tests/truncate.test.ts` and by callers that embed their
 * output, so the counted form is opt-in and the default is unchanged.
 */

import { describe, test, beforeEach, afterEach } from "vitest";
import { strict as assert } from "node:assert";

import {
  capBytes,
  charSafePrefix,
  formatBytes,
  formatTruncationFooter,
  truncateJSON,
  truncateOutput,
} from "../../src/truncate.js";

const ENV_KEYS = ["CONTEXT_MODE_TRUNCATE_FOOTER", "CONTEXT_MODE_TRUNCATE_COUNTERS"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// ─────────────────────────────────────────────────────────
// formatBytes / formatTruncationFooter
// ─────────────────────────────────────────────────────────

describe("formatBytes", () => {
  test("stays in bytes below 1 KB", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(980), "980 B");
  });

  test("one decimal from KB up", () => {
    assert.equal(formatBytes(8192), "8.0 KB");
    assert.equal(formatBytes(422400), "412.5 KB");
    assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
  });
});

describe("formatTruncationFooter", () => {
  test("counts dropped lines and bytes, grouped by thousands", () => {
    const footer = formatTruncationFooter({
      shownLines: 120, totalLines: 5340, shownBytes: 8192, totalBytes: 422400,
    });
    assert.equal(
      footer,
      "> Showing 120 of 5,340 line(s), 8.0 KB of 412.5 KB — dropped 5,220 line(s) / 404.5 KB.",
    );
  });

  test("says nothing when nothing was dropped and nothing folded", () => {
    assert.equal(
      formatTruncationFooter({ shownLines: 4, totalLines: 4, shownBytes: 40, totalBytes: 40 }),
      null,
    );
  });

  test("claims completeness when only folding happened", () => {
    const footer = formatTruncationFooter(
      { shownLines: 12, totalLines: 12, shownBytes: 400, totalBytes: 400 },
      [{ label: "env dump", foldedLines: 31, detail: "40 var(s), 8 shown" }],
    );
    assert.equal(
      footer,
      "> Complete: all 12 line(s) shown.\n" +
      "> Folded: env dump -31 line(s) (40 var(s), 8 shown).",
    );
  });

  test("reports truncation and folding together, one note per sample", () => {
    const footer = formatTruncationFooter(
      { shownLines: 10, totalLines: 100, shownBytes: 100, totalBytes: 2000 },
      [
        { label: "test output", foldedLines: 41, detail: "vitest" },
        { label: "repeats", foldedLines: 198, detail: "1 run(s), longest x200" },
        { label: "env dump", foldedLines: 0, detail: "did not fire" },
      ],
    );
    const lines = (footer ?? "").split("\n");
    assert.equal(lines.length, 2);
    assert.ok(lines[0].startsWith("> Showing 10 of 100 line(s),"));
    assert.equal(
      lines[1],
      "> Folded: test output -41 line(s) (vitest); repeats -198 line(s) (1 run(s), longest x200).",
    );
  });

  test("CONTEXT_MODE_TRUNCATE_FOOTER=0 silences it", () => {
    process.env.CONTEXT_MODE_TRUNCATE_FOOTER = "0";
    assert.equal(
      formatTruncationFooter({ shownLines: 1, totalLines: 99, shownBytes: 5, totalBytes: 500 }),
      null,
    );
  });
});

// ─────────────────────────────────────────────────────────
// truncateOutput
// ─────────────────────────────────────────────────────────

describe("truncateOutput", () => {
  const log = Array.from({ length: 500 }, (_, i) => `line ${i} of the command output`).join("\n");

  test("returns the input untouched when everything fits", () => {
    const out = truncateOutput("a\nb\nc", 1000);
    assert.equal(out.text, "a\nb\nc");
    assert.equal(out.footer, null);
    assert.deepEqual(out.stats, { shownLines: 3, totalLines: 3, shownBytes: 5, totalBytes: 5 });
  });

  test("cuts on line boundaries and honours the byte budget including the footer", () => {
    const cap = 400;
    const out = truncateOutput(log, cap);
    assert.ok(Buffer.byteLength(out.text) <= cap, `got ${Buffer.byteLength(out.text)} bytes`);
    const lines = out.text.split("\n");
    const footerStart = lines.findIndex(l => l.startsWith("> Showing"));
    assert.ok(footerStart > 0, "footer must be present");
    // Every kept line is a whole line from the input — no half-lines.
    for (const l of lines.slice(0, footerStart)) assert.match(l, /^line \d+ of the command output$/);
    assert.equal(out.stats.shownLines, footerStart);
    assert.equal(out.stats.totalLines, 500);
  });

  test("the footer's numbers match what was actually kept", () => {
    const out = truncateOutput(log, 600);
    const body = out.text.split("\n").filter(l => !l.startsWith("> ")).join("\n");
    assert.equal(out.stats.shownLines, body.split("\n").length);
    assert.equal(out.stats.shownBytes, Buffer.byteLength(body));
    assert.equal(out.stats.totalBytes, Buffer.byteLength(log));
    assert.ok(out.text.includes(`of ${out.stats.totalLines.toLocaleString("en-US")} line(s)`));
  });

  test("maxLines caps the head even when the byte budget is generous", () => {
    const out = truncateOutput(log, Infinity, { maxLines: 5 });
    assert.equal(out.stats.shownLines, 5);
    assert.ok(out.text.split("\n").at(-1)?.startsWith("> Showing 5 of 500 line(s)"));
  });

  test("footer:false drops the footer and keeps the cut", () => {
    const out = truncateOutput(log, 400, { footer: false });
    assert.equal(out.footer, null);
    assert.ok(!out.text.includes("> Showing"));
    assert.ok(Buffer.byteLength(out.text) <= 400);
  });

  test("CONTEXT_MODE_TRUNCATE_FOOTER=0 drops the footer without changing the cut", () => {
    process.env.CONTEXT_MODE_TRUNCATE_FOOTER = "0";
    const out = truncateOutput(log, 400);
    assert.equal(out.footer, null);
    assert.ok(!out.text.includes("> Showing"));
  });

  test("a budget too small for the footer still honours the budget", () => {
    const out = truncateOutput(log, 20);
    assert.ok(Buffer.byteLength(out.text) <= 20, `got ${Buffer.byteLength(out.text)} bytes`);
  });

  test("fold notes ride the same footer when nothing was dropped", () => {
    const out = truncateOutput("a\nb\nc", Infinity, {
      notes: [{ label: "repeats", foldedLines: 12, detail: "2 run(s), longest x7" }],
    });
    assert.ok(out.text.startsWith("a\nb\nc\n"));
    assert.ok(out.text.includes("> Complete: all 3 line(s) shown."));
    assert.ok(out.text.includes("> Folded: repeats -12 line(s) (2 run(s), longest x7)."));
  });
});

// ─────────────────────────────────────────────────────────
// Back-compatibility with the existing callers
// ─────────────────────────────────────────────────────────

describe("existing truncate helpers are unchanged by default", () => {
  test("truncateJSON keeps the historic bare marker", () => {
    const out = truncateJSON({ text: "x".repeat(500) }, 100);
    assert.ok(out.endsWith("... [truncated]"));
    assert.ok(Buffer.byteLength(out) <= 100);
  });

  test("truncateJSON three-argument signature still works", () => {
    assert.equal(truncateJSON({ a: 1 }, 1000, 0), '{"a":1}');
  });

  test("capBytes still appends the bare ellipsis", () => {
    assert.equal(capBytes("abcdef", 4), "a...");
  });

  test("charSafePrefix is untouched", () => {
    assert.equal(charSafePrefix("hello", 3), "hel");
  });
});

describe("truncateJSON counted marker (opt-in)", () => {
  const value = { text: "x".repeat(5000) };

  test("per-call opt-in reports shown and dropped bytes", () => {
    const out = truncateJSON(value, 200, 2, { counters: true });
    assert.ok(Buffer.byteLength(out) <= 200, `got ${Buffer.byteLength(out)} bytes`);
    assert.match(out, /\.\.\. \[truncated: [\d,]+ of [\d,]+ bytes shown, [\d,]+ dropped\]$/);
    const m = /truncated: ([\d,]+) of ([\d,]+) bytes shown, ([\d,]+) dropped/.exec(out)!;
    const num = (s: string) => Number(s.replace(/,/g, ""));
    assert.equal(num(m[1]) + num(m[3]), num(m[2]));
    assert.equal(num(m[2]), Buffer.byteLength(JSON.stringify(value, null, 2)));
  });

  test("CONTEXT_MODE_TRUNCATE_COUNTERS=1 flips the default", () => {
    process.env.CONTEXT_MODE_TRUNCATE_COUNTERS = "1";
    const out = truncateJSON(value, 200);
    assert.match(out, /bytes shown, [\d,]+ dropped\]$/);
  });

  test("falls back to the bare marker when the counted one cannot fit", () => {
    const out = truncateJSON(value, 30, 2, { counters: true });
    assert.ok(Buffer.byteLength(out) <= 30);
    assert.ok(out.endsWith("... [truncated]"));
  });

  test("no truncation means no marker either way", () => {
    assert.equal(truncateJSON({ a: 1 }, 1000, 0, { counters: true }), '{"a":1}');
  });
});
