/**
 * measure-fetch-arms — before/after measurement of the SHIPPED fetch pipeline.
 *
 * ARM "before": exactly what the shipped subprocess did before this change —
 *   a plain GET (Node default Accept) then Turndown with the shipped
 *   `remove([...])` sanitiser. This is the CAVEAT the brief flagged: the
 *   1.49 MB figure came from a RAW Turndown run with no remove() list, so it
 *   is NOT a claim about the product. This arm settles what the product did.
 *
 * ARM "after": the new request — the same single round trip, with the
 *   Accept header that asks for the machine-readable version first.
 *
 * Reports bytes, content-type, article-marker presence and link-only-line
 * share for both arms. No truncation: full byte counts, whole documents
 * written to disk for inspection.
 *
 * No regular expressions (repo-wide ban).
 */

const fs = require("node:fs");
const path = require("node:path");
const TurndownService = require("turndown");
const gfm = require("turndown-plugin-gfm");

const OUT = process.env.ARM_OUT || "/tmp/claude-501/arms";

const ACCEPT_AFTER =
  "text/markdown, text/x-markdown;q=0.9, text/html;q=0.8, application/xhtml+xml;q=0.8, */*;q=0.5";

// The six platforms named in the brief, plus two HTML-only controls that
// exercise the extraction algorithm rather than the markdown route.
const TARGETS = [
  { site: "stripe", url: "https://docs.stripe.com/api/charges/object", marker: "amount_captured" },
  { site: "resend", url: "https://resend.com/docs/api-reference/emails/send-email", marker: "attachments" },
  { site: "cursor", url: "https://cursor.com/docs/context/rules", marker: "alwaysApply" },
  { site: "polygon", url: "https://polygon.io/docs/rest/stocks/aggregates/custom-bars", marker: "adjusted" },
  { site: "mintlify", url: "https://www.mintlify.com/docs/quickstart", marker: "docs.json" },
  { site: "gitbook", url: "https://docs.gitbook.com/getting-started/quickstart", marker: "space" },
  // HTML-route controls: these hosts publish no markdown, so they are the
  // ones that exercise the extraction algorithm rather than route 1.
  { site: "mdn", url: "https://developer.mozilla.org/en-US/docs/Web/API/AbortController", marker: "abort()" },
  { site: "python", url: "https://docs.python.org/3/library/csv.html", marker: "csv.reader" },
];

function trimEdges(s) {
  let a = 0, b = s.length;
  const sp = (c) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
  while (a < b && sp(s.charAt(a))) a++;
  while (b > a && sp(s.charAt(b - 1))) b--;
  return s.substring(a, b);
}

/** Share of non-blank lines that are nothing but a markdown link — the chrome tell. */
function linkOnlyShare(md) {
  const lines = md.split("\n");
  let nonBlank = 0, linkOnly = 0;
  for (const raw of lines) {
    const t = trimEdges(raw);
    if (t.length === 0) continue;
    nonBlank++;
    let s = t;
    while (s.lastIndexOf("* ", 0) === 0 || s.lastIndexOf("- ", 0) === 0) s = trimEdges(s.substring(2));
    if (s.lastIndexOf("[", 0) === 0 && s.lastIndexOf(")") === s.length - 1 && s.indexOf("](") > 0) {
      const close = s.indexOf("](");
      if (s.indexOf("[", 1) === -1 || s.indexOf("[", 1) > close) linkOnly++;
    }
  }
  return { nonBlank, linkOnly, pct: nonBlank === 0 ? 0 : (linkOnly * 100) / nonBlank };
}

function convertHtml(html) {
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  td.use(gfm.gfm);
  td.remove(["script", "style", "nav", "header", "footer", "noscript"]);
  return td.turndown(html);
}

async function arm(url, headers) {
  const res = await fetch(url, { headers, redirect: "follow" });
  const ct = res.headers.get("content-type") || "";
  const body = await res.text();
  return { status: res.status, ct, body, bytes: Buffer.byteLength(body, "utf-8") };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const rows = [];
  for (const t of TARGETS) {
    const row = { site: t.site, url: t.url, marker: t.marker };
    try {
      // BEFORE: no Accept header at all — the shipped request.
      const b = await arm(t.url, {});
      const beforeDoc = b.ct.indexOf("text/html") >= 0 ? convertHtml(b.body) : b.body;
      row.before = {
        status: b.status,
        ct: b.ct.split(";")[0],
        inputBytes: b.bytes,
        outputBytes: Buffer.byteLength(beforeDoc, "utf-8"),
        marker: beforeDoc.indexOf(t.marker) >= 0,
        link: linkOnlyShare(beforeDoc),
      };
      fs.writeFileSync(path.join(OUT, t.site + ".before.md"), beforeDoc);
    } catch (e) {
      row.before = { error: String(e && e.message ? e.message : e) };
    }
    try {
      // AFTER: the same one round trip, asking for machine-readable first.
      const a = await arm(t.url, { accept: ACCEPT_AFTER });
      const isMd =
        a.ct.indexOf("text/markdown") >= 0 ||
        a.ct.indexOf("text/x-markdown") >= 0 ||
        (a.ct.indexOf("text/plain") >= 0 && trimEdges(a.body).lastIndexOf("# ", 0) === 0);
      const afterDoc = isMd ? a.body : (a.ct.indexOf("text/html") >= 0 ? convertHtml(a.body) : a.body);
      row.after = {
        status: a.status,
        ct: a.ct.split(";")[0],
        route: isMd ? "markdown" : (a.ct.indexOf("text/html") >= 0 ? "html" : "text"),
        inputBytes: a.bytes,
        outputBytes: Buffer.byteLength(afterDoc, "utf-8"),
        marker: afterDoc.indexOf(t.marker) >= 0,
        link: linkOnlyShare(afterDoc),
      };
      fs.writeFileSync(path.join(OUT, t.site + ".after.md"), afterDoc);
    } catch (e) {
      row.after = { error: String(e && e.message ? e.message : e) };
    }
    rows.push(row);
    console.log(JSON.stringify(row));
  }
  fs.writeFileSync(path.join(OUT, "arms.json"), JSON.stringify(rows, null, 2));
  console.log("WROTE " + path.join(OUT, "arms.json"));
}

main().catch((e) => { console.error("FATAL " + e); process.exit(1); });
