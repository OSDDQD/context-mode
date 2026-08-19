/**
 * D2 PRD Phase 3 — bash-redirected marker pattern (slices 3.1–3.5).
 *
 * Slice 3.1: PreToolUse writes the redirect marker file when a curl/wget
 *            command is intercepted.
 * Slice 3.2: PostToolUse reads the marker, emits a `category=redirect,
 *            type=bash-redirected, bytes_avoided=8192` event, and unlinks.
 * Slice 3.3: the marker belongs to ONE call — a concurrent call's PostToolUse
 *            cannot take it, and the owner takes it exactly once.
 * Slice 3.4: when no marker is present, no phantom event is emitted.
 * Slice 3.5: long curl/wget commands are truncated to 200 chars in the marker.
 *
 * Since v1.0.173 the markers live one-file-per-call under a per-session
 * directory, so nothing here spells a path itself: `callKeyFor` is fed the
 * SAME payload the hook is fed on stdin, and `redirectMarkerPathFor` turns
 * that key into the path. A test that hard-codes the filename is a test that
 * agrees with yesterday's layout rather than with the hook.
 */

import { describe, test, beforeAll, beforeEach, afterAll, afterEach, expect } from "vitest";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import { SessionDB } from "../../src/session/db.js";
import { loadDatabase } from "../../src/db-base.js";
import { callKeyFor, redirectMarkerPathFor, resetGuidanceThrottle } from "../../hooks/core/routing.mjs";


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

// MCP readiness sentinel — hooks check /tmp on Unix, tmpdir() on Windows.
// Without it, mcpRedirect() returns null (passthrough) and no marker is written.
const mcpSentinelDir = process.platform === "win32" ? tmpdir() : "/tmp";
const mcpSentinel = resolve(mcpSentinelDir, `context-mode-mcp-ready-${process.pid}`);

