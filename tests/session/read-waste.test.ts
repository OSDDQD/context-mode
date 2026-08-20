/**
 * §3.6 — read but never used.
 *
 * The sibling of the returns detector. A return is a file the model paid for
 * twice; this is a file it paid for once and never used at all — pulled into
 * the window whole by a `Read`, then never edited, never named by a later
 * call, never mentioned in the answer.
 *
 * What is asserted here:
 *   - a read-then-edited file counts as USED;
 *   - a read-and-never-mentioned file counts as WASTE;
 *   - a file mentioned ONLY by the read that pulled it in counts as WASTE;
 *   - every exoneration route works: later tool call, later read, assistant
 *     text, bare basename in prose;
 *   - the conservative guards hold — tail grace, truncated stream, env switch;
 *   - bytes price from `bytes_returned` first and the injected `sizeOf` second,
 *     and tokens stay on the one `tokensFromBytes` basis (ADR-0004).
 */

import { afterEach, describe, expect, test } from "vitest";
import {
  DEFAULT_READ_WASTE_TAIL_STEPS,
  detectReadWaste,
  readWasteDetectorEnabled,
  summarizeReadWaste,
} from "../../src/session/reuse-detector.js";
import type { ReuseCandidateEvent } from "../../src/session/reuse-detector.js";
import { tokensFromBytes } from "../../src/session/tokenizer.js";

afterEach(() => {
  delete process.env.CONTEXT_MODE_READ_WASTE;
});

const PROJECT = "/home/dev/proj";

let nextId = 1;
const at = (min: number): string => {
  const base = Date.UTC(2026, 0, 2, 10, 0, 0);
  return new Date(base + min * 60_000).toISOString().replace("T", " ").slice(0, 19);
};

function ev(type: string, data: string, minute: number, extra?: Partial<ReuseCandidateEvent>): ReuseCandidateEvent {
  return { id: nextId++, type, data, created_at: at(minute), project_dir: PROJECT, ...extra };
}

const read = (path: string, minute: number, bytes = 20_000): ReuseCandidateEvent =>
  ev("file_read", path, minute, { bytes_returned: bytes });
const edit = (path: string, minute: number): ReuseCandidateEvent => ev("file_edit", path, minute);
const say = (text: string, minute: number): ReuseCandidateEvent =>
  ev("turn_end", JSON.stringify({ stop_hook_active: false, last_assistant_message: text }), minute);

/**
 * Enough step events after the last read for the tail grace to release it.
 * Deliberately carries no path-shaped text, so it can never exonerate anything.
 */
function tail(minute: number, n = DEFAULT_READ_WASTE_TAIL_STEPS): ReuseCandidateEvent[] {
  return Array.from({ length: n }, (_, i) => ev("bash_outcome", "exit 0", minute + i));
}

// No filesystem probing anywhere in this file: reads price from
// `bytes_returned`, and the injected `sizeOf` is the only fallback.
const opts = { enabled: true, sizeOf: () => 0 };

describe("detectReadWaste — the waste is found", () => {
  test("a read nothing ever refers to again is waste", () => {
    const r = detectReadWaste([read(`${PROJECT}/src/orphan.ts`, 0), ...tail(1)], opts);
    expect(r.wastedReads).toBe(1);
    expect(r.wastedSources).toBe(1);
    expect(r.judgedReads).toBe(1);
    expect(r.wastedBytes).toBe(20_000);
    expect(r.detections[0].source).toBe(`${PROJECT}/src/orphan.ts`);
  });

  test("a file mentioned ONLY by the read that pulled it in is still waste", () => {
    // The read event's own `data` IS the path. It must not exonerate itself.
    const r = detectReadWaste([read(`${PROJECT}/src/selfnamed.ts`, 0), ...tail(1)], opts);
    expect(r.wastedReads).toBe(1);
  });

  test("tokens follow the one tokenizer basis, not a private constant", () => {
    const r = detectReadWaste([read(`${PROJECT}/src/orphan.ts`, 0, 40_000), ...tail(1)], opts);
    expect(r.wastedTokens).toBe(Math.round(tokensFromBytes(40_000)));
  });

  test("ratio is waste over reads that were old enough to judge", () => {
    const r = detectReadWaste(
      [
        read(`${PROJECT}/src/one.ts`, 0),
        read(`${PROJECT}/src/two.ts`, 1),
        edit(`${PROJECT}/src/one.ts`, 2),
        ...tail(3),
      ],
      opts,
    );
    expect(r.judgedReads).toBe(2);
    expect(r.wastedReads).toBe(1);
    expect(r.ratio).toBeCloseTo(0.5, 6);
  });

  test("top offenders come back heaviest first, capped at three", () => {
    const r = detectReadWaste(
      [
        read(`${PROJECT}/src/small.ts`, 0, 1_000),
        read(`${PROJECT}/src/huge.ts`, 1, 90_000),
        read(`${PROJECT}/src/mid.ts`, 2, 9_000),
        read(`${PROJECT}/src/tiny.ts`, 3, 100),
        ...tail(4),
      ],
      opts,
    );
    expect(r.top.map((t) => t.bytes)).toEqual([90_000, 9_000, 1_000]);
  });

  test("unpriced reads fall back to the injected sizeOf", () => {
    const r = detectReadWaste([read(`${PROJECT}/src/orphan.ts`, 0, 0), ...tail(1)], {
      enabled: true,
      sizeOf: () => 4_096,
    });
    expect(r.wastedBytes).toBe(4_096);
  });
});

