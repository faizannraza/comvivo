# ADR-019 — Identifiers

- **Status:** Accepted
- **Date:** 2026-11-01
- **Deciders:** project owner (delegated to Claude Code, autonomous mode)
- **Supersedes / Amended by:** —

## Context

- Village has many entity types whose ids are all strings and frequently travel together: group, member, person, conversation, message, memory, turn, label, task, event, poll, plan, decision, job. Several APIs take two or three of them in a row.
- Ids appear in content-free logs and in audit rows. When content cannot be logged (ADR-013, `01` §11.7), the id **is** the debugging handle, so it has to be readable and self-describing.
- Polymorphic references exist (an audit row or a `TurnEffect` points at "some entity"), so an id should say what it refers to.
- `core` is pure and has no RNG; the ID generator is an injected port (ADR-020). Tests need deterministic ids.
- Storage needs stable integer rowids for FTS5 and `vec0`, which is a separate concern from the public id.

## Decision

| Item | Choice |
|---|---|
| Id format | **TypeID** (`typeid-js`): a type prefix plus a UUIDv7-based suffix — `grp_01j…`, `mbr_01j…`, `mem_01j…` |
| TypeScript | **Branded types per entity** (ADR-010), so a `MemberId` cannot be passed where a `PersonId` is expected |
| Storage | TypeID strings in `TEXT` columns (30–32 chars). Tables indexed by FTS/vec additionally carry `rid INTEGER PRIMARY KEY AUTOINCREMENT` plus `id TEXT NOT NULL UNIQUE` (`02` §2 D1) |
| Generation | Through an injected `IdGenerator` port; a monotonic generator in `storage`, a `DeterministicIds` implementation in tests (`M0-T7`, `M1-T3`) |
| Registry | A central prefix registry so every entity's prefix is declared in one place |

`AUTOINCREMENT` on `rid` is deliberate: it prevents rowid reuse, so a stale FTS or vector index entry can never end up pointing at a different row.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **ULID** | Gives sortability but **no type prefix**, so a polymorphic reference needs a separate type column everywhere, and a mistyped id in a log or an API call looks identical to a correct one. TypeID is UUIDv7-based and keeps the same time-ordering property while making the type visible. |
| **Auto-increment integers** | Smallest and fastest, and wrong for this product: ids leak counts and ordering across groups, they are trivially enumerable in an API where an unreadable row must return the same 404 as a nonexistent one (`09` §2 D-08), they are meaningless in logs, and they mix up freely between entity types. |

## Consequences

**Good**
- A content-free log line is still debuggable, because the id names its own type.
- Lexicographic order equals creation order (UUIDv7), so cursors, pagination and "most recent" queries are cheap without a second index.
- Branded types turn cross-entity mix-ups into compile errors — which matters most where an audience or a label is constructed.
- Ids are not enumerable, so a 404-for-unreadable policy actually hides existence.
- Stable integer rowids keep FTS5 and `vec0` correct without exposing them.

**Bad / accepted costs**
- 30–32 bytes per id instead of 8, repeated across every foreign key. Irrelevant at this scale (`02` §3.16) and a real cost in a much larger system.
- Two keys per indexed table (`rid` and `id`) is more schema surface and one more invariant to maintain.
- Branded id types need explicit constructors at the storage and HTTP edges.
- UUIDv7 encodes a creation timestamp, so an id reveals *when* a row was made; acceptable because ids are only ever shown to people who can already read the row.

**Follow-ups**
- `M0-T7` — `DeterministicIds` for tests.
- `M1-T3` — TypeID branded types, the prefix registry and the monotonic generator.
- `M1-T11`–`M1-T13` — schema and index work that depends on the `rid`/`id` pair.

## References
- `docs/plan/01-architecture.md` §2 ADR-019, §11.7
- `docs/plan/02-domain-model-and-storage.md` §2 D1, §3.16 (capacity planning)
- `docs/plan/09-dashboard-api-cli.md` §2 D-08
