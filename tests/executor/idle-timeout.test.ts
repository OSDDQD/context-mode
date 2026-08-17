/**
 * The idle watchdog, and what it must not kill.
 *
 * Issue #406 is the whole design constraint: a wall clock turned 30-minute
 * Gradle builds into false negatives, so the default limit is *silence*, not
 * elapsed time. These tests pin both halves — a chatty long-running command
 * survives, a hung one does not — plus the two cases where the watchdog must
 * not arm at all.
 *
 * Fixtures use `node -e` rather than `sleep`/`yes` so the suite runs on the
 * Windows CI leg too.
 */

import { describe, test, expect } from "vitest";
import { PolyglotExecutor } from "../../src/executor.js";

const exec = new PolyglotExecutor();

/** A shell command that runs `node -e <script>`. */
function nodeScript(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

/** Prints every 60ms for `totalMs`, then exits 0. */
const CHATTY = (totalMs: number) => nodeScript(
  `let n=0;const t=setInterval(()=>{console.log("tick",n++)},60);` +
  `setTimeout(()=>{clearInterval(t);process.exit(0)},${totalMs});`,
);

/** Prints once, then goes silent forever. */
const HANGS = nodeScript(`console.log("starting");setInterval(()=>{},1000);`);

describe("idle watchdog", () => {
  test("a command that keeps printing survives a shorter idle window (#406)", async () => {
    process.env.CONTEXT_MODE_EXEC_IDLE_TIMEOUT_MS = "400";
    try {
      const r = await exec.execute({ language: "shell", code: CHATTY(1200) });
      expect(r.timedOut).toBe(false);
      expect(r.killedBy).toBeUndefined();
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("tick");
    } finally {
      delete process.env.CONTEXT_MODE_EXEC_IDLE_TIMEOUT_MS;
    }
  }, 30_000);

  test("a silent process is killed and says why", async () => {
    process.env.CONTEXT_MODE_EXEC_IDLE_TIMEOUT_MS = "500";
    process.env.CONTEXT_MODE_EXEC_KILL_GRACE_MS = "0";
    try {
      const started = Date.now();
      const r = await exec.execute({ language: "shell", code: HANGS });
      expect(r.timedOut).toBe(true);
      expect(r.killedBy).toBe("idle");
      expect(r.stderr).toMatch(/no output for/);
      // Killed on silence, not on total runtime: it printed once at t≈0.
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      delete process.env.CONTEXT_MODE_EXEC_IDLE_TIMEOUT_MS;
      delete process.env.CONTEXT_MODE_EXEC_KILL_GRACE_MS;
    }
  }, 30_000);

  test("an explicit timeout is the caller's policy — the watchdog stays out of it", async () => {
    process.env.CONTEXT_MODE_EXEC_IDLE_TIMEOUT_MS = "100";
    process.env.CONTEXT_MODE_EXEC_KILL_GRACE_MS = "0";
    try {
      // Silent for 700ms, well past the idle window, but the caller allowed 5s.
      const r = await exec.execute({
        language: "shell",
        code: nodeScript(`setTimeout(()=>{console.log("done");process.exit(0)},700);`),
        timeout: 5_000,
      });
      expect(r.timedOut).toBe(false);
      expect(r.stdout).toContain("done");
    } finally {
      delete process.env.CONTEXT_MODE_EXEC_IDLE_TIMEOUT_MS;
      delete process.env.CONTEXT_MODE_EXEC_KILL_GRACE_MS;
    }
  }, 30_000);

  test("an explicit timeout that fires reports killedBy: timeout", async () => {
    process.env.CONTEXT_MODE_EXEC_KILL_GRACE_MS = "0";
    try {
      const r = await exec.execute({
        language: "shell",
        code: nodeScript(`setInterval(()=>{},1000);`),
        timeout: 400,
      });
      expect(r.timedOut).toBe(true);
      expect(r.killedBy).toBe("timeout");
    } finally {
      delete process.env.CONTEXT_MODE_EXEC_KILL_GRACE_MS;
    }
  }, 30_000);

  test("background mode is never watched — being quiet is the job", async () => {
    process.env.CONTEXT_MODE_EXEC_IDLE_TIMEOUT_MS = "100";
    try {
      const r = await exec.execute({
        language: "shell",
        code: nodeScript(`console.log("up");setInterval(()=>{},1000);`),
        timeout: 500,
        background: true,
      });
      expect(r.backgrounded).toBe(true);
      expect(r.killedBy).toBe("timeout");
    } finally {
      delete process.env.CONTEXT_MODE_EXEC_IDLE_TIMEOUT_MS;
      await exec.cleanup?.();
    }
  }, 30_000);

  test("=0 is off: a silent command runs to completion", async () => {
    process.env.CONTEXT_MODE_EXEC_IDLE_TIMEOUT_MS = "0";
    try {
      const r = await exec.execute({
        language: "shell",
        code: nodeScript(`setTimeout(()=>{console.log("late");process.exit(0)},600);`),
      });
      expect(r.timedOut).toBe(false);
      expect(r.stdout).toContain("late");
    } finally {
      delete process.env.CONTEXT_MODE_EXEC_IDLE_TIMEOUT_MS;
    }
  }, 30_000);

  test("the output cap reports killedBy: output-cap", async () => {
    const capped = new PolyglotExecutor({ hardCapBytes: 64 * 1024 });
    const r = await capped.execute({
      language: "shell",
      code: nodeScript(`const s="x".repeat(8192);for(let i=0;i<200;i++)console.log(s);`),
    });
    expect(r.killedBy).toBe("output-cap");
    expect(r.stderr).toMatch(/output capped/);
  }, 30_000);
});
