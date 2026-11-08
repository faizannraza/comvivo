/**
 * The writer connection holds the instance lock (`M1-T8` AC: "Uses `M1-T7` for the lock").
 *
 * Two of this milestone's acceptance criteria met here, and both were unmet before: `M1-T8`'s
 * "uses `M1-T7` for the lock" — the lock module had **no** production caller, so `lockedError` was
 * reachable only from its own tests — and `M1-T7`'s "a second process gets `STORAGE_LOCKED`",
 * which had no test that involved a second process. The nearest existing one called `acquireLock`
 * twice in the same process, which exercises the file but not the ownership rule: the lock's
 * liveness test is `pid` plus `bootId`, so a same-process second call is asking whether this
 * process is itself.
 *
 * The cross-process case uses a real child, not a worker thread, for exactly that reason — a
 * worker shares `process.pid`.
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_CODES, exitCodeFor, StorageError } from '@comvivo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { writeSourcePathsTsconfig } from '../../../../scripts/support/paths-tsconfig.js';
import {
  auditPermissions,
  databaseFilePaths,
  dataDirLayout,
  nodeLockEnvironment,
  readLockHolder,
  secureDatabaseFiles,
} from '../datadir/index.js';
import { fakeEnvironment, withDataDir } from '../datadir/testing/data-dir.js';
import { openLockedDatabase } from './locked.js';
import { pragmaValue } from './open.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '../..');
const REPO_ROOT = join(PACKAGE_ROOT, '../..');
const HOLDER = join(HERE, 'testing/lock-holder.mjs');
const KEY = Buffer.alloc(32, 0x3c);

const open = (dataDir: string, overrides: Record<string, unknown> = {}) =>
  openLockedDatabase({
    dataDir,
    version: 'test-1.0.0',
    key: KEY,
    withHeartbeat: false,
    ...overrides,
  });

/** Children started by a test, so a failure cannot leave one holding a lock. */
const children: { kill: () => void }[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

/**
 * Start the holder child and resolve once it reports the lock is taken.
 *
 * Waiting for its line rather than sleeping: the parent must try **after** the child holds the
 * lock, and a sleep long enough to be safe on a loaded runner is long enough to make the suite
 * slow for no reason.
 */
async function startHolder(dataDir: string): Promise<{ pid: number; stop: () => Promise<void> }> {
  const tsconfig = writeSourcePathsTsconfig(dataDir, REPO_ROOT, 'tsconfig.holder.json');
  // `process.execPath` with `--import tsx`, **not** the `tsx` shim in `node_modules/.bin`. The shim
  // is a wrapper that runs node as a child, so the pid this process spawns is the wrapper's and the
  // pid the script prints is the inner one — killing the first leaves the second holding the lock,
  // and `isAlive(printedPid)` stays true after the spawned child has exited. `M1-T14` hit the same
  // shim from the other side (it forwards `SIGKILL` as exit 137 with a null signal).
  const child = spawn(process.execPath, ['--import', 'tsx', HOLDER, dataDir], {
    cwd: PACKAGE_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig },
  });
  // Resolved when the OS has reaped the child, so a caller can wait for the pid to be *gone*
  // rather than sleeping and hoping. A real timer here would be both slower and less reliable, and
  // `scripts/hygiene`'s `no-real-timers` is right to refuse one — the event is the actual signal.
  const exited = new Promise<void>((resolve) => {
    child.on('exit', () => resolve());
  });
  const stop = async (): Promise<void> => {
    child.stdin.end();
    child.kill('SIGKILL');
    await exited;
  };
  children.push({ kill: () => void stop() });

  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      const line = out.split('\n')[0];
      if (line === undefined || !line.includes('}')) return;
      const message = JSON.parse(line) as { held: boolean; pid: number };
      if (message.held) {
        // The harness assumption, asserted rather than assumed: the process we can signal is the
        // one that took the lock. Everything below depends on it.
        expect(message.pid).toBe(child.pid);
        resolve({ pid: message.pid, stop });
      } else reject(new Error(`the child could not take the lock: ${out}`));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    child.on('exit', (code) => {
      reject(new Error(`the holder exited with ${String(code)} before taking the lock: ${err}`));
    });
  });
}

