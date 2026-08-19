/**
 * Latency benchmark — routed tool call vs. the native tool it replaces.
 *
 * BENCHMARK.md measures bytes saved. It never measured the price paid for them.
 * That gap matters: a model routed onto a tool that answers slower pays twice
 * (the wait, and the temptation to go back to Grep), and no amount of blocking
 * fixes a path that is simply worse to walk. This script produces the missing
 * number.
 *
 * Three pairs, each the same question asked two ways:
 *
 *   ctx_find(query)              vs  rg -l <query>            — where does it live
 *   ctx_execute_file(path, …)    vs  Read(path)               — what is in this file
 *   ctx_search(queries)          vs  rg -n <query> × N        — what do we know already
 *
 * The routed side is driven through the real MCP surface: a child process
 * running the committed `server.bundle.mjs`, spoken to over stdio JSON-RPC.
 * That is the exact path a host takes, so nothing here is a fast lane the
 * production caller does not get. The native side pays its real cost too —
 * ripgrep is measured including process spawn, because the host spawns it.
 *
 * Cold vs. warm is the variable that decides the answer, so both are reported.
 * A cold run is a fresh server process pointed at empty storage
 * (`CONTEXT_MODE_DIR` + `CONTEXT_MODE_FFF_DIR` under a temp root): it pays for
 * index construction. A warm run reuses one server whose indexes are already
 * built. Median and p90 rather than a mean — one 2-second index build in a
 * ten-run mean hides exactly the outlier a user notices.
 *
 * Run:  npx tsx tests/latency-benchmark.ts
 *
 * Nothing outside the temp root is written, and the user's real
 * `~/.claude/context-mode` store is never touched.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * The bundle under test.
 *
 * Defaults to the committed artifact, which is what ships and therefore what
 * the published numbers must describe. `CTX_LATENCY_BUNDLE` points it at an
 * equivalent build elsewhere — the case that motivated the override is
 * measuring a tool added to `src/` before the committed bundle has been
 * rebuilt, where the alternative is either publishing no number or publishing
 * one taken from a different execution path.
 */
const BUNDLE = process.env.CTX_LATENCY_BUNDLE || join(REPO, "server.bundle.mjs");

/** Warm runs measured per pair, after two unmeasured warmups. */
const WARM_RUNS = 7;
/** Cold runs measured per pair. Each one spawns a server against empty storage. */
const COLD_RUNS = 5;

/** Queries used for the find/search pairs — real identifiers from this repo. */
const QUERIES = ["registerTool", "detectPlatform", "PLATFORM_ENV_VARS"];

/** File used for the execute_file/Read pair — large enough that reading it costs. */
const TARGET_FILE = "src/adapters/detect.ts";

/**
 * The default program `ctx_execute_file` gets asked to run: list exported
 * symbols. This is the shape D4 wants to make argument-free (`ctx_read(path,
 * intent)`), so the latency of writing-and-running it is the number D4 needs.
 */
const EXECUTE_FILE_CODE = `
const fs = require("node:fs");
const src = fs.readFileSync(process.argv[2] ?? ${JSON.stringify(join(REPO, TARGET_FILE))}, "utf-8");
const names = [...src.matchAll(/export (?:async )?function ([A-Za-z0-9_]+)/g)].map((m) => m[1]);
console.log(names.join("\\n"));
`.trim();

// ─────────────────────────────────────────────────────────
// MCP client — stdio JSON-RPC against the committed bundle
// ─────────────────────────────────────────────────────────

interface RpcMessage {
  id?: number;
  result?: { content?: Array<{ type: string; text?: string }> };
  error?: { message?: string };
}

class McpServer {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, (m: RpcMessage) => void>();
  private buffer = "";
  private nextId = 0;

