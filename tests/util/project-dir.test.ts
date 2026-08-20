import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isPluginInstallPath,
  resolveProjectDir,
  resolveProjectDirFromTranscript,
} from "../../src/util/project-dir.js";

const cleanup: string[] = [];
const bunAvailable = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;

afterEach(() => {
  while (cleanup.length) {
    const p = cleanup.pop();
    if (p) try { rmSync(p, { recursive: true, force: true }); } catch {}
  }
});

function makeTranscriptsRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "ctx-transcripts-"));
  cleanup.push(d);
  return d;
}

function writeTranscript(root: string, encodedDir: string, sessionId: string, cwd: string, mtime?: Date) {
  const dir = join(root, encodedDir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  // Mirror Claude Code's transcript shape: line 1 = session metadata, line 2+ has cwd
  const lines = [
    JSON.stringify({ type: "session-meta", sessionId, permissionMode: "default" }),
    JSON.stringify({ type: "user", cwd, sessionId }),
  ];
  writeFileSync(file, lines.join("\n") + "\n");
  if (mtime) utimesSync(file, mtime, mtime);
  return file;
}

function compiledResolverScript(): string {
  const moduleUrl = pathToFileURL(join(process.cwd(), "build/util/project-dir.js")).href;
  return `
    import { resolveProjectDir } from ${JSON.stringify(moduleUrl)};
    const result = resolveProjectDir({
      env: {},
      cwd: "/Users/x/fallback",
      pwd: undefined,
      transcriptsRoot: "/nonexistent/transcripts"
    });
    console.log(result);
  `;
}

function runCompiledResolver(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: "utf-8",
    env: { ...process.env, PWD: "" },
  }).trim();
}

describe("isPluginInstallPath", () => {
  it("matches macOS / Linux plugin cache paths", () => {
    expect(isPluginInstallPath("/Users/x/.claude/plugins/cache/context-mode/context-mode/1.0.112")).toBe(true);
    expect(isPluginInstallPath("/home/x/.claude/plugins/cache/foo/foo/1.0.0")).toBe(true);
    expect(isPluginInstallPath("/Users/x/.codex/plugins/cache/context-mode/context-mode/1.0.151")).toBe(true);
    expect(isPluginInstallPath("/home/x/.codex/plugins/cache/foo/foo/1.0.0")).toBe(true);
  });

  it("matches plugin marketplace paths", () => {
    expect(isPluginInstallPath("/Users/x/.claude/plugins/marketplaces/context-mode")).toBe(true);
    expect(isPluginInstallPath("/Users/x/.codex/plugins/marketplaces/context-mode")).toBe(true);
  });

  it("matches Windows plugin cache paths (backslash + drive letter)", () => {
    expect(isPluginInstallPath("C:\\Users\\x\\.claude\\plugins\\cache\\foo\\foo\\1.0.0")).toBe(true);
    expect(isPluginInstallPath("C:\\Users\\x\\.codex\\plugins\\cache\\foo\\foo\\1.0.0")).toBe(true);
  });

  it("returns false for ordinary project paths", () => {
    expect(isPluginInstallPath("/Users/x/Server/proj")).toBe(false);
    expect(isPluginInstallPath("/home/x/work/proj")).toBe(false);
    expect(isPluginInstallPath("C:\\Users\\x\\proj")).toBe(false);
  });

  it("returns false for unrelated .claude subpaths (e.g. session storage)", () => {
    // This path is under .claude but NOT under .claude/plugins/* — must not match.
    expect(isPluginInstallPath("/Users/x/.claude/projects/-Users-x-proj")).toBe(false);
    expect(isPluginInstallPath("/Users/x/.claude/context-mode/sessions/abc.db")).toBe(false);
  });

  it("returns false for empty / null-ish inputs", () => {
    expect(isPluginInstallPath("")).toBe(false);
    expect(isPluginInstallPath("/")).toBe(false);
  });
});

