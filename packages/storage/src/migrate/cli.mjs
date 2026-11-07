/**
 * `pnpm db:migrate` — apply pending migrations to a development database.
 *
 * `02` D15 is explicit that drizzle-kit's own `migrate` is **not** the migration path: it cannot
 * record checksums, cannot toggle `foreign_keys` outside the transaction, and cannot take a
 * pre-migration backup. So this command runs the real runner, the same one `apps/server` calls at
 * boot (`02` §3.12.2). The storage package's `db:migrate` used to point at `drizzle-kit migrate`;
 * that was corrected at `M1-T14`, because a convenience command that behaves differently from the
 * production path is how a developer learns the wrong thing.
 *
 * Development only, and unencrypted: a host's database is migrated by the server at boot, with the
 * keyring unlocked. `09` §C owns `comvivo migrate status`.
 *
 * Usage: `pnpm db:migrate [--db <path>] [--app-version <v>] [--backup-dir <path>]`
 */

import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3-multiple-ciphers';
import * as sqliteVec from 'sqlite-vec';
import { migrate } from './runner.js';
import { fileMigrationSource } from './source.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATIONS = resolve(PACKAGE_ROOT, 'migrations');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (argv[index + 1] ?? fallback);
};

const dbPath = resolve(flag('db', resolve(PACKAGE_ROOT, '.dev/dev.sqlite')));
const appVersion = flag('app-version', '0.0.0-dev');
const backupDir = flag('backup-dir', undefined);

const { mkdirSync } = await import('node:fs');
mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
// `02` §3.5: vec0 DML inside a trigger needs this, and a migration may install such a trigger.
db.pragma('trusted_schema = ON');
sqliteVec.load(db);
db.pragma('foreign_keys = ON');

try {
  const result = migrate(db, fileMigrationSource(MIGRATIONS), {
    appVersion,
    ...(backupDir === undefined ? {} : { backupDir: resolve(backupDir) }),
  });
  if (result.applied === 0) {
    process.stdout.write(`${dbPath}: already up to date\n`);
  } else {
    process.stdout.write(`${dbPath}: applied ${result.applied} migration(s)\n`);
    for (const id of result.ids) process.stdout.write(`  ${id}\n`);
    if (result.backupPath !== undefined) {
      process.stdout.write(`  pre-migration backup: ${result.backupPath}\n`);
    }
  }
} catch (error) {
  process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`);
  const hint = error && typeof error === 'object' && 'hint' in error ? error.hint : undefined;
  if (typeof hint === 'string') process.stderr.write(`\n${hint}\n`);
  process.exitCode = 1;
} finally {
  db.close();
}
