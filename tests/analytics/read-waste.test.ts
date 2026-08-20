/**
 * §3.6 — read but never used, end to end.
 *
 * The missed-redirect block already tells the user which raw calls slipped past
 * the routing rules. This is the complementary loss: files that DID enter the
 * window through a `Read` and were then never referred to again — no edit, no
 * later call, no mention in the answer. Pure waste, and invisible until now.
 *
 * What is pinned here:
 *   - `getRealBytesStats` surfaces it off the same event stream the reuse
 *     detector already pulls, with no second query;
 *   - it is REPORTED, never DEDUCTED — `bytesAvoided` and `totalSavedTokens`
 *     are bit-for-bit what they were before the pass existed, because a `Read`
 *     was never booked as a saving in the first place (ADR-0004: one basis,
 *     one direction);
 *   - `CONTEXT_MODE_READ_WASTE=0` removes it entirely;
 *   - the rendered line says the bytes, the tokens, the denominator, and that
 *     nothing was deducted for it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { SessionDB } from "../../src/session/db.js";
import { formatReport, getRealBytesStats } from "../../src/session/analytics.js";
import type { ConversationStats, FullReport, RealBytesStats } from "../../src/session/analytics.js";
import { tokensFromBytes } from "../../src/session/tokenizer.js";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const fn of cleanups) { try { fn(); } catch { /* ignore */ } }
});
afterEach(() => {
  delete process.env.CONTEXT_MODE_READ_WASTE;
  delete process.env.CONTEXT_MODE_REUSE_DETECT;
});

const PROJECT = "/home/dev/proj";

function mkSessionsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "read-waste-"));
  cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
  return dir;
}

interface SeedEvent {
  type: string;
  category: string;
  data: string;
  bytesAvoided?: number;
  bytesReturned?: number;
}

function seed(dbPath: string, sessionId: string, events: SeedEvent[]): void {
  const sdb = new SessionDB({ dbPath });
  try {
    sdb.ensureSession(sessionId, PROJECT);
    for (const e of events) {
      sdb.insertEvent(
        sessionId,
        {
          type: e.type,
          category: e.category,
          priority: 1,
          data: e.data,
          project_dir: PROJECT,
          attribution_source: "test",
          attribution_confidence: 1,
        },
        "test",
        { projectDir: PROJECT },
        { bytesAvoided: e.bytesAvoided, bytesReturned: e.bytesReturned },
      );
    }
  } finally {
    sdb.close();
  }
}

const readEvent = (path: string, bytes: number): SeedEvent =>
  ({ type: "file_read", category: "file", data: path, bytesReturned: bytes });
const editEvent = (path: string): SeedEvent =>
  ({ type: "file_edit", category: "file", data: path });
/**
 * Step events with no path-shaped text — they release the tail grace, nothing
 * more. Each carries a distinct payload because SessionDB collapses identical
 * consecutive events, and a collapsed tail would leave the read unjudged.
 */
const tail = (n = 3): SeedEvent[] =>
  Array.from({ length: n }, (_, i) => ({ type: "bash_outcome", category: "bash", data: `exit ${i}` }));

describe("getRealBytesStats — the waste is surfaced", () => {
  test("a read nothing referenced again is reported, and nothing is deducted for it", () => {
    const dir = mkSessionsDir();
    const sid = `sess-${randomUUID()}`;
    seed(join(dir, "aa11bb22cc33dd44__s.db"), sid, [
      { type: "cache-hit", category: "cache", data: "https://x", bytesAvoided: 90_000 },
      readEvent(`${PROJECT}/src/orphan.ts`, 30_000),
      ...tail(),
    ]);

    const r = getRealBytesStats({ sessionId: sid, sessionsDir: dir, projectDir: PROJECT });

    expect(r.readWaste).toBeDefined();
    expect(r.readWaste!.wastedReads).toBe(1);
    expect(r.readWaste!.wastedSources).toBe(1);
    expect(r.readWaste!.wastedBytes).toBe(30_000);
    expect(r.readWaste!.wastedTokens).toBe(Math.round(tokensFromBytes(30_000)));
    expect(r.readWaste!.top[0].path).toBe(`${PROJECT}/src/orphan.ts`);

    // Reported, not deducted: the savings arithmetic is untouched.
    expect(r.bytesAvoided).toBe(90_000);
    expect(r.totalSavedTokens).toBe(
      Math.floor(tokensFromBytes(r.eventDataBytes + 90_000 + r.snapshotBytes)),
    );
  });

  test("a read that fed an edit is not waste, and the field stays undefined", () => {
    const dir = mkSessionsDir();
    const sid = `sess-${randomUUID()}`;
    seed(join(dir, "ee55ff66aa77bb88__s.db"), sid, [
      readEvent(`${PROJECT}/src/alpha.ts`, 30_000),
      editEvent(`${PROJECT}/src/alpha.ts`),
      ...tail(),
    ]);

    const r = getRealBytesStats({ sessionId: sid, sessionsDir: dir, projectDir: PROJECT });
    expect(r.readWaste).toBeUndefined();
  });

  test("CONTEXT_MODE_READ_WASTE=0 removes the metric without touching any other number", () => {
    const dir = mkSessionsDir();
    const sid = `sess-${randomUUID()}`;
    seed(join(dir, "1a2b3c4d5e6f7a8b__s.db"), sid, [
      { type: "cache-hit", category: "cache", data: "https://x", bytesAvoided: 90_000 },
      readEvent(`${PROJECT}/src/orphan.ts`, 30_000),
      ...tail(),
    ]);

    const on = getRealBytesStats({ sessionId: sid, sessionsDir: dir, projectDir: PROJECT });
    process.env.CONTEXT_MODE_READ_WASTE = "0";
    const off = getRealBytesStats({ sessionId: sid, sessionsDir: dir, projectDir: PROJECT });

    expect(off.readWaste).toBeUndefined();
    expect(off.bytesAvoided).toBe(on.bytesAvoided);
    expect(off.totalSavedTokens).toBe(on.totalSavedTokens);
  });
});

