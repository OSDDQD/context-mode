/**
 * Platform-aware MCP tool naming.
 *
 * A tool name is not cosmetic: it is what the agent has to type. Guidance that
 * names `ctx_find` on a host whose wire name is
 * `mcp__plugin_context-mode_context-mode__ctx_find` is guidance the agent
 * cannot act on, so every message built in these hooks goes through a namer
 * bound to the running host.
 *
 * | Platform    | Pattern                                       |
 * |-------------|-----------------------------------------------|
 * | Claude Code | mcp__plugin_context-mode_context-mode__<tool>  |
 */

const TOOL_PREFIXES = {
  "claude-code": (tool) => `mcp__plugin_context-mode_context-mode__${tool}`,
};

/**
 * Get the platform-specific MCP tool name for a bare tool name.
 * Falls back to claude-code convention if platform is unknown.
 */
export function getToolName(platform, bareTool) {
  const fn = TOOL_PREFIXES[platform] || TOOL_PREFIXES["claude-code"];
  return fn(bareTool);
}

/**
 * Create a namer function bound to a specific platform.
 * Returns (bareTool) => platformSpecificToolName.
 */
export function createToolNamer(platform) {
  return (bareTool) => getToolName(platform, bareTool);
}

/** List of all known platform IDs. */
export const KNOWN_PLATFORMS = Object.keys(TOOL_PREFIXES);
