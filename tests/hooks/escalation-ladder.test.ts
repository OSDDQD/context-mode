/**
 * The price of a violation tracks what the session is doing NOW.
 *
 * The advisory used to fire once per session per tool and then latch shut with
 * an O_CREAT|O_EXCL marker — the first Read of a session got advice, the two
 * hundredth got silence. Long sessions are precisely the ones where the rules
 * matter most, and the ones where compaction has already removed those rules
 * from the system text.
 *
 * The first replacement swung too far the other way: severity was derived from
 * a session total that only grows, so nine unrouted calls in the first ten
 * minutes priced every read for the next six hours. Monotonicity-for-the-whole-
 * session was asserted here as the property, and it was the wrong property — a
 * session cannot apologise to a number that never goes down.
 *
 * What is asserted now is decay: the level reads a sliding window, so a quiet
 * window returns the session to silence on its own, with no command and no
 * second counter to drift out of step. The session totals survive, but only as
 * something to quote — the notice says what the session has spent, the ladder
 * prices what it is doing now. Monotonicity survives too, in its honest form:
 * at a fixed instant, a larger window tally is never treated more gently.
 *
 * Two further properties are load-bearing. Silence on a healthy session is a
 * requirement, not a nicety: a session that routes its heavy work hears
 * nothing at all. And when the tally cannot be read — no session id, no
 * PostToolUse yet, an unreadable store — the behaviour must fall back to the
 * advisory this hook has always emitted, never to the violation branch.
 * Punishing a session for a file we failed to open is the one outcome with no
 * defence.
 *
 * The last group here is about the price of the message itself. Refusing costs
 * roughly a kilobyte of reason text, every time, on exactly the sessions that
 * are already refusing repeatedly — so the fine print is worth saying once,
 * and the floor under a refusal has to sit where the refusal pays for itself.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  routePreToolUse,
  resetGuidanceThrottle,
  writeUnroutedTally,
  readUnroutedTally,
  escalationLevel,
  escalationWindowMs,
  escalationDenyFloorBytes,
  escalationAskFloorBytes,
} from "../../hooks/core/routing.mjs";

interface Decision {
  action: string;
  reason?: string;
  additionalContext?: string;
  redirectMeta?: { bytesAvoided?: number };
}

/**
 * The window pair prices the decision; the session pair is only quoted. Both
 * are optional here so the old two-field records still typecheck — that shape
 * is a supported input, not a legacy accident (see the compatibility test).
 */
interface Tally {
  count: number;
  bytes: number;
  windowCount?: number;
  windowBytes?: number;
  at?: number;
}

/** ADR-0003: a redirect is a redirect, never a wall. */
const FORBIDDEN = [
  "blocked",
  "not allowed",
  "restricted",
  "forbidden",
  "prohibited",
  "permission denied",
  "unavailable",
];

const PROJECT = process.cwd();

const SENTINEL_DIR = mkdtempSync(join(tmpdir(), "ctx-ladder-sentinel-"));
process.env.CONTEXT_MODE_MCP_SENTINEL_DIR = SENTINEL_DIR;
const SENTINEL = resolve(SENTINEL_DIR, `context-mode-mcp-ready-${process.pid}`);

const ENV_KEYS = [
  "CONTEXT_MODE_NUDGE_AFTER_CALLS",
  "CONTEXT_MODE_NUDGE_AFTER_BYTES",
  "CONTEXT_MODE_ESCALATION_WINDOW_MS",
  "CONTEXT_MODE_ESCALATION_DENY_MIN_BYTES",
];

