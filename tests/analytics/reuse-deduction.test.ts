/**
 * C-02 — the returns, deducted from the claimed savings.
 *
 * `getRealBytesStats` used to book every `bytes_avoided` byte as a win. When
 * the model reads a file whole a few steps after a ctx tool handed it a
 * compressed view of that same file, nothing was kept out: the full text
 * entered the window anyway, and the retrieval response entered it on top.
 * This suite pins the correction end to end —
 *
 *   before:  keptOut = eventDataBytes + bytesAvoided + snapshotBytes
 *   after:   keptOut = eventDataBytes + max(0, bytesAvoided - returned)
 *                                     + snapshotBytes
 *
 * — the subtraction happening in BYTES, before `tokensFromBytes`, so both
 * sides of every ctx_stats ratio stay on the one basis `session/tokenizer.ts`
 * established. It also pins that the receipt SAYS what it took off, and that
 * the env switch restores the old (overstated) number exactly.
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
  delete process.env.CONTEXT_MODE_REUSE_DETECT;
  delete process.env.CONTEXT_MODE_REUSE_THRESHOLD;
});

const PROJECT = "/home/dev/proj";

function mkSessionsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "reuse-deduct-"));
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

/** A ctx_execute_file call over `src/a.ts` that kept `avoided` bytes out. */
function coverEvent(path: string, avoided: number): SeedEvent {
  return {
    type: "mcp_tool_call",
    category: "mcp_tool_call",
    data: JSON.stringify({
      tool_name: "mcp__plugin_context-mode_context-mode__ctx_execute_file",
      params: { path, language: "javascript" },
    }),
    bytesAvoided: avoided,
  };
}

/** A full `Read` of `path` that put `bytes` into the window. */
function readEvent(path: string, bytes: number): SeedEvent {
  return { type: "file_read", category: "file", data: path, bytesReturned: bytes };
}

