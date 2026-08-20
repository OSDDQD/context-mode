/**
 * `canonicalProjectRoot` — the memo, and what it deliberately does not invalidate.
 *
 * This function is on the hot path of everything keyed by project: the finder
 * registry, the fs-bus installation map and `fffDbPathsFor` all call it, several
 * times per tool call, always with the same one or two roots. `realpathSync` is
 * a syscall per path component, so the repeat resolutions were pure waste.
 *
 * Two properties are worth pinning, and they pull in opposite directions:
 *   - a repeat lookup must not hit the filesystem again, and
 *   - a lookup that FAILED must not be pinned, because "does not exist yet" is
 *     the one answer that legitimately changes while a server is running (fresh
 *     worktree, a fixture directory made a moment later).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The real resolver, wrapped so the calls can be counted. Everything else in
// node:fs stays actual — the point is the syscall count, not a fake filesystem.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const native = vi.fn(actual.realpathSync.native);
  const realpathSync = Object.assign(
    vi.fn(actual.realpathSync) as unknown as typeof actual.realpathSync,
    { native },
  );
  return { ...actual, realpathSync };
});

import * as fs from "node:fs";
import {
  canonicalProjectRoot, clearCanonicalProjectRootCache,
} from "../../src/fff/paths.js";

const nativeMock = vi.mocked(fs.realpathSync.native);

let tmp: string;

beforeEach(() => {
  clearCanonicalProjectRootCache();
  nativeMock.mockClear();
  tmp = mkdtempSync(join(tmpdir(), "ctx-canon-"));
});

afterEach(() => {
  clearCanonicalProjectRootCache();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("canonicalProjectRoot memoisation", () => {
  test("resolves once for repeated lookups of the same root", () => {
    const root = join(tmp, "project");
    mkdirSync(root);

    const first = canonicalProjectRoot(root);
    const second = canonicalProjectRoot(root);
    const third = canonicalProjectRoot(`${root}/`);

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(nativeMock).toHaveBeenCalledTimes(1);
  });

  test("distinct roots keep distinct entries", () => {
    const a = join(tmp, "a");
    const b = join(tmp, "b");
    mkdirSync(a);
    mkdirSync(b);

    expect(canonicalProjectRoot(a)).not.toBe(canonicalProjectRoot(b));
    expect(canonicalProjectRoot(a)).not.toBe(canonicalProjectRoot(b));
    expect(nativeMock).toHaveBeenCalledTimes(2);
  });

  test("a path that did not exist yet is NOT pinned to its fallback", () => {
    const target = join(tmp, "real");
    const link = join(tmp, "link");
    mkdirSync(target);

    // Nothing at `link` yet: the resolver fails and the resolved-but-not-real
    // form is returned WITHOUT being cached.
    const before = canonicalProjectRoot(link);
    expect(before.endsWith("link")).toBe(true);

    let symlinked = true;
    try {
      symlinkSync(target, link, "dir");
    } catch {
      symlinked = false; // unprivileged Windows — nothing to assert here
    }
    if (!symlinked) return;

    // Same argument, now resolvable: the answer must follow the link rather
    // than come back from a memo of the failure.
    expect(canonicalProjectRoot(link)).toBe(canonicalProjectRoot(target));
  });

  test("clearing the memo picks up a retargeted symlink", () => {
    const first = join(tmp, "one");
    const second = join(tmp, "two");
    const link = join(tmp, "current");
    mkdirSync(first);
    mkdirSync(second);
    try {
      symlinkSync(first, link, "dir");
    } catch {
      return; // unprivileged Windows
    }

    const pinned = canonicalProjectRoot(link);
    expect(pinned).toBe(canonicalProjectRoot(first));

    unlinkSync(link);
    symlinkSync(second, link, "dir");

    // Documented behaviour: within a process the entry is stable, because the
    // registries downstream are already keyed on the value handed out earlier.
    expect(canonicalProjectRoot(link)).toBe(pinned);

    clearCanonicalProjectRootCache();
    expect(canonicalProjectRoot(link)).toBe(canonicalProjectRoot(second));
  });
});
