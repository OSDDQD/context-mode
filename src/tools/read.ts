/**
 * ctx_read — the argument-free read path.
 *
 * Measured, not assumed (BENCHMARK.md Part 4): `ctx_execute_file` costs 26 ms
 * warm against `Read`'s 0.2 ms and returns 529 B where `Read` returns 34 KB.
 * Twenty-six milliseconds is invisible inside a model turn, so latency is not
 * why a model reaches for `Read` instead. What it reaches past is the `code`
 * argument: `ctx_execute_file` asks for a program to be composed before the
 * question can be asked at all, and `Read` asks for a path. One argument
 * against one is a comparison `Read` wins every time, whatever the routing
 * rules say.
 *
 * So this tool is `ctx_execute_file` with the program supplied. `path` is the
 * only required argument; `intent` narrows what comes back. There is no second
 * execution path — the handler builds a default program and hands it to the
 * very same `ctx_execute_file` handler, which is why the latency numbers
 * measured for that tool still describe this one.
 *
 * What comes back is a slice, never the file: a header, the file's structure
 * (declarations, headings, top-level keys — whichever the file has), and, when
 * `intent` is given, the regions that match it with a little context. Not the
 * first N lines, which is the one shape that looks like a slice and answers
 * nothing.
 *
 * On the word `intent`: `ctx_execute_file` already has a parameter of that
 * name and it means something else there — a hint applied to the *output*,
 * auto-indexing large stdout into FTS5 so only matching sections come back.
 * Here `intent` selects what the default program extracts from the *input*.
 * The two never meet: this handler passes no `intent` down, so the underlying
 * call keeps its own semantics untouched and the slice is returned whole.
 *
 * ## Re-reading the same unchanged file
 *
 * The second identical call costs exactly as much conversation memory as the
 * first and carries no new information, and in a long session that repetition
 * is one of the largest single expenses there is. So a repeat of the same call
 * on a file the fs-bus watcher has been covering since the first one returns a
 * one-line "unchanged" notice instead of the slice.
 *
 * Two conditions, both required. The fs-bus cache must answer `unchanged` —
 * never `unknown`, which is what it says whenever the watcher was not live or
 * an event may have been missed, and which therefore falls through to a real
 * read. And the *call* must be the same call: the cache key carries a hash of
 * the generated program, so a different `intent` — or any future argument that
 * changes what the program prints — is a different key that has never been
 * delivered and cannot be short-circuited by the one that was.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

import { checkRead, isReadCacheEnabled, recordRead } from "../fs-bus/index.js";
import type { ToolDeps, ToolResult } from "./shared/deps.js";

/** Arguments the underlying `ctx_execute_file` handler accepts. */
export interface ExecuteFileArgs {
  path: string;
  language: "javascript";
  code: string;
  timeout?: number;
  /** Deliberately never set by ctx_read — see the module docblock. */
  intent?: string;
  /** Attribution for stats and for the security messages the handler emits. */
  toolName?: string;
}

/**
 * What `ctx_read` needs on top of {@link ToolDeps}.
 *
 * One field, and it is the whole design: the actual `ctx_execute_file` handler,
 * passed in rather than reimplemented. Anything else would be a second path
 * through the executor, and a second path is exactly what makes a benchmark
 * stop describing production.
 */
export interface ReadToolDeps extends ToolDeps {
  runExecuteFile: (args: ExecuteFileArgs) => Promise<ToolResult>;
}

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text" as const, text }], isError };
}

/**
 * Refuse rather than read, above this size.
 *
 * `ctx_execute_file` reads the whole file into a string before any program
 * runs, so a multi-hundred-megabyte file is a V8 string-length failure with a
 * stack trace, not an answer. A stated limit and a pointer to the tool that
 * can stream is more useful than either the crash or a ten-second wait.
 */
export const READ_MAX_BYTES = 16 * 1024 * 1024;

/** Characters of slice returned before it is clipped. */
const SLICE_BUDGET = 6000;

/**
 * Terms that a one-word intent almost always means more broadly.
 *
 * Kept deliberately small. This is not a synonym engine and does not pretend
 * to be one: it covers the handful of intents that would otherwise match no
 * literal token at all ("errors" never appears in the code that throws them).
 * Everything else is matched literally, which is also what the tool
 * description promises.
 */
