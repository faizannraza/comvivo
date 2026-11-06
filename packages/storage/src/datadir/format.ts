/**
 * The `FORMAT` marker (`12` §4.5, `12` §3.8.1 step 2).
 *
 * One small JSON file at the root of a data directory, and it answers the question the boot
 * sequence cannot answer any other way: **is this an install, or an empty directory?**
 * `12` §3.8.1 step 2 turns that into three outcomes, and the difference between them is the
 * difference between a fresh start and destroying somebody's data:
 *
 *  - no `FORMAT`, empty `db/` → a fresh install;
 *  - no `FORMAT`, non-empty `db/` → **exit 65**, because something is there and this build did
 *    not put it there;
 *  - `FORMAT` present → read it, and refuse a `formatVersion` from the future.
 *
 * The third case is why `format` is a frozen wire constant. A host's directory carries this
 * string, so changing it would make every existing install look like "not mine" — the same
 * no-migration property the crypto labels have — the constants themselves live in `marker.ts`,
 * which is exempt from the brand guard and asserted to import nothing.
 *
 * Written atomically through `tmp/` (`12` §4.5), because a half-written `FORMAT` is indistinguishable
 * from a foreign directory and would trigger the exit-65 path on the next boot.
 */
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type InstanceId, idSchema, StorageError, z } from '@comvivo/shared';
import { DIR_MODE, dataDirLayout, FILE_MODE } from './layout.js';
import { DATA_DIR_FORMAT, DATA_DIR_FORMAT_VERSION } from './marker.js';

const lastBootSchema = z.object({
  version: z.string().min(1),
  schemaHead: z.string().min(1),
  at: z.string().min(1),
});

export const formatSchema = z.object({
  format: z.literal(DATA_DIR_FORMAT),
  formatVersion: z.number().int().positive(),
  instanceId: idSchema('inst'),
  createdAt: z.string().min(1),
  createdBy: z.string().min(1),
  /** Absent until the first successful boot (`12` §3.8.1 step 8). */
  lastBoot: lastBootSchema.optional(),
  lastCleanShutdownAt: z.string().min(1).optional(),
});

export { DATA_DIR_FORMAT, DATA_DIR_FORMAT_VERSION } from './marker.js';

export type DataDirFormat = z.infer<typeof formatSchema>;
export type LastBoot = z.infer<typeof lastBootSchema>;

/** What `readFormat` found. `12` §3.8.1 step 2's three outcomes, as a value. */
export type FormatState =
  | { readonly kind: 'present'; readonly format: DataDirFormat }
  | { readonly kind: 'fresh' }
  | { readonly kind: 'occupied'; readonly reason: string };

/**
 * Read `FORMAT`, distinguishing a fresh directory from one that is already somebody's install.
 *
 * `hasData` is injected rather than hard-coded as "is `db/` non-empty" because the question is
 * really "would starting fresh here destroy something", and `12` §3.8.1 asks it of `db/` while a
 * restore asks it of the whole tree. Defaulting it keeps the common case a one-argument call.
 */
export async function readFormat(
  root: string,
  hasData: (root: string) => Promise<boolean> = dbDirHasData,
): Promise<FormatState> {
  const layout = dataDirLayout(root);
  let text: string;
  try {
    text = await readFile(layout.format, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new StorageError('STORAGE_IO', `${layout.format} could not be read`, {
        hint: 'Check the path and that the service user can read the data directory.',
        cause,
      });
    }
    // `12` §3.8.1 step 2. The dangerous case is the second one: data with no marker means this
    // directory belongs to something, and creating a fresh install over it would be the single
    // most destructive thing this product could do.
    return (await hasData(root))
      ? {
          kind: 'occupied',
          reason: `${layout.db} contains data but there is no FORMAT marker`,
        }
      : { kind: 'fresh' };
  }

  return { kind: 'present', format: parseFormat(text, layout.format) };
}

