/**
 * Fork identity.
 *
 * This tree is a fork of mksglu/context-mode, and two things follow from that
 * which the upstream code has no reason to handle:
 *
 * 1. `ctx upgrade` used to clone the upstream repo unconditionally. Run from a
 *    fork install, that is not an upgrade — it is a silent downgrade that
 *    deletes every local addition and leaves no trace of having done so.
 * 2. Both trees report the same `version`, so "which one is installed?" had no
 *    answer. A fork marker makes doctor and stats able to say it out loud.
 *
 * The repo to pull from is resolved from what the install actually is, in
 * order: operator override, the fork marker in package.json, the git origin of
 * the installed tree, and only then the upstream default.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Where an unforked install upgrades from. */
export const UPSTREAM_REPO = "https://github.com/mksglu/context-mode.git";

export interface ForkInfo {
  /** Git URL this fork upgrades from. */
  repo: string;
  /** Git URL this fork tracks for merges. */
  upstream: string;
  /** Fork revision, independent of the upstream `version`. */
  version: string;
  /** Human-readable owner/name, for one-line status output. */
  name?: string;
}

/** @returns The `fork` block of a parsed package.json, when well-formed. */
export function readForkInfo(pkg: unknown): ForkInfo | null {
  if (!pkg || typeof pkg !== "object") return null;
  const fork = (pkg as Record<string, unknown>).fork;
  if (!fork || typeof fork !== "object") return null;
  const f = fork as Record<string, unknown>;
  if (typeof f.repo !== "string" || !f.repo.trim()) return null;
  return {
    repo: f.repo.trim(),
    upstream: typeof f.upstream === "string" && f.upstream.trim() ? f.upstream.trim() : UPSTREAM_REPO,
    version: typeof f.version === "string" ? f.version : "0",
    name: typeof f.name === "string" ? f.name : undefined,
  };
}

/** @returns Fork info for an installed tree, or null when it is not a fork. */
export function getForkInfo(pluginRoot: string): ForkInfo | null {
  try {
    const pkgPath = join(pluginRoot, "package.json");
    if (!existsSync(pkgPath)) return null;
    return readForkInfo(JSON.parse(readFileSync(pkgPath, "utf-8")));
  } catch {
    return null;
  }
}

/** @returns `origin`'s URL for a git working tree, or null. */
export function gitOriginUrl(dir: string): string | null {
  try {
    if (!existsSync(join(dir, ".git"))) return null;
    const out = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const url = out.trim();
    return url || null;
  } catch {
    return null;
  }
}

/**
 * Which repository `ctx upgrade` should pull from.
 *
 * @param opts.originUrl Injected for tests; defaults to the plugin tree's origin.
 */
export function resolveUpgradeRepo(opts: {
  env?: NodeJS.ProcessEnv;
  pluginRoot?: string;
  originUrl?: string | null;
}): { url: string; reason: "env" | "fork-marker" | "git-origin" | "upstream" } {
  const env = opts.env ?? process.env;

  const override = env.CONTEXT_MODE_UPGRADE_REPO?.trim();
  if (override) return { url: override, reason: "env" };

  if (opts.pluginRoot) {
    const fork = getForkInfo(opts.pluginRoot);
    if (fork) return { url: fork.repo, reason: "fork-marker" };
  }

  const origin = opts.originUrl !== undefined
    ? opts.originUrl
    : (opts.pluginRoot ? gitOriginUrl(opts.pluginRoot) : null);
  if (origin) return { url: origin, reason: "git-origin" };

  return { url: UPSTREAM_REPO, reason: "upstream" };
}

/** Compare two git URLs ignoring the noise that does not change the target. */
export function sameGitRepo(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (u: string | null | undefined): string =>
    (u ?? "")
      .trim()
      .toLowerCase()
      .replace(/^git\+/, "")
      .replace(/^ssh:\/\/git@/, "https://")
      .replace(/^git@([^:]+):/, "https://$1/")
      .replace(/\.git$/, "")
      .replace(/\/+$/, "");
  const na = norm(a);
  return na.length > 0 && na === norm(b);
}

/**
 * Decide whether a fetched tree is newer than the installed one.
 *
 * `version` alone cannot answer this for a fork: the fork keeps upstream's
 * version so its own releases are invisible to a `newVersion === localVersion`
 * check, and `ctx upgrade` reports "already on latest" while shipping nothing.
 * Observed exactly that — an upgrade that pulled a tree 4 commits ahead and
 * installed none of it. The fork revision breaks the tie.
 *
 * A missing revision on either side reads as "0", so an install predating the
 * fork marker still sees the first marked release as an update.
 */
export function isUpgradeAvailable(opts: {
  localVersion: string;
  remoteVersion: string;
  localForkVersion?: string | null;
  remoteForkVersion?: string | null;
}): { available: boolean; localLabel: string; remoteLabel: string } {
  const rev = (v: string | null | undefined): string => (v ?? "0").trim() || "0";
  const localRev = rev(opts.localForkVersion);
  const remoteRev = rev(opts.remoteForkVersion);
  const label = (version: string, r: string): string =>
    r === "0" ? `v${version}` : `v${version} (fork rev ${r})`;
  return {
    available: opts.remoteVersion !== opts.localVersion || remoteRev !== localRev,
    localLabel: label(opts.localVersion, localRev),
    remoteLabel: label(opts.remoteVersion, remoteRev),
  };
}

/** One-line install identity for doctor/stats output. */
export function describeInstall(pluginRoot: string, version: string): string {
  const fork = getForkInfo(pluginRoot);
  if (!fork) return `context-mode v${version} (upstream)`;
  const name = fork.name ?? fork.repo.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
  return `context-mode v${version} · fork ${name} rev ${fork.version}`;
}