describe("D2 Phase 3 — bash-redirected marker pattern", () => {
  let fakeHome: string;
  let fakeProject: string;
  let env: Record<string, string>;
  const sessionId = "redirect-bash-test-session";
  let dbPath: string;

  beforeAll(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "ctx-redirect-bash-home-"));
    fakeProject = mkdtempSync(join(tmpdir(), "ctx-redirect-bash-project-"));
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
    // The session id is fixed, so markers left behind by a previous RUN of the
    // suite would otherwise be swept into this one's accounting. This clears
    // the whole per-session marker directory, not one filename.
    resetGuidanceThrottle(sessionId);
  });

  afterEach(() => {
    try { unlinkSync(mcpSentinel); } catch {}
  });

  type Payload = Record<string, unknown>;

  /**
   * One payload, used for both the hook's stdin and the call key.
   *
   * `tool_use_id` is what the host itself supplies on both PreToolUse and
   * PostToolUse, and it is the only handle that survives a rewrite: the curl
   * branch replaces the command, so PostToolUse sees different `tool_input`
   * for the same call.
   */
  function bashPre(command: string, toolUseId: string): Payload {
    return {
      session_id: sessionId,
      tool_use_id: toolUseId,
      tool_name: "Bash",
      tool_input: { command },
    };
  }

  function bashPost(command: string, toolUseId: string, response = "ok"): Payload {
    return {
      session_id: sessionId,
      tool_use_id: toolUseId,
      tool_name: "Bash",
      tool_input: { command },
      tool_response: response,
    };
  }

  function markerFor(payload: Payload): string {
    return redirectMarkerPathFor(sessionId, { callKey: callKeyFor(payload) });
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
  const runPost = (payload: Payload) => runHook(POSTTOOL_PATH, payload);

  // ─── Slice 3.1 ───────────────────────────────────────────
  test("3.1: PreToolUse writes redirect marker on curl", () => {
    const pre = bashPre("curl https://api.example.com/data.json", "call-3-1");
    const r = runPre(pre);
    assert.equal(r.status, 0, `pretooluse non-zero. stderr: ${r.stderr}`);

    const markerPath = markerFor(pre);
    assert.ok(existsSync(markerPath), "marker file must be written");
    const content = readFileSync(markerPath, "utf-8");
    expect(content.startsWith("Bash:bash-redirected:8192:")).toBe(true);
    expect(content).toContain("curl https://api.example.com");
  });

  // ─── Slice 3.2 ───────────────────────────────────────────
  test("3.2: PostToolUse reads marker + emits redirect event with bytes_avoided=8192", () => {
    const pre = bashPre("curl https://example.com/secret", "call-3-2");
    runPre(pre);
    // The command the host actually runs is the rewritten one; the id is what
    // ties it back to the decision that rewrote it.
    const post = runPost(bashPost("echo blocked", "call-3-2"));
    assert.equal(post.status, 0, `posttooluse non-zero. stderr: ${post.stderr}`);

    const rows = readEvents(dbPath, sessionId, "bash-redirected");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].category).toBe("redirect");
    expect(rows[0].bytes_avoided).toBe(8192);
    expect(rows[0].bytes_returned).toBe(0);
    expect(rows[0].data).toContain("Bash:");
  });

  // ─── Slice 3.3 ───────────────────────────────────────────
  test("3.3: the marker is this call's alone, and is spent exactly once", () => {
    const pre = bashPre("curl https://example.com", "call-3-3");
    runPre(pre);
    const markerPath = markerFor(pre);
    assert.ok(existsSync(markerPath), "marker should exist before PostToolUse");

    // Somebody else's PostToolUse. Under the single-cell layout it would have
    // walked off with this marker and booked 8 KB against the wrong call.
    const before = readEvents(dbPath, sessionId, "bash-redirected").length;
    runPost({
      session_id: sessionId,
      tool_use_id: "call-3-3-unrelated",
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/x.ts", old_string: "a", new_string: "b" },
      tool_response: "ok",
    });
    assert.ok(existsSync(markerPath), "an unrelated call must not consume this marker");
    expect(readEvents(dbPath, sessionId, "bash-redirected").length).toBe(before);

    // The owner takes it, and it is gone.
    runPost(bashPost("echo blocked", "call-3-3"));
    assert.ok(!existsSync(markerPath), "marker must be deleted after its own PostToolUse");
    const afterOwner = readEvents(dbPath, sessionId, "bash-redirected").length;
    expect(afterOwner).toBe(before + 1);

    // A repeat of the same PostToolUse (a retried hook, a duplicated event)
    // finds nothing left to charge.
    runPost(bashPost("echo blocked", "call-3-3"));
    expect(readEvents(dbPath, sessionId, "bash-redirected").length).toBe(afterOwner);
  });

  // ─── Slice 3.4 ───────────────────────────────────────────
  test("3.4: no marker → no phantom redirect event", () => {
    // No PreToolUse → no marker.
    const before = readEvents(dbPath, sessionId, "bash-redirected").length;
    runPost({
      session_id: sessionId,
      tool_use_id: "call-3-4",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/whatever.ts" },
      tool_response: "ok",
    });
    const after = readEvents(dbPath, sessionId, "bash-redirected").length;
    expect(after).toBe(before);
  });

  // ─── Slice 3.5 ───────────────────────────────────────────
  test("3.5: long command summary truncated to 200 chars in marker", () => {
    const longCmd = "curl " + "https://example.com/" + "a".repeat(500);
    const pre = bashPre(longCmd, "call-3-5");
    runPre(pre);
    const content = readFileSync(markerFor(pre), "utf-8");
    // Format: tool:type:bytes:summary — extract everything after the 3rd colon.
    const i1 = content.indexOf(":");
    const i2 = content.indexOf(":", i1 + 1);
    const i3 = content.indexOf(":", i2 + 1);
    const summary = content.slice(i3 + 1);
    expect(summary.length).toBeLessThanOrEqual(200);
    expect(summary.length).toBeGreaterThan(0);
  });

  // ─── Two calls in flight at once ─────────────────────────
  test("concurrent calls each keep their own marker and their own accounting", () => {
    // The reason the markers moved to one file per call. Two curls are
    // intercepted before either finishes; each PostToolUse must charge its own
    // URL, and neither may consume the other's marker.
    const preA = bashPre("curl https://a.example.com/one", "call-par-a");
    const preB = bashPre("curl https://b.example.com/two", "call-par-b");
    runPre(preA);
    runPre(preB);

    const markerA = markerFor(preA);
    const markerB = markerFor(preB);
    assert.ok(existsSync(markerA) && existsSync(markerB), "both markers must coexist");
    expect(markerA).not.toBe(markerB);

    const before = readEvents(dbPath, sessionId, "bash-redirected").length;

    runPost(bashPost("echo a", "call-par-a"));
    assert.ok(!existsSync(markerA), "A's marker was not consumed by A");
    assert.ok(existsSync(markerB), "A's PostToolUse consumed B's marker");

    runPost(bashPost("echo b", "call-par-b"));
    assert.ok(!existsSync(markerB), "B's marker was not consumed by B");

    const rows = readEvents(dbPath, sessionId, "bash-redirected").slice(before);
    expect(rows.length).toBe(2);
    expect(rows.map(r => r.data).join("\n")).toContain("https://a.example.com/one");
    expect(rows.map(r => r.data).join("\n")).toContain("https://b.example.com/two");
    for (const row of rows) expect(row.bytes_avoided).toBe(8192);
  });
});