/** Parse and validate `FORMAT`, refusing a version this build cannot read. */
export function parseFormat(text: string, path = 'FORMAT'): DataDirFormat {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new StorageError('STORAGE_CORRUPT', `${path} is not valid JSON`, {
      hint:
        'The marker file is damaged. It is small and safe to inspect — if the data directory is ' +
        'otherwise intact, restore it from a backup rather than deleting it, because a missing ' +
        'marker next to a populated database refuses to start by design.',
      cause,
    });
  }

  // The *version* check comes before the schema, so "this directory is from a newer build" is not
  // reported as "this file is malformed". They need different answers: upgrade, versus restore.
  const declared = (json as { formatVersion?: unknown }).formatVersion;
  if (typeof declared === 'number' && declared > DATA_DIR_FORMAT_VERSION) {
    throw new StorageError(
      'STORAGE_VERSION_UNSUPPORTED',
      `${path} declares format version ${String(declared)}, and this build reads ` +
        String(DATA_DIR_FORMAT_VERSION),
      {
        hint:
          'This data directory was written by a newer version. Upgrade rather than downgrade — ' +
          'an older build cannot safely read a newer layout.',
      },
    );
  }

  const parsed = formatSchema.safeParse(json);
  if (!parsed.success) {
    throw new StorageError(
      'STORAGE_CORRUPT',
      `${path} is not a valid marker: ${parsed.error.issues
        .map((issue) => issue.message)
        .join('; ')}`,
      {
        hint:
          'The marker file is damaged, or this is another application’s directory. Check the ' +
          'configured data directory before doing anything else.',
      },
    );
  }
  return parsed.data;
}

/**
 * Write `FORMAT` atomically: `tmp/` → fsync → rename → fsync the directory.
 *
 * The same sequence `KeyringStore` uses, and for the same reason — a torn `FORMAT` reads as a
 * directory this build did not create, which exits 65. `tmp/` rather than `/tmp` because
 * `rename(2)` is atomic only within a filesystem.
 */
export async function writeFormat(root: string, format: DataDirFormat): Promise<void> {
  const layout = dataDirLayout(root);
  const validated = formatSchema.parse(format);
  const temp = join(layout.tmp, 'FORMAT.tmp');

  await mkdir(layout.tmp, { recursive: true, mode: DIR_MODE });
  await writeFile(temp, `${JSON.stringify(validated, null, 2)}\n`, { mode: FILE_MODE });
  await syncPath(temp);
  await rename(temp, layout.format);
  await syncDirectory(dirname(layout.format));
}

/** A fresh marker for a new install (`12` §4.5). */
export function newFormat(options: {
  readonly instanceId: InstanceId;
  readonly createdBy: string;
  readonly now: Date;
}): DataDirFormat {
  return {
    format: DATA_DIR_FORMAT,
    formatVersion: DATA_DIR_FORMAT_VERSION,
    instanceId: options.instanceId,
    createdAt: options.now.toISOString(),
    createdBy: options.createdBy,
  };
}

/**
 * Record a successful boot (`12` §3.8.1 step 8).
 *
 * Read-modify-write rather than a patch, so `createdAt`, `createdBy` and `instanceId` survive —
 * those three are the identity of the install and must never be rewritten by a boot.
 */
export async function recordBoot(root: string, lastBoot: LastBoot): Promise<DataDirFormat> {
  const state = await readFormat(root);
  if (state.kind !== 'present') {
    throw new StorageError('STORAGE_IO', 'there is no FORMAT marker to record a boot into', {
      hint: 'This is a bug: the boot sequence writes FORMAT before it records a boot.',
      category: 'bug',
    });
  }
  const next: DataDirFormat = { ...state.format, lastBoot };
  await writeFormat(root, next);
  return next;
}

/** Record a clean shutdown, so the next boot can tell a crash from a stop. */
export async function recordCleanShutdown(root: string, at: Date): Promise<void> {
  const state = await readFormat(root);
  if (state.kind !== 'present') return;
  await writeFormat(root, { ...state.format, lastCleanShutdownAt: at.toISOString() });
}

/** Did the last run end cleanly? `false` also when nothing has ever recorded a shutdown. */
export function shutDownCleanly(format: DataDirFormat): boolean {
  if (format.lastCleanShutdownAt === undefined) return false;
  if (format.lastBoot === undefined) return true;
  return Date.parse(format.lastCleanShutdownAt) >= Date.parse(format.lastBoot.at);
}

/** `12` §3.8.1 step 2's "non-empty `db/`" test. */
async function dbDirHasData(root: string): Promise<boolean> {
  const { readdir } = await import('node:fs/promises');
  try {
    return (await readdir(dataDirLayout(root).db)).length > 0;
  } catch {
    // No `db/` at all is the fresh case, not an error: the layout has not been created yet.
    return false;
  }
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  // Read-only: a directory opened `r+` fails with `EISDIR` on Linux, which is the bug the keyring
  // store found the hard way and no in-memory fake would have caught.
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Remove a stale `FORMAT.tmp` left by an interrupted write. Returns whether there was one. */
export async function clearFormatTemp(root: string): Promise<boolean> {
  const temp = join(dataDirLayout(root).tmp, 'FORMAT.tmp');
  try {
    await rm(temp);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new StorageError('STORAGE_IO', `${temp} could not be removed`, { cause });
  }
}
