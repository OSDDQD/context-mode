---
description: Search the persistent FTS5 knowledge base (indexed content + session memory)
argument-hint: [query]
disable-model-invocation: true
---

Search indexed content without rereading raw sources into conversation context.

1. Prefer the `ctx_search` MCP tool. Batch all related questions in one `queries` array.
2. Scope with `source` when the user names a project or indexed label.
3. Use short, specific queries of two to four technical terms:
   ```javascript
   ctx_search({ source: "project:<name>", queries: ["authentication middleware", "token refresh"], limit: 5 })
   ```
4. If MCP tools are unavailable, fall back to the CLI: `context-mode search "authentication middleware" --source project:<name> --limit 5`
5. If the index is empty, tell the user to run `/context-mode:ctx-index` or `context-mode index <path>` first.
