import "../setup-home";
import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import * as src from "../../src/session/project-attribution.js";

/**
 * The hooks load `hooks/session-attribution.bundle.mjs`, never `src/`
 * (hooks/session-loaders.mjs:41-53). Every other attribution suite imports
 * `src/`, which is how the Bug 8 fix (2e7a543) stayed green in CI for two
 * months while being dead in production. This suite is the only one that
 * asserts against the artifact that actually runs.
 */

const BUNDLE = resolve(__dirname, "../../hooks/session-attribution.bundle.mjs");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let bundle: any;

beforeAll(async () => {
  bundle = await import(pathToFileURL(BUNDLE).href);
});

const PROJ_A = "/tmp/projA";
const PROJ_B = "/tmp/projB";

const CONTEXT = {
  sessionOriginDir: PROJ_A,
  inputProjectDir: PROJ_A,
  workspaceRoots: [] as string[],
  lastKnownProjectDir: null,
};

// Event batches chosen to cover each branch of the resolver: explicit cwd
// switch, file event inside/outside the known root, workspace-root override,
// and the empty-context fallback.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BATCHES: Array<{ name: string; events: any[]; context: any }> = [
  {
    name: "Bug 8 — path-less event after an in-batch cwd switch",
    events: [
      { type: "cwd", data: PROJ_B },
      { type: "bash", data: "git status" },
    ],
    context: CONTEXT,
  },
  {
    name: "file event outside the input root",
    events: [{ type: "file_edit", data: `${PROJ_B}/src/foo.ts` }],
    context: CONTEXT,
  },
  {
    name: "file event inside the input root",
    events: [{ type: "file_read", data: `${PROJ_A}/src/bar.ts` }],
    context: CONTEXT,
  },
  {
    name: "workspace root wins over input cwd",
    events: [{ type: "file_edit", data: `${PROJ_B}/src/foo.ts` }],
    context: { ...CONTEXT, workspaceRoots: [PROJ_B] },
  },
  {
    name: "path-less event with no signal at all",
    events: [{ type: "bash", data: "ls" }],
    context: {
      sessionOriginDir: null,
      inputProjectDir: null,
      workspaceRoots: [],
      lastKnownProjectDir: null,
    },
  },
];

describe("session-attribution bundle — parity with src", () => {
  it("the Bug 8 fix is live in the shipped bundle", () => {
    // 2e7a543: once a high-confidence cwd event re-scopes the batch, later
    // path-less events must follow it instead of falling back to the hook's
    // startup cwd. The April bundle returned PROJ_A here.
    const [, second] = bundle.resolveProjectAttributions(BATCHES[0].events, BATCHES[0].context);
    expect(second.projectDir).toBe(PROJ_B);
  });

  it.each(BATCHES)("bundle matches src: $name", ({ events, context }) => {
    expect(bundle.resolveProjectAttributions(events, context)).toEqual(
      src.resolveProjectAttributions(events as never, context as never),
    );
  });

  it("exports every runtime value src exports", () => {
    const runtimeExports = Object.entries(src)
      .filter(([, v]) => typeof v !== "undefined")
      .map(([k]) => k)
      .sort();
    expect(runtimeExports.length).toBeGreaterThanOrEqual(6);
    for (const name of runtimeExports) {
      expect(bundle[name], `bundle is missing export ${name}`).toBeDefined();
    }
  });
});
