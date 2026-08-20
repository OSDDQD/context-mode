/**
 * The resolution rules of `readEnvFamily`, tested on their own so the two
 * families that use it (reuse detector, fs-bus) can test their own semantics
 * rather than re-testing precedence.
 *
 * The property that matters most here is the last one: an env var is operator
 * input, and operator input must never be able to throw on a start-up path.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  boolKey,
  disableKeyOnOff,
  isOffValue,
  numberKey,
  parseFamilyObject,
  readEnvFamily,
} from "../../src/util/env-family.js";

const HEAD = "CONTEXT_MODE_TEST_FAMILY";
const SCHEMA = {
  enabled: boolKey("enabled", null, true),
  index: boolKey("index", "CONTEXT_MODE_TEST_FAMILY_INDEX", true),
  size: numberKey("size", "CONTEXT_MODE_TEST_FAMILY_SIZE", 40, (n) =>
    n >= 1 ? Math.min(Math.trunc(n), 100) : undefined),
};

const read = (env: NodeJS.ProcessEnv) =>
  readEnvFamily(HEAD, SCHEMA, env, { headScalar: disableKeyOnOff<typeof SCHEMA>("enabled") });

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CONTEXT_MODE_TEST_FAMILY")) delete process.env[key];
  }
});

describe("readEnvFamily", () => {
  it("returns the declared fallbacks when nothing is set", () => {
    expect(read({})).toEqual({ enabled: true, index: true, size: 40 });
  });

  it("reads a JSON-only configuration off the head name", () => {
    expect(read({ [HEAD]: '{"index":false,"size":7}' })).toEqual({ enabled: true, index: false, size: 7 });
  });

  it("reads a scalar-only configuration", () => {
    expect(read({ CONTEXT_MODE_TEST_FAMILY_INDEX: "0", CONTEXT_MODE_TEST_FAMILY_SIZE: "9" }))
      .toEqual({ enabled: true, index: false, size: 9 });
  });

  it("lets the scalar win over the JSON key it overlaps", () => {
    // The shell profile is authoritative: the JSON blob is the considered
    // configuration, the scalar is what someone exported five minutes ago.
    const settings = read({
      [HEAD]: '{"index":true,"size":7}',
      CONTEXT_MODE_TEST_FAMILY_INDEX: "0",
    });
    expect(settings.index).toBe(false);
    expect(settings.size).toBe(7); // untouched keys still come from the JSON
  });

  it("falls back to the scalars on malformed JSON instead of throwing", () => {
    const broken = { [HEAD]: '{"index":false,,', CONTEXT_MODE_TEST_FAMILY_SIZE: "12" };
    expect(() => read(broken)).not.toThrow();
    expect(read(broken)).toEqual({ enabled: true, index: true, size: 12 });
  });

  it("ignores JSON that is not an object", () => {
    for (const raw of ["[1,2]", "null", "4", '"x"']) {
      expect(read({ [HEAD]: raw }).enabled).toBe(true);
    }
  });

  it("treats a non-JSON head value as the family's legacy scalar", () => {
    expect(read({ [HEAD]: "0" }).enabled).toBe(false);
    expect(read({ [HEAD]: "off" }).enabled).toBe(false);
    expect(read({ [HEAD]: "1" }).enabled).toBe(true);
  });

  it("treats empty and unparseable scalars as unset", () => {
    expect(read({ CONTEXT_MODE_TEST_FAMILY_SIZE: "   " }).size).toBe(40);
    expect(read({ CONTEXT_MODE_TEST_FAMILY_SIZE: "banana" }).size).toBe(40);
    // Rejected by the normalizer → falls through to the JSON layer, not to the
    // default, so one bad scalar does not discard the rest of the config.
    expect(read({ [HEAD]: '{"size":7}', CONTEXT_MODE_TEST_FAMILY_SIZE: "0" }).size).toBe(7);
  });

  it("defaults to process.env when no env is passed", () => {
    process.env.CONTEXT_MODE_TEST_FAMILY_INDEX = "0";
    expect(readEnvFamily(HEAD, SCHEMA).index).toBe(false);
  });

  it("never throws when a family's own coercion does", () => {
    const hostile = {
      boom: {
        json: "boom",
        scalar: "CONTEXT_MODE_TEST_FAMILY_BOOM",
        fallback: "safe",
        fromScalar: () => { throw new Error("scalar"); },
        fromJson: () => { throw new Error("json"); },
      },
    };
    expect(readEnvFamily(HEAD, hostile, { CONTEXT_MODE_TEST_FAMILY_BOOM: "x" }))
      .toEqual({ boom: "safe" });
  });
});

describe("parseFamilyObject / isOffValue", () => {
  it("accepts only a JSON object", () => {
    expect(parseFamilyObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseFamilyObject("  {}  ")).toEqual({});
    for (const raw of [undefined, null, "", "0", "{", "[]", "null", "3"]) {
      expect(parseFamilyObject(raw)).toBeUndefined();
    }
  });

  it("keeps the fork's off-value vocabulary", () => {
    for (const raw of ["0", "off", "FALSE", " no ", "disabled"]) expect(isOffValue(raw)).toBe(true);
    for (const raw of [undefined, "", "1", "on", "yes"]) expect(isOffValue(raw)).toBe(false);
  });
});
