---
name: ctx-find
description: |
  Locate where something lives in this project — one fused search across fuzzy file
  names, literal grep, the FTS5 knowledge base, chunk vectors, and the codegraph
  neighbourhood, returned as a single ranked list.
  Trigger: /context-mode:ctx-find
user-invocable: true
---

# Context Mode Find

Answer "where does this live?" without listing directories or grepping the tree into context.

## Instructions

1. Prefer the `ctx_find` MCP tool when it is available. It runs five signals in
   parallel — fuzzy file names (frecency-aware), literal grep, the FTS5 knowledge
   base, chunk vectors, and the codegraph neighbourhood — and fuses them with
   reciprocal-rank fusion into ONE ranked list. Each row is tagged with the signals
   that produced it; signals that cannot run are reported as blind.
2. Use 2-5 specific terms. Free text, not a regex — the fuzzy and semantic arms
   do the widening.
3. Narrow when the answer is obviously local:

```javascript
ctx_find({ query: "session db path", scope: "src/session", type: "code" })
ctx_find({ query: "what did we decide about caching", type: "memory", limit: 5 })
```

`type`: `all` (default) | `files` (names + graph) | `code` (names + grep + graph) |
`memory` (FTS5 + vectors). `source` scopes the knowledge-base signals to one indexed
label (partial match). `scope` is a project-relative directory prefix.

4. Do NOT follow this with a glob or grep for the same question — `ctx_find` already
   ran both. Reach for a raw grep only when you need an exhaustive literal sweep
   rather than a ranked answer.
5. Sibling tools: `ctx_search` answers "what do we already know about it", `ctx_graph`
   answers "how is it connected". Pick by the question, not by habit.
6. If the fused list comes back empty, the content was never captured and is not in
   the tree — index it first with `ctx_batch_execute` or `ctx_fetch_and_index`.
7. `CONTEXT_MODE_FIND=0` removes the tool from the surface; if it is missing, that is why.
