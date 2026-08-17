/**
 * SubagentStop + SessionEnd registration (fork features #14, #15).
 *
 * Pins that the two lifecycle hooks are wired end to end: hooks.json entries,
 * script files on disk, and the adapter's hook-type definitions the doctor
 * and upgrade flows read.
 */

import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOOK_TYPES, HOOK_SCRIPTS, OPTIONAL_HOOKS } from "../../src/adapters/claude-code/hooks.js";

const ROOT = join(__dirname, "..", "..");

describe("hooks.json lifecycle entries", () => {
  const hooksJson = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf-8")) as {
    hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>;
  };

  test.each(["SubagentStop", "SessionEnd"])("%s is registered with an existing script", (event) => {
    const entries = hooksJson.hooks[event];
    expect(entries, `${event} must be present in hooks.json`).toBeDefined();
    expect(entries).toHaveLength(1);
    expect(entries[0].matcher).toBe("");
    const command = entries[0].hooks[0].command;
    expect(command).toContain("${CLAUDE_PLUGIN_ROOT}");
    const script = command.match(/hooks\/([a-z-]+\.mjs)/)?.[1];
    expect(script, `command must reference a hook script: ${command}`).toBeDefined();
    expect(existsSync(join(ROOT, "hooks", script!))).toBe(true);
  });
});

describe("adapter hook definitions", () => {
  test("HOOK_TYPES and HOOK_SCRIPTS carry the lifecycle hooks", () => {
    expect(HOOK_TYPES.SUBAGENT_STOP).toBe("SubagentStop");
    expect(HOOK_TYPES.SESSION_END).toBe("SessionEnd");
    expect(HOOK_SCRIPTS.SubagentStop).toBe("subagentstop.mjs");
    expect(HOOK_SCRIPTS.SessionEnd).toBe("sessionend.mjs");
  });

  test("both are optional — doctor must not fail an install without them", () => {
    expect(OPTIONAL_HOOKS).toContain("SubagentStop");
    expect(OPTIONAL_HOOKS).toContain("SessionEnd");
  });

  test("every HOOK_SCRIPTS entry exists on disk", () => {
    for (const script of Object.values(HOOK_SCRIPTS)) {
      expect(existsSync(join(ROOT, "hooks", script)), `hooks/${script}`).toBe(true);
    }
  });
});
