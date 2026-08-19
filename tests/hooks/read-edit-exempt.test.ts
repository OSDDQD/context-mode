/**
 * Taking the escape hatch must never count as a violation.
 *
 * The large-file refusal ends with a promise: "reading it in order to EDIT it?
 * Call Read again on this same path — the repeat is allowed." The repeat is an
 * ordinary allowed Read, so PostToolUse used to see a heavy native call with
 * no redirect marker and record a fresh violation. That single missing marker
 * closed a loop:
 *
 *   refusal → the caller does what the refusal said → counted as a violation
 *   → tally grows → cost line fires → adherence denominator gains one
 *   → escalation climbs a step → the next refusal is harsher
 *
 * Each use of the way out made the next one more expensive, and the target was
 * read-before-edit — the main job, not an edge case. The window is 2 KB to
 * 50 KB wide by default: above 50 KB the retry carried an accounting marker by
 * accident, below 2 KB nothing is counted at all, and between them the loop
 * ran. That band is where these tests live.
 *
 * They drive the real hooks as subprocesses, because the bug was in the
 * handoff between them: PreToolUse decides, writes a marker, exits; PostToolUse
 * reads the marker in a different process and decides whether anything was
 * violated. An in-process test of either half would have shown nothing wrong.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  resetGuidanceThrottle,
  readUnroutedTally,
  escalationLevel,
  callKeyFor,
  redirectMarkerPathFor,
} from "../../hooks/core/routing.mjs";

const REPO_ROOT = resolve(__dirname, "..", "..");
const PRETOOL = join(REPO_ROOT, "hooks", "pretooluse.mjs");
const POSTTOOL = join(REPO_ROOT, "hooks", "posttooluse.mjs");

/** Inside the band the loop ran in: over the collection floor, under 50 KB. */
const MID_SIZE = 20_000;

let home: string;
let project: string;
let sessionId: string;
let env: NodeJS.ProcessEnv;
let sentinelDir: string;
let sentinel: string;
let counter = 0;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ctx-exempt-home-"));
  project = mkdtempSync(join(tmpdir(), "ctx-exempt-project-"));
  sessionId = `exempt-${process.pid}-${++counter}`;
  sentinelDir = mkdtempSync(join(tmpdir(), "ctx-exempt-sentinel-"));
  sentinel = resolve(sentinelDir, `context-mode-mcp-ready-${process.pid}`);
  writeFileSync(sentinel, String(process.pid));
  resetGuidanceThrottle(sessionId);
  env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CLAUDE_PROJECT_DIR: project,
    CLAUDE_SESSION_ID: sessionId,
    CONTEXT_MODE_SESSION_SUFFIX: "",
    CONTEXT_MODE_MCP_SENTINEL_DIR: sentinelDir,
  };
});

afterEach(() => {
  // resetGuidanceThrottle clears the session's whole marker directory, which
  // is where refusals and accounted-for calls both live since v1.0.173.
  resetGuidanceThrottle(sessionId);
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  rmSync(sentinelDir, { recursive: true, force: true });
});

interface HookRun {
  status: number;
  stdout: string;
  stderr: string;
}