const INTENT_ALIASES: Record<string, string[]> = {
  export: ["export", "exports", "module.exports", "public"],
  exports: ["export", "exports", "module.exports", "public"],
  error: ["error", "catch", "throw", "reject", "err", "exception", "fail"],
  errors: ["error", "catch", "throw", "reject", "err", "exception", "fail"],
  test: ["test", "it(", "describe", "expect", "assert"],
  tests: ["test", "it(", "describe", "expect", "assert"],
  import: ["import", "require", "from"],
  imports: ["import", "require", "from"],
  config: ["config", "options", "settings", "env", "process.env"],
  api: ["api", "endpoint", "route", "handler", "request", "response"],
  type: ["type", "interface", "enum", "schema"],
  types: ["type", "interface", "enum", "schema"],
};

/** Split an intent into the literal terms the default program will look for. */
export function intentTerms(intent: string | undefined): string[] {
  if (!intent) return [];
  const words = intent
    .toLowerCase()
    .split(/[^a-z0-9_.$]+/i)
    .filter((w) => w.length >= 3);
  const terms = new Set<string>();
  for (const word of words) {
    for (const alias of INTENT_ALIASES[word] ?? [word]) terms.add(alias);
  }
  return [...terms];
}

/**
 * The program `ctx_read` runs in place of one the caller would have written.
 *
 * Plain CommonJS JavaScript, because that is what `ctx_execute_file` wraps for
 * `language: "javascript"`: it defines `FILE_CONTENT` and `FILE_CONTENT_PATH`
 * ahead of this source and runs the result in a subprocess. Written without
 * backticks so the TypeScript template literal holding it needs no escaping.
 */
