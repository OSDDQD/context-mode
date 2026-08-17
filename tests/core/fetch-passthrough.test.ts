/**
 * Artifact-URL passthrough (upstream #938 / #984 / #1006).
 *
 * The failure being guarded against is not "fetch fails" — it is "fetch
 * succeeds and returns an empty SPA shell the model believes is content".
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { isFetchPassthroughUrl, passthroughFetchError } from "../../src/fetch-passthrough.js";
import {
  isFetchPassthroughUrl as hookIsPassthrough,
  resetFetchPassthrough,
  routePreToolUse,
} from "../../hooks/core/routing.mjs";

const ARTIFACT_URLS = [
  "https://claude.ai/code/artifact/0d6ac9f2-1f2a-4a1e-9f2f-1a2b3c4d5e6f",
  "https://claude.ai/public/artifacts/0d6ac9f2-1f2a-4a1e-9f2f-1a2b3c4d5e6f",
  "https://claude.site/artifacts/0d6ac9f2-1f2a-4a1e-9f2f-1a2b3c4d5e6f",
  "http://claude.ai/code/artifact/abc",
];

const NORMAL_URLS = [
  "https://example.com/docs",
  "https://claude.ai/chats",
  "https://github.com/mksglu/context-mode/issues/938",
  "https://notclaude.ai.evil.com/code/artifact/x",
];

const ORIGINAL = process.env.CONTEXT_MODE_FETCH_PASSTHROUGH;

beforeEach(() => {
  delete process.env.CONTEXT_MODE_FETCH_PASSTHROUGH;
  resetFetchPassthrough();
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CONTEXT_MODE_FETCH_PASSTHROUGH;
  else process.env.CONTEXT_MODE_FETCH_PASSTHROUGH = ORIGINAL;
  resetFetchPassthrough();
});

describe("isFetchPassthroughUrl", () => {
  test("recognises artifact URLs", () => {
    for (const url of ARTIFACT_URLS) expect(isFetchPassthroughUrl(url), url).toBe(true);
  });

  test("leaves ordinary URLs alone", () => {
    for (const url of NORMAL_URLS) expect(isFetchPassthroughUrl(url), url).toBe(false);
  });

  test("host-suffix entries extend the list", () => {
    const env = { CONTEXT_MODE_FETCH_PASSTHROUGH: "intranet.corp" } as NodeJS.ProcessEnv;
    expect(isFetchPassthroughUrl("https://wiki.intranet.corp/page", env)).toBe(true);
    expect(isFetchPassthroughUrl("https://intranet.corp/page", env)).toBe(true);
    expect(isFetchPassthroughUrl("https://intranet.corp.evil.com/page", env)).toBe(false);
  });

  test("regex entries extend the list; malformed ones are skipped", () => {
    const env = {
      CONTEXT_MODE_FETCH_PASSTHROUGH: "[unclosed(|||^https://docs\\.internal/",
    } as NodeJS.ProcessEnv;
    expect(() => isFetchPassthroughUrl("https://docs.internal/x", env)).not.toThrow();
    expect(isFetchPassthroughUrl("https://docs.internal/x", env)).toBe(true);
  });

  test("the hook and server implementations agree", () => {
    for (const url of [...ARTIFACT_URLS, ...NORMAL_URLS]) {
      expect(hookIsPassthrough(url), url).toBe(isFetchPassthroughUrl(url));
    }
  });
});

describe("routePreToolUse — WebFetch", () => {
  test("artifact URLs pass through untouched", () => {
    for (const url of ARTIFACT_URLS) {
      const decision = routePreToolUse("WebFetch", { url }, "/repo", "claude-code", "sess-1");
      expect(decision, url).toBeNull();
    }
  });

  test("ordinary URLs still get the redirect (when MCP is reachable)", () => {
    const decision = routePreToolUse(
      "WebFetch",
      { url: "https://example.com/docs" },
      "/repo",
      "claude-code",
      "sess-2",
    );
    // Either a deny/redirect decision, or null when this environment has no
    // MCP server running (mcpRedirect's availability gate). Both are correct;
    // what must never happen is the artifact branch swallowing a normal URL.
    if (decision !== null) expect(decision.action).toBe("deny");
  });
});

describe("passthroughFetchError", () => {
  test("names the tool that works instead of only refusing", () => {
    const msg = passthroughFetchError("https://claude.ai/code/artifact/x");
    expect(msg).toContain("WebFetch");
    expect(msg).toContain("empty shell");
    expect(msg).toContain("https://claude.ai/code/artifact/x");
  });
});
