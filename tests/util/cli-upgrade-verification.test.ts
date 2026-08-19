/**
 * cli.ts upgrade-flow verification — v1.0.114 hotfix.
 *
 * The bug being fixed: /ctx-upgrade in v1.0.113 wrote registry version
 * "1.0.113" while the cache install dir on disk still carried plugin.json
 * version "1.0.112" (in-place files-array drift). Claude Code's plugin
 * loader rejected the manifest mismatch and silently disconnected the
 * plugin. The user has no MCP, so /ctx-upgrade can't even retry.
 *
 * Defense-in-depth wired into the upgrade flow:
 *   1. start.mjs MUST wire HEAL 3 + HEAL 4 from healInstalledPlugins
 *      (already-broken users self-recover on next MCP boot).
 *   2. src/cli.ts upgrade() MUST verify pluginRoot's plugin.json reports
 *      newVersion BEFORE bumping the registry (preflight gate).
 *   3. src/cli.ts upgrade() MUST re-read installed_plugins.json AFTER
 *      bumping and assert installPath/.claude-plugin/plugin.json's
 *      version matches the registry — throws on mismatch.
 *   4. src/cli.ts upgrade() MUST verify the marketplace clone (if
 *      present) was actually pulled to newVersion — Mert's case showed
 *      the clone stuck at v1.0.89 while npm published v1.0.113.
 *
 * Cross-OS / registry-format reference:
 *   refs/platforms/oh-my-pi/packages/coding-agent/test/marketplace/registry.test.ts:257-272
 *     installed_plugins.json shape: { version: 2, plugins: { key: Entry[] } }
 *   refs/platforms/codex/codex-rs/app-server/src/config/external_agent_config_tests.rs:808
 *     settings.json `enabledPlugins` is `{key: bool}` (cross-platform contract)
 */

import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

const cliSrc = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf-8");
const startSrc = readFileSync(resolve(ROOT, "start.mjs"), "utf-8");
const upgradeIdx = cliSrc.indexOf("async function upgrade");
// upgradeBody cap was 14000 at v1.0.114; the function has grown by ~10k chars
// through #523/#531/#542 (Layer 5b heal, Layer 6 mcp.json heal, Pi/OMP detect).
// CI run 25739349791 showed the cap truncating the `Run manually: git -C ...
// fetch ... reset` one-liner at offset 14073 — 73 chars past the cap. The
// "marketplace assertion provides a manual-fix one-liner" test then sliced
// `assertIdx + 1000` and got a short 243-char buffer that ended mid-string at
// `... marketplaceDir"} fe` (regex needs `fetch ... reset`, both cut off).
// 30000 contains the full ~24k-char upgrade() body plus 6k buffer for future
// growth. Cheaper than dynamically detecting function boundaries; safe because
// every test using upgradeBody asserts on CONTENTS, never on .length.
const upgradeBody = cliSrc.slice(upgradeIdx, upgradeIdx + 30000);

// ─────────────────────────────────────────────────────────
// start.mjs wires HEAL 3 + HEAL 4 (Change 1)
// ─────────────────────────────────────────────────────────

