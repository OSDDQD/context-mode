/**
 * adapters/data-root — the one storage-root override shared by every adapter.
 *
 * Issue #649 — `CONTEXT_MODE_DATA_DIR` universal storage override. Adapters had
 * storage hardcoded to `~/.<platform>/context-mode/sessions/` with no env-var
 * escape hatch. CI runners on NFS homes, dev containers, and shared-workspace
 * setups need to point context-mode storage at a writable volume without
 * patching source or abusing the host platform's own config-dir variable.
 *
 * The override applies only to context-mode-owned state (`getSessionDir`,
 * `getMemoryDir`) — never to platform-native config (`getConfigDir`,
 * `getSettingsPath`), which must stay where the host platform's own tooling
 * expects it. Use `CLAUDE_CONFIG_DIR` to move platform-native config; use
 * `CONTEXT_MODE_DATA_DIR` to move context-mode storage independently.
 *
 * This lives in its own module rather than on a shared base class: it was the
 * only thing the adapters ever actually shared. `BaseAdapter` used to carry it
 * plus default implementations built from a `sessionDirSegments` array, which
 * every adapter then overrode. A base class whose every method is overridden is
 * a file, not a contract; the contract is `HookAdapter` in `types.ts`, and the
 * adapter implements it directly.
 */

import { resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Returns the resolved absolute path when `CONTEXT_MODE_DATA_DIR` is set to a
 * non-blank value, otherwise `null` so callers fall back to their
 * platform-native default.
 *
 * Mirrors the `resolveClaudeConfigDir` contract for env-var handling
 * (whitespace guard, tilde expansion, relative-path resolution) so users get
 * one consistent set of rules across every override site.
 */
export function resolveContextModeDataRoot(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.CONTEXT_MODE_DATA_DIR;
  if (!raw || raw.trim() === "") return null;
  if (raw.startsWith("~")) {
    return resolve(homedir(), raw.replace(/^~[/\\]?/, ""));
  }
  return resolve(raw);
}
