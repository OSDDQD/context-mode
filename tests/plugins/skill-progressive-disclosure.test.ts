/**
 * SKILL.md size budget — progressive disclosure (roadmap §2.3).
 *
 * The whole SKILL.md body enters context the moment the skill triggers. It had
 * grown to 18 175 bytes (~4 500 tokens) of decision trees, tables and worked
 * examples that a session needs on maybe one call in twenty. The Agent Skills
 * canon is the opposite: a short body that says when to use the skill and the
 * rules that must always hold, with the bulk in sibling reference files the
 * model loads only when it needs them.
 *
 * Nothing here checks prose quality. It pins the three things that silently
 * regress: the body stays small, every reference it advertises exists, and the
 * frontmatter description — the one part that is always in context, and the
 * only thing that makes the skill trigger at all — keeps its trigger
 * vocabulary. A description that loses `ctx_find` stops the skill from firing
 * on "where does X live", and nothing anywhere goes red.
 */

import "../setup-home";
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(__dirname, "..", "..");
const skillDir = join(repoRoot, "skills", "context-mode");
const skill = readFileSync(join(skillDir, "SKILL.md"), "utf-8");

/** 4 KB ≈ 1 000 tokens. The pre-split body was 18 175 bytes. */
const BODY_BUDGET_BYTES = 4096;

describe("skills/context-mode/SKILL.md", () => {
  it(`stays within the ${BODY_BUDGET_BYTES}-byte progressive-disclosure budget`, () => {
    const size = Buffer.byteLength(skill, "utf-8");
    expect(
      size,
      `SKILL.md is ${size} B — over the ${BODY_BUDGET_BYTES} B budget. It loads in full ` +
        `on every trigger; move the new material into skills/context-mode/references/ ` +
        `and link it from the References section instead of growing the body.`,
    ).toBeLessThanOrEqual(BODY_BUDGET_BYTES);
  });

  it("resolves every reference file it points at", () => {
    const referenced = [...skill.matchAll(/references\/[A-Za-z0-9._-]+\.md/g)].map((m) => m[0]);
    expect(referenced.length, "SKILL.md advertises no reference files").toBeGreaterThan(0);
    const dangling = [...new Set(referenced)].filter((rel) => !existsSync(join(skillDir, rel)));
    expect(
      dangling,
      `SKILL.md points at reference files that do not exist: ${dangling.join(", ")} — ` +
        `the model is told it can load them and gets nothing.`,
    ).toEqual([]);
  });

  it("keeps the trigger vocabulary in the frontmatter description", () => {
    const frontmatter = skill.split("---")[1] ?? "";
    for (const term of [
      "ctx_execute",
      "ctx_execute_file",
      "ctx_batch_execute",
      "ctx_find",
      "ctx_graph",
      "Playwright",
      "20 lines",
    ]) {
      expect(
        frontmatter.includes(term),
        `frontmatter description lost "${term}" — the skill stops triggering on that case`,
      ).toBe(true);
    }
  });
});