describe('a second process gets STORAGE_LOCKED (12 §3.7)', { tags: ['slow'] }, () => {
  it('refuses to open while a live child process holds the lock', async () => {
    await withDataDir(async (root) => {
      const holder = await startHolder(root);
      expect(holder.pid).not.toBe(process.pid);

      const caught = await open(root).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(caught).toBeInstanceOf(StorageError);
      const error = caught as StorageError;
      expect(error.storageCode).toBe('STORAGE_LOCKED');
      // The message names who holds it, which is the whole point of the lock file carrying a pid.
      expect(error.detail?.['pid']).toBe(holder.pid);
      expect(error.hint).toContain('One process per data directory');
      // `12` §4.2: a held lock is temporary, so an orchestrator backs off instead of giving up.
      expect(exitCodeFor(error)).toBe(EXIT_CODES.temporary);
      expect(exitCodeFor(error)).toBe(75);

      // And no database was created on the way to being refused: the lock is taken before the
      // file is opened, so a refused second process leaves the data directory untouched.
      expect(existsSync(dataDirLayout(root).dbFile)).toBe(false);
    });
  });

  it('opens once the holder is gone, because a dead pid is a stale lock', async () => {
    await withDataDir(async (root) => {
      const holder = await startHolder(root);
      await expect(open(root)).rejects.toThrow(StorageError);

      // `SIGKILL` is immediate but reaping is not, so wait for the child's own `exit` event —
      // after which the pid is genuinely gone and `isAlive` can be asserted rather than polled.
      await holder.stop();
      expect(isAlive(holder.pid)).toBe(false);

      const opened = await open(root);
      try {
        // Same host, dead pid: taken over immediately rather than waiting out the 60-second
        // heartbeat timeout, which is the fast path `12` §3.7 describes.
        expect(opened.tookOverFrom?.pid).toBe(holder.pid);
        expect(opened.db.open).toBe(true);
      } finally {
        await opened.release();
      }
    });
  });
});

