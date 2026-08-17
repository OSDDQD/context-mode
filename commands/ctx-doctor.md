---
description: Diagnose context-mode — runtimes, hooks, FTS5, plugin registration, versions
disable-model-invocation: true
---

Run context-mode diagnostics and display results directly in the conversation.

1. Call the `ctx_doctor` MCP tool directly. It runs all checks server-side and returns a plain-text status report.
2. Display the results verbatim — they are already formatted with plain-text status prefixes: `[OK]` PASS, `[FAIL]` FAIL, `[WARN]` WARN. Renderer-safe (no markdown task-list syntax) for cross-client compatibility.
3. **Fallback** (only if the MCP tool call fails): run with Bash:
   ```
   CLI="${CLAUDE_PLUGIN_ROOT}/cli.bundle.mjs"; [ ! -f "$CLI" ] && CLI="${CLAUDE_PLUGIN_ROOT}/build/cli.js"; node "$CLI" doctor
   ```
   Re-display results verbatim with the same `[OK]`/`[FAIL]`/`[WARN]` prefixes.
