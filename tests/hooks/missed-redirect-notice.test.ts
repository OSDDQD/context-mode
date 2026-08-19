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
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildMissedRedirectNotice,
  describeMissedRedirect,
  missedRedirectFloorBytes,
} from "../../hooks/core/routing.mjs";
import { formatPostToolContext } from "../../hooks/core/formatters.mjs";
import { loadDatabase } from "../../src/db-base.js";

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
    //
    // The command has to be one that WOULD be reported otherwise — `ls` and
    // friends are sanctioned now, so using one of those here would pass no
    // matter what `routed` did.
    const call = {
      tool_name: "Bash",
      tool_input: { command: "cat huge.log" },
      tool_response: heavy,
    };
    expect(describeMissedRedirect(call)).toMatchObject({ toolName: "Bash" });
    expect(describeMissedRedirect(call, { routed: true })).toBeNull();
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

  it("says nothing about a Read the caller had already bounded", () => {
    // The refusal text promises in writing that offset and limit "go through
    // unchanged". A bounded read that still counts as a violation turns that
    // promise into a trap, so these are dropped outright rather than merely
    // sanctioned — the advice was followed exactly and there is nothing left
    // to report.
    expect(
      describeMissedRedirect({
        tool_name: "Read",
        tool_input: { file_path: "/src/big.ts", limit: 200 },
        tool_response: heavy,
      }),
    ).toBeNull();
  });

  it("still reports the same Read once the bound is gone", () => {
    // The companion to the case above: the only difference between the two is
    // the `limit`, so this is what makes that test about bounding and not
    // about the tool or the floor.
    expect(
      describeMissedRedirect({
        tool_name: "Read",
        tool_input: { file_path: "/src/big.ts" },
        tool_response: heavy,
      }),
    ).toMatchObject({ toolName: "Read", bytes: 40_000, sanctioned: false });
  });

  it("records the Bash calls the rules route TO Bash without holding them against the session", () => {
    // "Bash ONLY for: git, mkdir, rm, mv, cd, ls, npm install, pip install"
    // is the plugin's own instruction. Counting obedience as a violation made
    // the escalation ladder climb on the behaviour it was asking for.
    expect(
      describeMissedRedirect({
        tool_name: "Bash",
        tool_input: { command: "git diff" },
        tool_response: "d".repeat(15_360),
      }),
    ).toMatchObject({ toolName: "Bash", bytes: 15_360, summary: "git diff", sanctioned: true });

    for (const command of ["npm install", "mkdir -p x", "mv a b", "rm -rf x", "ls -la"]) {
      expect(
        describeMissedRedirect({
          tool_name: "Bash",
          tool_input: { command },
          tool_response: heavy,
        }),
        command,
      ).toMatchObject({ sanctioned: true });
    }
  });

  it("withdraws the sanction the moment a shell operator composes with a sink", () => {
    // A sanctioned prefix says what the FIRST command is, not what the line
    // returns. `git diff && cat huge` floods exactly as much as `cat huge`.
    expect(
      describeMissedRedirect({
        tool_name: "Bash",
        tool_input: { command: "git diff && cat huge.log" },
        tool_response: heavy,
      }),
    ).toMatchObject({ sanctioned: false });
  });

  it("sanctions nothing the rules never asked for", () => {
    expect(
      describeMissedRedirect({
        tool_name: "Bash",
        tool_input: { command: "cat huge.log" },
        tool_response: heavy,
      }),
    ).toMatchObject({ toolName: "Bash", summary: "cat huge.log", sanctioned: false });
  });

  it("treats a confirmed ask as consent, whatever the command was", () => {
    // Consent lives in the ask marker the hook consumed, not in the payload —
    // once the user has said yes, charging the session for the call would be
    // billing them for their own decision.
    expect(
      describeMissedRedirect(
        { tool_name: "Bash", tool_input: { command: "cat huge.log" }, tool_response: heavy },
        { sanctioned: true },
      ),
    ).toMatchObject({ sanctioned: true });
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
    extraPayload: Record<string, unknown> = {},
  ): string {
    const result = spawnSync("node", [HOOK], {
      input: JSON.stringify({
        session_id: "cost-notice-test",
        cwd: project,
        tool_name: tool,
        tool_input: toolInput,
        tool_response: "x".repeat(responseBytes),
        ...extraPayload,
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

  /**
   * The rows the hook actually wrote. The notice is only half of the
   * contract — what the session is charged for lives in the store, and the
   * two must be read separately or a call that prints nothing while still
   * counting would pass unnoticed.
   *
   * The DB name is the hash of the normalized project path, the same way the
   * hook derives it (`\` → `/` first, so the two agree on Windows).
   */
  function readEvents(home: string, project: string, type: string): Array<{
    type: string;
    category: string;
    data: string;
  }> {
    const canonical = project.replace(/\\/g, "/");
    const projectHash = createHash("sha256")
      .update(process.platform === "darwin" || process.platform === "win32"
        ? canonical.toLowerCase()
        : canonical)
      .digest("hex")
      .slice(0, 16);
    const dbPath = join(home, ".claude", "context-mode", "sessions", `${projectHash}.db`);
    const Database = loadDatabase();
    const raw = new Database(dbPath, { readonly: true });
    try {
      return raw
        .prepare(
          "SELECT type, category, data FROM session_events WHERE session_id = ? AND type = ?",
        )
        .all("cost-notice-test", type) as Array<{ type: string; category: string; data: string }>;
    } finally {
      raw.close();
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

      // Not a git command: Bash is where the rules send git, so `git log
      // --stat` is sanctioned and would never reach the notice. The violation
      // this counts is an unbounded dump the sandbox should have held.
      const third = runHook("Bash", { command: "cat build.log" }, 43_008, home, project);
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

  it("charges a subagent's bytes to the subagent, not to this window", () => {
    withScratch((home, project) => {
      // An Explore agent that pulls 40 KB spends 40 KB of ITS context; what
      // comes back here is its report. Escalating the main loop for those
      // bytes prices a decision on somebody else's spending.
      const inSubagent = runHook(
        "Read", { file_path: "/agent.ts" }, 43_008, home, project, {},
        { agent_id: "agent-7" },
      );
      expect(inSubagent).toBe("");
      expect(readEvents(home, project, "missed_redirect")).toHaveLength(0);

      // Same payload on the main thread. It is recorded — and the notice
      // still reads as the session's FIRST such call, which is what proves
      // the subagent left the tally alone rather than merely printing nothing.
      const mainThread = runHook("Read", { file_path: "/agent.ts" }, 43_008, home, project);
      expect(mainThread).toContain("42.0 KB");
      expect(mainThread).not.toContain("such calls");
      expect(readEvents(home, project, "missed_redirect")).toHaveLength(1);
    });
  });

  it("files a heavy call the rules asked for under its own type, and says nothing", () => {
    withScratch((home, project) => {
      const line = runHook("Bash", { command: "git diff" }, 15_360, home, project);
      expect(line).toBe("");

      // The bytes stay visible in ctx_stats — they were spent — under a type
      // the tally does not read, so they cannot move the escalation ladder.
      const sanctioned = readEvents(home, project, "sanctioned_heavy");
      expect(sanctioned).toHaveLength(1);
      expect(sanctioned[0].category).toBe("sanctioned-heavy");
      expect(sanctioned[0].data).toContain("15360 bytes unrouted");
      expect(sanctioned[0].data).toContain("git diff");
      expect(readEvents(home, project, "missed_redirect")).toHaveLength(0);
    });
  });
});