function run(hook: string, payload: Record<string, unknown>): HookRun {
  const r = spawnSync("node", [hook], {
    input: JSON.stringify({ session_id: sessionId, cwd: project, ...payload }),
    encoding: "utf-8",
    timeout: 60_000,
    env,
  });
  return { status: r.status ?? 1, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

/** The payload a Read of this path arrives as — the hook's stdin and the
 *  input the call key is derived from are the same object by construction. */
function readPayload(filePath: string): Record<string, unknown> {
  return { tool_name: "Read", tool_input: { file_path: filePath } };
}

/** Where this call files a marker it expects to collect itself. */
function ownMarkerFor(filePath: string): string {
  return redirectMarkerPathFor(sessionId, { callKey: callKeyFor(readPayload(filePath)) });
}

/** Where a refusal for this path is filed — by target, since a refused call
 *  never reaches PostToolUse to claim a key of its own. */
function denyMarkerFor(filePath: string): string {
  return redirectMarkerPathFor(sessionId, { denied: true, denyPath: filePath });
}

function pre(filePath: string): { status: number; decision: string; reason: string } {
  const r = run(PRETOOL, readPayload(filePath));
  let decision = "passthrough";
  let reason = "";
  try {
    const out = JSON.parse(r.stdout).hookSpecificOutput ?? {};
    decision = out.permissionDecision ?? (out.additionalContext ? "context" : "passthrough");
    reason = out.permissionDecisionReason ?? "";
  } catch { /* no stdout at all is a passthrough */ }
  return { status: r.status, decision, reason };
}

function post(filePath: string, bytes: number): string {
  const r = run(POSTTOOL, {
    tool_name: "Read",
    tool_input: { file_path: filePath },
    tool_response: "x".repeat(bytes),
  });
  try {
    return JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? "";
  } catch {
    return "";
  }
}

function makeFile(name: string, size: number): string {
  const path = join(project, name);
  writeFileSync(path, "x".repeat(size));
  return path;
}

describe("the read-before-edit escape hatch is not a violation", () => {
  it("records nothing when the caller does exactly what the refusal said", () => {
    const file = makeFile("mid.ts", MID_SIZE);

    // Ask for a threshold that refuses this file, so the band under test is
    // the 2–50 KB one the loop actually ran in.
    env.CONTEXT_MODE_READ_DENY_BYTES = "10000";

    const refusal = pre(file);
    expect(refusal.decision, `pretooluse said: ${refusal.reason}`).toBe("deny");
    expect(refusal.reason).toMatch(/Read again/i);

    // Two repeats, not one, and the reason is worth writing down: the refusal
    // leaves its own marker on disk, and the first PostToolUse to run consumes
    // it. So under the old behaviour the FIRST repeat was accidentally covered
    // by the refusal's leftover marker and only the second one was charged.
    // A one-repeat test would have passed against the bug.
    // Read → Edit → Read again to check the result is an ordinary sequence
    // anyway, so this is the real shape of the failure, not a contrived one.
    for (let i = 0; i < 2; i++) {
      const retry = pre(file);
      expect(retry.decision, "the repeat must go through").toBe("passthrough");
      expect(post(file, MID_SIZE), "the retry must not be charged a cost line").toBe("");
    }

    expect(
      readUnroutedTally(sessionId),
      "the retry must not appear in the tally the ladder is priced from",
    ).toBeNull();
  });

  it("does not raise the escalation step by using the way out repeatedly", () => {
    // The loop's signature: each use of the escape hatch made the next refusal
    // harsher. Four of them in a row must leave the ladder exactly where it
    // was — at the bottom.
    const file = makeFile("mid.ts", MID_SIZE);
    env.CONTEXT_MODE_READ_DENY_BYTES = "10000";

    expect(pre(file).decision).toBe("deny");
    for (let i = 0; i < 4; i++) {
      pre(file);
      post(file, MID_SIZE);
    }

    const tally = readUnroutedTally(sessionId);
    expect(tally, "four uses of the escape hatch recorded a tally").toBeNull();
    expect(escalationLevel(tally)).toBe(0);
  });

  it("still records a heavy read that nobody was promised", () => {
    // The control. Without it the two tests above would pass just as well if
    // PostToolUse had stopped recording anything at all.
    const file = makeFile("unpromised.ts", MID_SIZE);
    const notice = post(file, MID_SIZE);

    expect(notice, "an unrouted heavy read must still be charged").toContain("KB");
    expect(readUnroutedTally(sessionId)).toMatchObject({ count: 1 });
  });

  it("writes an accounted-for marker that claims no saving", () => {
    // The mechanism, asserted directly: the retry's marker exists (so the call
    // is not a violation) and carries 0 bytes avoided (so it is not a saving
    // either — the bytes did enter the conversation).
    const file = makeFile("mid.ts", MID_SIZE);
    env.CONTEXT_MODE_READ_DENY_BYTES = "10000";
    pre(file);
    pre(file);

    const markerPath = ownMarkerFor(file);
    expect(existsSync(markerPath), "the repeat wrote no marker at all").toBe(true);
    const marker = readFileSync(markerPath, "utf-8");
    expect(marker.startsWith("Read:read-edit-exempt:0:")).toBe(true);
  });

  it("keeps the accounting threshold on the number the refusal used", () => {
    // The second half of the same promise: "the number the agent is refused at
    // and the number ctx_stats counts as avoided are one number." With the
    // threshold lowered, a 20 KB file is refused — so it must also be the size
    // the accounting event carries, not silently skipped for being under a
    // hard-coded 50 KB.
    const file = makeFile("mid.ts", MID_SIZE);
    env.CONTEXT_MODE_READ_DENY_BYTES = "10000";

    expect(pre(file).decision).toBe("deny");
    const marker = readFileSync(denyMarkerFor(file), "utf-8");
    expect(marker.startsWith(`Read:read-redirected:${MID_SIZE}:`)).toBe(true);
  });
});
