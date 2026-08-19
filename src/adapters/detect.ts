/**
 * adapters/detect — Auto-detect which platform is running.
 *
 * Detection priority:
 *   1. Environment variables (high confidence)
 *   2. Config directory existence (medium confidence)
 *   3. Fallback to Claude Code (low confidence — most common)
 *
 * Verified env vars per platform (from source code audit):
 *   - Claude Code:    CLAUDE_CODE_ENTRYPOINT, CLAUDE_PLUGIN_ROOT,
 *                     CLAUDE_PROJECT_DIR, CLAUDE_SESSION_ID | ~/.claude/
 *   - Codex CLI:      CODEX_CI, CODEX_THREAD_ID | ~/.codex/
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

import type { PlatformId, DetectionSignal, HookAdapter } from "./types.js";
import { CLIENT_NAME_TO_PLATFORM } from "./client-map.js";

/**
 * Tag for each PLATFORM_ENV_VARS row.
 *   - `workspace`: env var names a project/working directory. Used by
 *     `resolveProjectDir({ strictPlatform })` to form the candidate list,
 *     and when scrubbing a foreign workspace var off a spawned child.
 *   - `identification`: env var only signals which host is running; carries
 *     no project path. PRESERVED in normal operation (some are load-bearing
 *     for hook integrations on the host that owns them, e.g. CLAUDE_PLUGIN_ROOT
 *     for Claude Code's hook context).
 *
 * Issue #545 — algorithmic env-leak fix. The split allows resolveProjectDir
 * to derive ALLOW (own workspace vars) and BAN (other platforms' workspace
 * vars) sets from a single registry rather than a per-adapter list.
 *
 * Issue #561 — FOREIGN identification vars MUST be scrubbed when spawning a
 * child under a different host, or detectPlatform() in the child resolves to
 * whichever host merely left a variable behind and writes its session data
 * into that host's storage root. See `foreignIdentificationEnv()` below.
 */
export type EnvVarRole = "workspace" | "identification";
export interface PlatformEnvEntry {
  readonly name: string;
  readonly role: EnvVarRole;
  /**
   * When `false`, this entry is NOT used as a high-confidence detection
   * signal — only consumed by `workspaceEnvVarsFor`/`foreignWorkspaceEnv`
   * (project-dir cascade and bridge env scrub). Use for consumer-set
   * workspace vars that the host runtime never emits itself, so that a
   * stale env var on an unrelated host does not misclassify the platform.
   * Default: `true` (entry participates in detection).
   *
   * Issue #542 — the flag was introduced for consumer-set workspace vars
   * (PI_PROJECT_DIR and friends) that must not trigger detection on their
   * own. Neither remaining host has such a var, so nothing sets it today;
   * the field stays because the hazard returns with the next host that
   * documents a workspace override its runtime does not emit.
   */
  readonly detect?: boolean;
}

/**
 * High-confidence env vars per platform, checked in priority order.
 * Single source of truth — consumed by detectPlatform() below, by
 * `resolveProjectDir({ strictPlatform })` for cascade construction, and by
 * the foreign-env scrub below. Tests also iterate this map to clear
 * platform-related env vars deterministically.
 *
 * The map shape is `Map<PlatformId, ReadonlyArray<PlatformEnvEntry>>`. Use
 * `getEnvVarNames(p)` to get just the names (legacy `string[]` shape).
 */
