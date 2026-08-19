/**
 * turndown-plugin-gfm ships no type declarations and has no @types package.
 * Only scripts/measure-extraction.mts uses it, and only to register the GFM
 * rules on a Turndown instance, so the surface worth declaring is one function.
 *
 * This file exists because tsconfig.test.json typechecks scripts/, which
 * tsconfig.json never did — the import had been an implicit `any` since it was
 * written.
 */
declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  /** Registers the full GFM rule set (tables, strikethrough, task lists). */
  export function gfm(service: TurndownService): void;
  export function tables(service: TurndownService): void;
  export function strikethrough(service: TurndownService): void;
  export function taskListItems(service: TurndownService): void;
  export function highlightedCodeBlock(service: TurndownService): void;
}
