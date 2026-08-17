import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isStructurallyBounded, resetUserSafePatterns } from "../../hooks/core/routing.mjs";

let dir: string;
const ORIGINAL_INLINE = process.env.CONTEXT_MODE_SAFE_COMMANDS;
const ORIGINAL_FILE = process.env.CONTEXT_MODE_SAFE_COMMANDS_FILE;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ctx-allowlist-"));
  delete process.env.CONTEXT_MODE_SAFE_COMMANDS;
  delete process.env.CONTEXT_MODE_SAFE_COMMANDS_FILE;
  resetUserSafePatterns();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (ORIGINAL_INLINE === undefined) delete process.env.CONTEXT_MODE_SAFE_COMMANDS;
  else process.env.CONTEXT_MODE_SAFE_COMMANDS = ORIGINAL_INLINE;
  if (ORIGINAL_FILE === undefined) delete process.env.CONTEXT_MODE_SAFE_COMMANDS_FILE;
  else process.env.CONTEXT_MODE_SAFE_COMMANDS_FILE = ORIGINAL_FILE;
  resetUserSafePatterns();
});

describe("built-in allowlist additions", () => {
  test("near-silent git plumbing no longer draws the nudge", () => {
    for (const cmd of [
      "git add -A",
      "git commit -m 'wip'",
      "git push origin main",
      "git switch -c feature/x",
      "git stash pop",
    ]) {
      expect(isStructurallyBounded(cmd), cmd).toBe(true);
    }
  });

  test("chmod/chown stay bounded only without the per-file verbose flags", () => {
    expect(isStructurallyBounded("chmod +x script.sh")).toBe(true);
    expect(isStructurallyBounded("chmod -R 755 dir")).toBe(true);
    expect(isStructurallyBounded("chmod -Rv 755 dir")).toBe(false);
    expect(isStructurallyBounded("chown --changes user:group file")).toBe(false);
  });
});

describe("user-extensible allowlist", () => {
  test("inline patterns are honoured", () => {
    process.env.CONTEXT_MODE_SAFE_COMMANDS = "^ssh\\s+\\S+\\s+systemctl\\s+is-active\\s+\\S+$";
    resetUserSafePatterns();
    expect(isStructurallyBounded("ssh prod-web systemctl is-active nginx")).toBe(true);
    expect(isStructurallyBounded("ssh prod-web cat /var/log/huge.log")).toBe(false);
  });

  test("file patterns are honoured, with comments and blanks ignored", () => {
    const file = join(dir, "safe-commands.txt");
    writeFileSync(file, "# infra probes\n\n^docker\\s+compose\\s+ps$\n");
    process.env.CONTEXT_MODE_SAFE_COMMANDS_FILE = file;
    resetUserSafePatterns();
    expect(isStructurallyBounded("docker compose ps")).toBe(true);
    expect(isStructurallyBounded("docker compose logs")).toBe(false);
  });

  test("a malformed pattern is skipped without taking the hook down", () => {
    process.env.CONTEXT_MODE_SAFE_COMMANDS = "[unclosed(|||^myctl\\s+status$";
    resetUserSafePatterns();
    expect(() => isStructurallyBounded("myctl status")).not.toThrow();
    expect(isStructurallyBounded("myctl status")).toBe(true);
  });

  test("user patterns cannot bypass the shell-operator gate", () => {
    process.env.CONTEXT_MODE_SAFE_COMMANDS = "^myctl.*$";
    resetUserSafePatterns();
    expect(isStructurallyBounded("myctl status")).toBe(true);
    expect(isStructurallyBounded("myctl status | cat huge.log")).toBe(false);
    expect(isStructurallyBounded("myctl status; find /")).toBe(false);
    expect(isStructurallyBounded("myctl status > out.txt")).toBe(false);
  });
});
