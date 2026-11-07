/**
 * `initDatabase` (`02` §3.6.2).
 *
 * Creating a database is a different operation from opening one, and the difference is not
 * ceremony. Two settings can **only** be chosen at creation:
 *
 *  - **`auto_vacuum = INCREMENTAL`**, which `02` §3.6.2 says is "set once, on creation (before the
 *    first table)". SQLite ignores a change to `auto_vacuum` on a database that already has a
 *    schema, silently — so a database created without it can never reclaim space incrementally,
 *    and `02` §3.13's purge flows would grow the file forever. Changing it afterwards needs a full
 *    `VACUUM`, which rewrites the whole database and needs free space equal to its size: on a Pi
 *    with a 4 GB database and a 2 GB card, that is not a recovery, it is a restore.
 *  - **`page_size`**, left at SQLite's default deliberately. The spike measured no benefit worth
 *    the risk, and changing it later has the same `VACUUM` cost.
 *
 * So this function is the one place that may create a file, and it refuses to touch one that
 * already has a schema. That refusal is the real feature: `12` §3.8.1 step 2 and step 3 both rest
 * on "a key is never generated while a database exists", and the symmetric rule here is that a
 * database is never *initialised* while one exists.
 */
import { rmSync } from 'node:fs';
import { StorageError } from '@comvivo/shared';
import type Database from 'better-sqlite3-multiple-ciphers';
import { mapSqliteError } from './errors.js';
import { type OpenDatabase, type OpenOptions, openDatabase, pragmaValue } from './open.js';

/** `02` §3.6.2: incremental, so `02` §3.13's purges can reclaim space without a full VACUUM. */
export const AUTO_VACUUM_INCREMENTAL = 2;

export interface InitResult extends OpenDatabase {
  /** False when the database was already there, which is the common case after the first boot. */
  readonly created: boolean;
}

/**
 * Open a database, creating and configuring it if it is not there.
 *
 * `role` is fixed to `main` because only the main role may create (`02` §3.6.2's `fileMustExist`),
 * and allowing a caller to pass `worker` here would quietly re-enable the thing that rule
 * prevents.
 */
export function initDatabase(options: Omit<OpenOptions, 'role' | 'readonly'>): InitResult {
  const state = probeDatabase(options);

  if (state === 'populated') {
    const opened = openDatabase({ ...options, role: 'main' });
    try {
      assertAutoVacuum(opened.db, options.path);
      return { ...opened, created: false };
    } catch (error) {
      opened.db.close();
      throw error;
    }
  }

  if (state === 'empty') {
    // **An interrupted first boot, and the only way back.** Measured on
    // better-sqlite3-multiple-ciphers 13.0.3: once a database file exists with `journal_mode = WAL`
    // recorded in its header, `auto_vacuum = INCREMENTAL` can never be enabled on it — not on an
    // empty file, not after switching back to `journal_mode = DELETE`, not before the first table.
    // It reports success and stays at 0.
    //
    // So a boot that created the file and then failed before creating any table leaves a database
    // that could never reclaim space for the rest of its life. Removing it is safe *because* it
    // has no tables: a database with zero tables holds zero rows, so there is nothing to lose, and
    // the `-wal` and `-shm` files are derived from it.
    //
    // Narrow on purpose. This is only reached when the file **opened with the supplied key** and
    // reported **zero tables** — a wrong key throws from `probeDatabase` instead, and a single
    // table is enough to make this a `populated` database that is never touched.
    removeUnfinished(options.path);
  }

  const opened = openDatabase({ ...options, role: 'main', onCreated: enableIncrementalVacuum });
  return { ...opened, created: true };
}

/** What is at `path`: nothing, an unfinished file with no tables, or somebody's database. */
export type DatabaseState = 'absent' | 'empty' | 'populated';

/**
 * Find out what is at `path` without creating anything.
 *
 * "With a schema" rather than "the file exists", because `openDatabase` on the main role creates
 * an empty file as a side effect of opening — so after one failed boot the file is there and holds
 * nothing, and the two cases need different answers.
 */
