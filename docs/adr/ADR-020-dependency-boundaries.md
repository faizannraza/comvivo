# ADR-020 — Dependency boundaries

- **Status:** Accepted
- **Date:** 2026-11-01
- **Deciders:** project owner (delegated to Claude Code, autonomous mode)
- **Supersedes / Amended by:** amended by §14 **A11** (new packages and six rule changes — listed in full below)

## Context

The architecture's safety properties are **structural**, not procedural. Two of them in particular are enforced by who is allowed to import what:

- **No read-up (I1).** Only the context builder may call memory search, and only through the eligible-label filter. If any other module could call it, an IFC bypass would be one careless import away.
- **Requester authority (I3) and acknowledged effects (I7).** Only the tool executor may call mutating repositories on behalf of the model, because that is where policy authorization and journaling live.

Two more depend on it indirectly: `@village/core` must stay pure (no I/O, no `Date`, no `Math.random`, no `process`, no `node:*`) or it stops being deterministically testable, which is what makes property-based invariant tests possible at all; and the browser demo requires that `core`, `tools`, `channels/sdk` and `channels/simulator` contain no Node-only imports.

The project will also accept outside contributions from people who have not read the spine. A convention that exists only in a document will not survive that (`01` §2 ADR-020's own rationale: "the architecture stays true as contributors arrive").

## Decision

**The dependency rules in `01` §4, as amended by A11, are enforced by `dependency-cruiser` in CI.**

Base graph (`01` §4):

```
shared     → (nothing internal)
core       → shared
storage    → core, shared
models     → core, shared
channels/* → channels/sdk, core, shared          (never engine/storage)
tools      → core, shared, plugin-sdk            (repositories arrive via ToolContext ports, never by importing storage)
engine     → core, shared, tools (registry types only), channels/sdk (types only)
mcp        → core, shared, engine (public service interfaces only)
plugin-sdk → core (public types only), shared
evals      → everything (test-only)
apps/server    → everything (composition root)
apps/cli       → shared, storage (migrations/backup), apps/server (start)
apps/dashboard → generated API client only
```

Plus the base purity rules: `core` must not import `node:*`, use `Date`, `Math.random` or `process`, or perform any I/O — clock, ID generator and RNG are injected.

### A11's changes, in full

**New packages added to the graph:** `packages/plugin-host`, `packages/mcp-bridge`, `packages/plugins/*` (first-party), `packages/api-client` (generated), `templates/skills/`, and `packages/shared/src/brand.ts`.

**Rule changes:**

1. `plugin-sdk` **may** import `channels/sdk` types.
2. `engine` **may** import `plugin-sdk` types.
3. `apps/cli` **may** import channel and model **probe** entry points.
4. Memory search may be called from **`engine/context` and `engine/readmodels` only**, and **both must use the eligible-label filter**. (This widens `01` §4's "only `engine/context`" so the dashboard's memory explorer can exist without a second filtering path — `15` §2.)
5. `net`/`http`, `crypto` and `child_process` imports are **restricted to named modules** (`08` PSC-8): network request APIs only in `shared/net` (`safeFetch`) plus the model and channel adapters; `node:crypto`/libsodium only in `shared/crypto` and `storage/crypto`; `node:child_process` only in the sandbox launcher and the transcription runner.
6. **No `node:*` imports in `core`, `tools`, `channels/sdk` or `channels/simulator`** — which is what keeps the browser demo possible.

**Never weaken a rule to make an import work; fix the design** (`CLAUDE.md` §2). Enforcement is dependency-cruiser in `pnpm verify` and CI, backed by TypeScript project references (ADR-002) so most violations fail `typecheck` first, and by lint bans for the purity rules (ADR-003).

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Convention only** (document the rules, enforce in review) | The rules that matter are invisible at the diff level: an `import { MemorySearchPort }` in a new engine module looks completely ordinary, and a reviewer who has not internalised I1 will approve it. Review also does not scale to drive-by contributions, and a single missed import silently removes a privacy guarantee rather than breaking a test. Machine enforcement turns the architecture into a build failure. |

## Consequences

**Good**
- I1 and I3 are enforced by the build: a planted `MemorySearchPort` import outside `engine/context`/`engine/readmodels` fails CI (an explicit acceptance criterion in the memory milestone).
- `core` purity is machine-checked, so the property-based invariant suites stay meaningful.
- Dangerous primitives (network, crypto, subprocess) are confined to named modules, which makes the security review of those surfaces finite (`08` S3, S9).
- Contributors get a fast, specific error instead of a review comment, and the browser demo stays feasible.

**Bad / accepted costs**
- The rule set is non-trivial and must be kept in step with A11 and any future amendment; a stale rule file is worse than none because it breeds exceptions.
- Legitimate new edges require a plan amendment, which is friction by design (A11 is exactly that happening once).
- dependency-cruiser adds a CI job and some configuration maintenance.
- Type-only imports need care: several allowed edges are "types only", which the rule file has to express precisely or it will either leak or over-block.

**Follow-ups**
- `M0-T4` — encode `01` §4 as amended by A11, plus `08`'s security import rules and the `core` purity bans; include planted-violation tests so the rules are proven to fail.
- `M0-T1` — the package skeleton the rules apply to.
- `M6-T7` — the memory retriever, whose acceptance includes dependency-cruiser failing a planted `MemorySearchPort` import.

## References
- `docs/plan/01-architecture.md` §2 ADR-020, §4, §14 A11
- `docs/plan/08-security-privacy.md` §12 PSC-8
- `docs/plan/15-risks-and-open-questions.md` §2 (memory-search callers)
- `CLAUDE.md` §2 (dependency boundaries are never weakened)
