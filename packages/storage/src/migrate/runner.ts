/**
 * The migration runner (`02` §3.12.2).
 *
 * `02` D15 rejects drizzle-kit's own `migrate` for three reasons, and each one is a step below:
 * record sha256 checksums so a tampered or reordered migration fails loudly, toggle
 * `foreign_keys` **outside** the transaction, and take a pre-migration backup. A fourth emerged
 * while writing this: `foreign_key_check` after each migration, so a rebuild that drops a parent
 * row fails the migration rather than leaving a database that only breaks later.
 *
 * ## Why each migration commits on its own
 *
 * Forward-only (`02` §3.12.2). If migration *k* fails, *k−1* stays applied and the error names
 * *k*. The alternative — one transaction for the whole upgrade — sounds safer and is not: SQLite
 * cannot roll back a `VACUUM` or several `ALTER TABLE` forms, a long upgrade would hold a write
 * lock for its entire duration, and a crash mid-way would leave a half-rolled-back database with
 * no record of where it stopped. Per-migration commits mean the `_schema_migrations` table is
 * always an accurate account of what has run, which is what makes a crash resumable.
 *
 * ## Why `foreign_keys` is toggled outside the transaction
 *
 * `PRAGMA foreign_keys` is a **no-op inside a transaction** — SQLite ignores it silently. A
 * migration that assumed otherwise would run its table rebuild with constraints still enforced
 * and fail on the first `__new_table` insert. So the runner toggles around the transaction and
 * skips any `PRAGMA foreign_keys` statement a migration contains, because that statement would do
 * nothing where it sits and its presence means the author expected it to work.
 */
import { BRAND, StorageError } from '@comvivo/shared';
import type Database from 'better-sqlite3-multiple-ciphers';
import { isThenable } from '../db/tx.js';
import { mainDatabaseFile, preMigrationBackup } from './backup.js';
import type { DataMigrationCtx } from './data/index.js';
import type { Migration, MigrationSource } from './source.js';

/**
 * The bookkeeping table.
 *
 * **Named without the brand.** `02` §3.12.2 writes `_village_migrations`, which is a pre-rename
 * leftover the ADR-024 codemod missed (it scans `packages/**` and `apps/**`, so a spec listing is
 * reached only by the docs rewrite). The name is corrected here for the same reason `02` §3.3.3
 * renamed `kind='village'` to `kind='assistant'`, and more sharply: a brand in a *schema object*
 * turns a rename into a data migration, and this is the one table a migration cannot safely
 * rewrite — it is the table the migration runner reads to decide what to run.
 */
export const MIGRATIONS_TABLE = '_schema_migrations';

export interface MigrateOptions {
  /** Recorded against each applied migration, so a bad release is identifiable afterwards. */
  readonly appVersion: string;
  /** Where pre-migration backups go. Omit to skip the backup (tests, and an empty database). */
  readonly backupDir?: string;
  /**
   * The key `db` is open under, so the pre-migration backup can be verified.
   *
   * Required whenever `backupDir` is set, because `VACUUM INTO` writes an **encrypted** snapshot
   * (SP-3) and the `quick_check` that makes the copy a rollback path rather than a file cannot run
   * without it. `null` is the unencrypted instance, which `doctor` warns about.
   */
  readonly key?: Buffer | null;
  /** `02` §3.12.2 default. */
  readonly keepPreMigration?: number;
  /** Dev-only escape hatch for a migration edited before release. */
  readonly allowChecksumDrift?: boolean;
  /** Injected so a test can assert the recorded timestamp. */
  readonly nowMs?: () => number;
}

export interface MigrateResult {
  readonly applied: number;
  readonly ids: readonly string[];
  /** The pre-migration backup's path, when one was taken. */
  readonly backupPath?: string;
}

/** A row of {@link MIGRATIONS_TABLE}. */
export interface AppliedMigration {
  readonly id: string;
  readonly checksum: string;
  readonly applied_at: number;
  readonly app_version: string;
  readonly duration_ms: number;
  readonly kind: string;
}

/** Create the bookkeeping table if it is absent. Safe to call on every boot. */
export function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  app_version TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  kind TEXT NOT NULL
)`);
}

/** What has already been applied, in order. */
export function appliedMigrations(db: Database.Database): readonly AppliedMigration[] {
  ensureMigrationsTable(db);
  return db
    .prepare(`SELECT * FROM ${MIGRATIONS_TABLE} ORDER BY applied_at, id`)
    .all() as AppliedMigration[];
}

/**
 * Whether the database holds anything worth backing up.
 *
 * "Non-empty" means a table other than SQLite's own and the bookkeeping one. A fresh install runs
 * every migration and has nothing to lose, so making it wait for a `VACUUM INTO` of an empty file
 * would add a step to the first-run experience `00` §3 holds to five minutes.
 */
export function hasUserTables(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> ?`,
    )
    .get(MIGRATIONS_TABLE) as { n: number };
  return row.n > 0;
}

