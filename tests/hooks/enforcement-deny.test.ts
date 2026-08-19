/**
 * Enforcement: refuse where the loss is proven before the call, ask where it
 * is not, and never take away a capability that has no replacement.
 *
 * The rules with full adherence today are the ones that refuse and hand back a
 * ready call — curl, wget, inline HTTP, WebFetch. Everything else is advice
 * competing with habit. These tests pin the extension of that list, and,
 * equally, its limits.
 *
 * Read is refusable: statSync knows the size BEFORE the call, so the loss is
 * measured rather than guessed, and ctx_execute_file answers the same question
 * in 529 B where Read spends 34 KB (BENCHMARK.md Part 4).
 *
 * Grep is not, and the same benchmark is why: ctx_find returns 2.6 KB against
 * 0.7 KB for `rg -l`, and it ranks rather than enumerates. Refusing Grep would
 * trade a cheap exhaustive answer for an expensive partial one. So it escalates
 * to a confirmation, only when nothing bounds the search, and the prompt says
 * outright that confirming is correct when the sweep is the point.
 *
 * The load-bearing test in this file is the edit escape hatch. Read-before-Edit
 * has to keep working: Edit matches against the exact bytes in the
 * conversation, so a plugin that refuses that read breaks the main job instead
 * of routing it. A false refusal here costs more than any leak.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { routePreToolUse, resetGuidanceThrottle } from "../../hooks/core/routing.mjs";
import { formatters } from "../../hooks/core/formatters.mjs";

interface Decision {
  action: string;
  reason?: string;
  additionalContext?: string;
  redirectMeta?: { bytesAvoided?: number };
}

const PROJECT = process.cwd();

// The redirect guard passes calls through when no MCP server is live —
// pointing an agent at a tool that is not there would strand it. Every
// refusal below therefore needs a sentinel, which is also the mechanism the
// "MCP is down" test removes.
const SENTINEL_DIR = mkdtempSync(join(tmpdir(), "ctx-enforce-sentinel-"));
process.env.CONTEXT_MODE_MCP_SENTINEL_DIR = SENTINEL_DIR;
const SENTINEL = resolve(SENTINEL_DIR, `context-mode-mcp-ready-${process.pid}`);

let scratch: string;
let bigFile: string;
let smallFile: string;

const ENV_KEYS = [
  "CONTEXT_MODE_READ_DENY_BYTES",
  "CONTEXT_MODE_READ_EDIT_WINDOW_MS",
  "CONTEXT_MODE_BASH_DENY_COMMANDS",
  "CONTEXT_MODE_GREP_ASK",
];

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "ctx-enforce-"));
  bigFile = join(scratch, "big.ts");
  smallFile = join(scratch, "small.ts");
  writeFileSync(bigFile, "x".repeat(120_000));
  writeFileSync(smallFile, "x".repeat(1_000));
});

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  writeFileSync(SENTINEL, String(process.pid));
  resetGuidanceThrottle();
});

afterAll(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  delete process.env.CONTEXT_MODE_MCP_SENTINEL_DIR;
  rmSync(scratch, { recursive: true, force: true });
  rmSync(SENTINEL_DIR, { recursive: true, force: true });
});

/** Fresh session id per case, so one case's retry marker cannot answer another. */
let counter = 0;
function sid(): string {
  return `enforce-${process.pid}-${++counter}`;
}

function route(tool: string, input: Record<string, unknown>, session: string): Decision | null {
  return routePreToolUse(tool, input, PROJECT, "claude-code", session) as Decision | null;
}