describe("getRealBytesStats — the returns are deducted", () => {
  test("a covered-then-read file comes off bytesAvoided, in bytes, before tokens", () => {
    const dir = mkSessionsDir();
    const sid = `sess-${randomUUID()}`;
    seed(join(dir, "aaaabbbbccccdddd__s.db"), sid, [
      coverEvent("src/a.ts", 100_000),
      readEvent(`${PROJECT}/src/a.ts`, 30_000),
    ]);

    const r = getRealBytesStats({ sessionId: sid, sessionsDir: dir });

    expect(r.reuse).toBeDefined();
    expect(r.reuse!.returnedReads).toBe(1);
    expect(r.reuse!.coveredSources).toBe(1);
    expect(r.reuse!.returnedSources).toBe(1);
    expect(r.reuse!.returnedBytes).toBe(30_000);
    expect(r.reuse!.ratio).toBe(1);

    // The deduction itself.
    expect(r.keptOutBytesGross).toBe(100_000);
    expect(r.reuseDeductedBytes).toBe(30_000);
    expect(r.bytesAvoided).toBe(70_000);

    // And it propagates into the token headline through the SAME function the
    // implementation uses — no second basis anywhere in the chain.
    expect(r.totalSavedTokens).toBe(
      Math.floor(tokensFromBytes(r.eventDataBytes + 70_000 + r.snapshotBytes)),
    );
  });

  test("reading a DIFFERENT file deducts nothing", () => {
    const dir = mkSessionsDir();
    const sid = `sess-${randomUUID()}`;
    seed(join(dir, "1111222233334444__s.db"), sid, [
      coverEvent("src/a.ts", 100_000),
      readEvent(`${PROJECT}/src/b.ts`, 30_000),
    ]);

    const r = getRealBytesStats({ sessionId: sid, sessionsDir: dir });

    expect(r.reuse!.returnedReads).toBe(0);
    expect(r.reuse!.coveredSources).toBe(1);
    expect(r.reuseDeductedBytes).toBe(0);
    expect(r.bytesAvoided).toBe(100_000);
  });

  test("a session with no retrieval at all is untouched", () => {
    const dir = mkSessionsDir();
    const sid = `sess-${randomUUID()}`;
    seed(join(dir, "5555666677778888__s.db"), sid, [
      { type: "cache-hit", category: "cache", data: "https://x", bytesAvoided: 90_000 },
    ]);

    const r = getRealBytesStats({ sessionId: sid, sessionsDir: dir });
    expect(r.bytesAvoided).toBe(90_000);
    expect(r.reuse?.returnedBytes ?? 0).toBe(0);
  });

  test("the deduction clamps at zero — a bar can never invert", () => {
    const dir = mkSessionsDir();
    const sid = `sess-${randomUUID()}`;
    seed(join(dir, "9999aaaabbbbcccc__s.db"), sid, [
      coverEvent("src/a.ts", 5_000),
      readEvent(`${PROJECT}/src/a.ts`, 400_000),
    ]);

    const r = getRealBytesStats({ sessionId: sid, sessionsDir: dir });
    expect(r.reuse!.returnedBytes).toBe(400_000);
    expect(r.reuseDeductedBytes).toBe(5_000);
    expect(r.bytesAvoided).toBe(0);
    expect(r.totalSavedTokens).toBeGreaterThanOrEqual(0);
  });

  test("CONTEXT_MODE_REUSE_DETECT=0 restores the pre-C-02 number exactly", () => {
    const dir = mkSessionsDir();
    const sid = `sess-${randomUUID()}`;
    seed(join(dir, "ddddeeeeffff0000__s.db"), sid, [
      coverEvent("src/a.ts", 100_000),
      readEvent(`${PROJECT}/src/a.ts`, 30_000),
    ]);

    process.env.CONTEXT_MODE_REUSE_DETECT = "0";
    const off = getRealBytesStats({ sessionId: sid, sessionsDir: dir });
    expect(off.reuse).toBeUndefined();
    expect(off.bytesAvoided).toBe(100_000);
    expect(off.totalSavedTokens).toBe(
      Math.floor(tokensFromBytes(off.eventDataBytes + 100_000 + off.snapshotBytes)),
    );

    delete process.env.CONTEXT_MODE_REUSE_DETECT;
    const on = getRealBytesStats({ sessionId: sid, sessionsDir: dir });
    expect(on.bytesAvoided).toBe(70_000);
    expect(on.totalSavedTokens).toBeLessThan(off.totalSavedTokens);
  });

  test("lifetime tier (no sessionId) deducts too", () => {
    const dir = mkSessionsDir();
    const sid = `sess-${randomUUID()}`;
    seed(join(dir, "0f0f0f0f0f0f0f0f__s.db"), sid, [
      coverEvent("src/a.ts", 100_000),
      readEvent(`${PROJECT}/src/a.ts`, 25_000),
    ]);

    const r = getRealBytesStats({ sessionsDir: dir });
    expect(r.reuseDeductedBytes).toBe(25_000);
    expect(r.bytesAvoided).toBe(75_000);
  });
});

// ─────────────────────────────────────────────────────────
// Reporting — ctx_stats must say what it took off
// ─────────────────────────────────────────────────────────

const OPTS = {
  cwd: "/home/u/cm",
  now: Date.UTC(2026, 4, 24, 12, 0, 0),
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
    session: { id: "reuse-test", uptime_min: "3.0" },
    continuity: { total_events: 0, by_category: [], compact_count: 0, resume_ready: false },
    projectMemory: { total_events: 0, session_count: 0, by_category: [] },
  };
}

function baseConversation(): ConversationStats {
  return {
    sessionId: "reuse-conv",
    events: 12,
    dbCount: 1,
    daysAlive: 1.5,
    snapshotBytes: 0,
    snapshotsConsumed: 0,
    byCategory: [{ category: "file", count: 1, label: "Files tracked" }],
    firstEventMs: Date.parse("2026-05-23T08:00:00Z"),
    lastEventMs: Date.parse("2026-05-24T11:00:00Z"),
  };
}

