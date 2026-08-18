/**
 * End-to-end against the REAL native library.
 *
 * Skipped wholesale when `@ff-labs/fff-node` cannot load — unsupported
 * platform, optional dependency not installed, `--ignore-scripts`. The rest of
 * `tests/fff/` covers the same contracts through the loader seam, so this file
 * is the only place that needs the binary.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { acquireFinder, fffHealthReport, __resetFinderRegistryForTests } from "../../src/fff/finder.js";
import type { FffFinder } from "../../src/fff/finder.js";
import { isFffAvailable } from "../../src/fff/native.js";
import { dbDiskBytes } from "../../src/fff/paths.js";

const available = await isFffAvailable();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(!available)("fff native smoke", () => {
  let workspace: string;
  let project: string;
  let storageDir: string;
  let finder: FffFinder;

  beforeAll(async () => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), "fff-smoke-")));
    project = join(workspace, "project");
    storageDir = join(workspace, "store");
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "src", "alpha.ts"), "export const ALPHA = 1;\n// TODO: alpha\n");
    writeFileSync(join(project, "src", "beta.ts"), "// TODO: beta\n");

    const acquired = await acquireFinder(project, { storageDir, watchDebounceMs: 20 });
    if (!acquired.ok) throw new Error(`native acquire failed: ${acquired.error}`);
    finder = acquired.value;
  });

  afterAll(() => {
    __resetFinderRegistryForTests();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("finds files with absolute paths inside the project", () => {
    const result = finder.fileSearch("alpha", { pageSize: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.length).toBeGreaterThan(0);
    const hit = result.value.items[0]!;
    expect(hit.path).toBe(join(project, "src", "alpha.ts"));
    expect(hit.relativePath.replace(/\\/g, "/")).toBe("src/alpha.ts");
    expect(hit.modified).toBeGreaterThan(1_600_000_000_000); // milliseconds, not seconds
    expect(result.value.scores).toHaveLength(result.value.items.length);
  });

  it("greps with honest totals", () => {
    const result = finder.grep("TODO", { mode: "plain", pageSize: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // pageSize is a FILE budget: one file's worth of matches comes back, and
    // the cursor — not totalMatched — says the answer is partial.
    expect(result.value.items.length).toBeGreaterThan(0);
    expect(result.value.filesSearched).toBe(1);
    expect(result.value.filteredFileCount).toBeGreaterThanOrEqual(2);
    expect(result.value.truncated).toBe(true);
    expect(result.value.nextCursor).not.toBeNull();

    const page2 = finder.grep("TODO", { mode: "plain", pageSize: 1, cursor: result.value.nextCursor });
    expect(page2.ok).toBe(true);
    if (page2.ok) expect(page2.value.items[0]?.path).not.toBe(result.value.items[0]!.path);
  });

  it("globs", () => {
    const result = finder.glob("**/*.ts");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.items.length).toBeGreaterThanOrEqual(2);
  });

  it("persists ranking feedback to the per-project database", async () => {
    const tracked = await finder.trackQuery("alpha", join(project, "src", "alpha.ts"));
    expect(tracked.ok).toBe(true);
    expect(dbDiskBytes(finder.frecencyDbPath)).toBeGreaterThan(0);
    expect(finder.frecencyDbPath.startsWith(storageDir)).toBe(true);
  });

  it("delivers filesystem events through the shared bus", async () => {
    const seen: string[] = [];
    const off = finder.onFsChange((events) => seen.push(...events.map((e) => e.path)));

    writeFileSync(join(project, "src", "gamma.ts"), "export const GAMMA = 3;\n");
    for (let i = 0; i < 50 && seen.length === 0; i += 1) await sleep(100);

    off();
    expect(seen.some((p) => p.endsWith("gamma.ts"))).toBe(true);

    // Unsubscribed: no further deliveries.
    const before = seen.length;
    writeFileSync(join(project, "src", "delta.ts"), "export const DELTA = 4;\n");
    await sleep(300);
    expect(seen).toHaveLength(before);
  });

  it("reports health for the doctor", async () => {
    const report = await fffHealthReport(project);
    expect(report.enabled).toBe(true);
    expect(report.available).toBe(true);
    expect(report.version).toBeTruthy();
    expect(report.liveRoots).toContain(finder.projectRoot);
  });
});