const _PLATFORM_ENV_VARS_RAW: ReadonlyArray<readonly [PlatformId, readonly PlatformEnvEntry[]]> = [
  // Two rows since the fifteen-host removal. The ordering rule that governed
  // this table — forks listed BEFORE the fork's parent, so a Cursor or
  // Antigravity session was not claimed by the VS Code vars it inherits — has
  // no work left to do: neither remaining host is a fork of the other, and
  // their vars share no prefix. Entries stay verified against each platform's
  // own runtime source.
  //
  // Claude Code — verified against a live `env` dump (2026-05-11):
  //   CLAUDE_CODE_ENTRYPOINT=cli               (set on every CC session)
  //   CLAUDE_PLUGIN_ROOT=/Users/.../<version>  (set when a plugin is loaded)
  //   CLAUDE_PROJECT_DIR=/Users/.../project    (set in hooks context)
  //   CLAUDE_SESSION_ID=<uuid>                 (legacy session marker)
  ["claude-code", [
    { name: "CLAUDE_CODE_ENTRYPOINT", role: "identification" },
    { name: "CLAUDE_PLUGIN_ROOT",     role: "identification" },
    { name: "CLAUDE_PROJECT_DIR",     role: "workspace" },
    { name: "CLAUDE_SESSION_ID",      role: "identification" },
  ]],
  // codex — openai/codex codex-rs/core/src/exec_env.rs sets CODEX_THREAD_ID
  // per exec; unified_exec/process_manager.rs sets CODEX_CI in CI mode.
  // No workspace var: Codex passes cwd in hook stdin.
  ["codex", [
    { name: "CODEX_THREAD_ID", role: "identification" },
    { name: "CODEX_CI",        role: "identification" },
  ]],
];

export const PLATFORM_ENV_VARS: ReadonlyMap<PlatformId, readonly PlatformEnvEntry[]> = new Map(
  _PLATFORM_ENV_VARS_RAW,
);

/**
 * Backwards-compat shim: legacy `string[]` shape used by detection logic and
 * by tests that iterate the registry to clear env vars. Always returns the
 * names in registry order.
 */
export function getEnvVarNames(platform: PlatformId): string[] {
  return (PLATFORM_ENV_VARS.get(platform) ?? []).map((e) => e.name);
}

/**
 * Issue #545 — return only role=workspace env var names for a platform, in
 * registry order. Empty array for a platform with no workspace var — Codex,
 * which passes cwd in hook stdin instead. Consumed by
 * `resolveProjectDir({ strictPlatform })` to build the cascade.
 */
export function workspaceEnvVarsFor(platform: PlatformId): string[] {
  return (PLATFORM_ENV_VARS.get(platform) ?? [])
    .filter((e) => e.role === "workspace")
    .map((e) => e.name);
}

/**
 * Issue #545 — return the union of workspace env vars from ALL platforms
 * EXCEPT the given one, so a caller can strip another host's notion of the
 * workspace before it is mistaken for its own.
 *
 * Its original consumer, Pi's MCP bridge, is gone with the fifteen removed
 * hosts. The rule it enforced is not: a Codex session started from a shell
 * where Claude Code exported CLAUDE_PROJECT_DIR still has to ignore that
 * variable, and this is where that answer comes from.
 */
export function foreignWorkspaceEnv(platform: PlatformId): Set<string> {
  const ban = new Set<string>();
  for (const [p, vars] of PLATFORM_ENV_VARS) {
    if (p === platform) continue;
    for (const v of vars) {
      if (v.role === "workspace") ban.add(v.name);
    }
  }
  return ban;
}

/**
 * Issue #561 — return the union of identification env vars from ALL
 * platforms EXCEPT the given one. Sibling of `foreignWorkspaceEnv`,
 * filtered on `role === "identification"` instead of "workspace".
 *
 * The failure it prevents: a child spawned under one host inherits the shell
 * env of whatever else is running, and `detectPlatform()` walks the registry
 * in order. A stray CLAUDE_CODE_ENTRYPOINT is enough to make a Codex child
 * write its session data into `~/.claude/context-mode/`. Scrubbing the OTHER
 * host's identification vars while keeping its own is what stops that.
 */
export function foreignIdentificationEnv(platform: PlatformId): Set<string> {
  const ban = new Set<string>();
  for (const [p, vars] of PLATFORM_ENV_VARS) {
    if (p === platform) continue;
    for (const v of vars) {
      if (v.role === "identification") ban.add(v.name);
    }
  }
  return ban;
}

