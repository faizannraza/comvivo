/**
 * A child process that writes committed rows until it is killed (`02` §3.6.3 step 8).
 *
 * The parent (`crash.spike.test.ts`) sends `SIGKILL` mid-loop and then checks two things on
 * reopen: `PRAGMA integrity_check` is `ok`, and **no committed row is missing**. That second one
 * is the property that matters and the reason this process reports each commit on stdout rather
 * than the parent assuming a count: under `synchronous = NORMAL` in WAL mode a committed
 * transaction survives a process kill (the pages are in the OS cache) but may not survive a power
 * cut. Conflating the two would either hide a real durability bug or invent one.
 *
 * Usage: node crash-writer.mjs <db path> <key file> <rows>
 *
 * The key is read from a file rather than taken on the command line, because an argv is visible in
 * `ps` to every user on the machine — which is also why `08` §3.7 keeps real keys in
 * `data/keys/`.
 */
import { readFileSync } from 'node:fs';
import { argv, exit, stdout } from 'node:process';
import Database from 'better-sqlite3-multiple-ciphers';

const [, , dbPath, keyFile, rowsArg] = argv;
if (dbPath === undefined || keyFile === undefined) {
  process.stderr.write('usage: crash-writer.mjs <db path> <key file> <rows>\n');
  exit(2);
}

const key = readFileSync(keyFile);
const db = new Database(dbPath);
db.pragma("cipher='sqlcipher'");
db.pragma('legacy=4');
db.pragma(`key="x'${key.toString('hex')}'"`);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.exec('create table if not exists rows_written (n integer primary key, payload text not null)');

const insert = db.prepare('insert into rows_written (n, payload) values (?, ?)');
const total = Number(rowsArg ?? '100000');

// One row per transaction, so "committed" is unambiguous. `write` is synchronous on a pipe for
// small payloads, which is what makes the parent's record of commits trustworthy.
for (let n = 1; n <= total; n += 1) {
  insert.run(n, `row-${n}`);
  stdout.write(`${n}\n`);
}

db.close();