let scratch: string;
/** Big enough to be a violation, small enough that the size rule ignores it. */
let midFile: string;
/** A second one, so a refusal can be provoked twice without hitting the retry window. */
let otherMidFile: string;
/** Over the collection floor, under the floor a refusal would have to earn. */
let smallFile: string;
/** Under every floor on the ladder — nothing here is worth a word. */
let tinyFile: string;
let bigFile: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "ctx-ladder-"));
  midFile = join(scratch, "mid.ts");
  otherMidFile = join(scratch, "mid-two.ts");
  smallFile = join(scratch, "small.ts");
  tinyFile = join(scratch, "tiny.ts");
  bigFile = join(scratch, "big.ts");
  writeFileSync(midFile, "x".repeat(20_000));
  writeFileSync(otherMidFile, "x".repeat(20_000));
  writeFileSync(smallFile, "x".repeat(2_400));
  writeFileSync(tinyFile, "x".repeat(500));
  writeFileSync(bigFile, "x".repeat(120_000));
});

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  writeFileSync(SENTINEL, String(process.pid));
});

afterAll(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  delete process.env.CONTEXT_MODE_MCP_SENTINEL_DIR;
  rmSync(scratch, { recursive: true, force: true });
  rmSync(SENTINEL_DIR, { recursive: true, force: true });
});

let counter = 0;
/** A session of its own per case, with its tally already published. */
function session(tally: Tally | null): string {
  const id = `ladder-${process.pid}-${++counter}`;
  resetGuidanceThrottle(id);
  if (tally) writeUnroutedTally(id, tally);
  return id;
}

function route(tool: string, input: Record<string, unknown>, sid: string): Decision | null {
  return routePreToolUse(tool, input, PROJECT, "claude-code", sid) as Decision | null;
}

/**
 * Severity as a number, so "no softer than" is a comparison and not a story.
 *
 * `allow` sits at 0 with `null`: both let the call through untouched. It is a
 * separate action only because it carries the marker that tells PostToolUse
 * the call is already accounted for.
 */
const SEVERITY: Record<string, number> = { null: 0, allow: 0, context: 1, ask: 2, deny: 3 };
function severity(decision: Decision | null): number {
  return SEVERITY[decision?.action ?? "null"] ?? 0;
}

/** A rung-by-rung climb, all of it inside one window. */
function growingWindow(): Tally[] {
  return [
    [0, 0],
    [1, 20_000],
    [3, 60_000],
    [5, 90_000],
    [6, 150_000],
    [8, 220_000],
    [9, 400_000],
    [40, 2_000_000],
  ].map(([count, bytes]) => ({ count, bytes, windowCount: count, windowBytes: bytes }));
}

describe("escalationLevel — the steps", () => {
  it("is silent until a threshold is crossed", () => {
    expect(escalationLevel({ count: 0, bytes: 0 })).toBe(0);
    expect(escalationLevel({ count: 2, bytes: 50_000 })).toBe(0);
  });

  it("climbs one step per further multiple, and stops at refusal", () => {
    expect(escalationLevel({ count: 3, bytes: 0 })).toBe(1);
    expect(escalationLevel({ count: 6, bytes: 0 })).toBe(2);
    expect(escalationLevel({ count: 9, bytes: 0 })).toBe(3);
    expect(escalationLevel({ count: 300, bytes: 0 })).toBe(3);
  });

  it("takes whichever of the two thresholds is further along", () => {
    // One enormous call is as much evidence as three ordinary ones.
    expect(escalationLevel({ count: 1, bytes: 300 * 1024 })).toBe(3);
    expect(escalationLevel({ count: 9, bytes: 0 })).toBe(3);
  });

  it("reads its thresholds from the environment", () => {
    const env = {
      CONTEXT_MODE_NUDGE_AFTER_CALLS: "10",
      CONTEXT_MODE_NUDGE_AFTER_BYTES: String(1024 * 1024),
    };
    expect(escalationLevel({ count: 9, bytes: 500_000 }, env)).toBe(0);
    expect(escalationLevel({ count: 20, bytes: 0 }, env)).toBe(2);
  });

  it("treats an unreadable tally as no information, not as zero", () => {
    expect(escalationLevel(null)).toBe(0);
    expect(readUnroutedTally("ladder-nonexistent-session")).toBeNull();
  });

  it("reads a record with no window fields as all of it being recent", () => {
    // Every assertion above passes a bare {count, bytes} — the shape written
    // before the window existed, and the shape a session upgraded mid-flight
    // still has on disk until its next PostToolUse. It has to mean what it
    // meant then, or upgrading the plugin silently disarms the ladder for the
    // rest of that session. Spelled out once rather than left implied by the
    // other cases.
    const now = 1_700_000_000_000;
    const legacy = { count: 9, bytes: 400_000 };
    expect(escalationLevel(legacy, {}, now)).toBe(3);
    expect(escalationLevel(legacy, {}, now + 24 * 60 * 60_000)).toBe(3);
    expect(escalationLevel({ ...legacy, windowCount: 9, windowBytes: 400_000 }, {}, now)).toBe(3);
  });
});

