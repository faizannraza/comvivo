/**
 * The writer connection, holding the instance lock (`02` §3.6.2, `12` §3.7; invariant C1).
 *
 * `M1-T8`'s acceptance criterion ends "Uses `M1-T7` for the lock", and nothing did: the lock module
 * had no production caller at all, `lockedError` was reachable only from its own tests, and two
 * processes pointed at one data directory would both have opened it for writing. SQLite's own
 * locking would have kept the file consistent and C1 would still have been gone — writer isolation
 * is about one process owning the WAL, the outbox leases and the job queue, and SQLite has no
 * opinion about those.
 *
 * ## Why this is a separate module, and async
 *
 * `acquireLock` is asynchronous and `openDatabase` is deliberately synchronous — `02` §3.7.2 wants
 * synchronous repositories and transactions that never span an `await`, which is the rule the whole
 * storage layer is built on. Making `openDatabase` async to fit the lock in would have inverted
 * that for every caller. So the lock lives in one `async` function that brackets the synchronous
 * open, and the rest of the layer never sees a promise.
 *
 * ## What `release()` guarantees
 *
 * The lock is released **after** the connection is closed, and a failed open releases it before
 * rethrowing. Both directions matter: a lock left behind by a crashed boot is only cleaned up by
 * the 60-second stale takeover, so a container restart loop would wait a minute per attempt for a
 * problem that has nothing to do with locking.
 */
import { mkdir } from 'node:fs/promises';
import {
  acquireLock,
  DIR_MODE,
  dataDirLayout,
  HEARTBEAT_INTERVAL_MS,
  heartbeat,
  type LockEnvironment,
  type LockFile,
  type LockHolder,
  lockedError,
  lockPath,
  nodeLockEnvironment,
  releaseLock,
  secureDatabaseFiles,
} from '../datadir/index.js';
import { type InitResult, initDatabase } from './init.js';
import type { Cipher } from './open.js';

export interface LockedDatabaseOptions {
  /** The data directory root, not the database file: the lock lives in `run/`. */
  readonly dataDir: string;
  /** Recorded in the lock file, so the holder's version appears in the other process's error. */
  readonly version: string;
  /** `null` only when `privacy.encryptAtRest` is false, which `doctor` warns about. */
  readonly key: Buffer | null;
  readonly cipher?: Cipher;
  readonly busyTimeoutMs?: number;
  readonly cacheSizeKiB?: number;
  readonly loadVec?: boolean;
  /**
   * Keep refreshing `heartbeatAt` while the connection is open. On by default.
   *
   * Off for a short-lived command: a CLI call that exits in two seconds never reaches the first
   * interval, and a timer it has to remember to clear is a way to leave the process hanging.
   */
  readonly withHeartbeat?: boolean;
  /** Injected so a test can drive the clock and the liveness probe. */
  readonly environment?: LockEnvironment;
}

export interface LockedDatabase extends InitResult {
  /** The lock this process holds. */
  readonly lock: LockFile;
  /** Set when a stale lock was taken over, so a caller can log that it happened. */
  readonly tookOverFrom?: LockHolder;
  /** Close the connection and release the lock. Safe to call more than once. */
  release(): Promise<void>;
}

/**
 * Open the database for writing, holding the instance lock for as long as it is open.
 *
 * @throws a `STORAGE_LOCKED` {@link import('@comvivo/shared').StorageError} when another live
 * process holds the lock. `exitCodeFor` maps that to 75, so an orchestrator restarts with backoff
 * rather than giving up — `12` §4.2.
 */
export async function openLockedDatabase(options: LockedDatabaseOptions): Promise<LockedDatabase> {
  const environment = options.environment ?? (await nodeLockEnvironment(options.version));
  const outcome = await acquireLock(options.dataDir, environment);
  if (!outcome.acquired) {
    throw lockedError(outcome.heldBy, lockPath(options.dataDir));
  }

  const layout = dataDirLayout(options.dataDir);
  let opened: InitResult;
  try {
    // `db/` with the right mode, the same way `acquireLock` ensures `run/`. SQLite's own error for
    // a missing directory is "Cannot open database because the directory does not exist", which
    // tells a host nothing about which directory or why.
    await mkdir(layout.db, { recursive: true, mode: DIR_MODE });
    opened = initDatabase({
      path: layout.dbFile,
      key: options.key,
      ...(options.cipher === undefined ? {} : { cipher: options.cipher }),
      ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
      ...(options.cacheSizeKiB === undefined ? {} : { cacheSizeKiB: options.cacheSizeKiB }),
      ...(options.loadVec === undefined ? {} : { loadVec: options.loadVec }),
    });
  } catch (cause) {
    // Release before rethrowing. The alternative is a lock whose holder is already gone, which
    // only clears after the stale timeout — so a boot that fails on a wrong key would make the
    // next attempt wait a minute to be told the same thing.
    await releaseLock(options.dataDir, environment);
    throw cause;
  }

  // SQLite creates the database and its `-wal`/`-shm` sidecars with `0644 & ~umask`, so on a
  // default-umask host the store is world-readable the moment it exists. `12` §3.7 says `0600`,
  // and nothing applied it until now.
  await secureDatabaseFiles(options.dataDir);

  const timer =
    options.withHeartbeat === false
      ? undefined
      : setInterval(() => {
          // A failed heartbeat is not an error to propagate: `heartbeat` returns false when this
          // process no longer owns the lock, and the interval is the wrong place to decide what to
          // do about that. `12` §3.7's health check reports it; `09`'s `/healthz` surfaces it.
          void heartbeat(options.dataDir, environment).catch(() => false);
        }, HEARTBEAT_INTERVAL_MS);
  // Never hold the event loop open. A server has its own reasons to stay running; a CLI command
  // must be able to exit the moment its work is done.
  timer?.unref();

  let released = false;
  return {
    ...opened,
    lock: outcome.lock,
    ...(outcome.tookOverFrom === undefined ? {} : { tookOverFrom: outcome.tookOverFrom }),
    async release(): Promise<void> {
      if (released) return;
      released = true;
      if (timer !== undefined) clearInterval(timer);
      // Close first: releasing the lock while a connection is still open would let a second
      // process in while this one still has the WAL mapped, which is the state C1 forbids.
      opened.db.close();
      await releaseLock(options.dataDir, environment);
    },
  };
}
