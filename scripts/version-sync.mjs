#!/usr/bin/env node
// Sync version from package.json to all manifest files.
// Runs automatically via npm `version` lifecycle hook.
//
// `--check` verifies the same invariant without writing anything and exits 1 on
// drift, so CI can catch a manifest that fell out of lockstep (a release commit
// that staged package.json but not the manifests) instead of discovering it
// when a user installs the stale bundle.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Single source of truth for the set of manifests whose version must track
// package.json. Exported so tests/scripts/version-sync.test.ts can derive its
// lockstep + `git add` coverage assertions from this exact list instead of a
// hand-copied duplicate — the duplication is what let manifests silently drift
// across releases (#768; cf. the .cursor-plugin v1.0.111 incident). Any entry
// added here is automatically (a) version-synced below, (b) lockstep-asserted,
// and (c) checked for presence in the npm `version` `git add` list.
export const TARGETS = [
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  //
  // Two entries, down from eleven (15a02cf) and then from three. Every removed
  // entry was a manifest for a host this fork no longer ships, and each one was
  // a place the number could be forgotten — which is the failure D0 spent a
  // wave on. The shorter this list, the smaller the surface.
];

// Every place inside a manifest that carries the version. The writer and
// `--check` both walk this one list, so the check can never assert on a field
// the sync does not actually write — a mismatch between the two would make CI
// fail on a manifest that is in fact correct, which is worse than no check.
// Only fields that already exist are reported: absent ones are absent by
// design (e.g. .agents/plugins/marketplace.json has no top-level `version`).
function versionFields(content) {
  const fields = [];
  if (content.version !== undefined) {
    fields.push({ path: "version", owner: content, key: "version" });
  }
  if (content.metadata?.version !== undefined) {
    fields.push({ path: "metadata.version", owner: content.metadata, key: "version" });
  }
  if (Array.isArray(content.plugins)) {
    content.plugins.forEach((p, i) => {
      if (p?.version !== undefined) {
        fields.push({ path: `plugins[${i}].version`, owner: p, key: "version" });
      }
    });
  }
  return fields;
}

function syncManifests() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const version = pkg.version;

  console.log(`→ syncing version ${version} to manifests...`);

  const failures = [];
  for (const file of TARGETS) {
    try {
      const content = JSON.parse(readFileSync(file, "utf8"));
      for (const f of versionFields(content)) f.owner[f.key] = version;
      writeFileSync(file, JSON.stringify(content, null, 2) + "\n");
      console.log(`  ✓ ${file}`);
    } catch (e) {
      // Fail loud, don't skip: a listed target that can't be read/written is a
      // manifest that will ship stale. Silently warning-and-continuing (the
      // pre-#768 behavior) is exactly how a renamed/missing manifest drifts
      // forever without anyone noticing until a user files an install bug.
      console.error(`  ✗ ${file} — ${e.message}`);
      failures.push(file);
    }
  }

  if (failures.length > 0) {
    console.error(
      `version-sync: FAIL — ${failures.length} manifest(s) could not be synced: ${failures.join(", ")}`,
    );
    process.exit(1);
  }

  console.log(`✓ all manifests at v${version}`);
}

function checkManifests() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const version = pkg.version;

  console.log(`→ checking manifests against version ${version}...`);

  const drifted = [];
  const failures = [];
  for (const file of TARGETS) {
    let content;
    try {
      content = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      // Same reasoning as the writer: an unreadable target is a manifest that
      // will ship stale, so it is a failure and not a skip.
      console.error(`  ✗ ${file} — ${e.message}`);
      failures.push(file);
      continue;
    }
    const fields = versionFields(content);
    if (fields.length === 0) {
      // A target with no version field at all cannot be kept in lockstep — it
      // is either the wrong path or a manifest that lost its version key.
      console.error(`  ✗ ${file} — no version field to check`);
      failures.push(file);
      continue;
    }
    const off = fields.filter((f) => f.owner[f.key] !== version);
    if (off.length > 0) {
      for (const f of off) {
        console.error(`  ✗ ${file}#${f.path} — ${String(f.owner[f.key])} (expected ${version})`);
      }
      drifted.push(file);
      continue;
    }
    console.log(`  ✓ ${file}`);
  }

  if (drifted.length > 0 || failures.length > 0) {
    console.error(
      `version-sync --check: FAIL — ${drifted.length} manifest(s) out of sync` +
        `${failures.length > 0 ? `, ${failures.length} unreadable` : ""}. ` +
        `Run \`node scripts/version-sync.mjs\` and commit the result.`,
    );
    process.exit(1);
  }

  console.log(`✓ all manifests at v${version}`);
}

// Only run when executed directly (npm `version` hook, or CI passing --check).
// When imported (e.g. by the test that reads TARGETS as the source of truth),
// do nothing.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.slice(2).includes("--check")) checkManifests();
  else syncManifests();
}

// The `pi`, `openclaw` and `omp` blocks that used to sit in package.json were
// removed with their hosts (15a02cf); none of them carried a `version` field, so
// nothing about this list changes with them gone.