describe("start.mjs HEAL 3 + HEAL 4 wiring (v1.0.114 hotfix)", () => {
  test("imports the shared healInstalledPlugins module", () => {
    expect(startSrc).toMatch(/heal-installed-plugins\.mjs/);
    expect(startSrc).toContain("healInstalledPlugins");
  });

  test("HEAL 3+4 wiring lives between Layer 1 and Layer 4 blocks", () => {
    const layer1Idx = startSrc.indexOf("Self-heal Layer 1");
    const heal34Idx = startSrc.indexOf("HEAL 3");
    const layer4Idx = startSrc.indexOf("Self-heal Layer 4");
    expect(layer1Idx).toBeGreaterThan(-1);
    expect(heal34Idx).toBeGreaterThan(-1);
    expect(layer4Idx).toBeGreaterThan(-1);
    expect(heal34Idx).toBeGreaterThan(layer1Idx);
    expect(heal34Idx).toBeLessThan(layer4Idx);
  });

  test("HEAL 3+4 wiring is wrapped in defensive try/catch (never blocks MCP boot)", () => {
    const heal34Idx = startSrc.indexOf("HEAL 3");
    const layer4Idx = startSrc.indexOf("Self-heal Layer 4");
    const block = startSrc.slice(heal34Idx, layer4Idx);
    // outer try around the dynamic import + inner try around the call =
    // at least 2 try blocks
    expect((block.match(/try\s*\{/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(block).toContain("never block MCP boot");
  });

  test("uses ~/.claude/plugins/installed_plugins.json + ~/.claude/plugins/cache as inputs", () => {
    const heal34Idx = startSrc.indexOf("HEAL 3");
    const layer4Idx = startSrc.indexOf("Self-heal Layer 4");
    const block = startSrc.slice(heal34Idx, layer4Idx);
    expect(block).toContain("installed_plugins.json");
    expect(block).toContain('"cache"');
    expect(block).toContain('"context-mode@context-mode"');
  });
});

// ─────────────────────────────────────────────────────────
// cli.ts upgrade() — Change 2 — preflight, post-write, marketplace assertions
// ─────────────────────────────────────────────────────────

describe("cli.ts upgrade() pre-bump verification (v1.0.114 hotfix)", () => {
  test("reads pluginRoot/.claude-plugin/plugin.json BEFORE updatePluginRegistry", () => {
    const manifestIdx = upgradeBody.indexOf(".claude-plugin");
    const updateIdx = upgradeBody.indexOf("updatePluginRegistry");
    expect(manifestIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(-1);
    expect(manifestIdx).toBeLessThan(updateIdx);
  });

  test("throws when pluginRoot's plugin.json version disagrees with newVersion", () => {
    // The throw must mention the mismatch — surfacing the bug, not silently fixing.
    expect(upgradeBody).toMatch(
      /pluginRoot manifest version mismatch|Refusing to bump registry/,
    );
  });

  test("the throw appears between the in-place copy and updatePluginRegistry", () => {
    const stopIdx = upgradeBody.indexOf("Updated in-place to v");
    const throwIdx = upgradeBody.indexOf("Refusing to bump registry");
    const updateIdx = upgradeBody.indexOf("updatePluginRegistry");
    expect(stopIdx).toBeLessThan(throwIdx);
    expect(throwIdx).toBeLessThan(updateIdx);
  });

  // PR #650 wrapped the native-addon verifier and the \`npm install -g\` that
  // follows it in a platform gate: hosts that loaded context-mode in-process
  // had no npm global to update and no better-sqlite3 to verify. Both such
  // hosts are gone, the gate is gone with them, and what has to hold now is
  // that the two steps still run in that order for every host — unconditionally.
  test("upgrade() verifies the native addon ABI, then updates the npm global", () => {
    const upgradeIdx = cliSrc.indexOf("async function upgrade");
    const upgradeBody = cliSrc.slice(upgradeIdx, upgradeIdx + 30000);

    const abiIdx = upgradeBody.indexOf("Verifying native addon ABI");
    const npmGIdx = upgradeBody.indexOf('"install", "-g"');
    expect(abiIdx).toBeGreaterThan(0);
    expect(npmGIdx).toBeGreaterThan(abiIdx);
  });

  test("no platform gate stands between the ABI verifier and the npm global install", () => {
    // The failure this replaces was silent: a host that matched the gate got
    // an upgrade that reported success while skipping both steps. With the
    // predicate deleted, the way that shape comes back is a new gate, so the
    // assertion is on its absence rather than on its correct placement.
    expect(cliSrc).not.toContain("isInProcessPluginPlatform");
    expect(cliSrc).not.toContain("cachePluginRoot");
  });
});

describe("cli.ts upgrade() post-write registry consistency check (v1.0.114 hotfix)", () => {
  test("re-reads installed_plugins.json after updatePluginRegistry", () => {
    const updateIdx = upgradeBody.indexOf("updatePluginRegistry");
    const recheckIdx = upgradeBody.indexOf("Registry consistency check");
    expect(updateIdx).toBeGreaterThan(-1);
    expect(recheckIdx).toBeGreaterThan(-1);
    expect(recheckIdx).toBeGreaterThan(updateIdx);
  });

  test("throws on installPath that does not exist on disk", () => {
    expect(upgradeBody).toContain("installPath does not exist on disk");
  });

  test("throws on missing plugin.json manifest under installPath", () => {
    expect(upgradeBody).toMatch(/missing plugin\.json manifest/);
  });

  test("throws on version mismatch between registry and on-disk plugin.json", () => {
    // Must call out BOTH the registry version and the on-disk version so
    // the error message tells the user exactly what drifted.
    expect(upgradeBody).toMatch(
      /version mismatch.*registry.*plugin\.json|registry says.*but.*says/,
    );
  });

  test("post-write check reads from resolveClaudeConfigDir()", () => {
    // Must honor $CLAUDE_CONFIG_DIR (#460 round-3) so users with relocated
    // CC config dirs are still verified correctly. The resolveClaudeConfigDir
    // call lives in the post-write block — slice from updatePluginRegistry
    // onward so we include the full check body.
    const updateIdx = upgradeBody.indexOf("updatePluginRegistry");
    const recheckEnd = upgradeBody.indexOf("Marketplace clone version mismatch");
    const block = upgradeBody.slice(updateIdx, recheckEnd);
    expect(block).toMatch(/resolveClaudeConfigDir\(\)/);
  });
});

describe("cli.ts upgrade() marketplace post-pull assertion (v1.0.114 hotfix)", () => {
  test("verifies marketplace clone's plugin.json version matches newVersion", () => {
    expect(upgradeBody).toMatch(/Marketplace clone version mismatch|marketplace.*plugin\.json/i);
  });

  test("marketplace assertion runs AFTER the marketplace sync block", () => {
    const syncIdx = upgradeBody.indexOf("Marketplace clone synced");
    const assertIdx = upgradeBody.indexOf("Marketplace clone version mismatch");
    expect(syncIdx).toBeGreaterThan(-1);
    expect(assertIdx).toBeGreaterThan(-1);
    expect(assertIdx).toBeGreaterThan(syncIdx);
  });

  test("marketplace mismatch warns (does NOT throw) — npm-only users have no clone", () => {
    // A throw inside upgrade() would abort the rest of the flow; warn keeps
    // upgrade going so the cache install — the actually-loaded path — is
    // still completed for users without a marketplace clone.
    // The warn appears inside the marketplace assertion block; slice from
    // the assertion start to end of upgrade body capture so we cover both
    // the warn-string flow and any catch-block fallback.
    // Bound the window by the next statement in upgrade(), not by a byte
    // count: a fixed 2000-char slice reached past the assertion into the
    // dependency-install step below it, and the unrelated \`throw\` there made
    // this test fail for a change that never touched the marketplace block.
    const assertIdx = upgradeBody.indexOf("marketplace post-pull assertion");
    const blockEnd = upgradeBody.indexOf("// Install production deps", assertIdx);
    expect(assertIdx).toBeGreaterThan(-1);
    expect(blockEnd).toBeGreaterThan(assertIdx);
    const block = upgradeBody.slice(assertIdx, blockEnd);
    expect(block).toMatch(/p\.log\.warn/);
    expect(block).not.toMatch(/throw new Error/);
  });

  test("marketplace assertion provides a manual-fix one-liner", () => {
    const assertIdx = upgradeBody.indexOf("Marketplace clone version mismatch");
    const block = upgradeBody.slice(assertIdx, assertIdx + 1000);
    expect(block).toMatch(/git.*-C.*marketplaceDir.*fetch.*reset/);
  });
});

// ─────────────────────────────────────────────────────────
// End-to-end: bug-prevention contract
// ─────────────────────────────────────────────────────────

describe("v1.0.114 hotfix — full bug-prevention contract", () => {
  test("upgrade() now CANNOT silently leave registry+disk in disagreement", () => {
    // The upgrade flow must contain BOTH preflight (pre-write) AND
    // post-write checks. Either alone is insufficient — preflight protects
    // against in-place copy races, post-write protects against adapter
    // misbehavior.
    const stopIdx = upgradeBody.indexOf("Updated in-place to v");
    const preflightIdx = upgradeBody.indexOf("Refusing to bump registry");
    const updateIdx = upgradeBody.indexOf("updatePluginRegistry");
    const postIdx = upgradeBody.indexOf("Registry consistency check");
    expect(stopIdx).toBeGreaterThan(-1);
    expect(preflightIdx).toBeGreaterThan(stopIdx);
    expect(updateIdx).toBeGreaterThan(preflightIdx);
    expect(postIdx).toBeGreaterThan(updateIdx);
  });

  test("start.mjs HEAL block + cli.ts assertions cite v1.0.114 hotfix", () => {
    expect(startSrc).toMatch(/v1\.0\.113|v1\.0\.114|HEAL 3|HEAL 4/);
    expect(upgradeBody).toMatch(/v1\.0\.114|hotfix/);
  });
});
