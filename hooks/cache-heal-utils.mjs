// cache-heal-utils.mjs — fixes Brew-node-upgrade stale path bug
//
// Problem: start.mjs writes process.execPath into ~/.claude/settings.json
// when registering the cache-heal hook. On Brew, process.execPath returns
// the *versioned* Cellar snapshot:
//
//   /opt/homebrew/Cellar/node/25.9.0_2/bin/node
//
// When Brew upgrades Node, that path disappears and Claude fails to spawn
// the hook ("session start" error). The stable symlink is:
//
//   /opt/homebrew/bin/node
//
// Fix is two layered:
//   A) New installs on Unix: write hook script with `#!/usr/bin/env node`
//      shebang + chmod +x, register hook command as the bare script path.
//      `env` resolves node from PATH at runtime — survives any Node upgrade.
//      Windows keeps the explicit-execPath form (no shebang support).
//   B) Self-heal: every MCP boot, scan ~/.claude/settings.json for an
//      existing cache-heal hook command whose leading node path no longer
//      exists. If stale, rewrite using pattern (A).
//
// This module is pure (no global state) and side-effect free except for
// the explicit selfHealCacheHealHook() entry point that touches disk.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  statSync,
  readdirSync,
  renameSync,
  unlinkSync,
  lstatSync,
  realpathSync,
  symlinkSync,
  mkdirSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Convert any path string to forward slashes (matches normalize-hooks style,
 * keeps round-trips on Windows safe).
 */
function fwd(p) {
  return String(p).replace(/\\/g, "/");
}

/**
 * Extract the leading executable path from a hook command string IF it
 * looks like a node binary. Returns null when the command is shebang-style
 * (bare script path) or when the leading executable isn't node.
 *
 * Accepted shapes:
 *   '"/abs/path/to/node" "/abs/path/script.mjs"'
 *   '/abs/path/to/node "/abs/path/script.mjs"' (unquoted node)
 *
 * Returns null for:
 *   '"/abs/path/script.mjs"'                    (shebang form)
 *   '"/usr/bin/python3" "/abs/path/script.py"'  (not node)
 */
export function extractNodePath(cmd) {
  if (!cmd || typeof cmd !== "string") return null;
  const trimmed = cmd.trim();
  if (!trimmed) return null;

  // Match: optional quote, capture path until matching quote or whitespace.
  let leading;
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end === -1) return null;
    leading = trimmed.slice(1, end);
  } else {
    const end = trimmed.search(/\s/);
    leading = end === -1 ? trimmed : trimmed.slice(0, end);
  }

  if (!leading) return null;

  // Only treat as a node path if the basename is a node binary.
  // Match: "node", "node.exe" (case-insensitive on Windows-style names).
  const base = leading.split(/[\\/]/).pop() ?? "";
  if (!/^node(\.exe)?$/i.test(base)) return null;

  return leading;
}

/**
 * True when the hook command's leading node path no longer exists on disk.
 * Returns false for shebang-style commands (no node prefix to validate).
 */
export function isStaleNodePath(cmd) {
  const nodePath = extractNodePath(cmd);
  if (!nodePath) return false;
  try {
    return !existsSync(nodePath);
  } catch {
    return false;
  }
}

/**
 * Build a cross-platform hook command for the cache-heal script.
 *
 * On Unix (anything except win32):
 *   - Returns just the script path (double-quoted), e.g. '"/path/to/script.mjs"'
 *   - Caller MUST ensure the script has `#!/usr/bin/env node` shebang and
 *     chmod 0o755.
 *   - `env` resolves node from PATH at runtime → survives Brew/asdf/nvm
 *     upgrades.
 *
 * On Windows:
 *   - Returns '"<nodePath>" "<scriptPath>"' (forward slashes, both quoted).
 *   - Windows has no shebang support; we must invoke node explicitly.
 */
