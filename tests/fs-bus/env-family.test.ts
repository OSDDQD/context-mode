/**
 * `CONTEXT_MODE_FS_BUS` carries two shapes: the master off-switch it has always
 * been, and the consumer family collapsed onto it. These tests pin the seam.
 *
 * The regression that must never happen is the first one: `=0` is what an
 * operator reaches for when the watcher misbehaves, and if the collapse ever
 * reads it as "not an object, therefore ignore", the kill switch is gone.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  isCacheConsumerEnabled,
  isFsBusEnabled,
  isGraphConsumerEnabled,
  isIndexConsumerEnabled,
  maxFilesPerBatch,
  DEFAULT_MAX_FILES_PER_BATCH,
} from "../../src/fs-bus/env.js";

const FLAGS = [
  "CONTEXT_MODE_FS_BUS",
  "CONTEXT_MODE_FS_BUS_INDEX",
  "CONTEXT_MODE_FS_BUS_GRAPH",
  "CONTEXT_MODE_FS_BUS_CACHE",
  "CONTEXT_MODE_FS_BUS_MAX_FILES",
];

afterEach(() => {
  for (const flag of FLAGS) delete process.env[flag];
});

const all = (env: NodeJS.ProcessEnv) => ({
  enabled: isFsBusEnabled(env),
  index: isIndexConsumerEnabled(env),
  graph: isGraphConsumerEnabled(env),
  cache: isCacheConsumerEnabled(env),
  maxFiles: maxFilesPerBatch(env),
});

describe("fs-bus env family", () => {
  it("defaults to everything on", () => {
    expect(all({})).toEqual({ enabled: true, index: true, graph: true, cache: true, maxFiles: DEFAULT_MAX_FILES_PER_BATCH });
  });

  it("keeps CONTEXT_MODE_FS_BUS=0 meaning the whole wiring off", () => {
    // With the master off the wiring installs an inert handle, so no consumer
    // is ever consulted — that is what "all off" means here.
    for (const off of ["0", "off", "false", "no", "disabled", " OFF "]) {
      expect(isFsBusEnabled({ CONTEXT_MODE_FS_BUS: off })).toBe(false);
    }
    expect(isFsBusEnabled({ CONTEXT_MODE_FS_BUS: "1" })).toBe(true);
    expect(isFsBusEnabled({})).toBe(true);
  });

  it("reads the consumers out of a JSON object on the same head name", () => {
    expect(all({ CONTEXT_MODE_FS_BUS: '{"index":false,"graph":false,"cache":true,"maxFiles":7}' }))
      .toEqual({ enabled: true, index: false, graph: false, cache: true, maxFiles: 7 });
  });

  it("still reads the individual scalars", () => {
    expect(all({
      CONTEXT_MODE_FS_BUS_INDEX: "0",
      CONTEXT_MODE_FS_BUS_GRAPH: "off",
      CONTEXT_MODE_FS_BUS_CACHE: "false",
      CONTEXT_MODE_FS_BUS_MAX_FILES: "12",
    })).toEqual({ enabled: true, index: false, graph: false, cache: false, maxFiles: 12 });
  });

  it("lets a scalar override the JSON key it overlaps", () => {
    const settings = all({
      CONTEXT_MODE_FS_BUS: '{"index":true,"graph":true,"maxFiles":7}',
      CONTEXT_MODE_FS_BUS_INDEX: "0",
      CONTEXT_MODE_FS_BUS_MAX_FILES: "9",
    });
    expect(settings).toMatchObject({ index: false, graph: true, maxFiles: 9 });
  });

  it("can express the master switch inside the object too", () => {
    expect(isFsBusEnabled({ CONTEXT_MODE_FS_BUS: '{"enabled":false}' })).toBe(false);
  });

  it("falls back to the scalars on malformed JSON without throwing", () => {
    const broken = { CONTEXT_MODE_FS_BUS: '{"index":false', CONTEXT_MODE_FS_BUS_GRAPH: "0" };
    expect(() => all(broken)).not.toThrow();
    // The unparseable object contributes nothing; the master stays ON, because
    // a typo must not silently disable the wiring.
    expect(all(broken)).toMatchObject({ enabled: true, index: true, graph: false });
  });

  it("keeps the 1…5000 clamp on maxFiles", () => {
    expect(maxFilesPerBatch({ CONTEXT_MODE_FS_BUS_MAX_FILES: "999999" })).toBe(5_000);
    expect(maxFilesPerBatch({ CONTEXT_MODE_FS_BUS_MAX_FILES: "0" })).toBe(DEFAULT_MAX_FILES_PER_BATCH);
    expect(maxFilesPerBatch({ CONTEXT_MODE_FS_BUS_MAX_FILES: "nope" })).toBe(DEFAULT_MAX_FILES_PER_BATCH);
    expect(maxFilesPerBatch({ CONTEXT_MODE_FS_BUS: '{"maxFiles":99999}' })).toBe(5_000);
  });

  it("reads process.env when no env argument is given", () => {
    process.env.CONTEXT_MODE_FS_BUS = '{"cache":false}';
    expect(isCacheConsumerEnabled()).toBe(false);
    expect(isIndexConsumerEnabled()).toBe(true);
  });
});
