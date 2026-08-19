/**
 * The cost line: what an unrouted heavy call says back.
 *
 * The gap this closes is a feedback gap, not a measurement gap. The bytes were
 * already counted — PostToolUse has recorded every unrouted heavy call for
 * releases — but they were counted into a database the model never reads, and
 * surfaced by a command nobody runs. Between "called Read on 42 KB" and
 * "learned that it cost 42 KB" there was no link at all.
 *
 * So the same number is put where the decision is made: appended to the tool
 * result the model is already looking at, while the next step is still being
 * planned.
 *
 * Two properties matter more than the wording, and both are asserted here:
 * silence on everything that is not a violation (a line that also fires on
 * correct calls is a line the model learns to skip), and agreement with
 * ctx_stats (the tally is read back out of the recorded events rather than
 * counted a second time, so the two surfaces cannot drift apart).
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildMissedRedirectNotice,
  describeMissedRedirect,
  missedRedirectFloorBytes,
} from "../../hooks/core/routing.mjs";
import { formatPostToolContext } from "../../hooks/core/formatters.mjs";

const REPO_ROOT = resolve(__dirname, "..", "..");
const HOOK = join(REPO_ROOT, "hooks", "posttooluse.mjs");

describe("describeMissedRedirect — what counts as a violation", () => {
  const heavy = "x".repeat(40_000);

  it("reports the payload of an unrouted heavy native call", () => {
    const missed = describeMissedRedirect({
      tool_name: "Read",
      tool_input: { file_path: "/src/big.ts" },
      tool_response: heavy,
    });
    expect(missed).toMatchObject({ toolName: "Read", bytes: 40_000, summary: "/src/big.ts" });
  });

  it("says nothing about a call that was routed", () => {
    // The PreToolUse redirect already spoke for this one; saying it again
    // after the fact is the noise the whole design is avoiding.
    expect(
      describeMissedRedirect(
        { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: heavy },
        { routed: true },
      ),
    ).toBeNull();
  });

  it("says nothing below the floor, or about a tool that does not flood", () => {
    expect(
      describeMissedRedirect({ tool_name: "Read", tool_input: {}, tool_response: "small" }),
    ).toBeNull();
    expect(
      describeMissedRedirect({ tool_name: "Write", tool_input: {}, tool_response: heavy }),
    ).toBeNull();
  });

  it("uses the same floor the telemetry and ctx_stats measure against", () => {
    // A notice with its own threshold would name calls that never show up in
    // ctx_stats, and the two surfaces would describe different sessions.
    expect(missedRedirectFloorBytes({})).toBe(2000);
    expect(missedRedirectFloorBytes({ CONTEXT_MODE_MISSED_REDIRECT_MIN_BYTES: "9000" })).toBe(9000);
    expect(
      describeMissedRedirect(
        { tool_name: "Read", tool_input: {}, tool_response: "y".repeat(5000) },
        { env: { CONTEXT_MODE_MISSED_REDIRECT_MIN_BYTES: "9000" } },
      ),
    ).toBeNull();
  });
});

describe("buildMissedRedirectNotice — the line itself", () => {
  const notice = (over: Record<string, unknown> = {}) =>
    buildMissedRedirectNotice({
      toolName: "Read",
      bytes: 43_008,
      tally: { count: 3, bytes: 121_242 },
      platform: "claude-code",
      env: {},
      ...over,
    });

  it("carries the measured bytes, the named replacement and the session tally", () => {
    const line = notice() ?? "";
    expect(line).toContain("42.0 KB");
    expect(line).toContain("ctx_execute_file");
    expect(line).toContain("3 such calls so far this session");
    expect(line).toContain("118.4 KB in total");
  });

  it("names a concrete call for each flooding tool, not just a tool name", () => {
    const pairs: Array<[string, string]> = [
      ["Read", "ctx_execute_file(path, language, code)"],
      ["Grep", "ctx_find(query)"],
      ["Glob", "ctx_find(query)"],
      ["Bash", "ctx_batch_execute(commands, queries)"],
      ["WebFetch", "ctx_fetch_and_index(url, source)"],
    ];
    for (const [tool, call] of pairs) {
      // Codex naming: bare tool names, so the signature is readable in the
      // assertion. The Claude Code namer prefixes the same call.
      const line = notice({ toolName: tool, platform: "codex" }) ?? "";
      expect(line, `${tool} notice`).toContain(call);
    }
  });

  it("invents no estimate of what the replacement would have returned", () => {
    // Nothing in the hook can know that number. A made-up one would sit next
    // to the one figure that is actually measured and discredit it.
    const line = notice() ?? "";
    expect(line).not.toMatch(/would have returned/i);
    expect(line).not.toMatch(/~\s*\d/);
  });

  it("drops the tally sentence on the first call, when it would restate itself", () => {
    const line = notice({ tally: { count: 1, bytes: 43_008 } }) ?? "";
    expect(line).not.toContain("such calls");
    expect(line.split("\n")).toHaveLength(1);
  });

  it("uses the name the agent called, not the one telemetry files it under", () => {
    // Codex normalises Shell to Bash so both hosts aggregate together; the
    // agent still called Shell.
    const line = notice({ toolName: "Bash", displayName: "Shell", platform: "codex" }) ?? "";
    expect(line).toContain("this Shell call");
  });

  it("goes quiet on CONTEXT_MODE_COST_NOTICE=0", () => {
    expect(notice({ env: { CONTEXT_MODE_COST_NOTICE: "0" } })).toBeNull();
  });
});

describe("formatPostToolContext — the two hosts that carry the line", () => {
  it("emits the PostToolUse event name, not the PreToolUse one", () => {
    // Reusing the PreToolUse shape here is the failure mode that would make
    // the host drop the line silently.
    for (const platform of ["claude-code", "codex"]) {
      expect(formatPostToolContext(platform, "hello"), platform).toEqual({
        hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "hello" },
      });
    }
  });

  it("says nothing for an empty notice, or for a host with no such channel", () => {
    expect(formatPostToolContext("claude-code", "")).toBeNull();
    expect(formatPostToolContext("nonexistent-host", "hello")).toBeNull();
  });
});

describe("the Claude Code hook, end to end", () => {
  /**
   * Each run gets its own fake HOME: the hook opens a session DB and sweeps
   * caches, and pointing it at the developer's config dir would make the suite
   * write into a live session.
   */
  function runHook(
    tool: string,
    toolInput: Record<string, unknown>,
    responseBytes: number,
    home: string,
    project: string,
    extraEnv: Record<string, string> = {},
  ): string {
    const result = spawnSync("node", [HOOK], {
      input: JSON.stringify({
        session_id: "cost-notice-test",
        cwd: project,
        tool_name: tool,
        tool_input: toolInput,
        tool_response: "x".repeat(responseBytes),
      }),
      encoding: "utf-8",
      timeout: 60_000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        CLAUDE_PROJECT_DIR: project,
        CLAUDE_SESSION_ID: "cost-notice-test",
        CONTEXT_MODE_SESSION_SUFFIX: "",
        ...extraEnv,
      },
    });
    const stdout = (result.stdout ?? "").trim();
    if (!stdout) return "";
    try {
      return JSON.parse(stdout).hookSpecificOutput?.additionalContext ?? "";
    } catch {
      return `UNPARSEABLE: ${stdout}`;
    }
  }

  function withScratch(fn: (home: string, project: string) => void): void {
    const home = mkdtempSync(join(tmpdir(), "cost-notice-home-"));
    const project = mkdtempSync(join(tmpdir(), "cost-notice-project-"));
    try {
      fn(home, project);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  }

  it("prints nothing at all on calls that are not violations", () => {
    withScratch((home, project) => {
      expect(runHook("Read", { file_path: "/small.ts" }, 100, home, project)).toBe("");
      expect(runHook("Write", { file_path: "/x.ts" }, 40_000, home, project)).toBe("");
    });
  });

  it("appends the line to an unrouted heavy call, and counts up across the session", () => {
    withScratch((home, project) => {
      // Distinct paths: SessionDB drops an exact repeat of the same event
      // within its dedup window, which is also why the tally is read back from
      // the store rather than counted in the hook.
      const first = runHook("Read", { file_path: "/a.ts" }, 43_008, home, project);
      expect(first).toContain("42.0 KB");
      expect(first).toContain("ctx_execute_file");
      expect(first).not.toContain("such calls");

      const second = runHook("Read", { file_path: "/b.ts" }, 43_008, home, project);
      expect(second).toContain("2 such calls so far this session");
      expect(second).toContain("84.0 KB in total");

      const third = runHook("Bash", { command: "git log --stat" }, 43_008, home, project);
      expect(third).toContain("this Bash call");
      expect(third).toContain("ctx_batch_execute");
      expect(third).toContain("3 such calls so far this session");
    });
  });

  it("stays silent when the notice is switched off", () => {
    withScratch((home, project) => {
      expect(
        runHook("Read", { file_path: "/c.ts" }, 43_008, home, project, {
          CONTEXT_MODE_COST_NOTICE: "0",
        }),
      ).toBe("");
    });
  });
});
