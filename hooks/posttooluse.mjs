#!/usr/bin/env node
/**
 * PostToolUse hook for context-mode session continuity.
 *
 * Captures session events from tool calls (13 categories) and stores
 * them in the per-project SessionDB for later resume snapshot building.
 *
 * Must be fast (<20ms). No network, no LLM, just SQLite writes.
 *
 * Crash-resilience: wrapped via runHook (#414).
 */

import { runHook } from "./run-hook.mjs";

await runHook(async () => {
  const {
    readStdin,
    parseStdin,
    getSessionId,
    getSessionDBPath,
    getInputProjectDir,
  } = await import("./session-helpers.mjs");
  const { createSessionLoaders, attributeAndInsertEvents } = await import("./session-loaders.mjs");
  const { dirname, resolve, basename } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { readFileSync, unlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  // Resolve absolute path for imports — relative dynamic imports can fail
  // when Claude Code invokes hooks from a different working directory.
  const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
  const { loadSessionDB, loadExtract, loadProjectAttribution } = createSessionLoaders(HOOK_DIR);

  // Declared out here so a failure in any later best-effort block cannot
  // swallow a notice that was already built: the line is printed after the
  // body, not inside it.
  let costNotice = null;

  try {
    const raw = await readStdin();
    const input = parseStdin(raw);
    const projectDir = getInputProjectDir(input);

    const { extractEvents } = await loadExtract();
    const { resolveProjectAttributions } = await loadProjectAttribution();
    const { SessionDB } = await loadSessionDB();

    const dbPath = getSessionDBPath();
    const db = new SessionDB({ dbPath });
    const sessionId = getSessionId(input);

    // Ensure session meta exists
    db.ensureSession(sessionId, projectDir);

    // Extract and store events
    const events = extractEvents({
      tool_name: input.tool_name,
      tool_input: input.tool_input ?? {},
      tool_response: typeof input.tool_response === "string"
        ? input.tool_response
        : JSON.stringify(input.tool_response ?? ""),
      tool_output: input.tool_output,
    });

    attributeAndInsertEvents(db, sessionId, events, input, projectDir, "PostToolUse", resolveProjectAttributions);

    // ─── Category 18: Rejected-approach — read PreToolUse marker ───
    try {
      const rejectedPath = resolve(tmpdir(), `context-mode-rejected-${sessionId}.txt`);
      let rejectedData;
      try {
        rejectedData = readFileSync(rejectedPath, "utf-8").trim();
        unlinkSync(rejectedPath);
      } catch { /* no marker */ }
      if (rejectedData) {
        const colonIdx = rejectedData.indexOf(":");
        const rejTool = colonIdx > 0 ? rejectedData.slice(0, colonIdx) : rejectedData;
        const rejReason = colonIdx > 0 ? rejectedData.slice(colonIdx + 1) : "denied";
        // v1.0.160: route through attributeAndInsertEvents so the bridge wire
        // receives this event too. db.insertEvent only writes locally — the
        // dashboard's rejection-rate widget needs the platform row.
        attributeAndInsertEvents(
          db,
          sessionId,
          [{
            type: "rejected",
            category: "rejected-approach",
            data: `${rejTool}: ${rejReason}`,
            priority: 2,
          }],
          input,
          projectDir,
          "PreToolUse",
          resolveProjectAttributions,
        );
      }
    } catch { /* best-effort */ }

    // ─── D2 PRD Phase 3/4: redirect marker — emit byte-accounting event ───
    // PreToolUse wrote `context-mode-redirect-${sessionId}.txt` for tools whose
    // output we kept out of the model's context window (curl/wget, WebFetch,
    // large Read). Format: `tool:type:bytesAvoided:commandSummary` (Override C).
    let redirectEmitted = false;
    try {
      // Shared marker reader (hooks/core/routing.mjs) — the Codex hooks use
      // the same one, so an accounting rule cannot hold on one host and not
      // the other.
      const { consumeRedirectMarker, READ_EDIT_EXEMPT_TYPE } = await import("./core/routing.mjs");
      const marker = consumeRedirectMarker(sessionId);
      if (marker) {
        // "Routed, and saved nothing" — the read-before-edit retry that
        // PreToolUse promised would go through. It has to suppress the
        // missed-redirect record (otherwise taking the offered way out counts
        // as a fresh violation, which raises the tally, the cost line and the
        // escalation step — a loop that feeds itself) while claiming no
        // saving, because the bytes really did arrive.
        if (marker.type === READ_EDIT_EXEMPT_TYPE) {
          redirectEmitted = true;
        } else if (marker.bytesAvoided > 0) {
          // v1.0.160: route through wire — the context-saving widget on the
          // platform reads category='redirect' rows, and bytes_avoided is
          // stamped by the bytesList branch in attributeAndInsertEvents.
          attributeAndInsertEvents(
            db,
            sessionId,
            [{
              type: marker.type,
              category: "redirect",
              data: `${marker.tool}: ${marker.summary}`,
              priority: 2,
              bytes_avoided: marker.bytesAvoided,
            }],
            input,
            projectDir,
            "PreToolUse",
            resolveProjectAttributions,
          );
          redirectEmitted = true;
        }
      }
    } catch { /* best-effort — never block hook */ }

    // ─── Missed-redirect telemetry: what got through unrouted ───
    // ctx_stats can show what routing SAVED; it has never shown what routing
    // MISSED. Without that half, the allowlist and the nudge thresholds can
    // only be tuned by guesswork. Any native data-fetching tool that returned
    // more than the threshold WITHOUT a redirect marker is, by definition, a
    // payload that entered the context window whole — record it so the
    // allowlist and thresholds have evidence behind them.
    //
    // The classification lives in hooks/core/routing.mjs so the Codex hook
    // records the same population against the same floor: two hosts, one
    // definition of "this went straight into the context window".
    try {
      const {
        describeMissedRedirect, readMissedRedirectTally, buildMissedRedirectNotice,
        writeUnroutedTally,
      } = await import("./core/routing.mjs");
      const missed = describeMissedRedirect(input, { routed: redirectEmitted });
      if (missed) {
        attributeAndInsertEvents(
          db,
          sessionId,
          [{
            type: "missed_redirect",
            category: "missed-redirect",
            // Machine-parseable prefix (analytics reads the byte count back
            // out of it), human-readable tail.
            data: `${missed.toolName}: ${missed.bytes} bytes unrouted — ${missed.summary}`,
            priority: 3,
          }],
          input,
          projectDir,
          "PostToolUse",
          resolveProjectAttributions,
        );
        // Tally AFTER the insert, so the count the model reads is the count
        // ctx_stats will report for the same session — including this call,
        // and excluding it in the one case the store deduplicated it away.
        const tally = readMissedRedirectTally(db, sessionId);
        // Hand the same two numbers to PreToolUse, which prices its next
        // decision on them and cannot afford to open SQLite itself.
        writeUnroutedTally(sessionId, tally);
        costNotice = buildMissedRedirectNotice({
          toolName: missed.toolName,
          bytes: missed.bytes,
          tally,
          platform: "claude-code",
        });
      }
    } catch { /* telemetry is best-effort — never block the hook */ }

    // ─── Code index queue: record files the agent just wrote or edited ───
    // One append, no SQLite: the MCP server drains this queue the next time
    // it opens the content store (src/session/code-index.ts). Keeps the hook
    // inside its <20ms budget while making the source tree searchable.
    try {
      if (process.env.CONTEXT_MODE_CODE_INDEX !== "0") {
        const toolName = input.tool_name ?? "";
        if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit" || toolName === "NotebookEdit") {
          const ti = input.tool_input ?? {};
          const filePath = ti.file_path ?? ti.notebook_path ?? ti.path;
          if (typeof filePath === "string" && filePath) {
            const { appendFileSync } = await import("node:fs");
            appendFileSync(resolve(dirname(dbPath), "code-index-queue.txt"), filePath + "\n", "utf-8");
          }
        }
      }
    } catch { /* queueing is best-effort */ }

    // ─── Category 27: Latency — read cross-hook marker and emit event if slow ───
    try {
      const toolName = input.tool_name ?? "";
      if (toolName) {
        const markerPath = resolve(tmpdir(), `context-mode-latency-${sessionId}-${toolName}.txt`);
        let startTime;
        try {
          startTime = parseInt(readFileSync(markerPath, "utf-8").trim(), 10);
          unlinkSync(markerPath);
        } catch {
          // No marker — pretooluse didn't write one or already consumed
        }
        if (startTime && !isNaN(startTime)) {
          const duration = Date.now() - startTime;
          if (duration > 5000) {
            // v1.0.160: route through wire — slow-tool insights need this row.
            attributeAndInsertEvents(
              db,
              sessionId,
              [{
                type: "tool_latency",
                category: "latency",
                data: `${toolName}: ${duration}ms`,
                priority: 3,
              }],
              input,
              projectDir,
              "PostToolUse",
              resolveProjectAttributions,
            );
          }
        }
      }
    } catch { /* latency tracking is best-effort */ }

    // ─── Retrieval bridge: emit the "With context-mode" (bytes_retrieved) row ───
    // The MCP server appended ctx_search / ctx_fetch_and_index response bytes to
    // a marker keyed by the session DB basename (the hook NEVER fires for the
    // plugin's own MCP tools, so this is the only place that signal can enter
    // the forward stream). Consume + emit one forwardable event so the platform
    // kept_out_pct goes "measured". Mirrors the redirect-marker handshake above.
    try {
      const marker = resolve(tmpdir(), `context-mode-retrieval-${basename(dbPath)}.txt`);
      let retrievedBytes = 0;
      try {
        const raw = readFileSync(marker, "utf-8");
        for (const line of raw.split("\n")) {
          const n = parseInt(line, 10);
          if (Number.isFinite(n) && n > 0) retrievedBytes += n;
        }
        unlinkSync(marker); // consume-once — next fire cannot re-forward
      } catch { /* no marker — phantom-event guard */ }
      if (retrievedBytes > 0) {
        // session-loaders stamps bytes_retrieved onto the platform payload from
        // this in-memory field (session_events has no such column — forward-only).
        attributeAndInsertEvents(
          db,
          sessionId,
          [{
            type: "mcp_tool_call",
            category: "retrieval",
            data: `retrieval: ${retrievedBytes} bytes accessed`,
            priority: 2,
            bytes_retrieved: retrievedBytes,
          }],
          input,
          projectDir,
          "PostToolUse",
          resolveProjectAttributions,
        );
      }
    } catch { /* best-effort — never block the hook */ }

    // ─── ctx_find ranking feedback: which candidate the caller actually opened ───
    // fff's ranking learns from `trackQuery(query, selectedFile)`, and MCP
    // cannot supply the second half: the protocol never tells the server what
    // the caller did next. So ctx_find publishes what it SHOWED
    // (`context-mode-find-<db>.json`) and this hook — which does fire for
    // Read/Edit/Write — records which of those files was then opened. The
    // server drains the selections on the next ctx_find and performs the
    // actual trackQuery.
    //
    // Why not call trackQuery here: it needs the native fff addon, an acquired
    // finder and a lock-aware retry. None of that belongs in a <20ms hook, and
    // no hook bundle carries src/fff/**. Recording intent is two field reads
    // and one append.
    //
    // Path spelling mirrors src/search/query-marker.ts — keep the two in step.
    try {
      if (process.env.CONTEXT_MODE_FIND_TRACK !== "0") {
        const toolName = input.tool_name ?? "";
        const SELECTING_TOOLS = new Set(["Read", "Edit", "MultiEdit", "Write", "NotebookEdit"]);
        if (SELECTING_TOOLS.has(toolName)) {
          const ti = input.tool_input ?? {};
          const filePath = ti.file_path ?? ti.notebook_path ?? ti.path;
          if (typeof filePath === "string" && filePath) {
            const candidatesPath = resolve(tmpdir(), `context-mode-find-${basename(dbPath)}.json`);
            let records = [];
            try {
              records = JSON.parse(readFileSync(candidatesPath, "utf-8"));
            } catch { /* no marker — no ctx_find has run recently */ }
            if (Array.isArray(records)) {
              const ttlRaw = Number.parseInt(process.env.CONTEXT_MODE_FIND_TRACK_TTL_MS ?? "", 10);
              const ttl = Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : 15 * 60_000;
              const now = Date.now();
              // Newest matching query wins — the marker is stored newest-first.
              const hit = records.find(r =>
                r && Array.isArray(r.paths) && typeof r.query === "string"
                && now - (Number(r.at) || 0) <= ttl
                && r.paths.includes(filePath));
              if (hit) {
                const { appendFileSync } = await import("node:fs");
                appendFileSync(
                  resolve(tmpdir(), `context-mode-find-selected-${basename(dbPath)}.jsonl`),
                  JSON.stringify({ query: hit.query, path: filePath, at: now }) + "\n",
                  "utf-8",
                );
              }
            }
          }
        }
      }
    } catch { /* ranking feedback is best-effort — never block the hook */ }

    db.close();
  } catch {
    // PostToolUse must never block the session — silent fallback
  }

  // The one thing this hook says out loud. Silence on every routed call is
  // the feature: a line the model sees on correct calls too is a line it
  // learns to skip.
  if (costNotice) {
    try {
      const { formatPostToolContext } = await import("./core/formatters.mjs");
      const payload = formatPostToolContext("claude-code", costNotice);
      if (payload) console.log(JSON.stringify(payload));
    } catch { /* the notice is advisory — never block the session */ }
  }
});