  constructor(readonly storageRoot: string) {
    this.child = spawn(process.execPath, [BUNDLE], {
      cwd: REPO,
      env: {
        ...process.env,
        // Isolate every store this run touches. Without these the benchmark
        // would measure (and pollute) the developer's own index.
        CONTEXT_MODE_DIR: join(storageRoot, "store"),
        CONTEXT_MODE_FFF_DIR: join(storageRoot, "fff"),
        // Claude Code sets this. Without it the server falls back to resolving
        // the project from the most recent session log, which points at
        // whatever repo was open last — measured: ctx_find answered with files
        // from an unrelated project until this was pinned.
        CLAUDE_PROJECT_DIR: REPO,
        CONTEXT_MODE_PLATFORM: "claude-code",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.resume();
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as RpcMessage;
          if (msg.id != null) {
            const resolver = this.pending.get(msg.id);
            if (resolver) {
              this.pending.delete(msg.id);
              resolver(msg);
            }
          }
        } catch {
          /* server prints non-JSON diagnostics on stdout in some modes */
        }
      }
    });
  }

  private request(method: string, params: unknown): Promise<RpcMessage> {
    const id = ++this.nextId;
    return new Promise((res) => {
      this.pending.set(id, res);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /** Handshake. Returned ms is the server's cold start as a host would see it. */
  async initialize(): Promise<number> {
    const start = performance.now();
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "claude-code", version: "1.0.0" },
    });
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
    );
    return performance.now() - start;
  }

  /** One tool call. Returns wall time and the bytes the host would receive. */
  async call(name: string, args: Record<string, unknown>): Promise<Sample> {
    const start = performance.now();
    const msg = await this.request("tools/call", { name, arguments: args });
    const ms = performance.now() - start;
    const text = (msg.result?.content ?? []).map((c) => c.text ?? "").join("");
    return { ms, bytes: Buffer.byteLength(text, "utf-8") };
  }

  /**
   * Kill the server and wait for it to actually exit. Awaiting matters: the
   * server holds SQLite WAL files under the temp root and keeps writing them
   * until the process is gone, so tearing the directory down on `kill()` alone
   * races the last flush and fails with ENOTEMPTY mid-benchmark.
   */
  close(): Promise<void> {
    return new Promise((res) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return res();
      const done = (): void => {
        clearTimeout(timer);
        res();
      };
      const timer = setTimeout(done, 2000);
      this.child.once("exit", done);
      this.child.kill();
    });
  }
}

// ─────────────────────────────────────────────────────────
// Native side
// ─────────────────────────────────────────────────────────

/**
 * `rg -l` — what Claude Code's Grep runs by default (files_with_matches).
 *
 * The trailing `"."` is load-bearing, not decoration: with no path argument and
 * a non-TTY stdout, ripgrep searches *stdin* rather than the working directory.
 * Under `spawnSync` that means an empty stdin, exit status 1 and zero output —
 * a native side that looks instant because it searched nothing.
 */
function ripgrepFiles(query: string): Sample {
  const start = performance.now();
  const out = spawnSync("rg", ["-l", "--", query, "."], { cwd: REPO, encoding: "utf-8" });
  return { ms: performance.now() - start, bytes: Buffer.byteLength(out.stdout ?? "", "utf-8") };
}

/** `rg -n` — Grep in content mode, the fallback when files_with_matches is not enough. */
function ripgrepLines(query: string): Sample {
  const start = performance.now();
  const out = spawnSync("rg", ["-n", "--", query, "."], { cwd: REPO, encoding: "utf-8" });
  return { ms: performance.now() - start, bytes: Buffer.byteLength(out.stdout ?? "", "utf-8") };
}

/**
 * Read — the host reads the file and hands the model `cat -n` style lines.
 * The line prefixes are part of what lands in context, so they are counted.
 */
