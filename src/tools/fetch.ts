/**
 * `ctx_fetch_and_index` — the SSRF guard, the fetch/index split, and the tool.
 *
 * Second wave of the `src/server.ts` split. What lives here is everything the
 * fetch tool needs on the PARENT side: the URL/IP policy, the TTL cache check,
 * the parallel-fetch / serial-index division of labour, the ladder-rung
 * reporting, and the registration itself. The fork has rewritten pieces of all
 * of it, so this region conflicts on every `sync-upstream` regardless of where
 * it lives — moving it out just leaves a smaller file to reconcile.
 *
 * What deliberately did NOT come along is `buildFetchCode()`, the ~500-line
 * CJS program that runs in the fetch subprocess. It stays in `src/server.ts`
 * for the same reason `runBatchCommands` did in wave 1: it is upstream's code
 * almost line for line, upstream actively develops that ladder, and a region
 * the fork has barely touched turns into a delete/modify conflict on every
 * merge the moment it moves. It arrives here through {@link FetchToolDeps}
 * instead — one field, and the merge stays clean.
 *
 * That leaves one import pointing the other way: `server.ts` imports
 * `classifyIp` and `classifyExtraction` from this file, because
 * `buildFetchCode` injects both into the subprocess via `.toString()` so the
 * child re-validates DNS and judges extraction yield with the same arithmetic
 * the parent uses. That is server → tools, the same direction as every other
 * tool module, so it closes no cycle.
 */

import { readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { cpus, tmpdir } from "node:os";
import { z } from "zod";

import { runPool, type PoolJob } from "../runPool.js";
import { composeFetchCacheKey } from "../fetch-cache.js";
import { PageStore } from "../fetch/page-store.js";
import { extractAndStore, routeSkipsExtraction, type FetchRoute, type Relabelled } from "../fetch/extract.js";
import { isFetchPassthroughUrl, passthroughFetchError } from "../fetch-passthrough.js";
import { charSafePrefix } from "../truncate.js";
import { emitCacheHitEvent } from "../session/event-emit.js";
import type { IndexResult } from "../store.js";
import type { FetchToolDeps } from "./shared/deps.js";
import { sessionStats } from "./shared/state.js";

/**
 * What `src/server.ts` owns, installed once by {@link registerCtxFetch}.
 *
 * A module-level binding rather than a parameter threaded through every
 * helper, because the helpers' signatures are part of what this file
 * guarantees: `fetchOneUrl` is the parallel-safe half and `indexFetched` is
 * the serial half, and the contract reads better without a `deps` argument
 * repeated on both. It cannot be observed unset: nothing here reads it at
 * import time, and every function that touches it is reachable only through
 * the registered handler — which exists only after `registerCtxFetch` ran.
 */
let deps: FetchToolDeps;

// ─────────────────────────────────────────────────────────
// Tool: fetch_and_index
// ─────────────────────────────────────────────────────────

/**
 * Opt-in outbound proxy for the fetch subprocess (#1039).
 *
 * Behind a corporate proxy the sandbox fetch is unreachable without one, but
 * honouring the ambient proxy silently would weaken the SSRF guard for
 * everyone. So it stays off unless the operator opts in explicitly, and it
 * only reports "on" when a proxy is actually configured.
 */
export function isProxyAllowed(): boolean {
  if (process.env.CONTEXT_MODE_ALLOW_PROXY !== "1") return false;
  return Boolean(
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy,
  );
}

/**
 * Env layered onto the fetch subprocess. `NODE_USE_ENV_PROXY` must be set
 * before Node bootstraps its global HTTP agent — setting it from inside the
 * script would be a no-op, which is why this goes through the executor's
 * `env` override rather than the script template.
 */
export function buildFetchEnv(): Record<string, string> | undefined {
  return isProxyAllowed() ? { NODE_USE_ENV_PROXY: "1" } : undefined;
}

// ─────────────────────────────────────────────────────────
// fetch_and_index helpers — split into parallel-safe fetch and serial-only index
// ─────────────────────────────────────────────────────────

const FETCH_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_PREVIEW_LIMIT = 3072;

function formatFetchTtl(ttlMs: number): string {
  if (ttlMs === 0) return "0ms";
  const day = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;
  const minute = 60 * 1000;
  if (ttlMs % day === 0) return `${ttlMs / day}d`;
  if (ttlMs % hour === 0) return `${ttlMs / hour}h`;
  if (ttlMs % minute === 0) return `${ttlMs / minute}m`;
  return `${ttlMs}ms`;
}

type FetchOneResult =
  | { kind: "cached"; label: string; chunkCount: number; estimatedBytes: number; ageStr: string; ttlStr: string }
  | { kind: "fetched"; url: string; source?: string; markdown: string; header: string; route: FetchRoute; rung: string }
  | { kind: "fetch_error"; url: string; error: string; reason: "exit" | "read" | "empty" | "shell" | "throw" };

// ─────────────────────────────────────────────────────────
// Extraction verdict — the "silent success" guard
// ─────────────────────────────────────────────────────────

export type ExtractionVerdict =
  | { kind: "ok" }
  | { kind: "shell"; textBytes: number; sourceBytes: number; yieldPct: string };

/**
 * Decide whether a non-empty extraction is actually a document or a
 * JavaScript-rendered shell.
 *
 * WHY THIS EXISTS. The old guard was `markdown.length === 0`. A canvas app or
 * SPA serves a few KB of bootstrap HTML whose entire text content is its
 * <title>; Turndown faithfully renders that to ~20 bytes. Twenty bytes is not
 * zero, so the fetch was reported as a success and the shell was indexed as if
 * it were the page. The caller had no way to tell that apart from a genuinely
 * short document.
 *
 * Measured on this exact code path (2026-08, bytes in -> markdown bytes out):
 *   excalidraw.com            6,862 ->     21   (0.31% yield)  <- shell
 *   app.diagrams.net          2,759 ->    476   (17.3% yield)   real prose
 *   nextjs.org              316,151 -> 13,587   (4.30% yield)   real prose
 *   developers.cloudflare.com 178,627 -> 8,389  (4.70% yield)   real prose
 *
 * Neither signal works alone. A ratio alone condemns a small valid page
 * (`<p>Hello</p>` is 5 bytes of text from 40 of markup and is perfectly fine).
 * A floor alone condemns a genuinely short document. Requiring BOTH — almost
 * no text came out AND almost none of what came in survived — isolates the
 * shell case and leaves every measured real page above untouched.
 *
 * Arithmetic only: no pattern matching, no markup sniffing, no word lists.
 *
 * The two thresholds live INSIDE the body on purpose. This function is
 * injected verbatim into the fetch subprocess (see buildFetchCode) so the
 * subprocess decides "is this a shell?" with the same arithmetic the parent
 * uses — one definition, two callers. A `const` at module scope would not
 * survive `.toString()` and the subprocess would throw a ReferenceError.
 *
 * @param textBytes   length of the converted text, already trimmed
 * @param sourceBytes bytes received off the wire pre-conversion; a
 *                    non-positive value means the subprocess did not report it
 *                    (older bundle), and with no evidence we never accuse.
 */
export function classifyExtraction(textBytes: number, sourceBytes: number): ExtractionVerdict {
  // Text that survives conversion, below which a document carries no usable
  // content. A page title alone lands around 20 bytes; a one-line answer or a
  // short redirect notice lands around 100.
  const SHELL_MAX_TEXT_BYTES = 200;
  // Fraction of received bytes that must survive conversion. Below this, the
  // bytes served were overwhelmingly markup and script rather than text.
  const SHELL_MAX_YIELD = 0.02;
  if (!Number.isFinite(sourceBytes) || sourceBytes <= 0) return { kind: "ok" };
  if (!Number.isFinite(textBytes) || textBytes >= SHELL_MAX_TEXT_BYTES) return { kind: "ok" };
  const ratio = textBytes / sourceBytes;
  if (ratio >= SHELL_MAX_YIELD) return { kind: "ok" };
  return {
    kind: "shell",
    textBytes,
    sourceBytes,
    yieldPct: (ratio * 100).toFixed(2),
  };
}

/**
 * Pure fetch step — TTL cache check + subprocess fetch. SAFE TO RUN IN PARALLEL.
 * Performs zero SQLite writes (only reads source meta). Caller must funnel
 * fetched results through `indexFetched` serially to avoid FTS5 WAL contention.
 */
/**
 * SSRF guard for ctx_fetch_and_index: validate URL scheme + resolve target IP +
 * block link-local / IMDS / multicast / reserved IP ranges. Returns null if
 * safe; returns a FetchOneResult fetch_error if blocked.
 *
 * Policy (PR #401 ops review, developer-friendly default):
 *
 * **HARD BLOCK** (no legitimate dev workflow):
 *   - file://, gopher://, javascript:, data: schemes (only http: and https:)
 *   - 169.254.0.0/16 link-local (INCLUDES 169.254.169.254 = AWS/GCP/Azure IMDS
 *     cloud credential endpoint — high-value target for indirect prompt injection)
 *   - IPv6 link-local fe80::/10
 *   - Multicast (224+ IPv4, ff00::/8 IPv6) and reserved (0.0.0.0/8) ranges
 *
 * **ALLOW by default** (legitimate developer use cases dominate):
 *   - localhost, 127.x.x.x, ::1 (local dev servers — Next.js, Vite, Postgres, …)
 *   - 10.x, 172.16-31.x, 192.168.x RFC1918 private (developer's internal network)
 *
 * **STRICT MODE** opt-in via env var: `CTX_FETCH_STRICT=1`
 *   - Blocks loopback + RFC1918 too
 *   - For hosted/CI environments where the runtime isn't the user's own machine
 *
 * DNS resolution is performed against the resolved IP (not just URL parse) so a
 * hostname like `evil.com` pointing to 169.254.169.254 is rejected — defends
 * against attacker-controlled DNS records and DNS rebinding.
 */
async function ssrfGuard(rawUrl: string): Promise<FetchOneResult | null> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { kind: "fetch_error", url: rawUrl, error: "invalid URL", reason: "exit" };
  }

  // Auth-gated SPA targets (claude.ai Artifacts, #938/#984/#1006). An anonymous
  // fetch "succeeds" here and returns an empty shell, which the model cannot
  // distinguish from real content. Fail loudly and name the tool that works.
  if (isFetchPassthroughUrl(rawUrl)) {
    return {
      kind: "fetch_error",
      url: rawUrl,
      error: passthroughFetchError(rawUrl),
      reason: "exit",
    };
  }

  // 1. Scheme allowlist — http and https only
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      kind: "fetch_error",
      url: rawUrl,
      error: `URL scheme "${parsed.protocol}" not allowed (only http: and https:)`,
      reason: "exit",
    };
  }

  const strict = process.env.CTX_FETCH_STRICT === "1";

  // 2. DNS resolve + check IP ranges (hard-block + optional strict-mode block)
  try {
    const { lookup } = await import("node:dns/promises");
    const records = await lookup(parsed.hostname, { all: true, verbatim: true });
    for (const rec of records) {
      const verdict = classifyIp(rec.address);
      if (verdict === "block") {
        return {
          kind: "fetch_error",
          url: rawUrl,
          error: `URL "${parsed.hostname}" resolves to ${rec.address} — blocked (link-local / IMDS / multicast / reserved)`,
          reason: "exit",
        };
      }
      if (verdict === "private" && strict) {
        return {
          kind: "fetch_error",
          url: rawUrl,
          error: `URL "${parsed.hostname}" resolves to private IP ${rec.address} — blocked under CTX_FETCH_STRICT=1`,
          reason: "exit",
        };
      }
    }
  } catch (err) {
    // libuv DNS error codes that typically indicate the resolver itself can't
    // reach a nameserver — common when the MCP host process is running under
    // a sandbox that blocks outbound network, OR a transient upstream DNS
    // hiccup. Append an imperative retry hint so the agent does not capitulate
    // to training data on the FIRST transient failure (PR #654 substitute —
    // sibling-tool consistency with hooks/core/routing.mjs WebFetch wording).
    const errCode = (err as NodeJS.ErrnoException | undefined)?.code ?? "";
    const isTransientDns = errCode === "ETIMEOUT" || errCode === "ETIMEDOUT" ||
      errCode === "EAI_AGAIN" || errCode === "ENETUNREACH" || errCode === "EPERM";
    const baseMsg = err instanceof Error ? err.message : String(err);
    const hint = isTransientDns
      ? " — transient DNS error; retry once before falling back. If it keeps failing, the MCP host may be running under a network sandbox; restart the host with network access enabled."
      : "";
    return {
      kind: "fetch_error",
      url: rawUrl,
      error: `DNS lookup failed for "${parsed.hostname}": ${baseMsg}${hint}`,
      reason: "exit",
    };
  }

  return null; // safe to fetch
}

