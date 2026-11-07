# Migrations

Forward-only. There is no `down`. Read this before changing anything under `src/schema/`.

The rules below are `02` §3.12.3. They exist because a migration runs **once** on a stranger's
machine, holding data you cannot see, and the only way back is the pre-migration backup.

## Authoring

| Change | Command |
|---|---|
| Schema (tables, columns, indexes) | `pnpm --filter @comvivo/storage db:generate --name <slug>` |
| Virtual tables, triggers, partial-index fixes | `pnpm --filter @comvivo/storage db:guards` regenerates `0001_search_and_guards.sql` from the schema. For anything else: `drizzle-kit generate --custom --name <slug>` and write the SQL |
| Data migration | add `src/migrate/data/<migrationId>.ts` and list it in `data/index.ts` |

Always create a migration with `drizzle-kit`, never by hand. It writes the `meta/_journal.json`
entry, and **a `.sql` file the journal does not list is never applied** — the source raises
`MIGRATION_FAILED` rather than skipping it silently, but only after someone notices the schema is
wrong.

## The six rules

1. **Never rename or drop a column in the same release that stops writing it.** Expand, then
   contract, across two releases. A host running the old binary against the new schema must still
   work, because that is what a rolled-back deployment is.
2. **A new `NOT NULL` column needs a default or a data migration.** SQLite will not add one
   otherwise, and a default of `''` is a decision about meaning, not a formality.
3. **A table rebuild must recreate its triggers and FTS/vec links in the same migration.**
   drizzle-kit's `__new_<table>` pattern drops and recreates the table, which drops every trigger
   on it. `migrations.fresh-equals-migrated` catches a missing one; nothing catches it at review.
4. **Adding an enum value means rebuilding the table**, because the `CHECK` constraint names the
   values. Plan for the cost.
5. **A long data migration must be chunked and safe to run twice.** The runner commits each
   migration separately and is forward-only, so recovery from a crash means *running the same
   function again*.
6. **Never edit a released migration.** `migrations.lock.json` holds a sha256 of every released
   one and `migrations.checksums-locked` fails on drift — including whitespace. A host who applied
   the old version and one who applies the new would otherwise end up with different databases.

## What the runner does

`migrate()` (`src/migrate/runner.ts`), per `02` §3.12.2:

- creates `_schema_migrations` if absent;
- raises `SCHEMA_TOO_NEW` if the database holds a migration this build does not know — an older
  binary against newer data;
- raises `MIGRATION_CHECKSUM_MISMATCH` if an applied migration's file has changed since;
- takes a pre-migration backup (`VACUUM INTO`, then `quick_check`) when the database is non-empty;
- applies each pending migration in its **own** `IMMEDIATE` transaction, with `foreign_keys` off
  around it — a `PRAGMA foreign_keys` *inside* a transaction is silently ignored, so the runner
  skips any such statement a migration contains;
- runs `foreign_key_check` inside the transaction and rolls back with `MIGRATION_FK_VIOLATION` if
  the migration broke a reference;
- runs `PRAGMA optimize` at the end, so the planner's statistics describe the new schema.

If migration *k* fails, *k−1* stays applied and the error names *k*. Recover with
`comvivo restore pre-migrate:latest`.

## Snapshots

`pnpm tsx scripts/make-db-snapshot.ts --version v0.1.0` writes
`fixtures/db-snapshots/v0.1.0.sqlite.gz`: a migrated, seeded, **synthetic** database that
`migrations.int.test.ts` upgrades to HEAD. It is byte-reproducible — the seed uses fixed ids and a
fixed clock — because a fixture that changes every run produces a diff nobody reads.

`migrations.fresh-equals-migrated` compares two *fresh* databases, so it cannot see a migration
that is correct on an empty schema and wrong on one holding rows. The snapshot is what closes that
gap, and it is the only thing that can.