/**
 * Sync map from platform identifier → home-relative path segments where that
 * platform stores its config. Mirrors the `super([...])` argument passed by
 * each adapter — kept in sync as the single source of truth used when we need
 * a session dir BEFORE an adapter has been instantiated (race window between
 * MCP server start and `initialize` handshake completion).
 *
 * `src/session/analytics.ts` keeps a second copy of this map for the stats
 * report, which cannot import an adapter. Two entries each, and they have to
 * agree.
 *
 * Returns `null` for "unknown" or any string outside the supported set so the
 * caller can decide on a safe fallback.
 */
export function getSessionDirSegments(platform: string): string[] | null {
  switch (platform) {
    case "claude-code":      return [".claude"];
    case "codex":            return [".codex"];
    default:                 return null;
  }
}

/**
 * Detect the current platform by checking env vars and config dirs.
 *
 * @param clientInfo - Optional MCP clientInfo from initialize handshake.
 *   When provided, takes highest priority (zero-config detection).
 */
export function detectPlatform(clientInfo?: { name: string; version?: string }): DetectionSignal {
  // ── Highest priority: MCP clientInfo ──────────────────
  if (clientInfo?.name) {
    const platform = CLIENT_NAME_TO_PLATFORM[clientInfo.name];
    if (platform) {
      return {
        platform,
        confidence: "high",
        reason: `MCP clientInfo.name="${clientInfo.name}"`,
      };
    }
  }

  // ── Explicit platform override ────────────────────────
  const platformOverride = process.env.CONTEXT_MODE_PLATFORM;
  if (platformOverride) {
    const validPlatforms: PlatformId[] = ["claude-code", "codex"];
    if (validPlatforms.includes(platformOverride as PlatformId)) {
      return {
        platform: platformOverride as PlatformId,
        confidence: "high",
        reason: `CONTEXT_MODE_PLATFORM=${platformOverride} override`,
      };
    }
  }

  // ── High confidence: environment variables ─────────────

  for (const [platform, vars] of PLATFORM_ENV_VARS) {
    if (vars.some((v) => v.detect !== false && process.env[v.name])) {
      return {
        platform,
        confidence: "high",
        reason: `${vars.filter((v) => v.detect !== false).map((v) => v.name).join(" or ")} env var set`,
      };
    }
  }

  // ── Medium confidence: config directory existence ──────

  const home = homedir();

  // Two roots left, and they cannot collide: a machine with both ~/.claude and
  // ~/.codex is a machine running both, and the env tier above has already
  // spoken for whichever one is actually hosting this process. The elaborate
  // ordering this block used to carry — CLI agents probed before host IDEs
  // (#542), `agy` and Copilot CLI probed before the generic ~/.claude and
  // ~/.gemini fallbacks (#774) — existed to break exactly the ties that no
  // longer exist. Claude Code first because it is the default the low-
  // confidence tier falls back to anyway.
  if (existsSync(resolve(home, ".claude"))) {
    return {
      platform: "claude-code",
      confidence: "medium",
      reason: "~/.claude/ directory exists",
    };
  }

  if (existsSync(resolve(home, ".codex"))) {
    return {
      platform: "codex",
      confidence: "medium",
      reason: "~/.codex/ directory exists",
    };
  }

  // ── Low confidence: fallback ───────────────────────────

  return {
    platform: "claude-code",
    confidence: "low",
    reason: "No platform detected, defaulting to Claude Code",
  };
}

/**
 * Get the adapter instance for a given platform.
 * Lazily imports platform-specific adapter modules.
 */
export async function getAdapter(platform?: PlatformId): Promise<HookAdapter> {
  const target = platform ?? detectPlatform().platform;

  switch (target) {
    case "codex": {
      const { CodexAdapter } = await import("./codex/index.js");
      return new CodexAdapter();
    }

    case "claude-code":
    default: {
      // Unknown platform falls back to Claude Code: the MCP server works
      // everywhere, and its hooks are the ones a foreign host is most likely
      // to understand. This is also why the fifteen removed adapters do not
      // need a migration path — a session on one of them lands here.
      const { ClaudeCodeAdapter } = await import("./claude-code/index.js");
      return new ClaudeCodeAdapter();
    }
  }
}
