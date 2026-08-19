/**
 * D2 PRD Phase 4 — webfetch-redirected marker pattern (slices 4.1–4.3).
 *
 * Mirrors the Bash redirect marker tests but for the WebFetch deny path
 * in routing.mjs. Default bytes_avoided = 16384 (typical web page body).
 *
 * A refusal is the one decision that has no PostToolUse of its own — the call
 * never runs — so since v1.0.173 its marker is filed under the target rather
 * than under a call key, and the next PostToolUse sweeps it up once it is old
 * enough (`sweepAfterMs`, 2 s) that no call can still be in flight for it.
 * That delay is what these tests have to reproduce, and they do it by aging
 * the file rather than by sleeping through it.
 */

import { describe, test, beforeAll, beforeEach, afterAll, afterEach, expect } from "vitest";
import { strict as assert } from "node:assert";
import {
  writeFileSync, readFileSync, existsSync, unlinkSync, mkdtempSync, rmSync, mkdirSync, utimesSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import { loadDatabase } from "../../src/db-base.js";
import { redirectMarkerPathFor, resetGuidanceThrottle } from "../../hooks/core/routing.mjs";


const _hashCanonical = (p: string) => createHash("sha256").update(
  (process.platform === "darwin" || process.platform === "win32") ? p.toLowerCase() : p
).digest("hex").slice(0, 16);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRETOOL_PATH = join(__dirname, "..", "..", "hooks", "pretooluse.mjs");
const POSTTOOL_PATH = join(__dirname, "..", "..", "hooks", "posttooluse.mjs");

interface RawEventRow {
  type: string;
  category: string;
  bytes_avoided: number;
  bytes_returned: number;
  data: string;
}

function readEvents(dbPath: string, sessionId: string, type: string): RawEventRow[] {
  // The store is created by the first PostToolUse, and several cases here read
  // a baseline before any hook has run — no file yet means no events yet.
  if (!existsSync(dbPath)) return [];
  const Database = loadDatabase();
  const raw = new Database(dbPath, { readonly: true });
  try {
    return raw
      .prepare(
        "SELECT type, category, bytes_avoided, bytes_returned, data FROM session_events " +
        "WHERE session_id = ? AND type = ?",
      )
      .all(sessionId, type) as RawEventRow[];
  } finally {
    raw.close();
  }
}

/**
 * Backdate a marker so the next PostToolUse treats it as settled.
 *
 * The sweep is keyed on the file's age, so moving the mtime is the same
 * observation as waiting — two seconds cheaper per case, and not flaky under
 * a loaded CI box the way a 2 s sleep with a 2 s threshold would be.
 */
function ageMarker(path: string, ms = 10_000): void {
  const past = new Date(Date.now() - ms);
  utimesSync(path, past, past);
}

const mcpSentinelDir = process.platform === "win32" ? tmpdir() : "/tmp";
const mcpSentinel = resolve(mcpSentinelDir, `context-mode-mcp-ready-${process.pid}`);

describe("D2 Phase 4 — webfetch-redirected marker pattern", () => {
  let fakeHome: string;
  let fakeProject: string;
  let env: Record<string, string>;
  const sessionId = "redirect-webfetch-test-session";
  let dbPath: string;

  beforeAll(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "ctx-redirect-wf-home-"));
    fakeProject = mkdtempSync(join(tmpdir(), "ctx-redirect-wf-project-"));
    env = {
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      CLAUDE_CONFIG_DIR: join(fakeHome, ".claude"),
      CLAUDE_PROJECT_DIR: fakeProject,
      CLAUDE_SESSION_ID: sessionId,
      CONTEXT_MODE_SESSION_SUFFIX: "",
    };
    // Hooks hash the path AFTER normalizeWorktreePath() (\ → /), so the test
    // must apply the same normalization before SHA — otherwise on Windows the
    // expected hash uses backslashes while the hook uses slashes (#435 pattern).
    const projectHash = _hashCanonical(fakeProject.replace(/\\/g, "/"));
    const dbDir = join(fakeHome, ".claude", "context-mode", "sessions");
    mkdirSync(dbDir, { recursive: true });
    dbPath = join(dbDir, `${projectHash}.db`);
  });

  afterAll(() => {
    try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
    try { rmSync(fakeProject, { recursive: true, force: true }); } catch {}
  });

  beforeEach(() => {
    writeFileSync(mcpSentinel, String(process.pid));
    // The session id is fixed, so a refusal left on disk by a previous RUN of
    // this suite would be swept into the current one's accounting. Clearing
    // the whole marker directory is the only reliable reset.
    resetGuidanceThrottle(sessionId);
  });

  afterEach(() => {
    try { unlinkSync(mcpSentinel); } catch {}
  });

  type Payload = Record<string, unknown>;

  function fetchPayload(url: string, toolUseId: string): Payload {
    return {
      session_id: sessionId,
      tool_use_id: toolUseId,
      tool_name: "WebFetch",
      tool_input: { url, prompt: "summarize" },
    };
  }

  /** Where the refusal for this URL is filed — by target, not by call. */
  function denyMarkerFor(url: string): string {
    return redirectMarkerPathFor(sessionId, { denied: true, denyPath: url });
  }

  function runHook(hookPath: string, payload: Payload) {
    return spawnSync("node", [hookPath], {
      input: JSON.stringify(payload),
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env, ...env },
    });
  }

  const runPre = (payload: Payload) => runHook(PRETOOL_PATH, payload);

  /** Some later call, which is what a refusal has to depend on to be counted. */
  function runNextPost(toolUseId: string) {
    return runHook(POSTTOOL_PATH, {
      session_id: sessionId,
      tool_use_id: toolUseId,
      tool_name: "Bash",
      tool_input: { command: "echo next" },
      tool_response: "next",
    });
  }

  // ─── Slice 4.1 ───────────────────────────────────────────
  test("4.1: PreToolUse writes redirect marker on WebFetch", () => {
    const url = "https://docs.example.com/long-page";
    const r = runPre(fetchPayload(url, "call-4-1"));
    assert.equal(r.status, 0, `pretooluse non-zero. stderr: ${r.stderr}`);

    const markerPath = denyMarkerFor(url);
    assert.ok(existsSync(markerPath), "marker file must be written");
    const content = readFileSync(markerPath, "utf-8");
    expect(content.startsWith("WebFetch:webfetch-redirected:16384:")).toBe(true);
    expect(content).toContain("https://docs.example.com");
  });

  // ─── Slice 4.2 ───────────────────────────────────────────
  test("4.2: a settled refusal is swept into one webfetch-redirected event", () => {
    const url = "https://example.com/article";
    runPre(fetchPayload(url, "call-4-2"));
    const markerPath = denyMarkerFor(url);
    const before = readEvents(dbPath, sessionId, "webfetch-redirected").length;

    // Too fresh to sweep: a marker seconds old may still belong to a call the
    // host has not finished dispatching, and charging it now would race.
    runNextPost("call-4-2-early");
    assert.ok(existsSync(markerPath), "a fresh refusal must survive the first sweep");
    expect(readEvents(dbPath, sessionId, "webfetch-redirected").length).toBe(before);

    ageMarker(markerPath);
    const post = runNextPost("call-4-2-late");
    assert.equal(post.status, 0, `posttooluse non-zero. stderr: ${post.stderr}`);
    assert.ok(!existsSync(markerPath), "a settled refusal must be consumed, not left to re-charge");

    const rows = readEvents(dbPath, sessionId, "webfetch-redirected").slice(before);
    expect(rows.length).toBe(1);
    expect(rows[0].category).toBe("redirect");
    expect(rows[0].bytes_avoided).toBe(16384);
    expect(rows[0].bytes_returned).toBe(0);
    expect(rows[0].data).toContain("WebFetch:");

    // Consume-once: every later call in the session must not re-book the same
    // refusal. This is the whole reason the sweep deletes as it reads.
    runNextPost("call-4-2-again");
    expect(readEvents(dbPath, sessionId, "webfetch-redirected").length).toBe(before + 1);
  });

  // ─── Slice 4.3 ───────────────────────────────────────────
  test("4.3: long URL truncated to 200 chars in marker", () => {
    const longUrl = "https://example.com/" + "a".repeat(500);
    runPre(fetchPayload(longUrl, "call-4-3"));
    // The refusal is filed under the summary it recorded, which is already
    // truncated — so asking for the truncated path is itself the assertion
    // that writer and reader agree on the same 200 chars.
    const content = readFileSync(denyMarkerFor(longUrl.slice(0, 200)), "utf-8");
    const i1 = content.indexOf(":");
    const i2 = content.indexOf(":", i1 + 1);
    const i3 = content.indexOf(":", i2 + 1);
    const summary = content.slice(i3 + 1);
    expect(summary.length).toBeLessThanOrEqual(200);
    expect(summary.length).toBeGreaterThan(0);
  });
});
