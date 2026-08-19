/**
 * D2 PRD Phase 4 — read-redirected marker pattern (slices 4.4–4.6).
 *
 * Slice 4.4: a Read against a >50 KB file produces a redirect marker.
 * Slice 4.5: PostToolUse emits `read-redirected` with bytes_avoided = actual file size.
 * Slice 4.6: small files (<= 50 KB) do NOT trigger a redirect marker.
 *
 * A refused Read has no PostToolUse of its own, so since v1.0.173 its marker
 * is filed under the path it refused and swept by the next PostToolUse once it
 * is old enough to be certain no call is still in flight for it. The last case
 * covers the other end of the same promise: when the caller takes the escape
 * hatch and repeats the Read, the bytes DO enter the conversation, so the
 * pending refusal must be cancelled rather than swept as a saving.
 */

import { describe, test, beforeAll, beforeEach, afterAll, afterEach, expect } from "vitest";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  unlinkSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  utimesSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

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
  // The store is created by the first PostToolUse; a case that reads a
  // baseline before any hook has run sees no file, which is no events.
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
 * The sweep is keyed on the file's age, so moving the mtime observes the same
 * thing as waiting the 2 s out — without spending it, and without the flake a
 * 2 s sleep against a 2 s threshold invites on a loaded machine.
 */
function ageMarker(path: string, ms = 10_000): void {
  const past = new Date(Date.now() - ms);
  utimesSync(path, past, past);
}

const mcpSentinelDir = process.platform === "win32" ? tmpdir() : "/tmp";
const mcpSentinel = resolve(mcpSentinelDir, `context-mode-mcp-ready-${process.pid}`);

