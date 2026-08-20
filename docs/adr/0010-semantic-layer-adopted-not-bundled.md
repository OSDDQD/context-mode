# ADR-0010 — The semantic layer is adopted, not bundled

**Status:** Accepted
**Date:** 2026-08-20 — recorded retrospectively; the layer shipped earlier
**Source:** [FORK-CHANGES §6, §18](../FORK-CHANGES.md)

## Context

The ranking pipeline was purely lexical — a Porter matcher and a trigram matcher
fused with RRF. That is excellent at *find the chunk containing `useEffect`* and
blind to *why does the deploy keep failing* when the chunk says *build step
exits 137*. Measured later against the 74-query corpus
([ADR-0017](0017-retrieval-quality-gate.md)), lexical search finds nothing
relevant in the top 5 for **17 of 74 queries** — 13 of the 14 Russian ones and 4
paraphrases.

Closing that gap normally means shipping a model: an ONNX runtime, a few hundred
megabytes of weights, a vendor API key, or all three. For a plugin whose entire
purpose is not spending resources the user did not ask to spend, each of those is
a large standing cost paid by everyone to serve one query class.

The opposite failure is just as real. The first shape of this feature required
two environment variables, which meant it shipped switched off for everyone who
did not read the documentation — and a capability nobody enables is worth
exactly nothing.

## Decision

**Semantic candidates are fused into the RRF that already exists.** Nothing is
replaced; a bad embedding model degrades ranking slightly instead of breaking
search, and an absent one changes nothing at all.

**No model, no runtime, no vendor call.** The layer uses an embeddings endpoint
the operator already runs. `CONTEXT_MODE_EMBEDDINGS_URL` +
`CONTEXT_MODE_EMBEDDINGS_MODEL` configure it explicitly.

**With nothing configured, it adopts what is already running.** The first hybrid
search probes three loopback endpoints — Ollama `:11434`, LM Studio `:1234`,
llama.cpp `:8080` — on a 400 ms budget, once per process with a five-minute
retry window so a runtime started mid-session still counts. Constraints:

- **Loopback only.** An unconfigured install never reaches off the machine.
  `CONTEXT_MODE_EMBEDDINGS_AUTODETECT=0` disables the probe.
- **Never a chat model.** `pickEmbeddingModel` takes the operator's choice, then
  `bge-m3`, then anything that self-identifies as an embedder. "First model in
  the list" is not an acceptable fallback: a chat model answers the embed call
  with plausible garbage, which poisons ranking silently.
- **An explicit URL is never overridden.** If the operator set a URL and only
  the model is missing, the default model is used against *their* endpoint
  rather than a probe finding a different one.

**Vectors are stored int8.** Cosine similarity divides by both norms, so a
per-vector positive scale cancels; quantising to the vector's own peak makes the
table 4× smaller at a measured cosine of **0.99990** against the unquantised
vector — noise far below the gap between any two candidates a ranking has to
separate. Every query walks this table: 1024 dims are 4 KB per chunk as float32
and 1 KB as int8. The decoder tells the formats apart by blob length against the
`dim` the row already carries, so older rows keep working with no migration.
`CONTEXT_MODE_EMBEDDINGS_QUANT=f32` opts out.

**Two budgets, not one.** A single query embedding is ~230 ms; a batch of 16–32
real chunks is 5–15 s. One shared timeout aborts every backfill before it writes
a vector and the index stays permanently cold — invisibly, because search simply
degrades to lexical. The query path keeps a short budget so a hung endpoint
cannot stall an answer; the background path gets a long one.

**The index warms lazily, and `drain` can finish the job.** A batch is embedded
after each answer is returned. `backfillVectorsUntil()` is the bulk pass the
per-search warm-up cannot be, bounded by both a wall clock and a chunk cap, wired
into `context-mode drain` ([ADR-0009](0009-capture-queues.md)) so it runs
detached. Waiting for the per-search batch alone is not a plan: a 1,320-chunk
index needs roughly 83 searches.

**Vectors are pruned, never accumulated.** `chunk_vectors` is keyed on
`chunks.rowid` and `chunks` is an FTS5 table, so a re-index orphans every vector
it had; and two models' vectors are not comparable — different dimensionality
scores 0, *same* dimensionality scores plausible nonsense, which is worse
because nothing looks broken. `pruneOrphanVectors()` and
`pruneStaleModelVectors()` both run before each backfill.

**Wired where cold knowledge is reached, and nowhere else.** `ctx_search` in
relevance mode, and `ctx_batch_execute` / `ctx_gather` with
`query_scope: "global"`. Deliberately **not** the default `query_scope: "batch"`,
where the query runs against output the same call just produced and the caller
already knows the terms.

**Coverage is reported honestly.** "Configured" and "can answer" are different
states, and a cold index degrades to lexical in a way that looks exactly like
working. `ctx_stats` reports embedded-chunk coverage, model, index size, and how
many of this session's semantic passes actually changed a ranking — the only
honest answer to "is the round trip earning its latency?". One line appears in
the response itself when the layer is not answering, once per process, only
above 200 chunks, and only where it would change the result.

## Alternatives rejected

**Bundle a model or an ONNX runtime.** A permanent install-size and
startup cost imposed on every user for one query class, plus a second
supply chain to keep current.

**Require explicit configuration, with no autodetection.** Measured outcome:
the feature is off for almost everyone. Probing loopback is cheap, bounded,
and cannot leak anything off the machine.

**A single timeout for query and backfill.** Guarantees a permanently cold
index whose symptom is "search seems a bit worse".

**Float32 storage.** 4× the bytes read on every query to recover 0.0001 of
cosine.

**Failing loudly when the endpoint is down.** Search must never fail because an
optional side-car is unreachable; degrading to lexical is the correct behaviour
and is what the coverage line exists to make visible.

## Consequences

- The default install behaves exactly as before until a local embedding runtime
  happens to be present.
- `CONTEXT_MODE_EMBEDDINGS=0` is a hard off switch honoured by both the explicit
  and the autodetected path.
- Changing `CONTEXT_MODE_EMBEDDINGS_MODEL` re-warms the index rather than
  leaving it permanently half-degraded.
- CI does not gate on this arm — see
  [ADR-0017](0017-retrieval-quality-gate.md) for why a gate that needs a live
  model is worse than no gate.
