/**
 * `ctx_doctor` — the server-side installation report.
 *
 * This is the widest seam in `src/tools/`, and it is honest rather than
 * accidental: the tool exists to answer "is this install healthy", so it has to
 * see the install. Eight values come in — the detected runtimes and the
 * languages they enable, the platform-aware plugin root, the MCP handshake's
 * clientInfo, the pre-detection session dir, the adapter used for hook
 * validation, the live tool registry, and the running version — because
 * `src/server.ts` computes all eight once at boot, and recomputing any of them
 * here would report on a second detection pass rather than on the process the
 * user is actually running.
 *
 * They live on {@link DoctorToolDeps}, not on the base {@link ToolDeps}, which
 * is the whole point of the per-tool extension shape: one report tool that has
 * to see everything must not make every tool able to.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import { detectPlatform } from "../adapters/detect.js";
import type { PlatformId } from "../adapters/types.js";
import { loadDatabase } from "../db-base.js";
import { PolyglotExecutor } from "../executor.js";
import { hasBunRuntime } from "../runtime.js";
import {
  describeStorageDirectorySource,
  resolveContentStorageDir,
  resolveSessionStorageDir,
  resolveStatsStorageDir,
} from "../session/db.js";
import { collectDeliveryHealth, renderDeliveryHealth } from "../util/delivery-health.js";
import { getHookScriptPaths } from "../util/hook-config.js";
import { collectLayerHealth, layerDiagnosticsEnabled, renderLayerHealth } from "../util/layer-health.js";
import type { DoctorToolDeps } from "./shared/deps.js";

/** Register `ctx_doctor` on the server carried by `deps`. */
export function registerCtxDoctor(deps: DoctorToolDeps): void {
  const {
    getProjectDir, trackResponse, VERSION,
    runtimes, available, getRuntimeAwarePackageRoot,
    getDefaultSessionDir, getDiagnosticAdapter, REGISTERED_CTX_TOOLS,
  } = deps;
  // Aliased so the handler body below stays byte-identical to the version that
  // lived in src/server.ts: it reads `server.server.getClientVersion()`, and a
  // refactor whose diff is only the move is the one that can be reviewed.
  const server = { server: { getClientVersion: deps.getClientVersion } };

  // ── ctx-doctor: diagnostics (server-side) ─────────────────────────────────
  deps.server.registerTool(
    "ctx_doctor",
    {
      title: "Run Diagnostics",
      // #846: read-only diagnostics (runs an internal self-test, mutates nothing).
      // Was cancelled by Codex when unannotated.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "Diagnose context-mode installation. Runs all checks server-side and " +
        "returns a plain-text status report with [OK]/[FAIL]/[WARN] prefixes " +
        "(renderer-safe across MCP clients). No CLI execution needed.",
      inputSchema: z.object({}),
    },
    async () => {
      // Renderer-safe output (Mickey #3 — Z.ai GLM 4.7 ReferenceError):
      // Z.ai's MCP renderer mounts a custom React component for GitHub-flavored
      // markdown task-list syntax (`- [x]` / `- [ ]` / `- [-]`) that depends on
      // a missing `client` context, throwing `ReferenceError: client is not
      // defined`. We avoid both task-list syntax AND `## ` h2 headings to stay
      // safe across all MCP renderers — using plain-text status prefixes
      // (`[OK]` / `[FAIL]` / `[WARN]`) instead.
      const lines: string[] = ["context-mode doctor", ""];
      let currentPlatform: PlatformId | undefined;
      try {
        currentPlatform = detectPlatform(server.server.getClientVersion() ?? undefined).platform;
      } catch {
        currentPlatform = detectPlatform().platform;
      }
      // __pkg_dir is build/ for tsc, plugin root for bundle — resolve to plugin root.
      // Codex is special: when plugin-manager runtime root differs from the
      // current package root, diagnose the root Codex will actually execute.
      const pluginRoot = getRuntimeAwarePackageRoot(currentPlatform);

      // Runtimes
      const total = 11;
      const pct = ((available.length / total) * 100).toFixed(0);
      lines.push(`[OK] Runtimes: ${available.length}/${total} (${pct}%) — ${available.join(", ")}`);

      // Performance
      if (hasBunRuntime()) {
        lines.push("[OK] Performance: FAST (Bun)");
      } else {
        lines.push("[WARN] Performance: NORMAL — install Bun for 3-5x speed boost");
      }

      const sessionStorage = resolveSessionStorageDir(getDefaultSessionDir);
      const contentStorage = resolveContentStorageDir(getDefaultSessionDir);
      const statsStorage = resolveStatsStorageDir(getDefaultSessionDir);
      lines.push(`[OK] Storage sessions: ${sessionStorage.path} (${describeStorageDirectorySource(sessionStorage)})`);
      lines.push(`[OK] Storage content: ${contentStorage.path} (${describeStorageDirectorySource(contentStorage)})`);
      lines.push(`[OK] Storage stats: ${statsStorage.path} (${describeStorageDirectorySource(statsStorage)})`);

      // Server test — cleanup executor to prevent resource leaks (#247)
      {
        const testExecutor = new PolyglotExecutor({ runtimes });
        try {
          const result = await testExecutor.execute({ language: "javascript", code: 'console.log("ok");', timeout: 5000 });
          if (result.exitCode === 0 && result.stdout.trim() === "ok") {
            lines.push("[OK] Server test: PASS");
          } else {
            const detail = result.stderr?.trim() ? ` (${result.stderr.trim().slice(0, 200)})` : "";
            lines.push(`[FAIL] Server test: FAIL — exit ${result.exitCode}${detail}`);
          }
        } catch (err: unknown) {
          lines.push(`[FAIL] Server test: FAIL — ${err instanceof Error ? err.message : err}`);
        } finally {
          testExecutor.cleanupBackgrounded();
        }
      }

      // FTS5 / SQLite — close in finally to prevent GC segfault (#247)
      {
        let testDb: ReturnType<typeof loadDatabase> extends (...args: any[]) => infer R ? R : never;
        try {
          const Database = loadDatabase();
          testDb = new Database(":memory:");
          testDb.exec("CREATE VIRTUAL TABLE fts_test USING fts5(content)");
          testDb.exec("INSERT INTO fts_test(content) VALUES ('hello world')");
          const row = testDb.prepare("SELECT * FROM fts_test WHERE fts_test MATCH 'hello'").get() as { content: string } | undefined;
          if (row && row.content === "hello world") {
            lines.push("[OK] FTS5 / SQLite: PASS — native module works");
          } else {
            lines.push("[FAIL] FTS5 / SQLite: FAIL — unexpected result");
          }
        } catch (err: unknown) {
          lines.push(`[FAIL] FTS5 / SQLite: FAIL — ${err instanceof Error ? err.message : err}`);
        } finally {
          try { testDb!?.close(); } catch { /* best effort */ }
        }
      }

      // Hooks
      const diagnosticAdapter = await getDiagnosticAdapter();
      if (diagnosticAdapter) {
        for (const result of diagnosticAdapter.validateHooks(pluginRoot)) {
          const prefix = result.status === "pass" ? "[OK]" : result.status === "warn" ? "[WARN]" : "[FAIL]";
          const fix = result.fix ? ` — fix: ${result.fix}` : "";
          lines.push(`${prefix} ${result.check}: ${result.message}${fix}`);
        }

        const hookScriptPaths = getHookScriptPaths(diagnosticAdapter, pluginRoot);
        if (hookScriptPaths.length === 0) {
          lines.push("[OK] Hook scripts: no direct .mjs script paths to verify");
        }
        for (const scriptPath of hookScriptPaths) {
          const hookPath = resolve(pluginRoot, scriptPath);
          if (existsSync(hookPath)) {
            lines.push(`[OK] Hook script: PASS — ${hookPath}`);
          } else {
            lines.push(`[FAIL] Hook script: FAIL — not found at ${hookPath}`);
          }
        }
      } else {
        lines.push("[WARN] Hooks: adapter detection unavailable");
      }

      // Search layers (P3): fff, codegraph, the fs bus, tokenizer, compression.
      // Same probes the CLI doctor runs — every one of them degrades to a state
      // ("not installed", "off") rather than a failure, so a plugin without the
      // optional layers still reports a clean bill of health.
      if (layerDiagnosticsEnabled()) {
        try {
          const layers = await collectLayerHealth({ projectDir: getProjectDir(), pluginRoot });
          lines.push("[OK] Search layers:");
          for (const line of renderLayerHealth(layers)) lines.push(`  ${line}`);
        } catch (e) {
          lines.push(`[WARN] Search layers: probe unavailable — ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // Delivery: which build is the host actually running?
      //
      // Every check above answers for the tree this code was loaded from, and
      // that tree is exactly where the interesting failure hides: the host runs
      // an unpacked copy keyed by version number, so a wave that changes the
      // tool surface without moving the number leaves the session on the old
      // copy — `ctx_find` and `ctx_graph` were absent from every live session
      // while both the repository and the marketplace clone carried them, and
      // this report said everything was fine. REGISTERED_CTX_TOOLS is the
      // authoritative answer to "what does THIS session have", so pass it.
      try {
        const delivery = collectDeliveryHealth({
          pluginRoot,
          liveTools: REGISTERED_CTX_TOOLS.map((t) => t.name),
        });
        const prefix = delivery.status === "fail" ? "[FAIL]" : delivery.status === "warn" ? "[WARN]" : "[OK]";
        lines.push(`${prefix} Delivery:`);
        for (const line of renderDeliveryHealth(delivery)) lines.push(`  ${line}`);
      } catch (e) {
        lines.push(`[WARN] Delivery: probe unavailable — ${e instanceof Error ? e.message : String(e)}`);
      }

      // Version
      lines.push(`[OK] Version: v${VERSION}`);

      return trackResponse("ctx_doctor", {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      });
    },
  );
}
