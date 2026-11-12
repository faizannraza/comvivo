/**
 * The pre-migration backup (`02` §3.12.4).
 *
 * `02` §3.12.2 is forward-only: each migration commits on its own, so if migration *k* fails the
 * earlier ones stay applied. There is no "down" migration, by design — a reversal script is code
 * nobody tests and that runs exactly once, in an emergency. The backup **is** the rollback path,
 * and `village restore pre-migrate:latest` (`09` §C) is how it is used.
 *
 * `VACUUM INTO` rather than a file copy, for two reasons that both matter here. It takes a
 * consistent snapshot without stopping writers, so the backup does not need the database to be
 * quiet; and it writes a defragmented single file with no WAL to reconcile, so the restored copy
 * cannot be a torn read of a database mid-checkpoint.
 *
 * `quick_check` then runs on the copy. A backup nobody verified is a backup that is discovered to
 * be useless at the only moment it is needed.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { StorageError } from '@comvivo/shared';
import type Database from 'better-sqlite3-multiple-ciphers';
import { openDatabase } from '../db/open.js';

/** The subdirectory of `backupDir` that pre-migration copies live in. */
export const PRE_MIGRATE_DIR = 'pre-migrate';

/**
 * `12` §3.7 step 6: the runner needs at least this multiple of the database size free.
 *
 * **2.2, not 2**, and nothing read it at all. The constant was `2` and there was no free-space
 * probe anywhere in this module, so `12` §3.7's "require free space ≥ 2.2× the DB size (else 75)"
 * was a published requirement with no code behind it. Found by the M1 independent review.
 *
 * Why more than 2×: `VACUUM INTO` writes a full copy, and the migration that follows it then needs
 * room for its own journal and for any table rebuild. The 0.2 is that headroom — running out of
 * space *during* the upgrade is strictly worse than refusing to start, because the backup exists
 * and the database is half-migrated.
 */
export const REQUIRED_FREE_SPACE_MULTIPLE = 2.2;

/** How the free-space check reads the filesystem. Injected so a test can state a full disk. */
export interface SpaceProbe {
  /** Bytes available to this user at `path`, or `undefined` when it cannot be determined. */
  freeBytes(path: string): number | undefined;
}

export const nodeSpaceProbe: SpaceProbe = {
  freeBytes(path: string): number | undefined {
    try {
      const stats = statfsSync(path);
      // `bavail`, not `bfree`: the difference is the reserve only root can use, and this process
      // is not root. Reporting the larger number would let the check pass and the write fail.
      return stats.bsize * stats.bavail;
    } catch {
      return undefined;
    }
  },
};

/**
 * Refuse the upgrade when the disk cannot hold the backup.
 *
 * `STORAGE_DISK_SPACE_LOW` maps to exit **75** (`12` §4.2, `shared/src/exit-codes.ts`), which is
 * what `12` §3.7 step 6 asks for: an orchestrator backs off and retries rather than treating a
 * full disk as a configuration error a human must fix before the service may start again.
 *
 * An unreadable `statfs` is **not** a failure. This check exists to turn a predictable
 * out-of-space into a clean refusal; a platform that cannot answer should not be able to stop an
 * upgrade that would otherwise have worked.
 */
export function assertSpaceForBackup(
  databaseBytes: number,
  directory: string,
  probe: SpaceProbe = nodeSpaceProbe,
): void {
  const free = probe.freeBytes(directory);
  if (free === undefined) return;
  const needed = Math.ceil(databaseBytes * REQUIRED_FREE_SPACE_MULTIPLE);
  if (free >= needed) return;
  throw new StorageError(
    'STORAGE_DISK_SPACE_LOW',
    'there is not enough free space for the pre-migration backup',
    {
      hint:
        `The upgrade needs ${String(Math.ceil(needed / 1_048_576))} MiB free and the backup ` +
        `directory has ${String(Math.floor(free / 1_048_576))} MiB. Free some space and start ` +
        'again — migrations are forward-only, so this backup is the rollback path and the upgrade ' +
        'will not begin without it.',
      detail: {
        freeBytes: free,
        neededBytes: needed,
        databaseBytes,
        multiple: REQUIRED_FREE_SPACE_MULTIPLE,
      },
    },
  );
}

/** The database file's size on disk, including its WAL, or 0 when it cannot be read. */
export function databaseBytesOf(db: Database.Database): number {
  const rows = db.pragma('database_list') as { name: string; file: string }[];
  const file = rows.find((row) => row.name === 'main')?.file ?? '';
  if (file === '') return 0;
  let total = 0;
  for (const candidate of [file, `${file}-wal`]) {
    try {
      total += statSync(candidate).size;
    } catch {
      // Absent: an in-memory database has no file, and the WAL exists only while a connection is
      // open in WAL mode.
    }
  }
  return total;
}

export interface PreMigrationBackupOptions {
  /** The data directory's backup root. */
  readonly backupDir: string;
  /**
   * The key the source database is open under, or `null` for an unencrypted instance.
   *
   * Needed because the snapshot is encrypted with it (SP-3): the verification below cannot open
   * the copy without it, and a verification that silently skipped the check would be worse than
   * none — `02` §3.12.4 makes this backup the rollback path for a forward-only migration.
   */
  readonly key: Buffer | null;
  /** The last migration already applied, or `'empty'` for a database with none. */
  readonly fromLastId: string;
  /** The last migration that will be applied. */
  readonly toLastId: string;
  /** How many copies to keep (`02` §3.12.2 default 3). */
  readonly keep: number;
  /** Epoch milliseconds, injected so the file name is deterministic in tests. */
  readonly nowMs: number;
  /** Injected so a test can state a full disk rather than need one. */
  readonly space?: SpaceProbe;
}