export function buildHookCommand({ scriptPath, platform, nodePath }) {
  if (!scriptPath || typeof scriptPath !== "string") {
    throw new TypeError("buildHookCommand: scriptPath is required");
  }
  const safeScript = fwd(scriptPath);
  if (platform === "win32") {
    if (!nodePath || typeof nodePath !== "string") {
      throw new TypeError(
        "buildHookCommand: nodePath is required on win32",
      );
    }
    const safeNode = fwd(nodePath);
    return `"${safeNode}" "${safeScript}"`;
  }
  return `"${safeScript}"`;
}

/**
 * Self-heal step for ~/.claude/settings.json.
 *
 * - Looks at SessionStart hooks for any registered cache-heal hook.
 * - If its command has a stale node path (Brew upgrade scenario),
 *   rewrites the command using buildHookCommand() — Unix gets shebang
 *   form, Windows gets explicit nodePath form.
 * - No-op when:
 *     * settings.json doesn't exist
 *     * no cache-heal hook is registered
 *     * the hook command is already valid (path exists or shebang form)
 * - On Unix, also re-asserts the script's shebang + chmod +x so a healed
 *   command actually works.
 *
 * Returns: one of "noop" | "healed" | "missing-settings" — useful for
 * tests and telemetry.
 *
 * Best-effort — all I/O is wrapped; never throws.
 */
export function selfHealCacheHealHook({
  settingsPath,
  scriptPath,
  platform,
  nodePath,
}) {
  if (!settingsPath || !existsSync(settingsPath)) return "missing-settings";

  let raw;
  try {
    raw = readFileSync(settingsPath, "utf-8");
  } catch {
    return "noop";
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "noop";
  }

  const hooks = parsed?.hooks;
  if (!hooks || typeof hooks !== "object") return "noop";
  const sessionStart = Array.isArray(hooks.SessionStart)
    ? hooks.SessionStart
    : null;
  if (!sessionStart) return "noop";

  let healed = false;
  for (const matcher of sessionStart) {
    const inner = matcher?.hooks;
    if (!Array.isArray(inner)) continue;
    for (const h of inner) {
      if (typeof h?.command !== "string") continue;
      if (!h.command.includes("context-mode-cache-heal")) continue;
      if (!isStaleNodePath(h.command)) continue;

      // Stale → rewrite.
      h.command = buildHookCommand({ scriptPath, platform, nodePath });
      healed = true;
    }
  }

  if (!healed) return "noop";

  // Unix: re-assert shebang + chmod so the bare-script command works.
  if (platform !== "win32" && scriptPath && existsSync(scriptPath)) {
    try {
      ensureShebangAndExecBit(scriptPath);
    } catch {
      /* best effort */
    }
  }

  try {
    writeFileSync(
      settingsPath,
      JSON.stringify(parsed, null, 2) + "\n",
      "utf-8",
    );
  } catch {
    return "noop";
  }
  return "healed";
}

/**
 * Issue #710 — heal Claude Code's per-session shell snapshots.
 *
 * Claude Code writes a per-session snapshot at boot:
 *   ~/.claude/shell-snapshots/snapshot-<shell>-<ts>-<rand>.sh
 * Every Bash tool call `source`s that snapshot to reproduce the user env
 * (refs/platforms/claude-code/src/utils/bash/ShellSnapshot.ts:269-336;
 * sourced before every Bash tool call at bashProvider.ts:166). The snapshot
 * bakes an `export PATH='…'` line containing the active context-mode
 * `bin/` for the then-current cache version, e.g.
 *   …/.claude/plugins/cache/context-mode/context-mode/1.0.146/bin
 *
 * /ctx-upgrade installs the new version and deletes the old cache dir
 * mid-session, but it never touches the snapshot — so every subsequent
 * Bash tool call fails with "Plugin directory does not exist: …/1.0.146"
 * until the session restarts.
 *
 * This helper rewrites the version segment of every context-mode PATH
 * entry in every snapshot under `snapshotsDir` to `currentVersion`.
 * Anchored on the doubled `context-mode/context-mode/` segment so sibling
 * plugins (`pm-skills/pm-toolkit`, `claude-adhd/claude-adhd`, …) and
 * shape-spoofing entries (`evil-owner/context-mode/1.0.146`) are
 * untouched.
 *
 * Layered like cache-heal-utils' brew-node fix:
 *   Layer 1 — /ctx-upgrade calls this after install (cli.ts) so the
 *             session that just upgraded sees the new bin on the next
 *             Bash call.
 *   Layer 2 — SessionStart hook calls this on every boot so a session
 *             that started before /ctx-upgrade ran still self-heals.
 *
 * Write contract:
 *   - Atomic: write to `<file>.tmp-<pid>-<ts>` then rename. Snapshots
 *     are `source`d concurrently; a half-written file would crash the
 *     bash subprocess mid-call.
 *   - Idempotent: a snapshot already on `currentVersion` is not
 *     re-written (mtime preserved). A snapshot with no context-mode
 *     entry is not re-written.
 *   - Best-effort: every I/O is wrapped; never throws. Telemetry shape
 *     is `{ rewritten: string[] }` for caller logging.
 *   - Cross-platform: handles both unix (`/Users/x/.claude/…`),
 *     Cygwin/Git Bash (`/c/Users/x/.claude/…`), and Windows native
 *     (`C:\Users\x\.claude\…`) path variants. ShellSnapshot.ts
 *     writes paths using whatever shell wrote them, so all three
 *     shapes can appear depending on the user's shell environment.
 */
