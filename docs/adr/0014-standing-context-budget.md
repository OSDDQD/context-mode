# ADR-0014 — The standing context budget

**Status:** Accepted
**Date:** 2026-08-20 — recorded retrospectively; the changes shipped earlier
**Source:** [FORK-CHANGES §4, §13, §15, §36](../FORK-CHANGES.md)
**Extends:** [ADR-0002 — Tool description voice and structure](0002-tool-description-style.md)

## Context

A plugin whose entire purpose is not spending tokens on bytes the model does not
need was itself spending them before it did anything at all:

| Surface | Cost | Paid |
|---|---|---|
| tool descriptions | 18,739 chars ≈ 4,685 tokens over 12 tools | every request |
| skill descriptions | ~1.5 KB for seven commands only ever invoked explicitly | every session |
| SessionStart routing block | its own budget | every session, plus after every compaction |

The tool descriptions are steering prose. Once the routing block and the
project's own rules have said "think in code", most of that prose is a second
copy of an instruction already in the window.

Then Claude Code's tool-search releases (≥2.1) changed the arithmetic: MCP tool
schemas are **deferred**, visible by name only until a `ToolSearch` call loads
them. That flips the trade twice over. Descriptions are no longer shipped per
request, so the long form is suddenly free — and a direct ctx_* call before the
load fails with a validation error, which breaks the plugin in the worst
possible way: the routing block says call `ctx_batch_execute`, the call errors,
and the model concludes the tools are unavailable and falls back to exactly the
raw Bash/Read flood the plugin exists to prevent.

## Decision

**1. Bytes that ship on every request or every session must earn their place.**
That is the rule the rest of this ADR applies.

**2. Compact descriptions are the default; the long form stays in the source as
the reference.** Measured over a live `tools/list` (12 tools): 18,739 → 4,971
chars, ≈3,442 tokens saved per request (73%).

**3. The description budget follows the host.** `CONTEXT_MODE_TOOL_DESCRIPTIONS`
takes `full`, `compact`, or unset/`auto`. Under `auto` the tools register
compact and the server swaps in the full text on `oninitialized` — after the MCP
handshake identifies the client, before its `tools/list` — when the client is a
schema-deferring host. Identification is by high-confidence `clientInfo`
mapping, with **no env-sniff fallback**: a foreign host running inside a
Claude Code-launched shell must not qualify. An SDK without `update()` keeps the
compact text, which is still correct.

**4. The routing block teaches the bootstrap rather than assuming it.** On a
deferring host it includes a `deferred_tool_bootstrap` section: load the core
ctx_* tools in ONE `ToolSearch("select:…")` call, and never fall back to raw
tools because a schema was not loaded yet. It is worded "may be deferred" so it
is harmless on hosts that do not defer.
`CONTEXT_MODE_TOOLSEARCH_HINT=0` opts out.

**5. Utility skills became slash commands.** Claude Code loads every skill
description into every session's system prompt, so seven commands that are only
ever invoked explicitly were charging every session for standing presence. They
are plugin slash commands with `disable-model-invocation: true` — zero standing
context, same `/context-mode:ctx-*` invocation — and the one skill that *should*
trigger by itself kept its description while losing its long trigger list.

**6. The description is the last surface before the choice.** `CLAUDE.md` and
the routing block are read long before a tool is picked, and every turn pushes
them further away; the tool description is read immediately before it. The model
is not choosing in isolation, it is comparing `ctx_find` against `Grep` — and if
that comparison is not written down it gets made from priors trained on `Grep`.
So every routing target names the native tool it displaces and carries a
WHEN NOT (which ADR-0002 leaves optional) with honest exclusions, enforced by
`tests/core/tool-description-displacement.test.ts`.

**7. The block must survive compaction, and that is measured rather than
argued.** `hooks/hooks.json` registers SessionStart with an empty matcher, which
for SessionStart means all four lifecycle sources — but the hook *body* also
branches on `input.source`, and an early return would drop the block just as
effectively as a matcher that never fired.
`tests/hooks/sessionstart-survives-compaction.test.ts` runs the real hook on all
four sources and compares the emitted block byte for byte.

## Alternatives rejected

**Ship the full descriptions everywhere.** ~3.4k tokens per request to restate
instructions the session already carries.

**Delete the long form.** It is the reference the compact table is derived from,
and it is exactly right on a host that injects no routing block of its own —
which is why `full` remains a supported setting.

**Sniff the environment to detect Claude Code.** Env variables leak into any
process launched from that terminal, so a foreign MCP host would be handed
descriptions written for a different set of rules.

**Keep the utility skills auto-discovered.** Standing cost in every session for
capability used by explicit invocation only.

**Assume deferral never happens, or that it always does.** Both are wrong on
some install, and the failure mode of guessing wrong is the plugin appearing not
to exist.

## Consequences

- Two defaults differ from upstream deliberately: compact descriptions, and the
  semantic layer's adoption behaviour
  ([ADR-0010](0010-semantic-layer-adopted-not-bundled.md)).
- `tests/core/compact-descriptions.test.ts` pins the compact text, so a
  description edit that only touches the long form is caught.
- The agent definition's `tools:` list is an allowlist, so a routing block that
  names a tool an agent cannot call instructs it to do something impossible —
  `tests/plugins/agent-tool-allowlist.test.ts` derives that rule per agent
  instead of enumerating it.

## What is true today

Nine slash commands live in `commands/`, each with
`disable-model-invocation: true`. The `platform-skills/` twins named in the
original entry are gone: they existed for packagers that had no slash commands,
and those hosts were removed ([ADR-0023](0023-two-supported-hosts.md)).