export function buildDefaultProgram(intent: string | undefined): string {
  const terms = JSON.stringify(intentTerms(intent));
  const label = JSON.stringify(intent?.trim() ?? "");
  return `
const TERMS = ${terms};
const INTENT = ${label};
const BUDGET = ${SLICE_BUDGET};
const out = [];
const say = (s) => out.push(s);

function finish() {
  let text = out.join("\\n");
  if (text.length > BUDGET) {
    text = text.slice(0, BUDGET) + "\\n… slice clipped at " + BUDGET + " characters. " +
      "Narrow it with a more specific intent, or use ctx_execute_file for a different cut.";
  }
  console.log(text);
}

try {
  const path = FILE_CONTENT_PATH;
  const raw = FILE_CONTENT;
  // Byte count comes from the content already in hand rather than statSync,
  // so this program needs no module import at all. Requiring a builtin here
  // would be legal — the sandbox runs it as CommonJS — but this text is
  // embedded verbatim in the bundle, where the guard in
  // scripts/assert-bundle.mjs cannot tell generated program text from a bare
  // require in the bundle itself, which esbuild ESM output genuinely cannot
  // resolve (#511). Buffer.byteLength is the more honest number besides: it
  // measures what was read, so it cannot disagree with the slice reported.
  const bytes = Buffer.byteLength(raw, "utf8");

  // Binary guard. readFileSync(…, "utf-8") does not throw on binary input, it
  // substitutes replacement characters — so the check is on the result, and it
  // runs before anything tries to read structure out of noise.
  const replacements = (raw.match(/\\uFFFD/g) || []).length;
  if (raw.indexOf("\\u0000") >= 0 || replacements > raw.length * 0.01) {
    say(path);
    say(bytes + " bytes, not text (binary or non-UTF-8) — no slice available.");
    say("Use ctx_execute_file with code that reads it as a Buffer if you need its bytes.");
    finish();
  } else {
    const lines = raw.split("\\n");
    // A file ending in a newline splits into a trailing empty element. Counting
    // it would report one line more than any editor shows and one CSV row more
    // than the file has.
    const lineCount = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    const ext = ((path.match(/\\.([A-Za-z0-9]+)$/) || ["", ""])[1] || "").toLowerCase();
    say(path);
    say(lineCount + " lines, " + bytes + " bytes" + (INTENT ? ', intent "' + INTENT + '"' : ""));
    say("");

    // ── structure ────────────────────────────────────────
    const CODE_EXT = ["ts","tsx","js","jsx","mjs","cjs","py","go","rs","rb","php","java","c","h","cc","cpp","hpp","cs","swift","kt","scala","sh","bash"];
    const DECL = [
      /^\\s*export\\s+(?:default\\s+)?(?:async\\s+)?(?:abstract\\s+)?(?:function|class|interface|type|enum|const)\\s+([A-Za-z0-9_$]+)/,
      /^\\s*(?:async\\s+)?function\\s+([A-Za-z0-9_$]+)/,
      /^\\s*(?:abstract\\s+)?class\\s+([A-Za-z0-9_$]+)/,
      /^\\s*def\\s+([A-Za-z0-9_]+)/,
      /^\\s*func\\s+(?:\\([^)]*\\)\\s*)?([A-Za-z0-9_]+)/,
      /^\\s*(?:pub\\s+)?(?:async\\s+)?fn\\s+([A-Za-z0-9_]+)/,
      /^\\s*(?:public|private|protected|internal)\\s+[A-Za-z0-9_<>\\[\\], ]+\\s+([A-Za-z0-9_]+)\\s*\\(/,
      /^\\s*([A-Za-z0-9_]+)\\s*\\(\\)\\s*\\{\\s*$/,
    ];
    const structure = [];
    if (ext === "md" || ext === "markdown") {
      lines.forEach((l, i) => { if (/^#{1,6}\\s+\\S/.test(l)) structure.push((i + 1) + ": " + l.trim()); });
    } else if (ext === "json") {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          for (const k of Object.keys(parsed)) {
            const v = parsed[k];
            const shape = Array.isArray(v) ? "array[" + v.length + "]"
              : v === null ? "null"
              : typeof v === "object" ? "object{" + Object.keys(v).length + "}"
              : typeof v;
            structure.push(k + ": " + shape);
          }
        }
      } catch (e) { structure.push("(not valid JSON: " + e.message + ")"); }
    } else if (ext === "csv" || ext === "tsv") {
      const sep = ext === "tsv" ? "\\t" : ",";
      structure.push("columns: " + (lines[0] || "").split(sep).length);
      structure.push("header: " + (lines[0] || "").slice(0, 200));
      structure.push("rows: " + Math.max(0, lineCount - 1));
    } else if (CODE_EXT.indexOf(ext) >= 0) {
      lines.forEach((l, i) => {
        for (const re of DECL) {
          const m = re.exec(l);
          if (m) { structure.push((i + 1) + ": " + l.trim().slice(0, 120)); return; }
        }
      });
    }
    if (structure.length > 0) {
      say("STRUCTURE (" + structure.length + "):");
      for (const s of structure.slice(0, 120)) say("  " + s);
      if (structure.length > 120) say("  … " + (structure.length - 120) + " more");
      say("");
    } else {
      // No declarations to show — describe the shape instead of showing bytes.
      const widths = lines.map((l) => l.length);
      const longest = widths.length ? Math.max.apply(null, widths) : 0;
      const blank = lines.filter((l) => l.trim() === "").length;
      say("SHAPE: no declarations found; longest line " + longest +
        " chars, " + blank + " blank lines.");
      say("");
    }

    // ── intent-matched regions ───────────────────────────
    if (TERMS.length === 0) {
      say("No intent given — this is the structural slice. Pass intent to get the " +
        "regions that answer a specific question about this file.");
    } else {
      const scored = lines.map((l, i) => {
        const low = l.toLowerCase();
        let score = 0;
        for (const t of TERMS) if (low.indexOf(t) >= 0) score++;
        return { i: i, score: score };
      }).filter((r) => r.score > 0);

      if (scored.length === 0) {
        say("MATCHES: none of " + JSON.stringify(TERMS) + " appear in this file.");
      } else {
        // Group neighbouring hits so the answer is regions, not scattered lines.
        const regions = [];
        for (const hit of scored) {
          const last = regions[regions.length - 1];
          if (last && hit.i - last.end <= 4) {
            last.end = hit.i;
            last.score += hit.score;
          } else {
            regions.push({ start: hit.i, end: hit.i, score: hit.score });
          }
        }
        regions.sort((a, b) => b.score - a.score);
        const shown = regions.slice(0, 6).sort((a, b) => a.start - b.start);
        say("MATCHES (" + regions.length + " regions, showing " + shown.length + "):");
        for (const r of shown) {
          const from = Math.max(0, r.start - 2);
          const to = Math.min(lines.length - 1, r.end + 2);
          say("");
          for (let i = from; i <= to; i++) {
            say("  " + (i + 1) + ": " + lines[i].slice(0, 200));
          }
        }
      }
    }
    finish();
  }
} catch (err) {
  console.log("ctx_read default program failed: " + (err && err.message ? err.message : String(err)));
}
`.trim();
}

/**
 * What one delivered slice was, so a repeat of it can be recognised.
 *
 * `hash` is the content hash handed to the fs-bus cache; carrying it back as
 * `sinceHash` is what stops one variant's record from answering for another,
 * and what stops a record written by some other reader of the same path from
 * being mistaken for this tool's own delivery.
 */
interface DeliveredSlice {
  hash: string;
  lines: number;
  bytes: number;
}

/**
 * Delivered slices remembered per handler.
 *
 * Small on purpose: the fs-bus cache already bounds what it tracks, and this
 * map only has to cover the paths a session keeps coming back to. Insertion
 * order is the LRU order — a hit deletes and re-sets the key.
 */