function nativeRead(relPath: string): Sample {
  const start = performance.now();
  const src = readFileSync(join(REPO, relPath), "utf-8");
  const numbered = src
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(6)}\t${line}`)
    .join("\n");
  return { ms: performance.now() - start, bytes: Buffer.byteLength(numbered, "utf-8") };
}

// ─────────────────────────────────────────────────────────
// Statistics
// ─────────────────────────────────────────────────────────

interface Sample {
  ms: number;
  bytes: number;
}

interface Stat {
  label: string;
  runs: number;
  medianMs: number;
  p90Ms: number;
  bytes: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function summarize(label: string, samples: Sample[]): Stat {
  const times = samples.map((s) => s.ms).sort((a, b) => a - b);
  const bytes = samples.map((s) => s.bytes).sort((a, b) => a - b);
  return {
    label,
    runs: samples.length,
    medianMs: percentile(times, 50),
    p90Ms: percentile(times, 90),
    bytes: percentile(bytes, 50),
  };
}

const stats: Stat[] = [];
function record(label: string, samples: Sample[]): Stat {
  const s = summarize(label, samples);
  stats.push(s);
  const ratio = s.bytes > 0 ? `${(s.bytes / 1024).toFixed(1)} KB` : "0 B";
  console.log(
    `  ${s.label.padEnd(44)} median ${s.medianMs.toFixed(0).padStart(6)} ms   ` +
      `p90 ${s.p90Ms.toFixed(0).padStart(6)} ms   ${ratio.padStart(9)}  (n=${s.runs})`,
  );
  return s;
}

// ─────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "ctx-latency-"));
}

/**
 * Remove a temp root, retrying briefly. Even after the server process exits,
 * the kernel can still be flushing its last WAL pages; one retry loop is
 * cheaper than a benchmark that dies two thirds of the way through.
 */
function removeRoot(root: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return;
    } catch {
      /* one more pass */
    }
  }
}

/** 1/5/15-minute load average, formatted for the run header and footer. */
function loadAverage(): string {
  return loadavg()
    .map((n) => `  ${n.toFixed(2)}`)
    .join("");
}

/** One cold cycle: new storage, new server, one call, teardown. */
async function coldCall(
  tool: string,
  args: Record<string, unknown>,
  prepare?: (s: McpServer) => Promise<void>,
): Promise<Sample> {
  const root = freshRoot();
  const server = new McpServer(root);
  try {
    const initMs = await server.initialize();
    if (prepare) await prepare(server);
    const sample = await server.call(tool, args);
    // A host pays the handshake once per session, not per call — but a cold
    // first tool call cannot happen without it, so it belongs in the cold number.
    return { ms: sample.ms + initMs, bytes: sample.bytes };
  } finally {
    await server.close();
    removeRoot(root);
  }
}

async function main(): Promise<void> {
  console.log("Context Mode — latency benchmark (routed vs. native)\n");
  console.log(`  repo        ${REPO}`);
  console.log(`  files       ${spawnSync("git", ["ls-files"], { cwd: REPO, encoding: "utf-8" }).stdout.trim().split("\n").length} tracked`);
  console.log(`  bundle      ${BUNDLE}`);
  console.log(`  node        ${process.version}`);
  console.log(`  ripgrep     ${(spawnSync("rg", ["--version"], { encoding: "utf-8" }).stdout ?? "").split("\n")[0]}`);
  console.log(`  runs        ${COLD_RUNS} cold / ${WARM_RUNS} warm per pair`);
  // Load average bookends every run. A benchmark taken on a busy machine is
  // still useful, but only if the reader can see how busy it was.
  console.log(`  load (start)${loadAverage()}\n`);

  // ── Pair 1: ctx_find vs Grep ───────────────────────────
  console.log("Pair 1 — locate a symbol");
  {
    const cold: Sample[] = [];
    for (let i = 0; i < COLD_RUNS; i++) {
      cold.push(await coldCall("ctx_find", { query: QUERIES[i % QUERIES.length] }));
    }
    record("ctx_find  (cold: fresh server + empty index)", cold);

    const root = freshRoot();
    const server = new McpServer(root);
    await server.initialize();
    for (const q of QUERIES) await server.call("ctx_find", { query: q }); // warmup
    const warm: Sample[] = [];
    for (let i = 0; i < WARM_RUNS; i++) {
      warm.push(await server.call("ctx_find", { query: QUERIES[i % QUERIES.length] }));
    }
    record("ctx_find  (warm)", warm);
    await server.close();
    removeRoot(root);

    const rgFirst: Sample[] = QUERIES.map((q) => ripgrepFiles(q));
    record("rg -l     (first touch)", rgFirst);
    const rgWarm: Sample[] = [];
    for (let i = 0; i < WARM_RUNS; i++) rgWarm.push(ripgrepFiles(QUERIES[i % QUERIES.length]));
    record("rg -l     (warm)", rgWarm);
  }

  // ── Pair 2: ctx_execute_file vs Read ───────────────────
  console.log("\nPair 2 — extract exported symbols from one file");
  {
    const args = { path: TARGET_FILE, language: "javascript", code: EXECUTE_FILE_CODE };
    const cold: Sample[] = [];
    for (let i = 0; i < COLD_RUNS; i++) cold.push(await coldCall("ctx_execute_file", args));
    record("ctx_execute_file  (cold: fresh server)", cold);

    const root = freshRoot();
    const server = new McpServer(root);
    await server.initialize();
    for (let i = 0; i < 2; i++) await server.call("ctx_execute_file", args);
    const warm: Sample[] = [];
    for (let i = 0; i < WARM_RUNS; i++) warm.push(await server.call("ctx_execute_file", args));
    record("ctx_execute_file  (warm)", warm);
    await server.close();
    removeRoot(root);

    const reads: Sample[] = [];
    for (let i = 0; i < WARM_RUNS; i++) reads.push(nativeRead(TARGET_FILE));
    record(`Read ${TARGET_FILE}`, reads);
  }

  // ── Pair 2b: ctx_read vs Read ──────────────────────────
  console.log("\nPair 2b — the same question with no program to write");
  {
    const plain = { path: TARGET_FILE };
    const aimed = { path: TARGET_FILE, intent: "exports" };

    const cold: Sample[] = [];
    for (let i = 0; i < COLD_RUNS; i++) cold.push(await coldCall("ctx_read", plain));
    record("ctx_read  (cold: fresh server)", cold);

    const root = freshRoot();
    const server = new McpServer(root);
    await server.initialize();
    for (let i = 0; i < 2; i++) await server.call("ctx_read", plain);
    const warm: Sample[] = [];
    for (let i = 0; i < WARM_RUNS; i++) warm.push(await server.call("ctx_read", plain));
    record("ctx_read  (warm, structural slice)", warm);
    const aimedWarm: Sample[] = [];
    for (let i = 0; i < WARM_RUNS; i++) aimedWarm.push(await server.call("ctx_read", aimed));
    record("ctx_read  (warm, intent: \"exports\")", aimedWarm);
    await server.close();
    removeRoot(root);
  }

  // ── Pair 3: ctx_search vs repeated Grep ────────────────
  console.log("\nPair 3 — answer three questions about already-indexed content");
  {
    const indexSrc = async (s: McpServer): Promise<void> => {
      await s.call("ctx_index", { path: join(REPO, "src"), source: "latency-bench" });
    };

    const cold: Sample[] = [];
    for (let i = 0; i < COLD_RUNS; i++) {
      cold.push(await coldCall("ctx_search", { queries: QUERIES }, indexSrc));
    }
    record("ctx_search  (cold: incl. indexing src/)", cold);

    const root = freshRoot();
    const server = new McpServer(root);
    await server.initialize();
    await indexSrc(server);
    for (let i = 0; i < 2; i++) await server.call("ctx_search", { queries: QUERIES });
    const warm: Sample[] = [];
    for (let i = 0; i < WARM_RUNS; i++) warm.push(await server.call("ctx_search", { queries: QUERIES }));
    record("ctx_search  (warm)", warm);
    await server.close();
    removeRoot(root);

    // Native equivalent: no memory, so every question is grepped again.
    const grepAll = (): Sample => {
      let ms = 0;
      let bytes = 0;
      for (const q of QUERIES) {
        const s = ripgrepLines(q);
        ms += s.ms;
        bytes += s.bytes;
      }
      return { ms, bytes };
    };
    const nativeSamples: Sample[] = [];
    for (let i = 0; i < WARM_RUNS; i++) nativeSamples.push(grepAll());
    record(`rg -n × ${QUERIES.length}  (warm)`, nativeSamples);
  }

  console.log(`\n  load (end)  ${loadAverage()}`);
  console.log("\nMachine-readable summary:");
  console.log(JSON.stringify(stats, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
