# The fetch ladder — completed, and measured on SPA and SSR alike, 2026-08-12

Companion to `fetch-extraction-2026-08-12.md`, which settled rungs 1, 4 and 5.
This document settles **rung 2** and answers the question that motivated it:
does a documentation SPA need a browser?

Every number was produced by a command in this repo:

- `scripts/measure-fetch-ladder.cjs` with `scripts/ladder-targets.json` and
  `scripts/ladder-targets2.json` — 36 documentation pages, each rung probed
  independently so the report can say which rung *would* answer and what the
  rungs below it produce.
- `tests/core/fetch-ladder-rungs.test.ts` — the real generated subprocess
  against a real HTTP server on loopback, asserting the rung AND the request
  count.
- `claude -p --model claude-haiku-4-5-20251001`, read back from
  `~/.claude/projects/<slug>/<uuid>.jsonl`.

Nothing here is truncated. Whole documents are written to disk by the harness.

## The ladder as shipped

Each rung is tried in cost order and the rung that answered is reported on
every fetch — success or refusal.

| # | rung | cost | id on the wire |
|---|---|---|---|
| 1 | `Accept: text/markdown` on the request already being made | zero extra round trips | `1-accept-markdown` |
| 1 | the same response as HTML, converted | zero extra round trips | `1-html-converted` |
| 2a | the page's `.md` sibling | one request, **failure path only** | `2a-md-sibling` |
| 2b | the host's `llms.txt`, followed only when it names this page somewhere 2a did not already try | one or two requests, **failure path only** | `2b-llms-txt` |
| 4 | block classification against other pages of the same host | none (local) | reported alongside the rung |
| 5 | the honest refusal, naming the urls already requested | — | `ladder-exhausted` |

`env.AI.toMarkdown()` is **not** on the ladder, and the reason has not changed:
it is a converter, the converter was never the binding constraint, and reaching
it from a local Node subprocess would add a Cloudflare credential to a process
that needs none. It also does not execute JavaScript, so it could never have
been the SPA answer it is sometimes sold as.

## Rung 2 exists because one measured page needed it

Over 36 pages, exactly one page was unreachable by rung 1 and reachable by
rung 2:

| page | plain HTTP fetch converts to | rung 1 `Accept` | `.md` sibling | rung 2 needed? |
|---|---:|---|---:|---|
| `developer.apple.com/documentation/swiftui/view` | **36 B** — the title, nothing else | HTML | **5,593 B of the article** | **yes** |
| `reactnative.dev/docs/view` | 33,034 B, article present | ignored, serves HTML | 30,318 B of markdown | no |

Apple is the hardest measured page in the set: 17,486 B in, 36 B of text out,
0.21% yield — a shell by the shipped arithmetic, and the whole article behind
JavaScript. Rung 2a recovers all of it.

React Native is the near miss, and the ladder is right not to climb for it. The
host ignores content negotiation, so rung 1's markdown path is unavailable — but
its HTML converts to a genuine article, so rung 1 has already answered and the
`.md` file, though a cleaner document, is not worth a second request. Confirmed
in the live run below: React Native reports `1-html-converted`, not `2a`. A
ladder that climbed for a *better* answer rather than a *missing* one would pay
an extra request on every page of every host that ignores `Accept`.

**Two acceptance traps, both measured, both structural in the fix:**

- `developer.apple.com` serves its `.md` with an **empty `Content-Type`** and an
  **HTML comment as its first bytes**. A "content-type says markdown" test or a
  "starts with `#`" test rejects a real article.
- `angular.dev` answers a missing `.md` with **HTTP 200 carrying the SPA shell**.
  A "status is 200" test accepts a soft 404 and indexes chrome as the page.

So a sibling is accepted unless the server handed back an HTML *document* —
checked by looking for a document element, not by guessing at the body's shape.

## Rung 2b earns one line, not more

`llms.txt` was present on 20 of the 36 hosts. On the pages where it named this
page at all, the url it named was the `.md` sibling rung 2a already computes —
**measured value-add over 2a on this sample: zero**. It is still on the ladder,
because the one shape it covers is real (a host that publishes its markdown
under a different path or host), and because it costs nothing on the happy path.
It is followed **only** when it names a url 2a did not already try, so an index
that merely points back at the page we just failed on is not re-fetched. That
case has its own test.

## Cost order is asserted, not asserted-in-prose

`tests/core/fetch-ladder-rungs.test.ts` reads the **server's request log**, not
just the returned document. The happy-path case deliberately publishes a `.md`
sibling and asserts it is *never requested*:

```
rung 1, html converted to an article  → requests: ["/docs/view"]
rung 2a, shell recovered              → requests: ["/documentation/swiftui/view",
                                                   "/documentation/swiftui/view.md"]
```

