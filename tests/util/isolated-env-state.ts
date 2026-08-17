/**
 * Shared mutable state for the test isolation helper.
 *
 * `tests/setup-home.ts` installs `vi.mock("node:os")` which reads `homedir()`
 * and `tmpdir()` from this module. `withIsolatedEnv()` writes the active fake
 * HOME here so the mock returns the current value, and `restore()` reverts it.
 *
 * Kept as its own tiny module so the os mock can import it without pulling in
 * the rest of `isolated-env.ts` (and the cycle / hoisting headaches that
 * implies).
 */

import { mkdtempSync } from "node:fs";
import { join } from "node:path";

// Deliberately not `os.tmpdir()`: the os module is what the setup files mock,
// and importing it here would close a cycle (mock factory → this module → os).
const tempRoot = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp";

/**
 * The suite-wide fake home, created once per test process.
 *
 * Both isolation layers resolve to this same directory so they cannot disagree:
 * `setup-storage.ts` (loaded for every suite) redirects `homedir()` to it, and
 * `setup-home.ts` (opt-in) additionally points HOME/USERPROFILE at it for
 * suites whose child processes need the fake home too.
 */
export const suiteFakeHome = mkdtempSync(join(tempRoot, "context-mode-test-home-"));

let activeFakeHome: string | undefined;

export function setActiveFakeHome(value: string | undefined): void {
  activeFakeHome = value;
}

export function getActiveFakeHome(): string | undefined {
  return activeFakeHome;
}
