/**
 * The reuse detector's six variables, collapsed onto `CONTEXT_MODE_REUSE`.
 *
 * Six scalars are the ones most likely to be sitting in a shell profile
 * already, so every one of them is pinned as still working — the collapse is
 * only allowed to ADD a way to configure the detector.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  reuseDetectorEnabled,
  reuseMinSamples,
  reuseSettings,
  reuseStatFilesEnabled,
  reuseStepWindow,
  reuseThreshold,
  reuseWindowMs,
  DEFAULT_REUSE_MIN_SAMPLES,
  DEFAULT_REUSE_STEP_WINDOW,
  DEFAULT_REUSE_THRESHOLD,
  DEFAULT_REUSE_WINDOW_MS,
} from "../../src/session/reuse-detector.js";

const FLAGS = [
  "CONTEXT_MODE_REUSE",
  "CONTEXT_MODE_REUSE_DETECT",
  "CONTEXT_MODE_REUSE_THRESHOLD",
  "CONTEXT_MODE_REUSE_STEP_WINDOW",
  "CONTEXT_MODE_REUSE_WINDOW_MS",
  "CONTEXT_MODE_REUSE_MIN_SAMPLES",
  "CONTEXT_MODE_REUSE_STAT_FILES",
];

afterEach(() => {
  for (const flag of FLAGS) delete process.env[flag];
});

const DEFAULTS = {
  enabled: true,
  threshold: DEFAULT_REUSE_THRESHOLD,
  stepWindow: DEFAULT_REUSE_STEP_WINDOW,
  windowMs: DEFAULT_REUSE_WINDOW_MS,
  minSamples: DEFAULT_REUSE_MIN_SAMPLES,
  statFiles: true,
};

describe("reuse detector env family", () => {
  it("defaults to the documented values", () => {
    expect(reuseSettings()).toEqual(DEFAULTS);
  });

  it("keeps CONTEXT_MODE_REUSE_DETECT=0 disabling the detector", () => {
    for (const off of ["0", "false", "off", "no"]) {
      process.env.CONTEXT_MODE_REUSE_DETECT = off;
      expect(reuseDetectorEnabled()).toBe(false);
    }
    process.env.CONTEXT_MODE_REUSE_DETECT = "1";
    expect(reuseDetectorEnabled()).toBe(true);
  });

  it("still reads every individual scalar", () => {
    process.env.CONTEXT_MODE_REUSE_THRESHOLD = "45";      // percentage form
    process.env.CONTEXT_MODE_REUSE_STEP_WINDOW = "5";
    process.env.CONTEXT_MODE_REUSE_WINDOW_MS = "60000";
    process.env.CONTEXT_MODE_REUSE_MIN_SAMPLES = "0";
    process.env.CONTEXT_MODE_REUSE_STAT_FILES = "0";
    expect(reuseThreshold()).toBeCloseTo(0.45);
    expect(reuseStepWindow()).toBe(5);
    expect(reuseWindowMs()).toBe(60_000);
    expect(reuseMinSamples()).toBe(0);
    expect(reuseStatFilesEnabled()).toBe(false);
  });

  it("reads a JSON-only configuration", () => {
    process.env.CONTEXT_MODE_REUSE =
      '{"enabled":false,"threshold":0.5,"stepWindow":4,"windowMs":1000,"minSamples":1,"statFiles":false}';
    expect(reuseSettings()).toEqual({
      enabled: false, threshold: 0.5, stepWindow: 4, windowMs: 1000, minSamples: 1, statFiles: false,
    });
  });

  it("accepts the percentage form inside the JSON as well", () => {
    process.env.CONTEXT_MODE_REUSE = '{"threshold":45}';
    expect(reuseThreshold()).toBeCloseTo(0.45);
  });

  it("lets a scalar win over the JSON key it overlaps", () => {
    process.env.CONTEXT_MODE_REUSE = '{"threshold":0.5,"stepWindow":4}';
    process.env.CONTEXT_MODE_REUSE_THRESHOLD = "0.9";
    expect(reuseThreshold()).toBeCloseTo(0.9);
    expect(reuseStepWindow()).toBe(4);
  });

  it("falls back to the scalars on malformed JSON without throwing", () => {
    process.env.CONTEXT_MODE_REUSE = '{"threshold":0.5';
    process.env.CONTEXT_MODE_REUSE_STEP_WINDOW = "7";
    expect(() => reuseSettings()).not.toThrow();
    expect(reuseSettings()).toEqual({ ...DEFAULTS, stepWindow: 7 });
  });

  it("reads a bare off-value on the head name as the whole family off", () => {
    process.env.CONTEXT_MODE_REUSE = "0";
    expect(reuseDetectorEnabled()).toBe(false);
    // …and the individual scalar still wins over it.
    process.env.CONTEXT_MODE_REUSE_DETECT = "1";
    expect(reuseDetectorEnabled()).toBe(true);
  });

  it("rejects out-of-range values back to the defaults", () => {
    process.env.CONTEXT_MODE_REUSE_THRESHOLD = "-1";
    process.env.CONTEXT_MODE_REUSE_STEP_WINDOW = "0";
    process.env.CONTEXT_MODE_REUSE_MIN_SAMPLES = "-3";
    expect(reuseThreshold()).toBe(DEFAULT_REUSE_THRESHOLD);
    expect(reuseStepWindow()).toBe(DEFAULT_REUSE_STEP_WINDOW);
    expect(reuseMinSamples()).toBe(DEFAULT_REUSE_MIN_SAMPLES);
  });
});