export function rewriteShellSnapshots({ snapshotsDir, currentVersion }) {
  const out = { rewritten: [] };
  if (
    !snapshotsDir ||
    typeof snapshotsDir !== "string" ||
    !currentVersion ||
    typeof currentVersion !== "string"
  ) {
    return out;
  }
  let entries;
  try {
    if (!existsSync(snapshotsDir)) return out;
    entries = readdirSync(snapshotsDir);
  } catch {
    return out;
  }

  // Match the version segment of any PATH entry of the form
  //   …/plugins/cache/context-mode/context-mode/<VERSION>/bin
  // across all three path shapes (`/`, `\`, mixed). The doubled
  // `context-mode/context-mode/` is the trust anchor — it prevents
  // shape-spoofing from another owner.
  //
  // Captures:
  //   $1 — separator-tolerant prefix up to and including the second
  //        `context-mode` segment + its trailing separator
  //   $2 — version segment (no separators)
  //   $3 — trailing separator + `bin`
  const versionSegmentRe =
    /(context-mode[/\\]context-mode[/\\])([^/\\]+)([/\\]bin)/g;

  for (const name of entries) {
    if (!name.endsWith(".sh")) continue;
    const file = join(snapshotsDir, name);
    let content;
    try {
      const st = statSync(file);
      if (!st.isFile()) continue;
      content = readFileSync(file, "utf-8");
    } catch {
      // Binary, unreadable, or vanished — skip.
      continue;
    }

    let touched = false;
    const next = content.replace(
      versionSegmentRe,
      (whole, prefix, version, suffix) => {
        if (version === currentVersion) return whole;
        touched = true;
        return `${prefix}${currentVersion}${suffix}`;
      },
    );
    if (!touched) continue;

    // Atomic rename — never write directly to `file` because the
    // snapshot may be sourced by a concurrent Bash subprocess.
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(tmp, next, "utf-8");
      renameSync(tmp, file);
      out.rewritten.push(file);
    } catch {
      // Best-effort cleanup of the tmp file; never throw.
      try {
        unlinkSync(tmp);
      } catch {
        /* best effort */
      }
    }
  }

  return out;
}

/**
 * Issue #710 Layer 2 — self-heal entry point for SessionStart.
 *
 * Resolves the snapshots directory + current version from the live
 * environment (or accepts explicit overrides for tests) and delegates to
 * `rewriteShellSnapshots`. Wrap-and-swallow; never throws.
 *
 * `pluginCacheRoot` is accepted to match the cache-heal-utils precedent
 * surface but not yet used (the version segment alone is sufficient for
 * the regex match — we don't need to walk the cache to know the right
 * answer; the cli passes the version it just installed). Kept in the
 * shape for forward-compat if a future heal pass needs to cross-check
 * the on-disk symlink target.
 */
