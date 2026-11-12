/**
 * Data migrations (`02` §3.12.1).
 *
 * A data migration is a synchronous, chunked, **idempotent** function that runs inside the same
 * transaction as the SQL migration sharing its id. Each of those three words is a requirement
 * rather than a style:
 *
 *  - **synchronous**, because `01` §1 forbids a better-sqlite3 transaction from spanning an
 *    `await` — the transaction would commit when the callback returned and the work would happen
 *    outside it, with no isolation and no rollback;
 *  - **chunked**, because `02` §3.12.3 rule 5 requires a long migration to be interruptible, and
 *    because a single statement over a million rows blocks the event loop;
 *  - **idempotent**, so a crash part-way through can resume. The runner commits each migration
 *    separately and is forward-only, so "resume" means "run the same function again".
 *
 * The registry is empty and will stay empty until a release needs one. That is not a placeholder:
 * `02` §3.12.1 says a data migration is added as a file here, and `dataMigrationFor` is what the
 * source calls to find it. The mechanism is exercised by `migrate-parts.int.test.ts` with a
 * registered fixture, so the first real one does not also debug the wiring. (This named
 * `source.test.ts`, which does not exist — a pointer to a test is only useful if a reader can
 * open it.)
 */
import type Database from 'better-sqlite3-multiple-ciphers';

/** What a data migration may use. The clock is injected so a migration is testable. */
export interface DataMigrationCtx {
  /** The version of the application running the migration. */
  readonly appVersion: string;
  /** Epoch milliseconds at the start of the run. */
  readonly nowMs: number;
}

/** A data migration, paired by id with the SQL migration it follows. */
export interface DataMigration {
  /** The SQL migration's id, e.g. `0003_backfill_handles`. */
  readonly id: string;
  /** Synchronous, chunked and idempotent (`02` §3.12.1). */
  run(db: Database.Database, ctx: DataMigrationCtx): void;
}

/**
 * Every registered data migration, by id.
 *
 * Empty until a release needs one. A new one is added as `data/<id>.ts` and listed here, so the
 * set is a literal rather than a directory scan — a scan would make the registry depend on build
 * output layout, and would silently pick up a file someone was still writing.
 */
const REGISTRY: readonly DataMigration[] = [];

/** The data migration for `id`, if one is registered. */
export function dataMigrationFor(id: string): DataMigration | undefined {
  return REGISTRY.find((migration) => migration.id === id);
}

/** Every registered data migration, for tests and for `comvivo migrate status`. */
export function dataMigrations(): readonly DataMigration[] {
  return REGISTRY;
}