/**
 * Classify an IP address.
 *   - "block":    always blocked (link-local/IMDS/multicast/reserved/malformed)
 *   - "private":  loopback or RFC1918 — allowed by default, blocked in strict mode
 *   - "public":   safe to fetch
 *
 * Exported (via the function name) so SSRF tests can exercise the matcher directly.
 */
export function classifyIp(rawIp: string): "block" | "private" | "public" {
  // RFC 6874 zone identifiers (`fe80::1%eth0`, URL-encoded `%25eth0`) must
  // be stripped BEFORE any prefix/equality classification. Without the strip,
  // a loopback `::1%eth0` no longer matches `lower === "::1"` and falls
  // through to "public" — silently bypassing the SSRF guard. Strip first,
  // classify second.
  const pctIdx = rawIp.indexOf("%");
  const ip = pctIdx === -1 ? rawIp : rawIp.slice(0, pctIdx);
  const lower = ip.toLowerCase();

  // IPv6 takes priority — check for `:` first so IPv4-mapped addresses
  // (`::ffff:127.0.0.1`) don't get incorrectly routed through the IPv4 parser.
  if (lower.includes(":")) {
    // IPv4-mapped IPv6 (`::ffff:127.0.0.1`) — recurse through IPv4 classifier
    const v4MappedMatch = lower.match(/^::ffff:([\d.]+)$/);
    if (v4MappedMatch) return classifyIp(v4MappedMatch[1]);
    // Hard-block
    if (lower === "::") return "block"; // unspecified
    if (lower.startsWith("fe8") || lower.startsWith("fe9") ||
        lower.startsWith("fea") || lower.startsWith("feb")) return "block"; // fe80::/10 link-local
    if (lower.startsWith("ff")) return "block"; // ff00::/8 multicast
    // Private (loopback + ULA)
    if (lower === "::1") return "private";
    if (lower.startsWith("fc") || lower.startsWith("fd")) return "private"; // fc00::/7 ULA
    return "public";
  }

  // IPv4 (or non-IP string — malformed = block)
  if (!ip.includes(".")) return "block"; // not an IP at all
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return "block";
  const [a, b] = parts;
  // Hard-block (no legitimate use)
  if (a === 169 && b === 254) return "block"; // link-local incl. 169.254.169.254 (IMDS)
  if (a === 0) return "block";                 // 0.0.0.0/8 (current network)
  if (a >= 224) return "block";                // 224.0.0.0+ multicast/reserved
  // Private (loopback + RFC1918) — allow by default
  if (a === 127) return "private";                          // 127.0.0.0/8 loopback
  if (a === 10) return "private";                           // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return "private";    // 172.16.0.0/12
  if (a === 192 && b === 168) return "private";             // 192.168.0.0/16
  return "public";
}

