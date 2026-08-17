---
description: Index a local file or directory into the persistent FTS5 knowledge base
argument-hint: [path]
disable-model-invocation: true
---

Index local project content for later `ctx_search` retrieval.

1. Prefer the `ctx_index` MCP tool. Use the path from the command argument; ask only if none was given and the project root is ambiguous.
2. Use `path`, not large inline `content`, so file bytes do not enter the conversation.
3. For repository indexing, pass conservative bounds and a clear source label:
   ```javascript
   ctx_index({ path: ".", source: "project:<name>", maxDepth: 5, maxFiles: 200 })
   ```
4. If MCP tools are unavailable, fall back to the CLI: `context-mode index . --source project:<name>`
5. Report the indexed source label, file/section count, and the matching search command:
   ```javascript
   ctx_search({ source: "project:<name>", queries: ["..."] })
   ```

Safety: do not index dependency directories, build outputs, secrets, or generated artifacts — prefer `exclude` for noisy paths. For broad repos, ask before raising `maxFiles` above 500.
