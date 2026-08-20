// normalize-hooks.mjs — fixes #378
//
// Static committed files (hooks/hooks.json, .claude-plugin/plugin.json) ship
// with `${CLAUDE_PLUGIN_ROOT}` placeholder + bare `node` command. On Windows
// + Claude Code this triggers cjs/loader:1479 errors because:
//   1. bare `node` may not resolve via PATH (Git Bash, see #369)
//   2. `${CLAUDE_PLUGIN_ROOT}` resolution can hit MSYS path mangling (#372)
//   3. backslash paths get corrupted in shell quoting
//
// Our buildNodeCommand() fix handles dynamically-generated settings.json but
// not the static committed files. Solution: start.mjs detects the placeholder
// pattern on every MCP boot and rewrites with absolute paths using
// process.execPath + forward slashes. Idempotent — only rewrites when needed.
// Survives upgrades because it runs at every start.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PLACEHOLDER = "${CLAUDE_PLUGIN_ROOT}";

// ─────────────────────────────────────────────────────────────────────────
// Source-checkout refusal (#523 / #711 aimed at the REPOSITORY, not the cache)
//
// The placeholder→absolute rewrite below is correct for an INSTALLED plugin
// (a cache copy that only this machine ever reads) and always wrong for a
// DEVELOPMENT CHECKOUT: running `node start.mjs` / `bun start.mjs` from a clone
// to smoke-test the MCP server used to rewrite two TRACKED files in place —
//   .claude-plugin/plugin.json  "command": "node" → "/home/<user>/.bun/bin/bun"
//                               args[0] → "/home/<user>/projects/context-mode/start.mjs"
//   hooks/hooks.json            all 14 commands → the same machine-local paths
// — so every contributor silently dirtied their working tree, and committing
// that ships a plugin pointing at a stranger's home directory. Same failure
// class as #523 and #711/#713, which were about the cache copy.
//
// The signal: an installed copy has no `.git`, a checkout does. It is sound for
// the two files THIS module writes because both are consumed exclusively by
// Claude Code, and none of Claude Code's install paths carry `.git`:
//   - the native plugin manager COPIES the package into
//     ~/.claude/plugins/cache/<owner>/<plugin>/<version>/ (no `.git`);
//   - the marketplace git clone lives at ~/.claude/plugins/marketplaces/<owner>/
//     and is never itself a pluginRoot (see deriveMarketplaceClonePath);
//   - `npm install -g` unpacks a tarball (no `.git`).
// The one install layout that IS a git clone — Codex's marketplace clone under
// ~/.codex/plugins/cache/ — reads `.codex-plugin/hooks.json`, not the two files
// here, so refusing there costs nothing. And a local marketplace pointed
// straight at a clone belongs to a developer, who wants the placeholder kept.
//
// `.git` is matched with existsSync, not isDirectory: a worktree or submodule
// checkout has `.git` as a FILE holding a gitdir pointer, and that is just as
// much a working tree as a plain clone.
// ─────────────────────────────────────────────────────────────────────────

/** Is `pluginRoot` a development checkout rather than an installed copy? */
export function isSourceCheckout(pluginRoot) {
  if (!pluginRoot) return false;
  try {
    return existsSync(resolve(pluginRoot, ".git"));
  } catch {
    return false;
  }
}

// One line per plugin root per process: both manifests refuse on the same boot,
// and two identical lines would only read as a loop. Keyed by root so a process
// that legitimately touches several roots (start.mjs Layer 1 normalizes the NEW
// cache dir, Layer 5 its own) still reports each one.
const refusedCheckoutRoots = new Set();

/**
 * Report a refusal exactly once per root. stderr ONLY — start.mjs speaks the
 * MCP protocol over stdout, so a stray stdout line here would corrupt the
 * JSON-RPC stream and take the whole server down. A silent refusal is how the
 * next person spends an hour on the opposite question, hence not debug-gated.
 */
function logCheckoutRefusal(pluginRoot) {
  const key = String(pluginRoot);
  if (refusedCheckoutRoots.has(key)) return;
  refusedCheckoutRoots.add(key);
  try {
    process.stderr.write(
      `[context-mode] normalize-hooks: ${key} is a git checkout, not an installed plugin — ` +
        `not persisting the absolute-path rewrite of hooks/hooks.json + .claude-plugin/plugin.json ` +
        `(it would dirty tracked manifests with machine-local paths). Resolution still applies in memory.\n`,
    );
  } catch {
    /* stderr may be closed under a suppressed-stderr hook — never throw */
  }
}

