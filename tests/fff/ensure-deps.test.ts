/**
 * `ensureFffNative()` in hooks/ensure-deps.mjs.
 *
 * Hooks fire on every tool call, so the only acceptable cost when the package
 * is already there is a couple of `existsSync` calls. And because fff is
 * OPTIONAL, a failed install must not turn into an npm invocation on every
 * subsequent hook — hence the cooldown marker.
 *
 * Driven in a subprocess: importing ensure-deps.mjs auto-runs its bootstrap,
 * which is exactly what a real hook does, and the child keeps that side effect
 * out of the test worker. `CONTEXT_MODE_FFF=0` is set before the import so the
 * auto-run cannot reach the network; the assertions then call the exported
 * function directly with a fake plugin root.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ensureDepsUrl = pathToFileURL(join(repoRoot, "hooks", "ensure-deps.mjs")).href;
const MARKER = ".context-mode-fff-install-attempt";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "fff-ensure-deps-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** Fake plugin root: package.json plus whatever node_modules layout is asked for. */
function fakeRoot(name: string, opts: { installed?: boolean; marker?: boolean } = {}): string {
  const root = join(workspace, name);
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fake", dependencies: { "@ff-labs/fff-node": "0.10.5" } }),
  );
  if (opts.installed) {
    mkdirSync(join(root, "node_modules", "@ff-labs", "fff-node"), { recursive: true });
    const bin = join(root, "node_modules", "@ff-labs", "fff-bin-linux-x64-gnu");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "libfff_c.so"), "");
  }
  if (opts.marker) writeFileSync(join(root, "node_modules", MARKER), new Date().toISOString());
  return root;
}

function runProbe(script: string): { code: number; out: string } {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 60_000,
    // The auto-run must not attempt a network install while the child boots.
    env: { ...process.env, CONTEXT_MODE_FFF: "0" },
  });
  return { code: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("ensureFffNative", () => {
  it("does nothing when the package and its platform binary are already present", () => {
    const root = fakeRoot("installed", { installed: true });
    const probe = runProbe(`
      const { ensureFffNative } = await import(${JSON.stringify(ensureDepsUrl)});
      delete process.env.CONTEXT_MODE_FFF;
      const { existsSync } = await import("node:fs");
      await ensureFffNative(${JSON.stringify(root)});
      console.log(JSON.stringify({ marker: existsSync(${JSON.stringify(join(root, "node_modules", MARKER))}) }));
    `);

    expect(probe.code).toBe(0);
    // No marker means the fast path returned before it ever considered npm.
    expect(probe.out).toContain('{"marker":false}');
  });

  it("stays out of the way entirely when CONTEXT_MODE_FFF is off", () => {
    const root = fakeRoot("disabled"); // nothing installed
    const probe = runProbe(`
      const { ensureFffNative } = await import(${JSON.stringify(ensureDepsUrl)});
      const { existsSync } = await import("node:fs");
      await ensureFffNative(${JSON.stringify(root)});
      console.log(JSON.stringify({ marker: existsSync(${JSON.stringify(join(root, "node_modules", MARKER))}) }));
    `);

    expect(probe.code).toBe(0);
    expect(probe.out).toContain('{"marker":false}');
  });

  it("respects the cooldown marker instead of retrying npm on every hook", () => {
    const root = fakeRoot("cooldown", { marker: true });
    const probe = runProbe(`
      const { ensureFffNative } = await import(${JSON.stringify(ensureDepsUrl)});
      delete process.env.CONTEXT_MODE_FFF;
      const { statSync } = await import("node:fs");
      const marker = ${JSON.stringify(join(root, "node_modules", MARKER))};
      const before = statSync(marker).mtimeMs;
      await ensureFffNative(${JSON.stringify(root)});
      const after = statSync(marker).mtimeMs;
      console.log(JSON.stringify({ untouched: before === after }));
    `);

    expect(probe.code).toBe(0);
    // Marker untouched ⇒ returned before the install branch rewrote it.
    expect(probe.out).toContain('{"untouched":true}');
  });

  it("pins the version declared in package.json", () => {
    // The install command is never run here; this asserts the version the
    // module would use, which must match the exact pin (no caret).
    const probe = runProbe(`
      const mod = await import(${JSON.stringify(ensureDepsUrl)});
      const { readFileSync } = await import("node:fs");
      const pkg = JSON.parse(readFileSync(${JSON.stringify(join(repoRoot, "package.json"))}, "utf8"));
      console.log(JSON.stringify({
        spec: pkg.dependencies["@ff-labs/fff-node"],
        exported: typeof mod.ensureFffNative,
      }));
    `);

    expect(probe.code).toBe(0);
    expect(probe.out).toContain('"exported":"function"');
    expect(probe.out).toMatch(/"spec":"\d+\.\d+\.\d+"/); // exact, not ^ or ~
  });
});
