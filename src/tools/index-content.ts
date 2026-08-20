/**
 * `ctx_index` — put content into the FTS5 knowledge base without it passing
 * through the conversation.
 *
 * It moved for the ordinary reason: 200 lines the fork wrote (the directory
 * dispatch of #687, the root-symlink re-check of #442 round-3) that nothing
 * else in the server reads. Two seam fields, both of them security-relevant and
 * both already used the same way by `ctx_execute_file`: the deny-glob gate and
 * the project-relative path resolver. Neither could be re-implemented here —
 * they read the host's own Read deny policy and the env cascade that decides
 * what "the project" is, and a second opinion on either is a hole.
 */

import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { z } from "zod";

import { evaluateFilePath, readToolDenyPatterns } from "../security.js";
import type { IndexToolDeps } from "./shared/deps.js";

/** Register `ctx_index` on the server carried by `deps`. */
export function registerCtxIndex(deps: IndexToolDeps): void {
  const {
    getStore, getProjectDir, trackResponse, trackIndexed, currentAttribution,
    checkFilePathDenyPolicy, resolveProjectPath,
  } = deps;

  // ─────────────────────────────────────────────────────────
  // Tool: index
  // ─────────────────────────────────────────────────────────

  deps.server.registerTool(
    "ctx_index",
    {
      title: "Index Content",
      // #846: writes content into the local FTS5 store (additive, not destructive;
      // re-indexing the same content adds rows, so not idempotent). No network.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      description: `Store content in a searchable knowledge base (BM25 over FTS5). Splits markdown by headings, keeps code blocks intact, and persists the raw chunks. The full content stays in storage — retrieve any section on-demand via ctx_search; nothing is summarized or truncated.

  WHEN:
    - Documentation from Context7, Skills, or MCP tools (API docs, framework guides, code examples)
    - API references (endpoint details, parameter specs, response schemas)
    - MCP tools/list output (exact tool signatures and descriptions)
    - Skill prompts and instructions that are too large to keep verbatim in conversation
    - README files, migration guides, changelog entries
    - Any content with code examples you may need to reference precisely later

  WHEN NOT:
    - Log files, test output, CSV, or build output — use ctx_execute_file, which processes in-sandbox without persisting bytes
    - Single-use ephemeral content you will not query later — keep it inline if it fits, or ctx_execute_file it

  RETURNS:
    Indexing metadata: chunk counts (total, code-bearing), source label, and the exact ctx_search call shape to query the indexed content. Raw content is NOT echoed back — it lives in storage, retrievable via ctx_search(source: "<label>"). When \`path\` is provided, a content hash is stored so ctx_search results auto-flag staleness on future calls.

  EXAMPLE: ctx_index(content: "# React useEffect\\n\\nThe Effect Hook lets you ...", source: "react-useeffect-docs")
  EXAMPLE: ctx_index(path: "/path/to/large-spec.md", source: "openapi-v2-spec")`,
      inputSchema: z.object({
        content: z
          .string()
          .optional()
          .describe(
            "Raw text/markdown to index. Provide this OR path, not both.",
          ),
        path: z
          .string()
          .optional()
          .describe(
            "File OR directory path to read and index (content never enters context). Provide this OR content. Directory paths trigger a bounded recursive walk (#687).",
          ),
        source: z
          .string()
          .optional()
          .describe(
            "Label for the indexed content (e.g., 'Context7: React useEffect', 'Skill: frontend-design')",
          ),
        include: z.array(z.string()).optional().describe(
          "Directory-only: glob patterns to include (default: all matching extensions).",
        ),
        exclude: z.array(z.string()).optional().describe(
          "Directory-only: glob patterns to exclude. Merged with defaults (node_modules, .git, dist, build, .next, coverage, .venv, __pycache__, .DS_Store).",
        ),
        maxDepth: z.number().int().min(0).optional().describe(
          "Directory-only: max recursion depth from root (default: 5).",
        ),
        maxFiles: z.number().int().min(1).optional().describe(
          "Directory-only: hard cap on files indexed (default: 200) — FTS5 blow-up guard.",
        ),
        extensions: z.array(z.string()).optional().describe(
          "Directory-only: allowed file extensions (default: .md .mdx .txt .json .yaml .yml .ts .tsx .js .jsx .py .rs .go .sh).",
        ),
        respectGitignore: z.boolean().optional().describe(
          "Directory-only: apply nearest .gitignore (default: true).",
        ),
        followSymlinks: z.boolean().optional().describe(
          "Directory-only: follow directory symlinks (default: false — cycle hazard + escape risk).",
        ),
      }),
    },
    async ({ content, path, source, include, exclude, maxDepth, maxFiles, extensions, respectGitignore, followSymlinks }) => {
      if (!content && !path) {
        return trackResponse("ctx_index", {
          content: [
            {
              type: "text" as const,
              text: "Error: Either content or path must be provided",
            },
          ],
          isError: true,
        });
      }

      // Apply Read deny-policy to prevent indexing sensitive files into the
      // FTS5 store, which would otherwise be queryable via ctx_search and
      // exfiltrate content into the model's context (issue #442). Mirrors the
      // check ctx_execute_file already performs.
      if (path) {
        const pathDenied = checkFilePathDenyPolicy(path, "ctx_index");
        if (pathDenied) return pathDenied;
      }

      try {
        const resolvedPath = path ? resolveProjectPath(path) : undefined;

        // Directory dispatch (#687, reported by @matiasduartee). When the
        // resolved path is a directory, walk it bounded and re-enter `index()`
        // per-file so the security gate at store.ts:845 (TOCTOU defense from
        // #442 round-3) keeps running for every file.
        //
        // Root-level symlink defense: the deny-glob check above ran on the
        // user-supplied `path`. If `path` is a symlink whose target lands in
        // a sensitive directory (e.g. `/tmp/link -> /etc`), statSync would
        // happily report directory and walkDirectoryDetailed would
        // realpathSync internally, walking /etc with the user's deny globs
        // bound to /tmp/link instead of the real target. Detect the symlink
        // with lstatSync, follow it once, and re-apply the deny check
        // against the realpath so the user's deny globs see the actual
        // walk root.
        if (resolvedPath && existsSync(resolvedPath)) {
          const lst = lstatSync(resolvedPath);
          if (lst.isSymbolicLink()) {
            let realTarget: string;
            try {
              realTarget = realpathSync(resolvedPath);
            } catch {
              return trackResponse("ctx_index", {
                content: [{ type: "text" as const, text: "Error: symlink target could not be resolved." }],
              });
            }
            if (realTarget !== resolvedPath) {
              const realDenied = checkFilePathDenyPolicy(realTarget, "ctx_index");
              if (realDenied) return realDenied;
            }
          }
        }
        if (resolvedPath && existsSync(resolvedPath) && statSync(resolvedPath).isDirectory()) {
          const store = getStore();
          const projectDir = getProjectDir();
          const denyGlobs = readToolDenyPatterns("Read", projectDir);
          const isWin32 = process.platform === "win32";
          const perFileDeny = (absPath: string): boolean => {
            try {
              return evaluateFilePath(absPath, denyGlobs, isWin32, projectDir).denied;
            } catch {
              return false; // fail-open consistent with checkFilePathDenyPolicy
            }
          };
          const dirResult = store.indexDirectory({
            path: resolvedPath,
            source: source ?? resolvedPath,
            attribution: currentAttribution(),
            perFileDeny,
            include,
            exclude,
            maxDepth,
            maxFiles,
            extensions,
            respectGitignore,
            followSymlinks,
          });
          const capNote = dirResult.capped
            ? ` (cap reached — only first ${dirResult.filesIndexed} of ${dirResult.totalSeen}+ files; raise maxFiles to index more)`
            : "";
          const denyNote = dirResult.denied > 0
            ? ` (${dirResult.denied} file${dirResult.denied === 1 ? "" : "s"} blocked by Read deny policy)`
            : "";
          const failNote = dirResult.failed > 0
            ? ` (${dirResult.failed} file${dirResult.failed === 1 ? "" : "s"} failed to read)`
            : "";
          return trackResponse("ctx_index", {
            content: [
              {
                type: "text" as const,
                text: `Indexed ${dirResult.filesIndexed} file${dirResult.filesIndexed === 1 ? "" : "s"} (${dirResult.totalChunks} sections) from directory: ${dirResult.label}${capNote}${denyNote}${failNote}\nUse ctx_search(queries: ["..."]) to query this content.`,
              },
            ],
          });
        }

        // Track the raw bytes being indexed (content or file)
        if (content) trackIndexed(Buffer.byteLength(content));
        else if (resolvedPath) {
          try {
            const fs = await import("fs");
            trackIndexed(fs.readFileSync(resolvedPath).byteLength);
          } catch { /* ignore — file read errors handled by store */ }
        }
        const store = getStore();
        const result = store.index({ content, path: resolvedPath, source: source ?? resolvedPath, attribution: currentAttribution() });

        return trackResponse("ctx_index", {
          content: [
            {
              type: "text" as const,
              text: `Indexed ${result.totalChunks} sections (${result.codeChunks} with code) from: ${result.label}\nUse ctx_search(queries: ["..."]) to query this content. Use source: "${result.label}" to scope results.`,
            },
          ],
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return trackResponse("ctx_index", {
          content: [
            { type: "text" as const, text: `Index error: ${message}` },
          ],
          isError: true,
        });
      }
    },
  );
}
