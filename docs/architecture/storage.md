# `@comvivo/storage`

The only module that touches the database. Everything above it — the engine, the tools, the HTTP
API — reaches persistence through ports defined in `@comvivo/core`, and this package is the single
implementation of those ports (`01` §4).

This note is the map: what lives where, and the handful of rules that are worth knowing before
changing any of it. The *design* is `docs/plan/02-domain-model-and-storage.md`; the generated table
reference is [`schema.md`](./schema.md); the measured cost of each read and write is
[`storage-benchmarks.md`](./storage-benchmarks.md); and the rules for changing the schema are
[`MIGRATIONS.md`](../../packages/storage/MIGRATIONS.md).

## The shape of it

| Directory | What it owns |
|---|---|
| `src/schema/` | The Drizzle tables, one module per domain area, plus the raw SQL for what Drizzle cannot express: the FTS5 virtual tables and every trigger |
| `src/db/` | Opening a database (`open.ts`), the pragma sequence, the transaction wrapper (`tx.ts`), error mapping, and the worker connection |
| `src/repos/` | One repository per aggregate, implementing core's ports. Every read is label-filtered; every write is a `WriteResult` |
| `src/ifc/` | `LabelStore`: interning a label and its reader set, which is what makes `I1` and `I4` enforceable in SQL |
| `src/search/` | FTS5 query building, the vec0 embedding spaces, and the hybrid memory search |
| `src/queue/` | The durable job queue: claim, lease, retry, the scheduler and the worker loop |
| `src/outbox/` | The acknowledged-effect outbox (`I7`): enqueue, lease, acknowledge |
| `src/crypto/` | The keyring, key derivation, the blob cipher and the backup envelope |
| `src/datadir/` | The data directory's layout, locking, atomic writes and filesystem checks |
| `src/migrate/` | The migration runner, its lock, the pre-migration backup and the snapshot tests |
| `src/backup/` | Backup creation, its manifest and restore |
| `src/retention/` | Retention sweeps, group purge and person erasure, in resumable chunks |
| `src/export/` | A member's or a group's data as JSONL, for the portability obligation |
| `src/blobs/` | The content-addressed, per-blob-encrypted attachment store |
| `src/readmodels/` | Read models the engine asks for by shape rather than by table |
| `src/perf/` | The fixture generator the benchmarks measure against (`02` §3.16.5) |
| `src/testing/` | Test doubles and helpers. **Never imported by production code** — dependency-cruiser refuses it |

`bench/` sits beside `src/` rather than inside it: it holds the benchmark suite, its fixture
builder and the `dbstat` size reader, none of which ship. `spike/` is the encryption spike's
permanent regression suite (`02` M1-T2).

## Six rules worth knowing

1. **A transaction never spans an `await`.** better-sqlite3 is synchronous, and an `await` inside a
   transaction yields the event loop while holding a write lock. `SqliteStore.write(fn)` takes a
   synchronous callback and the type system enforces it (`NotPromise`); a lint rule refuses a raw
   `connection.transaction(…)` outside three allow-listed paths, which
   `scripts/lint/rules.ts` names with its reasons: `db/tx.ts` is the implementation,
   `migrate/runner.ts` sits *below* the wrapper and installs the schema the repositories read, and
   `spike/**` measures the driver rather than our wrapper. Everything else goes through
   `SqliteStore`.
2. **Every read is label-filtered.** A repository read takes an `EligibleLabelSet` and applies it
   in SQL. The handful of deliberate exceptions are named `…Unfiltered`, and dependency-cruiser
   restricts who may call them: the tool executor, which has already applied the requester's
   authority, and storage internals such as the retention sweep.
3. **Group isolation is enforced by generated triggers, not by a convention about columns.** The
   precise shape, because the convenient summary — "the group id is in every table and every
   index" — is false and was in this document until the M1 exit gate: **51 of 78** tables carry
   `group_id` and **45 of 109** indexes lead with it. The rest reach their group through a parent,
   which `02` §3.3 intends. What is uniform is the guard set, generated from the schema by
   `pnpm --filter @comvivo/storage db:guards`:
   - a **label** trigger per labeled column, refusing a row whose label belongs to another group
     (31 columns);
   - a **parent-group** trigger per foreign key whose two sides must agree, refusing a row attached
     to another group's parent — including a denormalised `group_id` that disagrees with the parent
     it was copied from (66 keys, added at the exit gate after a reviewer proved twenty-two such
     writes succeeded);
   - a **group-immutability** trigger, so a row cannot be moved between groups after the fact.

   A table added later gets all three by existing. The cost is what `02` D5 predicted — one
   primary-key lookup per write: ingestion measures 0.86 ms p95 against a 3 ms budget with the
   parent-group guards in place, against 0.93 ms without them.
4. **An id list drives the query, not the eligibility list.** Given both, SQLite's planner picks by
   guesswork — a fresh install has no `sqlite_stat1` — and which it picks depends on how many
   labels the group has. `eqUnindexed` and `inArrayUnindexed` in `db/drizzle.ts` are the hints,
   each carrying the measurement that justifies it; `db/plan-hints.int.test.ts` pins the plan.
5. **Validation happens at the boundary, every time.** Every JSON column has a zod schema, and a
   row is parsed on the way out rather than cast. The cost is measured: hydrating 200 memories,
   validation included, is 3.2 ms.
6. **Forward-only migrations.** There is no `down`. Expand, then contract, across two releases, and
   read `MIGRATIONS.md` before touching `src/schema/`.

## What this package may import

`@comvivo/core` and `@comvivo/shared`, and nothing else from the workspace — enforced by
dependency-cruiser in `pnpm verify`, not by convention. Never weaken a rule to make an import work;
fix the design. The direction that matters is the other way round: nothing imports *from* storage
except the engine's own composition root, because a channel adapter or a tool that could reach the
database could read a row without a label check.

## Where the numbers are

Every figure that a budget is stated against is measured, not estimated, and lives in
[`storage-benchmarks.md`](./storage-benchmarks.md): the per-row sizes from `dbstat`, the twelve
latencies of `02` §3.16.4, and the fixture they were taken on. `pnpm bench --gate` fails when a row
misses its budget.