describe("Read: refuse the whole-file read of a large file", () => {
  it("refuses, and hands back the call to make instead — with the real path in it", () => {
    const decision = route("Read", { file_path: bigFile }, sid());
    expect(decision?.action).toBe("deny");
    const reason = decision?.reason ?? "";
    // A ready call, not an abstract suggestion: the path is already in it.
    expect(reason).toContain("ctx_execute_file");
    expect(reason).toContain(JSON.stringify(bigFile));
    expect(reason).toContain("117.2 KB");
    // The measured size still reaches the byte accounting.
    expect(decision?.redirectMeta?.bytesAvoided).toBe(120_000);
  });

  it("says nothing about a file under the threshold", () => {
    const decision = route("Read", { file_path: smallFile }, sid());
    expect(decision?.action).not.toBe("deny");
  });

  it("lets a bounded read through — offset/limit returns a slice, not the file", () => {
    const decision = route("Read", { file_path: bigFile, offset: 100, limit: 50 }, sid());
    expect(decision?.action).not.toBe("deny");
  });

  it("passes the read through when the replacement tool is not running", () => {
    // With no MCP server there is no ctx_execute_file to route to, and a
    // refusal pointing at a tool that does not exist is a dead end.
    unlinkSync(SENTINEL);
    const decision = route("Read", { file_path: bigFile }, sid());
    expect(decision?.action).not.toBe("deny");
  });
});

describe("Read: the edit escape hatch", () => {
  it("allows the same path on the second call, and says so in the refusal", () => {
    const session = sid();

    const first = route("Read", { file_path: bigFile }, session);
    expect(first?.action).toBe("deny");

    // The instruction has to be in the text the model reads. Without it the
    // model has no way to learn that a retry is the way through, and simply
    // stops — which is the expensive failure, not the leak.
    const reason = first?.reason ?? "";
    expect(reason).toMatch(/EDIT/);
    expect(reason).toMatch(/Read again/i);
    expect(reason).toMatch(/\d+s/);

    const second = route("Read", { file_path: bigFile }, session);
    expect(second?.action, "the repeat after a refusal must go through").not.toBe("deny");
  });

  it("opens the window for that path only", () => {
    const session = sid();
    const other = join(scratch, "other.ts");
    writeFileSync(other, "y".repeat(120_000));

    expect(route("Read", { file_path: bigFile }, session)?.action).toBe("deny");
    expect(route("Read", { file_path: other }, session)?.action).toBe("deny");
    expect(route("Read", { file_path: bigFile }, session)?.action).not.toBe("deny");
  });

  it("keeps the path open across several reads, not just one", () => {
    // Read → Edit → Read again to check the result is an ordinary shape, and
    // re-refusing in the middle of it is the false positive worth avoiding.
    const session = sid();
    expect(route("Read", { file_path: bigFile }, session)?.action).toBe("deny");
    expect(route("Read", { file_path: bigFile }, session)?.action).not.toBe("deny");
    expect(route("Read", { file_path: bigFile }, session)?.action).not.toBe("deny");
  });

  it("closes the window once it expires", async () => {
    process.env.CONTEXT_MODE_READ_EDIT_WINDOW_MS = "1";
    const session = sid();
    expect(route("Read", { file_path: bigFile }, session)?.action).toBe("deny");
    await new Promise((r) => setTimeout(r, 25));
    expect(route("Read", { file_path: bigFile }, session)?.action).toBe("deny");
  });
});

describe("Read: the threshold is the operator's", () => {
  it("refuses at a lowered threshold and stays quiet at a raised one", () => {
    process.env.CONTEXT_MODE_READ_DENY_BYTES = "500";
    expect(route("Read", { file_path: smallFile }, sid())?.action).toBe("deny");

    process.env.CONTEXT_MODE_READ_DENY_BYTES = "500000";
    expect(route("Read", { file_path: bigFile }, sid())?.action).not.toBe("deny");
  });

  it("turns the refusal off entirely at 0", () => {
    process.env.CONTEXT_MODE_READ_DENY_BYTES = "0";
    expect(route("Read", { file_path: bigFile }, sid())?.action).not.toBe("deny");
  });

  it("names both variables in the refusal, so the operator can find them", () => {
    const reason = route("Read", { file_path: bigFile }, sid())?.reason ?? "";
    expect(reason).toContain("CONTEXT_MODE_READ_DENY_BYTES");
    expect(reason).toContain("CONTEXT_MODE_READ_EDIT_WINDOW_MS");
  });
});

