# Fetch extraction — measurements, 2026-08-12

Every number here was produced by a command in this repo. The harnesses are
`scripts/measure-fetch-arms.cjs` (route 1, before/after per site),
`scripts/measure-extraction.mts` (the algorithm, on HTML-only hosts) and
`scripts/probe-routes.cjs` (which route a host takes). Nothing is truncated;
the whole converted documents are written to disk by the harnesses.

## The caveat, settled first

The brief carried a figure of **1,485,503 B** of Turndown output for
`https://docs.stripe.com/api/charges/object`, flagged with a caveat: Turndown
had been invoked RAW, and the shipped path might sanitise before it.

It does. `src/server.ts` has always called
`td.remove(['script','style','nav','header','footer','noscript'])`.

**Measured shipped output for that page: 26,053 B, not 1,485,503 B.**

So the 1.49 MB figure is a property of a raw Turndown call and must not be
repeated as a claim about the product. It also relocates the problem. The
shipped converter was never emitting megabytes; it was emitting ~26 KB of
which **28.3% of non-blank lines were link-only** — nav, not article. The
defect was never byte volume. It was that the article was not in there.

## Route 1 — ask for the machine-readable page

One request, one extra `Accept` header. All six named platforms honour it.

| site | before: input → indexed | link-only | after: input → indexed | link-only | article |
|---|---|---:|---|---:|---|
| stripe | 1,846,878 → 26,053 B | 28.3% | 11,744 → **11,744 B** | 5.0% | intact both |
| gitbook | 1,603,402 → 19,430 B | 21.9% | 13,612 → **13,612 B** | 0.0% | intact both |
| cursor | 519,445 → 37,081 B | 0.29% | 16,636 → **16,636 B** | 0.37% | intact both |
| resend | 761,789 → 15,115 B | 0.34% | 12,411 → **12,411 B** | 0.99% | intact both |
| polygon | 1,613,890 → 9,050 B | 0.90% | 5,594 → **5,594 B** | 0.0% | intact both |
| mintlify | 525,924 → 6,223 B | 1.8% | 9,549 → **9,549 B** | 2.4% | **before LOST it** |

Mintlify is the one that shows the stakes plainly. The HTML arm produced a
*smaller* document that did not contain `docs.json` or `navigation` at all —
that page's body is client-rendered, so the converter faithfully transliterated
a shell. The markdown arm is larger *and* carries the article. Fewer bytes is
not the goal; the article is.

This is also why no byte threshold could ever have worked: on this table the
right answer is sometimes "smaller" and sometimes "bigger".

## Route 2 — the algorithm, on hosts that publish no markdown

`developer.mozilla.org` and `docs.python.org` return HTML to the markdown
`Accept`, so route 1 cannot help and the classifier has to earn its keep.
Run over three pages of each, in order:

| host | page | doc bytes | blocks | template blocks | template bytes | provisional | article in index |
|---|---|---:|---:|---:|---:|---|---|
| mdn | AbortController | 3,738 | 30 | 0 | 0 | **yes** (page 1) | yes |
| mdn | AbortSignal | 11,810 | 75 | 13 | 1,008 | no | yes |
| mdn | Blob | 8,287 | 64 | 19 | 710 | no | yes |
| py | csv | 29,677 | 203 | 0 | 0 | **yes** (page 1) | yes |
| py | json | 35,218 | 290 | 20 | 788 | no | yes |
| py | sqlite3 | 105,510 | 799 | 109 | 1,374 | no | yes |

Page 1 of each host is provisional with zero template blocks — the design
refuses to guess with no comparison set. Page 2 of each host reported
`relabelled: 1`: the cold-start page was re-classified the moment evidence
existed.

The three invariants were checked on every one of these fetches and held:

- `reassemble(splitBlocks(doc)) === doc` — byte for byte.
- stored `full_text` === the converted document — byte for byte.
- the template stream is still retrievable after being labelled out.

## The same three invariants, against the live production store

After the `claude -p` runs, read back from
`~/.claude/context-mode/content/fetch-pages.db` (`/tmp/claude-501/verify-store.mts`):

| page | stored bytes | blocks | template blocks | blocks reassemble to full_text | template recoverable |
|---|---:|---:|---:|---|---:|
| docs.python.org/3/library/csv.html | 29,663 | 203 | **17** | true | 823 B |
| docs.python.org/3/library/json.html | 35,204 | 290 | 20 | true | 842 B |
| docs.stripe.com/api/charges/object | 11,743 | 50 | 0 | true | 0 B |

`csv.html` was fetched as page 1 with **0** template blocks and reads back with
**17**. That is the cold-start re-run, persisted to disk, in the real store.

## Why "label, never drop"

Under-matching leaks chrome: visible, and recoverable on the next fetch of that
host. Over-matching hides content: silent, and there is nothing left to detect
it with. The normaliser is therefore deliberately conservative (whitespace and
case only — no punctuation stripping, no token dropping), and the classifier
only ever labels a block `template` when that exact block was already seen on a
*different* page of the same host.

This is visible in the python run: the `### Navigation` heading is template,
but the nav's `next`/`previous` links are not, because they genuinely differ
per page. Those lines stay in the index. That is the correct outcome — they are
page-specific by construction, and demoting them would be a guess.

## Where this does not run

The gateway (`context-mode-sandbox`) has no fetch path. Verified 2026-08-12:
`grep -rln "toMarkdown" --include="*.ts" --include="*.mjs"` returns nothing
outside `node_modules`, and `fetch_and_index` appears only under `docs/`. No
fetch path was invented there; the change ships where the code actually runs.

Cloudflare `toMarkdown` was not adopted for the same reason. It is a converter,
and the measurements above show the converter was never the binding constraint
— route 1 beats it on every one of the six platforms (Stripe: 11,744 B of pure
article vs 24,755 B of nav-plus-article), and reaching it from the OSS plugin
would add a Cloudflare account credential to a local Node subprocess that
currently needs none.