describe("a healthy session hears nothing", () => {
  it("says nothing on any of the three tools while the tally is under the first step", () => {
    const sid = session({ count: 1, bytes: 5_000 });
    expect(route("Read", { file_path: midFile }, sid)).toBeNull();
    expect(route("Bash", { command: "ps aux" }, sid)).toBeNull();
    expect(route("Grep", { pattern: "handleRequest", path: "src" }, sid)).toBeNull();
  });
});

describe("the ladder, step by step", () => {
  const steps: Array<[string, Tally, string, string, string]> = [
    // tally,                       Read,      Bash,      Grep
    ["advise", { count: 3, bytes: 40_000 }, "context", "context", "context"],
    ["ask", { count: 6, bytes: 80_000 }, "ask", "ask", "ask"],
    // Grep stops at ask on purpose — see below.
    ["deny", { count: 9, bytes: 120_000 }, "deny", "deny", "ask"],
  ];

  for (const [label, tally, read, bash, grep] of steps) {
    it(`${label}: Read=${read}, Bash=${bash}, Grep=${grep}`, () => {
      const sid = session(tally);
      expect(route("Read", { file_path: midFile }, sid)?.action ?? "null").toBe(read);
      expect(route("Bash", { command: "ps aux" }, sid)?.action ?? "null").toBe(bash);
      expect(route("Grep", { pattern: "x", path: "src" }, sid)?.action ?? "null").toBe(grep);
    });
  }

  it("carries the actual number once it starts speaking", () => {
    // The point of the advisory coming back is that it comes back knowing
    // something the first one did not.
    const sid = session({ count: 4, bytes: 130_000 });
    const text =
      route("Read", { file_path: midFile }, sid)?.additionalContext ??
      route("Bash", { command: "ps aux" }, sid)?.additionalContext ??
      "";
    expect(text).toContain("4 unrouted heavy calls");
    expect(text).toContain("127.0 KB");
    expect(text).toContain("CONTEXT_MODE_NUDGE_AFTER_CALLS");
    expect(text).toContain("CONTEXT_MODE_NUDGE_AFTER_BYTES");
  });

  it("refuses with the ready replacement call, not with a complaint", () => {
    const sid = session({ count: 9, bytes: 400_000 });
    const read = route("Read", { file_path: midFile }, sid);
    expect(read?.action).toBe("deny");
    expect(read?.reason).toContain("ctx_execute_file");
    expect(read?.reason).toContain(JSON.stringify(midFile));

    const bash = route("Bash", { command: "ps aux" }, session({ count: 9, bytes: 400_000 }));
    expect(bash?.action).toBe("deny");
    expect(bash?.reason).toContain("ctx_batch_execute");
    expect(bash?.reason).toContain(JSON.stringify("ps aux"));
  });

  it("keeps the edit escape hatch at every step", () => {
    // The refusal promises the repeat will go through. At the top of the
    // ladder that promise has to be worth exactly as much as it is at the
    // bottom, or the ladder has quietly broken the main job.
    const sid = session({ count: 9, bytes: 400_000 });
    const first = route("Read", { file_path: midFile }, sid);
    expect(first?.action).toBe("deny");
    expect(first?.reason).toMatch(/Read again/i);
    const second = route("Read", { file_path: midFile }, sid);
    // `allow` is a passthrough that carries the accounted-for marker; what it
    // must never be is a prompt or another refusal.
    expect(severity(second), "the promised repeat must not become a prompt either").toBe(0);
  });

  it("never blocks a bounded read, however high the tally", () => {
    // offset/limit already returns a slice rather than the file, so there is
    // nothing left to route. The large-file advisory still rides along, as it
    // always has — what must not happen is a prompt or a refusal.
    const sid = session({ count: 30, bytes: 900_000 });
    const decision = route("Read", { file_path: bigFile, offset: 10, limit: 40 }, sid);
    expect(decision?.action ?? "null").not.toBe("ask");
    expect(decision?.action ?? "null").not.toBe("deny");
  });

  it("never refuses a Grep, however high the tally", () => {
    // ctx_find ranks where Grep enumerates. No amount of accumulated leakage
    // turns "answer partially" into the right answer, so the ladder tops out
    // at a confirmation for searches and says so.
    const sid = session({ count: 100, bytes: 10_000_000 });
    const decision = route("Grep", { pattern: "x", path: "src" }, sid);
    expect(decision?.action).toBe("ask");
    expect(decision?.reason).toMatch(/ranks, it does not enumerate/);
  });
});

