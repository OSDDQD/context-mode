/**
 * `ctx_execute` and `ctx_execute_file` — the two sandbox entry points, plus the
 * output-handling helpers that only they use.
 *
 * They travel together because they are one mechanism seen twice: the same
 * echo, the same deny checks, the same four-way ladder over the result (timed
 * out / non-zero exit / intent-matched / too large to return). `intentSearch`
 * and `indexStdout` came along because nothing else in the server called them;
 * leaving them behind would have left `src/server.ts` holding two functions
 * whose only callers are in this file.
 *
 * `executeFileHandler` is returned rather than exported, and that is the point
 * of the return value: `ctx_read` (src/tools/read.ts) IS this call with a
 * default program supplied, and it receives the handler through
 * `ReadToolDeps.runExecuteFile`. Handing back the closure keeps that one live
 * function — with this module's `deps` already bound — instead of a second
 * route into the executor with a second set of security checks.
 *
 * What did NOT move: `buildExecuteEcho`, and the `checkProjectBoundary` /
 * `checkNonShellDenyPolicy` / `checkFilePathDenyPolicy` trio. The echo helpers
 * are shared with the batch tools and are upstream's code untouched by the
 * fork — the same reasoning that kept `truncateCommandForEcho` on
 * {@link BatchToolDeps}. The security checks read the host's own deny policy
 * and project root; a second implementation of either is a hole, not a
 * refactor.
 */

import { z } from "zod";

import { classifyNonZeroExit } from "../exit-classify.js";
import type { Language } from "../runtime.js";
import type { ExecuteToolDeps, ToolResult } from "./shared/deps.js";
import { sessionStats } from "./shared/state.js";

/**
 * Register `ctx_execute` and `ctx_execute_file`, and hand back the file handler.
 *
 * The return value is not a convenience: `src/server.ts` passes it straight into
 * `ReadToolDeps.runExecuteFile`, which is how `ctx_read` stays the same call
 * rather than a lookalike.
 */
