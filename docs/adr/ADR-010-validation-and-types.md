# ADR-010 — Validation and types

- **Status:** Accepted
- **Date:** 2026-11-01
- **Deciders:** project owner (delegated to Claude Code, autonomous mode)
- **Supersedes / Amended by:** amended by §14 **A5** (`03` §3.3–3.4 own the authoritative IFC/policy types), **A7** (`02` owns the physical schema and the entity list), **A23** (`ToolDefinition` gains `uses`, `confirm`, `grantsDelegation`)

## Context

Village's inputs are all hostile or unreliable in some way:

- platform payloads from six chat apps, each with its own optional fields and migrations;
- LLM output, including structured output that the model can still get wrong;
- tool arguments produced by a model, which may be prompt-injected;
- HTTP bodies from a browser session;
- `village.yaml` and environment variables typed by a human;
- JSON columns read back out of SQLite, possibly written by an older build.

`01` §11.2 therefore requires zod validation at **every** boundary — and §11.6 bans silent catches. Two more constraints shape the type design:

- Village juggles many ids that are all strings: group, member, person, conversation, message, memory, turn, label. Passing a `MemberId` where a `PersonId` belongs must not compile.
- Domain logic lives in a pure core with no I/O. A policy denial, an IFC refusal, a conflicting edit or a failed precondition are **normal outcomes**, not exceptional ones, and they must be exhaustively handled by callers.

## Decision

| Item | Choice |
|---|---|
| Schema language | **zod v4**, at every boundary: config, HTTP, adapters, tool I/O, LLM structured outputs, and DB JSON columns (validated on **write and read**, `02` §2 D21) |
| Id types | **Branded TS types per entity** over TypeID strings (ADR-019), so ids of different entities are not interchangeable |
| Domain results | **Discriminated unions.** Domain decisions return a union (`allow` / `deny` / `needs_confirmation` / `contested` / …), never a thrown error. Every `switch` over one is exhaustive with a `never` assertion (`01` §11.3) |
| Throwing | **Only bugs and infrastructure failures throw.** A denied action, an unreadable row, an invalid proposal or a conflicting write is a value. A failed disk write, a corrupt row or a violated invariant is an exception |
| Error handling | No silent catches. Every caught error is handled, mapped to a typed error, or rethrown with context (`01` §11.6) |
| Strict JSON Schema | **One** zod v4 → strict JSON Schema converter, shared by the model adapters and the plugin SDK (`M2-T4`), so tool schemas sent to a provider and tool schemas validated locally can never diverge |

Ownership, as amended: the IFC and policy types sketched in `01` §7.2–7.3 are **authoritative in `03` §3.3–3.4** (A5); the physical schema and the full entity list are authoritative in `02` (A7); `ToolDefinition`'s extra fields come from A23.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **io-ts** | A heavier functional-programming style (`fp-ts` codecs, `Either` everywhere) that would set the idiom for the entire codebase, and a much smaller ecosystem for the things we need off the shelf — OpenAPI generation (`@hono/zod-openapi`) and JSON-Schema emission for tool definitions. |
| **valibot** | Smaller bundles, which matters for a browser payload and not for a server. zod v4 closed most of the performance gap, and zod is what the surrounding ecosystem we depend on (Hono's OpenAPI middleware, clack's Standard-Schema validation) speaks natively. One schema language beats a marginally faster one. |

## Consequences

**Good**
- A single schema definition per boundary produces the runtime parse, the TypeScript type, the OpenAPI component and the JSON Schema for tool use. Four artefacts cannot drift.
- Branded ids turn a whole class of cross-entity mix-ups into compile errors — important when a leak could be caused by passing the wrong member id into an audience.
- Discriminated-union outcomes make "did you handle a denial?" a type-checker question, which is the only scalable way to keep policy decisions from being dropped.
- Validating JSON columns on read catches migration bugs on the first read instead of in a user's group.

**Bad / accepted costs**
- Parsing on read costs CPU on hot paths, including ingestion (20 ms p95 budget), so hot schemas have to be lean.
- Branded types require explicit constructors and occasional casts at the storage edge.
- `exactOptionalPropertyTypes` plus zod optionals is a fiddly combination in adapter code that mirrors loose platform payloads.
- Every new boundary is extra ceremony; the payoff is that no boundary is accidentally trusted.

**Follow-ups**
- `M0-T6` — shared foundation libraries: `Result` helpers, typed errors, zod utils, `assertNever`, and the config-loader skeleton.
- `M2-T4` — the single strict JSON-Schema converter.
- `M2-T5` — plugin-SDK tool types including the A23 fields.
- `M1-T10` — storage column helpers and custom types (`jsonOf(schema)`).

## References
- `docs/plan/01-architecture.md` §2 ADR-010, §11.1–§11.3, §11.6, §14 A5, A7, A23
- `docs/plan/02-domain-model-and-storage.md` §2 D21
- `docs/plan/03-group-intelligence.md` §3.3–§3.4 (authoritative IFC and policy types)