/** `02` §3.12.2: an applied migration this binary does not know means the DB is from the future. */
function assertNotTooNew(
  applied: readonly AppliedMigration[],
  known: readonly Migration[],
  appVersion: string,
): void {
  const knownIds = new Set(known.map((migration) => migration.id));
  const unknown = applied.filter((row) => !knownIds.has(row.id)).map((row) => row.id);
  if (unknown.length === 0) return;
  throw new StorageError(
    'SCHEMA_TOO_NEW',
    'this database was created by a newer version of the application',
    {
      hint:
        'The data directory has migrations this build does not know about, so running it would ' +
        'corrupt data written by the newer version. Upgrade the application, or restore a backup ' +
        'taken before the upgrade.',
      detail: { dbIds: unknown.join(', '), binaryVersion: appVersion },
    },
  );
}

/** `02` §3.12.1: a released migration is never edited. */
function assertChecksums(
  applied: readonly AppliedMigration[],
  known: readonly Migration[],
  allowDrift: boolean,
): void {
  const byId = new Map(known.map((migration) => [migration.id, migration]));
  const drifted = applied.filter((row) => {
    const match = byId.get(row.id);
    return match !== undefined && match.checksum !== row.checksum;
  });
  if (drifted.length === 0 || allowDrift) return;
  throw new StorageError(
    'MIGRATION_CHECKSUM_MISMATCH',
    `${String(drifted.length)} applied migration(s) differ from the files on disk`,
    {
      hint:
        'A migration that has already run was edited afterwards, so this database and a fresh ' +
        'one would no longer have the same schema. Revert the edit and add a new migration ' +
        'instead; migrations are forward-only.',
      detail: { ids: drifted.map((row) => row.id).join(', ') },
    },
  );
}

/**
 * Apply every pending migration.
 *
 * @param db an open, writable connection
 * @param source where the migrations come from
 */
export function migrate(
  db: Database.Database,
  source: MigrationSource,
  options: MigrateOptions,
): MigrateResult {
  const nowMs = options.nowMs ?? (() => Date.now());
  ensureMigrationsTable(db);

  const applied = appliedMigrations(db);
  const known = source.list();
  assertNotTooNew(applied, known, options.appVersion);
  assertChecksums(applied, known, options.allowChecksumDrift === true);

  const appliedIds = new Set(applied.map((row) => row.id));
  const pending = known.filter((migration) => !appliedIds.has(migration.id));
  if (pending.length === 0) return { applied: 0, ids: [] };

  const backupPath = takeBackupIfNeeded(db, applied, pending, options, nowMs());
  const ctx: DataMigrationCtx = { appVersion: options.appVersion, nowMs: nowMs() };

  for (const migration of pending) {
    applyOne(db, migration, ctx, options, nowMs, backupPath);
  }

  // `optimize` updates the statistics the query planner uses. After a migration the old ones
  // describe a schema that no longer exists, and `02` §3.3.10's index choices depend on them.
  db.pragma('optimize');
  return {
    applied: pending.length,
    ids: pending.map((migration) => migration.id),
    ...(backupPath === undefined ? {} : { backupPath }),
  };
}

function takeBackupIfNeeded(
  db: Database.Database,
  applied: readonly AppliedMigration[],
  pending: readonly Migration[],
  options: MigrateOptions,
  nowMs: number,
): string | undefined {
  if (options.backupDir === undefined || !hasUserTables(db)) return undefined;
  return preMigrationBackup(db, {
    backupDir: options.backupDir,
    key: options.key ?? null,
    fromLastId: applied.at(-1)?.id ?? 'empty',
    toLastId: pending.at(-1)?.id ?? 'empty',
    keep: options.keepPreMigration ?? 3,
    nowMs,
  });
}