async function fetchOneUrl(url: string, source: string | undefined, force: boolean | undefined, ttl: number | undefined): Promise<FetchOneResult> {
  // SSRF guard — reject file://, javascript:, loopback, RFC1918, IMDS, link-local
  // BEFORE any cache lookup or subprocess spawn. Even cached entries shouldn't
  // serve a previously-poisoned source label.
  const ssrfBlock = await ssrfGuard(url);
  if (ssrfBlock) return ssrfBlock;

  if (!force && ttl !== 0) {
    const store = deps.getStore();
    // Cache key composes (source, url) so two distinct URLs sharing the same
    // `source` label do not collide — they each get their own cache slot
    // (commit 1f1243e regression test enforced).
    const cacheKey = composeFetchCacheKey(source, url);
    const meta = store.getSourceMeta(cacheKey);
    if (meta) {
      const indexedAt = new Date(meta.indexedAt + "Z"); // SQLite datetime is UTC without Z
      const ageMs = Date.now() - indexedAt.getTime();
      const cacheTtlMs = ttl ?? FETCH_TTL_MS;
      if (ageMs < cacheTtlMs) {
        const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
        const ageMin = Math.floor(ageMs / (60 * 1000));
        const ageStr = ageHours > 0 ? `${ageHours}h ago` : ageMin > 0 ? `${ageMin}m ago` : "just now";
        const estimatedBytes = meta.chunkCount * 1600; // ~1.6KB/chunk avg
        return { kind: "cached", label: meta.label, chunkCount: meta.chunkCount, estimatedBytes, ageStr, ttlStr: formatFetchTtl(cacheTtlMs) };
      }
      // Stale — fall through to re-fetch silently
    }
  }

  const outputPath = join(tmpdir(), `ctx-fetch-${Date.now()}-${Math.random().toString(36).slice(2)}.dat`);
  try {
    const fetchCode = deps.buildFetchCode(url, outputPath);
    const result = await deps.executor.execute({
      language: "javascript",
      code: fetchCode,
      timeout: 30_000,
      env: buildFetchEnv(),
    });
    if (result.exitCode !== 0) {
      // Subprocess fetch failure — undici / fetch can surface EAI_AGAIN /
      // ETIMEDOUT / ENETUNREACH in stderr when the resolver is overloaded
      // or the network is briefly unavailable. Append the same retry hint
      // ssrfGuard's pre-flight DNS path emits so the agent doesn't capitulate
      // to training data on the first transient failure (PR #654 substitute —
      // sibling-tool consistency with hooks/core/routing.mjs WebFetch wording).
      const raw = result.stderr || result.stdout || "unknown error";
      const isTransientDns = /\b(EAI_AGAIN|ETIMEDOUT|ETIMEOUT|ENETUNREACH|EPERM|getaddrinfo)\b/.test(raw);
      const hint = isTransientDns
        ? " — transient DNS error; retry once before falling back. If it keeps failing, the MCP host may be running under a network sandbox; restart the host with network access enabled."
        : "";
      return { kind: "fetch_error", url, error: `${raw}${hint}`, reason: "exit" };
    }
    // Line 0 is the __CM_CT__ marker (unchanged contract). Line 1, when
    // present, is the pre-conversion byte count the subprocess received.
    const stdoutLines = (result.stdout || "").trim().split("\n");
    const header = (stdoutLines[0] || "").trim();
    const sourceBytes = Number.parseInt((stdoutLines[1] || "").trim(), 10);
    // Line 2 is the route. Absent (older bundle) means "we converted HTML",
    // which is the conservative reading: it keeps classification switched on.
    const route = parseFetchRoute((stdoutLines[2] || "").trim());
    // Line 3 is which rung of the ladder answered; line 4 is the rung-2 urls
    // that were requested. Both are absent on an older bundle, which reads as
    // "not reported" rather than as "none" — we never invent evidence.
    const rung = (stdoutLines[3] || "").trim() || "unreported";
    const ladderTried = parseLadderTried(stdoutLines[4] || "");
    let markdown: string;
    try {
      // Parent-side defense-in-depth on the subprocess output size. The
      // embedded safeText() in buildFetchCode already caps before writing,
      // but a torn write (subprocess killed mid-write, fs cache desync,
      // etc.) could still leave an oversized file. Bail before slurping
      // multiple gigabytes into the long-running MCP server's heap.
      const MAX_FETCH_OUTPUT_BYTES = 50 * 1024 * 1024;
      const fileSize = statSync(outputPath).size;
      if (fileSize > MAX_FETCH_OUTPUT_BYTES) {
        return { kind: "fetch_error", url, error: `subprocess output ${fileSize} bytes exceeds cap ${MAX_FETCH_OUTPUT_BYTES}`, reason: "read" };
      }
      markdown = readFileSync(outputPath, "utf-8").trim();
    } catch {
      return { kind: "fetch_error", url, error: "could not read subprocess output", reason: "read" };
    }
    if (markdown.length === 0) {
      return { kind: "fetch_error", url, error: "empty content", reason: "empty" };
    }
    // Non-empty is not the same as non-shell. Refuse to index a bootstrap
    // shell as if it were the page, and say exactly why so the agent does not
    // simply retry the same URL and get the same 21 bytes.
    const verdict = classifyExtraction(markdown.length, sourceBytes);
    if (verdict.kind === "shell") {
      // Rung 5 — the honest refusal. Every rung above it has now been tried,
      // and the message names the urls that were requested so the caller does
      // not go hunting for files the ladder already asked for.
      const climbed = ladderTried.length > 0
        ? ` The ladder was climbed first and every rung came back empty: ${ladderTried.join(", ")}.`
        : "";
      return {
        kind: "fetch_error",
        url,
        error:
          `extracted only ${verdict.textBytes} bytes of text from ${verdict.sourceBytes} bytes received ` +
          `(${verdict.yieldPct}% yield) — the response was a shell whose content is rendered client-side ` +
          `by JavaScript, so an HTTP fetch cannot see it. Nothing was indexed (the response is stored ` +
          `whole and unaltered).${climbed} Retrying this URL returns the same shell. Fetch this page's ` +
          `source instead: its repository README or raw doc file on GitHub, its OpenAPI or JSON schema ` +
          `endpoint, or a sibling page of the same host that is server-rendered.`,
        reason: "shell",
      };
    }
    return { kind: "fetched", url, source, markdown, header, route, rung };
  } catch (err: unknown) {
    return {
      kind: "fetch_error",
      url,
      error: err instanceof Error ? err.message : String(err),
      reason: "throw",
    };
  } finally {
    try { rmSync(outputPath); } catch { /* already gone */ }
  }
}

