import { vi } from "vitest";
import { parse } from "node:path";

import { getActiveFakeHome, suiteFakeHome } from "./util/isolated-env-state.js";

// Import this helper from suites whose CHILD processes need the fake home too:
// it points HOME/USERPROFILE at the same directory `homedir()` already resolves
// to, so a spawned hook writes where the test is looking. Redirecting
// `homedir()` alone is global (tests/setup-storage.ts, wired into
// vitest.config.ts); setting HOME is not, because it also redirects the
// version-manager shims that `npm` and `node` are launched through.
export const fakeHome = suiteFakeHome;
const root = parse(fakeHome).root;
export const realHome = process.env.HOME ?? "";

process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.HOMEDRIVE = root.replace(/[\\/]+$/, "");
process.env.HOMEPATH = fakeHome.slice(root.length) || root;

// Prevent CONTEXT_MODE_BRIDGE_DEPTH from leaking in when Pi's MCP child
// spawned with depth=1 and that env persisted into the test runner.
delete process.env.CONTEXT_MODE_BRIDGE_DEPTH;

// `node:os` mock: defer to `withIsolatedEnv()` when a scoped fake HOME is
// active; otherwise return the suite-wide fakeHome. This lets tests opt into
// stricter Windows-aware isolation without forking the mock setup.
vi.mock("node:os", async () => {
  const mod = await vi.importActual<typeof import("node:os")>("node:os");
  const realTmp = mod.tmpdir();
  return {
    ...mod,
    homedir: () => getActiveFakeHome() ?? fakeHome,
    tmpdir: () => getActiveFakeHome() ?? realTmp,
  };
});