/**
 * The ONE place either branch below persists a manifest.
 *
 * Two invariants live here so they cannot drift between the hooks.json and
 * plugin.json branches:
 *   1. a source checkout is never written to (see above) — the caller keeps
 *      running, the rewrite is simply not persisted;
 *   2. a trailing newline present in the original survives the round trip.
 *      JSON.stringify drops it, and the committed manifests end with one — a
 *      write that ate it showed up as a whole-file diff on top of the path
 *      damage.
 *
 * Returns whether the file was actually written.
 */
function writeNormalizedManifest(filePath, original, next, pluginRoot) {
  if (next === original) return false;
  if (isSourceCheckout(pluginRoot)) {
    logCheckoutRefusal(pluginRoot);
    return false;
  }
  const out =
    original.endsWith("\n") && !next.endsWith("\n") ? `${next}\n` : next;
  writeFileSync(filePath, out, "utf-8");
  return true;
}

// #604: matches a cache path segment `context-mode/context-mode/<version>`.
// Capture group is the X.Y.Z version. Used to detect command paths frozen on a
// previous-version dir that Claude Code's native plugin manager has since
// cleaned up. `/g` so a single content blob with multiple stale references is
// fully covered. Forward-slash only — callers convert beforehand.
const CACHE_VERSION_RE =
  /context-mode\/context-mode\/([0-9]+\.[0-9]+\.[0-9]+)(?=\/)/g;

/** Convert any path string to forward slashes (MSYS-safe). */
function fwd(p) {
  return String(p).replace(/\\/g, "/");
}

/**
 * Extract the X.Y.Z version segment from a pluginRoot under the context-mode
 * cache layout. Returns null when running from npm-global, a dev checkout, or
 * any layout that does not match the `<…>/context-mode/context-mode/<v>(/…)?`
 * pattern — callers must treat null as "no stale-path check is possible".
 */
function pluginRootVersion(pluginRoot) {
  if (!pluginRoot) return null;
  const m =
    /context-mode\/context-mode\/([0-9]+\.[0-9]+\.[0-9]+)(?:\/|$)/.exec(
      fwd(pluginRoot),
    );
  return m ? m[1] : null;
}

/**
 * Does `content` reference any context-mode cache version segment that differs
 * from `currentVersion`? Detects the #604 ratchet: already-normalized hooks.json
 * / plugin.json carrying a previous version's absolute paths forward into a
 * newer version's cache directory after Claude Code's auto-update.
 */
function hasStaleCacheVersionSegment(content, currentVersion) {
  if (!currentVersion || !content || typeof content !== "string") return false;
  const safe = fwd(content);
  CACHE_VERSION_RE.lastIndex = 0;
  let m;
  while ((m = CACHE_VERSION_RE.exec(safe)) !== null) {
    if (m[1] !== currentVersion) return true;
  }
  return false;
}

/**
 * Pure detection: does this content need to be (re-)normalized?
 *
 * Two triggers:
 *   1. Fresh content still containing the `${CLAUDE_PLUGIN_ROOT}` placeholder
 *      — the original #378 first-boot path on any host.
 *   2. (#604) Already-resolved content whose absolute paths point at a
 *      different version of the context-mode cache than the current
 *      `pluginRoot`. Breaks the ratchet that previously froze stale paths
 *      after Claude Code's native plugin manager copied a previous version's
 *      hooks.json forward.
 *
 * `pluginRoot` is optional for backwards compatibility with single-arg
 * callers; without it, only the placeholder check runs.
 */
export function needsHookNormalization(content, pluginRoot) {
  if (!content || typeof content !== "string") return false;
  if (content.includes(PLACEHOLDER)) return true;
  return hasStaleCacheVersionSegment(content, pluginRootVersion(pluginRoot));
}

/**
 * Rewrite hooks.json content. Replaces:
 *   - `node "${CLAUDE_PLUGIN_ROOT}/x.mjs"` →
 *     `"<execPath>" "<pluginRoot>/x.mjs"`  (forward slashes, double-quoted)
 *
 * Pure function — takes content + paths, returns new content. Deliberately NOT
 * gated by the source-checkout refusal: the refusal is about PERSISTING the
 * rewrite, so a caller running from a checkout still gets correct resolved
 * values to use in memory. Only writeNormalizedManifest refuses.
 * Idempotent — leaves already-normalized content unchanged.
 */
