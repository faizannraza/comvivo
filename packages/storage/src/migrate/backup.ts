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
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { StorageError } from '@comvivo/shared';
import type Database from 'better-sqlite3-multiple-ciphers';
import DatabaseCtor from 'better-sqlite3-multiple-ciphers';

/** The subdirectory of `backupDir` that pre-migration copies live in. */
export const PRE_MIGRATE_DIR = 'pre-migrate';

/** `02` §3.12.2: the runner needs at least this multiple of the database size free. */
export const REQUIRED_FREE_SPACE_MULTIPLE = 2;

export interface PreMigrationBackupOptions {
  /** The data directory's backup root. */
  readonly backupDir: string;
  /** The last migration already applied, or `'empty'` for a database with none. */
  readonly fromLastId: string;
  /** The last migration that will be applied. */
  readonly toLastId: string;
  /** How many copies to keep (`02` §3.12.2 default 3). */
  readonly keep: number;
  /** Epoch milliseconds, injected so the file name is deterministic in tests. */
  readonly nowMs: number;
}

/** `02` §3.12.4's file name: `<fromLastId>__<toLastId>__<ts>.db`. */
export function preMigrationBackupName(options: PreMigrationBackupOptions): string {
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

  verifyBackup(path);
  pruneOldBackups(directory, options.keep);
  return path;
}

/** Open the copy read-only and run `quick_check`. */
function verifyBackup(path: string): void {
  const copy = new DatabaseCtor(path, { readonly: true });
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
