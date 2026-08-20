/**
 * `ctx_upgrade` — hands the host the shell command that upgrades this plugin.
 *
 * The handler is a command builder: it resolves the plugin root, picks the
 * bundle / built-CLI / inline-script rung that actually exists there, and
 * returns the command as text. It performs no upgrade itself, which is why
 * moving it is cheap — there is no shared state to leave behind.
 *
 * Two of its three seam fields exist because `src/server.ts` still owns the
 * resolvers: `getRuntimeAwarePackageRoot` (whose Codex-only override rule is
 * boot-time knowledge) and `getClientVersion`, the MCP handshake value that
 * only the live server object can answer. The third is not a seam field at all:
 * `killProcessOnPort` now comes from `./insight.js` — a sideways tool → tool
 * import, which is allowed, rather than an import back at the server, which is
 * the one direction ADR-0020 forbids.
 */

import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

import { buildNodeCommand, type PlatformId } from "../adapters/types.js";
import { detectPlatform } from "../adapters/detect.js";
import { resolveUpgradeRepo } from "../util/fork-info.js";
import { killProcessOnPort } from "./insight.js";
import type { UpgradeToolDeps } from "./shared/deps.js";

/** Register `ctx_upgrade` on the server carried by `deps`. */
export function registerCtxUpgrade(deps: UpgradeToolDeps): void {
  const { getSessionDir, getPackageRoot, trackResponse } = deps;
  // The handler reads `server.server.getClientVersion()`. Aliasing the injected
  // getter to that expression keeps the body byte-identical to the version that
  // lived in src/server.ts — this is a refactor, and the diff should say so.
  const server = { server: { getClientVersion: deps.getClientVersion } };

  // ── ctx-upgrade: upgrade meta-tool ─────────────────────────────────────────
  deps.server.registerTool(
    "ctx_upgrade",
    {
      title: "Upgrade Plugin",
      // #846: an action tool (returns an upgrade command to run); not read-only,
      // but non-destructive and idempotent. No direct network from the call.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "Upgrade context-mode to the latest version. Returns a shell command to execute. " +
        "You MUST run the returned command using your shell tool (Bash, shell_execute, " +
        "run_in_terminal, etc.) and display the output as a checklist. " +
        "Tell the user to restart their session after upgrade.",
      inputSchema: z.object({}),
    },
    async () => {
      // Issue #542 — thread MCP clientInfo into the spawned upgrade
      // process. detectPlatform() runs IN-PROCESS here (no spawn boundary)
      // so clientInfo from the MCP handshake is the highest-confidence
      // signal available. We forward the resolved PlatformId as a
      // --platform flag (cross-shell safe on POSIX, Git Bash, PowerShell,
      // and cmd.exe — unlike env-var prefixes). If detection fails we
      // skip the flag and let upgrade()'s own detectPlatform() fall back.
      let platformFlag = "";
      let platformId: PlatformId | undefined;
      try {
        const clientInfo = server.server.getClientVersion();
        const signal = detectPlatform(clientInfo ?? undefined);
        platformId = signal.platform;
        platformFlag = ` --platform ${signal.platform}`;
      } catch {
        try { platformId = detectPlatform().platform; } catch { /* best effort — fall back to upgrade()'s own detect */ }
      }

      // __pkg_dir is build/ for tsc, plugin root for bundle — resolve to plugin root.
      // Only Codex may replace it with the plugin-manager runtime root; other
      // adapters can coexist with Codex on the same machine.
      const pluginRoot = getPackageRoot();
      const bundlePath = resolve(pluginRoot, "cli.bundle.mjs");
      const fallbackPath = resolve(pluginRoot, "build", "cli.js");

      // Insight pivoted to the hosted dashboard (context-mode.com/insight), so
      // ctx_insight no longer builds a local cache. On upgrade, sweep the legacy
      // insight-cache and stop any stale local dashboard left from old versions.
      try {
        const sessDir = getSessionDir();
        const insightCacheDir = join(dirname(sessDir), "insight-cache");
        if (existsSync(insightCacheDir)) {
          // Kill any running insight server first via the shared helper —
          // this is locale-independent on Windows (PR #469) and isolates per-pid
          // failures. We ignore the structured result: cache cleanup is
          // best-effort and must never block ctx_upgrade.
          killProcessOnPort(4747);
          rmSync(insightCacheDir, { recursive: true, force: true });
        }
      } catch { /* best effort — don't block upgrade */ }


      let cmd: string;

      if (existsSync(bundlePath)) {
        cmd = `${buildNodeCommand(bundlePath)} upgrade${platformFlag}`;
      } else if (existsSync(fallbackPath)) {
        cmd = `${buildNodeCommand(fallbackPath)} upgrade${platformFlag}`;
      } else {
        // Inline fallback: neither CLI file exists (e.g. marketplace installs).
        // Generate a self-contained node -e script that performs the upgrade.
        //
        // The repo is resolved, never hardcoded. This branch used to clone
        // upstream unconditionally — which, run from a fork install, is not an
        // upgrade but a silent downgrade that overwrites every local commit and
        // says nothing about having done so. src/util/fork-info.ts exists for
        // exactly this and the CLI path already used it; this branch, the one a
        // marketplace install actually takes, was still pinned to upstream.
        const repoUrl = resolveUpgradeRepo({ pluginRoot }).url;
        // Write inline script to a temp .mjs file — avoids quote-escaping issues
        // across cmd.exe, PowerShell, and bash (node -e '...' breaks on Windows).
        const scriptLines = [
          `import{execFileSync}from"node:child_process";`,
          `import{cpSync,rmSync,existsSync,mkdtempSync,readFileSync,writeFileSync,lstatSync}from"node:fs";`,
          `import{join,resolve,sep}from"node:path";`,
          `import{tmpdir}from"node:os";`,
          `const P=${JSON.stringify(pluginRoot)};`,
          `const T=mkdtempSync(join(tmpdir(),"ctx-upgrade-"));`,
          `try{`,
          `console.log("- [x] Starting inline upgrade (no CLI found)");`,
          `execFileSync("git",["clone","--depth","1","${repoUrl}",T],{stdio:"inherit"});`,
          `console.log("- [x] Cloned latest source");`,
          `execFileSync(process.platform==="win32"?"npm.cmd":"npm",["install"],{cwd:T,stdio:"inherit",shell:process.platform==="win32"});`,
          `execFileSync(process.platform==="win32"?"npm.cmd":"npm",["run","build"],{cwd:T,stdio:"inherit",shell:process.platform==="win32"});`,
          `console.log("- [x] Built from source");`,
          `const pkg=JSON.parse(readFileSync(join(T,"package.json"),"utf8"));`,
          `const items=[...(Array.isArray(pkg.files)?pkg.files:[]),"src","package.json"];`,
          // Supply-chain containment on items[]. Mirror the cli.ts upgrade()
          // guard: a compromised upstream package.json with files:["../etc"]
          // would otherwise let path.join follow ".." out of pluginRoot.
          // path.resolve normalizes "..", so the lexical startsWith catches
          // both relative-".." traversal and absolute-path bypass. Plus a
          // symlink filter so a committed symlink inside the clone can't
          // plant itself in pluginRoot (cpSync default preserves source
          // symlinks; a planted symlink in pluginRoot/src then redirects
          // every subsequent load through to an attacker target).
          `const PW=resolve(P)+sep;const TW=resolve(T)+sep;`,
          `const noSymlink=(src)=>{try{return !lstatSync(src).isSymbolicLink()}catch{return false}};`,
          `for(const item of items){const from=resolve(T,item);const to=resolve(P,item);if(!(to+sep).startsWith(PW))continue;if(!(from+sep).startsWith(TW))continue;if(!noSymlink(from))continue;if(existsSync(from)){rmSync(to,{recursive:true,force:true});cpSync(from,to,{recursive:true,force:true,filter:noSymlink});}}`,
          // Issue #609: do NOT write .mcp.json into the cache dir. Claude Code reads
          // .claude-plugin/plugin.json.mcpServers as the canonical MCP source — the
          // per-version .mcp.json file is a stale-write vector. Same architectural
          // fix as the cli.ts upgrade() path; both writers were the only producers.
          `console.log("- [x] Copied package files");`,
          `execFileSync(process.platform==="win32"?"npm.cmd":"npm",["install","--production"],{cwd:P,stdio:"inherit",shell:process.platform==="win32"});`,
          `console.log("- [x] Installed production dependencies");`,
          `console.log("## context-mode upgrade complete");`,
          `}catch(e){`,
          `console.error("- [ ] Upgrade failed:",e.message);`,
          `process.exit(1);`,
          `}finally{`,
          `try{rmSync(T,{recursive:true,force:true})}catch{}`,
          `}`,
        ].join("\n");

        // Server writes the temp script file — avoids shell quoting issues entirely
        const tmpScript = resolve(pluginRoot, ".ctx-upgrade-inline.mjs");
        const { writeFileSync: writeTmp } = await import("node:fs");
        writeTmp(tmpScript, scriptLines);
        cmd = buildNodeCommand(tmpScript);
      }

      const text = [
        "## ctx-upgrade",
        "",
        "Run this command using your shell execution tool:",
        "",
        "```",
        cmd,
        "```",
        "",
        "After the command completes, display results as a markdown checklist:",
        "- `[x]` for success, `[ ]` for failure",
        "- Example format:",
        "  ```",
        "  ## context-mode upgrade",
        "  - [x] Pulled latest from GitHub",
        "  - [x] Built and installed v0.9.24",
        "  - [x] npm global updated",
        "  - [x] Hooks configured",
        "  - [x] Doctor: all checks PASS",
        "  ```",
        "- Tell the user to restart their session to pick up the new version.",
      ].join("\n");

      return trackResponse("ctx_upgrade", {
        content: [{ type: "text" as const, text }],
      });
    },
  );
}
