/**
 * measure-fetch-ladder — does the shipped ladder answer SPA pages too?
 *
 * For each target URL this runs every rung of the ladder INDEPENDENTLY, so the
 * report can say which rung would have answered and what the rungs below it
 * would have produced. Nothing is truncated: every fetched document is written
 * whole to disk and the byte counts are exact.
 *
 *   arm PLAIN  — a plain GET with the browser-shaped Accept, then the shipped
 *                Turndown sanitiser. This arm is the SPA/SSR CLASSIFIER: if the
 *                converted text trips the shipped shell arithmetic
 *                (<200 B of text AND <2% yield) the page is client-rendered.
 *   rung 1     — the same single request with `Accept: text/markdown`.
 *   rung 2a    — the `.md` sibling of the page path.
 *   rung 2b    — the origin's `llms.txt`, and whether it names this page.
 *
 * No regular expressions (repo-wide ban).
 */

const fs = require("node:fs");
const path = require("node:path");
const TurndownService = require("turndown");
const { gfm } = require("turndown-plugin-gfm");

const OUT = process.env.LADDER_OUT || "/tmp/claude-501/ladder";

const ACCEPT_MD =
  "text/markdown, text/x-markdown;q=0.9, text/html;q=0.8, application/xhtml+xml;q=0.8, */*;q=0.5";
const ACCEPT_HTML = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// The shipped shell arithmetic, mirrored here so the classifier in this
// harness is the same one the product ships (src/server.ts classifyExtraction).
const SHELL_MAX_TEXT_BYTES = 200;
const SHELL_MAX_YIELD = 0.02;

function isShell(textBytes, sourceBytes) {
  if (!(sourceBytes > 0)) return false;
  if (textBytes >= SHELL_MAX_TEXT_BYTES) return false;
  return textBytes / sourceBytes < SHELL_MAX_YIELD;
}

function trimEdges(s) {
  let a = 0, b = s.length;
  const sp = (c) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
  while (a < b && sp(s.charAt(a))) a++;
  while (b > a && sp(s.charAt(b - 1))) b--;
  return s.substring(a, b);
}

function toMd(html) {
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  td.use(gfm);
  td.remove(["script", "style", "nav", "header", "footer", "noscript"]);
  return td.turndown(html);
}

/** Does the body read as a markdown document rather than an HTML page? */
function looksMarkdown(ct, body) {
  if (ct.indexOf("text/markdown") >= 0 || ct.indexOf("text/x-markdown") >= 0) return true;
  const t = trimEdges(body);
  if (t.lastIndexOf("<", 0) === 0) return false; // starts with a tag: HTML
  if (ct.indexOf("text/plain") >= 0 || ct.indexOf("text/x-md") >= 0) {
    return t.lastIndexOf("# ", 0) === 0 || t.lastIndexOf("---", 0) === 0;
  }
  return false;
}

function bytes(s) { return Buffer.byteLength(s, "utf-8"); }

async function get(url, accept) {
  // Three attempts. A single transient network failure must not be reported as
  // "this site has no such document" — that is exactly the silent-zero this
  // repo forbids. The last error is returned verbatim if all three fail.
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept, "user-agent": UA },
        redirect: "follow",
      });
      const body = await res.text();
      return { ok: true, status: res.status, finalUrl: res.url, ct: (res.headers.get("content-type") || "").split(";")[0].trim(), body };
    } catch (e) {
      last = e && e.message ? e.message : String(e);
      if (e && e.cause && e.cause.message) last = last + " / " + e.cause.message;
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
  }
  return { ok: false, error: last };
}

/** `.md` sibling candidates for a page path, cheapest/most conventional first. */
function mdSiblings(u) {
  const p = new URL(u);
  const out = [];
  const pathname = p.pathname;
  const dotHtml = ".html";
  if (pathname.length > dotHtml.length && pathname.lastIndexOf(dotHtml) === pathname.length - dotHtml.length) {
    out.push(pathname.substring(0, pathname.length - dotHtml.length) + ".md");
  } else if (pathname.charAt(pathname.length - 1) === "/") {
    out.push(pathname.substring(0, pathname.length - 1) + ".md");
    out.push(pathname + "index.md");
  } else {
    out.push(pathname + ".md");
    out.push(pathname + "/index.md");
  }
  const seen = new Set();
  const urls = [];
  for (const c of out) {
    const full = p.origin + c;
    if (seen.has(full)) continue;
    seen.add(full);
    urls.push(full);
  }
  return urls;
}

/** Does an llms.txt body name this page's path? Structural scan, no regex. */
function llmsNamesPath(body, pathname) {
  return body.indexOf(pathname) >= 0;
}

const TARGETS = require(process.env.LADDER_TARGETS || path.join(__dirname, "ladder-targets.json"));

