/**
 * probe-routes — which route does each host actually take?
 *
 * Answers one question per URL: does the site honour `Accept: text/markdown`
 * (route 1, no extraction needed) or does it hand back HTML (route 2, the
 * extraction algorithm must earn its keep)? Prints the failure verbatim when
 * a host is unreachable rather than reporting a silent zero.
 *
 * No regular expressions (repo-wide ban). Nothing truncated.
 */

const ACCEPT =
  "text/markdown, text/x-markdown;q=0.9, text/html;q=0.8, application/xhtml+xml;q=0.8, */*;q=0.5";

const URLS = process.argv.slice(2);

function trimEdges(s) {
  let a = 0, b = s.length;
  const sp = (c) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
  while (a < b && sp(s.charAt(a))) a++;
  while (b > a && sp(s.charAt(b - 1))) b--;
  return s.substring(a, b);
}

async function main() {
  for (const u of URLS) {
    try {
      const res = await fetch(u, { headers: { accept: ACCEPT }, redirect: "follow" });
      const ct = (res.headers.get("content-type") || "").split(";")[0];
      const body = await res.text();
      const isMd =
        ct.indexOf("text/markdown") >= 0 ||
        ct.indexOf("text/x-markdown") >= 0 ||
        (ct.indexOf("text/plain") >= 0 && trimEdges(body).lastIndexOf("# ", 0) === 0);
      console.log(
        JSON.stringify({
          url: u,
          status: res.status,
          finalUrl: res.url,
          ct,
          bytes: Buffer.byteLength(body, "utf-8"),
          route: isMd ? "markdown" : ct.indexOf("text/html") >= 0 ? "html" : "text",
        }),
      );
    } catch (e) {
      console.log(JSON.stringify({ url: u, error: String(e && e.message ? e.message : e), cause: String((e && e.cause) || "") }));
    }
  }
}

main().catch((e) => { console.error("FATAL " + e); process.exit(1); });