A ladder that quietly made three requests on every fetch would pass every
content assertion and still be the wrong product.

## SPA hit rate

Operative definition, the owner's: a page is SPA-rendered when **the article is
absent from what an HTTP fetch returns**. Applied to the 36-page sample by the
shipped shell arithmetic plus a marker-free article-presence check:

| page | evidence the article is absent | recovered by |
|---|---|---|
| `developer.apple.com/documentation/swiftui/view` | plain fetch converts to 36 B — the `<title>` and nothing else; shell by the shipped arithmetic (0.21% yield) | **rung 2a** |
| `platform.openai.com/docs/api-reference/chat` | plain fetch returns 403 and 0 B of text | rung 1 |
| `docs.anthropic.com/en/api/messages` | plain fetch converts to 3,312 B of chrome; **0 of 12** article sentences present | rung 1 |
| `www.mintlify.com/docs/quickstart` | 1 of 12 article sentences present; the earlier round measured the HTML arm losing `docs.json` and `navigation` entirely | rung 1 |

| | pages |
|---|---:|
| documentation pages probed | 36 |
| article absent from the plain HTTP response | **4** |
| of those, recovered browser-free | **4 of 4** |
| **pages that needed a browser** | **0 of 36** |

Three of the four were then re-proved end to end through `claude -p` (below);
mintlify was measured by harness only. The measured line from the earlier round
holds on a fresh sample: the ladder covers SPAs, and it covers them without
executing JavaScript.

The one case where a browser is genuinely the only tool is still the one the
earlier round named, and it is not a documentation page: excalidraw.com and
app.diagrams.net are a whiteboard and a diagram editor with no article to fetch.
Nothing in this sample changes that.

Two hosts in the sample could not be fetched at all, and the reason is not
JavaScript: `ai.google.dev` and `developer.android.com` bounce a plain client
through a redirect loop the walk stops at five hops. That surfaced as
`SSRF blocked: redirect chain exceeded 5 hops`, which accused an attack for what
is a benign locale redirect; the message now names both possibilities and says
what to try. **UNVERIFIED whether these pages are reachable with a cookie jar** —
the command that settles it is a fetch that persists `Set-Cookie` across hops,
which the subprocess deliberately does not do.

## The `claude -p` proof

Seven fetches through the real MCP server (`server.bundle.mjs`, the minified
artifact that ships), each asked a question only the article answers. Rung and
result read from the transcript's `tool_result` in
`~/.claude/projects/<slug>/<uuid>.jsonl`, never from the model's prose. Session
ids `11111111-1111-4111-8111-00000000000{1..7}`; evidence dumped whole to
`/tmp/claude-501/proof-evidence/`.

| site | kind | rung that answered | question | answered |
|---|---|---|---|---|
| developer.apple.com/documentation/swiftui/view | **SPA** (36 B of text served) | **2a — `.md` sibling**, 5,593 B | which property must a `View` implement? | `body` ✓ |
| platform.openai.com/docs/api-reference/chat | **SPA** (0 B of text served) | 1 — `Accept: text/markdown`, 231,958 B | range of `frequency_penalty`? | −2.0 to 2.0 ✓ |
| docs.anthropic.com/en/api/messages | **SPA** (article absent from the shell) | 1 — `Accept: text/markdown`, 794,970 B | which field gives the stop reason? | `stop_reason` ✓ |
| reactnative.dev/docs/view | SSR | 1 — HTML converted; rung 4 provisional, 396 blocks | which prop fires on layout change? | `onLayout` ✓ |
| docs.python.org/3/library/csv.html | SSR | 1 — HTML converted; rung 4, 186/203 content, 17 template (775 B) | default dialect of `csv.reader`? | `excel` ✓ |
| developer.mozilla.org/…/AbortController | SSR | 1 — HTML converted; rung 4, 21/30 content, 9 template (426 B) | which property makes a fetch abortable? | `signal` ✓ |
| kubernetes.io/docs/concepts/workloads/pods/ | SSR | 1 — HTML converted; rung 4 provisional, 129 blocks | what do containers in a Pod share? | namespaces, cgroups, storage, network identity ✓ |

**7 of 7 answered. 3 of 3 SPA pages answered. 0 browsers.**

The Apple row is the one that was impossible before this change. The document
the search returned is the article verbatim — "Implement the required `body`
computed property to provide the content for your custom view" — retrieved from
a page whose HTTP response contains 36 bytes of text.

## Why the rung is reported at all

The point of a ladder is that a reader can tell which step paid. Before this
change the fetch reported `route: site-authored markdown` versus
`route: converted HTML` — enough to know whether extraction ran, not enough to
know whether the ladder was climbed. Every fetch now reports its rung, and the
refusal names the urls it already requested, so the caller does not go hunting
for files the ladder already asked for.
