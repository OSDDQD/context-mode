/**
 * adapters/client-map — MCP clientInfo.name → PlatformId mapping.
 *
 * Source: Apify MCP Client Capabilities Registry
 * https://github.com/apify/mcp-client-capabilities
 *
 * Only includes platforms we have adapters for. Codex announces itself under
 * two names depending on how it was built — `Codex` from the CLI, and
 * `codex-mcp-client` from the MCP client wrapper — and both must resolve, or a
 * Codex session drops to the env-var tier and is detected by CODEX_THREAD_ID
 * instead of by the handshake it already sent.
 *
 * This tier answers before any env var is read: a host that says who it is
 * should be believed over a directory that happens to exist on disk.
 *
 * Why three entries still get their own module. `detect.ts` imports
 * `./types.js` with `import type` — erased at compile — and `./client-map.js`
 * as a value. Folding the map into `types.ts` would turn that type-only edge
 * into a real one and pull `resolveHookRuntime` (and with it all of
 * `src/runtime.ts`, which probes the filesystem and spawns version checks)
 * into the graph of every importer of `detect.ts` — including
 * `src/util/claude-config.ts`, whose static import is documented as safe
 * precisely because detect reaches only `node:` builtins, a type-only
 * `types.js`, and this file. The module is small because the protocol fact it
 * records is small, not because it is a fragment of something larger.
 */

import type { PlatformId } from "./types.js";

export const CLIENT_NAME_TO_PLATFORM: Record<string, PlatformId> = {
  "claude-code": "claude-code",
  "Codex": "codex",
  "codex-mcp-client": "codex",
};
