/**
 * CONTEXT_MODE_EXEC_ENV_MODE=allowlist — what a sandboxed command can see.
 *
 * The default is a denylist, which can only remove what it has heard of:
 * AWS_*, GITHUB_TOKEN, database URLs and anything else the launching shell
 * exported all reach the child. Allowlist mode inverts that.
 */

import { describe, test, expect, afterEach } from "vitest";
import { PolyglotExecutor } from "../../src/executor.js";

const exec = new PolyglotExecutor();
const SECRET = "AWS_SECRET_ACCESS_KEY";

afterEach(() => {
  delete process.env.CONTEXT_MODE_EXEC_ENV_MODE;
  delete process.env[SECRET];
});

/** Echo one variable from inside the sandbox. */
async function readVar(name: string): Promise<string> {
  const r = await exec.execute({
    language: "javascript",
    code: `console.log(process.env[${JSON.stringify(name)}] ?? "<unset>")`,
  });
  return r.stdout.trim();
}

describe("sandbox environment", () => {
  test("by default an unrecognised credential reaches the child", async () => {
    process.env[SECRET] = "leaked-value";
    expect(await readVar(SECRET)).toBe("leaked-value");
  }, 30_000);

  test("allowlist mode withholds it", async () => {
    process.env[SECRET] = "leaked-value";
    process.env.CONTEXT_MODE_EXEC_ENV_MODE = "allowlist";
    expect(await readVar(SECRET)).toBe("<unset>");
  }, 30_000);

  test("allowlist mode still gives a runtime what it needs to run", async () => {
    process.env.CONTEXT_MODE_EXEC_ENV_MODE = "allowlist";
    expect(await readVar("PATH")).not.toBe("<unset>");
    // Forced sandbox values are applied after the filter, so they survive.
    expect(await readVar("HOME")).not.toBe("<unset>");
    expect(await readVar("TMPDIR")).not.toBe("<unset>");
  }, 30_000);
});
