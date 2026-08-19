/**
 * Routing adherence — `routed heavy calls / all heavy calls`.
 *
 * D1–D5 all change how hard the plugin pulls work towards itself, and until
 * this number existed every one of them was accepted on belief: `ctx_stats`
 * could say what routing SAVED and what it MISSED, but never what share of the
 * heavy work it got in the first place. That is the position search was in
 * before P2.1 made quality a number.
 *
 * The tests below are mostly about honesty rather than arithmetic. A metric
 * that reports 0% when nothing heavy happened, or that quietly folds calls of
 * unknown size into the denominator, is worse than no metric — it would be
 * read as evidence in exactly the decisions it was built to inform.
 */

import { describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/session/db.js";
import {
  adherenceMinBytes,
  computeRoutingAdherence,
  formatReport,
  getConversationStats,
} from "../../src/session/analytics.js";
import type {
  ConversationStats,
  FullReport,
  RoutingCallSample,
} from "../../src/session/analytics.js";

const MIN = 2000;

function baseReport(): FullReport {
  return {
    savings: {
      processed_kb: 50,
      entered_kb: 10,
      saved_kb: 40,
      pct: 80,
      savings_ratio: 5,
      by_tool: [],
      total_calls: 0,
      total_bytes_returned: 10 * 1024,
      kept_out: 40 * 1024,
      total_processed: 50 * 1024,
    },
    session: { id: "sess-adherence", uptime_min: "3.0" },
    continuity: { total_events: 0, by_category: [], compact_count: 0, resume_ready: false },
    projectMemory: { total_events: 0, session_count: 0, by_category: [] },
  };
}

function conversation(extra: Partial<ConversationStats>): ConversationStats {
  return {
    sessionId: "sess-adherence",
    events: 12,
    dbCount: 1,
    daysAlive: 0.5,
    snapshotBytes: 0,
    snapshotsConsumed: 0,
    byCategory: [{ category: "file", count: 12, label: "Files tracked" }],
    firstEventMs: Date.UTC(2026, 7, 17, 9, 0, 0),
    lastEventMs: Date.UTC(2026, 7, 17, 21, 0, 0),
    byDay: [{ ms: Date.UTC(2026, 7, 17), count: 12 }],
    ...extra,
  };
}

describe("computeRoutingAdherence", () => {
  test("a session with nothing heavy reports no data, not zero percent", () => {
    // 0/0 is not 0%. A quiet session and a session that leaked everything must
    // not print the same number.
    const a = computeRoutingAdherence([], { minBytes: MIN });
    expect(a.ratio).toBeNull();
    expect(a.heavy).toBe(0);
    expect(a.routedHeavy).toBe(0);
    expect(a.unroutedHeavy).toBe(0);
  });

  test("calls under the threshold are not heavy and do not enter the ratio", () => {
    const samples: RoutingCallSample[] = [
      { routed: false, tool: "Bash", bytes: 40, summary: "git status" },
      { routed: true, tool: "ctx_execute", bytes: 900 },
    ];
    const a = computeRoutingAdherence(samples, { minBytes: MIN });
    expect(a.heavy).toBe(0);
    expect(a.ratio).toBeNull();
    expect(a.unclassified).toBe(0);
  });

  test("everything routed is 100%", () => {
    const samples: RoutingCallSample[] = [
      { routed: true, tool: "ctx_execute", bytes: 9_000 },
      { routed: true, tool: "ctx_batch_execute", bytes: 120_000 },
      { routed: true, tool: "WebFetch", bytes: 16_384 },
    ];
    const a = computeRoutingAdherence(samples, { minBytes: MIN });
    expect(a.ratio).toBe(1);
    expect(a.routedHeavy).toBe(3);
    expect(a.routedBytes).toBe(145_384);
    expect(a.unroutedBytes).toBe(0);
    expect(a.top).toEqual([]);
  });

  test("everything unrouted is 0% — and that zero is real", () => {
    const samples: RoutingCallSample[] = [
      { routed: false, tool: "Bash", bytes: 15_600, summary: "git log" },
      { routed: false, tool: "Read", bytes: 60_000, summary: "/repo/dump.json" },
    ];
    const a = computeRoutingAdherence(samples, { minBytes: MIN });
    expect(a.ratio).toBe(0);
    expect(a.unroutedHeavy).toBe(2);
    expect(a.routedHeavy).toBe(0);
    expect(a.unroutedBytes).toBe(75_600);
  });

  test("a mixed session divides routed by the whole heavy population", () => {
    const samples: RoutingCallSample[] = [
      { routed: true, tool: "ctx_execute", bytes: 5_000 },
      { routed: true, tool: "ctx_execute", bytes: 5_000 },
      { routed: true, tool: "ctx_execute", bytes: 5_000 },
      { routed: false, tool: "Bash", bytes: 5_000, summary: "git log" },
    ];
    const a = computeRoutingAdherence(samples, { minBytes: MIN });
    expect(a.heavy).toBe(4);
    expect(a.ratio).toBe(0.75);
  });

  test("calls of unknown size are counted apart, never spread over the denominator", () => {
    // The whole point: a routed call with no recorded size must not be assumed
    // heavy (which would flatter the ratio) nor assumed light (which would
    // hide real routed work).
    const samples: RoutingCallSample[] = [
      { routed: true, tool: "ctx_search" },
      { routed: true, tool: "ctx_find" },
      { routed: false, tool: "Bash" },
      { routed: false, tool: "Bash", bytes: 8_000, summary: "git log" },
      { routed: true, tool: "ctx_execute", bytes: 8_000 },
    ];
    const a = computeRoutingAdherence(samples, { minBytes: MIN });
    expect(a.heavy).toBe(2);
    expect(a.ratio).toBe(0.5);
    expect(a.unclassified).toBe(3);
    expect(a.unclassifiedRouted).toBe(2);
  });

  test("offenders are grouped by tool and command, heaviest first", () => {
    const samples: RoutingCallSample[] = [
      { routed: false, tool: "Bash", bytes: 4_000, summary: "git log" },
      { routed: false, tool: "Bash", bytes: 6_000, summary: "git log" },
      { routed: false, tool: "Read", bytes: 40_000, summary: "/repo/dump.json" },
      { routed: false, tool: "Bash", bytes: 3_000, summary: "npm ls" },
    ];
    const a = computeRoutingAdherence(samples, { minBytes: MIN });
    expect(a.top[0]).toEqual({ tool: "Read", calls: 1, bytes: 40_000, summary: "/repo/dump.json" });
    expect(a.top[1]).toEqual({ tool: "Bash", calls: 2, bytes: 10_000, summary: "git log" });
    expect(a.top).toHaveLength(3);
  });

  test("the offender list honors topLimit", () => {
    const samples: RoutingCallSample[] = Array.from({ length: 9 }, (_, i) => ({
      routed: false, tool: "Bash", bytes: 3_000 + i, summary: `cmd-${i}`,
    }));
    expect(computeRoutingAdherence(samples, { minBytes: MIN, topLimit: 2 }).top).toHaveLength(2);
  });

  test("averaged sizes count towards the ratio but are reported as estimates", () => {
    const a = computeRoutingAdherence([
      { routed: true, tool: "ctx_execute", bytes: 9_000, estimated: true },
      { routed: true, tool: "ctx_batch_execute", bytes: 40_000 },
      { routed: false, tool: "Bash", bytes: 9_000, summary: "git log" },
    ], { minBytes: MIN });
    expect(a.routedHeavy).toBe(2);
    expect(a.routedEstimated).toBe(1);
  });

  test("a negative or non-finite size is unknown, not zero", () => {
    const a = computeRoutingAdherence(
      [{ routed: false, tool: "Bash", bytes: -1 }, { routed: true, tool: "ctx_execute", bytes: Number.NaN }],
      { minBytes: MIN },
    );
    expect(a.unclassified).toBe(2);
    expect(a.heavy).toBe(0);
  });
});

describe("adherenceMinBytes", () => {
  test("defaults to the collection floor the PostToolUse hook uses", () => {
    expect(adherenceMinBytes({})).toEqual({ minBytes: 2000 });
  });

  test("CONTEXT_MODE_ADHERENCE_MIN_BYTES raises the line", () => {
    expect(adherenceMinBytes({ CONTEXT_MODE_ADHERENCE_MIN_BYTES: "50000" })).toEqual({ minBytes: 50_000 });
  });

  test("a line below the collection floor is clamped, and says so", () => {
    // Under the floor no unrouted call is recorded at all, so the denominator
    // would lose leaks while keeping routed calls — a ratio that flatters by
    // construction.
    expect(adherenceMinBytes({ CONTEXT_MODE_ADHERENCE_MIN_BYTES: "500" }))
      .toEqual({ minBytes: 2000, clampedFrom: 500 });
  });

  test("the floor follows the hook's own threshold when that is raised", () => {
    expect(adherenceMinBytes({
      CONTEXT_MODE_MISSED_REDIRECT_MIN_BYTES: "10000",
      CONTEXT_MODE_ADHERENCE_MIN_BYTES: "4000",
    })).toEqual({ minBytes: 10_000, clampedFrom: 4000 });
  });

  test("garbage values fall back instead of producing NaN thresholds", () => {
    expect(adherenceMinBytes({ CONTEXT_MODE_ADHERENCE_MIN_BYTES: "abc" })).toEqual({ minBytes: 2000 });
    expect(adherenceMinBytes({ CONTEXT_MODE_ADHERENCE_MIN_BYTES: "0" })).toEqual({ minBytes: 2000 });
  });
});

describe("ctx_stats rendering", () => {
  test("states the share, the absolute halves, and the threshold by name", () => {
    const text = formatReport(baseReport(), "1.0.169", null, {
      conversation: conversation({
        adherence: computeRoutingAdherence([
          { routed: true, tool: "ctx_execute", bytes: 100_000 },
          { routed: true, tool: "ctx_execute", bytes: 100_000 },
          { routed: false, tool: "Bash", bytes: 50_000, summary: "git log --stat" },
          { routed: false, tool: "Read", bytes: 50_000, summary: "/repo/dump.json" },
        ], { minBytes: MIN }),
      }),
    });
    expect(text).toContain("Routing adherence: 50%");
    expect(text).toContain("2 of 4 heavy calls");
    // A share of "heavy calls" is unreadable without the line that defines heavy.
    expect(text).toContain("CONTEXT_MODE_ADHERENCE_MIN_BYTES");
    expect(text).toContain("Through the plugin:");
    expect(text).toContain("straight into context:");
  });

  test("an idle session reports no data rather than a damning zero", () => {
    const text = formatReport(baseReport(), "1.0.169", null, {
      conversation: conversation({ adherence: computeRoutingAdherence([], { minBytes: MIN }) }),
    });
    expect(text).toContain("Routing adherence: no data");
    expect(text).not.toContain("Routing adherence: 0%");
  });

  test("unclassified calls get their own line instead of moving the ratio", () => {
    const text = formatReport(baseReport(), "1.0.169", null, {
      conversation: conversation({
        adherence: computeRoutingAdherence([
          { routed: true, tool: "ctx_execute", bytes: 9_000 },
          { routed: true, tool: "ctx_search" },
          { routed: true, tool: "ctx_find" },
        ], { minBytes: MIN }),
      }),
    });
    expect(text).toContain("Routing adherence: 100%");
    expect(text).toContain("Not classified: 2 calls with no recorded size (2 of them routed)");
  });

  test("a clamped threshold explains itself in the report", () => {
    const text = formatReport(baseReport(), "1.0.169", null, {
      conversation: conversation({
        adherence: computeRoutingAdherence(
          [{ routed: false, tool: "Bash", bytes: 9_000, summary: "git log" }],
          { minBytes: 2000, clampedFrom: 500 },
        ),
      }),
    });
    expect(text).toContain("Raised from 500 B");
  });

  test("the offender list shows the repeat count for a command fired many times", () => {
    const text = formatReport(baseReport(), "1.0.169", null, {
      conversation: conversation({
        missedRedirect: {
          count: 3,
          bytes: 30_000,
          top: [{ tool: "Bash", bytes: 30_000, summary: "git log --stat" }],
        },
        adherence: computeRoutingAdherence([
          { routed: false, tool: "Bash", bytes: 10_000, summary: "git log --stat" },
          { routed: false, tool: "Bash", bytes: 10_000, summary: "git log --stat" },
          { routed: false, tool: "Bash", bytes: 10_000, summary: "git log --stat" },
        ], { minBytes: MIN }),
      }),
    });
    expect(text).toContain("git log --stat");
    expect(text).toContain("×3");
  });

  test("an estimated numerator says so instead of passing for a measurement", () => {
    const text = formatReport(baseReport(), "1.0.169", null, {
      conversation: conversation({
        adherence: computeRoutingAdherence([
          { routed: true, tool: "ctx_execute", bytes: 9_000, estimated: true },
          { routed: false, tool: "Bash", bytes: 9_000, summary: "git log" },
        ], { minBytes: MIN }),
      }),
    });
    expect(text).toContain("per-tool average");
  });

  test("a session with no adherence data at all still renders the old blocks", () => {
    // Back-compat: conversations recorded before this field existed.
    const text = formatReport(baseReport(), "1.0.169", null, {
      conversation: conversation({
        missedRedirect: {
          count: 1,
          bytes: 9_000,
          top: [{ tool: "Bash", bytes: 9_000, summary: "git log" }],
        },
      }),
    });
    expect(text).toContain("Slipped through unrouted");
    expect(text).not.toContain("Routing adherence");
  });
});

describe("getConversationStats — where the two halves come from", () => {
  /** A session DB with the rows a real session would have written. */
  function fixture(): { dir: string; sessionId: string } {
    const dir = mkdtempSync(join(tmpdir(), "ctx-adherence-"));
    const sessionId = "11111111-2222-3333-4444-555555555555";
    const sdb = new SessionDB({ dbPath: join(dir, "abcdef0123456789.db") });
    try {
      const event = (category: string, type: string, data: string) => ({
        type, category, priority: 3, data,
        project_dir: "/repo", attribution_source: "test", attribution_confidence: 1,
      });
      // Two heavy calls that went into context whole, one under the line.
      sdb.insertEvent(sessionId, event("missed-redirect", "missed_redirect", "Bash: 15600 bytes unrouted — git log --stat"));
      sdb.insertEvent(sessionId, event("missed-redirect", "missed_redirect", "Read: 40000 bytes unrouted — /repo/dump.json"));
      sdb.insertEvent(sessionId, event("missed-redirect", "missed_redirect", "Bash: 300 bytes unrouted — git status"));
      // One native call the PreToolUse hook turned around — measured per call.
      sdb.insertEvent(
        sessionId,
        event("redirect", "webfetch-redirected", "WebFetch: https://example.com/spec"),
        "PreToolUse", undefined, { bytesAvoided: 30_000 },
      );
      // Three ctx_execute calls: 24 KB returned in total, 8 KB average.
      for (let i = 0; i < 3; i++) sdb.incrementToolCall(sessionId, "ctx_execute", 8_000);
      // A meta tool that must never count as routed heavy work.
      sdb.incrementToolCall(sessionId, "ctx_doctor", 50_000);
    } finally {
      sdb.close();
    }
    return { dir, sessionId };
  }

  test("routed calls come from tool_calls and redirects; unrouted from missed-redirect rows", () => {
    const { dir, sessionId } = fixture();
    const stats = getConversationStats({ sessionId, sessionsDir: dir });
    const a = stats.adherence!;

    // 3 ctx_execute (averaged) + 1 redirect = 4 routed; 2 unrouted over the line.
    expect(a.routedHeavy).toBe(4);
    expect(a.routedEstimated).toBe(3);
    expect(a.unroutedHeavy).toBe(2);
    expect(a.heavy).toBe(6);
    expect(a.ratio).toBeCloseTo(4 / 6, 5);
    expect(a.unroutedBytes).toBe(55_600);
  });

  test("running diagnostics cannot raise a session's adherence", () => {
    const { dir, sessionId } = fixture();
    const a = getConversationStats({ sessionId, sessionsDir: dir }).adherence!;
    // ctx_doctor returned 50 KB — well over the line — and still counts for
    // nothing: it is a command about the plugin, not work routed through it.
    expect(a.routedHeavy).toBe(4);
  });

  test("the sub-threshold unrouted call is left out of both halves", () => {
    const { dir, sessionId } = fixture();
    const a = getConversationStats({ sessionId, sessionsDir: dir }).adherence!;
    expect(a.heavy).toBe(6);
    expect(a.unclassified).toBe(0);
  });

  test("heavy calls the rules asked for never enter the denominator", () => {
    // `git diff` on Bash is the routing block being obeyed, not a leak. Both
    // kinds of row carry the same `data` line, so only the category separates
    // them — and if the query took both, adherence would fall the more
    // closely the agent followed the plugin.
    const dir = mkdtempSync(join(tmpdir(), "ctx-sanctioned-"));
    const sessionId = "66666666-7777-8888-9999-000000000000";
    const sdb = new SessionDB({ dbPath: join(dir, "0123456789abcdef.db") });
    try {
      const event = (category: string, type: string, data: string) => ({
        type, category, priority: 3, data,
        project_dir: "/repo", attribution_source: "test", attribution_confidence: 1,
      });
      sdb.insertEvent(sessionId, event("missed-redirect", "missed_redirect", "Read: 40000 bytes unrouted — /repo/dump.json"));
      sdb.insertEvent(sessionId, event("sanctioned-heavy", "sanctioned_heavy", "Bash: 15600 bytes unrouted — git diff"));
      sdb.insertEvent(sessionId, event("sanctioned-heavy", "sanctioned_heavy", "Bash: 90000 bytes unrouted — npm install"));
    } finally {
      sdb.close();
    }

    const stats = getConversationStats({ sessionId, sessionsDir: dir });
    const a = stats.adherence!;
    expect(a.heavy).toBe(1);
    expect(a.unroutedHeavy).toBe(1);
    expect(a.unroutedBytes).toBe(40_000);
    expect(a.unclassified).toBe(0);
    // Nor may they show up in the offender list the same block prints.
    expect(stats.missedRedirect?.count).toBe(1);
  });
});
