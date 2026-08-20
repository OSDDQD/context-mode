# The walk, stage by stage

Every call below is a tool this plugin already ships. Nothing here needs new code.

---

## Stage 0 — pick the target

| Reviewing | Diff base |
|---|---|
| Uncommitted work | `git diff HEAD` |
| A branch before a PR | `git diff $(git merge-base main HEAD)...HEAD` (three dots: the branch's own commits, not main's) |
| A single commit | `git show --format= <sha>` |

Fix the base once and reuse the same expression in every later command — a walk
seeded from one base and historied from another reports edges that do not exist.

---

## Stage 1 — the diff, without the diff

```javascript
ctx_gather({
  commands: [
    { label: "diff stat",    command: "git diff --stat HEAD" },
    { label: "changed files", command: "git diff --name-status HEAD" },
  ],
  queries: ["which files changed and by how much", "renames and deletions"],
})
```

`--stat` is the whole budget for lockfiles, snapshots, fixtures and generated
output: you see they moved and you move on. `--name-status` gives the `R` rows
that Stage 2 needs for renames.

---

## Stage 2 — changed line ranges, then symbols

Parse the hunk headers in the sandbox; only the range list comes back.

```javascript
ctx_execute({
  language: "javascript",
  code: `
    const { execSync } = require('child_process');
    const EXCLUDE = [
      "':(exclude)*.lock'", "':(exclude)*-lock.json'", "':(exclude)**/__snapshots__/**'",
      "':(exclude)**/generated/**'", "':(exclude)dist/**'", "':(exclude)build/**'",
    ].join(' ');
    let raw = '';
    try {
      raw = execSync('git diff -U0 HEAD -- . ' + EXCLUDE, { encoding: 'utf8', maxBuffer: 64e6 });
    } catch (e) { console.log('git diff failed: ' + (e.message || e)); }
    let file = null;
    const rows = [];
    for (const line of raw.split('\\n')) {
      if (line.startsWith('+++ b/')) { file = line.slice(6); continue; }
      const m = /^@@ -\\d+(?:,\\d+)? \\+(\\d+)(?:,(\\d+))? @@\\s*(.*)$/.exec(line);
      if (!m || !file) continue;
      const start = Math.max(1, Number(m[1]));
      const len = m[2] === undefined ? 1 : Number(m[2]);
      const end = len === 0 ? start : start + len - 1;   // len 0 = pure deletion
      rows.push(file + ':' + start + '-' + end + '\\t' + (m[3] || '').trim());
    }
    console.log(rows.join('\\n'));
    console.log('\\n' + rows.length + ' ranges in ' +
      new Set(rows.map(r => r.split(':')[0])).size + ' files');
  `,
})
```

The text after `@@` is git's own hint at the enclosing declaration. It is a
heuristic, not a parse: it names the **nearest preceding** declaration, so a
hunk in an import block or between two functions is labelled with whatever
declaration came before it, and a range spanning hundreds of lines is labelled
with only the first. Trust it when the range is short and the name is plausible.
Otherwise — and whenever it comes back blank — ask the graph for the file's
shape and intersect by line number:

```javascript
ctx_graph({ action: "outline", file: "src/store.ts", signaturesOnly: true })
```

`outline` returns every declaration in source order with its start line — a few
dozen lines for a file of thousands. The declaration whose range contains a
changed line is the seed. Do this **only** for files the hunk headers failed on.

**Keep the seeds whose contract changed.** A hunk inside a function that leaves
its signature, return shape, thrown errors and side effects alone is a
depth-0 finding, not a seed. See `convergence.md`.

---

## Stage 3 — the hop

```javascript
ctx_graph({ action: "impact", symbol: "resolveSymbol", depth: 2 })
```

`impact` is the right action here and `callers` is not: it walks the same
inbound direction but over calls **plus** references **plus** `extends`, so a
subclass that overrides the changed method and a module that passes the function
by name both show up. Rows carry `depth` — hops from the seed — so depth 1 is a
direct caller and depth 2 is its caller.

- `depth` is clamped to 1..5; `depth: 2` per hop is the working default.
- Use `callees` only when the change *consumes* a new contract (you started
  calling something new and want to know what that pulls in).
- `symbol` accepts a bare name or a qualified name. When a bare name is
  ambiguous the reply says so — qualify it (`ClassName.method`) rather than
  reviewing the wrong one.

---

## Stage 4 — look at the call site, not the file

```javascript
ctx_read({ path: "src/session/attribution.ts", intent: "resolveSymbol" })
```

`intent` is matched literally against the file's text, so the symbol name is the
right thing to pass. What comes back is the file's shape plus the matching
regions with a few lines of context each — enough to judge whether the call site
survives the new contract, without the file entering context.

Do this for depth-1 rows. Depth-2 rows are judged from the graph row alone
unless depth 1 turned out to be broken.

---

## Stage 5 — history of the touched files

One batch, read-only, parallel:

```javascript
ctx_gather({
  commands: [
    { label: "history src/store.ts",  command: "git log -n 5 --date=short --format=%h|%ad|%an|%s -- src/store.ts" },
    { label: "churn on resolveSymbol", command: "git log -n 8 --format=%h|%s -S resolveSymbol -- src" },
    { label: "reverts near this file", command: "git log -n 20 -i --grep=revert --format=%h|%s -- src/store.ts" },
  ],
  queries: [
    "was this contract changed before",
    "was a similar change reverted",
    "who has been touching this file",
  ],
  concurrency: 4,
})
```

`-S <name>` is the pickaxe: commits where the number of occurrences of that
string changed — i.e. where this contract was introduced, moved or removed. A
symbol that has been changed and reverted before is the strongest signal in the
whole walk that the current change needs a second look.

Restrict the history to files that are **in the diff** or that hold a **depth-1**
row. Every other file's history is noise.

If `ctx_gather` refuses a command as not provably read-only, run the same
command through `ctx_execute({ language: "shell", ... })` instead of dropping it.

---

## Stage 6 — repeat, or stop

New frontier = the rows that passed the expansion predicate. Re-enter Stage 3.
Stop conditions are in `convergence.md`.

---

## The renamed-symbol trick

The codegraph index reflects the last index run, not the working tree — every
reply says whether it lags. For this recipe that lag is usable rather than
merely tolerable:

- **Renamed or deleted symbol** — query the **old** name. The pre-change graph
  is exactly the list of call sites that must be updated, and it is unobtainable
  from the post-change tree.
- **Newly added symbol** — `impact` correctly returns nothing; nothing calls it
  yet. Do not read that as "no index".
- **Changed signature, same name** — the index is accurate; no caveat.

When the lag line reports many files behind, say so in the report or re-run
`codegraph init` in the project before trusting an empty result.
