/**
 * The retrieval harness must not lose a measurement it cannot make.
 *
 * `docs/research/retrieval-2026-08-18.md` was overwritten by a run with no
 * embedding endpoint: the hybrid column became eight rows of `—`, and the run
 * that could measure it had already finished. Two rules came out of that, and
 * both are asserted here — the first against the guard directly, the second by
 * running the real script over a temp file, since the failure was in the
 * script's behaviour and not in the rule.
 */

import { describe, test, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { checkReportOverwrite, reportArms } from "../../scripts/lib/report-guard.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const HARNESS = join(ROOT, "scripts/measure-retrieval.mjs");

/** A report as the harness renders it, with or without the hybrid column. */
function reportText(opts: { hybrid: boolean }): string {
  const h = (value: string) => (opts.hybrid ? value : "—");
  return [
    "# Retrieval quality — measured baseline",
    "",
    "**Date:** 2026-08-18",
    "",
    "## Result",
    "",
    "| metric | lexical | hybrid |",
    "|---|---|---|",
    `| precision@1 | 66.2% | ${h("87.8%")} |`,
    `| recall@5 | 77.0% | ${h("97.3%")} |`,
    `| MRR@5 | 0.699 | ${h("0.910")} |`,
    "",
  ].join("\n");
}

const workdirs: string[] = [];
function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ctx-report-guard-"));
  workdirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of workdirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("reportArms", () => {
  test("reads the arms off the rendered table, not off the environment", () => {
    expect(reportArms(reportText({ hybrid: true }))).toEqual({ lexical: true, hybrid: true });
    expect(reportArms(reportText({ hybrid: false }))).toEqual({ lexical: true, hybrid: false });
  });

  test("a file that is not a report claims nothing", () => {
    expect(reportArms("# Notes\n\nnothing measured here\n")).toEqual({ lexical: false, hybrid: false });
    expect(reportArms("")).toEqual({ lexical: false, hybrid: false });
  });
});

describe("checkReportOverwrite", () => {
  const both = { lexical: true, hybrid: true };
  const lexicalOnly = { lexical: true, hybrid: false };

  test("writing where there is no report is always allowed", () => {
    expect(checkReportOverwrite({ existing: null, arms: lexicalOnly }).ok).toBe(true);
  });

  test("a weaker run is refused, and the message says what would be lost", () => {
    const verdict = checkReportOverwrite({ existing: reportText({ hybrid: true }), arms: lexicalOnly });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("hybrid");
    expect(verdict.reason).toContain("--force");
  });

  test("--force overwrites, and says which arm it is discarding", () => {
    const verdict = checkReportOverwrite({
      existing: reportText({ hybrid: true }),
      arms: lexicalOnly,
      force: true,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.forced).toEqual(["hybrid"]);
  });

  test("an equal or stronger run overwrites without a flag", () => {
    // Re-measuring is the normal use. Demanding --force for it would train
    // everyone to pass --force by reflex, which is the guard undone.
    expect(checkReportOverwrite({ existing: reportText({ hybrid: false }), arms: lexicalOnly }).ok).toBe(true);
    expect(checkReportOverwrite({ existing: reportText({ hybrid: false }), arms: both }).ok).toBe(true);
    expect(checkReportOverwrite({ existing: reportText({ hybrid: true }), arms: both }).ok).toBe(true);
  });
});

// The harness runs with --lexical-only, so these need no embedding endpoint —
// which is precisely the configuration that caused the loss.
describe("the harness itself", () => {
  const run = (args: string[]) =>
    spawnSync("node", [HARNESS, "--lexical-only", ...args], { cwd: ROOT, encoding: "utf-8" });

  test("without --report it writes nothing", () => {
    const target = join(workdir(), "retrieval.md");
    const r = run([]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("precision@1");
    expect(existsSync(target)).toBe(false);
    // And it says nothing about having written a file.
    expect(r.stdout).not.toContain("report written");
  });

  test("--report <path> writes where no report exists", () => {
    const target = join(workdir(), "retrieval.md");
    const r = run(["--report", target]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toContain("## Result");
  });

  test("a run without the hybrid arm refuses to overwrite a report that has it", () => {
    const target = join(workdir(), "retrieval.md");
    const before = reportText({ hybrid: true });
    writeFileSync(target, before);

    const r = run(["--report", target]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("refusing to overwrite");
    expect(r.stderr).toContain("--force");
    // The point of the rule: the file is untouched.
    expect(readFileSync(target, "utf-8")).toBe(before);
  });

  test("--force overwrites it anyway", () => {
    const target = join(workdir(), "retrieval.md");
    writeFileSync(target, reportText({ hybrid: true }));

    const r = run(["--report", target, "--force"]);
    expect(r.status, r.stderr).toBe(0);
    const after = readFileSync(target, "utf-8");
    expect(after).not.toBe(reportText({ hybrid: true }));
    expect(after).toContain("The hybrid arm did not run");
  });
});