function realBytesWith(reuse: RealBytesStats["reuse"], deducted: number): RealBytesStats {
  return {
    eventDataBytes: 2_139_000,
    bytesAvoided: 2_898_000,
    bytesReturned: 140_000,
    snapshotBytes: 0,
    contentBytes: 0,
    totalSavedTokens: Math.floor(tokensFromBytes(2_139_000 + 2_898_000)),
    reuse,
    keptOutBytesGross: 2_898_000 + deducted,
    reuseDeductedBytes: deducted,
  };
}

describe("ctx_stats — the returns are visible", () => {
  test("the block names the reads, the share, and the bytes deducted", () => {
    const text = formatReport(baseReport(), "1.0.200", null, {
      conversation: baseConversation(),
      realBytes: {
        conversation: realBytesWith({
          returnedReads: 4,
          coveredSources: 10,
          returnedSources: 2,
          returnedBytes: 220_000,
          returnedTokens: Math.round(tokensFromBytes(220_000)),
          ratio: 0.2,
          enabled: true,
        }, 220_000),
      },
      ...OPTS,
    });

    expect(text).toMatch(/Went back to the source/);
    expect(text).toMatch(/4 full reads/);
    expect(text).toMatch(/20% of the 10 compressed/);
    expect(text).toMatch(/deducted from the savings above/);
    // Below the 30% line — no bypass advice.
    expect(text).not.toMatch(/Above the 30% line/);
  });

  test("above the threshold the receipt says compression is not paying for itself", () => {
    const text = formatReport(baseReport(), "1.0.200", null, {
      conversation: baseConversation(),
      realBytes: {
        conversation: realBytesWith({
          returnedReads: 6,
          coveredSources: 10,
          returnedSources: 5,
          returnedBytes: 500_000,
          returnedTokens: Math.round(tokensFromBytes(500_000)),
          ratio: 0.5,
          enabled: true,
        }, 500_000),
      },
      ...OPTS,
    });

    expect(text).toMatch(/50% of the 10 compressed/);
    expect(text).toMatch(/Above the 30% line/);
    expect(text).toMatch(/hand back full text/);
  });

  test("the printed line follows CONTEXT_MODE_REUSE_THRESHOLD", () => {
    process.env.CONTEXT_MODE_REUSE_THRESHOLD = "60";
    const text = formatReport(baseReport(), "1.0.200", null, {
      conversation: baseConversation(),
      realBytes: {
        conversation: realBytesWith({
          returnedReads: 6,
          coveredSources: 10,
          returnedSources: 5,
          returnedBytes: 500_000,
          returnedTokens: Math.round(tokensFromBytes(500_000)),
          ratio: 0.5,
          enabled: true,
        }, 500_000),
      },
      ...OPTS,
    });
    expect(text).toMatch(/Went back to the source/);
    expect(text).not.toMatch(/Above the \d+% line/);
  });

  test("a clean session prints no returns block at all", () => {
    const text = formatReport(baseReport(), "1.0.200", null, {
      conversation: baseConversation(),
      realBytes: {
        conversation: realBytesWith({
          returnedReads: 0,
          coveredSources: 8,
          returnedSources: 0,
          returnedBytes: 0,
          returnedTokens: 0,
          ratio: 0,
          enabled: true,
        }, 0),
      },
      ...OPTS,
    });
    expect(text).not.toMatch(/Went back to the source/);
  });

  test("no reuse data at all (detector off, legacy fixture) renders unchanged", () => {
    const text = formatReport(baseReport(), "1.0.200", null, {
      conversation: baseConversation(),
      realBytes: { conversation: realBytesWith(undefined, 0) },
      ...OPTS,
    });
    expect(text).not.toMatch(/Went back to the source/);
    expect(text).toMatch(/The scope, getting wider/);
  });
});
