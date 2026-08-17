import { PageStore, pageKeyFor } from "/Users/mksglu/Server/Mert/context-mode/src/fetch/page-store.js";
import { reassemble } from "/Users/mksglu/Server/Mert/context-mode/src/fetch/blocks.js";
import { storedTemplateText } from "/Users/mksglu/Server/Mert/context-mode/src/fetch/extract.js";
const s = new PageStore("/Users/mksglu/.claude/context-mode/content/fetch-pages.db");
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
