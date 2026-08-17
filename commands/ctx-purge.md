---
description: Purge the context-mode knowledge base (destructive, no undo)
disable-model-invocation: true
---

Permanently delete context-mode session data for this project. Two scopes (issue #520):

- **Project scope** (`scope: "project"`): wipes EVERYTHING — knowledge base, all session DB rows for every session, events markdown, and stats.
- **Session scope** (`sessionId: "<id>"`): wipes ONLY the matching session's rows + FTS5 chunks. Sibling sessions, project stats, and the FTS5 store file are preserved.

Steps:

1. **Decide the scope first** with the user:
   - "Wipe just one session?" → ask for the `sessionId`.
   - "Wipe the whole project?" → confirm scope:'project' (destructive, irreversible).
2. **Warn the user about scope:'project'** — everything will be deleted: the FTS5 knowledge base, the session events DB for ALL sessions in the project, the events markdown file, and persisted stats.
3. Call the `ctx_purge` MCP tool:
   - Scoped: `{ confirm: true, sessionId: "<id>" }` — implies scope:'session'.
   - Project: `{ confirm: true, scope: "project" }` — explicit destructive form.
   - `confirm: true` is always required. `sessionId` combined with `scope: "project"` is rejected as ambiguous.
4. Report the result — the response lists exactly what was deleted and (for scoped purges) confirms what was preserved.

Notes: `ctx_purge` is the only way to delete session data; `ctx_stats` is read-only; `/clear` and `/compact` do NOT affect context-mode data. There is no undo.