export function selfHealShellSnapshots({
  snapshotsDir,
  pluginCacheRoot: _pluginCacheRoot,
  currentVersion,
}) {
  return rewriteShellSnapshots({ snapshotsDir, currentVersion });
}

/**
 * Ensure a script starts with `#!/usr/bin/env node` and has 0o755 mode.
 * Idempotent — leaves correctly-shebanged scripts unchanged.
 */
export function ensureShebangAndExecBit(scriptPath) {
  if (!scriptPath || !existsSync(scriptPath)) return;
  try {
    const content = readFileSync(scriptPath, "utf-8");
    if (!content.startsWith("#!")) {
      writeFileSync(scriptPath, `#!/usr/bin/env node\n${content}`, "utf-8");
    }
    // statSync().mode lower 9 bits = perms.
    const mode = statSync(scriptPath).mode & 0o777;
    if (mode !== 0o755) {
      chmodSync(scriptPath, 0o755);
    }
  } catch {
    /* best effort */
  }
}

// ─────────────────────────────────────────────────────────
// Plugin cache symlink heal (anthropics/claude-code#46915, follow-up)
// ─────────────────────────────────────────────────────────
//
// What a real machine looked like, and how the old heal built it:
//
//   ~/.claude/plugins/cache/context-mode/context-mode/ contained NOTHING but
//   symlinks — `1.0.171 -> 1.0.169` and `1.0.169 -> 1.0.171`, a two-node
//   cycle, plus seven older version names pointing into it. Meanwhile
//   installed_plugins.json named 1.0.173, which existed nowhere. Claude Code
//   could not resolve the plugin at all: the session came up with ZERO ctx_*
//   tools and nothing in the UI said so.
//
// Two wrong primitives produced that state, and re-produced it every boot:
//
//   1. The version list was filtered by NAME only (`/^\d+\.\d+/`), so a
//      symlink named like a version counted as a version directory. "Newest"
//      could therefore BE a symlink, and pointing a missing version at it
//      created a symlink-to-symlink — one more edge of the eventual cycle.
//   2. `existsSync()` FOLLOWS symlinks. A cyclic link answers ELOOP and a
//      dangling one ENOENT, so both read as "missing" — and the heal
//      cheerfully re-created the exact link that was the problem.
//
// The rules below are the fix. They are the single source of truth for BOTH
// heal sites: this module (imported by start.mjs's Self-heal Layer 1) and
// CACHE_HEAL_HOOK_SOURCE further down — the standalone script deployed into
// <config>/hooks/, which cannot import from a plugin directory that may
// itself be the broken thing, and therefore restates these rules inline.
// Change one, change the other; tests/hooks/cache-heal-symlink-cycle.test.ts
// exercises both against the same fixtures.
//
//   R1. A heal target must be a REAL directory: lstat says directory AND not
//       a symlink, it holds `start.mjs`, and its `.claude-plugin/plugin.json`
//       parses. A tree missing either file cannot boot, so linking at it only
//       moves the failure one step later.
//   R2. A symlink is never a target. Resolve to the real directory first, so
//       no link this code writes can ever point at another link.
//   R3. A link that will not resolve (ELOOP = cycle, ENOENT = dangling) is
//       REMOVED, never re-created.
//   R4. A real directory is never removed. Only symlinks are.
//   R5. With no real version directory anywhere, the heal does nothing.
//       Inventing a link with nothing real to point at is how the cycle above
//       was born in the first place.

/**
 * What a name inside the versions directory actually is, judged WITHOUT
 * following symlinks.
 *
 *   "missing" — nothing there
 *   "dir"     — a real directory (never removed — R4)
 *   "alias"   — a symlink that resolves to something
 *   "broken"  — a symlink whose realpath fails: ELOOP (cycle) or ENOENT
 *   "other"   — a file, socket, … — not ours to touch
 */
export function cacheEntryState(p) {
  if (!p || typeof p !== "string") return "missing";
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return "missing";
  }
  // The symlink test comes first on purpose: a Windows junction reports BOTH
  // isDirectory() and isSymbolicLink() true, and reading one as a real dir
  // would let R2 write a link pointing at a link.
  if (st.isSymbolicLink()) {
    try {
      realpathSync(p);
      return "alias";
    } catch {
      return "broken";
    }
  }
  return st.isDirectory() ? "dir" : "other";
}

