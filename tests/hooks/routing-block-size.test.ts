/**
 * Byte ceilings on the two texts the plugin injects into a session.
 *
 * The paradox this file guards against: a plugin whose whole purpose is
 * keeping bytes out of the context window was spending 8 582 bytes of it on
 * SessionStart and 7 527 more in the prompt of every subagent — ~46 KB in a
 * session with five of them, before any work was done.
 *
 * Modelled on `tests/core/compact-descriptions.test.ts`, which pins the same
 * trade for tool descriptions: the authored prose stays as the reference text,
 * what ships is compact, an env flag switches back, and a ceiling stops the
 * compact form growing back into prose.
 *
 * The ceilings alone would be satisfied by deleting rules, so the second half
 * of this file asserts that every redirect the PreToolUse hook enforces is
 * still derivable from the compact text. Compaction may drop rationale and
 * examples; it may not drop a rule.
 */

import { describe, expect, test, afterEach } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs hook module without type declarations
import {
  createRoutingBlock,
  createSubagentRoutingBlock,
  createCompactRoutingBlock,
  createCompactSubagentBlock,
  createVerboseRoutingBlock,
} from "../../hooks/routing-block.mjs";
// @ts-ignore — plain .mjs hook module without type declarations
import { createToolNamer } from "../../hooks/core/tool-naming.mjs";

const ORIGINAL = process.env.CONTEXT_MODE_ROUTING_BLOCK;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CONTEXT_MODE_ROUTING_BLOCK;
  else process.env.CONTEXT_MODE_ROUTING_BLOCK = ORIGINAL;
});

const t = createToolNamer("claude-code");
const bytes = (s: string) => Buffer.byteLength(s, "utf-8");

/** What Claude Code actually receives: both blocks carry the ToolSearch bootstrap. */
const SESSION = () => createRoutingBlock(t, { toolSearchBootstrap: true });
const SUBAGENT = () => createSubagentRoutingBlock(t, { toolSearchBootstrap: true });

describe("what ships is the compact text", () => {
  test("compact by default", () => {
    delete process.env.CONTEXT_MODE_ROUTING_BLOCK;
    expect(SESSION()).toBe(createCompactRoutingBlock(t, { toolSearchBootstrap: true }));
    expect(SUBAGENT()).toBe(createCompactSubagentBlock(t, { toolSearchBootstrap: true }));
  });

  test("CONTEXT_MODE_ROUTING_BLOCK=full restores the authored text", () => {
    process.env.CONTEXT_MODE_ROUTING_BLOCK = "full";
    expect(SESSION()).toBe(createVerboseRoutingBlock(t, { toolSearchBootstrap: true }));
    // The subagent's full form is the authored block minus the operator
    // commands — what the Agent branch injected before the split (#233).
    expect(SUBAGENT()).toBe(
      createVerboseRoutingBlock(t, { toolSearchBootstrap: true, includeCommands: false }),
    );
  });

  test("an unknown value behaves as the default", () => {
    process.env.CONTEXT_MODE_ROUTING_BLOCK = "yes-please";
    expect(SESSION()).toBe(createCompactRoutingBlock(t, { toolSearchBootstrap: true }));
  });
});

describe("byte ceilings", () => {
  test("the session block fits 3 KB", () => {
    delete process.env.CONTEXT_MODE_ROUTING_BLOCK;
    // 8 582 bytes before. The ceiling is the 3 KB target with no slack for a
    // paragraph: a new rule has to displace an old one or be worth re-cutting
    // the rest for.
    expect(bytes(SESSION())).toBeLessThanOrEqual(3_072);
  });

  test("the subagent block stays under 1.8 KB", () => {
    delete process.env.CONTEXT_MODE_ROUTING_BLOCK;
    // 7 527 bytes before; the target was 1.5 KB and this lands at 1 755 bytes.
    // The gap is one line: the ToolSearch bootstrap spells ten tool names at
    // the 39-character Claude Code prefix — 517 bytes, 30% of the block —
    // and shortening it means either preloading fewer schemas than the block
    // tells the subagent to call (the #724 failure: not-found, then a silent
    // fall back to Bash) or trusting a keyword ToolSearch to find them. The
    // prose around it is already at 1.2 KB. Raise this only for another rule.
    expect(bytes(SUBAGENT())).toBeLessThanOrEqual(1_800);
  });

  test("the subagent block is materially smaller than the session block", () => {
    delete process.env.CONTEXT_MODE_ROUTING_BLOCK;
    // Both used to be the same text bar one section. A subagent has no session
    // to resume, no operator commands to run and no stats to report; if the two
    // ever converge in size again, the differentiation has been undone.
    expect(bytes(SUBAGENT())).toBeLessThan(bytes(SESSION()) * 0.75);
  });

  test("both stay far below the authored text they replace", () => {
    delete process.env.CONTEXT_MODE_ROUTING_BLOCK;
    const verbose = bytes(createVerboseRoutingBlock(t, { toolSearchBootstrap: true }));
    expect(bytes(SESSION())).toBeLessThan(verbose * 0.5);
    expect(bytes(SUBAGENT())).toBeLessThan(verbose * 0.3);
  });
});

