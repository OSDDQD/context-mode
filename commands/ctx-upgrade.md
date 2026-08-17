---
description: Update context-mode — pull latest, rebuild, migrate cache, fix hooks
disable-model-invocation: true
---

Pull the latest context-mode release and reinstall the plugin.

1. Call the `ctx_upgrade` MCP tool directly. It returns a shell command to execute.
2. Run the returned command using Bash.
3. Display results as a markdown checklist:
   ```
   ## context-mode upgrade
   - [x] Pulled latest from GitHub
   - [x] Built and installed v1.0.39
   - [x] Hooks configured
   - [x] Doctor: all checks PASS
   ```
   Use `[x]` for success, `[ ]` for failure. Show actual version numbers.
4. Tell the user to **restart their session** to pick up the new version.
5. **Fallback** (only if the MCP tool call fails): run with Bash:
   ```
   CLI="${CLAUDE_PLUGIN_ROOT}/cli.bundle.mjs"; [ ! -f "$CLI" ] && CLI="${CLAUDE_PLUGIN_ROOT}/build/cli.js"; node "$CLI" upgrade
   ```
