/**
 * Atomic file replacement: write a temp file, fsync it, rename it over the target, fsync the
 * directory (`12` §4.5).
 *
 * `rename(2)` within a filesystem is atomic, so a concurrent reader sees either the whole old file
 * or the whole new one — never a partial write. That property is the reason this exists, and it is
 * load-bearing in two places for different reasons:
 *
 *  - **`FORMAT`** (`12` §4.5) must survive a power cut: a torn marker makes the data directory
 *    unidentifiable, which `12` treats as exit 78.
 *  - **the instance lock** (`12` §3.7) must survive being *read* mid-write. This one was a plain
 *    `writeFile` over the live lock, and the consequence is sharper than it looks: a second process
 *    reading the lock while the holder's heartbeat is part-written sees unparseable JSON,
 *    `readLock` reports unparseable as **absent**, and `acquireLock` then replaces it with no
 *    liveness check — so two processes both believe they hold the lock. That is the two-writer
 *    state invariant **C1** exists to prevent, reached without either process doing anything
 *    wrong. Found by the M1 independent review.
 *
 * The fsyncs are what make it durable rather than merely atomic. `syncDirectory` opens the
 * directory **read-only**: `r+` fails with `EISDIR` on Linux, which the keyring store found the
 * hard way and which no in-memory fake would have caught.
 */
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { DIR_MODE, FILE_MODE } from './layout.js';

/** fsync one file, so its contents are on the device and not only in the page cache. */
export async function syncPath(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * fsync a directory, so a rename into it survives a power cut.
 *
 * Read-only: a directory opened `r+` fails with `EISDIR` on Linux.
 */
export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface AtomicWriteOptions {
  /**
   * Where to put the temp file. Defaults to beside the target.
   *
   * `rename` is only atomic **within one filesystem**, so beside the target is the one location
   * that is always safe — a data directory on a separate mount from `os.tmpdir()` is the normal
   * arrangement rather than the exception.
   *
   * `FORMAT` passes `tmp/FORMAT.tmp` explicitly, because that path is part of its own contract:
   * `clearFormatTemp` exists to remove a stale one, and it has to know where to look. That
   * directory is inside the data directory, so the same-filesystem requirement still holds.
   */
  readonly tempPath?: string;
}

/**
 * Replace `path` with `contents`, atomically.
 *
 * A failure anywhere before the rename leaves the existing file untouched, which is the other half
 * of the guarantee — a half-written heartbeat must not destroy the lock it was refreshing.
 */
export async function writeFileAtomic(
  path: string,
  contents: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  // The pid **and the basename** in the default name. The pid alone made the temp file per
  // process per *directory*, so two `writeFileAtomic` calls to different files in one directory
  // from one process would share it and one rename would steal the other's bytes — which is
  // exactly the torn write this function exists to prevent. Not reachable today (only `lock.ts`
  // uses the default, and role locks live in the same `run/` directory), which is why it is worth
  // closing now rather than after it is. Found by the M1 exit gate's reviewer.
  const temp =
    options.tempPath ?? join(dirname(path), `.${basename(path)}.${process.pid.toString(36)}.tmp`);
  await mkdir(dirname(temp), { recursive: true, mode: DIR_MODE });
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
  try {
    await writeFile(temp, contents, { mode: FILE_MODE });
    await syncPath(temp);
    await rename(temp, path);
  } catch (cause) {
    // The temp goes with the failure. Without this a failed write left `.<name>.<pid>.tmp` behind
    // for a reader to wonder about during an emergency, and nothing ever cleaned it up.
    await rm(temp, { force: true }).catch(() => undefined);
    throw cause;
  }
  await syncDirectory(dirname(path));
}