/** R1 — a directory this heal is allowed to point at. */
export function isRealPluginDir(p) {
  if (cacheEntryState(p) !== "dir") return false;
  // start.mjs is what the host spawns; plugin.json is what it keys the plugin
  // on. A tree carrying up-to-date files but neither of these is a partial
  // unpack, and pointing a version name at it is how "plugin loaded, zero
  // tools" happens.
  if (!existsSync(join(p, "start.mjs"))) return false;
  try {
    const manifest = JSON.parse(
      readFileSync(join(p, ".claude-plugin", "plugin.json"), "utf-8"),
    );
    return !!manifest && typeof manifest === "object";
  } catch {
    return false;
  }
}

/**
 * R2 — the real directory behind `p`, or null.
 *
 * realpathSync resolves the WHOLE chain, so a candidate reached through a
 * symlinked ancestor still yields a path no further link has to be followed
 * from. Null when it does not resolve or is not a usable plugin tree.
 */
export function realPluginDirOrNull(p) {
  if (!p || typeof p !== "string") return null;
  let real;
  try {
    real = realpathSync(p);
  } catch {
    return null;
  }
  return isRealPluginDir(real) ? real : null;
}

/** Numeric ordering of version directory names; missing segments sort as 0. */
export function compareVersionNames(a, b) {
  const pa = String(a).split(".").map((n) => Number.parseInt(n, 10));
  const pb = String(b).split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const va = Number.isFinite(pa[i]) ? pa[i] : 0;
    const vb = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/**
 * Newest REAL plugin directory under `parent` (R1 + R2), or null (R5).
 *
 * The name filter is the cheap pre-pass; `isRealPluginDir` is the one that
 * decides. That ordering matters — the old code stopped at the name, which is
 * precisely how a symlink became "newest".
 */
export function newestRealPluginDir(parent) {
  let names;
  try {
    names = readdirSync(parent);
  } catch {
    return null;
  }
  const real = names.filter(
    (n) => /^\d+\.\d+/.test(n) && isRealPluginDir(join(parent, n)),
  );
  if (real.length === 0) return null;
  real.sort(compareVersionNames);
  return realPluginDirOrNull(join(parent, real[real.length - 1]));
}

/**
 * R3 — remove every symlink under `parent` that cannot be resolved.
 *
 * This is what actually clears a `1.0.171 -> 1.0.169 -> 1.0.171` cycle: both
 * members answer ELOOP, both go. Real directories are never candidates (R4),
 * and `unlinkSync` on a symlink removes the link, never what it pointed at.
 *
 * Returns the paths removed — callers log it, tests assert on it.
 */
export function pruneBrokenPluginAliases(parent) {
  const removed = [];
  let names;
  try {
    names = readdirSync(parent);
  } catch {
    return removed;
  }
  for (const name of names) {
    const p = join(parent, name);
    if (cacheEntryState(p) !== "broken") continue;
    try {
      unlinkSync(p);
      removed.push(p);
    } catch {
      /* best effort — a link we cannot remove is still better left reported */
    }
  }
  return removed;
}

/**
 * Point one registry `installPath` at a real tree — or leave it alone.
 *
 * `preferredTarget` is the caller's own tree (start.mjs passes `__dirname`:
 * it is executing from there, so it is known-good by construction). It is
 * still put through R1/R2 rather than trusted, because a plugin root reached
 * through an alias must not become the target of another alias.
 *
 * Returns, for logging and tests:
 *   "skipped"       — no usable installPath
 *   "outside-cache" — refused: the path is not inside this host's plugin cache
 *   "ok"            — already healthy; nothing written
 *   "linked"        — a symlink was created at installPath
 *   "no-target"     — R5: nothing real to point at, so nothing was written
 *   "failed"        — the unlink or symlink call did not succeed
 */
export function healCacheInstallPath({
  installPath,
  cacheRoot,
  preferredTarget,
  platform = process.platform,
}) {
  if (!installPath || typeof installPath !== "string") return "skipped";
  const p = resolve(installPath);
  // Containment first: this function writes to disk, and the only place it may
  // ever write is this host's own plugin cache.
  if (!cacheRoot || typeof cacheRoot !== "string") return "outside-cache";
  if (!p.startsWith(resolve(cacheRoot) + sep)) return "outside-cache";

  const state = cacheEntryState(p);
  // R4 — a real directory IS the install. A file we do not understand is not
  // ours either. Both are left exactly as found.
  if (state === "dir" || state === "other") return "ok";
  if (state === "alias") {
    // It resolves — but to WHAT? A link onto a tree with no start.mjs is the
    // same dead end as a dangling one; it just fails later and less legibly.
    if (realPluginDirOrNull(p)) return "ok";
    try {
      unlinkSync(p);
    } catch {
      return "failed";
    }
  } else if (state === "broken") {
    // The cycle. Remove it — re-creating it is what kept the machine broken
    // across every single boot.
    try {
      unlinkSync(p);
    } catch {
      return "failed";
    }
  }

  const target =
    realPluginDirOrNull(preferredTarget) ?? newestRealPluginDir(dirname(p));
  // R5 — no real tree anywhere. Doing nothing leaves a diagnosable "missing
  // directory"; inventing a link leaves an undiagnosable loop.
  if (!target) return "no-target";

  try {
    const parent = dirname(p);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    symlinkSync(target, p, platform === "win32" ? "junction" : undefined);
    return "linked";
  } catch {
    return "failed";
  }
}

/**
 * The standalone cache-heal hook, as source text.
 *
 * start.mjs writes this into `<config>/hooks/context-mode-cache-heal.mjs` and
 * registers it as a SessionStart hook. It lives OUTSIDE any plugin directory
 * on purpose — its whole job is to run when the plugin cache is the broken
 * thing, so it may not import from a version dir that might not resolve.
 * That is why R1-R5 above are restated inline below rather than imported:
 * this module is the source of truth, the text is its standalone twin.
 * **Change one, change the other.**
 *
 * Kept here rather than inlined in start.mjs so the exact bytes users receive
 * can be written to a temp file and executed by a test
 * (tests/hooks/cache-heal-symlink-cycle.test.ts).
 */
export const CACHE_HEAL_HOOK_SOURCE = `#!/usr/bin/env node
// context-mode plugin cache self-heal (auto-deployed by start.mjs — do not edit)
//
// Source of truth for this logic is hooks/cache-heal-utils.mjs (rules R1-R5).
// This file is its standalone twin: it must keep working when the plugin cache
// is exactly what is broken, so it imports nothing from a version directory.
//
// Fixes anthropics/claude-code#46915 (auto-update breaks CLAUDE_PLUGIN_ROOT)
// and the symlink cycle the earlier heal used to build out of it:
// \`1.0.171 -> 1.0.169 -> 1.0.171\`, where existsSync() answered ELOOP — read as
// "missing" — so every boot re-created the loop, the plugin never loaded, and
// the session came up with ZERO ctx_* tools.
// Issue #727: also normalizes stale version paths in existing installPaths.
// Honors CLAUDE_CONFIG_DIR (#577), read at this script's runtime so users who
// set it after install still get healed.
// Pure Node.js — no bash/shell dependency.
import { existsSync, readdirSync, readFileSync, lstatSync, realpathSync, symlinkSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";

function cfgDir() {
  const e = process.env.CLAUDE_CONFIG_DIR;
  if (e && e.trim() !== "") return e.startsWith("~") ? resolve(homedir(), e.replace(/^~[/\\\\]?/, "")) : resolve(e);
  return resolve(homedir(), ".claude");
}

// lstat, never existsSync(): existsSync FOLLOWS links, so a cyclic link (ELOOP)
// and a dangling one (ENOENT) both read as "missing" — which is how the old
// heal kept re-creating the cycle it was supposed to repair.
function state(p) {
  let st;
  try { st = lstatSync(p); } catch { return "missing"; }
  // Symlink test first: a Windows junction reports BOTH link and directory.
  if (st.isSymbolicLink()) { try { realpathSync(p); return "alias"; } catch { return "broken"; } }
  return st.isDirectory() ? "dir" : "other";
}

// R1 — a real directory that can actually boot: start.mjs present and a
// parseable .claude-plugin/plugin.json. Anything else just moves the failure.
function isRealPluginDir(p) {
  if (state(p) !== "dir") return false;
  if (!existsSync(join(p, "start.mjs"))) return false;
  try { return !!JSON.parse(readFileSync(join(p, ".claude-plugin", "plugin.json"), "utf-8")); } catch { return false; }
}

// R2 — resolve the whole chain, so nothing this script writes points at a link.
function realDir(p) {
  if (!p) return null;
  let r;
  try { r = realpathSync(p); } catch { return null; }
  return isRealPluginDir(r) ? r : null;
}

// The name filter is only a pre-pass; isRealPluginDir decides. The old code
// stopped at the name, which is precisely how a symlink became "newest".
function newestRealDir(parent) {
  let names;
  try { names = readdirSync(parent); } catch { return null; }
  const real = names.filter((n) => /^\\d+\\.\\d+/.test(n) && isRealPluginDir(join(parent, n)));
  if (!real.length) return null;
  real.sort((a, b) => { const pa = a.split(".").map(Number), pb = b.split(".").map(Number); for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); } return 0; });
  return realDir(join(parent, real[real.length - 1]));
}

// R3 + R4 — unresolvable links are removed; real directories never are.
// unlinkSync on a symlink removes the link, never what it pointed at, so a
// two-node cycle loses both members and nothing else.
function pruneBroken(parent) {
  let names;
  try { names = readdirSync(parent); } catch { return; }
  for (const n of names) {
    const p = join(parent, n);
    if (state(p) !== "broken") continue;
    try { unlinkSync(p); } catch {}
  }
}

// Issue #727: CC's auto-update carries hooks.json forward with paths baked to a
// previous version dir. #713: narrow helper only — installPath belongs to a
// different version's cache dir, and writing plugin.json there is the #711 vector.
async function normalizeHooksAt(p) {
  try {
    const nhPath = join(p, "hooks", "normalize-hooks.mjs");
    if (!existsSync(nhPath)) return;
    const mod = await import(nhPath);
    const fn = mod.normalizeHooksJsonOnly || mod.normalizeHooksOnStartup;
    if (fn) fn({ pluginRoot: p, nodePath: process.execPath, platform: process.platform });
  } catch {}
}

try {
  const f = resolve(cfgDir(), "plugins", "installed_plugins.json");
  if (!existsSync(f)) process.exit(0);
  const cacheRoot = resolve(cfgDir(), "plugins", "cache");
  const ip = JSON.parse(readFileSync(f, "utf-8"));
  for (const [k, es] of Object.entries(ip.plugins || {})) {
    if (k !== "context-mode@context-mode") continue;
    for (const e of es || []) {
      const p = e && e.installPath;
      if (!p) continue;
      if (!resolve(p).startsWith(cacheRoot + sep)) continue;
      const parent = dirname(p);
      // Sweep first: a cycle elsewhere in the versions dir poisons every later
      // lookup here, including the newest-real-dir scan.
      pruneBroken(parent);
      const st = state(p);
      if (st === "other") continue;
      if (st === "dir" || (st === "alias" && realDir(p))) { await normalizeHooksAt(p); continue; }
      // An alias onto a tree with no start.mjs is the same dead end as a
      // dangling one — it just fails later and less legibly. Both go.
      if (st === "alias" || st === "broken") { try { unlinkSync(p); } catch { continue; } }
      const target = newestRealDir(parent);
      // R5 — nothing real to point at. A missing directory is diagnosable;
      // a link that loops back on itself is not.
      if (!target) continue;
      try { if (!existsSync(parent)) mkdirSync(parent, { recursive: true }); } catch {}
      try { symlinkSync(target, p, process.platform === "win32" ? "junction" : undefined); } catch {}
    }
  }
} catch {}
`;
