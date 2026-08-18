---
description: Answer structural questions about the codebase from the codegraph index — callers, callees, impact, outline — without reading files into context
argument-hint: [structural question]
disable-model-invocation: true
---

Answer "how is this connected?" from the codegraph SQLite index instead of by reading files.

1. Prefer the `ctx_graph` MCP tool. Seven actions share one contract:

   | `action` | Question | Required argument |
   |---|---|---|
   | `symbols` | Where is this name defined? | `query` |
   | `outline` | What does this file declare, in source order? | `file` |
   | `callers` | Who calls this symbol? (transitive) | `symbol` |
   | `callees` | What does this symbol call? (transitive) | `symbol` |
   | `impact` | What breaks if this changes? (calls + references + subclasses) | `symbol` |
   | `related` | What does the graph place next to this file? | `file` |
   | `explore` | Source bodies plus the call paths that reach them | `query` |

2. Examples:
   ```javascript
   ctx_graph({ action: "callers", symbol: "ContentStore.index" })
   ctx_graph({ action: "outline", file: "src/store.ts", signaturesOnly: true })
   ctx_graph({ action: "impact", symbol: "redactSecrets", depth: 3 })
   ctx_graph({ action: "explore", query: "session attribution" })
   ```
   `depth` (1-5) bounds the walking actions; default 2, `related` 1.

3. Every response states whether the index lags the working tree ("index lags N files").
   Report that line to the user rather than presenting a stale answer as current.

4. The project needs a codegraph index. If the tool says there is none, run
   `codegraph init` once in the project directory, then retry.

5. Sibling tools: `ctx_find` answers "where does it live" (lexical and fuzzy —
   use it for comments, string literals, arbitrary text), `ctx_search` answers
   "what do we already know about it" (captured output, fetched docs, session memory).

6. `CONTEXT_MODE_GRAPH=0` removes the tool from the surface; if it is missing, that is why.
   Related switches: `CONTEXT_MODE_GRAPH_DAEMON`, `CONTEXT_MODE_GRAPH_EXPLORE_PASSTHROUGH`,
   `CONTEXT_MODE_GRAPH_FRESHNESS`.
