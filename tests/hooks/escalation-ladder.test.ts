/**
 * The price of a violation grows instead of resetting.
 *
 * The advisory used to fire once per session per tool and then latch shut with
 * an O_CREAT|O_EXCL marker — the first Read of a session got advice, the two
 * hundredth got silence. Long sessions are precisely the ones where the rules
 * matter most, and the ones where compaction has already removed those rules
 * from the system text.
 *
 * What replaces it is a function of the session's own behaviour: the tally of
 * unrouted heavy calls, which only grows. Severity derived from a quantity
 * that only grows can only grow too, and that is asserted here directly rather
 * than left as an argument — a ladder that can quietly step back down is the
 * old bug wearing different clothes.
 *
 * Two properties are load-bearing besides monotonicity. Silence on a healthy
 * session is a requirement, not a nicety: a session that routes its heavy work
 * hears nothing at all. And when the tally cannot be read — no session id, no
 * PostToolUse yet, an unreadable store — the behaviour must fall back to the
 * advisory this hook has always emitted, never to the violation branch.
 * Punishing a session for a file we failed to open is the one outcome with no
 * defence.
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
} from "../../hooks/core/routing.mjs";

interface Decision {
  action: string;
  reason?: string;
  additionalContext?: string;
  redirectMeta?: { bytesAvoided?: number };
}

interface Tally {
  count: number;
  bytes: number;
}

const PROJECT = process.cwd();

const SENTINEL_DIR = mkdtempSync(join(tmpdir(), "ctx-ladder-sentinel-"));
process.env.CONTEXT_MODE_MCP_SENTINEL_DIR = SENTINEL_DIR;
const SENTINEL = resolve(SENTINEL_DIR, `context-mode-mcp-ready-${process.pid}`);

const ENV_KEYS = ["CONTEXT_MODE_NUDGE_AFTER_CALLS", "CONTEXT_MODE_NUDGE_AFTER_BYTES"];

let scratch: string;
/** Big enough to be a violation, small enough that the size rule ignores it. */
let midFile: string;
let bigFile: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "ctx-ladder-"));
  midFile = join(scratch, "mid.ts");
  bigFile = join(scratch, "big.ts");
  writeFileSync(midFile, "x".repeat(20_000));
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

describe("the price never goes back down", () => {
  it("gives a strictly non-decreasing response as the tally grows", () => {
    // The old behaviour failed exactly here: call 1 got advice and call 2 got
    // silence. Severity is a function of a quantity that only grows, so this
    // holds by construction — asserted anyway, because "by construction" is
    // what the previous design believed about itself too.
    const growing: Tally[] = [
      { count: 0, bytes: 0 },
      { count: 1, bytes: 20_000 },
      { count: 3, bytes: 60_000 },
      { count: 5, bytes: 90_000 },
      { count: 6, bytes: 150_000 },
      { count: 8, bytes: 220_000 },
      { count: 9, bytes: 400_000 },
      { count: 40, bytes: 2_000_000 },
    ];
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
  it("round-trips the two numbers PostToolUse counted", () => {
    const sid = `ladder-roundtrip-${process.pid}`;
    resetGuidanceThrottle(sid);
    writeUnroutedTally(sid, { count: 7, bytes: 123_456 });
    expect(readUnroutedTally(sid)).toEqual({ count: 7, bytes: 123_456 });
  });

  it("is cleared with the rest of the session's markers", () => {
    const sid = `ladder-clear-${process.pid}`;
    writeUnroutedTally(sid, { count: 7, bytes: 123_456 });
    resetGuidanceThrottle(sid);
    expect(readUnroutedTally(sid)).toBeNull();
  });
});