interface IndexedFetchResult {
  label: string;
  totalChunks: number;
  totalBytes: number;
  preview: string;
  /** Set when the page carried no page-specific content and was not indexed. */
  refusal?: string;
  /** One line of extraction accounting, or undefined when nothing was classified. */
  extraction?: string;
}

/**
 * Map the subprocess's route line onto the typed route. Unknown or missing
 * values read as "html" — the conservative direction, because it leaves
 * template classification switched on rather than trusting an unverified
 * document as site-authored.
 */
function parseFetchRoute(raw: string): FetchRoute {
  if (raw === "markdown") return "markdown";
  if (raw === "json") return "json";
  if (raw === "text") return "text";
  return "html";
}

/**
 * The rung-2 urls the subprocess requested. An unparseable or absent line
 * yields an empty list, which the refusal reads as "not reported" — it never
 * claims urls were tried when there is no evidence that they were.
 */
export function parseLadderTried(raw: string): string[] {
  const line = raw.trim();
  if (line.length === 0) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const entry of parsed) if (typeof entry === "string" && entry.length > 0) out.push(entry);
  return out;
}

/**
 * How the ladder's rung ids read in a report. The point of a ladder is that a
 * reader can see WHICH step paid for this page, so every fetch says so.
 */
export function describeRung(rung: string): string {
  if (rung === "1-accept-markdown") return "rung 1 — the site served markdown to the Accept header on the request we were already making";
  if (rung === "1-html-converted") return "rung 1 — the site served HTML and it converted to an article";
  if (rung === "1-json-passthrough") return "rung 1 — JSON response, indexed as-is";
  if (rung === "1-text-passthrough") return "rung 1 — plain-text response, indexed as-is";
  if (rung === "2a-md-sibling") return "rung 2a — rung 1 returned a JavaScript shell, and the page's .md sibling carried the article";
  if (rung === "2b-llms-txt") return "rung 2b — rung 1 returned a JavaScript shell, and this host's llms.txt named the article elsewhere";
  if (rung === "ladder-exhausted") return "ladder exhausted — every rung came back empty";
  if (rung === "unreported") return "rung not reported (older fetch bundle)";
  return `rung ${rung}`;
}

/**
 * Per-project store holding every fetched document whole, plus every block
 * with its content/template label. Lives beside the FTS content DB so the
 * existing cleanup and purge sweeps reach it.
 */
let _pageStore: PageStore | null = null;
function getPageStore(): PageStore {
  if (!_pageStore) {
    _pageStore = new PageStore(join(dirname(deps.getStorePath()), "fetch-pages.db"));
  }
  return _pageStore;
}

/**
 * Serial-only indexing step — single FTS5 write per call. Caller loops over
 * fetched results and calls this one-at-a-time to avoid SQLite WAL contention
 * (PRD finding E).
 */
