/**
 * SessionStart re-injects the routing block on every lifecycle source.
 *
 * The routing block is the only place the rules live inside a session. It
 * arrives once, as `additionalContext` on SessionStart. Compaction throws away
 * the conversation that carried it — so if SessionStart does not fire again on
 * `compact`, or fires but returns a thinner block, the second half of every
 * long session runs with no routing rules at all. Nothing errors; the model
 * simply stops routing, and the only visible symptom is a context window that
 * fills faster than it used to.
 *
 * The registration says this cannot happen: hooks.json registers SessionStart
 * with an empty matcher, and for SessionStart the matcher is matched against
 * the lifecycle `source` (startup / resume / clear / compact), so empty means
 * all four. But the registration is only half of it — the hook body reads
 * `input.source` and branches on it, and a branch that returned early, or that
 * built `additionalContext` from scratch per source, would drop the block just
 * as effectively as a matcher that never fired. That is why these tests run the
 * real hook on all four sources and compare the emitted block byte for byte
 * rather than asserting on the matcher alone.
 *
 * Each run gets its own fake HOME/CLAUDE_CONFIG_DIR: the hook writes a session
 * DB, sweeps stale caches, and on a true fresh `startup` deliberately wipes
 * prior data. Pointing it at the developer's real config dir would make the
 * suite destructive.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const HOOK_PATH = join(REPO_ROOT, "hooks", "sessionstart.mjs");

/** Every lifecycle source Claude Code sends on SessionStart. */
const SOURCES = ["startup", "compact", "resume", "clear"] as const;

interface HookRun {
  status: number;
  additionalContext: string;
  stderr: string;
}

function runHook(source: string): HookRun {
  const home = mkdtempSync(join(tmpdir(), "ctx-sessionstart-home-"));
  const project = mkdtempSync(join(tmpdir(), "ctx-sessionstart-project-"));
  try {
    const result = spawnSync("node", [HOOK_PATH], {
      input: JSON.stringify({
        source,
        session_id: `sessionstart-${source}-test`,
        cwd: project,
      }),
      encoding: "utf-8",
      timeout: 60_000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        CLAUDE_PROJECT_DIR: project,
        CLAUDE_SESSION_ID: `sessionstart-${source}-test`,
        CONTEXT_MODE_SESSION_SUFFIX: "",
      },
    });
    let additionalContext = "";
    try {
      additionalContext =
        JSON.parse(result.stdout ?? "").hookSpecificOutput?.additionalContext ?? "";
    } catch {
      additionalContext = "";
    }
    return {
      status: result.status ?? 1,
      additionalContext,
      stderr: (result.stderr ?? "").trim(),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
}

/**
 * The routing block proper, without whatever per-source continuity text the
 * hook appends around it — that part is *supposed* to differ between a fresh
 * start and a resume. The block itself is not.
 */
function routingBlockOf(additionalContext: string): string {
  const open = additionalContext.indexOf("<context_window_protection>");
  const close = additionalContext.lastIndexOf("</context_window_protection>");
  if (open < 0 || close < 0) return "";
  return additionalContext.slice(open, close + "</context_window_protection>".length);
}

const RUNS = new Map<string, HookRun>(SOURCES.map((s) => [s, runHook(s)]));

describe("SessionStart registration covers every lifecycle source", () => {
  it("registers with an empty matcher, so compact and resume are not filtered out", () => {
    const hooks = JSON.parse(readFileSync(join(REPO_ROOT, "hooks", "hooks.json"), "utf-8")) as {
      hooks: Record<string, Array<{ matcher: string }>>;
    };
    const groups = hooks.hooks.SessionStart;
    expect(groups, "SessionStart is not registered at all").toBeDefined();
    // A non-empty matcher here would be a source filter. Naming any single
    // source (the tempting "startup") is exactly the bug this file exists for.
    for (const group of groups) {
      expect(
        group.matcher,
        `SessionStart matcher "${group.matcher}" filters lifecycle sources — ` +
          "the routing block would stop being re-injected after compaction",
      ).toBe("");
    }
  });
});

describe("SessionStart re-injects the routing block after compaction", () => {
  for (const source of SOURCES) {
    it(`emits the routing block on source=${source}`, () => {
      const run = RUNS.get(source)!;
      expect(run.status, `hook exited ${run.status}: ${run.stderr}`).toBe(0);
      expect(
        run.additionalContext,
        `source=${source} produced no additionalContext — a session on this ` +
          "lifecycle path would run with no routing rules",
      ).not.toBe("");
      expect(routingBlockOf(run.additionalContext)).toContain("<tool_selection_hierarchy>");
    });
  }

  it("emits the SAME block on compact and resume as on startup", () => {
    // Byte equality, not "contains something" — a source branch that rebuilt
    // the block, or appended a warning in place of it, would still pass a
    // substring check while shipping different rules to half the session.
    const baseline = routingBlockOf(RUNS.get("startup")!.additionalContext);
    expect(baseline.length, "startup emitted no routing block at all").toBeGreaterThan(0);
    const drifted = SOURCES.filter((s) => routingBlockOf(RUNS.get(s)!.additionalContext) !== baseline);
    expect(
      drifted,
      `these sources get a different routing block than startup: ${drifted.join(", ")}`,
    ).toEqual([]);
  });

  it("names the retrieval tools in the post-compaction block", () => {
    // The compaction path is where memory tools matter most — the model has
    // just lost the conversation and is about to re-derive what it already
    // knew. If the block that survives compaction does not name them, it is
    // the wrong block.
    const block = routingBlockOf(RUNS.get("compact")!.additionalContext);
    for (const tool of ["ctx_search", "ctx_find", "ctx_batch_execute", "ctx_execute"]) {
      expect(block, `post-compaction block never names ${tool}`).toContain(tool);
    }
  });
});
