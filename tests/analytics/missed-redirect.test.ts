/**
 * missed-redirect telemetry — the other half of the savings picture.
 *
 * ctx_stats has always shown what routing kept out; these tests pin the
 * block that shows what it did NOT, so the number can be tuned against
 * evidence instead of intuition.
 */

import { describe, expect, test } from "vitest";
import { formatReport, categoryLabels } from "../../src/session/analytics.js";
import type { ConversationStats, FullReport } from "../../src/session/analytics.js";

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
    session: { id: "sess-missed", uptime_min: "3.0" },
    continuity: { total_events: 0, by_category: [], compact_count: 0, resume_ready: false },
    projectMemory: { total_events: 0, session_count: 0, by_category: [] },
  };
}

function conversation(missed?: ConversationStats["missedRedirect"]): ConversationStats {
  return {
    sessionId: "sess-missed",
    events: 12,
    dbCount: 1,
    daysAlive: 0.5,
    snapshotBytes: 0,
    snapshotsConsumed: 0,
    byCategory: [{ category: "file", count: 12, label: "Files tracked" }],
    firstEventMs: Date.UTC(2026, 7, 17, 9, 0, 0),
    lastEventMs: Date.UTC(2026, 7, 17, 21, 0, 0),
    byDay: [{ ms: Date.UTC(2026, 7, 17), count: 12 }],
    ...(missed ? { missedRedirect: missed } : {}),
  };
}

describe("missed-redirect reporting", () => {
  test("the category has a human label so the renderer never prints a raw id", () => {
    expect(categoryLabels["missed-redirect"]).toBeTruthy();
  });

  test("the block lists the heaviest unrouted calls with a next step", () => {
    const text = formatReport(baseReport(), "1.0.169", null, {
      conversation: conversation({
        count: 3,
        bytes: 180_000,
        top: [
          { tool: "Bash", bytes: 120_000, summary: "git log --stat" },
          { tool: "Read", bytes: 60_000, summary: "/repo/dump.json" },
        ],
      }),
    });

    expect(text).toContain("Slipped through unrouted");
    expect(text).toContain("3 calls");
    expect(text).toContain("git log --stat");
    expect(text).toContain("/repo/dump.json");
    expect(text).toContain("safe-commands.txt");
  });

  test("a clean session prints no block at all — no triumphant zero", () => {
    const text = formatReport(baseReport(), "1.0.169", null, {
      conversation: conversation(),
    });
    expect(text).not.toContain("Slipped through unrouted");
  });

  test("long command summaries are truncated instead of wrapping the layout", () => {
    const long = "git log --format=" + "x".repeat(200);
    const text = formatReport(baseReport(), "1.0.169", null, {
      conversation: conversation({
        count: 1,
        bytes: 9_000,
        top: [{ tool: "Bash", bytes: 9_000, summary: long }],
      }),
    });
    expect(text).toContain("…");
    expect(text).not.toContain(long);
  });
});
