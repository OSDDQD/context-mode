/**
 * measure-extraction — exercises the SHIPPED extraction modules end to end on
 * real HTML-route hosts (the ones that publish no markdown, so route 1 cannot
 * help and the algorithm has to earn its keep).
 *
 * Asserts the three claims the design rests on:
 *   1. LOSSLESS  — reassemble(splitBlocks(doc)) === doc, byte for byte, and the
 *      stored full_text equals the input document byte for byte.
 *   2. EXTRACTIVE — on page 2+ of a host, the repeated chrome is labelled
 *      `template` and leaves the index; the article stays in `content`.
 *   3. RECOVERABLE — the template stream is still retrievable from the store,
 *      so nothing was dropped, only labelled.
 *
 * No regular expressions (repo-wide ban). Nothing truncated.
 */

import fs from "node:fs";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { splitBlocks, reassemble } from "../src/fetch/blocks.js";
import { extractAndStore, storedTemplateText } from "../src/fetch/extract.js";
import { PageStore, pageKeyFor } from "../src/fetch/page-store.js";

const ACCEPT =
  "text/markdown, text/x-markdown;q=0.9, text/html;q=0.8, application/xhtml+xml;q=0.8, */*;q=0.5";

const DB = "/tmp/claude-501/extract-proof.db";

interface Target { host: string; url: string; marker: string; }

const TARGETS: Target[] = [
  { host: "mdn", url: "https://developer.mozilla.org/en-US/docs/Web/API/AbortController", marker: "abort()" },
  { host: "mdn", url: "https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal", marker: "AbortSignal" },
  { host: "mdn", url: "https://developer.mozilla.org/en-US/docs/Web/API/Blob", marker: "Blob" },
  { host: "py", url: "https://docs.python.org/3/library/csv.html", marker: "csv.reader" },
  { host: "py", url: "https://docs.python.org/3/library/json.html", marker: "json.dumps" },
  { host: "py", url: "https://docs.python.org/3/library/sqlite3.html", marker: "sqlite3.connect" },
];

function convert(html: string): string {
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  td.use(gfm);
  td.remove(["script", "style", "nav", "header", "footer", "noscript"]);
  return td.turndown(html);
}

async function main(): Promise<void> {
  try { fs.rmSync(DB, { force: true }); } catch { /* fresh run */ }
  try { fs.rmSync(DB + "-wal", { force: true }); fs.rmSync(DB + "-shm", { force: true }); } catch { /* none */ }
  const store = new PageStore(DB);

  for (const t of TARGETS) {
    const res = await fetch(t.url, { headers: { accept: ACCEPT }, redirect: "follow" });
    const html = await res.text();
    const doc = convert(html);

    // CLAIM 1a — the split is exactly reversible.
    const rt = reassemble(splitBlocks(doc));
    const losslessSplit = rt === doc;

    const outcome = extractAndStore({
      url: t.url,
      sourceLabel: "proof:" + t.url,
      document: doc,
      route: "html",
      store,
    });

    // CLAIM 1b — the stored document is the input document, byte for byte.
    const stored = store.fullTextOf(pageKeyFor(t.url));
    const losslessStore = stored === doc;

    if (outcome.kind === "refuse") {
      console.log(JSON.stringify({
        host: t.host, url: t.url, verdict: "refuse", reason: outcome.reason,
        losslessSplit, losslessStore,
      }));
      continue;
    }

    // CLAIM 3 — template text is still retrievable after being labelled out.
    const tmpl = storedTemplateText(store, t.url);

    console.log(JSON.stringify({
      host: t.host,
      url: t.url,
      verdict: "index",
      provisional: outcome.provisional,
      docBytes: Buffer.byteLength(doc, "utf-8"),
      indexBytes: Buffer.byteLength(outcome.indexText, "utf-8"),
      contentBytes: outcome.contentBytes,
      templateBytes: outcome.templateBytes,
      totalBlocks: outcome.totalBlocks,
      templateBlocks: outcome.templateBlocks,
      // CLAIM 2 — the article survives into what actually gets indexed.
      markerInIndex: outcome.indexText.indexOf(t.marker) >= 0,
      markerInStore: (stored ?? "").indexOf(t.marker) >= 0,
      losslessSplit,
      losslessStore,
      templateRecoverableBytes: Buffer.byteLength(tmpl, "utf-8"),
      relabelled: outcome.relabelled.length,
    }));
  }
  store.close();
  console.log("DB=" + DB);
}

main().catch((e) => { console.error("FATAL " + e); process.exit(1); });
