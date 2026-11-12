/**
 * `@comvivo/storage/testing` — the database test kit (`11` §3.1.8, `02` §4.1).
 *
 * A subpath export rather than part of the package root, because every package's tests import it
 * and nothing in production may: `createTestDb` loads the migrations off disk and `exportDomainState`
 * reads every table of a group, neither of which belongs in a shipped code path.
 */

export {
  type DomainStateOptions,
  domainTables,
  exportDomainState,
  VOLATILE_COLUMNS,
} from './domain-state.js';
export { MIGRATIONS_DIR } from './migrations-dir.js';
export {
  type CreateTestDbOptions,
  createTestDb,
  resetTestDbTemplates,
  TEST_DB_KEY,
  writeMigratedDbFile,
} from './test-db.js';
export { cleanupTmpDbs, createTmpDbDir, createTmpDbFile } from './tmp-db.js';
