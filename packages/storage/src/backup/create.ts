/**
 * `createBackup` — `02` §3.14.1's snapshot pipeline.
 *
 * The six steps, in the order the spec gives them and for the reasons it gives:
 *
 *  1. `VACUUM INTO` a temporary snapshot. A consistent WAL snapshot that does not block the writer
 *     beyond normal WAL semantics, and — measured at `M1-T2`, SP-3 — **encrypted with the same
 *     key**, which is why `01` §14 A8's online-backup-API fallback is not needed.
 *  2. `quick_check` the snapshot, **with that key**. Anything but `ok` aborts: an archive of a
 *     corrupt database is worse than no archive, because it looks like a rollback path.
 *  3. Build the manifest, including per-table row counts and the snapshot's digest.
 *  4. Copy the referenced blob files into the shared `blobstore/`, hardlinking when the filesystem
 *     allows. They are already encrypted and immutable, so sharing them between archives is free.
 *  5. Stream `tar(manifest.json, blobs.jsonl, db/comvivo.db)` through the `VBK1` envelope into
 *     `<name>.vbak.part`, then fsync, rename and unlink the snapshot.
 *  6. Rotate: keep the newest `backups.keep` archives.
 *
 * ## No plaintext ever touches disk
 *
 * `08` §3.7.11 states it and the acceptance criterion tests it with a filesystem spy. Three things
 * make it true, and all three are easy to lose:
 *
 *  - the snapshot is encrypted by SQLite itself, not by us;
 *  - the tar is built **streaming** into the envelope, so the archive's plaintext exists only in
 *    64 KiB chunks in memory — there is no intermediate `.tar` file;
 *  - the manifest and the blob index go into the tar as in-memory buffers.
 *
 * The temporary snapshot is the one file written outside the archive, and it is ciphertext.
 *
 * ## Why the body is written to `.part` and renamed
 *
 * A half-written `.vbak` that a later `backup list` believes in is a rollback path that does not
 * exist. The rename is atomic within a directory, so an archive is either absent or complete, and
 * the directory `fsync` after it is what makes that survive a power cut (the same discipline as
 * `02` §3.11's blob writes).
 */
