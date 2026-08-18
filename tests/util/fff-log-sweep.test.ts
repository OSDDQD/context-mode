/**
 * The `fff_mcp+<ts>+<pid>.log` reaper.
 *
 * This is the one piece of this wave that DELETES files a user never asked us
 * to touch, so the tests are written around the blast radius rather than the
 * happy path: which names are matched, which are refused, what age gate
 * applies, and the fact that a directory that is not ours is left alone.
 *
 * Every case runs against a temp directory. Nothing here may ever point at the
 * real `~/.cache`.
 */

import { describe, test, expect, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FFF_LOG_DEFAULT_MAX_AGE_DAYS,
  FFF_MCP_LOG_RE,
  fffLogDir,
  fffLogMaxAgeDays,
  fffLogSweepEnabled,
  sweepFffMcpLogs,
} from "../../src/util/fff-logs.js";

const DAY_MS = 24 * 60 * 60 * 1000;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cm-fff-logs-"));
});

/** Write a file and backdate it by `ageDays`. */
function writeAged(name: string, ageDays: number, content = "log line\n"): string {
  const path = join(dir, name);
  writeFileSync(path, content, "utf-8");
  const when = new Date(Date.now() - ageDays * DAY_MS);
  utimesSync(path, when, when);
  return path;
}

function remaining(): string[] {
  return readdirSync(dir).sort();
}

describe("the name pattern", () => {
  test("matches exactly what the external server wrote", () => {
    expect(FFF_MCP_LOG_RE.test("fff_mcp+1755500000+12345.log")).toBe(true);
    expect(FFF_MCP_LOG_RE.test("fff_mcp+0+1.log")).toBe(true);
  });

  test("refuses every near miss", () => {
    for (const name of [
      "fff_mcp.log",                    // no stamp at all
      "fff_mcp+abc+12.log",             // non-numeric stamp
      "fff_mcp+1+2.log.bak",            // suffixed
      "fff_mcp+1+2.txt",                // wrong extension
      "my-fff_mcp+1+2.log",             // prefixed
      "fff_mcp+1.log",                  // one field
      "fff_mcp+1+2+3.log",              // three fields
    ]) {
      expect(FFF_MCP_LOG_RE.test(name), name).toBe(false);
    }
  });
});

describe("sweepFffMcpLogs", () => {
  test("removes only aged logs and reports what it freed", () => {
    writeAged("fff_mcp+100+1.log", 30, "x".repeat(100));
    writeAged("fff_mcp+200+2.log", 8);
    writeAged("fff_mcp+300+3.log", 1); // inside the window — kept

    const result = sweepFffMcpLogs({ dir, env: {}, maxAgeDays: 7 });

    expect(result.matched).toBe(3);
    expect(result.removed).toBe(2);
    expect(result.freedBytes).toBeGreaterThan(100);
    expect(remaining()).toEqual(["fff_mcp+300+3.log"]);
  });

  test("leaves every other file in the cache directory untouched", () => {
    writeAged("fff_mcp+100+1.log", 30);
    writeAged("important.log", 400);
    writeAged("fff_mcp.log", 400);
    writeAged("fff_mcp+1+2.log.bak", 400);
    mkdirSync(join(dir, "fff_mcp+9+9.log")); // a directory wearing the name

    sweepFffMcpLogs({ dir, env: {}, maxAgeDays: 7 });

    expect(remaining()).toEqual([
      "fff_mcp+1+2.log.bak",
      "fff_mcp+9+9.log",
      "fff_mcp.log",
      "important.log",
    ]);
  });

  test("the env switch stops it entirely", () => {
    writeAged("fff_mcp+100+1.log", 400);
    const result = sweepFffMcpLogs({ dir, env: { CONTEXT_MODE_FFF_LOG_SWEEP: "0" } });
    expect(result.skipped).toBe("disabled");
    expect(result.removed).toBe(0);
    expect(remaining()).toEqual(["fff_mcp+100+1.log"]);
  });

  test("the age gate comes from the env when the caller does not set one", () => {
    writeAged("fff_mcp+100+1.log", 2);
    sweepFffMcpLogs({ dir, env: { CONTEXT_MODE_FFF_LOG_MAX_AGE_DAYS: "30" } });
    expect(remaining()).toEqual(["fff_mcp+100+1.log"]);

    sweepFffMcpLogs({ dir, env: { CONTEXT_MODE_FFF_LOG_MAX_AGE_DAYS: "1" } });
    expect(remaining()).toEqual([]);
  });

  test("a missing cache directory is a skip, not a throw", () => {
    const result = sweepFffMcpLogs({ dir: join(dir, "nope"), env: {} });
    expect(result.skipped).toBe("unreadable");
    expect(result.removed).toBe(0);
  });
});

describe("env resolution", () => {
  test("the sweep is on unless switched off", () => {
    expect(fffLogSweepEnabled({})).toBe(true);
    expect(fffLogSweepEnabled({ CONTEXT_MODE_FFF_LOG_SWEEP: "0" })).toBe(false);
    expect(fffLogSweepEnabled({ CONTEXT_MODE_FFF_LOG_SWEEP: "off" })).toBe(false);
  });

  test("a bad age falls back to the default rather than deleting everything", () => {
    expect(fffLogMaxAgeDays({})).toBe(FFF_LOG_DEFAULT_MAX_AGE_DAYS);
    expect(fffLogMaxAgeDays({ CONTEXT_MODE_FFF_LOG_MAX_AGE_DAYS: "nonsense" }))
      .toBe(FFF_LOG_DEFAULT_MAX_AGE_DAYS);
    expect(fffLogMaxAgeDays({ CONTEXT_MODE_FFF_LOG_MAX_AGE_DAYS: "-5" }))
      .toBe(FFF_LOG_DEFAULT_MAX_AGE_DAYS);
    expect(fffLogMaxAgeDays({ CONTEXT_MODE_FFF_LOG_MAX_AGE_DAYS: "30" })).toBe(30);
  });

  test("the directory honours the override, then XDG, then HOME", () => {
    expect(fffLogDir({ CONTEXT_MODE_FFF_LOG_DIR: dir })).toBe(dir);
    // A relative override is ignored rather than fatal.
    expect(fffLogDir({ CONTEXT_MODE_FFF_LOG_DIR: "relative", HOME: "/home/u" }))
      .toBe(join("/home/u", ".cache"));
    expect(fffLogDir({ XDG_CACHE_HOME: "/xdg/cache", HOME: "/home/u" })).toBe("/xdg/cache");
    expect(fffLogDir({ HOME: "/home/u" })).toBe(join("/home/u", ".cache"));
  });
});
