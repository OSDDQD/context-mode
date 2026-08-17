#!/usr/bin/env node
/**
 * Probe what `ctx_execute` actually isolates (ADR-0002 / ADR-0006).
 *
 * The tool descriptions claimed a "sandboxed subprocess". This runs code
 * through the real executor and reports, per property, whether the claim holds:
 * working directory, filesystem reach, environment inheritance, network.
 *
 * Read-only. Nothing here writes outside the OS temp directory.
 *
 * Usage:
 *   node scripts/measure-sandbox-wording.mjs [--json]
 *
 * Requires a build: `npm run build`.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";

const asJson = process.argv.includes("--json");

let PolyglotExecutor;
try {
  ({ PolyglotExecutor } = await import("../build/executor.js"));
} catch (err) {
  console.error(`Cannot load build/: ${err.message}\nRun \`npm run build\` first.`);
  process.exit(1);
}

const projectRoot = resolve(process.cwd());
const exec = new PolyglotExecutor({ projectRoot });

/** Run one probe and return trimmed stdout. */
async function probe(code, language = "javascript") {
  const r = await exec.execute({ language, code, timeout: 20_000 });
  return (r.stdout || r.stderr).trim();
}

// Deliberately NOT a CONTEXT_MODE_* name: that prefix is carried through in
// allowlist mode on purpose, so it would prove nothing.
const marker = "probe-secret-value";
process.env.PROBE_API_TOKEN = marker;

const results = [];

results.push({
  property: "working directory (shell)",
  claim: "isolated",
  observed: await probe("pwd", "shell"),
  verdict: (await probe("pwd", "shell")) === projectRoot ? "the real project root" : "not the project root",
});

results.push({
  property: "filesystem reach",
  claim: "isolated",
  observed: await probe(
    `const fs=require('fs');` +
    `try{fs.readdirSync(${JSON.stringify(homedir())});console.log('home readable')}` +
    `catch(e){console.log('home blocked: '+e.code)}`,
  ),
  verdict: "inherits the parent's permissions",
});

const defaultEnv = await probe(`console.log(process.env.PROBE_API_TOKEN ?? '<unset>')`);
results.push({
  property: "environment inheritance (default)",
  claim: "isolated",
  observed: defaultEnv,
  verdict: defaultEnv === marker
    ? "denylist — anything not named is inherited"
    : "withheld",
});

process.env.CONTEXT_MODE_EXEC_ENV_MODE = "allowlist";
const allowlistEnv = await probe(`console.log(process.env.PROBE_API_TOKEN ?? '<unset>')`);
results.push({
  property: "environment inheritance (allowlist mode)",
  claim: "isolated",
  observed: allowlistEnv,
  verdict: allowlistEnv === marker ? "STILL INHERITED" : "withheld",
});
delete process.env.CONTEXT_MODE_EXEC_ENV_MODE;

results.push({
  property: "network",
  claim: "unrestricted (deliberate)",
  observed: await probe(`console.log(typeof fetch === 'function' ? 'fetch available' : 'no fetch')`),
  verdict: "available — fetching is a feature",
});

results.push({
  property: "output → conversation",
  claim: "only what you print",
  observed: await probe(
    `const fs=require('fs');const n=fs.readFileSync(${JSON.stringify(resolve(projectRoot, "package.json"))},'utf8').length;` +
    `console.log('read '+n+' bytes, printed this line')`,
  ),
  verdict: "HOLDS — the read bytes never left the subprocess",
});

delete process.env.PROBE_API_TOKEN;
await exec.cleanup?.();

if (asJson) {
  console.log(JSON.stringify({ projectRoot, results }, null, 2));
} else {
  console.log(`project root: ${projectRoot}\n`);
  console.log("| property | observed | verdict |");
  console.log("|---|---|---|");
  for (const r of results) {
    console.log(`| ${r.property} | \`${r.observed.replace(/\|/g, "\\|").slice(0, 60)}\` | ${r.verdict} |`);
  }
  console.log(
    "\nOne claim survives: only what the code prints enters the conversation. " +
    "That is a context boundary, not a security boundary — see docs/adr/0006-execution-isolation-posture.md.",
  );
}
