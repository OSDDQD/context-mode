# Retrieval and Search: ctx_find, ctx_graph, ctx_search

Three retrieval tools, three questions. They are not interchangeable, and picking
the wrong one costs a round trip.

---

## Three retrieval tools, three questions

| Question | Tool | What it reads |
|----------|------|---------------|
| **Where does this live?** | `ctx_find` | File names (frecency-ranked), grep over the tree, the FTS5 knowledge base, chunk vectors, and the codegraph neighbourhood — all five fused into one ranked list, with blind signals reported |
| **What do we already know about it?** | `ctx_search` | Only the FTS5 knowledge base: output you captured, docs you fetched, auto-captured session memory |
| **How is it connected?** | `ctx_graph` | The codegraph SQLite index: `symbols`, `outline`, `callers`, `callees`, `impact`, `related`, `explore` |

- `ctx_find` **replaces the Glob + Grep + `ctx_search` triad.** One call instead of
  three whose results you would otherwise merge by reading all three. Confine it with
  `scope: "src/session"` or `type: "code" | "files" | "memory"`.
- `ctx_graph` **replaces reading files to trace call paths.** "What breaks if I change
  `redactSecrets`?" is `ctx_graph(action: "impact", symbol: "redactSecrets")` — a few
  rows — not fifteen `Read` calls. It needs a codegraph index (`codegraph init` once
  per project); without one it says so instead of guessing.
- Reach past `ctx_find` for raw Glob/Grep only when you need an exhaustive literal
  sweep rather than a ranked answer.

---

## Search query strategy

- BM25 uses **OR semantics** — results matching more terms rank higher automatically
- Use 2-4 specific technical terms per query
- **Always use `source` parameter** when multiple docs are indexed to avoid cross-source contamination
  - Partial match works: `source: "Node"` matches `"Node.js v22 CHANGELOG"`
- **Always use `queries` array** — batch ALL search questions in ONE call:
  - `ctx_search(queries: ["transform pipe", "refine superRefine", "coerce codec"], source: "Zod")`
  - NEVER make multiple separate ctx_search() calls — put all queries in one array

---

## External documentation

- **Always use `ctx_fetch_and_index`** for external docs — NEVER `cat` or `ctx_execute` with local paths for packages you don't own
- For GitHub-hosted projects, use the raw URL: `https://raw.githubusercontent.com/org/repo/main/CHANGELOG.md`
- After indexing, use the `source` parameter in search to scope results to that specific document