describe("the price decays with the window", () => {
  // Time is a parameter here, not a global. escalationLevel takes `now` as its
  // third argument precisely so the ageing rule can be stated as arithmetic;
  // faking the clock would test the fake instead.
  const NOW = 1_700_000_000_000;

  it("goes silent once the newest event is older than the window", () => {
    // The incident this replaced: a burst of leakage in the first ten minutes
    // priced every call for the next six hours. Size of the burst is
    // deliberately absurd — no quantity of *old* evidence buys a step.
    const stale: Tally = {
      count: 400,
      bytes: 40_000_000,
      windowCount: 400,
      windowBytes: 40_000_000,
      at: NOW - escalationWindowMs({}) - 1,
    };
    expect(escalationLevel(stale, {}, NOW)).toBe(0);

    // One millisecond on the other side of the boundary is still the burst.
    expect(escalationLevel({ ...stale, at: NOW - escalationWindowMs({}) }, {}, NOW)).toBe(3);
  });

  it("shortens or lengthens that memory from the environment", () => {
    const env = { CONTEXT_MODE_ESCALATION_WINDOW_MS: "60000" };
    const tally: Tally = { count: 9, bytes: 0, windowCount: 9, windowBytes: 0, at: NOW - 90_000 };
    expect(escalationLevel(tally, env, NOW)).toBe(0);
    expect(escalationLevel(tally, {}, NOW)).toBe(3); // default 15 min still covers it
  });

  it("prices the window pair and quotes the session pair", () => {
    // The two pairs are allowed to disagree, and which one drives the level is
    // the whole point of the wave. A session that leaked hard an hour ago and
    // has been clean since is a silent session, however large its totals.
    const at = NOW - 1000;
    expect(escalationLevel({ count: 400, bytes: 40_000_000, windowCount: 0, windowBytes: 0, at }, {}, NOW)).toBe(0);
    expect(escalationLevel({ count: 0, bytes: 0, windowCount: 9, windowBytes: 0, at }, {}, NOW)).toBe(3);
    expect(escalationLevel({ count: 0, bytes: 0, windowCount: 0, windowBytes: 300 * 1024, at }, {}, NOW)).toBe(3);
  });

  it("still tells the agent what the whole session has spent", () => {
    // Decay changes what is charged for, not what is reported. The notice has
    // to keep naming the session's own totals — a line that quoted the window
    // instead would read as the leak having been forgiven.
    const sid = session({ count: 42, bytes: 130_000, windowCount: 4, windowBytes: 0 });
    const text = route("Read", { file_path: midFile }, sid)?.additionalContext ?? "";
    expect(text).toContain("42 unrouted heavy calls");
    expect(text).toContain("127.0 KB");
    expect(text).not.toContain("4 unrouted heavy calls");
  });

  it("never softens as the window tally grows at one instant", () => {
    // What survives of the old monotonicity claim. Across time the level may
    // fall — that is the feature. At a FIXED instant it may not: more recent
    // leakage can never buy a gentler answer, which is the property the ladder
    // would be worthless without.
    const growing: Array<[number, number]> = [
      [0, 0],
      [1, 20_000],
      [3, 60_000],
      [5, 90_000],
      [6, 150_000],
      [8, 220_000],
      [9, 400_000],
      [40, 2_000_000],
    ];
    let previous = -1;
    for (const [windowCount, windowBytes] of growing) {
      const level = escalationLevel(
        { count: 40, bytes: 2_000_000, windowCount, windowBytes, at: NOW },
        {},
        NOW,
      );
      expect(level, `softened at ${windowCount}/${windowBytes}: ${level} after ${previous}`)
        .toBeGreaterThanOrEqual(previous);
      previous = level;
    }
  });

  it("carries that through the routed decision, tool by tool", () => {
    // Same property one layer up, where it is what the caller actually feels.
    // writeUnroutedTally stamps `at` itself, so every one of these is a fresh
    // window and the only thing varying is how much is in it.
    const growing: Tally[] = growingWindow();
    for (const tool of [
      { tool: "Read", input: { file_path: midFile } },
      { tool: "Bash", input: { command: "ps aux" } },
      { tool: "Grep", input: { pattern: "x", path: "src" } },
    ]) {
      let previous = -1;
      for (const tally of growing) {
        const sid = session(tally);
        const now = severity(route(tool.tool, tool.input, sid));
        expect(
          now,
          `${tool.tool} softened at ${JSON.stringify(tally)}: ${now} after ${previous}`,
        ).toBeGreaterThanOrEqual(previous);
        previous = now;
      }
    }
  });

  it("does not go quiet on the second identical call the way the latch did", () => {
    const sid = session({ count: 4, bytes: 130_000 });
    const first = route("Bash", { command: "ps aux" }, sid);
    const second = route("Bash", { command: "ps aux" }, sid);
    const third = route("Bash", { command: "ps aux" }, sid);
    expect(first?.action).toBe("context");
    expect(severity(second)).toBeGreaterThanOrEqual(severity(first));
    expect(severity(third)).toBeGreaterThanOrEqual(severity(first));
  });
});

