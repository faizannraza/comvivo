/**
 * `@comvivo/storage`
 *
 * SQLite persistence: the drizzle schema and migrations, repositories implementing core's ports, crypto and the keyring, the durable job queue, FTS5 and vector indexes, and the blob store.
 *
 * Scaffolded by M0-T1. The implementation lands in this package's own milestone; see
 * `docs/plan/14-milestones.md`.
 */

export {
  LABEL_COUNT_TEMP_TABLE,
  LABEL_COUNT_WARN,
  LabelStore,
  labelCanonicalKey,
  readerSetCanonicalKey,
} from './ifc/label-store.js';
export {
  assertSpaceForBackup,
  databaseBytesOf,
  nodeSpaceProbe,
  PRE_MIGRATE_DIR,
  type PreMigrationBackupOptions,
  preMigrationBackup,
  preMigrationBackupName,
  pruneOldBackups,
  REQUIRED_FREE_SPACE_MULTIPLE,
  type SpaceProbe,
} from './migrate/backup.js';
export {
  type DataMigration,
  type DataMigrationCtx,
  dataMigrationFor,
  dataMigrations,
} from './migrate/data/index.js';
// --- Migrations (M1-T14) -------------------------------------------------------------------------
export {
  assertLockMatches,
  type LockEntry,
  type LockViolation,
  lockFor,
  lockViolations,
  type MigrationLock,
  readLock,
  writeLock,
} from './migrate/lock.js';
export {
  type AppliedMigration,
  appliedMigrations,
  ensureMigrationsTable,
  hasUserTables,
  isForeignKeyPragma,
  MIGRATIONS_TABLE,
  type MigrateOptions,
  type MigrateResult,
  migrate,
} from './migrate/runner.js';
export {
  compareVersions,
  SNAPSHOT_DIR,
  SNAPSHOT_PATTERN,
  snapshotFixtures,
} from './migrate/snapshots.js';
export {
  checksumOf,
  detectLayout,
  fileMigrationSource,
  type Migration,
  type MigrationLayout,
  type MigrationSource,
  STATEMENT_BREAKPOINT,
  splitStatements,
  staticMigrationSource,
} from './migrate/source.js';
