/**
 * Subagent transcript capture (fork feature #14).
 *
 * A subagent's context dies with the subagent; these tests pin the pipeline
 * that makes it recoverable: transcript resolution, digest extraction, and
 * the queue drain that indexes digests into the content store.
 */

import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  drainSubagentQueue,
  extractSubagentCapture,
  resolveAgentTranscriptPath,
  subagentQueuePath,
  subagentSourceLabel,
  type SubagentQueueEntry,
} from "../../src/session/subagent-capture.js";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "cm-subagent-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function line(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

/** A minimal dedicated subagent transcript: task → tool call → result → report. */
function dedicatedTranscript(): string {
  return (
    line({ type: "user", message: { role: "user", content: [{ type: "text", text: "Find the retry handler" }] } }) +
    line({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Searching." },
          { type: "tool_use", id: "tu_1", name: "Grep", input: { pattern: "retry", path: "src" } },
        ],
      },
    }) +
    line({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "src/http.ts:42: retryWithBackoff()" }] }],
      },
    }) +
    line({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "The retry handler is retryWithBackoff in src/http.ts:42." }] },
    })
  );
}

describe("extractSubagentCapture", () => {
  test("dedicated transcript becomes a digest with task, tool call, and final report", () => {
    const capture = extractSubagentCapture(dedicatedTranscript());
    expect(capture).not.toBeNull();
    expect(capture!.toolCalls).toBe(1);
    expect(capture!.markdown).toContain("## Task prompt");
    expect(capture!.markdown).toContain("Find the retry handler");
    expect(capture!.markdown).toContain("## 1. Grep: retry");
    expect(capture!.markdown).toContain("retryWithBackoff()");
    expect(capture!.markdown).toContain("## Final report");
    expect(capture!.finalText).toContain("src/http.ts:42");
  });

  test("long tool results are truncated to the cap", () => {
    const big = "x".repeat(10_000);
    const jsonl =
      line({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "cat big.log" } }] },
      }) +
      line({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: big }] },
      });
    const capture = extractSubagentCapture(jsonl, { toolResultCap: 100 });
    expect(capture).not.toBeNull();
    expect(capture!.markdown.length).toBeLessThan(1_000);
    expect(capture!.markdown).toContain("x".repeat(100));
    expect(capture!.markdown).not.toContain("x".repeat(101));
  });

  test("mixed transcript filters sidechain entries by agentId when present", () => {
    const jsonl =
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "MAIN CONVERSATION" }] } }) +
      line({ type: "assistant", isSidechain: true, agentId: "a1", message: { role: "assistant", content: [{ type: "text", text: "AGENT ONE" }] } }) +
      line({ type: "assistant", isSidechain: true, agentId: "a2", message: { role: "assistant", content: [{ type: "text", text: "AGENT TWO" }] } });
    const capture = extractSubagentCapture(jsonl, { agentId: "a1" });
    expect(capture).not.toBeNull();
    expect(capture!.markdown).toContain("AGENT ONE");
    expect(capture!.markdown).not.toContain("AGENT TWO");
    expect(capture!.markdown).not.toContain("MAIN CONVERSATION");
  });

  test("mixed transcript without ids takes the last contiguous sidechain run", () => {
    const jsonl =
      line({ type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "EARLIER AGENT" }] } }) +
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "MAIN" }] } }) +
      line({ type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "FINAL AGENT" }] } });
    const capture = extractSubagentCapture(jsonl, { agentId: "missing-id" });
    expect(capture).not.toBeNull();
    expect(capture!.markdown).toContain("FINAL AGENT");
    expect(capture!.markdown).not.toContain("EARLIER AGENT");
    expect(capture!.markdown).not.toContain("MAIN");
  });

  test("empty and unparseable input yields null", () => {
    expect(extractSubagentCapture("")).toBeNull();
    expect(extractSubagentCapture("not json\nstill not json\n")).toBeNull();
  });
});

describe("resolveAgentTranscriptPath", () => {
  test("a path already inside subagents/ is used as-is when it exists", () => {
    const dir = join(scratch, "subagents");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "agent-a1.jsonl");
    writeFileSync(p, "{}\n");
    expect(resolveAgentTranscriptPath({ transcriptPath: p, agentId: "a1" })).toBe(p);
  });

  test("derives the dedicated file from the main transcript path + agentId", () => {
    const main = join(scratch, "session-123.jsonl");
    writeFileSync(main, "{}\n");
    const dedicated = join(scratch, "session-123", "subagents", "agent-a7.jsonl");
    mkdirSync(join(scratch, "session-123", "subagents"), { recursive: true });
    writeFileSync(dedicated, "{}\n");
    expect(resolveAgentTranscriptPath({ transcriptPath: main, agentId: "a7" })).toBe(dedicated);
  });

  test("falls back to the given path when no dedicated file exists", () => {
    const main = join(scratch, "session-9.jsonl");
    writeFileSync(main, "{}\n");
    expect(resolveAgentTranscriptPath({ transcriptPath: main, agentId: "nope" })).toBe(main);
  });

  test("null when nothing exists on disk", () => {
    expect(resolveAgentTranscriptPath({ transcriptPath: join(scratch, "gone.jsonl") })).toBeNull();
    expect(resolveAgentTranscriptPath({})).toBeNull();
  });
});