export function normalizeHooksJson(content, nodePath, pluginRoot) {
  if (!needsHookNormalization(content, pluginRoot)) return content;

  const safeNode = fwd(nodePath);
  const safeRoot = fwd(pluginRoot);
  const currentVersion = pluginRootVersion(pluginRoot);

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }

  const hooks = parsed?.hooks;
  if (!hooks || typeof hooks !== "object") return content;

  let mutated = false;
  for (const eventName of Object.keys(hooks)) {
    const matchers = hooks[eventName];
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      const inner = matcher?.hooks;
      if (!Array.isArray(inner)) continue;
      for (const h of inner) {
        if (typeof h?.command !== "string") continue;

        const hasPlaceholder = h.command.includes(PLACEHOLDER);
        // #604: also rewrite when the command holds a stale absolute path under
        // a previous-version cache dir (Claude Code's auto-update ratchet).
        const hasStale = hasStaleCacheVersionSegment(h.command, currentVersion);
        if (!hasPlaceholder && !hasStale) continue;

        let next = h.command;
        if (hasPlaceholder) {
          // Replace placeholder with absolute root (forward-slash).
          next = next.replaceAll(PLACEHOLDER, safeRoot);
          // Replace bare `node ` prefix with quoted execPath. Match both
          // `node ` and `node\t` at start, with optional surrounding whitespace.
          next = next.replace(/^\s*node\s+/, `"${safeNode}" `);
        }
        if (hasStale) {
          // Re-point every `context-mode/context-mode/<old-version>/…` segment
          // to the current pluginRoot's version. Operates on the forward-slash
          // form so MSYS-mangled paths heal as well.
          next = fwd(next).replace(
            CACHE_VERSION_RE,
            `context-mode/context-mode/${currentVersion}`,
          );
        }
        h.command = next;
        mutated = true;
      }
    }
  }

  if (!mutated) return content;

  // Preserve 2-space indent (matches committed format).
  return JSON.stringify(parsed, null, 2);
}

/**
 * Rewrite plugin.json mcpServers. Replaces:
 *   - `command: "node"` → `command: "<execPath-fwd>"`
 *   - `args: ["${CLAUDE_PLUGIN_ROOT}/start.mjs"]` →
 *     `args: ["<pluginRoot-fwd>/start.mjs"]`
 *
 * Pure and unguarded for the same reason as normalizeHooksJson — in-memory
 * resolution stays available in a checkout, only the write is refused.
 * Idempotent.
 */
export function normalizePluginJson(content, nodePath, pluginRoot) {
  if (!needsHookNormalization(content, pluginRoot)) return content;

  const safeNode = fwd(nodePath);
  const safeRoot = fwd(pluginRoot);
  const currentVersion = pluginRootVersion(pluginRoot);

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }

  const servers = parsed?.mcpServers;
  if (!servers || typeof servers !== "object") return content;

  let mutated = false;
  for (const name of Object.keys(servers)) {
    const srv = servers[name];
    if (!srv || typeof srv !== "object") continue;

    if (Array.isArray(srv.args)) {
      const before = srv.args;
      const after = before.map((a) => {
        if (typeof a !== "string") return a;
        let next = a;
        if (next.includes(PLACEHOLDER)) {
          next = next.replaceAll(PLACEHOLDER, safeRoot);
        }
        // #604: same auto-update ratchet hits plugin.json args (see #523).
        if (hasStaleCacheVersionSegment(next, currentVersion)) {
          next = fwd(next).replace(
            CACHE_VERSION_RE,
            `context-mode/context-mode/${currentVersion}`,
          );
        }
        return next;
      });
      if (after.some((v, i) => v !== before[i])) {
        srv.args = after;
        mutated = true;
      }
    }

    if (srv.command === "node" && mutated) {
      // Only swap bare `node` when we also rewrote args — otherwise we'd
      // touch user-customized server entries unrelated to placeholders.
      srv.command = safeNode;
    }
  }

  if (!mutated) return content;
  return JSON.stringify(parsed, null, 2);
}

/**
 * Apply normalization to hooks/hooks.json ONLY (not plugin.json).
 *
 * Why a narrow variant exists (#711 + #414 / #528):
 *   - plugin.json is read by Claude Code's plugin manager and carried forward
 *     into NEW versioned cache dirs on auto-update. Baking absolute paths into
 *     it during /ctx-upgrade poisons the next version (#711).
 *   - hooks/hooks.json lives in the per-version dir and is read by the SAME
 *     Node process that needs to spawn a child. On Windows + Git Bash, Claude
 *     Code fires SessionStart/PreToolUse BEFORE MCP boot — the unresolved
 *     `${CLAUDE_PLUGIN_ROOT}` placeholder yields MODULE_NOT_FOUND for the
 *     first hook fire after /ctx-upgrade (#414).
 *
 * So /ctx-upgrade calls THIS narrow function (hooks.json only) to close the
 * Windows first-hook-fire window without re-introducing #711.
 *
 * Options:
 *   - pluginRoot:     absolute path to plugin install dir
 *   - nodePath:       process.execPath (the Node binary running this script)
 *   - jsRuntimePath:  optional — resolved Bun ≥1.0 path (#738). When set, the
 *                     rewrite uses this instead of nodePath so hook invocations
 *                     gain Bun's ~40-60ms cold-start advantage. Falls back to
 *                     nodePath when omitted (back-compat).
 *   - platform:       process.platform. Triggers a write on:
 *                       • "win32" / "linux" — the original #378 path
 *                         (#369/#372 MSYS / nvm fixes), AND
 *                       • any platform when jsRuntimePath !== nodePath
 *                         (#738 — bun swap is a perf optimisation that should
 *                         not be gated by the historical Windows-only check;
 *                         issue was filed from macOS).
 *
 * Refuses to persist anything when `pluginRoot` is a git checkout — see the
 * source-checkout block at the top of this file. Logs one line to stderr and
 * carries on; the server still boots from a checkout, it just stops dirtying
 * the tracked manifest.
 *
 * Best-effort — never throws.
 */
