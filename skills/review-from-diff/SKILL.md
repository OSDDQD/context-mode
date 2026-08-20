---
name: review-from-diff
description: |
  Review changes by walking outward from the diff through the code graph, so only the
  affected surface enters context. Use on "review my changes", "review this diff",
  "what breaks if I change this", "what does this change affect", "impact of this diff",
  "blast radius", "did I break any callers", "check this before I open a PR", or any
  pre-PR / pre-merge check. Composes git diff with ctx_graph (impact, callers, outline,
  related), ctx_read and ctx_gather instead of reading whole files.
---

# Review from the diff outward

A reviewer who reads only the diff misses the call sites the change breaks. A
reviewer who reads whole files floods the context and still misses them. This
walks the graph outward from the changed symbols and stops when the change
converges, so only the affected surface is ever loaded.

Not a defect hunt. A review command looks for bugs in the lines you wrote; this
answers **what those lines reach**. They compose — run this first, and the
blast radius tells the defect hunt where to look.

## The loop

1. **Diff** — `ctx_gather` for `git diff --stat` and `--name-status`; `ctx_execute` to parse `git diff -U0` into changed line ranges. Read hunks, never whole files.
2. **Seed** — map ranges to symbols: git's hunk headers first, `ctx_graph(action: "outline", file, signaturesOnly: true)` where they are silent. Keep the symbols whose **contract** changed.
3. **Hop** — `ctx_graph({action: "impact", symbol, depth: 2})` per seed: callers, referencers and subclasses in one walk.
4. **Inspect** — for the rows at depth 1, `ctx_read(path, intent: "<symbol>")` returns the call-site region, not the file.
5. **History** — one `ctx_gather` (`concurrency: 4`): `git log` per touched file, `git log -S<symbol>` per changed contract. Has this contract broken before?
6. **Repeat** from 3 with the surviving rows as the new frontier, until the rule below fires.

## Convergence rule

Expand a row only if all four hold — **new** (not already visited),
**outside the diff**, **reviewable** (not vendored, generated, `dist/`, lockfile
or snapshot), and **contract-carrying** (the seed's signature, return or error
shape, side effects or invariants changed; a body-only change stops at depth 1).

Stop at the first of: a hop that adds **zero new symbols** (converged — the
wanted ending); **hop 3**; **40 visited symbols**; **12 `ctx_graph` calls**.
Hitting a cap is a finding, not a failure: report the radius as unbounded and
drop to file level with `ctx_graph(action: "related", file)`.

## Never

- `Read` a whole file to see one call site — `ctx_read(path, intent:)`.
- Paste the whole diff. Exclude lockfiles, snapshots and generated paths by pathspec and review those from `--stat` alone.
- Grep a symbol name instead of `impact` — grep finds the string, not the edge, and misses subclasses and re-exports while flooding on common names.
- Expand into `node_modules/`, `vendor/`, `third_party/`, `dist/`, generated or snapshot files.
- `ctx_graph(action: "explore")` during the walk — it returns bodies. At most once, at the end, for the single hardest path.
- Present a stale answer: every `ctx_graph` reply states whether the index lags the tree. Quote that line, or re-index first.

## References (load on demand)

- `references/walk.md` — the six stages with the exact calls, the diff→symbol script, branch vs working-tree targets, and the renamed-symbol trick.
- `references/convergence.md` — the expansion predicate in full, ranking within a hop, caps, file collapse, and the too-wide fallback.
- `references/output-format.md` — the shape of the finished review, and where this stops and a defect-hunting review starts.
