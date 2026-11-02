# ADR-023 — Tool catalog strategy

- **Status:** **Proposed** — decided by **SP-5 (`M2-T20`)** and finalised by **`M13-T15`**
- **Date:** 2026-11-01
- **Deciders:** project owner (delegated to Claude Code, autonomous mode)
- **Supersedes / Amended by:** amended by §14 **A13** (the cached tool layer is keyed by a catalog hash; requester capabilities, audience and time move to a per-turn system message)

## Context

- Village ships **62 built-in tools** plus an optional `web_search`, in a fixed, authoritative order (`05` §3.6.7), and a group may enable extension tools on top (`10`).
- Tools are the **first** thing in the prompt (`tools → system → messages`, `01` §6.3) and therefore sit at the base of the cached prefix. Anything that varies per requester at that position invalidates the cache for everyone.
- Cost is the top product risk after leaks (`15` §3 R-2): roughly $67/month for a typical family on the Best preset, which is why per-preset budgets exist (A3). Cache hit rate is the single biggest lever on that number.
- The obvious-looking optimisation — show each member only the tools they may use — is a trap twice over: it fragments the cache per role, and it leaks capability information into the prompt. Policy already rejects unauthorized calls with a clear `is_error`, so hiding tools buys nothing in safety.
- But the opposite is also unproven: a large static catalog means a large cold-write surcharge on every cache miss, and arm C (deferred tool loading) is estimated to roughly **halve** it (`05` §8).

This is a measurement question, so this ADR is **Proposed**, not Accepted.

## Decision (proposed — the spine default until SP-5 reports)

**One stable, ordered catalog, keyed by a catalog hash, with policy gating execution.**

| Item | Proposed choice |
|---|---|
| Catalog contents | Built-ins in **fixed table order** (`05` §3.6.7 is the single authoritative list and order), then the group's enabled extension tools sorted by `(providerId, tool)` |
| Cache key (**A13**) | **`catalogHash = sha256(canonical JSON)`** of that list. The cached tool layer is keyed by it, so groups with the same enabled set **share** the cache entry and no group's extensions leak into another's prompt |
| Visibility | Tools the requester cannot use are **still listed**, and are rejected by policy with a clear `is_error` result |
| Per-turn variability (**A13**) | Requester capabilities, audience and current time go in a **per-turn mid-conversation system message**, not in the charter, so the charter and the tool layer stay fully cacheable |
| Catalog changes | Adding, renaming or removing a built-in is a **`catalogVersion` bump** with a changelog line, and requires **E-CAT re-measurement if the token size grows by more than 10%** |
| Experiment | **E-CAT**: arm A (full catalog) vs per-role catalogs vs arm C (deferred loading). Adopted only if an alternative shows **≥ 15% lower cost per turn at equal quality** (`05` §2 D10) |

### How this gets decided

| Stage | Task | What it produces |
|---|---|---|
| First measurement | **SP-5** = **`M2-T20`** (run together with SP-4) | `cache_read_ratio`, cost per turn and TTFT for arm A vs arm C, alongside top-level vs per-message effort and 1h vs 5m cache TTL, on synthetic traffic. Sets the `05` §5 defaults and writes the **draft** of this ADR |
| Final decision | **`M13-T15`** ("E-CAT final") | Re-runs E-CAT on **simulator** traffic with the `05` §3.4.9 metrics and moves this ADR's status to **Accepted** |

Until SP-5 reports, the spine default applies: **full catalog, policy rejection**.

## Alternatives considered

| Alternative | Why not (pending measurement) |
|---|---|
| **Per-role catalogs** | Fragments the cached tool layer into one entry per role, so the prefix everyone shares becomes several prefixes nobody shares — and the cache is the main cost lever. It also puts capability information into the prompt, which is exactly the kind of inference signal we try not to create, for no safety benefit: policy already gates execution. It stays an arm of E-CAT rather than a rejection on principle. |
| **Deferred tool loading** (arm C) | Genuinely attractive on cost — an estimated ~50% reduction in the cold-write surcharge with a ~4K prefix — but it adds a round trip when the model discovers it needs a tool, which costs latency on exactly the turns that already use tools, and it makes the cached prefix depend on what the model asked for. Carried as arm C in E-CAT and adopted only against the ≥ 15%-at-equal-quality bar. |

## Consequences

**Good**
- Groups with the same enabled extension set share one cached tool layer, which is where the cost savings actually come from.
- Listing unusable tools keeps a single global prefix and avoids leaking who can do what.
- The catalog hash makes "did the prompt prefix change?" an observable, testable fact rather than a guess, and keeps one group's extensions out of another group's prompt.
- A13's per-turn system message means per-requester context costs no cache stability at all.
- The decision is tied to measured `cache_read_ratio` and cost per turn, with a pre-committed adoption bar, so it cannot be settled by preference.

**Bad / accepted costs**
- A large static catalog means a large cold-write surcharge whenever the cache misses.
- The built-in catalog's order is frozen and cross-checked in CI, so refactors cannot reorder it casually; changes carry a `catalogVersion` bump and possibly a re-measurement.
- Policy-rejected tool calls are visible to the model as `is_error` results, which spends a few output tokens and needs clear tool-level copy so the model does not retry blindly.
- This ADR stays **Proposed** through most of the project, so anything depending on it must tolerate either outcome until `M13-T15`.

**Follow-ups**
- `M2-T17` — catalog canonicalization and `catalogHash`.
- `M2-T20` — **SP-5** (with SP-4): the first E-CAT measurement; writes this ADR's draft.
- `M7-T36` — built-in tool catalog freeze.
- `M13-T14` — final cache TTL and effort strategy.
- `M13-T15` — **E-CAT final**: records the decision with the `05` §3.4.9 metrics and sets the status to Accepted.

## References
- `docs/plan/01-architecture.md` §2 ADR-023, §6.3, §14 A13
- `docs/plan/05-agent-runtime.md` §2 D10; §3.4.9 (catalog stability and experiment E-CAT); §3.6.7 (the authoritative built-in catalog); §8 (cost)
- `docs/plan/10-extensibility.md` §2 X-12 (catalog caching)
- `docs/plan/15-risks-and-open-questions.md` §3 R-2, §4 SP-5
