/**
 * The hook-side platform table agrees with the server-side one.
 *
 * These are two hand-written copies of the same fact: which environment
 * variable means which host. `src/adapters/detect.ts` is consulted inside the
 * MCP server; `hooks/core/platform-detect.mjs` is consulted inside hook
 * scripts, which run as separate processes and cannot import the server's
 * TypeScript. When they disagree, nothing fails — the server writes a session
 * under one host's config root and the hooks look for it under another's, and
 * the symptom is a session that appears to have no memory.
 *
 * The rule used to be enforced in prose: a capitalised "MUST stay in
 * lock-step" comment at the top of the mirror. It did not hold. By the time it
 * was deleted the mirror listed two Claude Code variables where detect.ts
 * listed four, so `CLAUDE_CODE_ENTRYPOINT` and `CLAUDE_PLUGIN_ROOT` identified
 * the host on one side and were invisible on the other — the exact divergence
 * the comment forbade, sitting directly underneath it. A comment cannot hold
 * two copies together; it only records what someone intended once.
 *
 * So the requirement is executable now, and it is also stated more precisely
 * than the comment stated it. Byte-identity was never the requirement: the two
 * files may differ in ordering, in commentary, and in the shape they store
 * (detect.ts tags each variable with a role the hooks have no use for). What
 * must hold is that for any environment, both sides name the same host. That
 * is what is checked below.
 *
 * detect.ts is read as TEXT rather than imported. The assertion is about a
 * literal table in a specific file, and reading it directly keeps this test
 * from depending on the server's module graph — which pulls in the store, the
 * adapters and the session layer, any of which can be mid-refactor while this
 * invariant still needs checking.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  detectPlatformFromEnv,
  PLATFORM_ENV_VARS_MIRROR,
} from "../../hooks/core/platform-detect.mjs";

const REPO_ROOT = resolve(__dirname, "..", "..");
const DETECT_TS = resolve(REPO_ROOT, "src", "adapters", "detect.ts");

/**
 * The env-var names detect.ts lists for one platform, parsed out of the
 * `["<platform>", [ { name: "X", … }, … ]]` row of `_PLATFORM_ENV_VARS_RAW`.
 */
function detectTsVarsFor(platform: string): string[] | null {
  const source = readFileSync(DETECT_TS, "utf-8");
  const row = new RegExp(`\\["${platform}",\\s*\\[([\\s\\S]*?)\\]\\]`).exec(source);
  if (!row) return null;
  return [...row[1].matchAll(/name:\s*"([A-Z0-9_]+)"/g)].map((m) => m[1]);
}

const MIRROR = new Map(PLATFORM_ENV_VARS_MIRROR as Array<[string, string[]]>);

describe("the hook mirror and src/adapters/detect.ts", () => {
  it("covers exactly the supported hosts", () => {
    expect([...MIRROR.keys()].sort()).toEqual(["claude-code"]);
  });

  it("can still find the table it is mirroring", () => {
    // If detect.ts is restructured so the rows stop matching, this test would
    // otherwise pass by comparing against nothing at all.
    for (const platform of MIRROR.keys()) {
      expect(
        detectTsVarsFor(platform),
        `no ${platform} row found in src/adapters/detect.ts — the parser, not the data, is out of date`,
      ).not.toBeNull();
    }
  });

  for (const [platform, mirrored] of MIRROR) {
    it(`lists the same variables for ${platform} as detect.ts does`, () => {
      const canonical = detectTsVarsFor(platform) ?? [];
      expect(
        [...mirrored].sort(),
        `hooks/core/platform-detect.mjs and src/adapters/detect.ts disagree about ${platform}. ` +
          "A variable known to one side and not the other identifies the host in the server " +
          "and not in the hooks, or the reverse — the session then splits across two config roots.",
      ).toEqual([...canonical].sort());
    });
  }

  it("resolves every variable detect.ts knows to the platform that owns it", () => {
    // The property the byte-comparison above is standing in for, asserted
    // directly: one variable set, one answer.
    for (const [platform] of MIRROR) {
      for (const name of detectTsVarsFor(platform) ?? []) {
        expect(detectPlatformFromEnv({ [name]: "value" }), `${name} should mean ${platform}`).toBe(platform);
      }
    }
  });
});

describe("detectPlatformFromEnv", () => {
  it("falls back to claude-code when nothing matches", () => {
    // Not an error case: a host that sets nothing recognisable still gets
    // working guidance, in the naming convention most likely to be right.
    expect(detectPlatformFromEnv({})).toBe("claude-code");
    expect(detectPlatformFromEnv({ SOME_OTHER_CLI: "1" })).toBe("claude-code");
  });

  it("ignores a variable set to the empty string", () => {
    // Hosts clear variables by emptying them rather than unsetting them, and
    // an empty variable must not claim the session for the host that owns it.
    expect(detectPlatformFromEnv({ CLAUDE_CODE_ENTRYPOINT: "" })).toBe("claude-code");
  });

  it("does not promote a variable that merely looks like one of ours", () => {
    // The table is a list of exact names, not a prefix match, and it holds
    // only live hosts. CODEX_HOME is the case that can actually fail: a real
    // variable of a removed host, still set by users who moved that config,
    // saying nothing about which host is running now.
    expect(detectPlatformFromEnv({ CODEX_HOME: "/tmp/codex" })).toBe("claude-code");
    expect(detectPlatformFromEnv({ CODEX_CI: "1" })).toBe("claude-code");
  });

  it("defaults to the process environment when called with no argument", () => {
    expect(typeof detectPlatformFromEnv()).toBe("string");
  });
});
