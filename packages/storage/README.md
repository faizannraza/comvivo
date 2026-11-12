# `@comvivo/storage`

SQLite persistence: the Drizzle schema and migrations, the repositories implementing core's ports,
the keyring and crypto, the durable job queue and outbox, FTS5 and vector search, retention and
export, and the blob store. **The only module that touches the database** — everything above it
reaches persistence through ports defined in `@comvivo/core` (`01` §4).

## Where to read what

| | |
|---|---|
| The design, and why each table looks the way it does | [`docs/plan/02-domain-model-and-storage.md`](../../docs/plan/02-domain-model-and-storage.md) |
| The module map and the rules worth knowing first | [`docs/architecture/storage.md`](../../docs/architecture/storage.md) |
| Every table, column, index and trigger, generated | [`docs/architecture/schema.md`](../../docs/architecture/schema.md) |
| What each read and write actually costs, measured | [`docs/architecture/storage-benchmarks.md`](../../docs/architecture/storage-benchmarks.md) |
| The rules for changing the schema | [`MIGRATIONS.md`](./MIGRATIONS.md) |
| The encryption spike that settled the dependency choices | [`docs/architecture/storage-spike.md`](../../docs/architecture/storage-spike.md) |

## Commands

```bash
pnpm --filter @comvivo/storage db:generate --name <slug>   # a migration from a schema change
pnpm --filter @comvivo/storage db:guards                   # regenerate the I4 guard triggers
pnpm --filter @comvivo/storage db:migrate                  # apply migrations to a database
pnpm run schema:doc                                        # regenerate docs/architecture/schema.md
COMVIVO_BENCH_PROFILE=stress-50k-1m pnpm bench --filter storage/bench --gate
```

`pnpm run schema:check` runs in `pnpm verify` and in CI: the generated reference must match the
schema, and `02` §3.3.13's entity checklist must still resolve.

## Three things that will bite

- **A transaction never spans an `await`.** better-sqlite3 is synchronous; an `await` inside a
  transaction yields the event loop while holding a write lock. Use `store.write(fn)` with a
  synchronous callback — a lint rule refuses a raw `connection.transaction(…)` outside the three
  paths `scripts/lint/rules.ts` allow-lists and explains: `db/tx.ts`, `migrate/runner.ts` (the
  layer below the wrapper, which creates the schema the repositories read) and `spike/**` (which
  measures the driver, not the wrapper).
- **Reads take an `EligibleLabelSet` and apply it in SQL.** The exceptions are named
  `…Unfiltered`, and dependency-cruiser restricts who may call them. An unfiltered read reached
  from the wrong place is invariant `I1` deleted in one import.
- **A fresh database has no query-plan statistics.** Given an id list *and* an eligibility list,
  SQLite picks an index by guesswork, and which one depends on how many labels the group has — so
  the slow plan lands on small groups. `eqUnindexed` and `inArrayUnindexed` in `db/drizzle.ts` are
  the hints, each with its measurement.

## Boundaries

Dependency rules are enforced by dependency-cruiser in `pnpm verify`, not by convention.
This package may import: `@comvivo/core`, `@comvivo/shared`.
Never weaken a rule to make an import work; fix the design.

`src/testing/` holds test doubles and is refused to production code. `bench/` and `spike/` sit
outside `src/` and never ship.

## License

Apache-2.0. See [`LICENSE`](../../LICENSE).