describe("Bash: named heavy commands", () => {
  it("refuses each default entry with a ready ctx_batch_execute call", () => {
    for (const command of ["npm test", "docker logs api", "git log -p", "find / -name x"]) {
      const decision = route("Bash", { command }, sid());
      expect(decision?.action, command).toBe("deny");
      const reason = decision?.reason ?? "";
      expect(reason, command).toContain("ctx_batch_execute");
      // The command is already inside the replacement call, quoted.
      expect(reason, command).toContain(JSON.stringify(command));
      expect(reason, command).toContain("CONTEXT_MODE_BASH_DENY_COMMANDS");
    }
  });

  it("leaves a bounded search that merely starts the same way alone", () => {
    // `find /` is a sweep of the root; `find /etc -name '*.conf'` is a small
    // bounded search sharing eight characters with it. Substring matching
    // cannot tell them apart, which is why the entries are patterns.
    const decision = route("Bash", { command: "find /etc -name '*.conf'" }, sid());
    expect(decision?.action).not.toBe("deny");
  });

  it("leaves ordinary commands alone", () => {
    for (const command of ["git log --oneline -20", "ls -la", "npm run build"]) {
      expect(route("Bash", { command }, sid())?.action, command).not.toBe("deny");
    }
  });

  it("takes its list from the operator, and an empty list turns it off", () => {
    process.env.CONTEXT_MODE_BASH_DENY_COMMANDS = "cargo build";
    expect(route("Bash", { command: "cargo build --release" }, sid())?.action).toBe("deny");
    expect(route("Bash", { command: "npm test" }, sid())?.action).not.toBe("deny");

    process.env.CONTEXT_MODE_BASH_DENY_COMMANDS = "";
    expect(route("Bash", { command: "npm test" }, sid())?.action).not.toBe("deny");
  });

  it("does not trip on the command's name inside a quoted string", () => {
    const decision = route("Bash", { command: 'echo "remember to run npm test"' }, sid());
    expect(decision?.action).not.toBe("deny");
  });
});

describe("Grep and Glob: ask, never refuse", () => {
  const unbounded = { pattern: "handleRequest", output_mode: "content" };

  it("asks — it does not refuse — when nothing bounds the search", () => {
    const decision = route("Grep", unbounded, sid());
    expect(decision?.action).toBe("ask");
  });

  it("says that confirming is the right answer for an exhaustive sweep", () => {
    // The honest half. ctx_find ranks; it does not enumerate. A prompt that
    // hid that would be asking the caller to trade a complete answer for an
    // incomplete one without telling them.
    const reason = route("Grep", unbounded, sid())?.reason ?? "";
    expect(reason).toContain("ctx_find");
    expect(reason).toMatch(/every occurrence/i);
    expect(reason).toMatch(/ranks/i);
    expect(reason).toContain("CONTEXT_MODE_GREP_ASK");
  });

  it("stays quiet as soon as anything bounds it", () => {
    for (const input of [
      { pattern: "x", output_mode: "content", path: "src" },
      { pattern: "x", output_mode: "content", glob: "*.ts" },
      { pattern: "x", output_mode: "content", head_limit: 20 },
      { pattern: "x", output_mode: "files_with_matches" },
      { pattern: "x" },
    ]) {
      resetGuidanceThrottle();
      const decision = route("Grep", input, sid());
      expect(decision?.action, JSON.stringify(input)).not.toBe("ask");
    }
  });

  it("asks on a whole-tree Glob and nothing else", () => {
    expect(route("Glob", { pattern: "**/*" }, sid())?.action).toBe("ask");
    expect(route("Glob", { pattern: "**/*.ts" }, sid())?.action).not.toBe("ask");
    expect(route("Glob", { pattern: "**/*", path: "src" }, sid())?.action).not.toBe("ask");
  });

  it("goes quiet on CONTEXT_MODE_GREP_ASK=0", () => {
    process.env.CONTEXT_MODE_GREP_ASK = "0";
    expect(route("Grep", unbounded, sid())?.action).not.toBe("ask");
    expect(route("Glob", { pattern: "**/*" }, sid())?.action).not.toBe("ask");
  });
});

describe("the confirmation reaches the user with its reason attached", () => {
  it("carries permissionDecisionReason on Claude Code", () => {
    // Without this the host shows a bare yes/no. The entire argument for
    // asking rather than refusing is that the caller reads the tradeoff.
    expect(formatters["claude-code"].ask("because X")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: "because X",
      },
    });
  });

  it("keeps the old shape when there is no reason (security-policy ask)", () => {
    expect(formatters["claude-code"].ask()).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" },
    });
  });
});
