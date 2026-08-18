/**
 * C-02 — the hook→server bridge for the reuse verdict.
 *
 * The detector's input (the session event stream) only exists on the hook
 * side; the gateway that must act on the verdict lives in the MCP server
 * process. So the verdict travels the way the retrieval byte count already
 * travels — a tmp file keyed by the session DB basename — with two deliberate
 * differences, both asserted here:
 *
 *   - it is OVERWRITTEN, not appended: the gateway wants the current ratio,
 *     and stale ones must not pile up;
 *   - it is read WITHOUT being consumed: the gateway consults it on every
 *     retrieval, and a consume-once read would let the bypass fire exactly
 *     once and then forget.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { SessionDB } from "../../src/session/db.js";
import { persistReuseVerdict } from "../../src/session/persist-tool-calls.js";
import {
  clearReuseVerdict,
  readReuseVerdict,
  reuseMarkerPath,
  retrievalMarkerPath,
  writeReuseVerdict,
} from "../../src/session/retrieval-marker.js";
import { shouldBypassCompression } from "../../src/session/reuse-detector.js";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const fn of cleanups) { try { fn(); } catch { /* ignore */ } }
});
afterEach(() => {
  delete process.env.CONTEXT_MODE_REUSE_DETECT;
});

const PROJECT = "/home/dev/proj";

function mkDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
  return dir;
}

describe("reuse verdict marker", () => {
  test("marker path is keyed by the session DB basename and distinct from the retrieval marker", () => {
    const tmp = mkDir("reuse-marker-");
    const db = "/some/where/deadbeefdeadbeef__suffix.db";
    expect(reuseMarkerPath(db, tmp)).toBe(join(tmp, "context-mode-reuse-deadbeefdeadbeef__suffix.db.json"));
    expect(reuseMarkerPath(db, tmp)).not.toBe(retrievalMarkerPath(db, tmp));
  });

  test("write → read round-trips, and read does NOT consume", () => {
    const tmp = mkDir("reuse-marker-");
    const db = join(tmp, "abc__s.db");

    writeReuseVerdict(db, { covered: 10, returned: 4, ratio: 0.4 }, tmp);
    const first = readReuseVerdict(db, tmp);
    expect(first).not.toBeNull();
    expect(first!.covered).toBe(10);
    expect(first!.returned).toBe(4);
    expect(first!.ratio).toBeCloseTo(0.4);
    expect(first!.at).toBeGreaterThan(0);

    // Still there — the gateway reads it on every retrieval.
    expect(readReuseVerdict(db, tmp)).not.toBeNull();
    expect(existsSync(reuseMarkerPath(db, tmp))).toBe(true);
  });

  test("a second write overwrites rather than accumulating", () => {
    const tmp = mkDir("reuse-marker-");
    const db = join(tmp, "abc__s.db");
    writeReuseVerdict(db, { covered: 10, returned: 9, ratio: 0.9 }, tmp);
    writeReuseVerdict(db, { covered: 20, returned: 2, ratio: 0.1 }, tmp);
    const v = readReuseVerdict(db, tmp);
    expect(v!.covered).toBe(20);
    expect(v!.ratio).toBeCloseTo(0.1);
  });

  test("a missing verdict reads as null — no verdict means no bypass", () => {
    const tmp = mkDir("reuse-marker-");
    const db = join(tmp, "never-written__s.db");
    expect(readReuseVerdict(db, tmp)).toBeNull();
    expect(shouldBypassCompression({ stats: null })).toBe(false);
  });

  test("clear removes it", () => {
    const tmp = mkDir("reuse-marker-");
    const db = join(tmp, "abc__s.db");
    writeReuseVerdict(db, { covered: 5, returned: 5, ratio: 1 }, tmp);
    clearReuseVerdict(db, tmp);
    expect(readReuseVerdict(db, tmp)).toBeNull();
  });

  test("a corrupt marker reads as null instead of throwing", () => {
    const tmp = mkDir("reuse-marker-");
    const db = join(tmp, "abc__s.db");
    // Write garbage through the marker path itself.
    writeFileSync(reuseMarkerPath(db, tmp), "{not json");
    expect(readReuseVerdict(db, tmp)).toBeNull();
  });
});

describe("persistReuseVerdict — hook-side publisher", () => {
  function seedSession(dbPath: string, sessionId: string): void {
    const sdb = new SessionDB({ dbPath });
    try {
      sdb.ensureSession(sessionId, PROJECT);
      const push = (type: string, category: string, data: string) => {
        sdb.insertEvent(
          sessionId,
          {
            type, category, priority: 1, data,
            project_dir: PROJECT, attribution_source: "test", attribution_confidence: 1,
          },
          "test",
          { projectDir: PROJECT },
        );
      };
      const cover = (path: string) => push(
        "mcp_tool_call",
        "mcp_tool_call",
        JSON.stringify({
          tool_name: "mcp__plugin_context-mode_context-mode__ctx_execute_file",
          params: { path, language: "javascript" },
        }),
      );
      cover("src/a.ts");
      cover("src/b.ts");
      cover("src/c.ts");
      cover("src/d.ts");
      // Went back to two of the four.
      push("file_read", "file", `${PROJECT}/src/a.ts`);
      push("file_read", "file", `${PROJECT}/src/b.ts`);
    } finally {
      sdb.close();
    }
  }

  test("publishes a verdict the bypass policy can act on", () => {
    const tmp = mkDir("reuse-persist-");
    const dbPath = join(tmp, "feedfacefeedface__s.db");
    seedSession(dbPath, `sess-${randomUUID()}`);

    const verdict = persistReuseVerdict(dbPath, { tmpDir: tmp });
    expect(verdict).not.toBeNull();
    expect(verdict!.covered).toBe(4);
    expect(verdict!.returned).toBe(2);
    expect(verdict!.ratio).toBeCloseTo(0.5);

    // The gateway's view, straight off disk.
    const onDisk = readReuseVerdict(dbPath, tmp);
    expect(shouldBypassCompression({
      covered: onDisk!.covered,
      returned: onDisk!.returned,
    })).toBe(true);
  });

  test("publishes nothing when the detector is switched off", () => {
    const tmp = mkDir("reuse-persist-");
    const dbPath = join(tmp, "cafebabecafebabe__s.db");
    seedSession(dbPath, `sess-${randomUUID()}`);

    process.env.CONTEXT_MODE_REUSE_DETECT = "0";
    expect(persistReuseVerdict(dbPath, { tmpDir: tmp })).toBeNull();
    expect(readReuseVerdict(dbPath, tmp)).toBeNull();
  });

  test("a missing DB is a no-op, not a throw", () => {
    const tmp = mkDir("reuse-persist-");
    expect(persistReuseVerdict(join(tmp, "nope__s.db"), { tmpDir: tmp })).toBeNull();
  });

  test("a session with no retrieval publishes nothing to bypass on", () => {
    const tmp = mkDir("reuse-persist-");
    const dbPath = join(tmp, "0123456789abcdef__s.db");
    const sdb = new SessionDB({ dbPath });
    try {
      const sid = `sess-${randomUUID()}`;
      sdb.ensureSession(sid, PROJECT);
      sdb.insertEvent(sid, {
        type: "file_read", category: "file", priority: 1, data: `${PROJECT}/src/a.ts`,
        project_dir: PROJECT, attribution_source: "test", attribution_confidence: 1,
      }, "test", { projectDir: PROJECT });
    } finally {
      sdb.close();
    }
    expect(persistReuseVerdict(dbPath, { tmpDir: tmp })).toBeNull();
  });
});