// ─────────────────────────────────────────────────────────
// Reporting — the line the user actually reads
// ─────────────────────────────────────────────────────────

const OPTS = {
  cwd: "/home/u/cm",
  now: Date.UTC(2026, 7, 20, 12, 0, 0),
  locale: "en-TR" as const,
  tz: "Europe/Istanbul" as const,
};

function baseReport(): FullReport {
  return {
    savings: {
      processed_kb: 0, entered_kb: 0, saved_kb: 0, pct: 0, savings_ratio: 0,
      by_tool: [], total_calls: 5, total_bytes_returned: 1000,
      kept_out: 5000, total_processed: 0,
    },
    session: { id: "waste-test", uptime_min: "3.0" },
    continuity: { total_events: 0, by_category: [], compact_count: 0, resume_ready: false },
    projectMemory: { total_events: 0, session_count: 0, by_category: [] },
  };
}

function baseConversation(): ConversationStats {
  return {
    sessionId: "waste-conv",
    events: 12,
    dbCount: 1,
    daysAlive: 1.5,
    snapshotBytes: 0,
    snapshotsConsumed: 0,
    byCategory: [{ category: "file", count: 1, label: "Files tracked" }],
    firstEventMs: Date.parse("2026-08-19T08:00:00Z"),
    lastEventMs: Date.parse("2026-08-20T11:00:00Z"),
  };
}

function realBytesWith(readWaste: RealBytesStats["readWaste"]): RealBytesStats {
  return {
    eventDataBytes: 2_139_000,
    bytesAvoided: 2_898_000,
    bytesReturned: 140_000,
    snapshotBytes: 0,
    contentBytes: 0,
    totalSavedTokens: Math.floor(tokensFromBytes(2_139_000 + 2_898_000)),
    readWaste,
  };
}

describe("ctx_stats — the waste block", () => {
  test("names the bytes, the tokens, the denominator and the no-deduction rule", () => {
    const bytes = 61_440;
    const text = formatReport(baseReport(), "1.0.200", null, {
      conversation: baseConversation(),
      realBytes: {
        conversation: realBytesWith({
          wastedReads: 3,
          wastedSources: 2,
          judgedReads: 12,
          judgedSources: 9,
          wastedBytes: bytes,
          wastedTokens: Math.round(tokensFromBytes(bytes)),
          ratio: 0.25,
          top: [
            { path: `${PROJECT}/src/orphan.ts`, bytes: 40_960 },
            { path: `${PROJECT}/src/spare.ts`, bytes: 20_480 },
          ],
          enabled: true,
          truncated: false,
        }),
      },
      ...OPTS,
    });

    expect(text).toMatch(/Read and never used: 60\.0 KB \([\d.,KM]+ tokens\) in 2 files — 3 of 12 file reads\./);
    expect(text).toMatch(/Nothing referenced them afterwards: no edit, no later call, no mention in the answer\./);
    expect(text).toMatch(/orphan\.ts/);
    expect(text).toMatch(/Nothing was deducted for this — those bytes were never counted as kept out\./);
    // ADR-0005: `realBytes.conversation` is session-scoped on one call path and
    // worktree-scoped on another, so this line must claim neither.
    expect(text).not.toMatch(/Read and never used[^\n]*this (session|project)/);
  });

  test("a clean session prints no waste block at all", () => {
    const text = formatReport(baseReport(), "1.0.200", null, {
      conversation: baseConversation(),
      realBytes: { conversation: realBytesWith(undefined) },
      ...OPTS,
    });
    expect(text).not.toMatch(/Read and never used/);
  });
});
