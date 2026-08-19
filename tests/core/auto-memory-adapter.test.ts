import "../setup-home";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { searchAutoMemory } from "../../src/search/auto-memory.js";
import { CodexAdapter } from "../../src/adapters/codex/index.js";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code/index.js";

/**
 * Slice 4 — searchAutoMemory accepts an adapter and uses its
 * getInstructionFiles() / getMemoryDir() / getConfigDir() instead of
 * hardcoded ~/.claude / CLAUDE.md.
 *
 * Without an adapter it falls back to the historical Claude defaults
 * (so existing call sites keep working).
 */

describe("searchAutoMemory adapter dispatch", () => {
  let projectDir: string;
  let configDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ctxam-proj-"));
    configDir = mkdtempSync(join(tmpdir(), "ctxam-cfg-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it("uses adapter.getInstructionFiles() to discover project rule files", () => {
    // Codex declares ['AGENTS.md', 'AGENTS.override.md'].
    writeFileSync(
      join(projectDir, "AGENTS.md"),
      "# Codex Agent Rules\nUse exact terms like ALPHA-CODEX-MARKER everywhere.\n",
      "utf-8",
    );
    const adapter = new CodexAdapter();

    const results = searchAutoMemory(
      ["ALPHA-CODEX-MARKER"],
      5,
      projectDir,
      undefined,
      adapter,
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toContain("AGENTS.md");
  });

  it("uses adapter.getMemoryDir() (e.g. ~/.codex/memories) for memory scan", () => {
    // Build a fake codex config with memories/ subdir.
    const fakeMemoriesDir = join(configDir, "memories");
    mkdirSync(fakeMemoriesDir, { recursive: true });
    writeFileSync(
      join(fakeMemoriesDir, "decisions.md"),
      "Always prefer the BETA-MEMORY-TOKEN approach.\n",
      "utf-8",
    );

    // Custom adapter overriding getConfigDir + getMemoryDir to point at fixture.
    const adapter = new CodexAdapter();
    (adapter as unknown as { getConfigDir(): string }).getConfigDir = () => configDir;
    (adapter as unknown as { getMemoryDir(): string }).getMemoryDir = () => fakeMemoriesDir;
    (adapter as unknown as { getInstructionFiles(): string[] }).getInstructionFiles = () => ["AGENTS.md"];

    const results = searchAutoMemory(
      ["BETA-MEMORY-TOKEN"],
      5,
      projectDir,
      undefined,
      adapter,
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toContain("decisions.md");
  });

  it("falls back to CLAUDE.md scan when no adapter is provided", () => {
    writeFileSync(
      join(projectDir, "CLAUDE.md"),
      "Project notes mention GAMMA-FALLBACK-FLAG repeatedly.\n",
      "utf-8",
    );

    const results = searchAutoMemory(["GAMMA-FALLBACK-FLAG"], 5, projectDir);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe("project/CLAUDE.md");
  });

  it("scans multiple instruction files when adapter declares multiple (e.g. AGENTS.md + AGENTS.override.md)", () => {
    writeFileSync(
      join(projectDir, "AGENTS.override.md"),
      "Override note: DELTA-OVERRIDE-MARKER takes precedence.\n",
      "utf-8",
    );
    const adapter = new CodexAdapter();

    const results = searchAutoMemory(
      ["DELTA-OVERRIDE-MARKER"],
      5,
      projectDir,
      undefined,
      adapter,
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toContain("AGENTS.override.md");
  });

  // This case used to supply GeminiCLIAdapter and assert GEMINI.md, proving
  // the lookup was table-driven rather than an AGENTS.md special case. Gemini
  // CLI went with the other fourteen hosts in 15a02cf, and with it the only
  // convention that was neither CLAUDE.md nor AGENTS.md. What still exists is
  // the other half of the same property: a second adapter, a second file
  // name, chosen by the adapter and not by searchAutoMemory. Dropping the
  // case entirely would have left the Claude convention asserted nowhere but
  // in the no-adapter fallback, where CLAUDE.md is also the hardcoded default
  // — a test that cannot tell dispatch from coincidence.
  it("uses the Claude convention (CLAUDE.md) when ClaudeCodeAdapter is supplied", () => {
    writeFileSync(
      join(projectDir, "CLAUDE.md"),
      "Claude rules: invoke EPSILON-CLAUDE-FLAG on every read.\n",
      "utf-8",
    );
    // AGENTS.md sits next to it: if the adapter were ignored and the codex
    // list applied anyway, this file would win and the assertion would fail.
    writeFileSync(
      join(projectDir, "AGENTS.md"),
      "Codex rules: invoke EPSILON-CLAUDE-FLAG on every read.\n",
      "utf-8",
    );

    const results = searchAutoMemory(
      ["EPSILON-CLAUDE-FLAG"],
      5,
      projectDir,
      undefined,
      new ClaudeCodeAdapter(),
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.source.includes("CLAUDE.md"))).toBe(true);
    expect(results.every((r) => !r.source.includes("AGENTS.md"))).toBe(true);
  });
});

// Issue #663 — searchAutoMemory must NOT cross project boundaries.
//
// Before this fix, two terminals open in different repos shared the same
// `<configDir>/memory` directory; auto-memory from project-A leaked into
// `ctx_search` results inside project-B sessions. The fix routes the path
// through `adapter.getMemoryDir(projectDir)`, which scopes via
// `hashProjectDirCanonical(projectDir)`.
//
// This test pins the contract at the integration boundary: write a marker
// into project-A's scoped memory dir, search from project-B, expect zero
// hits. If the leak ever regresses, this test fails immediately.
describe("searchAutoMemory project isolation (#663)", () => {
  let projectA: string;
  let projectB: string;
  let configDirForA: string;
  let configDirForB: string;

  beforeEach(() => {
    projectA = mkdtempSync(join(tmpdir(), "ctxam-projA-"));
    projectB = mkdtempSync(join(tmpdir(), "ctxam-projB-"));
    configDirForA = mkdtempSync(join(tmpdir(), "ctxam-cfgA-"));
    configDirForB = mkdtempSync(join(tmpdir(), "ctxam-cfgB-"));
  });

  afterEach(() => {
    for (const d of [projectA, projectB, configDirForA, configDirForB]) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("memory written in projectA does not appear in projectB results when the adapter scopes by projectDir", async () => {
    const { hashProjectDirCanonical } = await import("../../src/session/db.js");

    // Adapter that mimics shared-configDir layout: both projects point at
    // the SAME configDir base, but the project hash should separate them.
    const sharedConfigDir = configDirForA;
    const adapter = new CodexAdapter();
    (adapter as unknown as { getConfigDir(): string }).getConfigDir = () => sharedConfigDir;
    (adapter as unknown as { getInstructionFiles(): string[] }).getInstructionFiles = () => ["AGENTS.md"];
    // Spy on the projectDir-aware override — delegate to a hash-scoped layout
    // so we exercise the same routing real adapters use post-#663.
    (adapter as unknown as { getMemoryDir(p?: string): string }).getMemoryDir =
      (p?: string) =>
        p
          ? join(sharedConfigDir, "memories", hashProjectDirCanonical(p))
          : join(sharedConfigDir, "memories");

    // Write a project-A-only marker into project-A's scoped memory dir.
    const projectAMemoryDir = join(
      sharedConfigDir,
      "memories",
      hashProjectDirCanonical(projectA),
    );
    mkdirSync(projectAMemoryDir, { recursive: true });
    writeFileSync(
      join(projectAMemoryDir, "secret.md"),
      "PROJECT-A-LEAK-CANARY should never be visible from project B.\n",
      "utf-8",
    );

    // Run searchAutoMemory from project-B's perspective.
    const results = searchAutoMemory(
      ["PROJECT-A-LEAK-CANARY"],
      5,
      projectB,
      undefined,
      adapter,
    );

    expect(results.length).toBe(0);
  });

  it("memory in projectA is still visible to projectA itself (positive control)", async () => {
    const { hashProjectDirCanonical } = await import("../../src/session/db.js");

    const sharedConfigDir = configDirForA;
    const adapter = new CodexAdapter();
    (adapter as unknown as { getConfigDir(): string }).getConfigDir = () => sharedConfigDir;
    (adapter as unknown as { getInstructionFiles(): string[] }).getInstructionFiles = () => ["AGENTS.md"];
    (adapter as unknown as { getMemoryDir(p?: string): string }).getMemoryDir =
      (p?: string) =>
        p
          ? join(sharedConfigDir, "memories", hashProjectDirCanonical(p))
          : join(sharedConfigDir, "memories");

    const projectAMemoryDir = join(
      sharedConfigDir,
      "memories",
      hashProjectDirCanonical(projectA),
    );
    mkdirSync(projectAMemoryDir, { recursive: true });
    writeFileSync(
      join(projectAMemoryDir, "notes.md"),
      "PROJECT-A-POSITIVE-MARKER must be findable from project A.\n",
      "utf-8",
    );

    const results = searchAutoMemory(
      ["PROJECT-A-POSITIVE-MARKER"],
      5,
      projectA,
      undefined,
      adapter,
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toContain("notes.md");
  });
});