describe("resolveProjectDir", () => {
  it("returns the first non-plugin env var in priority order", () => {
    const result = resolveProjectDir({
      env: {
        CLAUDE_PROJECT_DIR: "/Users/x/proj",
        CONTEXT_MODE_PROJECT_DIR: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0", // poisoned
      },
      cwd: "/some/cwd",
      pwd: undefined,
    });
    expect(result).toBe("/Users/x/proj");
  });

  it("rejects plugin path env vars and falls through to the next source", () => {
    const result = resolveProjectDir({
      env: {
        CLAUDE_PROJECT_DIR: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0",
        CONTEXT_MODE_PROJECT_DIR: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0",
      },
      cwd: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0",
      pwd: "/Users/x/Server/realproj",
    });
    expect(result).toBe("/Users/x/Server/realproj"); // PWD wins, skipping poisoned env + plugin cwd
  });

  it("rejects Codex plugin path env vars and falls through to the next source", () => {
    const result = resolveProjectDir({
      env: {
        CLAUDE_PROJECT_DIR: "/Users/x/.codex/plugins/cache/context-mode/context-mode/1.0.151",
        CONTEXT_MODE_PROJECT_DIR: "/Users/x/.codex/plugins/cache/context-mode/context-mode/1.0.151",
      },
      cwd: "/Users/x/.codex/plugins/cache/context-mode/context-mode/1.0.151",
      pwd: "/Users/x/Work/Dev/ucw",
    });
    expect(result).toBe("/Users/x/Work/Dev/ucw");
  });

  it("uses cwd as last resort when env + PWD are missing or all poisoned", () => {
    const result = resolveProjectDir({
      env: {},
      cwd: "/Users/x/proj",
      pwd: undefined,
    });
    expect(result).toBe("/Users/x/proj");
  });

  it("falls back to cwd EVEN IF cwd is plugin path when nothing else exists (no panics)", () => {
    // Last-resort behavior: rather than throw, return cwd. ctx_stats can detect
    // and render a "project context unavailable" message, but the function
    // itself stays total so other tools (sandbox execute, fetch) keep working.
    const result = resolveProjectDir({
      env: {},
      cwd: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0",
      pwd: undefined,
    });
    expect(result).toBe("/Users/x/.claude/plugins/cache/foo/foo/1.0.0");
  });

  // What used to stand here: "respects adapter-specific env vars
  // (GEMINI/VSCODE/OPENCODE/PI/IDEA) in the chain" plus two CURSOR_CWD cases.
  // Those five hosts are gone, and their variables were dropped from the
  // legacy chain — not as tidying, but because a variable left stale in the
  // user's shell by a host we no longer support could still re-root the
  // project here, on the one path that skips strict mode. The rule those
  // tests demonstrated is unchanged and is asserted below with the variables
  // that still exist.
  it("ignores workspace vars of removed hosts in the non-strict chain", () => {
    const result = resolveProjectDir({
      env: {
        GEMINI_PROJECT_DIR: "/leak/gemini",
        VSCODE_CWD: "/leak/vscode",
        OPENCODE_PROJECT_DIR: "/leak/opencode",
        PI_PROJECT_DIR: "/leak/pi",
        IDEA_INITIAL_DIRECTORY: "/leak/idea",
        CURSOR_CWD: "/leak/cursor",
      },
      cwd: "/x",
      pwd: "/Users/x/from-shell",
    });
    // None of them is a candidate any more, so the cascade reaches PWD.
    expect(result).toBe("/Users/x/from-shell");
  });

  // Issue #521 Slice 1 kept its subject: a workspace env var beats a cwd that
  // points at the plugin install dir (the /ctx-upgrade respawn case). Written
  // with CLAUDE_PROJECT_DIR, the one workspace var a live host publishes.
  it("respects a workspace env var over a plugin-path cwd", () => {
    const result = resolveProjectDir({
      env: { CLAUDE_PROJECT_DIR: "/Users/x/claude-proj" },
      cwd: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0", // plugin path → rejected
      pwd: undefined,
    });
    expect(result).toBe("/Users/x/claude-proj");
  });

  it("rejects a workspace env var that itself points at a plugin install path", () => {
    const result = resolveProjectDir({
      env: { CLAUDE_PROJECT_DIR: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0" },
      cwd: "/x",
      pwd: "/Users/x/realproj",
    });
    expect(result).toBe("/Users/x/realproj"); // PWD wins, poisoned env var skipped
  });
});

// ─────────────────────────────────────────────────────────
// Issue #545 — `strictPlatform` algorithmic mode.
//
// Under strict mode the candidate list is built from the platform's own
// workspace env vars + UNIVERSAL escape hatch — a foreign workspace var
// cannot win, regardless of cascade order. The resolver must contain ZERO
// hardcoded platform names: the candidate set is derived from
// PLATFORM_ENV_VARS, which is why the registry could shrink from seventeen
// rows to two without a line changing in src/util/project-dir.ts.
// ─────────────────────────────────────────────────────────

describe("resolveProjectDir — strictPlatform algorithmic mode (issue #545)", () => {
  it("strictPlatform=claude-code prefers CLAUDE_PROJECT_DIR over a leaked foreign var", () => {
    // The three cases that stood here used pi, qwen-code and gemini-cli. The
    // rule they demonstrated is unchanged and now has exactly one host that
    // declares a workspace var: whatever else is in the environment, strict
    // mode takes the platform's own.
    const result = resolveProjectDir({
      env: {
        // Left behind by a Cursor or Pi session in the same shell.
        CURSOR_CWD: "/leak/from/cursor-host",
        PI_PROJECT_DIR: "/leak/from/pi-host",
        CLAUDE_PROJECT_DIR: "/Users/x/own-claude-project",
      },
      cwd: "/some/cwd",
      pwd: undefined,
      strictPlatform: "claude-code",
    });
    expect(result).toBe("/Users/x/own-claude-project");
  });

  it("a platform with no workspace var of its own ignores every workspace var", () => {
    // Such a host passes cwd in hook stdin. Codex was the example until it
    // left; "unknown" has the same empty row and exercises the same branch.
    // So CLAUDE_PROJECT_DIR must lose even though it is the only live
    // workspace var in the registry, and the cascade falls to pwd.
    const result = resolveProjectDir({
      env: {
        CLAUDE_PROJECT_DIR: "/leak/from/claude-host",
        CURSOR_CWD: "/leak/from/cursor-host",
      },
      cwd: "/some/cwd",
      pwd: "/Users/x/from-shell",
      strictPlatform: "unknown",
    });
    expect(result).toBe("/Users/x/from-shell");
  });

  it("a platform with no workspace var falls through CONTEXT_MODE_PROJECT_DIR > pwd > cwd", () => {
    const result = resolveProjectDir({
      env: {
        // Foreign workspace vars leaked everywhere — none must win.
        CLAUDE_PROJECT_DIR: "/leak/cc",
        GEMINI_PROJECT_DIR: "/leak/gemini",
        VSCODE_CWD: "/leak/vscode",
        IDEA_INITIAL_DIRECTORY: "/leak/idea",
        PI_PROJECT_DIR: "/leak/pi",
        OPENCODE_PROJECT_DIR: "/leak/opencode",
        CURSOR_CWD: "/leak/cursor",
        // Universal escape hatch.
        CONTEXT_MODE_PROJECT_DIR: "/Users/x/escape",
      },
      cwd: "/some/cwd",
      pwd: undefined,
      strictPlatform: "unknown",
    });
    expect(result).toBe("/Users/x/escape");
  });

  it("non-strict mode preserves the EXACT legacy candidate order (semver lock)", () => {
    // The frozen part is the branch and the ORDER: a caller that names no
    // platform gets the historical cascade rather than an empty one. The
    // order is now CLAUDE_PROJECT_DIR > CONTEXT_MODE_PROJECT_DIR — the same
    // relative order it always had, with the removed hosts' slots gone.
    const env = {
      CLAUDE_PROJECT_DIR: "/p1",
      CONTEXT_MODE_PROJECT_DIR: "/p8",
    };
    // First wins.
    expect(resolveProjectDir({ env, cwd: "/x", pwd: undefined })).toBe("/p1");
    // Drop CLAUDE — the universal escape hatch wins.
    expect(resolveProjectDir({
      env: { ...env, CLAUDE_PROJECT_DIR: undefined },
      cwd: "/x", pwd: undefined,
    })).toBe("/p8");
    // A removed host's variable does not reopen a slot between the two.
    expect(resolveProjectDir({
      env: {
        GEMINI_PROJECT_DIR: "/p2",
        IDEA_INITIAL_DIRECTORY: "/p6",
        CONTEXT_MODE_PROJECT_DIR: "/p8",
      },
      cwd: "/x", pwd: undefined,
    })).toBe("/p8");
  });
});

describe("resolveProjectDirFromTranscript", () => {
  it("returns cwd from the most-recently-modified Claude Code transcript", () => {
    const root = makeTranscriptsRoot();
    writeTranscript(root, "-Users-x-old", "old-session", "/Users/x/old-proj", new Date(Date.now() - 60_000));
    writeTranscript(root, "-Users-x-new", "new-session", "/Users/x/new-proj", new Date());

    const result = resolveProjectDirFromTranscript({ projectsRoot: root });
    expect(result).toBe("/Users/x/new-proj");
  });

  it("returns undefined when projects dir does not exist", () => {
    const result = resolveProjectDirFromTranscript({ projectsRoot: "/nonexistent/path" });
    expect(result).toBeUndefined();
  });

  it("returns undefined when the newest transcript is older than maxAgeMs", () => {
    const root = makeTranscriptsRoot();
    const now = Date.now();
    writeTranscript(root, "-Users-x-stale", "stale-session", "/Users/x/stale-proj", new Date(now - 60_000));

    const result = resolveProjectDirFromTranscript({
      projectsRoot: root,
      maxAgeMs: 30_000,
      nowMs: now,
    });
    expect(result).toBeUndefined();
  });

  it("returns cwd when the newest transcript is within maxAgeMs", () => {
    const root = makeTranscriptsRoot();
    const now = Date.now();
    writeTranscript(root, "-Users-x-fresh", "fresh-session", "/Users/x/fresh-proj", new Date(now - 10_000));

    const result = resolveProjectDirFromTranscript({
      projectsRoot: root,
      maxAgeMs: 30_000,
      nowMs: now,
    });
    expect(result).toBe("/Users/x/fresh-proj");
  });

  it("returns undefined when no jsonl files exist", () => {
    const root = makeTranscriptsRoot();
    mkdirSync(join(root, "-Users-x-empty"), { recursive: true });
    const result = resolveProjectDirFromTranscript({ projectsRoot: root });
    expect(result).toBeUndefined();
  });

  it("skips transcripts without a cwd field in any of their first lines", () => {
    const root = makeTranscriptsRoot();
    const dir = join(root, "-Users-x-cwd-less");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "session.jsonl"),
      JSON.stringify({ type: "session-meta", sessionId: "s1" }) + "\n" +
      JSON.stringify({ type: "user", text: "hi" }) + "\n",
    );
    const result = resolveProjectDirFromTranscript({ projectsRoot: root });
    expect(result).toBeUndefined();
  });

  it("resolveProjectDir prefers transcript cwd over PWD when env is empty and cwd is plugin path", () => {
    const root = makeTranscriptsRoot();
    writeTranscript(root, "-Users-x-real", "active-session", "/Users/x/real-proj");

    const result = resolveProjectDir({
      env: {},
      cwd: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0", // plugin path → rejected
      pwd: "/Users/x", // home dir, not a real project
      transcriptsRoot: root,
    });
    expect(result).toBe("/Users/x/real-proj");
  });

  it("resolveProjectDir falls back to PWD when transcript yields nothing", () => {
    const result = resolveProjectDir({
      env: {},
      cwd: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0",
      pwd: "/Users/x/proj",
      transcriptsRoot: "/nonexistent/transcripts",
    });
    expect(result).toBe("/Users/x/proj");
  });

  it("resolveProjectDir falls back to PWD when transcript is stale", () => {
    const root = makeTranscriptsRoot();
    const now = Date.now();
    writeTranscript(root, "-Users-x-stale", "stale-session", "/Users/x/stale-proj", new Date(now - 60_000));

    const result = resolveProjectDir({
      env: {},
      cwd: "/Users/x",
      pwd: "/Users/x",
      transcriptsRoot: root,
      transcriptMaxAgeMs: 30_000,
      nowMs: now,
    });
    expect(result).toBe("/Users/x");
  });

  it("compiled ESM resolver runs under Node without CommonJS require", () => {
    const output = runCompiledResolver(process.execPath, [
      "--input-type=module",
      "-e",
      compiledResolverScript(),
    ]);

    expect(output).toBe("/Users/x/fallback");
  });

  it.runIf(bunAvailable)("compiled ESM resolver runs under Bun without CommonJS require", () => {
    const output = runCompiledResolver("bun", ["-e", compiledResolverScript()]);

    expect(output).toBe("/Users/x/fallback");
  });
});
