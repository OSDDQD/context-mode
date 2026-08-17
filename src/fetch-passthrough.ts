/**
 * URLs the sandbox fetch cannot read, and the routing layer must not claim.
 *
 * Upstream #938 / #984 / #1006: a claude.ai Artifact page is a client-rendered
 * SPA behind the caller's login. Claude Code's native WebFetch has a documented
 * exception that fetches these with the authenticated session;
 * `ctx_fetch_and_index` does a plain anonymous GET and gets back the empty
 * shell — roughly 100 bytes of "Content is user-generated and unverified".
 *
 * That is worse than an error: the model receives a well-formed page, indexes
 * it, searches it, finds nothing, and has no signal that the content was never
 * there. So both halves of the fix live here — the hook lets these URLs through
 * to the native tool (hooks/core/routing.mjs), and the sandbox fetch refuses
 * them loudly instead of returning an empty success.
 *
 * Keep this list in sync with `BUILTIN_FETCH_PASSTHROUGH` in
 * hooks/core/routing.mjs — tests/core/fetch-passthrough.test.ts asserts the two
 * implementations agree.
 */

const BUILTIN_PASSTHROUGH: RegExp[] = [
  /^https?:\/\/(?:[\w-]+\.)*claude\.ai\/code\/artifact\//i,
  /^https?:\/\/(?:[\w-]+\.)*claude\.ai\/public\/artifacts\//i,
  /^https?:\/\/(?:[\w-]+\.)*claude\.site\/artifacts\//i,
];

/**
 * @param url Candidate URL.
 * @param env Environment carrying the operator's `CONTEXT_MODE_FETCH_PASSTHROUGH`
 *   extension list: entries separated by `|||`, each a host suffix or — when it
 *   starts with `^` — a regex over the whole URL.
 * @returns true when only the host's native fetch can read this URL.
 */
export function isFetchPassthroughUrl(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!url || typeof url !== "string") return false;
  if (BUILTIN_PASSTHROUGH.some(rx => rx.test(url))) return true;

  const raw = env.CONTEXT_MODE_FETCH_PASSTHROUGH;
  if (!raw) return false;

  const hosts: string[] = [];
  for (const entryRaw of raw.split("|||")) {
    const entry = entryRaw.trim();
    if (!entry) continue;
    if (entry.startsWith("^")) {
      try {
        if (new RegExp(entry, "i").test(url)) return true;
      } catch { /* skip malformed */ }
    } else {
      hosts.push(entry.toLowerCase().replace(/^\.+/, ""));
    }
  }
  if (hosts.length === 0) return false;

  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hosts.some(h => hostname === h || hostname.endsWith(`.${h}`));
}

/**
 * Error text for a passthrough URL that reached the sandbox fetch anyway
 * (a direct `ctx_fetch_and_index` call — the hook only guards WebFetch).
 *
 * Names the working path instead of just refusing, so the agent's next move is
 * obvious rather than a retry loop against a URL that will never resolve.
 */
export function passthroughFetchError(url: string): string {
  return (
    `${url} is served as an authenticated, client-rendered page — an anonymous fetch returns ` +
    "an empty shell, not the content, so ctx_fetch_and_index cannot read it.\n" +
    "Use the host's native WebFetch tool for this URL: it fetches with your claude.ai session. " +
    "context-mode does not redirect these URLs, so that call goes straight through.\n" +
    "If the page is genuinely public, add its host to CONTEXT_MODE_FETCH_PASSTHROUGH only if you " +
    "want the same passthrough behavior; the sandbox fetch will still be unable to read it."
  );
}