/**
 * The rules, one assertion each. Every one of these is enforced at runtime by
 * `hooks/core/routing.mjs` — the block is where the model is told about it
 * BEFORE the call is intercepted, which is the difference between routing and
 * being corrected.
 */
describe("every enforced rule survives compaction", () => {
  const RULES: Array<[string, RegExp]> = [
    ["curl/wget goes to the fetch tool", /curl\/wget/],
    ["so does WebFetch", /WebFetch/],
    ["so does inline HTTP from code", /inline fetch\(\)\/requests/],
    ["fetched pages are searched, not read", /ctx_fetch_and_index\(url, source\)/],
    ["Bash output you will process goes to the batch tool", /Bash output you will filter\/count\/parse/],
    ["one command goes to ctx_execute", /ctx_execute\(language, code\)/],
    ["plan mode has a read-only gather path", /plan mode → ctx_gather|Plan mode → ctx_gather/i],
    ["Read for analysis goes to ctx_read", /Read to analyze → ctx_read\(path, intent\)/],
    ["…and to ctx_execute_file when code must derive it", /ctx_execute_file\(path, language, code\)/],
    ["Glob/Grep for locating goes to ctx_find", /Glob\/Grep to locate → ctx_find\(query\)/],
    ["symbol questions go to ctx_graph", /ctx_graph\(action\)/],
    ["parallel I/O carries the concurrency guidance", /concurrency 2-8 for network I\/O/],
    ["…including when to keep it at 1", /1 for builds\/tests/],
    ["Read-before-Edit is conceded, not routed away", /Edit matches the exact bytes/],
    ["file writes stay on Write\/Edit", /Write\/Edit for (every )?file writes?/],
    ["Bash keeps git and friends", /git\/mkdir\/rm\/mv/],
    ["Grep keeps the exhaustive sweep", /Grep for an exhaustive/],
  ];

  for (const [name, pattern] of RULES) {
    test(`session block: ${name}`, () => {
      delete process.env.CONTEXT_MODE_ROUTING_BLOCK;
      expect(SESSION()).toMatch(pattern);
    });
    test(`subagent block: ${name}`, () => {
      delete process.env.CONTEXT_MODE_ROUTING_BLOCK;
      expect(SUBAGENT()).toMatch(pattern);
    });
  }

  test("the session block still teaches session memory", () => {
    delete process.env.CONTEXT_MODE_ROUTING_BLOCK;
    expect(SESSION()).toMatch(/sort: "timeline"/);
    expect(SESSION()).toMatch(/BEFORE asking the user/);
  });

  test("the session block still carries the operator commands", () => {
    delete process.env.CONTEXT_MODE_ROUTING_BLOCK;
    expect(SESSION()).toContain("<ctx_commands>");
    expect(SESSION()).toContain("ctx stats");
  });
});

/**
 * What the subagent block drops, and the one thing it adds.
 *
 * Dropping the memory/commands prose is the whole point of a second text; if
 * it creeps back the block is a copy of the session one again.
 */
describe("the subagent block is a different text, not a shorter copy", () => {
  test("no memory or resume prose — a subagent has no session to resume", () => {
    delete process.env.CONTEXT_MODE_ROUTING_BLOCK;
    expect(SUBAGENT()).not.toMatch(/timeline|after compaction|on resume/i);
  });

  test("no operator commands — a subagent has no user to run them for (#233)", () => {
    delete process.env.CONTEXT_MODE_ROUTING_BLOCK;
    expect(SUBAGENT()).not.toContain("<ctx_commands>");
    for (const tool of ["ctx_stats", "ctx_doctor", "ctx_upgrade", "ctx_purge", "ctx_insight"]) {
      expect(SUBAGENT(), `${tool} is an operator command, not a subagent's call`).not.toContain(tool);
    }
  });

  test("it tells the subagent what to hand back", () => {
    // The repo's artifact rule aimed at tool output, and a verbose subagent
    // report floods the parent exactly the same way. Path plus one line.
    delete process.env.CONTEXT_MODE_ROUTING_BLOCK;
    const block = SUBAGENT();
    expect(block).toMatch(/REPORT BACK/);
    expect(block).toMatch(/return the path plus one line/);
    expect(block, "the reason has to be there or the rule reads as ceremony")
      .toMatch(/parent's context/);
  });

  test("the report policy also survives the full-text escape hatch", () => {
    // Under CONTEXT_MODE_ROUTING_BLOCK=full the subagent gets the authored
    // block, which carries the same rule as the artifact policy.
    process.env.CONTEXT_MODE_ROUTING_BLOCK = "full";
    expect(SUBAGENT()).toMatch(/file path \+ 1-line description/);
  });
});