/** `02` §3.12.4's file name: `<fromLastId>__<toLastId>__<ts>.db`. */
export function preMigrationBackupName(
  options: Pick<PreMigrationBackupOptions, 'fromLastId' | 'toLastId' | 'nowMs'>,
): string {
  return `${options.fromLastId}__${options.toLastId}__${String(options.nowMs)}.db`;
}

/**
 * Take the backup and verify it, returning its path.
 *
 * The path is returned rather than logged here because `02` §3.12.2 has the CLI print it: a host
 * who needs it is reading terminal output, not a log file.
 */
export function preMigrationBackup(
  db: Database.Database,
  options: PreMigrationBackupOptions,
): string {
  const directory = join(options.backupDir, PRE_MIGRATE_DIR);
  const path = join(directory, preMigrationBackupName(options));

  try {
    // Inside the `try`: `mkdirSync` was outside it in the first version, so a backup directory
    // that could not be created escaped as a raw `ENOTDIR` — no code, no hint, and nothing saying
    // that this is why the upgrade stopped. Found by the test that asserts the failure is a
    // `StorageError`.
    mkdirSync(directory, { recursive: true });
  } catch (cause) {
    throw new StorageError('MIGRATION_FAILED', 'the pre-migration backup could not be written', {
      hint:
        'Migrations are forward-only, so this backup is the rollback path and the upgrade will ' +
        'not start without it. Check the permissions on the backup directory.',
      detail: { path },
      cause,
    });
  }

  // After the directory exists, so the probe reads the filesystem the copy will land on — a
  // separate mount for `backups/` is a normal arrangement and its free space is the one that
  // matters. Outside the `try` below because this is a clean refusal with its own code and exit
  // status, not a write that failed.
  assertSpaceForBackup(databaseBytesOf(db), directory, options.space);

  try {
    // `VACUUM INTO` refuses to overwrite, which is the behaviour we want: a name collision means
    // two migrations started in the same millisecond, and silently replacing the first copy would
    // destroy the only rollback path for one of them.
    db.exec(`VACUUM INTO ${quote(path)}`);
  } catch (cause) {
    throw new StorageError('MIGRATION_FAILED', 'the pre-migration backup could not be written', {
      hint:
        'Migrations are forward-only, so this backup is the rollback path and the upgrade will ' +
        'not start without it. Check free disk space and the permissions on the backup directory.',
      detail: { path },
      cause,
    });
  }

  // A snapshot that fails verification is **removed**, not left in the directory.
  //
  // `pruneOldBackups` sorts by mtime, so the corrupt copy would be the newest — and the error this
  // path raises recommends `restore pre-migrate:latest`, which would then select the file that
  // just failed `quick_check`. The upgrade is refused either way; the difference is whether the
  // rollback path a host reaches for is the broken one. Found by the M1 exit gate's reviewer.
  try {
    verifyBackup(path, options.key);
  } catch (cause) {
    rmSync(path, { force: true });
    throw cause;
  }
  pruneOldBackups(directory, options.keep);
  return path;
}

/**
 * Open the copy read-only and run `quick_check`.
 *
 * **With the key**, and the first version of this did not have one — which made it fail on every
 * encrypted instance, which is every default install. `VACUUM INTO` under SQLite3MultipleCiphers
 * writes an *encrypted* snapshot (SP-3, and `M1-T2` asserts it), so a keyless
 * `new Database(path, { readonly: true }).pragma('quick_check')` throws `SQLITE_NOTADB` — raw, with
 * no code and no hint, out of a function with a `try/finally` and no `try/catch`. Every migration
 * of a real host would have stopped there.
 *
 * It passed CI because the only test of this path seeds a **plaintext** database, so the snapshot
 * was plaintext too and the keyless open worked. Found at `M1-T27`, when the backup pipeline needed
 * the same `quick_check` on the same kind of snapshot; measured before being believed.
 *
 * `openDatabase` rather than a bare constructor, so the cipher, the `legacy=4` compatibility and
 * the hex validation are the ones the rest of the product uses. `loadVec: false` because a
 * snapshot's integrity does not depend on the extension and a verification that needed it would
 * fail on a `doctor --repair` host.
 */
function verifyBackup(path: string, key: Buffer | null): void {
  const opened = openDatabase({ path, key, readonly: true, role: 'cli', loadVec: false });
  const copy = opened.db;
  try {
    const result = copy.pragma('quick_check', { simple: true });
    if (result !== 'ok') {
      throw new StorageError('BACKUP_INTEGRITY', 'the pre-migration backup failed quick_check', {
        hint:
          'The backup was written but is not readable, so it cannot serve as the rollback path. ' +
          'Check the disk for errors before upgrading.',
        detail: { path, result: String(result) },
      });
    }
  } finally {
    copy.close();
  }
}

/**
 * Keep only the newest `keep` copies.
 *
 * Oldest-first by modification time rather than by name: the name starts with the *from* id, so
 * sorting by name would delete by migration order rather than by age, and a re-run of the same
 * upgrade would evict the copy taken before the first attempt — the one that is actually wanted.
 */
export function pruneOldBackups(directory: string, keep: number): readonly string[] {
  if (!existsSync(directory) || keep < 0) return [];
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.db'))
    .map((name) => ({ name, mtimeMs: statSync(join(directory, name)).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
  const removed: string[] = [];
  for (const file of files.slice(keep)) {
    rmSync(join(directory, file.name), { force: true });
    removed.push(file.name);
  }
  return removed;
}

/** Quote a path as a SQL string literal. */
function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
