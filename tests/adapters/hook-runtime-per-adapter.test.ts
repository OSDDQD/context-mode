/**
 * Per-adapter hook command emission — issue #738.
 *
 * An adapter that emits a JS-runtime hook spawn command must route through
 * `buildHookRuntimeCommand` so bun is preferred when available. Since the
 * fifteen-host removal that is claude-code alone; qwen-code, gemini-cli and
 * kiro were the other three and left with their adapters.
 *
 * An adapter that emits a CLI dispatcher command instead invokes
 * `context-mode hook <adapter> <event>` and inherits the CLI's runtime choice.
 * The one adapter of that shape left with the Codex removal, so only the
 * runtime-spawn half has an example to run against. The pairing returns with
 * the next dispatcher-form host, and #738 — one shape silently adopting the
 * other's — is why it has to.
 *
 * Test strategy: rather than fight Vitest's module cache (which caches
 * `runtime.js` after the first import and never picks up subsequent
 * `vi.doMock("node:fs")` calls), we read the host's real runtime resolution
 * and assert each adapter emits exactly that path. This proves the adapter
 * routes through `buildHookRuntimeCommand` because the only other code path
 * (`buildNodeCommand` using `process.execPath`) would produce a different
 * binary name when bun is available on the host.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

describe("hook command emission flows through buildHookRuntimeCommand (#738)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  test("claude-code generateHookConfig emits the resolved hook runtime path", async () => {
    const { resolveHookRuntime, resetHookRuntimeCache } = await import("../../src/runtime.js");
    resetHookRuntimeCache();
    const runtime = resolveHookRuntime();
    const { ClaudeCodeAdapter } = await import("../../src/adapters/claude-code/index.js");
    const adapter = new ClaudeCodeAdapter();
    const config = adapter.generateHookConfig("/plugin/root") as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    const preCmd = config.PreToolUse[0].hooks[0].command;
    // Wire format: `"<runtimePath>" "<scriptPath>"` with forward-slashed paths.
    const expectedRuntime = runtime.path.replace(/\\/g, "/");
    expect(preCmd).toBe(`"${expectedRuntime}" "/plugin/root/hooks/pretooluse.mjs"`);
  });

  test("claude-code never emits bare 'node' (Algo-D3 invariant preserved)", async () => {
    const { resetHookRuntimeCache } = await import("../../src/runtime.js");
    resetHookRuntimeCache();
    const { ClaudeCodeAdapter } = await import("../../src/adapters/claude-code/index.js");
    const adapter = new ClaudeCodeAdapter();
    const config = adapter.generateHookConfig("/plugin/root") as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    const allCommands = Object.values(config).flatMap((entries) =>
      entries.flatMap((e) => e.hooks.map((h) => h.command))
    );
    for (const cmd of allCommands) {
      // Must NOT be bare `node ...` — that would mean the helper was
      // bypassed (the bug claude-code/index.ts comment Algo-D3 prevents).
      expect(cmd).not.toMatch(/^node\s/);
      // Wire shape (always double-quoted pair).
      expect(cmd).toMatch(/^"[^"]+"\s+"[^"]+"$/);
    }
  });



});