const DELIVERED_SLICES_MAX = 256;

/**
 * Identity of one *call*, not one file.
 *
 * The program text is hashed into the key rather than the raw `intent`,
 * because the program is what determines the output: any argument that ever
 * starts changing it — a line range, a different cut, a new alias table —
 * changes this key without anybody having to remember to add it here. Getting
 * that wrong would answer "unchanged" to a call that asked a different
 * question and never saw the answer.
 */
function sliceKey(absolute: string, program: string): string {
  return `${absolute}\u0000${createHash("sha1").update(program).digest("hex").slice(0, 16)}`;
}

/** Short content digest. Opaque to the cache, which only compares it. */
function contentHash(bytes: Buffer): string {
  return createHash("sha1").update(bytes).digest("hex").slice(0, 12);
}

/**
 * Lines the way the default program counts them: a trailing newline does not
 * open a line. Reporting a different number in the short-circuit than the
 * first read printed would look like the file had changed.
 */
function countLines(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  let newlines = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a) newlines++;
  return bytes[bytes.length - 1] === 0x0a ? newlines : newlines + 1;
}

/** Register `ctx_read` on the server carried by `deps`. */
export function registerCtxRead(deps: ReadToolDeps): void {
  const { getProjectDir, trackResponse, runExecuteFile } = deps;
  const delivered = new Map<string, DeliveredSlice>();

  function remember(key: string, slice: DeliveredSlice): void {
    delivered.delete(key);
    delivered.set(key, slice);
    while (delivered.size > DELIVERED_SLICES_MAX) {
      const oldest = delivered.keys().next();
      if (oldest.done) break;
      delivered.delete(oldest.value);
    }
  }

  deps.server.registerTool(
    "ctx_read",
    {
      title: "Read a file as a slice (executes a default program, reads the given path)",
      // Read-only, on the same reasoning that lets ctx_gather claim it (#1048):
      // the program is ours and fixed, so unlike ctx_execute_file there is no
      // caller-supplied code that could write. It reads the named file, stats
      // it, and prints — which is what makes it callable from plan mode, where
      // the argument-free read path is most wanted and Read is the only
      // alternative.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description: `Answer a question about one file without pulling the file into your conversation. One required argument, path. This is ctx_execute_file with the program already written, so no code has to be composed to ask.

What comes back is a slice, not the file: its size and shape, its structure (declarations for code, headings for markdown, top-level keys for JSON, header and row count for CSV), and, when intent is given, the regions matching that intent with a couple of lines of context around each. The file bytes stay in the subprocess.

WHEN:
  - Instead of Read, when you want to KNOW something about a file rather than SEE all of it, and you do not want to write a program to find out
  - The file is large enough that Read would spend conversation memory you need for the actual work
  - You have a specific question about it — pass intent, such as "exports", "error handling", "where the timeout is set"
  - You want a file's structure before deciding whether to open it at all
WHEN NOT:
  - You intend to EDIT the file — use Read, because Edit matches against the exact bytes in your conversation and a slice cannot be matched against
  - You need the file verbatim, all of it, because you are going to reproduce or review every line — Read is the honest call
  - You need a derivation this program does not perform (aggregate, parse, transform) — ctx_execute_file takes the code to do it
  - You do not know which file yet — ctx_find takes the question and returns the path
RETURNS:
  A header naming the file with its line and byte count, a STRUCTURE block, and a MATCHES block of intent-matching regions with line numbers. Clipped with a marker if the slice would exceed 6000 characters. Files over 16 MB and non-UTF-8 files are reported as such rather than read.
  Repeating the same call on a file that has not changed since returns one "unchanged since your last read" line instead of the slice again; pass refresh: true for the slice itself.
EXAMPLE: ctx_read(path: "src/adapters/detect.ts")
EXAMPLE: ctx_read(path: "src/adapters/detect.ts", intent: "exports")
EXAMPLE: ctx_read(path: "server.log", intent: "timeout errors")`,
      inputSchema: z.object({
        path: z
          .string()
          .describe("Absolute file path or relative to project root."),
        intent: z
          .string()
          .optional()
          .describe(
            "What you need from this file, in plain words — the slice is selected to match it. " +
            "Terms are matched literally against the file's text. Omit it for the structural slice. " +
            "Unlike ctx_execute_file's intent, which searches the OUTPUT, this one selects the INPUT.",
          ),
        timeout: z
          .coerce.number()
          .optional()
          .describe("Max execution time in ms. When omitted, the MCP host's RPC timeout governs."),
        refresh: z
          .boolean()
          .optional()
          .describe(
            "Read again even if the same call already returned this file unchanged. " +
            "Use it when you need the slice itself back, not the fact that it did not change.",
          ),
      }),
    },
    async (params) => {
      const p = params as {
        path?: unknown;
        intent?: unknown;
        timeout?: unknown;
        refresh?: unknown;
      };
      const rawPath = typeof p.path === "string" ? p.path.trim() : "";
      if (!rawPath) {
        return trackResponse("ctx_read", textResult("Error: `path` is required.", true));
      }

      // Taken before the file is opened, by anyone: everything between this
      // instant and the byte the subprocess got is a window in which a write
      // could have landed. `recordRead` compares this against the watcher's
      // invalidation stamp and marks the entry dirty when the write won, which
      // is the only thing keeping the "hash after the read" order below safe.
      const readAt = Date.now();

      // Fail on the path before spending a subprocess on it. The underlying
      // handler would surface an ENOENT from inside the sandbox as a runtime
      // error with a stack trace; a caller who mistyped a path deserves to be
      // told that, in one line, in the words they used.
      const absolute = isAbsolute(rawPath) ? rawPath : resolve(getProjectDir(), rawPath);
      let size: number;
      try {
        const stat = statSync(absolute);
        if (stat.isDirectory()) {
          return trackResponse(
            "ctx_read",
            textResult(
              `Error: ${rawPath} is a directory, not a file. ` +
                "Use ctx_find to locate a file inside it, or ctx_index to index the tree.",
              true,
            ),
          );
        }
        size = stat.size;
      } catch {
        return trackResponse(
          "ctx_read",
          textResult(`Error: no such file: ${rawPath} (resolved to ${absolute})`, true),
        );
      }

      if (size > READ_MAX_BYTES) {
        return trackResponse(
          "ctx_read",
          textResult(
            `Error: ${rawPath} is ${size} bytes, over the ${READ_MAX_BYTES}-byte ctx_read limit. ` +
              "The whole file is loaded before the slice is taken, so a file this size would cost " +
              "more than the answer is worth. Use ctx_execute_file with code that streams it, or " +
              "ctx_find/ctx_search if the question is really about locating something.",
            true,
          ),
        );
      }

      const intent = typeof p.intent === "string" ? p.intent : undefined;
      const timeout = typeof p.timeout === "number" ? p.timeout : undefined;
      const refresh = p.refresh === true;

      const program = buildDefaultProgram(intent);
      const cacheOn = isReadCacheEnabled();
      const key = sliceKey(absolute, program);

      // Short-circuit only on a definite `unchanged`. `unknown` — no watcher,
      // watcher restarted, cache switched off — means nobody can promise the
      // bytes are still there, and handing back a stale slice on a maybe is
      // strictly worse than paying for the read again.
      if (cacheOn && !refresh) {
        const prior = delivered.get(key);
        if (prior) {
          const answer = checkRead(absolute, { sinceHash: prior.hash });
          if (answer.state === "unchanged") {
            remember(key, prior);
            return trackResponse(
              "ctx_read",
              textResult(
                `${absolute}\n` +
                  `unchanged since your last read (hash ${prior.hash}, ${prior.lines} lines, ` +
                  `${prior.bytes} bytes)${intent ? `, intent "${intent}"` : ""} — the same slice ` +
                  "is withheld rather than spent twice. Pass refresh: true to read it anyway.",
              ),
            );
          }
        }
      }

      // The whole point: one call into the same handler ctx_execute_file
      // registers, with the program supplied instead of demanded. `intent` is
      // deliberately not forwarded — theirs indexes the output, ours selected
      // the input, and passing it on would silently swap one for the other.
      const result = await runExecuteFile({
        path: rawPath,
        language: "javascript",
        code: program,
        timeout,
        toolName: "ctx_read",
      });

      // Hash AFTER the call, never before. That handler owns the security
      // decisions — project boundary (#852), Read deny globs — and reading the
      // bytes here first would pull in a file it is about to refuse. An error
      // result is not a read: recording it would let the next call answer
      // "unchanged" for a slice the caller never received.
      if (cacheOn && result.isError !== true) {
        try {
          const bytes = readFileSync(absolute);
          const slice: DeliveredSlice = {
            hash: contentHash(bytes),
            lines: countLines(bytes),
            bytes: bytes.length,
          };
          recordRead({ path: absolute, hash: slice.hash, bytes: slice.bytes, readAt });
          remember(key, slice);
        } catch {
          // Vanished or unreadable between the run and here. Nothing to
          // remember, and the caller already has its slice — stay quiet.
        }
      }
      return result;
    },
  );
}
