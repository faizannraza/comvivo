/**
 * `@comvivo/storage/testing` — the database test kit (`11` §3.1.8, `02` §4.1).
 *
 * A subpath export rather than part of the package root, because every package's tests import it
 * and nothing in production may: `createTestDb` loads the migrations off disk and `exportDomainState`
 * reads every table of a group, neither of which belongs in a shipped code path.
 */

// `08` §3.7.4's keyring, built in memory. Exported at `M3-T13`'s coverage pass, because the CLI's
// `keys` commands need a real one to run against — and a second builder in `apps/cli` would be a
// second place a fixture could diverge from the shape `keyringSchema` accepts.
export {
  buildKeyring,
  FAST_SCRYPT,
  FIXTURE_INSTANCE,
  type FixtureOptions,
  type KeyringFixture,
} from '../crypto/testing/keyring-fixture.js';
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
