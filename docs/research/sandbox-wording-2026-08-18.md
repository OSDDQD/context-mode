# "Sandboxed subprocess" — what is actually isolated

**Date:** 2026-08-18
**Harness:** `node scripts/measure-sandbox-wording.mjs`
**Subject:** `ctx_execute` / `ctx_execute_file` tool descriptions (ADR-0002, ADR-0006)

## Question

The tool descriptions promised a "sandboxed subprocess" and the README promised
"complete isolation". ADR-0002 requires a description change to be backed by a
probe rather than by taste, so: which of those properties hold when code runs
through the real executor?

## Method

Each row runs a short script through `PolyglotExecutor` and reports what it
observed. Read-only; nothing is written outside the OS temp directory.

## Result

Project root `/home/osddqd/projects/context-mode`.

| property | observed | verdict |
|---|---|---|
| working directory (shell) | `/home/osddqd/projects/context-mode` | the real project root |
| filesystem reach | `home readable` | inherits the parent's permissions |
| environment inheritance (default) | `probe-secret-value` | denylist — anything not named is inherited |
| environment inheritance (allowlist mode) | `<unset>` | withheld |
| network | `fetch available` | available — fetching is a feature |
| output → conversation | `read 5823 bytes, printed this line` | **holds** |

Five of six "isolation" claims are false as stated. The subprocess runs in the
user's own project directory, can read their home directory, and — by default —
receives every environment variable the denylist has not heard of, which is
where `AWS_*`, `GITHUB_TOKEN` and connection strings live.

The sixth is the one the plugin exists for and it holds exactly: a script read
5,823 bytes and the conversation received one line.

## Consequence

Descriptions now say **"separate subprocess"**. The routing sentence — *"only
what you print enters the conversation"* — is unchanged, because it is the claim
the probe confirms. `CONTEXT_MODE_EXEC_ENV_MODE=allowlist` closes the
environment row for anyone who wants it; the other rows are inherent to running
the user's own build in the user's own directory, and ADR-0006 records why no OS
sandbox is being added.

## Caveats

- One machine, Linux. The filesystem and environment rows are structural (they
  follow from `spawn` inheriting the parent), so platform variation would not
  change the verdicts; the paths would differ.
- "Network available" is not a defect. Fetching is a feature, and the fetch path
  is what makes `ctx_fetch_and_index` work.
