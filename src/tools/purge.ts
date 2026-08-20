/**
 * `ctx_purge` — the explicit, scoped wipe of everything this project indexed.
 *
 * It moved out of `src/server.ts` last among the destructive tools and it is
 * the one that pays for itself: 290 lines, three scopes, a deprecated
 * back-compat path and a schema whose shape is load-bearing (see the block
 * comment below on issue #563). None of that is upstream code the fork tracks,
 * and none of it is read by anything else in the server.
 *
 * The seam costs exactly one field. Everything the handler touches is either
 * on the base {@link ToolDeps} or importable sideways — `peekStore`/`setStore`
 * and `sessionStats` from `./shared/state.js`, `purgeSession` and
 * `hashProjectDirLegacy` from the session layer — except the path of the
 * persisted stats file, which `src/server.ts` still owns because two other
 * call sites there read it. So {@link PurgeToolDeps} carries `getStatsFilePath`
 * and nothing else: the injection is one function, not a widened contract.
 */

import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

import { hashProjectDirLegacy } from "../session/db.js";
import { purgeSession } from "../session/purge.js";
import type { PurgeToolDeps } from "./shared/deps.js";
import { peekStore, sessionStats, setStore } from "./shared/state.js";

/** Register `ctx_purge` on the server carried by `deps`. */
export function registerCtxPurge(deps: PurgeToolDeps): void {
  const {
    getStore, getStorePath, getProjectDir, getSessionDir, getStatsFilePath,
    trackResponse, coerceBoolean,
  } = deps;

  // ── ctx-purge: explicit knowledge base wipe ─────────────────────────────────
  //
  // Issue #520 — scoped purge.
  // The schema is ADDITIVE: bare {confirm:true} preserves the legacy
  // project-wide wipe verbatim (with a stderr deprecation warning so
  // future callers migrate to explicit scope). When sessionId is given,
  // only that session's rows + FTS5 chunks are removed; project-wide
  // files (events.md, FTS5 store file, stats file) are preserved.
  // Passing both sessionId AND scope:"project" is ambiguous (does the
  // caller want a per-session wipe or a project-wide one?) and is
  // rejected by an explicit check in the handler body — NOT a schema-level
  // .refine(). MCP SDK's normalizeObjectSchema() reads `.shape` to project
  // inputSchema → JSON Schema for tools/list; a ZodEffects (refine wrapper)
  // has no `.shape`, so the SDK silently emits `properties: {}`, and Claude
  // Code's strict-input-validation gate then rejects EVERY call to this
  // tool with "input_schema does not support fields". Issue #563.
  deps.server.registerTool(
    "ctx_purge",
    {
      title: "Purge Knowledge Base",
      // #846: permanently deletes indexed content — destructive. Purging an
      // already-purged scope has no further effect (idempotent). No network.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      description: `DESTRUCTIVE: permanently delete indexed content. Cannot be undone. Requires confirm:true and exactly one scope.

  WHEN:
    - User explicitly asks to drop one thing they indexed ('forget those docs', 'remove the react docs from the knowledge base')
    - User explicitly asks to clear a specific session ('purge this session', 'wipe this conversation')
    - User explicitly asks to reset the whole project ('reset everything', 'wipe the knowledge base')

  WHEN NOT:
    - User says 'reset', 'clear', or 'wipe' without naming a scope -> ask which scope before calling
    - User wants to free memory or improve performance -> recommend ctx_stats first, do not purge

  SCOPES (pass exactly one):
    - Per-source: ctx_purge(confirm: true, source: "<label>") deletes one indexed source's chunks from the knowledge base. Every other source, every session row and the stats file survive. The label has to match exactly; a partial or misspelled label is refused with the near matches named rather than guessed at.
    - Per-session: ctx_purge(confirm: true, sessionId: "<uuid>") deletes that session's events (auto-captured decisions, errors, plans, user prompts, rejected approaches, etc.) and per-session FTS5 chunks; sibling sessions and stats file are preserved.
    - Per-project: ctx_purge(confirm: true, scope: "project") wipes FTS5 knowledge base, every session DB row, events markdown, and resets the stats file. Use ctx_stats first to preview category counts before purging.

  CONTRACT:
    - confirm:true is required; confirm:false returns 'purge cancelled'.
    - sessionId and scope:'project' together return 'ambiguous - pick one'.
    - source combined with sessionId, or with any scope other than 'source', returns 'ambiguous - pick one'.
    - scope:'session' without sessionId throws (sessionId required).
    - scope:'source' without source returns an error naming the missing label.
    - A label matching no indexed source returns an error, not a success: nothing was deleted and the response says so.
    - Bare {confirm:true} is deprecated: maps to scope:'project' with a stderr warning; will hard-error in a future major.

  RETURNS:
    A summary of removed rows + the resolved scope.

  EXAMPLE: ctx_purge(confirm: true, source: "react-docs")
  EXAMPLE: ctx_purge(confirm: true, sessionId: "7c8a-1234-5678-9abc-def012345678")
  EXAMPLE: ctx_purge(confirm: true, scope: "project")`,
      // NOTE: schema MUST be a plain z.object — no .refine()/.transform()/
      // .superRefine() wrapper. See block comment above & issue #563. The
      // cross-field ambiguity check lives in the handler body below.
      inputSchema: z.object({
        // confirm: wrapped in coerceBoolean preprocessor — OpenCode's native
        // plugin bridge can deliver `confirm:"true"` / `confirm:"false"` as
        // string literals. Without this, v1.0.139's inputSchema.parse() path
        // rejects valid intent as "Expected boolean, received string" (#627).
        confirm: z.preprocess(coerceBoolean, z.boolean()).describe(
          "MUST be true. Destructive operation; false returns 'purge cancelled'."
        ),
        sessionId: z.string().optional().describe(
          "UUID of a single session. Pairs with confirm:true to wipe only that " +
          "session's events + per-session FTS5 chunks. Sibling sessions and the " +
          "stats file are preserved. MUST NOT be combined with scope:'project'."
        ),
        source: z.string().optional().describe(
          "Label of ONE indexed source. Pairs with confirm:true to delete that " +
          "source's chunks and nothing else — every other source, every session " +
          "row and the stats file are preserved. The label must match exactly, " +
          "as printed by ctx_stats or returned when the content was indexed; a " +
          "label matching no source is reported as an error, never as a success. " +
          "MUST NOT be combined with sessionId or with a wider scope."
        ),
        scope: z.enum(["session", "project", "source"]).optional().describe(
          "Explicit scope selector. 'session' REQUIRES sessionId, 'source' REQUIRES " +
          "source. 'project' wipes the entire project (FTS5 + every session + stats). " +
          "Omit only for the deprecated bare-{confirm:true} back-compat path."
        ),
      }),
    },
    async ({ confirm, sessionId, scope, source }) => {
      // Cross-field ambiguity check — formerly a schema .refine(), moved
      // into the handler so the inputSchema stays a plain ZodObject and
      // the MCP SDK can serialize `.shape` into JSON Schema (issue #563).
      // Same human-readable message as the original refine() preserved.
      if (sessionId && scope === "project") {
        return trackResponse("ctx_purge", {
          content: [{
            type: "text" as const,
            text:
              "Ambiguous purge: sessionId implies scope:'session', cannot combine with scope:'project'. " +
              "Use scope:'project' WITHOUT sessionId for the legacy whole-project wipe.",
          }],
          isError: true,
        });
      }
      // Same rule for the targeted scope. A label names one source; pairing it
      // with a session or the whole project asks for two different deletions,
      // and picking one of them for the caller is how a wipe happens by accident.
      if (source && (sessionId || (scope !== undefined && scope !== "source"))) {
        return trackResponse("ctx_purge", {
          content: [{
            type: "text" as const,
            text:
              "Ambiguous purge: source implies scope:'source', cannot combine with sessionId or a wider scope. " +
              "Pass source alone to delete one indexed source, or drop it for the session/project wipe.",
          }],
          isError: true,
        });
      }
      if (scope === "source" && !source) {
        return trackResponse("ctx_purge", {
          content: [{
            type: "text" as const,
            text:
              "scope:'source' needs the label of the source to delete. " +
              "Call ctx_purge(confirm: true, source: \"<label>\").",
          }],
          isError: true,
        });
      }
      if (!confirm) {
        return trackResponse("ctx_purge", {
          content: [{
            type: "text" as const,
            text: "Purge cancelled. Pass confirm: true to proceed.",
          }],
        });
      }

      // Effective scope resolution:
      //   - explicit scope wins
      //   - else "session" iff sessionId is given
      //   - else "source" iff source is given
      //   - else "project" (back-compat — emit deprecation warning so
      //     callers migrate to the explicit form before a future major).
      const effectiveScope: "session" | "project" | "source" =
        scope ?? (sessionId ? "session" : source ? "source" : "project");
      if (!scope && !sessionId && !source) {
        console.warn(
          "[context-mode] ctx_purge: bare {confirm:true} is deprecated. " +
          "Pass scope:'project' for the whole-project wipe, or scope:'session' + sessionId " +
          "for a scoped wipe. See issue #520."
        );
      }

      // Targeted delete — one source, by label, through the live store. This
      // returns before the file-level wipe below, so nothing is closed, no file
      // is unlinked, the stats are not reset, and the other scopes behave
      // exactly as they did before this branch existed.
      if (effectiveScope === "source") {
        const label = source as string;
        const store = getStore();
        const indexed = store.listSources();
        const exact = indexed.filter(s => s.label === label);

        if (exact.length === 0) {
          // Refusing beats reporting a no-op as a success. The `source` filter
          // on ctx_search matches partial labels, so a caller who learned the
          // label there will reasonably pass a substring here — and a cheerful
          // "purged" would read as "it is gone" while the source is still
          // indexed and still answering searches.
          const near = indexed
            .filter(s => s.label.includes(label) || label.includes(s.label))
            .map(s => s.label);
          const hint = near.length > 0
            ? ` Indexed labels containing it: ${near.slice(0, 10).join(", ")}${near.length > 10 ? `, +${near.length - 10} more` : ""}. Pass one of them exactly.`
            : ` ${indexed.length} source(s) are indexed; ctx_stats lists them.`;
          return trackResponse("ctx_purge", {
            content: [{
              type: "text" as const,
              text: `No indexed source is labelled "${label}". Nothing was deleted.${hint}`,
            }],
            isError: true,
          });
        }

        // `sources.label` carries no UNIQUE constraint, so one label can own
        // several rows (a legacy import, an interrupted re-index). deleteSource
        // removes one row per call, so loop until the label is gone and report
        // what actually went: deleting one row of three and calling it done is
        // the same silent success as deleting none.
        const chunkCount = exact.reduce((sum, s) => sum + s.chunkCount, 0);
        let removedRows = 0;
        for (let i = 0; i < exact.length; i++) {
          if (store.deleteSource(label) === 0) break;
          removedRows++;
        }

        if (removedRows < exact.length) {
          return trackResponse("ctx_purge", {
            content: [{
              type: "text" as const,
              text:
                `Partially purged source "${label}": ${removedRows} of ${exact.length} row(s) removed. ` +
                `The rest could not be deleted — re-run to finish, or use scope:'project' if the store is damaged.`,
            }],
            isError: true,
          });
        }

        const rowNote = exact.length > 1 ? ` across ${exact.length} rows sharing that label` : "";
        return trackResponse("ctx_purge", {
          content: [{
            type: "text" as const,
            text:
              `Purged source "${label}": ${chunkCount} section(s) removed${rowNote}. ` +
              `Every other indexed source, all session data and the stats file are untouched.`,
          }],
        });
      }

      // Close the persistent FTS5 content store handle BEFORE delegating to
      // purgeSession so the store's lock is released on Windows. The handle
      // is recreated lazily on the next getStore() call.
      let storePathForPurge: string | undefined;
      try {
        storePathForPurge = getStorePath();
      } catch { /* best effort — store path may be unresolvable on fresh install */ }
      const openStore = peekStore();
      if (openStore) {
        try { openStore.cleanup(); } catch { /* best effort */ }
        setStore(null);
      }

      // FTS5 store: pass contentDir so purgeSession sweeps BOTH canonical
      // and legacy raw-casing variants (dual-hash, mirrors session events).
      // storePath is also passed for the rare case where the resolver picked
      // an absolute path that differs from the dual-hash pair (e.g. caller
      // pre-migrated). Both paths are de-duped during unlink.
      const contentDir = storePathForPurge ? dirname(storePathForPurge) : undefined;
      const { deleted } = purgeSession({
        projectDir: getProjectDir(),
        sessionsDir: getSessionDir(),
        storePath: storePathForPurge,
        contentDir,
        legacyContentDir: join(homedir(), ".context-mode", "content"),
        // hashProjectDirLegacy mirrors the deployed (≤ v1.0.111) raw-casing
        // hash that named files under ~/.context-mode/content/. Using the
        // legacy hash here is correct: that pre-pre-legacy directory was
        // never migrated and still uses raw casing.
        contentHash: hashProjectDirLegacy(getProjectDir()),
        scope: effectiveScope,
        sessionId,
      });

      // Stats are PROJECT-scoped (one stats file per project, summing all
      // sessions). A scoped per-session purge MUST leave stats alone — they
      // still belong to other sessions in the same project. Stats reset
      // happens ONLY when scope === "project".
      if (effectiveScope === "project") {
        // Reset in-memory session stats
        sessionStats.calls = {};
        sessionStats.bytesReturned = {};
        sessionStats.bytesIndexed = 0;
        sessionStats.bytesSandboxed = 0;
        sessionStats.cacheHits = 0;
        sessionStats.cacheBytesSaved = 0;
        sessionStats.sessionStart = Date.now();
        deleted.push("session stats");

        // Also drop the persisted stats file so external readers see a fresh state
        try {
          const statsFile = getStatsFilePath();
          if (existsSync(statsFile)) unlinkSync(statsFile);
        } catch { /* best effort */ }
      }

      const message = effectiveScope === "session"
        ? `Purged session ${sessionId}: ${deleted.length ? deleted.join(", ") : "no matching rows"}. ` +
          `Other sessions and project-wide stats preserved.`
        : `Purged: ${deleted.join(", ")}. All session data for this project has been permanently deleted.`;
      return trackResponse("ctx_purge", {
        content: [{
          type: "text" as const,
          text: message,
        }],
      });
    },
  );
}