describe("no tally, no escalation", () => {
  it("falls back to the historical one-shot advisory when nothing can be read", () => {
    // Not silence (that would drop the rules for every session before the
    // first PostToolUse) and emphatically not a refusal.
    const sid = session(null);
    expect(route("Bash", { command: "ps aux" }, sid)?.action).toBe("context");
    expect(route("Read", { file_path: midFile }, sid)?.action).toBe("context");
    expect(route("Grep", { pattern: "x", path: "src" }, sid)?.action).toBe("context");
  });

  it("still latches that fallback once per type, exactly as before", () => {
    const sid = session(null);
    expect(route("Bash", { command: "ps aux" }, sid)?.action).toBe("context");
    expect(route("Bash", { command: "ps aux" }, sid)).toBeNull();
  });

  it("survives a corrupt tally file by treating it as unreadable", () => {
    const sid = session({ count: 9, bytes: 400_000 });
    writeFileSync(join(tmpdir(), `context-mode-guidance-s-${sid}`, "unrouted-tally.json"), "{not json");
    expect(readUnroutedTally(sid)).toBeNull();
    expect(route("Read", { file_path: midFile }, sid)?.action).toBe("context");
  });

  it("keeps the size rule working with no tally at all", () => {
    // The enforcement thresholds do not depend on the ladder: a large file is
    // refused on its own measured size whether or not anything has been
    // counted yet.
    const sid = session(null);
    expect(route("Read", { file_path: bigFile }, sid)?.action).toBe("deny");
  });

  it("passes everything through when the replacement tool is not running", () => {
    unlinkSync(SENTINEL);
    const sid = session({ count: 40, bytes: 2_000_000 });
    expect(route("Read", { file_path: midFile }, sid)?.action).not.toBe("deny");
    expect(route("Bash", { command: "ps aux" }, sid)?.action).not.toBe("deny");
  });
});

