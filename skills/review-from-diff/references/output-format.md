# The shape of the finished review

The walk is worthless if its result reads like a list of graph rows. What the
reader wants is: what does this change reach, what of it is broken, and how far
did you actually look.

---

## Sections

**1. Verdict, one line.** "Converged at hop 2 — 11 symbols reached, 2 call sites
need updating." Or: "Radius unbounded at the 40-symbol cap; this change wants
splitting."

**2. Affected surface.** One row per symbol the change reaches that is not
already in the diff.

| Symbol | Hop | Where | Why it is reached | Verdict |
|---|---|---|---|---|
| `SessionStore.restore` | 1 | `src/session/store.ts:214` | calls `parseConfig`, which now returns `null` on a missing key | **breaks** — dereferences without a guard |
| `CachedConfig` | 2 | `src/config/cache.ts:37` | extends `ConfigStore`, overrides `load` | **check** — the override keeps the old signature |
| `parse.test.ts` | 1 | `tests/config/parse.test.ts:9` | asserts the old throw | **update** — the asserted contract changed |

Ranked by verdict, then hop: `breaks` before `check` before `fine`.

**3. Reached and not affected.** One line, not a table: "9 further call sites at
depth 1-2 are unaffected — the signature and error shape are unchanged." This is
the sentence that makes the whole thing trustworthy; without it a short table
reads like a walk that gave up.

**4. Not walked, and why.** Generated and vendored paths skipped, rows dropped
by a cap, frontier symbols left unexpanded by the per-hop limit. Name them.

**5. History.** Only when it says something: this contract was changed and
reverted in `abc1234`; this file has three authors in the last month; the symbol
was introduced two weeks ago and has no callers outside the diff.

**6. Index freshness.** If any `ctx_graph` reply reported the index lagging the
working tree, say so here with the number of files, because it bounds every
"nothing else is affected" claim above.

---

## Costs to state honestly

If you fell back to file level, say which files were reviewed as a unit rather
than symbol by symbol. If you read a whole file after all — sometimes correct,
for a short file whose every line changed — say that too. A review that hides
where it economised cannot be checked.

---

## What this review is not

It does not hunt bug classes. It will not find an off-by-one inside an unchanged
function, a missing `await` that breaks nothing structurally, an injection, or a
performance regression that keeps every signature intact. A defect-hunting
review — the host's own review command, or a security review — does that, and
does it by reading the changed lines closely rather than by walking edges.

The two compose in one direction: run this walk first and hand the defect hunt
the blast radius. "These four files and these two call sites are what the change
reaches" turns an unbounded read into a bounded one. Running it the other way
round gains nothing.

Say which one you ran. A reader who thinks they got a defect review and got a
reachability walk will trust it for something it never claimed.