import {
  closeSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { BRAND, StorageError } from '@comvivo/shared';
import { type SecretStream, sha256Stream } from '@comvivo/shared/crypto';
import type Database from 'better-sqlite3-multiple-ciphers';
import { pack as tarPack } from 'tar-stream';
import { type BackupHeader, sealBackup } from '../crypto/backup-envelope.js';
import { openDatabase } from '../db/open.js';
import {
  BACKUP_MANIFEST_FORMAT,
  type BackupManifest,
  BLOB_INDEX_ENTRY,
  type BlobIndexLine,
  encodeBlobIndex,
  MANIFEST_DB_PATH,
  MANIFEST_ENTRY,
} from './manifest.js';

/** `.vbak`, per `08` §3.7.11. The in-progress name carries `.part` until the rename. */
export const ARCHIVE_EXTENSION = '.vbak';
export const PART_EXTENSION = '.part';

/** A stored blob file, as the archive needs to see it. */
export interface BlobFileRef extends BlobIndexLine {
  /** Absolute path in `data/blobs`. */
  readonly path: string;
}

export interface CreateBackupOptions {
  /** The live connection. Read-only here: the snapshot comes from `VACUUM INTO`. */
  readonly db: Database.Database;
  /** The key `db` is open under, so the snapshot can be `quick_check`ed. */
  readonly key: Buffer | null;
  /** `<dataDir>/backups`. The archive lands in `<backupDir>/<tier>`. */
  readonly backupDir: string;
  readonly tier: 'daily' | 'weekly' | 'monthly' | 'manual';
  readonly stream: SecretStream;
  /** The per-backup DEK, already wrapped into every slot of `header`. */
  readonly dek: Uint8Array;
  /** The envelope header, built by the caller because only it holds the keys (`08` §3.7.11). */
  readonly header: BackupHeader;
  readonly manifest: Omit<BackupManifest, 'db' | 'tables' | 'blobs'>;
  /** Every blob the database references, with its path on disk. */
  readonly blobs: readonly BlobFileRef[];
  /** `shared` puts the files in `blobstore/`; `embedded` also tars them (`--portable`). */
  readonly blobMode: 'shared' | 'embedded';
  /** `backups.keep`. Older archives in the same tier are removed afterwards. */
  readonly keep: number;
}

export interface CreateBackupResult {
  readonly path: string;
  readonly manifest: BackupManifest;
  /** The archive's size on disk. */
  readonly bytes: number;
  /** Blob files copied into `blobstore/` this run; the rest were already there. */
  readonly blobsCopied: number;
  /** Archives removed by the rotation. */
  readonly pruned: readonly string[];
}

/** Quote a path for `VACUUM INTO`. Single quotes doubled, as SQLite requires. */
function quote(path: string): string {
  return `'${path.replaceAll("'", "''")}'`;
}

/**
 * `02` §3.14.1's name: `village-<instanceId>-<YYYYMMDDTHHmmssZ>.vbak`.
 *
 * `08` §3.7.11 says "filenames carry no sensitive metadata" and gives the first six characters of
 * the instance id, which is the stronger reading — a full id in a filename copied to cloud storage
 * identifies the instance across every archive. Six characters of a TypeID suffix is enough to
 * tell two instances' archives apart in one directory and not enough to be a fingerprint.
 */
export function archiveName(instanceId: string, createdAt: string): string {
  const stamp = createdAt.replaceAll(/[-:]/g, '').replace(/\.\d+/, '');
  // `at(-1)` rather than `includes('_') ? split('_')[1] : id`: the conditional had a `?? id`
  // fallback that nothing could reach — when the id contains `_`, `split('_')[1]` is a string — and
  // an unreachable fallback is a branch no test can cover and nobody has proven works.
  const suffix = instanceId.split('_').at(-1) ?? instanceId;
  return `village-${suffix.slice(0, 6)}-${stamp}${ARCHIVE_EXTENSION}`;
}

/** Row counts for every real table, which is `02` §3.14.3's `tables`. */
export interface TableRowCounts {
  readonly counts: Record<string, number>;
  /**
   * Tables whose `count(*)` the build refused.
   *
   * Carried rather than dropped: both sides of a restore compare counts, and a table counted on
   * one side and skipped on the other reads as a row-count mismatch — which refuses a sound
   * archive. `tableCountDifferences` ignores a name either side skipped.
   */
  readonly skipped: readonly string[];
}

export function tableRowCounts(db: Database.Database): TableRowCounts {
  const names = (
    db
      .prepare(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  const counts: Record<string, number> = {};
  const skipped: string[] = [];
  for (const name of names) {
    // Virtual tables and their shadows are included deliberately: a restore that lost an FTS
    // index's contents would otherwise pass every check and answer no searches. A table a
    // `count(*)` cannot be run on is skipped rather than failing the backup — `vec0` refuses one
    // on some builds, and a backup is not the place to discover that.
    try {
      const row = db.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get() as {
        n: number;
      };
      counts[name] = row.n;
    } catch {
      // **Skipped, and named.** The skip itself is right — a `count(*)` a `vec0` build refuses
      // must not fail a backup — but dropping the name made a *sound* archive un-restorable: a
      // table whose count failed here and succeeded at restore time became `expected 0 ≠ actual
      // N` in `tableCountDifferences`, and `restoreBackup` refuses the archive with "the restored
      // database has different row counts from the manifest". The reason had been discarded in an
      // empty block. Found by the M1 exit gate's reviewer.
      skipped.push(name);
    }
  }
  return { counts, skipped };
}

/**
 * Hash a file without reading it into memory.
 *
 * A plain `for await` over the read stream rather than a `pipeline`: there is no destination here,
 * the digest *is* the output, and a `pipeline` with a draining sink was three lines of ceremony
 * saying the same thing.
 */
async function digestOf(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = sha256Stream();
  for await (const piece of createReadStream(path)) hash.update(piece as Uint8Array);
  return { sha256: hash.digest().toString('hex'), bytes: statSync(path).size };
}

/**
 * Copy a blob into the shared store if it is not there already.
 *
 * A hardlink first, because the files are immutable and content-addressed: fourteen daily archives
 * of a 2 GB blob store then cost 2 GB rather than 28 GB. A cross-device link fails with `EXDEV`,
 * which is the normal case for a `backups/` on its own mount, and the copy is the fallback.
 */
function copyIfAbsent(from: string, to: string): boolean {
  try {
    statSync(to);
    return false;
  } catch {
    // Not there; fall through to the link.
  }
  try {
    linkSync(from, to);
    return true;
  } catch {
    // Any failure falls through to the copy, and the copy reports its own. The first version
    // filtered on `EXDEV`/`EPERM`/`ENOTSUP` and rethrew anything else, which added three branches
    // no test could reach and hid nothing: a genuine problem — no space, no permission — fails the
    // `copyFileSync` below with the same errno and a clearer operation.
  }
  // `copyFileSync` rather than a stream: a blob is at most `blobs.maxBytes` (50 MiB) and the copy
  // is one syscall the kernel can do with `copy_file_range`.
  copyFileSync(from, to);
  return true;
}

export const BLOBSTORE_DIR = 'blobstore';

/** Keep the newest `keep` archives in one tier, removing the rest. Returns what went. */
export function pruneArchives(directory: string, keep: number): readonly string[] {
  if (keep < 0) return [];
  let entries: readonly string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  const archives = entries
    .filter((name) => name.endsWith(ARCHIVE_EXTENSION))
    .map((name) => ({ name, mtime: statSync(join(directory, name)).mtimeMs }))
    // Newest first, by **modification time** rather than by name: the name carries a timestamp, but
    // a clock that moved backwards would then evict the newest archive, which is the one a host
    // actually wants (the same reasoning as `pruneOldBackups` in `migrate/backup.ts`).
    .toSorted((left, right) => right.mtime - left.mtime);
  const doomed = archives.slice(keep);
  for (const archive of doomed) unlinkSync(join(directory, archive.name));
  return doomed.map((archive) => archive.name);
}

/**
 * `fsync` a directory, so a rename survives a power cut.
 *
 * The rename is atomic within a directory, which makes an archive either absent or complete — but
 * atomicity is about ordering, not durability: without this, a power cut can leave the directory
 * entry unwritten and the archive gone. The same discipline as `02` §3.11's blob writes.
 */
function fsyncDir(path: string): void {
  const handle = openSync(path, 'r');
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

export async function createBackup(options: CreateBackupOptions): Promise<CreateBackupResult> {
  const tierDir = join(options.backupDir, options.tier);
  const tmpDir = join(options.backupDir, '.tmp');
  mkdirSync(tierDir, { recursive: true, mode: 0o700 });
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });

  const stamp = options.manifest.createdAt.replaceAll(/[-:.]/g, '');
  const snapshot = join(tmpDir, `snap-${stamp}.db`);
  /** The `.part` this call is writing, so the `finally` can remove exactly it. */
  let partial: string | undefined;
  try {
    // Step 1. `VACUUM INTO` refuses to overwrite, which is what we want: a name collision means
    // two backups started in the same instant and silently replacing one would be a lie.
    options.db.exec(`VACUUM INTO ${quote(snapshot)}`);

    // Step 2. With the key — the snapshot is encrypted (SP-3), so a keyless open throws
    // `SQLITE_NOTADB` and the check would never run. `M1-T14`'s version of this had that bug.
    assertSnapshotSound(snapshot, options.key);

    // Step 3.
    const digest = await digestOf(snapshot);
    const counted = tableRowCounts(options.db);
    const manifest: BackupManifest = {
      ...options.manifest,
      db: {
        path: MANIFEST_DB_PATH,
        bytes: digest.bytes,
        sha256: digest.sha256,
        encrypted: options.key !== null,
        quickCheck: 'ok',
      },
      tables: counted.counts,
      ...(counted.skipped.length === 0 ? {} : { tablesSkipped: [...counted.skipped] }),
      blobs: {
        mode: options.blobMode,
        count: options.blobs.length,
        bytes: options.blobs.reduce((sum, blob) => sum + blob.sizeEnc, 0),
        index: BLOB_INDEX_ENTRY,
      },
      format: BACKUP_MANIFEST_FORMAT,
      formatVersion: 1,
    };

    // Step 4.
    const blobsCopied = copyBlobs(options);

    // Step 5.
    const name = archiveName(options.manifest.instanceId, options.manifest.createdAt);
    const part = join(tierDir, `${name}${PART_EXTENSION}`);
    const final = join(tierDir, name);
    partial = part;
    await writeArchive({ ...options, manifest, snapshot, part });
    renameSync(part, final);
    partial = undefined;
    fsyncDir(tierDir);

    // Step 6.
    const pruned = pruneArchives(tierDir, options.keep);
    return {
      path: final,
      manifest,
      bytes: statSync(final).size,
      blobsCopied,
      pruned,
    };
  } finally {
    // The snapshot goes whatever happened: it is a full copy of the database, and leaving one
    // behind on every failure fills `backups/.tmp` with ciphertext nobody will ever read.
    rmSync(snapshot, { force: true });
    // And so does **this call's own** `.part`, if the rename never claimed it. `pruneArchives`
    // filters on `.vbak`, which a `.vbak.part` does not satisfy, and nothing else swept them — so
    // every failed backup left a partial archive in the tier directory for ever. Only this one:
    // scanning the directory would delete a concurrent backup's file out from under it. Found by
    // the M1 exit gate's reviewer.
    if (partial !== undefined) rmSync(partial, { force: true });
  }
}

/** `quick_check` the snapshot under its own key. Anything but `ok` aborts the backup. */
function assertSnapshotSound(path: string, key: Buffer | null): void {
  const opened = openDatabase({ path, key, readonly: true, role: 'cli', loadVec: false });
  try {
    const result = opened.db.pragma('quick_check', { simple: true });
    if (result !== 'ok') {
      throw new StorageError('BACKUP_INTEGRITY', 'the snapshot failed quick_check', {
        hint:
          'The database was already damaged when the backup was taken, so this archive would ' +
          `preserve the damage. Run \`${BRAND.cliName} doctor --deep\` before backing up again.`,
        detail: { result: String(result) },
      });
    }
  } finally {
    opened.db.close();
  }
}

/** Step 4: the shared blob store, or nothing when the archive embeds them. */
function copyBlobs(options: CreateBackupOptions): number {
  if (options.blobMode === 'embedded') return 0;
  const store = join(options.backupDir, BLOBSTORE_DIR);
  mkdirSync(store, { recursive: true, mode: 0o700 });
  let copied = 0;
  for (const blob of options.blobs) {
    if (copyIfAbsent(blob.path, join(store, `${blob.addr}.vblob`))) copied += 1;
  }
  return copied;
}

interface WriteArchiveOptions extends CreateBackupOptions {
  readonly manifest: BackupManifest;
  readonly snapshot: string;
  readonly part: string;
}

/**
 * Step 5: tar → envelope → file, streaming.
 *
 * The tar is produced by `tar-stream` and consumed by `sealBackup` as an async iterable, so no
 * intermediate `.tar` exists anywhere — which is what makes `08` §3.7.11's "no plaintext ever
 * touches disk" true rather than aspirational.
 */
async function writeArchive(options: WriteArchiveOptions): Promise<void> {
  const pack = tarPack();
  const out = createWriteStream(options.part, { mode: 0o600 });

  const manifestJson = Buffer.from(JSON.stringify(options.manifest, null, 2), 'utf8');
  const blobIndex = Buffer.from(encodeBlobIndex(options.blobs), 'utf8');

  // An `'error'` listener before anything is written, and a drain that can reject: without them
  // `ENOSPC` mid-archive either hung the backup forever (the drain promise had no reject path) or
  // threw an unhandled `'error'`. Found by the M1 exit gate's reviewer.
  let streamFailure: Error | undefined;
  out.on('error', (error: Error) => {
    streamFailure ??= error;
  });

  // Entries are added as the pack is consumed, not before: `tar-stream` applies backpressure, so
  // adding a 5 GB entry up front would buffer it.
  //
  // `.catch` on the handle, not on the `await` below: if `sealBackup` throws, `await fill` is never
  // reached, and an abandoned rejected promise **ends the process** on Node 26 — after the caller
  // has already caught and reported the real error. Measured at the M1 exit gate: the caller's
  // message printed, then the process died ten milliseconds later with the abandoned one.
  let fillFailure: Error | undefined;
  const fill = (async () => {
    pack.entry({ name: MANIFEST_ENTRY, size: manifestJson.length, mode: 0o600 }, manifestJson);
    pack.entry({ name: BLOB_INDEX_ENTRY, size: blobIndex.length, mode: 0o600 }, blobIndex);
    await addFile(pack, MANIFEST_DB_PATH, options.snapshot);
    if (options.blobMode === 'embedded') {
      for (const blob of options.blobs) {
        await addFile(pack, `blobs/${blob.addr}.vblob`, blob.path);
      }
    }
    pack.finalize();
  })().catch((error: unknown) => {
    fillFailure = error as Error;
    // Destroying the pack unblocks `sealBackup`, which is reading from it: without this the seal
    // would wait for bytes that are never coming.
    pack.destroy(error as Error);
  });

  await sealBackup({
    stream: options.stream,
    dek: options.dek,
    header: options.header,
    source: pack as unknown as AsyncIterable<Uint8Array>,
    write: async (piece) => {
      if (streamFailure !== undefined) throw streamFailure;
      if (!out.write(piece)) {
        await new Promise<void>((resolve, reject) => {
          out.once('drain', resolve);
          out.once('error', reject);
        });
      }
    },
  });
  await fill;
  if (fillFailure !== undefined) throw fillFailure;
  if (streamFailure !== undefined) throw streamFailure;
  await new Promise<void>((resolve, reject) => {
    out.end((error?: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** Stream one file into the tar, so its size never costs memory. */
async function addFile(
  pack: ReturnType<typeof tarPack>,
  name: string,
  path: string,
): Promise<void> {
  const size = statSync(path).size;
  const entry = pack.entry({ name, size, mode: 0o600 });
  await pipeline(createReadStream(path), entry);
}