describe("the tally hop between the two hooks", () => {
  it("round-trips both pairs and the timestamp PostToolUse counted", () => {
    const sid = `ladder-roundtrip-${process.pid}`;
    resetGuidanceThrottle(sid);
    const before = Date.now();
    writeUnroutedTally(sid, {
      count: 7,
      bytes: 123_456,
      windowCount: 2,
      windowBytes: 40_000,
    });
    const read = readUnroutedTally(sid);
    // `at` is stamped by the writer, not carried from the caller: PreToolUse
    // needs to know when this record was made, and only the writer knows.
    expect(read).toEqual({
      count: 7,
      bytes: 123_456,
      windowCount: 2,
      windowBytes: 40_000,
      at: expect.any(Number),
    });
    expect(read!.at).toBeGreaterThanOrEqual(before);
  });

  it("fills the window pair from the session pair when PostToolUse sends only two numbers", () => {
    const sid = `ladder-roundtrip-legacy-${process.pid}`;
    resetGuidanceThrottle(sid);
    writeUnroutedTally(sid, { count: 7, bytes: 123_456 });
    expect(readUnroutedTally(sid)).toMatchObject({
      count: 7,
      bytes: 123_456,
      windowCount: 7,
      windowBytes: 123_456,
    });
  });

  it("is cleared with the rest of the session's markers", () => {
    const sid = `ladder-clear-${process.pid}`;
    writeUnroutedTally(sid, { count: 7, bytes: 123_456 });
    resetGuidanceThrottle(sid);
    expect(readUnroutedTally(sid)).toBeNull();
  });
});

describe("a step has to be worth its own text", () => {
  /** Deep enough into the ladder that only the file's size is left in doubt. */
  const AT_DENY: Tally = { count: 9, bytes: 400_000 };
  /** One rung down, where the question is whether asking is worth asking. */
  const AT_ASK: Tally = { count: 6, bytes: 80_000 };

  it("does not refuse a file smaller than the refusal", () => {
    // The observed incident: a 2.4 KB read refused with ~1 KB of reason text,
    // after which the caller took the escape hatch and read it anyway. That
    // trade spends context to save none of it. The collection floor (2000
    // bytes) is a telemetry number and was never meant to authorise this.
    const sid = session(AT_DENY);
    const action = route("Read", { file_path: smallFile }, sid)?.action ?? "null";
    expect(action).not.toBe("deny");
    // Nor a prompt: 2.4 KB is under the ask floor too, so what is left is the
    // advisory, which costs a line and blocks nothing.
    expect(action).not.toBe("ask");
    expect(action).toBe("context");
  });

  it("refuses the same session's read once the file is worth refusing", () => {
    // Nothing about the session changed — only the size of what it is about
    // to pull in. That is the whole distinction the floor draws.
    const sid = session(AT_DENY);
    expect(route("Read", { file_path: midFile }, sid)?.action).toBe("deny");
  });

  it("does not prompt for a file smaller than the prompt", () => {
    // The ask branch had no size test at all, so a session on the `ask` rung
    // was interrupted for a 500-byte file. A prompt is not free either: its
    // reason text lands whatever the user answers, and the answer is usually
    // yes.
    expect(route("Read", { file_path: tinyFile }, session(AT_ASK))?.action ?? "null").not.toBe("ask");
    expect(route("Read", { file_path: smallFile }, session(AT_ASK))?.action ?? "null").not.toBe("ask");
    // Above the floor the rung works exactly as before.
    expect(route("Read", { file_path: midFile }, session(AT_ASK))?.action).toBe("ask");
  });

  it("lets the environment raise the refusal floor and refuses to let it fall", () => {
    expect(escalationDenyFloorBytes({})).toBe(16_384);
    expect(escalationDenyFloorBytes({ CONTEXT_MODE_ESCALATION_DENY_MIN_BYTES: "65536" })).toBe(65_536);
    // A lower enforcement floor is the setting that produced the incident, so
    // the knob is one-directional: it can buy more restraint, never less.
    for (const raw of ["2000", "1", "0", "-5", "nonsense"]) {
      expect(
        escalationDenyFloorBytes({ CONTEXT_MODE_ESCALATION_DENY_MIN_BYTES: raw }),
        `${raw} must not lower the floor`,
      ).toBe(16_384);
    }
  });

  it("keeps the ask floor at half the refusal floor, whichever way it moves", () => {
    // Derived rather than configured, so the two steps cannot be set into the
    // wrong order by an operator moving one and forgetting the other.
    for (const env of [
      {},
      { CONTEXT_MODE_ESCALATION_DENY_MIN_BYTES: "65536" },
      { CONTEXT_MODE_ESCALATION_DENY_MIN_BYTES: "2000" },
    ]) {
      expect(escalationAskFloorBytes(env)).toBe(Math.floor(escalationDenyFloorBytes(env) / 2));
      expect(escalationAskFloorBytes(env)).toBeLessThan(escalationDenyFloorBytes(env));
    }
    expect(escalationAskFloorBytes({})).toBe(8_192);
  });

  it("holds both floors through the routed decision, not just the accessors", () => {
    process.env.CONTEXT_MODE_ESCALATION_DENY_MIN_BYTES = "2000";
    const sid = session(AT_DENY);
    expect(route("Read", { file_path: smallFile }, sid)?.action ?? "null").not.toBe("deny");
    // Raising it does take effect, which is what makes the clamp a clamp and
    // not the env var being ignored outright — and it drags the ask floor up
    // with it, so a 20 KB read on a refusing session goes quiet.
    process.env.CONTEXT_MODE_ESCALATION_DENY_MIN_BYTES = String(64 * 1024);
    const raised = session(AT_DENY);
    const action = route("Read", { file_path: midFile }, raised)?.action ?? "null";
    expect(action).not.toBe("deny");
    expect(action).not.toBe("ask");
  });
});

