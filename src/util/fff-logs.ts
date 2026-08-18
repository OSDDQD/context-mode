/**
 * Reap the log files the *external* `fff-mcp` server used to leave behind.
 *
 * That server wrote one file per run into the user's cache directory, named
 * `fff_mcp+<epoch>+<pid>.log`, and never deleted any of them. The fork replaced
 * it with the in-process library (`src/fff/`), so nothing writes those files
 * any more — the pile that is already on disk simply sits there forever.
 *
 * Deliberately narrow, because this deletes files nobody asked us to touch:
 *
 *   - one directory, never recursive, never following a symlink;
 *   - one exact name shape (`FFF_MCP_LOG_RE`) — a file called `fff_mcp.log`,
 *     or `fff_mcp+1+2.log.bak`, is left alone;
 *   - only regular files older than the age cutoff;
 *   - behind an env switch, and every error is swallowed per file.
 *
 * It rides the existing housekeeping path rather than inventing a scheduler:
 * `context-mode drain`, which the SessionEnd hook already spawns detached
 * (`hooks/sessionend.mjs`) once a session ends.
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { lstatSync, readdirSync, unlinkSync } from "node:fs";

/** `CONTEXT_MODE_FFF_LOG_SWEEP=0` keeps the orphaned logs. */
export const FFF_LOG_SWEEP_ENV = "CONTEXT_MODE_FFF_LOG_SWEEP" as const;
/** `CONTEXT_MODE_FFF_LOG_MAX_AGE_DAYS` — how old a log must be. */
export const FFF_LOG_MAX_AGE_ENV = "CONTEXT_MODE_FFF_LOG_MAX_AGE_DAYS" as const;
/** `CONTEXT_MODE_FFF_LOG_DIR` — absolute override of the cache directory. */
export const FFF_LOG_DIR_ENV = "CONTEXT_MODE_FFF_LOG_DIR" as const;

/** Default age cutoff, matching the 7-day horizon the session cleanup uses. */
export const FFF_LOG_DEFAULT_MAX_AGE_DAYS = 7;

/**
 * The one name shape we delete: `fff_mcp+<digits>+<digits>.log`.
 *
 * Anchored at both ends on purpose — the whole safety argument of this module
 * is that the pattern cannot widen into "anything with fff in the name".
 */
export const FFF_MCP_LOG_RE = /^fff_mcp\+\d+\+\d+\.log$/;

type Env = NodeJS.ProcessEnv;

function isOff(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "0" || v === "off" || v === "false" || v === "no" || v === "disabled";
}

/** On by default; `CONTEXT_MODE_FFF_LOG_SWEEP=0` switches it off. */
export function fffLogSweepEnabled(env: Env = process.env): boolean {
  return !isOff(env[FFF_LOG_SWEEP_ENV]);
}

/** Age cutoff in days. Non-numeric or negative values fall back to the default. */
export function fffLogMaxAgeDays(env: Env = process.env): number {
  const raw = Number.parseInt(env[FFF_LOG_MAX_AGE_ENV] ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : FFF_LOG_DEFAULT_MAX_AGE_DAYS;
}

/**
 * Where the external server wrote its logs: an explicit override, else
 * `XDG_CACHE_HOME`, else `~/.cache`. A non-absolute override is ignored rather
 * than fatal — the same rule the fff storage directory uses.
 */
export function fffLogDir(env: Env = process.env): string {
  const explicit = env[FFF_LOG_DIR_ENV];
  if (explicit && isAbsolute(explicit)) return explicit;
  const xdg = env.XDG_CACHE_HOME;
  if (xdg && isAbsolute(xdg)) return xdg;
  return join(env.HOME || env.USERPROFILE || homedir(), ".cache");
}

export interface FffLogSweepResult {
  dir: string;
  /** Files matching the pattern, whatever their age. */
  matched: number;
  removed: number;
  freedBytes: number;
  /** Set when the sweep did not run at all. */
  skipped?: "disabled" | "unreadable";
}

/**
 * Delete stale `fff_mcp+<ts>+<pid>.log` files. Returns what it did; never
 * throws, so a caller can fold it into a best-effort maintenance pass.
 */
export function sweepFffMcpLogs(
  opts: { dir?: string; env?: Env; maxAgeDays?: number; now?: number } = {},
): FffLogSweepResult {
  const env = opts.env ?? process.env;
  const dir = opts.dir ?? fffLogDir(env);
  const result: FffLogSweepResult = { dir, matched: 0, removed: 0, freedBytes: 0 };

  if (!fffLogSweepEnabled(env)) {
    result.skipped = "disabled";
    return result;
  }

  const maxAgeDays = opts.maxAgeDays ?? fffLogMaxAgeDays(env);
  const now = opts.now ?? Date.now();
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // No cache directory (fresh machine, Windows layout, sandboxed HOME).
    result.skipped = "unreadable";
    return result;
  }

  for (const name of entries) {
    if (!FFF_MCP_LOG_RE.test(name)) continue;
    result.matched++;
    const path = join(dir, name);
    try {
      // lstat, not stat: a symlink wearing the log's name is not a log.
      const st = lstatSync(path);
      if (!st.isFile()) continue;
      if (st.mtimeMs > cutoff) continue;
      unlinkSync(path);
      result.removed++;
      result.freedBytes += st.size;
    } catch { /* raced, or not ours to delete — leave it */ }
  }

  return result;
}
