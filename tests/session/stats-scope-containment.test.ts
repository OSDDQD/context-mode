/**
 * ADR-0005 — the scope ladder must be labelled for what it measures, and a
 * wider scope must never report less than a narrower one.
 *
 * The bug this pins: the line that read "This chat" was fed the whole worktree
 * pool (deliberately, so a conversation's sub-agents are credited to it), which
 * made it a project number. Printed as a chat number next to an all-work number
 * that did not count content bytes at all, it produced
 * "This chat 6.9 MB > All your work 6.7 MB".
 */

import { describe, expect, test } from "vitest";
import { formatReport } from "../../src/session/analytics.js";
import type {
  ConversationStats,
  FullReport,
  LifetimeStats,
  RealBytesStats,
} from "../../src/session/analytics.js";

const STABLE_OPTS = {
  cwd: "/home/u/cm",
  now: Date.UTC(2026, 4, 10, 18, 0, 0),
  locale: "en-TR" as const,
  tz: "Europe/Istanbul" as const,
};

function baseReport(): FullReport {
  return {
    savings: {
      processed_kb: 0, entered_kb: 0, saved_kb: 0, pct: 0, savings_ratio: 0,
      by_tool: [], total_calls: 0, total_bytes_returned: 0, kept_out: 0, total_processed: 0,
    },
    session: { id: "sess-x", uptime_min: "3.0" },
    continuity: { total_events: 0, by_category: [], compact_count: 0, resume_ready: false },
    projectMemory: {
      total_events: 160,
      session_count: 40,
      by_category: [{ category: "file", count: 391, label: "Files tracked" }],
    },
  };
}

function baseConversation(): ConversationStats {
  return {
    sessionId: "b5833e08-test",
    events: 1277,
    dbCount: 2,
    daysAlive: 11.4,
    snapshotBytes: 1552 * 1024,
    snapshotsConsumed: 1,
    byCategory: [{ category: "file", count: 131, label: "Files tracked" }],
  };
}

function baseLifetime(): LifetimeStats {
  return {
    totalEvents: 16_366,
    totalSessions: 411,
    autoMemoryCount: 22,
    autoMemoryProjects: 6,
    autoMemoryByPrefix: { project: 11 },
    categoryCounts: { file: 5082 },
    rescueBytes: 1675 * 1024,
    firstEventMs: Date.parse("2026-04-14T00:00:00Z"),
    distinctProjects: 10,
  };
}

/** A conversation slice whose worktree pool dwarfs the lifetime estimate. */
function hugeConversationBytes(sessionKeptOutBytes?: number): RealBytesStats {
  return {
    eventDataBytes: 3_000_000,
    bytesAvoided: 4_000_000,
    bytesReturned: 500_000,
    snapshotBytes: 100_000,
    contentBytes: 0,
    totalSavedTokens: Math.floor((3_000_000 + 4_000_000 + 100_000) / 4),
    ...(sessionKeptOutBytes === undefined ? {} : { sessionKeptOutBytes }),
  };
}

/** Parse "N.N MB"/"N KB" out of one labelled ladder row. */
function ladderBytes(text: string, label: string): number {
  const m = text.match(new RegExp(`${label}: ([\\d.,]+) (B|KB|MB|GB)`));
  if (!m) throw new Error(`row "${label}" not found in:\n${text}`);
  const n = parseFloat(m[1].replace(/,/g, ""));
  return n * { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[m[2] as "B" | "KB" | "MB" | "GB"];
}

describe("scope ladder", () => {
  test("the worktree pool is labelled a project, not a chat", () => {
    const text = formatReport(baseReport(), "1.0.169", null, {
      conversation: baseConversation(),
      lifetime: baseLifetime(),
      realBytes: { conversation: hugeConversationBytes() },
      ...STABLE_OPTS,
    });
    expect(text).toMatch(/This project:/);
    expect(text).not.toMatch(/This chat:/);
  });

  test("a session slice is reported as its own row, under the project row", () => {
    const text = formatReport(baseReport(), "1.0.169", null, {
      conversation: baseConversation(),
      lifetime: baseLifetime(),
      realBytes: { conversation: hugeConversationBytes(900_000) },
      ...STABLE_OPTS,
    });
    expect(ladderBytes(text, "This session")).toBeLessThanOrEqual(ladderBytes(text, "This project"));
  });

  test("all-work is never smaller than the project inside it", () => {
    // The conversation pool (7.1 MB) beats the lifetime estimate here — the
    // exact shape that produced "This chat > All your work".
    const text = formatReport(baseReport(), "1.0.169", null, {
      conversation: baseConversation(),
      lifetime: baseLifetime(),
      realBytes: { conversation: hugeConversationBytes(900_000) },
      ...STABLE_OPTS,
    });
    expect(ladderBytes(text, "All your work")).toBeGreaterThanOrEqual(ladderBytes(text, "This project"));
  });

  test("containment is restored by raising the wider scope, not lowering the narrower", () => {
    const conversation = hugeConversationBytes(900_000);
    const text = formatReport(baseReport(), "1.0.169", null, {
      conversation: baseConversation(),
      lifetime: baseLifetime(),
      realBytes: { conversation },
      ...STABLE_OPTS,
    });
    const projectRaw = conversation.eventDataBytes + conversation.bytesAvoided + conversation.snapshotBytes;
    // Within display rounding of the raw pool: the project row is not scaled
    // down to fit under a smaller lifetime number.
    const shown = ladderBytes(text, "This project");
    expect(Math.abs(shown - projectRaw) / projectRaw).toBeLessThan(0.01);
  });

  test("the disk footprint is stated as a cost, not as more savings", () => {
    const text = formatReport(baseReport(), "1.0.169", null, {
      conversation: baseConversation(),
      lifetime: baseLifetime(),
      realBytes: { conversation: hugeConversationBytes(900_000) },
      storeUsage: { bytes: 216 * 1024 * 1024, stores: 328 },
      ...STABLE_OPTS,
    });
    expect(text).toMatch(/Knowledge base on disk: .* across 328 stores/);
    expect(text).toMatch(/what it costs to keep, not what it saved/);
  });

  test("no footprint given, no footprint line", () => {
    const text = formatReport(baseReport(), "1.0.169", null, {
      conversation: baseConversation(),
      lifetime: baseLifetime(),
      realBytes: { conversation: hugeConversationBytes(900_000) },
      ...STABLE_OPTS,
    });
    expect(text).not.toMatch(/Knowledge base on disk/);
  });
});
