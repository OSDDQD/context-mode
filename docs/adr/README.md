# Architecture decision records

Each file records **one decision**: the problem as it actually occurred, what
was decided, which alternatives were rejected and why, and what the decision
costs. They are not change summaries — for the chronological record of what
changed and with which measurements, see
[`docs/FORK-CHANGES.md`](../FORK-CHANGES.md).

A record is not edited when the world moves under it. It gains a dated
amendment, or a **What is true today** section, so the reasoning stays readable
as the reasoning of its moment.

## Index

| # | Subject |
|---|---|
| [0001](0001-sessiondb-multi-writer.md) | SessionDB is multi-writer-safe — concurrent hooks share one database instead of a single-writer guard |
| [0002](0002-tool-description-style.md) | Tool description voice and structure — what a description must say, and how it is checked |
| [0003](0003-routing-deny-reasons.md) | Routing deny reasons: a redirect must not speak the vocabulary of a restriction |
| [0004](0004-stats-strict-compression-formula.md) | Stats display uses the strict-compression formula |
| [0005](0005-stats-scope-labels-and-containment.md) | Stats scope labels and containment — three scopes, each named for what it measures |
| [0006](0006-execution-isolation-posture.md) | Execution isolation posture — a separate subprocess, not a sandbox, and why no OS sandbox |
| [0007](0007-content-hash-index-cache.md) | Content-hash index cache — skip the rewrite when the bytes are unchanged, and who gets the attribution |
| [0008](0008-escalation-economics.md) | The economics of escalation — an intervention must cost less than what it prevents |
| [0009](0009-capture-queues.md) | Capture queues: hooks append a line, the server drains it, and a drain claims only its own project |
| [0010](0010-semantic-layer-adopted-not-bundled.md) | The semantic layer is adopted, not bundled — an endpoint you already run, int8 vectors, two budgets |
| [0011](0011-host-memory-indexed-never-injected.md) | Host memory is indexed and searchable, never injected and never written to |
| [0012](0012-fork-identity-and-upgrade-source.md) | Fork identity, release versioning and the upgrade source — an upgrade must never be a silent downgrade |
| [0013](0013-tracked-bundles-are-the-running-code.md) | Tracked bundles are the running code — build them, test against them, and move the version that keys their cache |
| [0014](0014-standing-context-budget.md) | The standing context budget — bytes shipped on every request or session have to earn it |
| [0015](0015-content-store-lifecycle.md) | Content-store lifecycle — age is the only reason to delete, eviction stays off the hot path, purge refuses to guess |
| [0016](0016-response-declares-what-it-omits.md) | Search responses declare what they omit — verbatim repeats are pointed at, completeness is claimed only when provable |
| [0017](0017-retrieval-quality-gate.md) | Retrieval quality is gated on the deterministic arm, and the report is protected from the harness |
| [0018](0018-code-aware-chunking.md) | Source files chunk at declaration boundaries, with a byte-exact way back |
| [0019](0019-index-time-credential-screening.md) | Credential screening at index time — two layers, tuned against false positives, honest about what it is not |
| [0020](0020-tooldeps-seam.md) | Splitting the server: dependencies travel as data through `ToolDeps`, never as an import back |
| [0021](0021-retrieval-consolidation.md) | Retrieval consolidation — fff in-process, codegraph read-only, one watcher, five signals fused into `ctx_find` |
| [0022](0022-honest-savings-accounting.md) | Honest accounting for what routing saves — fitted tokens, returns subtracted, adherence measured |
| [0023](0023-two-supported-hosts.md) | Two supported hosts — fifteen removed in one deletion-only commit, because the multiplier was the cost |
| [0024](0024-boundary-with-native-tools.md) | The boundary with the host's own tools — a read-only twin, artifact passthrough, and an opt-in with its trade written down |
| [0025](0025-the-rung-that-asked.md) | The rung that asked — a prompt whose two answers were both losses becomes a redirect on Bash, and stays a prompt where a human is genuinely being asked something |

## Writing a new one

Continue the numbering. Keep the shape: **Context** (what actually happened,
with numbers where they exist) → **Decision** → **Alternatives rejected** →
**Consequences**, including the ones that hurt. State the trade in the record
rather than leaving it to be discovered later while reading a report.