export function registerCtxExecute(deps: ExecuteToolDeps): {
  executeFileHandler: (args: {
    path: string;
    language: Language;
    code: string;
    timeout?: number;
    intent?: string;
    toolName?: string;
    echoOverride?: string;
  }) => Promise<ToolResult>;
} {
  const {
    executor, getStore, trackResponse, trackIndexed, currentAttribution,
    checkDenyPolicy, checkNonShellDenyPolicy, checkProjectBoundary,
    checkFilePathDenyPolicy, buildExecuteEcho, coerceBoolean,
    langList, bunNote,
  } = deps;

  // ─────────────────────────────────────────────────────────
  // Tool: execute
  // ─────────────────────────────────────────────────────────

  deps.server.registerTool(
    "ctx_execute",
    {
      // #852: surface code execution in the host approval prompt's title (the
      // only server-controlled field the MCP permission UI renders besides args).
      title: "Run code in a separate process (executes the supplied code)",
      // #846: runs arbitrary code in a child process with full network access,
      // the project root as cwd, and the parent's filesystem permissions.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      description: `Run code in a separate subprocess.${bunNote} Languages: ${langList}.

  Think-in-Code — the core philosophy: the bytes your code processes never enter your conversation memory; only what you console.log() does. Reading a 700 KB log directly means 700 KB of your remaining reasoning capacity gets spent on raw bytes. Running code over that same log in the subprocess and printing a 3 KB summary leaves you with 697 KB of capacity for the actual work.

  Concrete shape — analyze 47 source files without reading any of them:
    ctx_execute(language: "javascript", code: \`
      const fs = require('fs');
      const files = fs.readdirSync('src').filter(f => f.endsWith('.ts'));
      files.forEach(f => {
        const lines = fs.readFileSync('src/'+f,'utf8').split('\\\\n').length;
        console.log(f + ': ' + lines + ' lines');
      });
    \`)
    // 47 files analyzed, 15,314 LoC summarized — output ~3.6 KB instead of 47 Read() calls = ~700 KB.

  WHEN:
    - You intend to derive an answer FROM data (filter, count, aggregate, parse, compare, transform) — do the derivation in code and print only the answer
    - Output shape or size cannot be predicted before execution (recursive finds, repo-wide greps, list endpoints, query results, log scans)
    - You would otherwise read raw output and then mentally compute — that compute belongs here, in code, where its inputs stay out of your conversation
    - You need to keep a long-running process alive (dev server, watcher, daemon) — pass \`background: true\` to detach on timeout instead of killing the process
    - The output may legitimately be large but you only want recall-by-topic later — pass an \`intent\` string; outputs over ~5KB are auto-indexed into the knowledge base and only the section titles + previews come back, retrievable via ctx_search

  WHEN NOT:
    - Single observational command whose entire short output you intend to consume verbatim (whoami, pwd, git status on a clean tree) — Bash is simpler
    - File mutations (Edit/Write) or navigation (cd/ls) — Bash is the right surface
    - You already know the output is one short fixed line and you want to read it as-is

  RETURNS:
    Only what your code prints. Wrap risky calls in try/catch — uncaught errors go to stderr and may leak more than intended. When \`intent\` is set and output exceeds the auto-index threshold, the response carries searchable section titles + previews instead of the raw stdout; use ctx_search(queries: [...]) to drill into specific sections.

  EXAMPLE: ctx_execute(language: "javascript", code: "const out = require('child_process').execSync('npm test', {encoding:'utf8', stdio:['ignore','pipe','pipe']}); console.log(out.split('\\\\n').filter(l => /(FAIL|✗|×|Error:|Tests +.*(failed|passed))/i.test(l)).slice(0, 60).join('\\\\n'))")
  EXAMPLE: ctx_execute(language: "javascript", code: "const out = require('child_process').execSync('gh issue list --json number,title --limit 100', {encoding:'utf8'}); const hooks = JSON.parse(out).filter(i => /hook|routing/i.test(i.title)); console.log(\`\${hooks.length} hook-related issues\`)")`,
      inputSchema: z.object({
        language: z
          .enum([
            "javascript",
            "typescript",
            "python",
            "shell",
            "ruby",
            "go",
            "rust",
            "php",
            "perl",
            "r",
            "elixir",
            "csharp",
          ])
          .describe("Runtime language"),
        code: z
          .string()
          .describe(
            "Source code to execute. Print the summary with console.log (JS/TS), print (Python/Ruby/Perl/R), echo (Shell/PHP), fmt.Println (Go), IO.puts (Elixir), Console.WriteLine (C#).",
          ),
        timeout: z
          .coerce.number()
          .optional()
          .describe("Max execution time in ms. When omitted, no server-side timer fires — the MCP host's RPC timeout governs. Set an explicit value for long-running builds (Gradle/Maven/SBT)."),
        // background: wrapped in coerceBoolean preprocessor so the literal
        // strings "true"/"false" arriving from OpenCode's native plugin
        // bridge (and several LLM providers' tool-call JSON) parse as the
        // boolean the handler expects. z.coerce.boolean() is unsafe here —
        // Boolean("false") is true. Fixes #627.
        background: z
          .preprocess(coerceBoolean, z.boolean())
          .optional()
          .default(false)
          .describe("Keep the process alive past the timeout (servers, daemons); partial output comes back and the process survives. A background script must stay alive until the timeout detaches it, so leave setTimeout and other self-close timers out of it. For server+fetch, put both in ONE ctx_execute call."),
        cwd: z
          .string()
          .optional()
          .describe("Working directory for shell commands. Non-shell languages still run from their sandbox temp directory."),
        intent: z
          .string()
          .optional()
          .describe(
            "What you're looking for in the output. Specific technical terms retrieve better than concepts. Example: 'failing tests', 'HTTP 500 errors'.",
          ),
      }),
    },
    async ({ language, code, timeout, background, cwd, intent }) => {
      // Security: deny-only firewall
      if (language === "shell") {
        const denied = checkDenyPolicy(code, "execute");
        if (denied) return denied;
      } else {
        const denied = checkNonShellDenyPolicy(code, language, "execute");
        if (denied) return denied;
      }

      try {
        // For JS/TS: wrap in async IIFE with fetch + http/https interceptors to track network bytes
        let instrumentedCode = code;
        if (language === "javascript" || language === "typescript") {
          // Wrap user code in a closure that shadows CJS require with http/https interceptor.
          // globalThis.require does NOT work because CJS require is module-scoped, not global.
          // The closure approach (function(__cm_req){ var require=...; })(require) correctly
          // shadows the CJS require for all code inside, including __cm_main().
          instrumentedCode = `
  // FS read instrumentation — count bytes read via fs.readFileSync/readFile
  let __cm_fs=0;
  process.on('exit',()=>{if(__cm_fs>0)try{process.stderr.write('__CM_FS__:'+__cm_fs+'\\n')}catch{}});
  (function(){
    try{
      var f=typeof require!=='undefined'?require('fs'):null;
      if(!f)return;
      var ors=f.readFileSync;
      f.readFileSync=function(){var r=ors.apply(this,arguments);if(Buffer.isBuffer(r))__cm_fs+=r.length;else if(typeof r==='string')__cm_fs+=Buffer.byteLength(r);return r;};
      var orf=f.readFile;
      if(orf)f.readFile=function(){var a=Array.from(arguments),cb=a.pop();orf.apply(this,a.concat([function(e,d){if(!e&&d){if(Buffer.isBuffer(d))__cm_fs+=d.length;else if(typeof d==='string')__cm_fs+=Buffer.byteLength(d);}cb(e,d);}]));};
    }catch{}
  })();
  let __cm_net=0;
  // Report network bytes on process exit — works with both promise and callback patterns.
  // process.on('exit') fires after all I/O completes, unlike .finally() which fires
  // when __cm_main() resolves (immediately for callback-based http.get without await).
  process.on('exit',()=>{if(__cm_net>0)try{process.stderr.write('__CM_NET__:'+__cm_net+'\\n')}catch{}});
  ;(function(__cm_req){
  // Intercept globalThis.fetch
  const __cm_f=globalThis.fetch;
  globalThis.fetch=async(...a)=>{const r=await __cm_f(...a);
  try{const cl=r.clone();const b=await cl.arrayBuffer();__cm_net+=b.byteLength}catch{}
  return r};
  // Shadow CJS require with http/https network tracking.
  const __cm_hc=new Map();
  const __cm_hm=new Set(['http','https','node:http','node:https']);
  function __cm_wf(m,origFn){return function(...a){
    const li=a.length-1;
    if(li>=0&&typeof a[li]==='function'){const oc=a[li];a[li]=function(res){
      res.on('data',function(c){__cm_net+=c.length});oc(res);};}
    const req=origFn.apply(m,a);
    const oOn=req.on.bind(req);
    req.on=function(ev,cb,...r){
      if(ev==='response'){return oOn(ev,function(res){
        res.on('data',function(c){__cm_net+=c.length});cb(res);
      },...r);}
      return oOn(ev,cb,...r);
    };
    return req;
  }}
  var require=__cm_req?function(id){
    const m=__cm_req(id);
    if(!__cm_hm.has(id))return m;
    const k=id.replace('node:','');
    if(__cm_hc.has(k))return __cm_hc.get(k);
    const w=Object.create(m);
    if(typeof m.get==='function')w.get=__cm_wf(m,m.get);
    if(typeof m.request==='function')w.request=__cm_wf(m,m.request);
    __cm_hc.set(k,w);return w;
  }:__cm_req;
  if(__cm_req){if(__cm_req.resolve)require.resolve=__cm_req.resolve;
  if(__cm_req.cache)require.cache=__cm_req.cache;}
  async function __cm_main(){
  ${code}
  }
  __cm_main().catch(e=>{console.error(e);process.exitCode=1});${background ? '\nsetInterval(()=>{},2147483647);' : ''}
  })(typeof require!=='undefined'?require:null);`;
        }
        const result = await executor.execute({ language, code: instrumentedCode, timeout, background, cwd });

        // Echo the executed source code before stdout so users can audit
        // and tooling can block command patterns (Issues #717 + #736).
        // Built from the user-supplied `code`, NOT the instrumented variant.
        const echo = buildExecuteEcho(language, code);

        // Parse sandbox network metrics from stderr
        const netMatch = result.stderr?.match(/__CM_NET__:(\d+)/);
        if (netMatch) {
          sessionStats.bytesSandboxed += parseInt(netMatch[1]);
          // Clean the metric line from stderr
          result.stderr = result.stderr.replace(/\n?__CM_NET__:\d+\n?/g, "");
        }

        // Parse sandbox FS read metrics from stderr
        const fsMatch = result.stderr?.match(/__CM_FS__:(\d+)/);
        if (fsMatch) {
          sessionStats.bytesSandboxed += parseInt(fsMatch[1]);
          result.stderr = result.stderr.replace(/\n?__CM_FS__:\d+\n?/g, "");
        }

        if (result.timedOut) {
          const partialOutput = result.stdout?.trim();
          if (result.backgrounded && partialOutput) {
            // Background mode: process is still running, return partial output as success
            return trackResponse("ctx_execute", {
              content: [
                {
                  type: "text" as const,
                  text: `${echo}${partialOutput}\n\n_(process backgrounded after ${timeout}ms — still running)_`,
                },
              ],
            });
          }
          if (partialOutput) {
            // Timeout with partial output — return as success with note
            return trackResponse("ctx_execute", {
              content: [
                {
                  type: "text" as const,
                  text: `${echo}${partialOutput}\n\n_(timed out after ${timeout}ms — partial output shown above)_`,
                },
              ],
            });
          }
          return trackResponse("ctx_execute", {
            content: [
              {
                type: "text" as const,
                text: `${echo}Execution timed out after ${timeout}ms\n\nstderr:\n${result.stderr}`,
              },
            ],
            isError: true,
          });
        }

        if (result.exitCode !== 0) {
          const { isError, output } = classifyNonZeroExit({
            language, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
          });
          if (intent && intent.trim().length > 0 && Buffer.byteLength(output) > INTENT_SEARCH_THRESHOLD) {
            trackIndexed(Buffer.byteLength(output));
            return trackResponse("ctx_execute", {
              content: [
                { type: "text" as const, text: `${echo}${intentSearch(output, intent, isError ? `execute:${language}:error` : `execute:${language}`)}` },
              ],
              isError,
            });
          }
          // Auto-index large error output into FTS5 — no data loss
          if (Buffer.byteLength(output) > LARGE_OUTPUT_THRESHOLD) {
            trackIndexed(Buffer.byteLength(output));
            return trackResponse("ctx_execute", {
              content: [
                { type: "text" as const, text: `${echo}${intentSearch(output, "errors failures exceptions", isError ? `execute:${language}:error` : `execute:${language}`)}` },
              ],
              isError,
            });
          }
          return trackResponse("ctx_execute", {
            content: [
              { type: "text" as const, text: `${echo}${output}` },
            ],
            isError,
          });
        }

        const stdout = result.stdout || "(no output)";

        // Intent-driven search: if intent provided and output is large enough
        if (intent && intent.trim().length > 0 && Buffer.byteLength(stdout) > INTENT_SEARCH_THRESHOLD) {
          trackIndexed(Buffer.byteLength(stdout));
          return trackResponse("ctx_execute", {
            content: [
              { type: "text" as const, text: `${echo}${intentSearch(stdout, intent, `execute:${language}`)}` },
            ],
          });
        }

        // Auto-index large stdout into FTS5 — return pointer, not raw content
        if (Buffer.byteLength(stdout) > LARGE_OUTPUT_THRESHOLD) {
          const indexed = indexStdout(stdout, `execute:${language}`);
          // Prepend echo to the first text content so provenance still surfaces
          const echoed = {
            ...indexed,
            content: indexed.content.map((c, i) =>
              i === 0 && c.type === "text"
                ? { ...c, text: `${echo}${(c as { text: string }).text}` }
                : c,
            ),
          };
          return trackResponse("ctx_execute", echoed);
        }

        return trackResponse("ctx_execute", {
          content: [
            { type: "text" as const, text: `${echo}${stdout}` },
          ],
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return trackResponse("ctx_execute", {
          content: [
            { type: "text" as const, text: `Runtime error: ${message}` },
          ],
          isError: true,
        });
      }
    },
  );

  // ─────────────────────────────────────────────────────────
  // Helper: index stdout into FTS5 knowledge base
  // ─────────────────────────────────────────────────────────

  function indexStdout(
    stdout: string,
    source: string,
  ): { content: Array<{ type: "text"; text: string }> } {
    const store = getStore();
    trackIndexed(Buffer.byteLength(stdout));
    const indexed = store.index({ content: stdout, source, attribution: currentAttribution() });
    return {
      content: [
        {
          type: "text" as const,
          text: `Indexed ${indexed.totalChunks} sections (${indexed.codeChunks} with code) from: ${indexed.label}\nUse ctx_search(queries: ["..."]) to query this content. Use source: "${indexed.label}" to scope results.`,
        },
      ],
    };
  }

  // ─────────────────────────────────────────────────────────
  // Helper: intent-driven search on execution output
  // ─────────────────────────────────────────────────────────

  const INTENT_SEARCH_THRESHOLD = 5_000; // bytes — ~80-100 lines
  const LARGE_OUTPUT_THRESHOLD = 102_400; // 100KB — auto-index into FTS5, return pointer

  function intentSearch(
    stdout: string,
    intent: string,
    source: string,
    maxResults: number = 5,
  ): string {
    const totalLines = stdout.split("\n").length;
    const totalBytes = Buffer.byteLength(stdout);

    // Index into the PERSISTENT store so user can ctx_search() later
    const persistent = getStore();
    const indexed = persistent.indexPlainText(stdout, source, undefined, currentAttribution());

    // Search the persistent store directly (porter → trigram → fuzzy)
    let results = persistent.searchWithFallback(intent, maxResults, source);

    // Extract distinctive terms as vocabulary hints for the LLM
    const distinctiveTerms = persistent.getDistinctiveTerms(indexed.sourceId);

    if (results.length === 0) {
      const lines = [
        `Indexed ${indexed.totalChunks} sections from "${source}" into knowledge base.`,
        `No sections matched intent "${intent}" in ${totalLines}-line output (${(totalBytes / 1024).toFixed(1)}KB).`,
      ];
      if (distinctiveTerms.length > 0) {
        lines.push("");
        lines.push(`Searchable terms: ${distinctiveTerms.join(", ")}`);
      }
      lines.push("");
      lines.push("Use ctx_search(queries: [...]) to explore the indexed content.");
      return lines.join("\n");
    }

    // Return ONLY titles + first-line previews — not full content
    const lines = [
      `Indexed ${indexed.totalChunks} sections from "${source}" into knowledge base.`,
      `${results.length} sections matched "${intent}" (${totalLines} lines, ${(totalBytes / 1024).toFixed(1)}KB):`,
      "",
    ];

    for (const r of results) {
      const preview = r.content.split("\n")[0].slice(0, 120);
      lines.push(`  - ${r.title}: ${preview}`);
    }

    if (distinctiveTerms.length > 0) {
      lines.push("");
      lines.push(`Searchable terms: ${distinctiveTerms.join(", ")}`);
    }

    lines.push("");
    lines.push("Use ctx_search(queries: [...]) to retrieve full content of any section.");

    return lines.join("\n");
  }

  // ─────────────────────────────────────────────────────────
  // Tool: execute_file
  // ─────────────────────────────────────────────────────────

  deps.server.registerTool(
    "ctx_execute_file",
    {
      // #852: the host's MCP approval prompt renders only the tool name/title +
      // raw args — the title is the one server-controlled signal, so make it
      // unambiguously announce code execution + file read for the reviewer.
      title: "Run code over a file (executes code, reads the given path)",
      // #846: runs arbitrary code over a file in a child process with full
      // network access and the parent's filesystem permissions.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      description: `Read a file into a FILE_CONTENT variable in a separate subprocess and run code over it. Only what you console.log() enters your conversation — the file bytes stay in the subprocess.

  Think-in-Code applied to file-level analysis: Reading the whole file means every byte enters your conversation memory and costs reasoning capacity for the rest of the session. Running code over it here lets you keep the raw bytes out and only the derived answer in. Same principle as ctx_execute, scoped to one named file via the FILE_CONTENT variable.

  WHEN:
    - You want to KNOW SOMETHING ABOUT a file (line count, matches of a pattern, parsed structure, statistical aggregate) without needing to SEE all of it
    - The file is structured (CSV, JSON, log, code) and a code-level derivation is cheaper than reading verbatim
    - The file is large enough that reading the full content would burn meaningful conversation memory you need for the actual work
    - The derivation may itself produce a large output you want recall-by-topic on later — pass an \`intent\` string; outputs over ~5KB are auto-indexed and only matching sections come back, retrievable via ctx_search

  WHEN NOT:
    - You intend to EDIT the file — use Read so the subsequent Edit can match the exact text
    - You only need one specific line and you know its offset — Read with offset/limit is the simplest path
    - The file is small AND you will consume all of it for understanding/editing — Read directly

  RETURNS:
    Only what your code prints. The FILE_CONTENT variable holds the raw bytes inside the sandbox; nothing else leaves. When \`intent\` is set and output exceeds the auto-index threshold, the response carries searchable section titles + previews instead of the raw stdout.

  EXAMPLE: ctx_execute_file(path: "huge.log", language: "javascript", code: "const errs = FILE_CONTENT.split('\\\\n').filter(l => /ERROR|FATAL/.test(l)); console.log(\`\${errs.length} error lines\`); console.log(errs.slice(-5).join('\\\\n'))")
  EXAMPLE: ctx_execute_file(path: "data.csv", language: "javascript", code: "const rows = FILE_CONTENT.split('\\\\n'); console.log(\`rows: \${rows.length - 1}, header: \${rows[0]}\`)")`,
      inputSchema: z.object({
        path: z
          .string()
          .describe("Absolute file path or relative to project root"),
        language: z
          .enum([
            "javascript",
            "typescript",
            "python",
            "shell",
            "ruby",
            "go",
            "rust",
            "php",
            "perl",
            "r",
            "elixir",
            "csharp",
          ])
          .describe("Runtime language"),
        code: z
          .string()
          .describe(
            "Code to process FILE_CONTENT (file_content in Elixir). Print summary via console.log/print/echo/IO.puts/Console.WriteLine.",
          ),
        timeout: z
          .coerce.number()
          .optional()
          .describe("Max execution time in ms. When omitted, no server-side timer fires — the MCP host's RPC timeout governs."),
        intent: z
          .string()
          .optional()
          .describe(
            "What you're looking for in the output; large output comes back as the matching sections only. Use specific technical terms.",
          ),
      }),
    },
    executeFileHandler,
  );

  /**
   * The `ctx_execute_file` handler, lifted out of its registration so a second
   * tool can BE this call rather than resemble it.
   *
   * `ctx_read` (src/tools/read.ts) is exactly this function with a default
   * program supplied for `code`. Reimplementing the path would have meant two
   * routes into the executor and two sets of security checks, and would have
   * quietly invalidated the recorded latency numbers — those
   * measure this path, and only stay true of `ctx_read` while `ctx_read` is
   * this path.
   *
   * Three parameters exist only for that second caller. `toolName` carries the
   * attribution through the stats counters and the security messages, so a
   * denial names the tool the agent actually called. `policyLabel` follows it.
   * `echoOverride` replaces the source-code preamble: echoing 4 KB of a program
   * the agent did not write would cost more than the slice it produced, and
   * there is no audit value in showing a caller code they never supplied.
   */
  async function executeFileHandler({
    path,
    language,
    code,
    timeout,
    intent,
    toolName = "ctx_execute_file",
    echoOverride,
  }: {
    path: string;
    language: Language;
    code: string;
    timeout?: number;
    intent?: string;
    toolName?: string;
    echoOverride?: string;
  }): Promise<ToolResult> {
    const policyLabel = toolName.replace(/^ctx_/, "");
    // Security (#852): confine the processed file to the project root so
    // ctx_execute_file cannot be used to escape the host's sandbox/permission
    // controls. Runs before the deny-glob check — boundary first, then policy.
    const boundaryDenied = checkProjectBoundary(path, toolName);
    if (boundaryDenied) return boundaryDenied;

    // Security: check file path against Read deny patterns
    const pathDenied = checkFilePathDenyPolicy(path, toolName);
    if (pathDenied) return pathDenied;

    // Security: check code parameter against Bash deny patterns
    if (language === "shell") {
      const codeDenied = checkDenyPolicy(code, policyLabel);
      if (codeDenied) return codeDenied;
    } else {
      const codeDenied = checkNonShellDenyPolicy(code, language, policyLabel);
      if (codeDenied) return codeDenied;
    }

    try {
      const result = await executor.executeFile({
        path,
        language,
        code,
        timeout,
      });

      // Echo path + executed source code before stdout for audit/debug
      // (Issues #717 + #736).
      const echo = echoOverride ?? buildExecuteEcho(language, code, path);

      if (result.timedOut) {
        return trackResponse(toolName, {
          content: [
            {
              type: "text" as const,
              text: `${echo}Timed out processing ${path} after ${timeout}ms`,
            },
          ],
          isError: true,
        });
      }

      if (result.exitCode !== 0) {
        const { isError, output } = classifyNonZeroExit({
          language, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
        });
        if (intent && intent.trim().length > 0 && Buffer.byteLength(output) > INTENT_SEARCH_THRESHOLD) {
          trackIndexed(Buffer.byteLength(output));
          return trackResponse(toolName, {
            content: [
              { type: "text" as const, text: `${echo}${intentSearch(output, intent, isError ? `file:${path}:error` : `file:${path}`)}` },
            ],
            isError,
          });
        }
        // Auto-index large error output into FTS5 — no data loss
        if (Buffer.byteLength(output) > LARGE_OUTPUT_THRESHOLD) {
          trackIndexed(Buffer.byteLength(output));
          return trackResponse(toolName, {
            content: [
              { type: "text" as const, text: `${echo}${intentSearch(output, "errors failures exceptions", isError ? `file:${path}:error` : `file:${path}`)}` },
            ],
            isError,
          });
        }
        return trackResponse(toolName, {
          content: [
            { type: "text" as const, text: `${echo}${output}` },
          ],
          isError,
        });
      }

      const stdout = result.stdout || "(no output)";

      if (intent && intent.trim().length > 0 && Buffer.byteLength(stdout) > INTENT_SEARCH_THRESHOLD) {
        trackIndexed(Buffer.byteLength(stdout));
        return trackResponse(toolName, {
          content: [
            { type: "text" as const, text: `${echo}${intentSearch(stdout, intent, `file:${path}`)}` },
          ],
        });
      }

      // Auto-index large stdout into FTS5 — return pointer, not raw content
      if (Buffer.byteLength(stdout) > LARGE_OUTPUT_THRESHOLD) {
        const indexed = indexStdout(stdout, `file:${path}`);
        const echoed = {
          ...indexed,
          content: indexed.content.map((c, i) =>
            i === 0 && c.type === "text"
              ? { ...c, text: `${echo}${(c as { text: string }).text}` }
              : c,
          ),
        };
        return trackResponse(toolName, echoed);
      }

      return trackResponse(toolName, {
        content: [
          { type: "text" as const, text: `${echo}${stdout}` },
        ],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return trackResponse(toolName, {
        content: [
          { type: "text" as const, text: `Runtime error: ${message}` },
        ],
        isError: true,
      });
    }
  }

  return { executeFileHandler };
}