async function probeOne(t) {
  const rec = { site: t.site, url: t.url, marker: t.marker };

  const plain = await get(t.url, ACCEPT_HTML);
  if (!plain.ok) { rec.plain = { error: plain.error }; }
  else {
    const src = bytes(plain.body);
    let md = "";
    try { md = trimEdges(toMd(plain.body)); } catch (e) { md = ""; rec.turndownError = String(e && e.message); }
    rec.plain = {
      status: plain.status, ct: plain.ct, sourceBytes: src,
      textBytes: bytes(md),
      yieldPct: src > 0 ? ((bytes(md) / src) * 100).toFixed(2) : "0.00",
      shell: isShell(bytes(md), src),
      markerPresent: t.marker ? md.indexOf(t.marker) >= 0 : null,
    };
    fs.writeFileSync(path.join(OUT, t.site + ".plain.md"), md);
  }

  const r1 = await get(t.url, ACCEPT_MD);
  if (!r1.ok) { rec.rung1 = { error: r1.error }; }
  else {
    const isMd = looksMarkdown(r1.ct, r1.body);
    rec.rung1 = {
      status: r1.status, ct: r1.ct, bytes: bytes(r1.body), servedMarkdown: isMd,
      markerPresent: t.marker ? r1.body.indexOf(t.marker) >= 0 : null,
    };
    fs.writeFileSync(path.join(OUT, t.site + ".rung1." + (isMd ? "md" : "html")), r1.body);
  }

  rec.rung2a = [];
  for (const cand of mdSiblings(t.url)) {
    const r = await get(cand, ACCEPT_MD);
    if (!r.ok) { rec.rung2a.push({ url: cand, error: r.error }); continue; }
    const isMd = r.status === 200 && looksMarkdown(r.ct, r.body);
    rec.rung2a.push({
      url: cand, status: r.status, ct: r.ct, bytes: bytes(r.body),
      servedMarkdown: isMd,
      markerPresent: t.marker && isMd ? r.body.indexOf(t.marker) >= 0 : null,
    });
    if (isMd) { fs.writeFileSync(path.join(OUT, t.site + ".rung2a.md"), r.body); break; }
  }

  const origin = new URL(t.url).origin;
  const llms = await get(origin + "/llms.txt", ACCEPT_MD);
  if (!llms.ok) { rec.rung2b = { error: llms.error }; }
  else {
    const present = llms.status === 200 && llms.ct.indexOf("html") < 0 && bytes(llms.body) > 0
      && trimEdges(llms.body).lastIndexOf("<", 0) !== 0;
    rec.rung2b = {
      url: origin + "/llms.txt", status: llms.status, ct: llms.ct,
      bytes: bytes(llms.body), present,
      namesThisPage: present ? llmsNamesPath(llms.body, new URL(t.url).pathname) : false,
    };
    if (present) fs.writeFileSync(path.join(OUT, t.site + ".llms.txt"), llms.body);
  }

  return rec;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const results = [];
  const pool = Number(process.env.LADDER_POOL || 2);
  let i = 0;
  async function worker() {
    while (i < TARGETS.length) {
      const t = TARGETS[i++];
      const r = await probeOne(t);
      results.push(r);
      process.stderr.write("done " + r.site + "\n");
    }
  }
  await Promise.all(Array.from({ length: pool }, worker));
  results.sort((a, b) => (a.site < b.site ? -1 : 1));
  fs.writeFileSync(path.join(OUT, "ladder.json"), JSON.stringify(results, null, 2));

  // One line per site: classification, then which rung answered.
  for (const r of results) {
    const cls = r.plain && r.plain.shell ? "SPA" : r.plain && r.plain.error ? "ERR" : "SSR";
    const r1 = r.rung1 && r.rung1.servedMarkdown ? "rung1(" + r.rung1.bytes + "B" + (r.rung1.markerPresent ? ",marker" : ",NOmarker") + ")" : "rung1:no";
    let r2a = "rung2a:no";
    for (const c of r.rung2a || []) if (c.servedMarkdown) r2a = "rung2a(" + c.bytes + "B" + (c.markerPresent ? ",marker" : ",NOmarker") + ")";
    const r2b = r.rung2b && r.rung2b.present ? "llms.txt(" + r.rung2b.bytes + "B," + (r.rung2b.namesThisPage ? "names-page" : "no-page-link") + ")" : "llms.txt:no";
    const plainMark = r.plain && r.plain.markerPresent ? "plainHasMarker" : "plainNOmarker";
    console.log([r.site, cls, "yield=" + (r.plain ? r.plain.yieldPct : "?") + "%", "text=" + (r.plain ? r.plain.textBytes : "?") + "B", plainMark, r1, r2a, r2b].join("  "));
  }
  console.log("\nfull json: " + path.join(OUT, "ladder.json"));
}

main();