export function normalizeHooksJsonOnly({ pluginRoot, nodePath, jsRuntimePath, platform }) {
  const effectiveRuntime = jsRuntimePath || nodePath;
  // #378 path: always normalize on Windows/Linux to heal placeholder + bare-node.
  // #738 path: also fire on macOS when we have a real bun swap to perform — the
  // legacy gate skipped darwin because system node was reliable there, but bun
  // resolution is the new perf-win that the gate now needs to allow through.
  const isPlatformGated = platform !== "win32" && platform !== "linux";
  const hasBunSwap = jsRuntimePath && jsRuntimePath !== nodePath;
  if (isPlatformGated && !hasBunSwap) return;
  if (!pluginRoot || !effectiveRuntime) return;

  try {
    const hooksPath = resolve(pluginRoot, "hooks", "hooks.json");
    if (existsSync(hooksPath)) {
      const original = readFileSync(hooksPath, "utf-8");
      if (needsHookNormalization(original, pluginRoot)) {
        const next = normalizeHooksJson(original, effectiveRuntime, pluginRoot);
        // Refuses on a source checkout; keeps the trailing newline otherwise.
        writeNormalizedManifest(hooksPath, original, next, pluginRoot);
      }
    }
  } catch {
    /* best effort */
  }
}

/**
 * Apply normalization to hooks.json and plugin.json on startup.
 *
 * Options:
 *   - pluginRoot:     absolute path to plugin install dir (e.g. __dirname of start.mjs)
 *   - nodePath:       process.execPath
 *   - jsRuntimePath:  optional Bun ≥1.0 path (#738) — used for hooks.json only,
 *                     never for plugin.json (the MCP server itself must stay on
 *                     Node — better-sqlite3 ABI, #543)
 *   - platform:       process.platform ("win32" and "linux" trigger plugin.json
 *                     rewrite for #378; hooks.json also rewrites on darwin when
 *                     `jsRuntimePath` !== `nodePath` for #738)
 *
 * Refuses to persist either manifest when `pluginRoot` is a git checkout —
 * this is the call start.mjs makes with `pluginRoot: __dirname`, i.e. the
 * contributor's own working tree when the server is smoke-tested from a clone.
 *
 * Best-effort — never throws.
 */
export function normalizeHooksOnStartup({ pluginRoot, nodePath, jsRuntimePath, platform }) {
  // Delegate the hooks.json branch to the narrow helper so /ctx-upgrade and
  // boot share one implementation. plugin.json normalization stays here —
  // start.mjs and postinstall still need it; /ctx-upgrade must NOT (#711).
  normalizeHooksJsonOnly({ pluginRoot, nodePath, jsRuntimePath, platform });

  // plugin.json rewrite: ALWAYS uses nodePath (MCP server must stay on Node,
  // #543). Bun resolution is irrelevant here — `jsRuntimePath` is consumed
  // exclusively by the hooks.json branch above.
  if (platform !== "win32" && platform !== "linux") return;
  if (!pluginRoot || !nodePath) return;

  // .claude-plugin/plugin.json
  try {
    const pluginPath = resolve(pluginRoot, ".claude-plugin", "plugin.json");
    if (existsSync(pluginPath)) {
      const original = readFileSync(pluginPath, "utf-8");
      if (needsHookNormalization(original, pluginRoot)) {
        const next = normalizePluginJson(original, nodePath, pluginRoot);
        // Same guard as the hooks.json branch — this is the file that shipped
        // a contributor's $HOME to everyone else when it was written blind.
        writeNormalizedManifest(pluginPath, original, next, pluginRoot);
      }
    }
  } catch {
    /* best effort */
  }
}