describe("detectReadWaste — what counts as USED", () => {
  test("a read that was then edited is used", () => {
    const r = detectReadWaste(
      [read(`${PROJECT}/src/alpha.ts`, 0), edit(`${PROJECT}/src/alpha.ts`, 1), ...tail(2)],
      opts,
    );
    expect(r.wastedReads).toBe(0);
    expect(r.judgedReads).toBe(1);
  });

  test("a later tool call naming the file is enough", () => {
    const r = detectReadWaste(
      [
        read(`${PROJECT}/src/beta.ts`, 0),
        ev(
          "mcp_tool_call",
          JSON.stringify({ tool_name: "ctx_execute_file", params: { path: "src/beta.ts" } }),
          1,
        ),
        ...tail(2),
      ],
      opts,
    );
    expect(r.wastedReads).toBe(0);
  });

  test("a mention of the path in the assistant's answer is enough", () => {
    const r = detectReadWaste(
      [
        read(`${PROJECT}/src/gamma.ts`, 0),
        say("I traced the bug to /home/dev/proj/src/gamma.ts and left it alone.", 1),
        ...tail(2),
      ],
      opts,
    );
    expect(r.wastedReads).toBe(0);
  });

  test("a bare basename in prose is enough — when in doubt, USED", () => {
    const r = detectReadWaste(
      [read(`${PROJECT}/src/delta.ts`, 0), say("delta.ts already handles that case.", 1), ...tail(2)],
      opts,
    );
    expect(r.wastedReads).toBe(0);
  });

  test("the module stem alone is enough — the cheap proxy for an identifier", () => {
    const r = detectReadWaste(
      [
        read(`${PROJECT}/src/epsilon.ts`, 0),
        say("The epsilon module owns that mapping now.", 1),
        ...tail(2),
      ],
      opts,
    );
    expect(r.wastedReads).toBe(0);
  });

  test("re-reading the file exonerates the earlier read, never the last one", () => {
    const r = detectReadWaste(
      [read(`${PROJECT}/src/zeta.ts`, 0), read(`${PROJECT}/src/zeta.ts`, 5), ...tail(6)],
      opts,
    );
    expect(r.judgedReads).toBe(2);
    expect(r.wastedReads).toBe(1);
    expect(r.wastedSources).toBe(1);
  });

  test("a mention BEFORE the read does not count", () => {
    const r = detectReadWaste(
      [say("Let me open src/eta.ts.", 0), read(`${PROJECT}/src/eta.ts`, 1), ...tail(2)],
      opts,
    );
    expect(r.wastedReads).toBe(1);
  });
});

describe("detectReadWaste — the conservative guards", () => {
  test("reads inside the tail grace are not judged at all", () => {
    const r = detectReadWaste([...tail(0), read(`${PROJECT}/src/late.ts`, 9)], opts);
    expect(r.judgedReads).toBe(0);
    expect(r.wastedReads).toBe(0);
  });

  test("a truncated row set makes the pass abstain, and says so", () => {
    const r = detectReadWaste([read(`${PROJECT}/src/orphan.ts`, 0), ...tail(1)], {
      ...opts,
      truncated: true,
    });
    expect(r.truncated).toBe(true);
    expect(r.enabled).toBe(true);
    expect(r.wastedReads).toBe(0);
  });

  test("a URL or an unnormalizable path is never judged", () => {
    const r = detectReadWaste([read("https://example.com/x.ts", 0), ...tail(1)], opts);
    expect(r.judgedReads).toBe(0);
  });

  test("empty and malformed input yields nothing, never a throw", () => {
    expect(detectReadWaste([], opts).wastedReads).toBe(0);
    expect(detectReadWaste([ev("file_read", "", 0), ...tail(1)], opts).wastedReads).toBe(0);
    expect(
      detectReadWaste(undefined as unknown as ReuseCandidateEvent[], opts).wastedReads,
    ).toBe(0);
  });
});

describe("CONTEXT_MODE_READ_WASTE", () => {
  test("defaults to on", () => {
    expect(readWasteDetectorEnabled()).toBe(true);
  });

  test.each(["0", "false", "off", "no", "OFF"])("%s switches it off", (v) => {
    process.env.CONTEXT_MODE_READ_WASTE = v;
    expect(readWasteDetectorEnabled()).toBe(false);
    const r = detectReadWaste([read(`${PROJECT}/src/orphan.ts`, 0), ...tail(1)], { sizeOf: () => 0 });
    expect(r.enabled).toBe(false);
    expect(r.wastedReads).toBe(0);
  });

  test("an explicit `enabled` beats the env switch", () => {
    process.env.CONTEXT_MODE_READ_WASTE = "0";
    expect(detectReadWaste([read(`${PROJECT}/src/orphan.ts`, 0), ...tail(1)], opts).wastedReads).toBe(1);
  });
});

describe("summarizeReadWaste", () => {
  test("drops the per-read detail and keeps the numbers", () => {
    const r = detectReadWaste([read(`${PROJECT}/src/orphan.ts`, 0), ...tail(1)], opts);
    const s = summarizeReadWaste(r);
    expect("detections" in s).toBe(false);
    expect(s.wastedBytes).toBe(r.wastedBytes);
    expect(s.top).toEqual(r.top);
  });
});