function indexFetched(f: { url: string; source?: string; markdown: string; header: string; route?: FetchRoute; rung?: string }): IndexedFetchResult {
  const store = deps.getStore();
  // Storage label composed via composeFetchCacheKey so two URLs sharing a
  // `source` label do not overwrite each other (commit 1f1243e). ctx_search()
  // still finds both via LIKE-mode source filter on the `source` substring.
  const storageLabel = composeFetchCacheKey(f.source, f.url);
  const attribution = deps.currentAttribution();
  const route = f.route ?? "html";
  const rungId = f.rung ?? "unreported";

  // ── Template / content extraction ────────────────────────────────────
  // The converter answered "what format". This answers "which part of the
  // page". Chrome is what repeats across pages of the same host; content is
  // what does not. The page is stored WHOLE either way — this pass only ever
  // decides which blocks reach the search index.
  let indexText = f.markdown;
  let extraction: string | undefined;
  let relabelled: Relabelled[] = [];
  if (!routeSkipsExtraction(route)) {
    try {
      const outcome = extractAndStore({
        url: f.url,
        sourceLabel: storageLabel,
        document: f.markdown,
        route,
        store: getPageStore(),
      });
      if (outcome.kind === "refuse") {
        // Rung 5 — the honest refusal, with the rung that produced the document
        // named so the reader can see how far the ladder got.
        return {
          label: storageLabel,
          totalChunks: 0,
          totalBytes: outcome.storedBytes,
          preview: "",
          refusal: `${describeRung(rungId)}; ${outcome.reason}`,
        };
      }
      indexText = outcome.indexText;
      relabelled = outcome.relabelled;
      if (route === "markdown") {
        extraction =
          `${describeRung(rungId)}; site-authored markdown (${outcome.storedBytes} B) — no extraction needed`;
      } else if (outcome.provisional) {
        extraction =
          `${describeRung(rungId)}; rung 4 (block classification) — first page seen from this host, so all ${outcome.totalBlocks} blocks ` +
          `were indexed as content (PROVISIONAL); they are re-classified automatically when a second ` +
          `page of this host is fetched`;
      } else {
        extraction =
          `${describeRung(rungId)}; rung 4 (block classification) — ${outcome.totalBlocks - outcome.templateBlocks}/${outcome.totalBlocks} ` +
          `blocks indexed as content (${outcome.contentBytes} B); ${outcome.templateBlocks} blocks ` +
          `(${outcome.templateBytes} B) were seen on other pages of this host, so they are labelled ` +
          `template — stored whole, kept out of the index`;
      }
    } catch (err: unknown) {
      // Extraction is an optimisation on top of a working fetch. If the block
      // store cannot be opened, index the whole document exactly as before
      // rather than losing the page — and say so instead of failing silently.
      extraction =
        `extraction unavailable (${err instanceof Error ? err.message : String(err)}) — indexed the full document`;
      indexText = f.markdown;
    }
  }

  let indexed: IndexResult;
  if (f.header === "__CM_CT__:json") {
    indexed = store.indexJSON(f.markdown, storageLabel, undefined, attribution);
  } else if (f.header === "__CM_CT__:text") {
    indexed = store.indexPlainText(f.markdown, storageLabel, undefined, attribution);
  } else {
    indexed = store.index({ content: indexText, source: storageLabel, attribution });
  }
  // A second page of a host resolves the cold-start labelling of every page
  // that preceded it. store.index() replaces rows sharing a label, so this
  // re-index swaps the provisional content for the classified content.
  for (const prev of relabelled) {
    try {
      store.index({ content: prev.indexText, source: prev.sourceLabel, attribution });
    } catch { /* a re-run failure leaves the earlier, larger index in place */ }
  }
  if (relabelled.length > 0) {
    extraction = (extraction ? extraction + "; " : "") +
      `re-classified ${relabelled.length} earlier page(s) of this host now that a second page exists`;
  }
  // Track AFTER the FTS5 write succeeds — failed indexes shouldn't inflate the counter.
  deps.trackIndexed(Buffer.byteLength(f.markdown));
  const preview = indexText.length > FETCH_PREVIEW_LIMIT
    ? charSafePrefix(indexText, FETCH_PREVIEW_LIMIT) + "\n\n…[preview window only — the full document is stored; use ctx_search() to retrieve any section]"
    : indexText;
  return {
    label: indexed.label,
    totalChunks: indexed.totalChunks,
    totalBytes: Buffer.byteLength(f.markdown),
    preview,
    extraction,
  };
}

