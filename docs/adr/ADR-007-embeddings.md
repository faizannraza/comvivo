# ADR-007 — Embeddings

- **Status:** **Accepted (addendum pending SP-6)**
- **Date:** 2026-11-01
- **Deciders:** project owner (delegated to Claude Code, autonomous mode)
- **Supersedes / Amended by:** amended by §14 **A18** (default chosen by the M6 bake-off; baseline baked into the image; lazy worker-thread load with idle unload)

## Context

- Memory retrieval is hybrid: FTS5 for keywords and vectors for meaning (ADR-005). Vectors therefore exist for **memories**, which are the most sensitive rows in the database — exactly the content that must not leave the host by default.
- Sending every memory to an embedding API would mean the private content of a family's life transits a third party on every write. That contradicts the product's core claim (`00` §3.5) and would make the "works offline" and "runs on a Pi" promises impossible.
- The hardware floor is a Raspberry Pi 5. An embedder that holds hundreds of MB of RSS permanently would blow the idle-RSS target, which is a measured success metric (A22: idle RSS is measured 10 minutes after the last turn, **with the embedder unloaded**).
- Groups are multilingual, including code-mixed messages and non-Latin scripts, so model choice is a quality question that must be measured on a real retrieval set rather than argued from a leaderboard.

## Decision

**Local by default, in a worker thread, with a measured default model.**

| Item | Choice |
|---|---|
| Runtime | **`@huggingface/transformers`** (transformers.js, ONNX), running **in-process** on the host — no network call for embeddings in the default configuration |
| Process model (**A18**) | The embedder loads **lazily in a worker thread** and **unloads when idle**, against an idle-RSS target. Query embedding preempts batch embedding (priority lane) |
| Baseline model (**A18**) | **`multilingual-e5-small`** (MIT, 384-d, mean pooling, requires the `query: ` / `passage: ` prefixes). It is **baked into the image** (`12` §2 P5), read-only, so embeddings work offline and on first boot |
| Challenger (**A18**) | **`granite-embedding-97m-multilingual-r2`** (Apache-2.0, 384-d, CLS pooling, no prefix) |
| Opt-in only (**A18**) | **`bge-m3`** (1024-d, ~568 MB int8) — too heavy for the Pi latency/RSS budget; offered as `embeddings.model: bge-m3` for hosts with ≥ 4 x86 cores |
| Default decided by | **SP-6**, the **M6 bake-off** (`M6-T7`), under the fixed pass rules in `04` §3.8.1 |
| Pluggable providers | OpenAI, Voyage, Google, Ollama — selected per instance, with the egress consequence made explicit |
| Spaces | One embedding space per model/dimension, one `vec0` table per space, with a documented re-embedding migration (create → backfill → dual-write → switch → drop) |

### What SP-6 decides, and the rule it must apply

`multilingual-e5-small` stays the default **unless** a candidate meets **all** of the following on the memory-v1 retrieval set (`04` §3.8.1):

- recall@10 ≥ e5 + 3 points on the full set;
- no regression > 1 point on the code-mixed subset;
- warm query-embed p95 ≤ 40 ms on a Pi 5;
- worker RSS ≤ e5 + 20 MB;
- loads in transformers.js 4.x without custom ops;
- an OSI-approved license.

If `granite-embedding-97m-multilingual-r2` qualifies, it becomes the default. The result — recall@10 on the full, code-mixed and Arabic/Devanagari subsets, p95 embed latency and RSS — is recorded in an `ADR-007-addendum.md` written by `M6-T7`, together with the Pi run. `google/embeddinggemma-300m` is excluded as a default on license grounds (Gemma Terms of Use, not OSI) and is allowed only as a user opt-in.

One consequence of the baseline that the retrieval code must respect: e5 cosine scores cluster in 0.7–1.0, so only **relative order** is meaningful. Raw cosine is never thresholded except for dedupe constants calibrated **per space** (`04` §3.8.1).

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Always-API embeddings** | Every memory write would ship private content off the host, which breaks the product's central privacy claim, adds a hard network dependency to a write path, costs money per write, and makes offline and Pi installs impossible. API providers remain available as an explicit opt-in for hosts who prefer them. |

## Consequences

**Good**
- Embeddings of private memories never leave the host in the default configuration, which is the strongest version of the privacy claim we can make.
- Works offline and on first boot, because the baseline model ships inside the image.
- Cheap: no per-write cost, so memory extraction can be generous.
- Lazy load with idle unload keeps the idle-RSS metric honest on a Pi.

**Bad / accepted costs**
- A 384-d small model is weaker than a large hosted embedder; hybrid retrieval (FTS + vectors + fusion) carries part of the quality burden.
- The baked model adds ~135 MB to the image, against a ≤ 300 MB compressed budget (`12` §2 P6).
- Changing the default model later is a data migration (new space, backfill, dual-write, switch, drop), not a config flip.
- Cold-start latency on the first embedding after an idle unload is paid by whoever triggers it; the priority lane keeps it off the query path as much as possible.
- `granite-…-r2` transformers.js compatibility was **unverified** at plan time, so the bake-off may be decided by a loader failure rather than by quality.

**Follow-ups**
- `M6-T5` — embedding spaces and the local transformers.js worker (lazy load, idle unload, priority lane), plus the OpenAI/Ollama providers and the `embed.items` job.
- `M6-T7` — **SP-6**, the bake-off; writes `ADR-007-addendum.md` and the Pi numbers.
- `M6-T8` — baked model and verified fetcher: SHA-256 values for the chosen default, `allowRemoteModels=false` in the image, size gate.
- `M6-T27` — re-embedding migration.
- `M13-T19` — memory performance hardening on a Pi 5.

## References
- `docs/plan/01-architecture.md` §2 ADR-007, §2.1, §14 A18, A22
- `docs/plan/04-memory-system.md` §3.8 (embeddings), §3.8.1 (model evaluation and the decision rule)
- `docs/plan/12-packaging-release-ops.md` §2 P5, P6
- `docs/plan/15-risks-and-open-questions.md` §3 R-12, §4 SP-6
