/**
 * A child process that takes the instance lock and holds it (`12` §3.7; invariant C1).
 *
 * A real child process, not a worker thread: a worker shares `process.pid`, and the lock's own
 * ownership test is `pid` plus `bootId`, so a worker holding the lock would look to the parent like
 * the parent itself. The acceptance criterion is "a second **process** gets `STORAGE_LOCKED`", and
 * only a separate pid can show that.
 *
 * Committed here rather than written to a temp directory, for the reason
 * `migrate/testing/crash-runner.mjs` records: a script in `os.tmpdir()` cannot resolve
 * `better-sqlite3-multiple-ciphers`, because node searches upward for `node_modules` and finds
 * none — which fails as `ERR_MODULE_NOT_FOUND` and looks like a crash rather than the state the
 * test is arranging.
 *
 * Usage: `lock-holder.mjs <dataDir>`. Prints one line of JSON — `{"held":true,"pid":<pid>}` — once
 * the lock is held, then waits for stdin to close. The parent reads that line to know the lock is
 * taken before it tries, so the test never races.
 */
import process from 'node:process';
import { acquireLock, nodeLockEnvironment } from '../../datadir/lock.js';

const dataDir = process.argv[2];
if (dataDir === undefined) throw new Error('usage: lock-holder.mjs <dataDir>');

const environment = await nodeLockEnvironment('child-1.0.0');
const outcome = await acquireLock(dataDir, environment);
process.stdout.write(`${JSON.stringify({ held: outcome.acquired, pid: process.pid })}\n`);

if (!outcome.acquired) process.exit(1);

// Hold until the parent closes our stdin. `resume()` keeps the stream flowing so `end` fires; the
// alternative — an interval — would keep the process alive even if the parent died, which is how a
// test suite leaks a process that holds a lock.
process.stdin.resume();
await new Promise((resolve) => {
  process.stdin.on('end', resolve);
  process.stdin.on('close', resolve);
});