/** Register `ctx_fetch_and_index` on the server carried by `deps`. */
export function registerCtxFetch(d: FetchToolDeps): void {
  deps = d;
  const { trackResponse, getSessionDbPath, coerceJsonArray, coerceBoolean } = d;

  d.server.registerTool(
    "ctx_fetch_and_index",
    {
      title: "Fetch & Index URL(s)",
      // #846: fetches external URLs (open world) and writes them into the store.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      description: `Fetches URL content, converts HTML to markdown (JSON is chunked by key paths, plain text indexed directly), persists it in a searchable knowledge base, and returns a small preview window per source. The raw page bytes never enter your conversation — they live in storage and you retrieve any section on-demand via ctx_search.

Caching: every fetch is cached on disk and reused for repeat calls within the TTL window. The default TTL is 24 hours; override per-call with the \`ttl\` parameter (milliseconds, \`ttl: 0\` bypasses cache like \`force: true\`). Stored content older than 14 days is cleaned up on startup.

WHEN:
  - You need web content (docs, changelogs, API references, spec pages) and the raw page bytes should NOT enter your conversation
  - Multi-URL research (library evaluation, migration scans, doc comparisons): pass the \`requests\` array and a \`concurrency\` value 2-8 for parallel I/O
  - You want repeat lookups against the same URL to be cheap (TTL cache hits return only a hint, no re-fetch)
  - You want a long-lived cache window (override \`ttl\` upward for stable specs) or a guaranteed-fresh fetch (\`ttl: 0\` or \`force: true\`)

SPA pages: fetch them the same way. There is no headless browser, and measurement says none is needed — over 36 documentation pages, 4 had the article absent from the HTTP response and 4 of 4 were recovered without executing JavaScript. The fetch climbs a ladder in cost order and tells you which rung answered: (1) \`Accept: text/markdown\` on the request it was already making, (2a) the page's \`.md\` sibling, (2b) the host's llms.txt, (4) block classification against other pages of the same host, (5) a refusal naming the urls it already tried. Rungs past 1 cost a request only when the cheaper rung returned a JavaScript shell.

WHEN NOT:
  - You already have the content locally — store it via the inline index tool
  - The page is an application rather than a document (a whiteboard, a diagram editor, a dashboard) — there is no article to fetch, and the fetch will say so rather than index the shell

RETURNS:
  Per-source preview windows extracted around indexable headings plus indexing metadata (chunk counts, source labels, cache state). Raw content is NOT echoed back — retrieve any section on-demand via ctx_search(source: "<label>"). Concurrency parallelizes the fetch phase up to your chosen value (capped by the host's logical CPU count); the FTS5 write phase always runs serially because SQLite is a single-writer store. Net latency = max(fetch latency across the pool) + sum(per-source index write time). Cache hits skip both phases and return a small freshness hint instead of re-fetching. Use 4-8 for stable I/O-bound batches; lower the value when the target host enforces a per-IP rate limit you cannot raise.

EXAMPLE: ctx_fetch_and_index(
  requests: [{url: "https://react.dev/...", source: "react"}, {url: "https://vuejs.org/...", source: "vue"}],
  concurrency: 5
)`,
      inputSchema: z.object({
        url: z.string().optional().describe("Single URL to fetch and index (legacy single-shape)"),
        source: z
          .string()
          .optional()
          .describe(
            "Label for the indexed content when using single `url` (e.g., 'React useEffect docs', 'Supabase Auth API'). For batch, put source in each requests entry.",
          ),
        requests: z
          .preprocess(
            coerceJsonArray,
            z.array(
              z.object({
                url: z.string().describe("URL to fetch"),
                source: z.string().optional().describe("Label for this URL's indexed content"),
              }),
            ).min(1),
          )
          .optional()
          .describe(
            "Batch shape: array of {url, source?} entries. Use with concurrency>1 for parallel fetch. " +
            "Each request indexed under its own source label. Output preserves input order.",
          ),
        concurrency: z
          .coerce.number()
          .int()
          .min(1)
          .max(8)
          .optional()
          .default(1)
          .describe(
            "Max URLs to fetch in parallel (1-8, default: 1). " +
            "Use 4-8 for I/O-bound multi-URL batches (library docs, changelogs, pricing pages). " +
            "Capped by os.cpus().length on small machines (response notes when capped). " +
            "Indexing is always serial regardless — only fetches race.",
          ),
        force: z
          .preprocess(coerceBoolean, z.boolean())
          .optional()
          .describe("Skip cache and re-fetch even if content was recently indexed"),
        ttl: z
          .coerce.number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Override the cache freshness window for this call, in milliseconds. " +
            "`ttl: 0` bypasses the cache like `force: true`; omit to use the default 24h TTL.",
          ),
      }),
    },
    async ({ url, source, requests, concurrency, force, ttl }) => {
      // Normalize input: legacy {url} or new {requests: [...]}.
      // requests wins when both are provided (explicit batch intent).
      const batch: { url: string; source?: string }[] = requests
        ? requests
        : url
          ? [{ url, source }]
          : [];

      if (batch.length === 0) {
        return trackResponse("ctx_fetch_and_index", {
          content: [{
            type: "text" as const,
            text: "ctx_fetch_and_index requires either `url` (single) or `requests: [{url, source?}, ...]` (batch).",
          }],
          isError: true,
        });
      }

      const isLegacySingle = !requests && batch.length === 1;
      const requestedConcurrency = concurrency ?? 1;

      // Parallel fetch via shared runPool primitive. capByCpuCount only for batch
      // — single-URL doesn't need the cap (only one job, executor is one subprocess).
      const jobs: PoolJob<FetchOneResult>[] = batch.map((req) => ({
        run: () => fetchOneUrl(req.url, req.source, force, ttl),
      }));
      const { settled, effectiveConcurrency, capped } = await runPool(jobs, {
        concurrency: requestedConcurrency,
        capByCpuCount: !isLegacySingle && requestedConcurrency > 1,
      });

      // Serial index drain — workers race on fetch, but store.index* runs one at a time.
      type Finalized =
        | { kind: "cached"; label: string; chunkCount: number; ageStr: string; ttlStr: string }
        | { kind: "fetched"; indexed: IndexedFetchResult }
        | { kind: "fetch_error"; url: string; error: string; reason: "exit" | "read" | "empty" | "shell" | "throw" }
        | { kind: "job_error"; url: string; error: string };

      const finalized: Finalized[] = [];
      for (let i = 0; i < settled.length; i++) {
        const r = settled[i];
        if (r.status === "rejected") {
          const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
          finalized.push({ kind: "job_error", url: batch[i].url, error: message });
          continue;
        }
        const v = r.value;
        if (v.kind === "cached") {
          sessionStats.cacheHits++;
          sessionStats.cacheBytesSaved += v.estimatedBytes;
          // D2 Phase 5/7 — cache-hit event emission. `bytes_avoided` is the
          // size of the cached payload that would have re-entered context
          // had the TTL window missed. Best-effort, off the hot path.
          const cachedBytes = v.estimatedBytes;
          const cachedLabel = v.label;
          setImmediate(() =>
            emitCacheHitEvent({
              sessionDbPath: getSessionDbPath(),
              source: cachedLabel,
              bytesAvoided: cachedBytes,
            })
          );
          finalized.push({ kind: "cached", label: v.label, chunkCount: v.chunkCount, ageStr: v.ageStr, ttlStr: v.ttlStr });
        } else if (v.kind === "fetch_error") {
          finalized.push({ kind: "fetch_error", url: v.url, error: v.error, reason: v.reason });
        } else {
          // Serial FTS5 write here — no parallel store.index calls.
          // Cache miss: the URL was not in the TTL window so we paid the
          // network round-trip + re-indexed. Counted here so ctx_stats can
          // report nominal cache_hit_rate alongside the existing hit metrics.
          sessionStats.cacheMisses++;
          const indexed = indexFetched(v);
          // Honest refusal. A page whose every block already exists on other
          // pages of this host carried no page-specific content, and reporting
          // that as a success would hand the caller a site shell dressed as an
          // article. On an error the model tries another route; on a false
          // success it stops looking.
          if (indexed.refusal) {
            finalized.push({ kind: "fetch_error", url: v.url, error: indexed.refusal, reason: "shell" });
          } else {
            finalized.push({ kind: "fetched", indexed });
          }
        }
      }

      // Backward-compat single-URL response shape — preserve the EXACT original wording.
      if (isLegacySingle) {
        const r = finalized[0];
        if (r.kind === "cached") {
          return trackResponse("ctx_fetch_and_index", {
            content: [{
              type: "text" as const,
              text: `Cached: **${r.label}** — ${r.chunkCount} sections, indexed ${r.ageStr} (fresh, TTL: ${r.ttlStr}).\nTo refresh: call ctx_fetch_and_index again with \`force: true\`.\n\nYou MUST call ctx_search() to answer questions about this content — this cached response contains no content.\nUse: ctx_search(queries: [...], source: "${r.label}")`,
            }],
          });
        }
        if (r.kind === "fetched") {
          const totalKB = (r.indexed.totalBytes / 1024).toFixed(1);
          const text = [
            `Fetched and indexed **${r.indexed.totalChunks} sections** (${totalKB}KB) from: ${r.indexed.label}`,
            `Full content indexed in sandbox — use ctx_search(queries: [...], source: "${r.indexed.label}") for specific lookups.`,
            ...(r.indexed.extraction ? [r.indexed.extraction] : []),
            "",
            "---",
            "",
            r.indexed.preview,
          ].join("\n");
          return trackResponse("ctx_fetch_and_index", {
            content: [{ type: "text" as const, text }],
          });
        }
        // fetch_error — preserve original error wording per reason
        if (r.kind === "fetch_error") {
          const text =
            r.reason === "empty" ? `Fetched ${r.url} but got empty content`
            : r.reason === "shell" ? `Fetched ${r.url} but ${r.error}`
            : r.reason === "read" ? `Fetched ${r.url} but could not read subprocess output`
            : r.reason === "exit" ? `Failed to fetch ${r.url}: ${r.error}`
            : /* throw */         `Fetch error: ${r.error}`;
          return trackResponse("ctx_fetch_and_index", {
            content: [{ type: "text" as const, text }],
            isError: true,
          });
        }
        // job_error
        return trackResponse("ctx_fetch_and_index", {
          content: [{ type: "text" as const, text: `Fetch error: ${r.error}` }],
          isError: true,
        });
      }

      // Batch response — aggregated summary; isError only when EVERY URL failed.
      // Per-URL preview capped tightly so a 8-URL batch doesn't undo the
      // context-savings the tool exists to deliver (PRD review finding G1).
      const FETCH_BATCH_PREVIEW_LIMIT = 384; // ~3KB total for 8-URL batches
      const lines: string[] = [];
      let totalSections = 0;
      let totalBytes = 0;
      let cachedCount = 0;
      let fetchedCount = 0;
      let errorCount = 0;
      const snippets: string[] = [];
      for (const r of finalized) {
        if (r.kind === "cached") {
          cachedCount++;
          lines.push(`- [cache] ${r.label} — ${r.chunkCount} sections (${r.ageStr}, TTL: ${r.ttlStr})`);
        } else if (r.kind === "fetched") {
          fetchedCount++;
          totalSections += r.indexed.totalChunks;
          totalBytes += r.indexed.totalBytes;
          const kb = (r.indexed.totalBytes / 1024).toFixed(1);
          lines.push(`- [new]   ${r.indexed.label} — ${r.indexed.totalChunks} sections (${kb}KB)`);
          const snippet = r.indexed.preview.length > FETCH_BATCH_PREVIEW_LIMIT
            ? r.indexed.preview.slice(0, FETCH_BATCH_PREVIEW_LIMIT).trimEnd() + "…"
            : r.indexed.preview;
          snippets.push(`### ${r.indexed.label}\n\n${snippet}`);
        } else {
          errorCount++;
          lines.push(`- [err]   ${r.url}: ${r.error}`);
        }
      }

      const totalKB = (totalBytes / 1024).toFixed(1);
      const cappedNote = capped
        ? ` cap=${effectiveConcurrency}/${cpus().length}cpu`
        : "";
      // Status line: counts + sections + size, with singular/plural agreement
      // (count=1 → "1 error" not "1 errors") so the line stays grammatical.
      const fmt = (n: number, sing: string, plur: string) => `${n} ${n === 1 ? sing : plur}`;
      const headerLine =
        `fetched ${batch.length} c=${effectiveConcurrency}${cappedNote}. ` +
        `ok=${fetchedCount} cache=${cachedCount} err=${errorCount}. ` +
        `${fmt(totalSections, "section", "sections")} ${totalKB}KB.`;

      const text = [
        headerLine,
        "",
        ...lines,
        "",
        `ctx_search(queries: [...], source: "<label>") for full content.`,
        ...(snippets.length > 0 ? ["", "---", "", ...snippets] : []),
      ].join("\n");

      return trackResponse("ctx_fetch_and_index", {
        content: [{ type: "text" as const, text }],
        isError: errorCount === batch.length, // only mark error if every URL failed
      });
    },
  );
}