export function probeDatabase(options: Omit<OpenOptions, 'role' | 'readonly'>): DatabaseState {
  let probe: OpenDatabase;
  try {
    // `role: 'cli'` so `fileMustExist` is true: this must not create the file it is asking about.
    // `loadVec: false` because the extension is irrelevant to the question, and a load failure
    // here would be reported as "no database" rather than as itself.
    probe = openDatabase({ ...options, role: 'cli', readonly: true, loadVec: false });
  } catch (error) {
    if (error instanceof StorageError && error.storageCode === 'STORAGE_KEY_INVALID') {
      // The file is there and the key does not open it. **Not** "no database": initialising here
      // would write a second database over somebody's data. `12` §3.8.1 step 3 is explicit that a
      // key is never generated while a database exists, and this is the storage half of that rule.
      throw error;
    }
    return 'absent';
  }

  try {
    const row = probe.db
      .prepare("SELECT count(*) AS tables FROM sqlite_master WHERE type = 'table'")
      .get() as { tables?: number };
    return (row.tables ?? 0) > 0 ? 'populated' : 'empty';
  } catch (cause) {
    throw mapSqliteError(cause, {
      encrypted: options.key !== null,
      operation: 'reading the schema',
    });
  } finally {
    probe.db.close();
  }
}

/**
 * Remove a database file that holds no tables, with its `-wal` and `-shm`.
 *
 * Only ever called for the `empty` state. The sidecars go too because a `-wal` left beside a
 * recreated database is a journal for a file that no longer exists, and SQLite would try to replay
 * it.
 */
function removeUnfinished(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${path}${suffix}`);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new StorageError('STORAGE_IO', `${path}${suffix} could not be removed`, {
          hint:
            'An unfinished database from an interrupted first run has to be removed before it can ' +
            'be created properly. Check the data directory is writable.',
          cause,
        });
      }
    }
  }
}

/**
 * Turn on incremental auto-vacuum, and **check that it took**.
 *
 * The check is the whole point. `PRAGMA auto_vacuum` does not error when it cannot apply — it
 * reports success and leaves the setting at 0 — so without reading it back this function would be
 * indistinguishable from one that did nothing, which is exactly the bug the ordering fixes.
 */
function enableIncrementalVacuum(db: Database.Database): void {
  db.pragma('auto_vacuum = INCREMENTAL');
  const applied = pragmaValue(db, 'auto_vacuum');
  if (applied !== AUTO_VACUUM_INCREMENTAL) {
    throw new StorageError(
      'STORAGE_IO',
      `auto_vacuum is ${String(applied)} on a database just created, expected ` +
        String(AUTO_VACUUM_INCREMENTAL),
      {
        hint:
          'This is a bug: `auto_vacuum` can only be set on a database that has never had ' +
          '`journal_mode = WAL` written to its header, so if it did not apply here it never will ' +
          '— and deletions would never reclaim space.',
        category: 'bug',
      },
    );
  }
}

/**
 * Warn loudly if an existing database was created without incremental auto-vacuum.
 *
 * Not fatal: a host whose database predates this check still has working data, and refusing to
 * start would be a worse outcome than a growing file. But it is reported, because the only fix is
 * a full `VACUUM` and the right time to do that is a maintenance window the host chooses — not the
 * moment their disk fills up.
 */
export function assertAutoVacuum(db: Database.Database, path: string): void {
  const mode = pragmaValue(db, 'auto_vacuum');
  if (mode === AUTO_VACUUM_INCREMENTAL) return;
  throw new StorageError(
    'STORAGE_VERSION_UNSUPPORTED',
    `${path} has auto_vacuum = ${String(mode)}, and incremental vacuum is not available on it`,
    {
      hint:
        'This database was created without `auto_vacuum = INCREMENTAL`, which can only be set ' +
        'before the first table. Deletions will not reclaim space. The fix is a full `VACUUM` ' +
        'during a maintenance window — it rewrites the whole file and needs free space equal to ' +
        'its size, so do it before the disk is tight rather than after.',
    },
  );
}

/**
 * Reclaim space in bounded chunks (`02` §3.6.2, §3.13).
 *
 * Chunked rather than a bare `incremental_vacuum`, because the unbounded form holds the write lock
 * until it finishes — which on a large purge is long enough for every other connection to hit
 * `SQLITE_BUSY`. `02` §3.6.2 names 4096 pages per chunk.
 */
export function incrementalVacuum(db: Database.Database, pages = 4096): number {
  const before = freePages(db);
  db.pragma(`incremental_vacuum(${String(pages)})`);
  return before - freePages(db);
}

/** How many pages the database is holding but not using. */
export function freePages(db: Database.Database): number {
  const value = pragmaValue(db, 'freelist_count');
  return typeof value === 'number' ? value : 0;
}