describe("D2 Phase 4 — read-redirected marker pattern", () => {
  let fakeHome: string;
  let fakeProject: string;
  let env: Record<string, string>;
  const sessionId = "redirect-read-test-session";
  let dbPath: string;
  let largeFilePath: string;
  let smallFilePath: string;
  let retryFilePath: string;
  const LARGE_SIZE = 80_000;

  beforeAll(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "ctx-redirect-read-home-"));
    fakeProject = mkdtempSync(join(tmpdir(), "ctx-redirect-read-project-"));
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

    largeFilePath = join(fakeProject, "big.txt");
    writeFileSync(largeFilePath, "x".repeat(LARGE_SIZE), "utf-8");
    smallFilePath = join(fakeProject, "small.txt");
    writeFileSync(smallFilePath, "tiny", "utf-8");
    retryFilePath = join(fakeProject, "edit-me.txt");
    writeFileSync(retryFilePath, "x".repeat(LARGE_SIZE), "utf-8");
  });

  afterAll(() => {
    try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
    try { rmSync(fakeProject, { recursive: true, force: true }); } catch {}
  });

  beforeEach(() => {
    writeFileSync(mcpSentinel, String(process.pid));
    // Each case must start from a session that has not yet been refused
    // anything: a refusal arms the read-before-edit retry window for that
    // path, and the next read of it is then a promised repeat rather than a
    // fresh large read. Without this, 4.4 arms the window and 4.5 measures the
    // wrong branch. It also drops markers left by a previous RUN — the session
    // id is fixed, so those would be swept into this run's accounting.
    resetGuidanceThrottle(sessionId);
  });

  afterEach(() => {
    try { unlinkSync(mcpSentinel); } catch {}
  });

  type Payload = Record<string, unknown>;

  function readPayload(filePath: string, toolUseId: string): Payload {
    return {
      session_id: sessionId,
      tool_use_id: toolUseId,
      tool_name: "Read",
      tool_input: { file_path: filePath },
    };
  }

  /** Where a refusal for this path is filed — by target, not by call. */
  const denyMarkerFor = (filePath: string) =>
    redirectMarkerPathFor(sessionId, { denied: true, denyPath: filePath });

  /** Where a call that will get its own PostToolUse files its marker. */
  const ownMarkerFor = (payload: Payload) =>
    redirectMarkerPathFor(sessionId, { callKey: callKeyFor(payload) });

  const markerDir = () => dirname(redirectMarkerPathFor(sessionId, { callKey: "probe" }));

  /** Settle everything still pending, so a sweep cannot be blamed on timing. */
  function ageAllMarkers(): void {
    try {
      for (const name of readdirSync(markerDir())) ageMarker(join(markerDir(), name));
    } catch { /* no directory — nothing pending, which is the point */ }
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
  const runPost = (payload: Payload, response: string) =>
    runHook(POSTTOOL_PATH, { ...payload, tool_response: response });

  /** Some later call — what a refusal depends on to ever be counted. */
  const runNextPost = (toolUseId: string) => runHook(POSTTOOL_PATH, {
    session_id: sessionId,
    tool_use_id: toolUseId,
    tool_name: "Bash",
    tool_input: { command: "echo next" },
    tool_response: "next",
  });

  // ─── Slice 4.4 ───────────────────────────────────────────
  test("4.4: Read on large file (>50KB) writes redirect marker", () => {
    const r = runPre(readPayload(largeFilePath, "call-4-4"));
    assert.equal(r.status, 0, `pretooluse non-zero. stderr: ${r.stderr}`);
    const markerPath = denyMarkerFor(largeFilePath);
    assert.ok(existsSync(markerPath), "marker file must be written for large reads");
    const content = readFileSync(markerPath, "utf-8");
    expect(content.startsWith(`Read:read-redirected:${LARGE_SIZE}:`)).toBe(true);
  });

  // ─── Slice 4.5 ───────────────────────────────────────────
  test("4.5: a settled refusal emits read-redirected with bytes_avoided == file size", () => {
    runPre(readPayload(largeFilePath, "call-4-5"));
    const markerPath = denyMarkerFor(largeFilePath);
    const before = readEvents(dbPath, sessionId, "read-redirected").length;

    // Nothing yet: the refusal is seconds old and the sweep waits until no
    // call could still be in flight for it.
    runNextPost("call-4-5-early");
    assert.ok(existsSync(markerPath), "a fresh refusal must survive the first sweep");
    expect(readEvents(dbPath, sessionId, "read-redirected").length).toBe(before);

    ageMarker(markerPath);
    const post = runNextPost("call-4-5-late");
    assert.equal(post.status, 0, `posttooluse non-zero. stderr: ${post.stderr}`);

    const rows = readEvents(dbPath, sessionId, "read-redirected").slice(before);
    expect(rows.length).toBe(1);
    expect(rows[0].category).toBe("redirect");
    expect(rows[0].bytes_avoided).toBe(LARGE_SIZE);
    expect(rows[0].bytes_returned).toBe(0);

    // Once, not once per later call — the sweep deletes as it reads.
    runNextPost("call-4-5-again");
    expect(readEvents(dbPath, sessionId, "read-redirected").length).toBe(before + 1);
  });

  // ─── Slice 4.6 ───────────────────────────────────────────
  test("4.6: Read on small file (<=50KB) does NOT write redirect marker", () => {
    const payload = readPayload(smallFilePath, "call-4-6");
    runPre(payload);
    assert.ok(!existsSync(denyMarkerFor(smallFilePath)), "no refusal for small file reads");
    assert.ok(!existsSync(ownMarkerFor(payload)), "no accounting marker for small file reads");
  });

  // ─── The escape hatch: refused, then repeated ────────────
  test("a promised repeat cancels the refusal instead of banking it", () => {
    // The refusal's own text offers the repeat, and the repeat puts the file
    // into the conversation — so the saving the refusal recorded never
    // happened. If the marker were left for the sweep, ctx_stats would claim
    // the bytes as avoided while the model was reading them.
    const refused = readPayload(retryFilePath, "call-retry-1");
    runPre(refused);
    const denyMarker = denyMarkerFor(retryFilePath);
    assert.ok(existsSync(denyMarker), "the first read must be refused");

    const repeat = readPayload(retryFilePath, "call-retry-2");
    const r = runPre(repeat);
    expect(r.stdout ?? "", "the promised repeat must go through").not.toContain("\"deny\"");
    assert.ok(!existsSync(denyMarker), "the refusal must be cancelled once the bytes arrive");

    // What the repeat leaves instead: "already accounted for", zero saved.
    const own = ownMarkerFor(repeat);
    assert.ok(existsSync(own), "the repeat wrote no accounted-for marker");
    expect(readFileSync(own, "utf-8").startsWith("Read:read-edit-exempt:0:")).toBe(true);

    runPost(repeat, "x".repeat(LARGE_SIZE));
    // And no sweep can resurrect it afterwards, however old the directory gets.
    ageAllMarkers();
    runNextPost("call-retry-sweep");

    const banked = readEvents(dbPath, sessionId, "read-redirected")
      .filter(row => row.data.includes(retryFilePath));
    expect(banked, "a cancelled refusal must never reach the savings").toHaveLength(0);
  });
});
