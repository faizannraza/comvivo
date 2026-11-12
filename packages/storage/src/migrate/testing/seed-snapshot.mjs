/**
 * Migrate and seed a snapshot database. `scripts/make-db-snapshot.ts` runs this.
 *
 * Inside the package because it needs `@comvivo/storage`'s own dependencies — the driver and
 * `sqlite-vec` are declared here, not at the repository root, so the same module in `scripts/`
 * fails with `ERR_MODULE_NOT_FOUND`. The same split `crash-runner.mjs` uses.
 *
 * Usage: `seed-snapshot.mjs <dbPath> <version>`.
 */

import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3-multiple-ciphers';
import * as sqliteVec from 'sqlite-vec';
import { migrate } from '../runner.js';
import { fileMigrationSource } from '../source.js';
import { SEED_NOW_MS, SEED_STATEMENTS } from './release-seed.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

const [dbPath, version] = process.argv.slice(2);
if (dbPath === undefined || version === undefined) {
  process.stderr.write('usage: seed-snapshot.mjs <dbPath> <version>\n');
  process.exit(2);
}

const db = new Database(dbPath);
db.pragma('trusted_schema = ON');
sqliteVec.load(db);
db.pragma('foreign_keys = ON');

// **A fixed clock, measured.** Without it the snapshot is not reproducible: `_schema_migrations`
// records `applied_at` and `duration_ms` from `Date.now()`, and two runs of the same release
// differed in exactly those six bytes. A committed fixture must not embed wall-clock time, or
// every release produces a diff nobody can review.
migrate(db, fileMigrationSource(MIGRATIONS), {
  appVersion: version,
  nowMs: () => SEED_NOW_MS,
});
for (const statement of SEED_STATEMENTS) db.exec(statement);
// No free pages, so the committed fixture compresses predictably.
db.exec('VACUUM');
db.close();
process.stdout.write(`seeded ${dbPath} at ${version}\n`);
