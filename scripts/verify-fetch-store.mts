// Dev-only: checks the lossless claim against a real fetch-pages store.
//
// Every path in here used to be absolute and rooted at the original author's
// home directory, so the script could not run on any other machine — three
// source imports and the store path alike. Imports are now relative to this
// file; the store is resolved the way the plugin resolves it, with
// CONTEXT_MODE_DIR taking precedence over the adapter default.
import { homedir } from "node:os";
import { resolve } from "node:path";
import { PageStore, pageKeyFor } from "../src/fetch/page-store.js";
import { reassemble } from "../src/fetch/blocks.js";
import { storedTemplateText } from "../src/fetch/extract.js";

const contentRoot = process.env.CONTEXT_MODE_DIR?.trim()
  ? resolve(process.env.CONTEXT_MODE_DIR.trim(), "content")
  : resolve(homedir(), ".claude", "context-mode", "content");
const s = new PageStore(resolve(contentRoot, "fetch-pages.db"));
for (const u of [
  "https://docs.python.org/3/library/csv.html",
  "https://docs.python.org/3/library/json.html",
  "https://docs.stripe.com/api/charges/object",
]) {
  const k = pageKeyFor(u);
  const full = s.fullTextOf(k);
  if (full === null) { console.log(JSON.stringify({ url: u, stored: false })); continue; }
  const blocks = s.blocksOf(k);
  const rejoined = reassemble(blocks);
  const tmpl = storedTemplateText(s, u);
  console.log(JSON.stringify({
    url: u,
    storedBytes: Buffer.byteLength(full, "utf-8"),
    blocks: blocks.length,
    templateBlocks: blocks.filter((b) => b.kind === "template").length,
    // THE LOSSLESS CLAIM, against the live production store:
    blocksReassembleToFullText: rejoined === full,
    templateRecoverableBytes: Buffer.byteLength(tmpl, "utf-8"),
  }));
}
s.close();