/** Apply one migration in its own immediate transaction. */
function applyOne(
  db: Database.Database,
  migration: Migration,
  ctx: DataMigrationCtx,
  options: MigrateOptions,
  nowMs: () => number,
  backupPath: string | undefined,
): void {
  // Outside the transaction: a `PRAGMA foreign_keys` inside one is silently ignored.
  db.pragma('foreign_keys = OFF');
  try {
    const startedAt = nowMs();
    const run = db.transaction(() => {
      for (const statement of migration.sql) {
        if (isForeignKeyPragma(statement)) continue;
        db.exec(statement);
      }
      // The return value is **checked**, not discarded. `run` is declared `(db, ctx) => void`, and
      // void-return bivariance accepts an `async run()` — which would commit an empty transaction
      // and record the migration as applied, on a stranger's machine, with no way back but the
      // pre-migration backup. `02` §3.12.3's rules exist because a migration runs once; this is
      // the one guard `tx.ts` cannot provide, because the runner is the sanctioned non-`tx.ts`
      // transaction. Found by the M1 exit gate's reviewer.
      const outcome: unknown = migration.dataMigration?.run(db, ctx);
      if (isThenable(outcome)) {
        throw new StorageError(
          'MIGRATION_FAILED',
          `the data migration for ${migration.id} returned a promise`,
          {
            hint:
              'A data migration runs inside the migration transaction, so it must be ' +
              'synchronous — an `await` would yield the event loop while holding the write lock. ' +
              'Remove `async` and use the synchronous better-sqlite3 API.',
            category: 'bug',
          },
        );
      }

      const violations = db.pragma('foreign_key_check') as readonly Record<string, unknown>[];
      if (violations.length > 0) {
        throw new StorageError(
          'MIGRATION_FK_VIOLATION',
          `migration ${migration.id} left ${String(violations.length)} foreign key violation(s)`,
          {
            hint:
              'The migration ran but broke a reference, so it has been rolled back. A table ' +
              'rebuild that does not carry its children over is the usual cause.',
            detail: {
              id: migration.id,
              sample: JSON.stringify(violations.slice(0, 10)),
            },
          },
        );
      }

      db.prepare(
        `INSERT INTO ${MIGRATIONS_TABLE} (id, checksum, applied_at, app_version, duration_ms, kind)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        migration.id,
        migration.checksum,
        startedAt,
        options.appVersion,
        Math.max(0, nowMs() - startedAt),
        migration.dataMigration === undefined ? 'sql' : 'sql+data',
      );
    });
    // `immediate` so the write lock is taken at BEGIN rather than on the first write: a deferred
    // transaction can fail with SQLITE_BUSY partway through a migration, which is the worst
    // possible moment (`02` D10).
    run.immediate();
  } catch (cause) {
    throw asMigrationFailure(migration.id, cause, {
      backupPath,
      dbFile: mainDatabaseFile(db),
    });
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/**
 * Keep our own errors intact and wrap anything else with the migration that produced it.
 *
 * The hint names **the file**, not a command. It used to read `comvivo restore
 * pre-migrate:latest`, which is `09` §C's shorthand and does not exist until the CLI ships in
 * `M9` — so the first host whose upgrade failed was told to run something that answers "command
 * not found" at the one moment they need the instruction to be exact. Found by the M1 exit gate's
 * reviewer. The file-copy wording stays correct after the CLI lands, and `recovery` carries the
 * path so the dashboard and `doctor` can offer it without re-deriving anything — from the **error
 * object**, not from the log: `isSafeDetailValue` caps a `detail` string at 120 characters, and a
 * real `backups/pre-migrate/…` path under a home directory is usually longer, so the log line
 * carries the id and drops the path. The hint, which is not length-capped, is where a host reads
 * it.
 */
function asMigrationFailure(
  id: string,
  cause: unknown,
  recovery: { backupPath: string | undefined; dbFile: string | undefined },
): unknown {
  if (cause instanceof StorageError) return cause;
  const preamble =
    'Earlier migrations stay applied — upgrades are forward-only — so the database is at a ' +
    'known point. ';
  return new StorageError('MIGRATION_FAILED', `migration ${id} failed`, {
    hint:
      recovery.backupPath === undefined
        ? // No backup means `backupDir` was not configured or the database held no user tables —
          // in the second case there is nothing to lose, and in the first the host needs to know
          // that going back is not on offer rather than to be pointed at an empty directory.
          `${preamble}This run took no pre-migration backup, so there is nothing to restore: fix ` +
          'the migration and run the upgrade again.'
        : `${preamble}The way back is the pre-migration backup this run took. Stop the server, ` +
          `then copy \`${recovery.backupPath}\` over ` +
          `\`${recovery.dbFile ?? `db/${BRAND.slug}.db`}\` and delete the \`-wal\` and ` +
          '`-shm` files next to it.',
    detail: {
      id,
      ...(recovery.backupPath === undefined ? {} : { backupPath: recovery.backupPath }),
    },
    cause,
  });
}

/** Whether a statement is a `foreign_keys` pragma, which the runner handles itself. */
export function isForeignKeyPragma(statement: string): boolean {
  return /^\s*PRAGMA\s+foreign_keys\s*=/i.test(statement);
}
