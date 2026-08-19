import "../setup-home";
import { afterEach, afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code/index.js";
import { CodexAdapter } from "../../src/adapters/codex/index.js";
import { hashProjectDirCanonical } from "../../src/session/db.js";

/**
 * The storage contract every adapter owes: where session state goes, where
 * persistent memory goes, which of the two the universal override may move,
 * and what an adapter is NOT allowed to expose.
 *
 * This suite used to run against a synthetic `TestAdapter extends BaseAdapter`
 * constructed with `[".pi"]`, `[".gemini"]`, `[".omp"]` — it verified the base
 * class's DEFAULTS, which is to say it verified behaviour for adapters that
 * did not exist. Both surviving adapters override every one of those defaults
 * (claude-code roots at `$CLAUDE_CONFIG_DIR`, codex at `$CODEX_HOME` with a
 * `memories` folder), so the base class was folded into them and the same
 * assertions now run against the code that actually ships. That is the point
 * of the rewrite, not a side effect of it: the #649 override and the #663
 * project scoping had NO coverage against a real adapter before.
 */

const ADAPTERS = [
  {
    name: "claude-code",
    make: () => new ClaudeCodeAdapter() as unknown as StorageAdapter,
    configSegment: ".claude",
    memoryFolder: "memory",
    instructionFiles: ["CLAUDE.md"],
    /** Env vars that relocate this adapter's platform-native config root. */
    configEnv: ["CLAUDE_CONFIG_DIR"],
  },
  {
    name: "codex",
    make: () => new CodexAdapter() as unknown as StorageAdapter,
    configSegment: ".codex",
    memoryFolder: "memories",
    instructionFiles: ["AGENTS.md", "AGENTS.override.md"],
    configEnv: ["CODEX_HOME"],
  },
] as const;

interface StorageAdapter {
  getConfigDir(projectDir?: string): string;
  getSessionDir(): string;
  getMemoryDir(projectDir?: string): string;
  getInstructionFiles(): string[];
}

const DATA_DIR = "CONTEXT_MODE_DATA_DIR";

/**
 * A private root for the override cases, created per run and removed after.
 *
 * `getSessionDir()` mkdir's what it returns, so these tests write to disk.
 * They used to write to a hardcoded path under the system temp dir and leave
 * it behind: two checkouts on one machine, or two CI jobs on one runner,
 * shared the directory and nobody cleaned it. The path only has to be
 * absolute and outside the fake home — that is the whole point of the
 * override — so a per-run temp dir satisfies the contract and nothing else.
 */
let overrideRoot: string;

beforeAll(() => {
  overrideRoot = mkdtempSync(join(tmpdir(), "ctx-data-root-"));
});

afterAll(() => {
  rmSync(overrideRoot, { recursive: true, force: true });
});

/** Clear DATA_DIR plus every config-root override so $HOME is the only input. */
function withCleanEnv(keys: readonly string[]) {
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const k of [DATA_DIR, ...keys]) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

describe.each(ADAPTERS)(
  "$name — memory/config conventions",
  ({ make, configSegment, memoryFolder, instructionFiles, configEnv }) => {
    withCleanEnv(configEnv);

    it("getConfigDir is the platform-native root under $HOME", () => {
      expect(make().getConfigDir()).toBe(join(homedir(), configSegment));
    });

    it("getConfigDir returns an absolute path (HookAdapter contract)", () => {
      const dir = make().getConfigDir();
      expect(resolve(dir)).toBe(dir);
    });

    it("getInstructionFiles names the host's own rule files", () => {
      expect(make().getInstructionFiles()).toEqual([...instructionFiles]);
    });

    it("getMemoryDir defaults to <configDir>/<memoryFolder>", () => {
      expect(make().getMemoryDir()).toBe(
        join(homedir(), configSegment, memoryFolder),
      );
    });
  },
);

// Issue #649 — CONTEXT_MODE_DATA_DIR universal storage override.
//
// Adapters hardcode storage to `~/.<platform>/context-mode/sessions/` with no
// env-var escape hatch. CI runners, dev containers, and NFS-home users need to
// point context-mode storage at a writable volume without patching source or
// changing the host platform's own config-dir variable.
//
// Contract for CONTEXT_MODE_DATA_DIR:
//   - Unset / empty / whitespace-only → use platform-native default (no-op).
//   - Set                              → `<DATA_DIR>/context-mode/sessions/`
//                                        for getSessionDir(), and
//                                        `<DATA_DIR>/context-mode/<memoryFolder>/`
//                                        for getMemoryDir().
//   - Tilde + relative path handling mirrors `resolveClaudeConfigDir`
//     (~ expands to homedir, relative paths resolve against cwd).
//   - getConfigDir() is platform-native (settings.json, config.toml) and is
//     NOT relocated — only context-mode-owned state moves.
describe.each(ADAPTERS)(
  "$name — CONTEXT_MODE_DATA_DIR override (#649)",
  ({ make, configSegment, memoryFolder, configEnv }) => {
    withCleanEnv(configEnv);

    it("getSessionDir uses CONTEXT_MODE_DATA_DIR root when set (overrides homedir)", () => {
      process.env[DATA_DIR] = overrideRoot;
      expect(make().getSessionDir()).toBe(
        resolve(overrideRoot, "context-mode", "sessions"),
      );
    });

    it("getSessionDir falls back to <configDir>/context-mode/sessions when env unset", () => {
      expect(make().getSessionDir()).toBe(
        join(homedir(), configSegment, "context-mode", "sessions"),
      );
    });

    it("getSessionDir treats empty/whitespace env value as unset (safety guard)", () => {
      process.env[DATA_DIR] = "   ";
      expect(make().getSessionDir()).toBe(
        join(homedir(), configSegment, "context-mode", "sessions"),
      );
    });

    it("getSessionDir expands leading tilde against homedir (~/foo)", () => {
      process.env[DATA_DIR] = "~/relocated-storage";
      expect(make().getSessionDir()).toBe(
        resolve(homedir(), "relocated-storage", "context-mode", "sessions"),
      );
    });

    it("getMemoryDir relocates under the override, keeping the host's folder name", () => {
      process.env[DATA_DIR] = overrideRoot;
      expect(make().getMemoryDir()).toBe(
        resolve(overrideRoot, "context-mode", memoryFolder),
      );
    });

    it("getConfigDir is NOT relocated (platform-native settings stay put)", () => {
      process.env[DATA_DIR] = overrideRoot;
      // settings.json / config.toml belong with the platform install, not with
      // context-mode storage — relocating them would silently fork platform
      // behaviour from platform tooling. The override only moves
      // context-mode-owned state.
      expect(make().getConfigDir()).toBe(join(homedir(), configSegment));
    });
  },
);

// C2 narrowing — an adapter MUST NOT expose path helpers that are pure
// derivatives of `getSessionDir() + projectDir`. Those derivatives belong in
// `src/session/db.ts:resolveSessionDbPath` (single site of computation,
// case-fold migration, worktree-suffix handling). Exposing them on every
// adapter is a SHALLOW interface — its complexity equals its implementation —
// and tempts adapter authors to override for cargo-cult reasons (e.g. the
// pre-narrowing CodexAdapter override that just delegated to the same helper).
// Deletion test: collapses to ONE call site, complexity does NOT reappear in
// N callers.
describe.each(ADAPTERS)("$name — adapter-storage interface narrowing (C2)", ({ make }) => {
  it("does NOT expose getSessionDBPath — callers go through resolveSessionDbPath", () => {
    // Interrogate the runtime shape — the cast is intentional; we are pinning
    // that the public surface no longer carries this method.
    const adapter = make() as unknown as Record<string, unknown>;
    expect(adapter.getSessionDBPath).toBeUndefined();
  });

  it("does NOT expose getSessionEventsPath — events.md path lives in callers/server", () => {
    const adapter = make() as unknown as Record<string, unknown>;
    expect(adapter.getSessionEventsPath).toBeUndefined();
  });
});

// Issue #663 — auto-memory leaks across projects.
//
// Before this fix, `getMemoryDir()` ignored `projectDir` and every adapter
// returned a path shared by every project on the machine. Two terminals open in
// different repos read each other's memory files via searchAutoMemory().
//
// Contract for the scoped form:
//   - `getMemoryDir(projectDir)`                → `<base>/<hashProjectDirCanonical(projectDir)>`
//   - `getMemoryDir()` (legacy, no projectDir)  → `<base>` (unscoped) for backwards compat
//   - Two distinct projectDirs                  → two distinct paths
//   - Same projectDir on repeat calls           → identical path (deterministic)
//
// `CONTEXT_MODE_DATA_DIR` continues to relocate the root; the hash suffix sits
// underneath whichever root is active.
describe.each(ADAPTERS)(
  "$name — getMemoryDir project scoping (#663)",
  ({ make, configSegment, memoryFolder, configEnv }) => {
    withCleanEnv(configEnv);

    it("getMemoryDir(projectDir) appends hashProjectDirCanonical(projectDir)", () => {
      const projectDir = "/Users/test/projects/alpha";
      expect(make().getMemoryDir(projectDir)).toBe(
        join(
          homedir(),
          configSegment,
          memoryFolder,
          hashProjectDirCanonical(projectDir),
        ),
      );
    });

    it("two different projectDirs yield two different paths", () => {
      const adapter = make();
      expect(adapter.getMemoryDir("/Users/test/projects/alpha")).not.toBe(
        adapter.getMemoryDir("/Users/test/projects/beta"),
      );
    });

    it("same projectDir is deterministic across calls", () => {
      const adapter = make();
      const p = "/Users/test/projects/gamma";
      expect(adapter.getMemoryDir(p)).toBe(adapter.getMemoryDir(p));
    });

    it("getMemoryDir() without projectDir returns the legacy unscoped path", () => {
      expect(make().getMemoryDir()).toBe(
        join(homedir(), configSegment, memoryFolder),
      );
    });

    it("hash suffix lives under CONTEXT_MODE_DATA_DIR root when env is set", () => {
      process.env[DATA_DIR] = overrideRoot;
      const projectDir = "/Users/test/projects/delta";
      expect(make().getMemoryDir(projectDir)).toBe(
        join(
          resolve(overrideRoot),
          "context-mode",
          memoryFolder,
          hashProjectDirCanonical(projectDir),
        ),
      );
    });
  },
);