describe("the fine print is worth saying once", () => {
  /**
   * One session, no reset in between — the throttle is the thing under test,
   * and `session()` clears it. Two different paths, because a repeat of the
   * same path is the edit escape hatch and would be allowed rather than
   * refused a second time.
   */
  function twoRefusals(): { first: string; second: string } {
    const sid = session({ count: 9, bytes: 400_000 });
    const a = route("Read", { file_path: midFile }, sid);
    const b = route("Read", { file_path: otherMidFile }, sid);
    // Asserted here rather than per-case: every claim below is about the text
    // of a refusal, and "shorter" is trivially true of a decision that never
    // happened.
    expect(a?.action, "the first call must actually be refused").toBe("deny");
    expect(b?.action, "the second call must actually be refused").toBe("deny");
    return { first: a?.reason ?? "", second: b?.reason ?? "" };
  }

  it("spells the whole thing out the first time a session is refused", () => {
    const { first } = twoRefusals();
    expect(first).toContain("ctx_execute_file");
    expect(first).toContain("CONTEXT_MODE_READ_DENY_BYTES");
    expect(first).toContain("CONTEXT_MODE_READ_EDIT_WINDOW_MS");
  });

  it("drops to one line on every refusal after it", () => {
    const { first, second } = twoRefusals();
    // The reasoning and the knob names are what the caller has already read;
    // the refusal itself is what changed. On a session refusing repeatedly,
    // repeating the kilobyte makes the plugin the largest single writer to the
    // window it exists to protect.
    expect(second.length).toBeLessThan(first.length / 2);
    expect(second).not.toContain("CONTEXT_MODE_READ_DENY_BYTES");
    expect(second).not.toContain("CONTEXT_MODE_READ_EDIT_WINDOW_MS");
  });

  it("keeps everything the caller has to act on in the short form", () => {
    const { second } = twoRefusals();
    // A redirect, a ready replacement call, and the escape hatch with its
    // deadline. Drop any one of these and the short form stops being a
    // redirect and starts being a wall.
    expect(second).toContain("redirected");
    expect(second).toContain("ctx_read(");
    expect(second).toMatch(/repeat this Read within \d+s/);
  });

  it("stays inside the ADR-0003 vocabulary in both forms", () => {
    const { first, second } = twoRefusals();
    for (const text of [first, second]) {
      for (const word of FORBIDDEN) {
        expect(text.toLowerCase(), `"${word}" turns a redirect into a wall`).not.toContain(word);
      }
    }
  });
});
