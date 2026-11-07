/**
 * A child process that migrates and optionally kills itself part-way (`02` §3.12.6).
 *
 * Committed here rather than generated into a temp directory, following
 * `db/testing/read-worker.mjs`. A script written to `os.tmpdir()` cannot resolve
 * `better-sqlite3-multiple-ciphers` at all — node searches for `node_modules` upward from the
 * script, and a temp directory has none. That failed as `ERR_MODULE_NOT_FOUND`, which looks like a
 * crash rather than the kill the test is arranging.
 *
 * Usage: `crash-runner.mjs <dbPath> <migrationsDir> <killAfter>`. `killAfter > 0` applies that many
 * migrations and then `SIGKILL`s itself, which is the shape of an OOM kill or a power loss — no
 * unwinding, no `close()`, nothing flushed that was not already committed.
 */
import process from 'node:process';
import Database from 'better-sqlite3-multiple-ciphers';
import { migrate } from '../runner.js';
import { fileMigrationSource } from '../source.js';

const [dbPath, root, killAfter] = process.argv.slice(2);
if (dbPath === undefined || root === undefined) {
  process.stderr.write('usage: crash-runner.mjs <dbPath> <migrationsDir> <killAfter>\n');
  process.exit(2);
}

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
const source = fileMigrationSource(root);
const limit = Number(killAfter ?? '0');

if (limit > 0) {
  const all = source.list();
  migrate(db, { list: () => all.slice(0, limit) }, { appVersion: 'crash-test' });
  process.kill(process.pid, 'SIGKILL');
} else {
  migrate(db, source, { appVersion: 'crash-test' });
  db.close();
}
