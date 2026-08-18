/**
 * The three output-compression samples.
 *
 * Fixtures are real where realism is what is being tested:
 * `tests/fixtures/compress/vitest-run.txt` and `vitest-failing.txt` are the
 * verbatim output of `npx vitest run --reporter=verbose` on this repository's
 * own truncate suites. The env fixture is synthetic on purpose — a real `env`
 * dump would put live credentials in git — but its shape and its (fabricated)
 * credentials are exactly what `env` prints.
 *
 * The invariant every sample shares: whatever it removes, it reports.
 */

import { describe, test, beforeEach, afterEach } from "vitest";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  compressAndTruncate,
  compressExecResult,
  compressOptionsFromEnv,
  compressOutput,
  detectRunner,
  foldEnvDump,
  foldRepeatedLines,
  foldTestOutput,
  normalizeLogLine,
  outputCompressionEnabled,
} from "../../src/compress/index.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "compress");
const readFixture = (name: string) => readFileSync(join(FIXTURES, name), "utf-8");

const ENV_KEYS = [
  "CONTEXT_MODE_EXEC_COMPRESS",
  "CONTEXT_MODE_COMPRESS_TESTS",
  "CONTEXT_MODE_COMPRESS_ENV",
  "CONTEXT_MODE_COMPRESS_REPEATS",
  "CONTEXT_MODE_COMPRESS_ENV_VALUES",
  "CONTEXT_MODE_TRUNCATE_FOOTER",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// ─────────────────────────────────────────────────────────
// Sample 1 — repeated log lines
// ─────────────────────────────────────────────────────────

describe("foldRepeatedLines", () => {
  const retryLog = Array.from({ length: 200 }, (_, i) =>
    `2026-08-18T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.123Z ` +
    `WARN  upstream timeout, retry ${i + 1} of 200 (waited 250ms)`,
  ).join("\n");

  test("normalization erases timestamps, counters, uuids and hex ids", () => {
    assert.equal(
      normalizeLogLine("2026-08-18T10:00:01.123Z retry 7 of 200 id=9f1c2b3a4d5e6f70 took 25ms"),
      normalizeLogLine("2026-08-18T10:04:59.987Z retry 8 of 200 id=aabbccdd11223344 took 3ms"),
    );
  });

  test("normalization does not merge lines that differ in a word", () => {
    assert.notEqual(
      normalizeLogLine("10:00:01 connect failed"),
      normalizeLogLine("10:00:01 connect refused"),
    );
  });

  test("folds a near-identical run to one line plus a counted marker", () => {
    const pass = foldRepeatedLines(retryLog);
    const lines = pass.text.split("\n");
    assert.equal(lines.length, 2);
    assert.equal(lines[0], retryLog.split("\n")[0]);
    assert.equal(lines[1], "… x199 more near-identical line(s) folded (differ only in timestamp/counter)");
    assert.equal(pass.note?.foldedLines, 198);
    assert.equal(pass.note?.detail, "1 run(s), longest x200");
  });

  test("labels an exact-duplicate run as identical", () => {
    const pass = foldRepeatedLines(["same", "same", "same", "same", "tail"].join("\n"));
    assert.equal(pass.text, "same\n… x3 more identical line(s) folded\ntail");
    assert.equal(pass.note?.foldedLines, 2);
  });

  test("leaves short runs and mixed logs alone", () => {
    const mixed = "start\nA failed\nB failed\ndone";
    assert.equal(foldRepeatedLines(mixed).text, mixed);
    assert.equal(foldRepeatedLines(mixed).note, null);
  });

  test("the marker keeps the run's indentation", () => {
    const indented = ["    tick 1", "    tick 2", "    tick 3"].join("\n");
    assert.ok(foldRepeatedLines(indented).text.split("\n")[1].startsWith("    …"));
  });
});

// ─────────────────────────────────────────────────────────
// Sample 2 — env dumps
// ─────────────────────────────────────────────────────────

describe("foldEnvDump", () => {
  const dump = readFixture("env-dump.txt");

  test("folds a real-shaped env dump to a head plus names", () => {
    const pass = foldEnvDump(dump);
    const lines = pass.text.split("\n");
    assert.equal(lines[0], "# synthetic `env` output — every credential below is fabricated for tests");
    const marker = lines.find(l => l.startsWith("… x"))!;
    assert.ok(marker.startsWith("… x32 more env var(s) folded (names only):"), marker);
    assert.equal(pass.note?.sample, "env");
    assert.equal(pass.note?.foldedLines, 31);
    assert.ok(pass.note?.detail.startsWith("40 var(s), 8 shown"), pass.note?.detail);
  });

  test("credential values in the shown head are redacted, not printed", () => {
    const { text } = foldEnvDump(dump);
    assert.ok(!text.includes("AKIAIOSFODNN7EXAMPLE"));
    assert.ok(!text.includes("ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"));
    assert.ok(!text.includes("sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD"));
    assert.ok(text.includes("[redacted:aws-access-key]"));
    assert.ok(text.includes("[redacted:github-token]"));
    assert.match(foldEnvDump(dump).note!.detail, /\d+ secret value\(s\) redacted/);
  });

  test("credential values past the head are never printed at all", () => {
    const { text } = foldEnvDump(dump);
    // Digit-group shape deliberately avoided: GitHub's push protection matches
    // the real `xoxb-<digits>-<digits>-<alnum>` layout and would reject the
    // commit. The value still matches the plugin's own `slack-token` pattern
    // (src/session/redact.ts), which is what this fixture is here to exercise.
    assert.ok(!text.includes("xoxb-FIXTURE-NOT-A-REAL-TOKEN-AbCdEfGhIjKlMnOpQrSt"));
    assert.ok(!text.includes("hunter2ButLongerAndWithDigits9"));
    // …but the reader still learns the variables exist.
    assert.ok(text.includes("SLACK_BOT_TOKEN"));
    assert.ok(text.includes("DATABASE_PASSWORD"));
  });

  test("values:false hides even the screened head", () => {
    const { text, note } = foldEnvDump(dump, { values: false });
    assert.ok(text.includes("SHELL=[value hidden]"));
    assert.ok(!text.includes("/bin/bash"));
    assert.ok(note!.detail.endsWith("values hidden"));
  });

  test("a short run of assignments is left alone", () => {
    const short = "make: entering dir\nCC=gcc\nCFLAGS=-O2\nLD=ld\nbuilding…";
    assert.equal(foldEnvDump(short).text, short);
    assert.equal(foldEnvDump(short).note, null);
  });

  test("only consecutive assignment runs fold — surrounding log survives", () => {
    const body = ["=== env ===", ...Array.from({ length: 20 }, (_, i) => `VAR_${i}=value_${i}`), "=== done ==="];
    const { text } = foldEnvDump(body.join("\n"));
    assert.ok(text.startsWith("=== env ==="));
    assert.ok(text.endsWith("=== done ==="));
  });
});

// ─────────────────────────────────────────────────────────
// Sample 3 — test-runner output
// ─────────────────────────────────────────────────────────

describe("foldTestOutput", () => {
  test("detects the runner from real output", () => {
    assert.equal(detectRunner(readFixture("vitest-run.txt")), "vitest");
    assert.equal(detectRunner("PASS src/a.test.js\nTests:       1 passed, 1 total"), "jest");
    assert.equal(detectRunner("============ test session starts ============"), "pytest");
    assert.equal(detectRunner("=== RUN   TestA\n--- PASS: TestA (0.00s)"), "go");
    assert.equal(detectRunner("build succeeded in 4s\nnothing to do"), null);
  });

  test("real green vitest run: ticks fold, summary survives", () => {
    const raw = readFixture("vitest-run.txt");
    const pass = foldTestOutput(raw);
    const green = raw.split("\n").filter(l => /^\s*✓\s/.test(l)).length;
    assert.ok(green > 30, `fixture should be mostly green, got ${green}`);
    assert.equal(pass.note?.foldedLines, green - 1);
    assert.equal(pass.text.split("\n").filter(l => /^\s*✓\s/.test(l)).length, 0);
    assert.ok(pass.text.includes("… x" + green + " passing line(s) folded"));
    assert.ok(pass.text.includes("Test Files  2 passed (2)"));
    assert.ok(pass.text.includes("Tests  41 passed (41)"));
    assert.ok(pass.note?.detail.startsWith("vitest,"));
  });

  test("real failing vitest run: every failure line is kept", () => {
    const raw = readFixture("vitest-failing.txt");
    const { text, note } = foldTestOutput(raw);
    assert.ok(text.includes("× tests/tmp-compress-fixture.test.ts > fixture suite > fails on purpose"));
    assert.ok(text.includes("FAIL  tests/tmp-compress-fixture.test.ts"));
    assert.ok(text.includes("AssertionError"));
    assert.ok(text.includes("Test Files  1 failed | 1 passed (2)"));
    assert.ok(text.split("\n").length < raw.split("\n").length);
    assert.match(note!.detail, /^vitest, \d+ green line\(s\), \d+ failure line\(s\) kept$/);
  });

  test("jest: PASS banners fold, FAIL block and counts survive", () => {
    const jest = [
      "PASS src/alpha.test.js",
      "PASS src/beta.test.js",
      "FAIL src/gamma.test.js",
      "  ● gamma › adds",
      "    expect(received).toBe(expected)",
      "Test Suites: 1 failed, 2 passed, 3 total",
      "Tests:       1 failed, 5 passed, 6 total",
    ].join("\n");
    const { text, note } = foldTestOutput(jest);
    assert.ok(text.startsWith("… x2 passing line(s) folded"));
    assert.ok(text.includes("FAIL src/gamma.test.js"));
    assert.ok(text.includes("Tests:       1 failed, 5 passed, 6 total"));
    assert.equal(note?.foldedLines, 1);
  });

  test("pytest: all-dot progress lines fold, the failing file and summary stay", () => {
    const pytest = [
      "============================= test session starts ==============================",
      "platform linux -- Python 3.11.6, pytest-8.0.0, pluggy-1.4.0",
      "collected 20 items",
      "",
      "tests/test_alpha.py ......                                               [ 30%]",
      "tests/test_beta.py ......                                                [ 60%]",
      "tests/test_gamma.py ..F...                                               [100%]",
      "",
      "=================================== FAILURES ===================================",
      "E       assert 1 == 2",
      "=========================== short test summary info ============================",
      "FAILED tests/test_gamma.py::test_gamma_three - assert 1 == 2",
      "========================= 1 failed, 19 passed in 0.35s =========================",
    ].join("\n");
    const { text, note } = foldTestOutput(pytest);
    assert.ok(!text.includes("test_alpha.py"));
    assert.ok(!text.includes("test_beta.py"));
    assert.ok(text.includes("tests/test_gamma.py ..F..."));
    assert.ok(text.includes("FAILED tests/test_gamma.py::test_gamma_three"));
    assert.ok(text.includes("1 failed, 19 passed in 0.35s"));
    assert.equal(note?.foldedLines, 1);
  });

  test("go test: RUN/PASS chatter folds, the FAIL block stays", () => {
    const go = [
      "=== RUN   TestAlpha",
      "--- PASS: TestAlpha (0.00s)",
      "=== RUN   TestBeta",
      "--- PASS: TestBeta (0.00s)",
      "=== RUN   TestGamma",
      "--- FAIL: TestGamma (0.00s)",
      "    gamma_test.go:12: expected 1, got 2",
      "FAIL",
      "exit status 1",
      "FAIL\texample.com/pkg\t0.008s",
    ].join("\n");
    const { text, note } = foldTestOutput(go);
    assert.ok(text.startsWith("… x5 passing line(s) folded"));
    assert.ok(text.includes("--- FAIL: TestGamma (0.00s)"));
    assert.ok(text.includes("gamma_test.go:12: expected 1, got 2"));
    assert.equal(note?.foldedLines, 4);
  });

  test("does nothing to output that is not a test run", () => {
    const build = "webpack 5.90.0 compiled successfully in 4021 ms\nasset main.js 1.2 MiB";
    assert.equal(foldTestOutput(build).text, build);
    assert.equal(foldTestOutput(build).note, null);
  });
});

// ─────────────────────────────────────────────────────────
// Orchestration + the honest footer
// ─────────────────────────────────────────────────────────

describe("compressOutput", () => {
  test("runs the samples in order and sums what they folded", () => {
    const text = [
      readFixture("vitest-run.txt"),
      readFixture("env-dump.txt"),
      Array.from({ length: 10 }, () => "heartbeat ok").join("\n"),
    ].join("\n");
    const result = compressOutput(text);
    const samples = result.notes.map(n => n.sample);
    assert.deepEqual(samples, ["tests", "env", "repeats"]);
    assert.equal(result.foldedLines, result.notes.reduce((n, x) => n + x.foldedLines, 0));
    assert.ok(result.text.split("\n").length < text.split("\n").length - result.foldedLines + 1);
  });

  test("per-sample switches turn samples off", () => {
    const text = readFixture("vitest-run.txt");
    assert.equal(compressOutput(text, { tests: false, repeats: false, envDump: false }).text, text);
    assert.equal(compressOutput(text, { tests: false, repeats: false, envDump: false }).notes.length, 0);
  });

  test("compressOptionsFromEnv reads the CONTEXT_MODE_COMPRESS_* switches", () => {
    assert.deepEqual(compressOptionsFromEnv({} as NodeJS.ProcessEnv), {
      tests: true, envDump: true, repeats: true, envValues: true,
    });
    assert.deepEqual(
      compressOptionsFromEnv({
        CONTEXT_MODE_COMPRESS_TESTS: "0",
        CONTEXT_MODE_COMPRESS_ENV: "0",
        CONTEXT_MODE_COMPRESS_REPEATS: "0",
        CONTEXT_MODE_COMPRESS_ENV_VALUES: "0",
      } as NodeJS.ProcessEnv),
      { tests: false, envDump: false, repeats: false, envValues: false },
    );
  });

  test("compressAndTruncate reports folding and truncation in one footer", () => {
    const text = readFixture("vitest-run.txt");
    const { text: out } = compressAndTruncate(text, { maxBytes: 260 });
    assert.ok(Buffer.byteLength(out) <= 260, `got ${Buffer.byteLength(out)} bytes`);
    assert.ok(out.includes("> Showing "));
    assert.ok(out.includes("> Folded: test output -"));
  });
});

// ─────────────────────────────────────────────────────────
// Executor wiring
// ─────────────────────────────────────────────────────────

describe("outputCompressionEnabled", () => {
  const env = (v?: string) => (v === undefined ? {} : { CONTEXT_MODE_EXEC_COMPRESS: v }) as NodeJS.ProcessEnv;

  test("off by default — the indexing path must stay verbatim", () => {
    assert.equal(outputCompressionEnabled(undefined, env()), false);
  });

  test("CONTEXT_MODE_EXEC_COMPRESS=1 turns it on for callers that said nothing", () => {
    assert.equal(outputCompressionEnabled(undefined, env("1")), true);
  });

  test("an explicit opt-in wins over an unset env", () => {
    assert.equal(outputCompressionEnabled(true, env()), true);
    assert.equal(outputCompressionEnabled(false, env("1")), false);
  });

  test("CONTEXT_MODE_EXEC_COMPRESS=0 is a kill switch that beats the opt-in", () => {
    assert.equal(outputCompressionEnabled(true, env("0")), false);
  });
});

describe("compressExecResult", () => {
  const base = { stderr: "", exitCode: 0, timedOut: false };
  const noisy = { ...base, stdout: readFixture("vitest-run.txt") };

  test("returns the very same object when compression is off", () => {
    assert.equal(compressExecResult(noisy, undefined, {} as NodeJS.ProcessEnv), noisy);
  });

  test("folds stdout and appends the honest footer when asked", () => {
    const out = compressExecResult(noisy, true, {} as NodeJS.ProcessEnv);
    assert.notEqual(out, noisy);
    assert.ok(out.stdout.split("\n").length < noisy.stdout.split("\n").length);
    assert.ok(out.stdout.includes("> Folded: test output -"));
    assert.equal(out.stderr, noisy.stderr);
    assert.equal(out.exitCode, 0);
  });

  test("leaves stderr alone — it carries the executor's own kill notes", () => {
    const withErr = { ...noisy, stderr: "\n[output capped at 32MB — process killed]" };
    const out = compressExecResult(withErr, true, {} as NodeJS.ProcessEnv);
    assert.equal(out.stderr, withErr.stderr);
  });

  test("no sample fired means no footer and no copy", () => {
    const plain = { ...base, stdout: "one\ntwo\nthree" };
    assert.equal(compressExecResult(plain, true, {} as NodeJS.ProcessEnv), plain);
  });

  test("empty stdout is passed through", () => {
    const empty = { ...base, stdout: "" };
    assert.equal(compressExecResult(empty, true, {} as NodeJS.ProcessEnv), empty);
  });
});

// ─────────────────────────────────────────────────────────
// The indexing path must not be compressed
// ─────────────────────────────────────────────────────────

describe("ctx_batch_execute keeps indexing verbatim output", () => {
  test("runBatchCommands never opts into compression", () => {
    const server = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "server.ts"),
      "utf-8",
    );
    const start = server.indexOf("export async function runBatchCommands");
    assert.ok(start > 0, "runBatchCommands must exist in src/server.ts");
    const body = server.slice(start, server.indexOf("\n}\n", start));
    assert.ok(
      !/compress\s*:/.test(body),
      "runBatchCommands must not pass `compress` — its output is indexed verbatim",
    );
  });
});
