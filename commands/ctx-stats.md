---
description: Show context-mode savings for this session (tokens, ratio, per-tool breakdown)
disable-model-invocation: true
---

Show context savings for the current session.

1. Call the `ctx_stats` MCP tool (no parameters needed).
2. **CRITICAL**: Copy-paste the ENTIRE tool output as markdown text directly into your response message. Do NOT summarize, do NOT collapse, do NOT paraphrase. The user must see the full tables without pressing ctrl+o. Copy every line exactly as returned by the tool.
3. After the full output, add ONE sentence highlighting the key savings metric, e.g.:
   - "context-mode saved **12.4x** — 92% of data stayed in sandbox."
   - If no data yet: "No context-mode calls yet this session."

Note: `ctx_stats` is read-only. To wipe the knowledge base use `/context-mode:ctx-purge`.