describe("subagentSourceLabel", () => {
  test("sanitizes type and id into a stable label", () => {
    expect(subagentSourceLabel({ agentType: "Explore", agentId: "abc123" })).toBe("subagent:Explore:abc123");
    expect(subagentSourceLabel({})).toBe("subagent:agent:unknown");
    expect(subagentSourceLabel({ agentType: "a b/c", agentId: "x y" })).toBe("subagent:a-b-c:x-y");
  });
});

describe("drainSubagentQueue", () => {
  interface Indexed { content?: string; source?: string; attribution?: { sessionId?: string } }

  function fakeStore(): { calls: Indexed[]; index(o: Indexed): void } {
    const calls: Indexed[] = [];
    return { calls, index(o: Indexed) { calls.push(o); } };
  }

  function enqueue(entries: SubagentQueueEntry[]): void {
    writeFileSync(subagentQueuePath(scratch), entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  }

  test("indexes queued transcripts and clears the queue", () => {
    const transcript = join(scratch, "agent-a1.jsonl");
    writeFileSync(transcript, dedicatedTranscript());
    enqueue([{ sessionId: "s1", agentId: "a1", agentType: "Explore", transcriptPath: transcript }]);

    const store = fakeStore();
    const indexed = drainSubagentQueue({ store, sessionsDir: scratch });
    expect(indexed).toBe(1);
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0].source).toBe("subagent:Explore:a1");
    expect(store.calls[0].content).toContain("# Subagent: Explore (a1)");
    expect(store.calls[0].content).toContain("retryWithBackoff");
    expect(store.calls[0].attribution).toEqual({ sessionId: "s1" });
    expect(existsSync(subagentQueuePath(scratch))).toBe(false);
  });

  test("last queue entry wins per agent — one digest per agent", () => {
    const transcript = join(scratch, "agent-a1.jsonl");
    writeFileSync(transcript, dedicatedTranscript());
    enqueue([
      { sessionId: "s1", agentId: "a1", agentType: "Explore", transcriptPath: join(scratch, "gone.jsonl") },
      { sessionId: "s2", agentId: "a1", agentType: "Explore", transcriptPath: transcript },
    ]);
    const store = fakeStore();
    expect(drainSubagentQueue({ store, sessionsDir: scratch })).toBe(1);
    expect(store.calls[0].attribution).toEqual({ sessionId: "s2" });
  });

  test("malformed lines and missing transcripts are skipped, drain continues", () => {
    const transcript = join(scratch, "agent-ok.jsonl");
    writeFileSync(transcript, dedicatedTranscript());
    writeFileSync(
      subagentQueuePath(scratch),
      "{broken json\n" +
        JSON.stringify({ agentId: "gone", transcriptPath: join(scratch, "missing.jsonl") }) + "\n" +
        JSON.stringify({ agentId: "ok", agentType: "Plan", transcriptPath: transcript }) + "\n",
    );
    const store = fakeStore();
    expect(drainSubagentQueue({ store, sessionsDir: scratch })).toBe(1);
    expect(store.calls[0].source).toBe("subagent:Plan:ok");
  });

  test("overflow past maxAgents is written back for the next drain", () => {
    const transcript = join(scratch, "agent-x.jsonl");
    writeFileSync(transcript, dedicatedTranscript());
    enqueue([
      { agentId: "a1", transcriptPath: transcript },
      { agentId: "a2", transcriptPath: transcript },
      { agentId: "a3", transcriptPath: transcript },
    ]);
    const store = fakeStore();
    expect(drainSubagentQueue({ store, sessionsDir: scratch, maxAgents: 2 })).toBe(2);
    const remaining = readFileSync(subagentQueuePath(scratch), "utf-8").trim().split("\n");
    expect(remaining).toHaveLength(1);
    expect(JSON.parse(remaining[0]).agentId).toBe("a3");
  });

  test("no queue file — no work, no crash", () => {
    const store = fakeStore();
    expect(drainSubagentQueue({ store, sessionsDir: scratch })).toBe(0);
  });
});
