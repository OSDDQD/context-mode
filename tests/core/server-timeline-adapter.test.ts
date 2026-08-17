import "../setup-home";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serverSource } from "../shared/server-source.js";

/**
 * Slice 5 — server.ts ctx_search timeline mode.
 *
 * Two static checks, asserted against the source of src/server.ts:
 *   (a) the SessionDB path used by timeline mode includes the worktree
 *       suffix (matches the SessionDB path the snapshot/extract hooks write to);
 *   (b) the configDir + adapter passed to searchAllSources comes from
 *       _detectedAdapter — not a hardcoded ~/.claude path.
 *
 * Running this as a static guard avoids spawning a full MCP server in tests
 * while still preventing regressions of the original bug (#367 follow-ups).
 */

const SERVER_SRC = serverSource();

describe("ctx_search timeline mode wiring (server.ts)", () => {
  it("opens SessionDB via resolveSessionDbPath (worktree suffix + casing migration)", () => {
    // Bug #4: timeline mode used to look at ${hash}.db but writers used
    // ${hash}${getWorktreeSuffix()}.db. Now both go through
    // resolveSessionDbPath which also handles case-fold migration.
    expect(SERVER_SRC).toMatch(
      /resolveSessionDbPath\(\{\s*projectDir\s*,\s*sessionsDir\s*\}\)/,
    );
  });

  it("derives configDir from _detectedAdapter.getConfigDir() (not hardcoded ~/.claude)", () => {
    expect(SERVER_SRC).toMatch(
      /_detectedAdapter\??\.getConfigDir\(\)/,
    );
  });

  it("passes the detected adapter through to searchAllSources", () => {
    // searchAllSources call site should include `adapter:` in its options.
    // The handler moved to src/tools/search.ts, where the adapter arrives
    // through ToolDeps as a getter (detection finishes after import), so the
    // binding reads `detectedAdapter()` rather than the module-level
    // `_detectedAdapter` it used to close over.
    expect(SERVER_SRC).toMatch(
      /searchAllSources\(\{[\s\S]*?adapter:\s*(?:_detectedAdapter|detectedAdapter\(\))[\s\S]*?\}\)/,
    );
  });
});