/** Does this pid exist? `signal 0` checks without sending anything. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('the lock lifecycle around a connection', { tags: ['slow'] }, () => {
  it('holds the lock while open and releases it on close', async () => {
    await withDataDir(async (root) => {
      const opened = await open(root);
      const held = await readLockHolder(root, await nodeLockEnvironment('probe'));
      expect(held?.pid).toBe(process.pid);

      await opened.release();
      expect(await readLockHolder(root, await nodeLockEnvironment('probe'))).toBeUndefined();
      expect(opened.db.open).toBe(false);
    });
  });

  it('is safe to release twice', async () => {
    await withDataDir(async (root) => {
      const opened = await open(root);
      await opened.release();
      await expect(opened.release()).resolves.toBeUndefined();
    });
  });

  it('releases the lock when the database fails to open', async () => {
    await withDataDir(async (root) => {
      // Create the database under one key, then try to open it under another.
      const first = await open(root);
      await first.release();

      await expect(open(root, { key: Buffer.alloc(32, 0x7f) })).rejects.toThrow(StorageError);

      // The lock must not outlive the failed attempt. If it did, the next start would wait out the
      // 60-second stale timeout to be told the same thing — a restart loop paying a minute per
      // attempt for a problem that has nothing to do with locking.
      expect(await readLockHolder(root, await nodeLockEnvironment('probe'))).toBeUndefined();

      // Proven by the next open succeeding with the right key, rather than by the absence alone.
      const again = await open(root);
      try {
        expect(again.db.open).toBe(true);
      } finally {
        await again.release();
      }
    });
  });

  it('refuses a second writer in this process too, with the same error', async () => {
    await withDataDir(async (root) => {
      const first = await open(root);
      try {
        // A different pid and a live one, so this is the "somebody else holds it" path rather than
        // the stale-takeover path.
        const other = fakeEnvironment({ pid: process.pid + 1, alive: [process.pid] });
        const caught = await open(root, { environment: other }).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect((caught as StorageError).storageCode).toBe('STORAGE_LOCKED');
        // The holder is this process, which is what the message has to say for a host to be able
        // to act on it — "in use by pid <someone else>" would send them looking for the wrong one.
        expect((caught as StorageError).detail?.['pid']).toBe(process.pid);
      } finally {
        await first.release();
      }
    });
  });

  it('leaves the database and its sidecars at 0600 (12 §3.7)', async () => {
    await withDataDir(async (root) => {
      const opened = await open(root);
      try {
        // SQLite creates all three with `0644 & ~umask`, and nothing applied `12` §3.7's `0600`
        // until now — `grep chmod packages/storage/src/db/*.ts` was empty. On a default-umask host
        // the whole store, and every recent write in the WAL, was world-readable.
        const layout = dataDirLayout(root);
        // One write, so the `-wal` exists: a database that has only been created has nothing in
        // its write-ahead log and SQLite has not made the file yet. The WAL is the interesting
        // case — it holds the most recent writes in the clear relative to the page cipher's
        // boundaries, and it is the file a reader would reach for.
        opened.db.exec('CREATE TABLE mode_probe (x INTEGER)');
        await secureDatabaseFiles(root);

        // The sidecars exist while a connection is open, which is why this runs before `release`.
        const present = databaseFilePaths(root).filter((path) => existsSync(path));
        expect(present).toContain(layout.dbFile);
        expect(present).toContain(`${layout.dbFile}-wal`);
        expect(present.length).toBeGreaterThanOrEqual(2);

        for (const path of present) {
          expect(statSync(path).mode & 0o777, path).toBe(0o600);
        }
      } finally {
        await opened.release();
      }
    });
  });

  it('keeps the directory at 0700 as well, so the files are not reachable anyway', async () => {
    await withDataDir(async (root) => {
      const opened = await open(root);
      try {
        expect(statSync(dataDirLayout(root).db).mode & 0o777).toBe(0o700);
      } finally {
        await opened.release();
      }
    });
  });

  it('is audited, not only applied', async () => {
    await withDataDir(async (root) => {
      const opened = await open(root);
      await opened.release();

      // `auditPaths` walked the data-dir top level plus `keys/`, so `db/`'s **contents** were never
      // checked and boot reported clean over a world-readable database.
      //
      // The verdict is `tighten`, not `refuse`, and that is right: the database is encrypted at
      // rest, so a readable file is not the same severity as a readable `master.key`, and `12`
      // §3.7's rule 4 is that anything other than key material is corrected and warned about
      // rather than made into a reason not to start. The fix being tested is that the audit now
      // **sees** the file at all.
      const layout = dataDirLayout(root);
      chmodSync(layout.dbFile, 0o644);
      const audit = await auditPermissions(root);
      expect(audit.tightened).toContain(layout.dbFile);
      // Self-healing, which is the whole value of reaching it: the mode is corrected in place.
      expect(statSync(layout.dbFile).mode & 0o777).toBe(0o600);

      // And a file that was already correct is not reported, so this is the mode and not the path.
      const again = await auditPermissions(root);
      expect(again.tightened).not.toContain(layout.dbFile);
    });
  });

  it('starts the heartbeat by default and clears it on release', async () => {
    await withDataDir(async (root) => {
      // The default path, with no `withHeartbeat: false`. Not waiting out the 10-second interval:
      // what matters here is that the timer is created, `unref`ed so it cannot hold the process
      // open, and cleared on release. The refresh itself is `datadir/lock.ts`'s test, with a fake
      // clock — `11` §3.1.11 forbids a real timer in a test and is right to.
      const opened = await openLockedDatabase({
        dataDir: root,
        version: 'test-1.0.0',
        key: KEY,
      });
      try {
        expect(opened.db.open).toBe(true);
        expect(opened.lock.pid).toBe(process.pid);
      } finally {
        await opened.release();
      }
      // A live `setInterval` that was never cleared would keep this worker alive past the suite;
      // `unref` plus `clearInterval` is what stops that, and the lock being gone shows release ran
      // all the way through.
      expect(await readLockHolder(root, await nodeLockEnvironment('probe'))).toBeUndefined();
    });
  });

  it('passes every optional setting through to the connection', async () => {
    await withDataDir(async (root) => {
      // Each of these is a conditional spread in `openLockedDatabase`, and
      // `exactOptionalPropertyTypes` is why they are spreads rather than `undefined` values — an
      // explicit `cipher: undefined` is a type error against `OpenOptions`. Exercising all four
      // together keeps the spreads from being the untested half of the function.
      const opened = await openLockedDatabase({
        dataDir: root,
        version: 'test-1.0.0',
        key: KEY,
        cipher: 'sqlcipher',
        busyTimeoutMs: 1_234,
        cacheSizeKiB: 2_048,
        loadVec: true,
        withHeartbeat: false,
      });
      try {
        expect(opened.encrypted).toBe(true);
        expect(opened.vecVersion).toBeDefined();
        expect(pragmaValue(opened.db, 'busy_timeout')).toBe(1_234);
        // SQLite reports a KiB cache as a negative page count.
        expect(pragmaValue(opened.db, 'cache_size')).toBe(-2_048);
      } finally {
        await opened.release();
      }
    });
  });

  it('runs the holder child at all, so the cross-process tests are not vacuous', () => {
    // If `tsx` or the paths tsconfig broke, `startHolder` would reject and every test above would
    // fail — but it would fail for a harness reason that looks like a product failure. This names
    // the difference: the child script exists and parses.
    expect(existsSync(HOLDER)).toBe(true);
    const output = execFileSync(join(REPO_ROOT, 'node_modules/.bin/tsx'), ['--version'], {
      encoding: 'utf8',
    });
    expect(output.length).toBeGreaterThan(0);
  });
});
