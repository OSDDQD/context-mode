# ADR-0006 — Execution isolation posture

**Status:** Accepted
**Date:** 2026-08-18
**Relates to:** [ADR-0002 — Tool description style](0002-tool-description-style.md)

## Context

The tool descriptions said "sandboxed subprocess", the README said "complete
isolation", and neither was true. What `ctx_execute` actually does:

| | Reality |
|---|---|
| Working directory | the real project root (shell language) or a temp dir (others) |
| Filesystem | whatever the parent process can reach — no namespace, no chroot |
| Environment | a **denylist** — everything not explicitly named is inherited |
| Network | unrestricted, deliberately (fetching is a feature) |
| Process | a real child process; `killTree` bounds it, nothing else does |

The only property genuinely enforced is the one the plugin exists for: **the
bytes the child reads do not enter the conversation — only what it prints
does.** That is a context boundary, not a security boundary, and calling it a
sandbox invites a reader to trust it for something it does not do.

ADR-0002 requires description changes to be backed by a probe rather than
taste, hence `scripts/measure-sandbox-wording.mjs` and
`docs/research/sandbox-wording-2026-08-18.md`.

## Decision

**1. Say "separate subprocess", not "sandboxed subprocess."** In tool
descriptions, tool titles, `hooks/routing-block.mjs`, the README, the skills and
the agent definition. The approval title becomes "Run code in a separate process
(executes the supplied code)" — it still announces the action class, which is
what #852 asked of it, without implying containment.

The sentence that actually drives routing — *"only what you print enters the
conversation"* — is unchanged, word for word. It is the true claim and the
useful one.

**2. Internal identifiers keep their names.** `bytesSandboxed`,
`bytes_sandboxed`, `sandbox-execute` events, `emitSandboxExecuteEvent`. They are
column names and event types in databases already on disk; renaming them buys
honesty nobody reads and costs a migration.

**3. No OS sandbox.** bwrap, landlock, seccomp, Job Objects — all rejected for
this fork:

- The CI matrix is Linux, macOS and Windows. bwrap is Linux-only, landlock needs
  a recent kernel and is Linux-only, Job Objects are Windows-only. Three
  implementations, three sets of failure modes, on a code path whose bugs
  present as "my build mysteriously fails".
- The host already gates the tool. Claude Code, VS Code and JetBrains all put
  `ctx_execute` behind an approval prompt, and the user who approves it has
  already decided to let this agent run code. A second, weaker gate underneath
  changes little except what we can claim.
  <br>*Amended 2026-08-20:* VS Code and JetBrains are no longer supported
  hosts (15a02cf). The argument narrows rather than falls — both remaining
  hosts, Claude Code and Codex CLI, gate the tool the same way, and Codex's
  own manifest sets `default_tools_approval_mode: approve`. The decision is
  unchanged; only the roll call above is historical.
- A sandbox that must let the code read the project, write temp files and reach
  the network — which is the whole job — restricts very little of what actually
  matters.

Users who want an OS sandbox should run the *host* in one. The README now says
so instead of implying we already did it.

**4. The watchdog is idle-based, not wall-clock.** Recorded here because it is
the same kind of decision. Issue #406: imposing a wall clock on a call that
passed no timeout turned 30-minute Gradle builds into false failures. A long
build prints continuously; a hung process prints nothing. So the limit is
silence — every byte of output resets it — armed only when the caller set no
timeout of its own, never in background mode. Shipped disabled
(`CONTEXT_MODE_EXEC_IDLE_TIMEOUT_MS=0`) so a revision of real use can show it
does not kill honest work.

**5. Tighten what is cheap to tighten.** Not a sandbox, but not nothing:

- `CONTEXT_MODE_EXEC_ENV_MODE=allowlist` inverts the environment filter. Opt-in,
  because it also breaks any command that legitimately reads a credential from
  the environment.
- The output cap drops from 100 MB to 32 MB.
- `killTree` sends SIGTERM before SIGKILL so a killed build can flush and clean
  up.
- `ulimit` prologues (`-f`, `-u`, `-v`) stay **off**: on Linux `-u` counts
  processes per user and would throttle the host itself, and `-v` breaks JVM,
  Go and Node, which reserve large virtual address spaces they never touch.

## Consequences

- `tests/core/compact-descriptions.test.ts` pinned the word "sandbox" in the
  compact `ctx_execute` text; it now pins "subprocess".
- The README gains a paragraph saying plainly what the boundary is and is not.
- Anyone searching the codebase for "sandbox" still finds the analytics columns
  and the routing-destination phrasing ("the raw body stays in the sandbox"),
  which describe where bytes go rather than what is contained.
