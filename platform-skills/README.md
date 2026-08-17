# platform-skills/

The ctx-* utility skills, moved here from `skills/` (fork feature #15).

Claude Code auto-discovers every skill under a plugin's `skills/` directory
and loads each skill's description into the system prompt of every session —
~1.5 KB per session for seven commands that are only ever invoked explicitly.
Claude Code now gets them as plugin slash commands in `commands/`
(`disable-model-invocation: true`, zero standing context, same
`/context-mode:ctx-*` invocations).

This directory exists for the platforms that still consume the skill files:
`package.json` → `pi.skills` lists it alongside `./skills`. The main
`context-mode` routing skill stays in `skills/` for every platform.

Upstream-merge note: upstream edits to `skills/ctx-*/SKILL.md` will surface
as modify/delete conflicts after `npm run sync-upstream`; re-apply the change
to the matching file here and to the `commands/ctx-*.md` twin.
