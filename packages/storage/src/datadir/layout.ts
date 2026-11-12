/**
 * The data directory's shape and modes (`12` §3.7).
 *
 * One table, read by everything that writes under `dataDir`: the server at boot, `doctor`,
 * `backup`, `restore` and the installers. The point of centralising it is that the **modes** are
 * part of the security model, not decoration — `12` §3.7's audit refuses to start on a
 * group-readable `keys/`, and it can only do that if there is one agreed answer to "what should
 * this path's mode be".
 *
 * Two rules shape every path below:
 *
 *  - **`tmp/` is on the same filesystem as the data.** Every atomic write in this product is
 *    `write to tmp → fsync → rename`, and `rename(2)` is only atomic *within* a filesystem. A
 *    `tmp/` under `/tmp` would silently become a copy, which is not atomic and not crash-safe.
 *  - **Nothing here is brand-named except through `BRAND`.** A file in a host's data directory
 *    that carries the product name turns a rename into a migration (`STATUS.md`, 2026-11-03), so
 *    `comvivo.db` and `comvivo.lock` are built from `BRAND.slug`.
 */

import { join } from 'node:path';
import { BRAND } from '@comvivo/shared';

/** `12` §3.7: the data directory and every directory in it. */
export const DIR_MODE = 0o700;

/** `12` §3.7: every file in it. */
export const FILE_MODE = 0o600;

/**
 * The directories `12` §3.7 lays out, in creation order.
 *
 * Order matters only in that a parent must precede its children; `createLayout` relies on it so
 * it can `mkdir` without `recursive` and therefore notice a path that exists as a *file*.
 */
export const DATA_DIRS = [
  'db',
  'blobs',
  'keys',
  'backups',
  'backups/daily',
  'backups/weekly',
  'backups/monthly',
  'backups/pre-migrate',
  'backups/manual',
  'backups/ha-snapshot',
  'models',
  'models/.partial',
  'plugins',
  'logs',
  'run',
  'tmp',
] as const;

export type DataDirName = (typeof DATA_DIRS)[number];

/**
 * Directories created only when the feature that owns them is on.
 *
 * `logs/` exists only with `logging.file.enabled` (`12` §3.7), and an empty `logs/` in every
 * install would be a directory a host reasonably assumes is being written to.
 */
export const OPTIONAL_DIRS: readonly DataDirName[] = ['logs'];

/**
 * The key material `12` §3.7 and `08` §3.7.3 refuse to start on if it is group- or
 * world-readable, relative to `keys/`.
 *
 * Most installs have only the first two. The rest are listed so the audit covers an install that
 * does have them rather than silently skipping a file it has never heard of.
 */
export const KEY_FILES = [
  'master.key',
  'keyring.json',
  'keyring.json.prev',
  'vault.enc',
  'secrets.enc',
  'control.token',
] as const;

/** Every path the product knows about, resolved against one `dataDir`. */
export interface DataDirLayout {
  readonly root: string;
  readonly format: string;
  readonly db: string;
  readonly dbFile: string;
  readonly blobs: string;
  readonly keys: string;
  readonly masterKey: string;
  readonly keyring: string;
  readonly backups: string;
  readonly models: string;
  readonly plugins: string;
  readonly logs: string;
  readonly run: string;
  readonly lock: string;
  readonly lastBoot: string;
  readonly tmp: string;
}

/**
 * Resolve the layout for a data directory.
 *
 * Pure: no I/O, no `stat`, no creation. That matters because `doctor`, the installers and the
 * boot path all need to *name* these paths in messages before anything exists, and because a
 * function that silently created a directory as a side effect of being asked for a path would be
 * impossible to use in a dry run.
 */
export function dataDirLayout(root: string): DataDirLayout {
  return {
    root,
    format: join(root, 'FORMAT'),
    db: join(root, 'db'),
    dbFile: join(root, 'db', `${BRAND.slug}.db`),
    blobs: join(root, 'blobs'),
    keys: join(root, 'keys'),
    masterKey: join(root, 'keys', 'master.key'),
    keyring: join(root, 'keys', 'keyring.json'),
    backups: join(root, 'backups'),
    models: join(root, 'models'),
    plugins: join(root, 'plugins'),
    logs: join(root, 'logs'),
    run: join(root, 'run'),
    lock: join(root, 'run', `${BRAND.slug}.lock`),
    lastBoot: join(root, 'run', 'last-boot.json'),
    tmp: join(root, 'tmp'),
  };
}

/**
 * The absolute paths of every key file the audit checks, for one data directory.
 *
 * A function rather than a field on the layout because most of these do not exist in most
 * installs, and a layout full of paths to absent files invites code that assumes they are there.
 */
export function keyFilePaths(root: string): readonly string[] {
  return KEY_FILES.map((name) => join(root, 'keys', name));
}

/**
 * Create the layout, with `12` §3.7's modes.
 *
 * `mkdir` **without** `recursive`, one directory at a time in `DATA_DIRS` order. `recursive: true`
 * would succeed silently when a path already exists as a *file*, and the failure would then
 * surface much later as a confusing write error deep in the blob store. One level at a time means
 * `EEXIST` on a non-directory is reported here, where the message can name the path.
 *
 * The explicit `chmod` after each `mkdir` is not redundant, though **not** for the reason it is
 * tempting to give. A umask cannot loosen a mode — measured: `mkdir(path, { mode: 0o700 })` yields
 * 0700 under `umask 022` and under `umask 077`, because a umask only clears bits and 0700 has no
 * group or other bits to clear. The real reason is that `mode` applies **only when `mkdir` creates
 * the directory**: an existing 0755 `keys/` keeps 0755 no matter how often the layout is
 * recreated, and boot recreates it every time. Without the chmod, `12` §3.7's audit would warn
 * forever about a directory this function kept handing back unchanged.
 */
export async function createLayout(
  root: string,
  options: { readonly includeOptional?: readonly DataDirName[] } = {},
): Promise<readonly string[]> {
  const { chmod, mkdir, stat } = await import('node:fs/promises');
  const include = new Set(options.includeOptional ?? []);
  const created: string[] = [];

  const ensure = async (path: string): Promise<void> => {
    try {
      await mkdir(path, { mode: DIR_MODE });
      created.push(path);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
      const stats = await stat(path);
      if (!stats.isDirectory()) {
        throw new Error(`${path} exists and is not a directory`, { cause });
      }
    }
    await chmod(path, DIR_MODE);
  };

  await ensure(root);
  for (const name of DATA_DIRS) {
    if (OPTIONAL_DIRS.includes(name) && !include.has(name)) continue;
    await ensure(join(root, name));
  }
  return created;
}
