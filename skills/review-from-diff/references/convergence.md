# Convergence: which hop is worth taking, and when to stop

"Repeat until it converges" is not a rule. This is.

---

## State the walk carries

| Name | What it holds |
|---|---|
| `visited` | every symbol already expanded, keyed by qualified name → the hop it was reached at |
| `frontier` | the symbols this hop will expand (starts as the changed symbols whose contract changed) |
| `findings` | rows reached but deliberately **not** expanded, with the reason |
| `hop` | 0 for the diff itself; each `impact` round increments it |
| `calls` | `ctx_graph` calls spent so far |

Keep it in your own working notes, not in a file. If the walk is long enough
that the state itself is getting expensive, `ctx_index(content: <the table>,
source: "review-<branch>")` and search it back — that is cheaper than
re-deriving it, and it survives a compaction mid-review.

---

## Seeding: which changed symbols enter hop 1

Only symbols whose **contract** changed. The contract is the four things a
caller can depend on without reading the body:

1. **Signature** — parameters, their types, their order, optionality, defaults.
2. **Return and error shape** — return type, nullability, which errors are
   thrown or returned, whether it became async.
3. **Side effects** — what it writes, mutates, caches, emits, or no longer does.
4. **Invariants a caller relies on** — ordering, idempotency, thread/async
   safety, the units or ranges of what it returns.

A hunk that changes none of these is a **depth-0 finding**: record it, review it
on its own merits, and do not seed a walk from it. This single test is what
keeps a 40-file refactor from expanding into the whole repository.

---

## Expansion predicate

A row returned by `impact` enters the next frontier only if **all four** hold.

1. **New** — its qualified name is not in `visited`. Re-expanding a symbol is
   the most common way to spend the budget on nothing.
2. **Outside the diff** — the row's `file:line` does not fall inside a changed
   range from Stage 2. Call sites you already changed are already reviewed.
3. **Reviewable** — the file is not under `node_modules/`, `vendor/`,
   `third_party/`, `dist/`, `build/`, `out/`, `.next/`, `target/`, `generated/`,
   `__snapshots__/`, and is not `*.min.js`, `*.pb.*`, `*_pb2.py`,
   `*.generated.*`, or a lockfile. Generated code is regenerated, not reviewed.
4. **Contract-carrying** — the seed's change can actually reach it. A body-only
   change (contract intact, per the four points above) reaches nobody: record
   its depth-1 rows as "call sites unaffected" and expand none of them.

Rows failing 2, 3 or 4 are not discarded — they go into `findings` with the
reason. "Twelve callers, none affected because the signature is unchanged" is a
review result, and the reason is the part that makes it trustworthy.

**Tests are kept, never expanded.** A test that calls the changed symbol tells
you which contract was asserted — the most valuable depth-1 row there is. But
nothing calls a test, so expanding it costs a call and returns nothing.

---

## Ranking inside a hop

Cap the frontier at **8 symbols per hop**. When more survive the predicate,
take them in this order and put the rest in `findings` as unexpanded:

1. Exported / public symbols before file-private ones — a private helper's
   callers live in a file you have already seen.
2. Depth-1 rows before depth-2 rows.
3. Symbols in files that also appear in the diff — the change already touches
   two points on that path, which is where breakage concentrates.
4. Symbols with the most inbound rows — widest surface first, so a cap that
   fires later has already covered the important part.

---

## Stop conditions

Stop at the **first** one that fires.

| Condition | Meaning | What to report |
|---|---|---|
| A hop adds **zero new symbols** | Converged. The wanted ending. | "Converged at hop N; the affected surface is closed." |
| **hop = 3** | Each hop is an `impact` walk of `depth: 2`, so three hops is a radius of six edges. Past that a caller is reacting to its own contract, not to yours. | "Depth cap at hop 3; N symbols beyond it were not walked." |
| **40 symbols visited** | The change is wide. | Radius unbounded — see the fallback below. |
| **12 `ctx_graph` calls** | The walk is costing more than the review is worth. | Same fallback. |

A cap firing is a **finding about the change**, not a failure of the walk. A
change whose blast radius does not close inside six edges and forty symbols is a
change that wants splitting, and saying so is more useful than a partial list of
leaves.

---

## File collapse

When five or more rows come from the same file, stop treating that file's
symbols individually:

```javascript
ctx_graph({ action: "outline", file: "src/server.ts", signaturesOnly: true })
```

Take the outline once, treat the file as a single node in the walk, and review
it at file level. Five symbols in one file is one reviewer reading one file, not
five graph queries.

---

## When the surface is too wide

Drop from symbol level to file level and finish there rather than abandoning
the review:

```javascript
ctx_graph({ action: "related", file: "src/store.ts", depth: 1 })
```

`related` returns the symbols and files the graph places next to a file, by
imports and calls. One call per changed file gives the neighbourhood of the
whole change for the price of a handful of rows. Report the neighbourhood, name
the boundary the change crosses, and say plainly that the symbol-level walk was
cut off and where.

---

## Worked shape

```
hop 0  diff: 3 files, 11 ranges → 4 changed symbols
       2 body-only  → findings (contract intact)
       2 contract   → frontier [parseConfig, ConfigStore.load]

hop 1  impact(parseConfig, depth 2)       → 9 rows
         3 inside the diff                → findings
         2 in dist/                       → findings (generated)
         1 test                           → findings (kept, not expanded)
         3 new                            → frontier
       impact(ConfigStore.load, depth 2)  → 4 rows, 1 new → frontier
       frontier = 4, visited = 6, calls = 2

hop 2  4 × impact → 6 rows, 1 new (a subclass overriding load)
       frontier = 1, visited = 11, calls = 6

hop 3  1 × impact → 3 rows, 0 new
       CONVERGED — 11 symbols, 7 calls, no whole file read
```
