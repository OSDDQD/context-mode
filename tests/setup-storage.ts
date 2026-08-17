/**
 * Keep `npm test` out of the user's real knowledge base.
 *
 * Loaded for every suite via `setupFiles`. It redirects `homedir()` — and
 * nothing else. That narrowness is the point; the two wider options both break
 * real suites:
 *
 * - Setting HOME globally (what `setup-home.ts` does, opt-in) breaks every test
 *   that shells out through a version-manager shim rooted in the real home.
 * - Setting CONTEXT_MODE_DIR globally leaks into spawned hooks, which then
 *   write somewhere the parent test is not looking.
 *
 * Only in-process code resolving through `homedir()` is affected, which is
 * exactly what was leaking: 297 stray content DBs and hundreds of stats files
 * accumulated in ~/.claude/context-mode from test runs alone, and the plugin's
 * own disk accounting then counted them as the user's data.
 *
 * Suites that opt into `setup-home.ts` keep working: both mocks resolve to the
 * same `suiteFakeHome`, so HOME and `homedir()` cannot disagree.
 */

import { vi } from "vitest";
import { join } from "node:path";
import { getActiveFakeHome, suiteFakeHome } from "./util/isolated-env-state.js";

/**
 * Storage root for child processes, which never see the `homedir()` mock.
 *
 * NOT exported into the environment globally: the hook suites spawn children
 * with their own HOME and then look for the result under that HOME, and an
 * inherited CONTEXT_MODE_DIR would send the child somewhere else. Suites that
 * spawn a server or CLI with the ambient environment set it themselves.
 */
export const testStorageRoot = join(suiteFakeHome, ".context-mode-test-store");

/** HOME as the process was started with — the one we must never resolve to. */
const realHome = process.env.HOME ?? process.env.USERPROFILE ?? "";

vi.mock("node:os", async () => {
  const mod = await vi.importActual<typeof import("node:os")>("node:os");
  const realTmp = mod.tmpdir();
  return {
    ...mod,
    homedir: () => {
      const scoped = getActiveFakeHome();
      if (scoped) return scoped;
      // A suite that set HOME itself did so to be followed — honour it. Only
      // the untouched, real HOME gets swapped for the sandbox.
      const envHome = process.env.HOME ?? process.env.USERPROFILE;
      if (envHome && envHome !== realHome) return envHome;
      return suiteFakeHome;
    },
    tmpdir: () => getActiveFakeHome() ?? realTmp,
  };
});
