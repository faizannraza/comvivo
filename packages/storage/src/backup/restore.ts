/**
 * `restoreBackup` and `verifyBackup` — `02` §3.14.4.
 *
 * The eight steps, and the three that are easy to get wrong:
 *
 *  1. Refuse while the server is running (`RESTORE_SERVER_RUNNING`). A restore swaps the database
 *     file under a live process, and SQLite's answer to that is corruption.
 *  2. Unwrap the per-backup DEK from the header — by the current keyring, by the printed recovery
 *     key, or by a passphrase. Failure is `BACKUP_KEY_MISMATCH` and never "the file is damaged":
 *     the two send a host to completely different places.
 *  3. Stream-decrypt into `data/.restore-<ts>/`, **0700**. A missing `TAG_FINAL` or a bad tag is
 *     `BACKUP_INTEGRITY` and the directory is deleted — nothing is swapped in before the last
 *     chunk has authenticated, which is why the extraction goes somewhere else first.
 *  4. Verify the manifest: the snapshot's digest, then open it with the derived `db_key`,
 *     `quick_check`, and row counts equal to the manifest's.
 *  5. Verify the blobs against `blobs.jsonl`. A missing blob is a **warning** unless `strict`,
 *     because an attachment the sender deleted upstream is a normal state and refusing the whole
 *     restore for it would be the wrong trade.
 *  6. `SCHEMA_TOO_NEW` when the archive is from a newer binary. Older is fine: migrations run at
 *     the next start.
 *  7. Swap atomically — the old database moves aside to `pre-restore-<ts>/`, the new one moves in.
 *  8. Record `restored_from` so the next boot can audit it.
 *
 * ## The one thing this module does not do
 *
 * It does not **rekey**. `02` §3.14.4 step 7 says that when the archive's `RDK_g` differs from the
 * current keyring the restored database is rekeyed to the host's `db_key` and the blob DEKs are
 * re-wrapped. That is `08` §3.7.7's `rotate-data` machinery driven backwards, it needs a live
 * `KeyService` and a `blob.rewrap` job, and doing it badly leaves a database nobody can open. What
 * happens instead is explicit: the archive's keyring is written as the host's, which is correct for
 * the two cases that matter in M1 — a restore onto the same host, and a restore onto a fresh one
 * with the recovery key (`01` §14 A10) — and `restoreBackup` reports `keyringImported` so a caller
 * can see which it got. `M8-T25` adds the rekey path with the ops tooling that needs it.
 */
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { BRAND, StorageError } from '@comvivo/shared';
import {
  derivePurposeKey,
  KEY_PURPOSE,
  type SecretStream,
  secureEqual,
  sha256Stream,
} from '@comvivo/shared/crypto';
import { extract as tarExtract } from 'tar-stream';
import { type BackupHeader, openBackup, readBackupHead } from '../crypto/backup-envelope.js';
import { openDatabase } from '../db/open.js';
import { BLOBSTORE_DIR, tableRowCounts } from './create.js';
import {
  type BackupManifest,
  BackupManifestSchema,
  BLOB_INDEX_ENTRY,
  type BlobIndexLine,
  MANIFEST_DB_PATH,
  MANIFEST_ENTRY,
  parseBlobIndex,
  tableCountDifferences,
} from './manifest.js';

/** `02` §3.14.4 step 3's extraction directory, and step 7's set-aside. */
export const RESTORE_DIR_PREFIX = '.restore-';
export const PRE_RESTORE_DIR_PREFIX = 'pre-restore-';

/**
 * How a restore gets its keys.
 *
 * A port, because the key tree lives in `crypto/` and a restore must work in three situations that
 * reach it differently: the host's own keyring, a printed recovery key typed at a prompt, and a
 * passphrase. Injecting the two questions keeps `restore.ts` free of all three and testable with
 * none of them.
 */
export interface RestoreUnlock {
  /**
   * The per-backup DEK, from whichever slot the caller can open.
   *
   * `undefined` means "none of my keys match this archive", which becomes `BACKUP_KEY_MISMATCH`.
   */
  dekFor(header: BackupHeader): Uint8Array | undefined;
  /**
   * The root data key of the archive's current generation, from `keyringSnapshot`.
   *
   * Separate from `dekFor` because they are different keys answering different questions: the DEK
   * decrypts the body, and `RDK_g` is what `db_key` and the blob keys derive from. `01` §14 A10's
   * guarantee is that **one** printed recovery key answers both.
   */
  rootDataKeyFor(
    header: BackupHeader,
  ): { readonly gen: number; readonly key: Uint8Array } | undefined;
}

export interface RestoreOptions {
  readonly archive: string;
  /** The data directory to restore into. May be empty — that is the fresh-host case. */
  readonly dataDir: string;
  readonly unlock: RestoreUnlock;
  readonly stream: SecretStream;
  /** Where the shared blob files are. Defaults to `<dataDir>/backups/blobstore`. */
  readonly blobsFrom?: string | undefined;
  /** `--strict`: a missing blob fails the restore instead of warning. */
  readonly strict?: boolean | undefined;
  /** The binary's own migration ids, newest last, for step 6's comparison. */
  readonly knownMigrationIds: readonly string[];
  /** A stamp for the temporary directories, so two restores cannot collide. */
  readonly stamp: string;
  /** Called with each non-fatal finding. A missing blob is the only one today. */
  readonly warn?: ((code: string, detail: Record<string, string | number>) => void) | undefined;
}

export interface RestoreResult {
  readonly manifest: BackupManifest;
  /** Where the old database was moved, when there was one. */
  readonly preRestoreDir: string | undefined;
  readonly blobsLinked: number;
  readonly blobsMissing: number;
  /** True when the archive's keyring became the host's (see the module header). */
  readonly keyringImported: boolean;
}

function keyMismatch(message: string, hint: string): StorageError {
  return new StorageError('BACKUP_KEY_MISMATCH', message, { hint, category: 'validation.failed' });
}

function integrity(
  message: string,
  hint: string,
  detail?: Readonly<Record<string, string | number | boolean>>,
): StorageError {
  return new StorageError('BACKUP_INTEGRITY', message, {
    hint,
    category: 'io.failed',
    ...(detail === undefined ? {} : { detail }),
  });
}

/** Step 1: the server must not be running. */
export function assertServerStopped(dataDir: string): void {
  const lock = join(dataDir, 'run', `${BRAND.slug}.lock`);
  if (!existsSync(lock)) return;
  throw new StorageError('RESTORE_SERVER_RUNNING', 'the server is running', {
    hint: `Stop it first: \`${BRAND.cliName} stop\`. A restore replaces the database file, and SQLite's answer to that happening underneath a live process is corruption.`,
    category: 'validation.failed',
    detail: { lock },
  });
}

/** Read and parse the archive's header, without decrypting anything. */
export function readArchiveHeader(archive: string): BackupHeader {
  const handle = openSync(archive, 'r');
  try {
    // The head is bounded (`BACKUP_PREFIX_BYTES + BACKUP_HEADER_MAX_BYTES + 24`), so one read of
    // that much is always enough and never large. A streaming parse here would be ceremony.
    const probe = Buffer.alloc(64 * 1024 + 32);
    const read = readSync(handle, probe, 0, probe.length, 0);
    const head = readBackupHead(probe.subarray(0, read));
    if (head === undefined) {
      throw integrity(
        'that archive is shorter than its own header',
        'The file was truncated, most likely by an interrupted copy. Try another archive.',
      );
    }
    return head.header;
  } finally {
    closeSync(handle);
  }
}

/**
 * Steps 2–5: decrypt into a scratch directory and check everything the manifest claims.
 *
 * Returns the scratch directory and the manifest. The caller deletes the directory — `verifyBackup`
 * immediately, `restoreBackup` after the swap — because "who owns the temporary directory" is
 * exactly the kind of thing that leaks a decrypted database into `data/` when it is left implicit.
 */
async function extractAndVerify(options: RestoreOptions): Promise<{
  readonly dir: string;
  readonly manifest: BackupManifest;
  readonly dbKey: Uint8Array | null;
  readonly header: BackupHeader;
}> {
  const header = readArchiveHeader(options.archive);
  const dek = options.unlock.dekFor(header);
  if (dek === undefined) {
    throw keyMismatch(
      'no key opens this archive',
      'None of the slots in this archive matched the keyring, the recovery key or the passphrase. Check that the archive belongs to this instance.',
    );
  }
  const root = options.unlock.rootDataKeyFor(header);
  if (root === undefined) {
    throw keyMismatch(
      "this archive's keyring snapshot could not be unwrapped",
      'The body opened but the keyring snapshot did not, so the database key cannot be derived. This usually means a recovery key from a different generation.',
    );
  }

  const dir = join(options.dataDir, `${RESTORE_DIR_PREFIX}${options.stamp}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    await extractArchive(options, dek, header, dir);
    const manifest = readManifest(dir);
    const dbKey = manifest.db.encrypted
      ? derivePurposeKey(root.key, header.instanceId, KEY_PURPOSE.db)
      : null;
    await verifySnapshot(dir, manifest, dbKey);
    return { dir, manifest, dbKey, header };
  } catch (error) {
    // The directory holds a decrypted database. It goes on **every** failure path, which is why
    // this is a `catch` and not only a `finally` in the caller.
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Step 3: stream the body through tar into `dir`. */
async function extractArchive(
  options: RestoreOptions,
  dek: Uint8Array,
  header: BackupHeader,
  dir: string,
): Promise<void> {
  const extract = tarExtract();
  const writes: Promise<void>[] = [];
  /**
   * The first unsafe entry name, if any — **recorded** rather than thrown from the handler.
   *
   * `next(error)` was the first version and it escaped the consumer loop as an *uncaught
   * exception*: `tar-stream` destroys the stream, the `'error'` event lands on a later tick than
   * the `await done` that was supposed to catch it, and Vitest reported it as an unhandled error
   * after the test had already passed. A refusal that arrives as an uncaught exception is a
   * refusal a caller cannot handle, which for a path-traversal check is the whole point of having
   * one. So the handler discards the entry and the throw happens below, deterministically, with a
   * `BACKUP_INTEGRITY` code rather than a bare `Error`.
   */
  let unsafe: string | undefined;
  /** The first write failure, kept so it is thrown once the extraction has unwound cleanly. */
  let writeFailure: Error | undefined;
  extract.on('entry', (entry, source, next) => {
    const name = entry.name;
    // Path traversal: an archive is a file a host may have fetched from anywhere, and `../` in a
    // tar entry is the oldest trick there is. Checked before any path is joined, and `resume()`
    // discards the body — so nothing is written even for the entry that is refused.
    if (unsafe !== undefined || name.includes('..') || name.startsWith('/')) {
      unsafe ??= name;
      source.resume();
      next();
      return;
    }
    const target = join(dir, name);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    // `next()` on **both** outcomes, and the failure recorded rather than thrown.
    //
    // Before the M1 exit gate the rejection path was missing, and the consequence was worse than a
    // lost error: `next()` was never called, so `tar-stream` stopped consuming, `extract.write`
    // returned `false`, and the `await` on `'drain'` below could never resolve. The loop therefore
    // never reached `Promise.all(writes)`, the rejection went unhandled, and Node 26 ended the
    // process — skipping the `catch` whose whole job is to delete a half-extracted, **decrypted**
    // database. A disk filling up during a restore left one on disk.
    writes.push(
      pipeline(source, createWriteStream(target, { mode: 0o600 })).then(
        () => {
          next();
        },
        (error: unknown) => {
          writeFailure ??= error as Error;
          source.resume();
          next();
        },
      ),
    );
  });

  const done = new Promise<void>((resolve, reject) => {
    extract.on('finish', resolve);
    extract.on('error', reject);
  });

  for await (const piece of openBackup({
    stream: options.stream,
    dek,
    header,
    source: createReadStream(options.archive),
  })) {
    if (writeFailure !== undefined) throw writeFailure;
    if (!extract.write(piece)) {
      await new Promise<void>((resolve, reject) => {
        extract.once('drain', resolve);
        extract.once('error', reject);
      });
    }
  }
  // `end()` with no chunk: `tar-stream`'s extract is a Writable whose types require an argument,
  // so the empty buffer is the way to say "no more input".
  extract.end(Buffer.alloc(0));
  await done;
  await Promise.all(writes);
  if (writeFailure !== undefined) throw writeFailure;
  if (unsafe !== undefined) {
    throw integrity(
      'that archive contains an entry whose name escapes the extraction directory',
      'A `../` or absolute path in a tar entry is how an archive overwrites files outside itself. Nothing was extracted; do not trust this file.',
      { entry: unsafe },
    );
  }
}

function readManifest(dir: string): BackupManifest {
  const path = join(dir, MANIFEST_ENTRY);
  if (!existsSync(path)) {
    throw integrity(
      `that archive has no ${MANIFEST_ENTRY}`,
      'The body decrypted, so the key is right and the contents are not what this version writes.',
    );
  }
  const parsed = BackupManifestSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw integrity(
      `that archive's ${MANIFEST_ENTRY} is not a manifest this version understands`,
      parsed.error.issues[0]?.message ?? 'Check whether it was written by a newer build.',
    );
  }
  return parsed.data;
}

/** Step 4: the digest, then the database itself. */
async function verifySnapshot(
  dir: string,
  manifest: BackupManifest,
  dbKey: Uint8Array | null,
): Promise<void> {
  const path = join(dir, MANIFEST_DB_PATH);
  if (!existsSync(path)) {
    throw integrity(`that archive has no ${MANIFEST_DB_PATH}`, 'The archive is incomplete.');
  }
  const hash = sha256Stream();
  for await (const piece of createReadStream(path)) hash.update(piece as Uint8Array);
  const digest = hash.digest().toString('hex');
  // `secureEqual`, not `!==`: `comvivo/no-secret-equality` reported this, and converting it is the
  // right answer rather than a suppression. The timing of an integrity check on a file the caller
  // already holds leaks nothing, but the rule is not asked to know that — and a constant-time
  // comparison of two 64-character hex strings costs one SHA-256 per restore.
  if (!secureEqual(digest, manifest.db.sha256)) {
    // The body authenticated and the file still is not the one that was written: a tar entry that
    // unpacked short, or a filesystem that lied about a write. The AEAD cannot see either.
    throw integrity(
      'the restored database does not match the digest in the manifest',
      'The archive decrypted but its contents are not what was backed up. Try another archive.',
      { expected: manifest.db.sha256, actual: digest },
    );
  }

  const opened = openDatabase({
    path,
    key: dbKey === null ? null : Buffer.from(dbKey),
    readonly: true,
    role: 'cli',
    loadVec: false,
  });
  try {
    const check = opened.db.pragma('quick_check', { simple: true });
    if (check !== 'ok') {
      throw integrity('the restored database failed quick_check', 'The archive is damaged.', {
        result: String(check),
      });
    }
    const restored = tableRowCounts(opened.db);
    const differences = tableCountDifferences(manifest.tables, restored.counts, [
      ...(manifest.tablesSkipped ?? []),
      ...restored.skipped,
    ]);
    if (differences.length > 0) {
      // Named, not counted: "17 tables differ" is unactionable, and which tables are short is the
      // difference between "you have lost your messages" and "you have lost a cache".
      throw integrity(
        'the restored database has different row counts from the manifest',
        'The archive is incomplete. Try another one, or run with `--strict` off to see the detail.',
        {
          tables: differences
            .slice(0, 8)
            .map((d) => `${d.table}: ${String(d.expected)}≠${String(d.actual)}`)
            .join(', '),
          differing: differences.length,
        },
      );
    }
  } finally {
    opened.db.close();
  }
}

/** Step 5: every blob the index names must exist, with the right size. */
function verifyBlobs(
  options: RestoreOptions,
  dir: string,
  manifest: BackupManifest,
): { linked: number; missing: number; lines: readonly BlobIndexLine[] } {
  const indexPath = join(dir, BLOB_INDEX_ENTRY);
  const lines = existsSync(indexPath) ? parseBlobIndex(readFileSync(indexPath, 'utf8')) : [];
  const from =
    manifest.blobs.mode === 'embedded'
      ? join(dir, 'blobs')
      : (options.blobsFrom ?? join(options.dataDir, 'backups', BLOBSTORE_DIR));

  let linked = 0;
  let missing = 0;
  for (const line of lines) {
    const path = join(from, `${line.addr}.vblob`);
    let bytes: number | undefined;
    try {
      bytes = statSync(path).size;
    } catch {
      bytes = undefined;
    }
    if (bytes === line.sizeEnc) {
      linked += 1;
      continue;
    }
    missing += 1;
    if (options.strict === true) {
      throw new StorageError('BLOB_MISSING_FILE', 'a blob this archive references is missing', {
        hint: `Point \`--blobs-from\` at the directory holding the \`.vblob\` files, or drop \`--strict\` to restore without them.`,
        category: 'io.failed',
        detail: { addr: line.addr, expected: line.sizeEnc, found: bytes ?? -1 },
      });
    }
    // A warning, not a failure: an attachment whose file is gone is a message with a broken
    // picture, and refusing the whole restore for it would lose the other 50 000 messages too.
    options.warn?.('BLOB_MISSING_FILE', { addr: line.addr, expected: line.sizeEnc });
  }
  return { linked, missing, lines };
}

/** Step 6: an archive from a newer binary cannot be restored by this one. */
function assertSchemaKnown(manifest: BackupManifest, known: readonly string[]): void {
  if (known.includes(manifest.schema.lastMigrationId)) return;
  if (manifest.schema.migrationCount <= known.length) {
    // Fewer migrations than we know and an id we do not: a different *lineage*, not a newer one.
    throw integrity(
      "that archive's schema history does not match this build's",
      'The archive may be from a different product line. Check the instance id in the header.',
      { lastMigrationId: manifest.schema.lastMigrationId },
    );
  }
  throw new StorageError('SCHEMA_TOO_NEW', 'that archive is from a newer version', {
    hint: `Upgrade ${BRAND.displayName} to at least the version that wrote it, then restore. Migrations are forward-only, so this build cannot read it.`,
    category: 'validation.failed',
    detail: {
      archiveMigrations: manifest.schema.migrationCount,
      knownMigrations: known.length,
      lastMigrationId: manifest.schema.lastMigrationId,
    },
  });
}

/**
 * `village backup verify <file>`: steps 2–5 into a temporary directory, then delete it.
 *
 * The same code path as a restore, deliberately. A verification that used its own reader would
 * answer a question about itself — and this is the command a host runs to find out whether their
 * backups are real, so it has to be the restore that answers.
 */
export async function verifyBackup(options: RestoreOptions): Promise<BackupManifest> {
  const { dir, manifest } = await extractAndVerify(options);
  try {
    verifyBlobs(options, dir, manifest);
    assertSchemaKnown(manifest, options.knownMigrationIds);
    return manifest;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The whole of `02` §3.14.4. */
export async function restoreBackup(options: RestoreOptions): Promise<RestoreResult> {
  assertServerStopped(options.dataDir);
  const { dir, manifest, header, dbKey } = await extractAndVerify(options);
  try {
    const blobs = verifyBlobs(options, dir, manifest);
    assertSchemaKnown(manifest, options.knownMigrationIds);

    // Step 8 **before** step 7, which `02` §3.14.4 numbers the other way round and which is the
    // safer order: the row goes into the extracted file, so a failure here — a database with no
    // `app_meta`, a disk that filled — aborts with nothing moved. Writing it after the swap would
    // leave a host holding a restored database *and* an error, which is the one outcome a restore
    // must not produce. The effect is identical: it is the same file either way.
    recordRestoredFrom(join(dir, MANIFEST_DB_PATH), manifest, dbKey);

    // From here the live database has been moved. A failure after this point used to leave the
    // host with **no** `db/comvivo.db` and a raw errno that never mentioned where the old one
    // went — the comment above reasons carefully about failures *before* the first rename and had
    // nothing to say about these. So the swap puts the old files back, and if even that fails the
    // error names the directory holding them. Found by the M1 exit gate's reviewer.
    const preRestoreDir = setAsideExistingDb(options);
    let keyringImported: boolean;
    try {
      mkdirSync(join(options.dataDir, 'db'), { recursive: true, mode: 0o700 });
      renameSync(join(dir, MANIFEST_DB_PATH), join(options.dataDir, 'db', `${BRAND.slug}.db`));
      keyringImported = writeKeyringFromArchive(options, header);
    } catch (cause) {
      throw restoreSwapFailed(options, preRestoreDir, cause);
    }

    return {
      manifest,
      preRestoreDir,
      blobsLinked: blobs.linked,
      blobsMissing: blobs.missing,
      keyringImported,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Put the host's own database back, and say where it is either way.
 *
 * The one outcome a restore must not produce is a host with no database at all. If the files can
 * be moved back, the instance is exactly as it was and the error is about the archive; if they
 * cannot, the hint names the directory they are in, because a path in an error message is the
 * difference between a recoverable afternoon and a lost one.
 */
function restoreSwapFailed(
  options: RestoreOptions,
  preRestoreDir: string | undefined,
  cause: unknown,
): StorageError {
  if (preRestoreDir === undefined) {
    return new StorageError('BACKUP_INTEGRITY', 'the restored database could not be put in place', {
      hint:
        'Nothing was moved, so the instance is unchanged. Check free disk space and the ' +
        'permissions on the data directory, then try again.',
      category: 'io.failed',
      cause,
    });
  }
  const dbDir = join(options.dataDir, 'db');
  let restored = true;
  for (const suffix of ['', '-wal', '-shm']) {
    const from = join(preRestoreDir, `${BRAND.slug}.db${suffix}`);
    if (!existsSync(from)) continue;
    try {
      renameSync(from, join(dbDir, `${BRAND.slug}.db${suffix}`));
    } catch {
      restored = false;
    }
  }
  return new StorageError(
    'BACKUP_INTEGRITY',
    restored
      ? 'the restored database could not be put in place; your own database was put back'
      : 'the restored database could not be put in place, and your own could not be put back',
    {
      hint: restored
        ? 'The instance is as it was before the restore. Check free disk space and the ' +
          'permissions on the data directory, then try again.'
        : `Your database is in ${preRestoreDir}. Move its files back into ${dbDir} before ` +
          'starting again — nothing was deleted.',
      category: 'io.failed',
      detail: { preRestoreDir },
      cause,
    },
  );
}

/**
 * Step 7's first half: move the existing database aside rather than deleting it.
 *
 * A restore is the most destructive thing a host can do, and the one they are most likely to do by
 * mistake — `village restore` with the wrong archive, at two in the morning, after a scare. The
 * old files are still there afterwards, under a stamped directory, and `09`'s CLI prints where.
 */
function setAsideExistingDb(options: RestoreOptions): string | undefined {
  const dbDir = join(options.dataDir, 'db');
  const live = join(dbDir, `${BRAND.slug}.db`);
  if (!existsSync(live)) return undefined;
  const aside = join(options.dataDir, `${PRE_RESTORE_DIR_PREFIX}${options.stamp}`);
  mkdirSync(aside, { recursive: true, mode: 0o700 });
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${live}${suffix}`;
    if (existsSync(from)) renameSync(from, join(aside, `${BRAND.slug}.db${suffix}`));
  }
  return aside;
}

/**
 * Step 7's second half: the archive's keyring becomes the host's.
 *
 * Correct for the two cases M1 has: a restore onto the same host (where it is a no-op in content)
 * and a restore onto a fresh one with the recovery key, which is `01` §14 A10's guarantee. The
 * **rekey** path — when the host already has a different `RDK_g` and wants to keep it — is
 * `M8-T25`'s, and the module header says why it is not attempted here.
 */
function writeKeyringFromArchive(options: RestoreOptions, header: BackupHeader): boolean {
  const keysDir = join(options.dataDir, 'keys');
  mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  const path = join(keysDir, 'keyring.json');
  const keyring = {
    format: `${BRAND.slug}-keyring/1`,
    instanceId: header.instanceId,
    current: header.dataGen,
    wrapCount: 0,
    generations: header.keyringSnapshot.generations.map((generation) => ({
      gen: generation.gen,
      status: generation.gen === header.dataGen ? 'active' : 'retired',
      createdAt: header.createdAt,
      slots: generation.slots,
    })),
    static: header.keyringSnapshot.static,
  };
  // Synchronous, and the first version was not: a `createWriteStream(...).end(...)` returns before
  // the bytes are on disk, so the caller's own `existsSync` saw nothing and a test's cleanup
  // deleted the directory under the pending write — which surfaced as an **unhandled** ENOENT
  // rather than as a failure anyone could trace. A restore's last act is not a place for a race.
  //
  // `flag: 'wx'` — **exclusive create**, which is how "do not overwrite an existing keyring" stops
  // being advisory. An `existsSync` before the write was the same intent with a window in it: a
  // keyring created between the check and the write would have been silently replaced, and that is
  // the one failure from which a host has no recovery. `EEXIST` is the answer to the question the
  // check was asking, so it is handled rather than raised. Found by CodeQL at the M1 exit gate.
  try {
    writeFileSync(path, `${JSON.stringify(keyring, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      // A host restoring onto their own machine keeps the keyring they can already unlock.
      return false;
    }
    throw cause;
  }
  return true;
}

/**
 * Step 8: `app_meta('restored_from')`, so the next boot can audit it.
 *
 * Written into the **extracted** database, before the swap — the caller says why that ordering is
 * safer than the spec's. `09`'s boot reads the row, writes the `_instance` audit event and clears
 * it; this module does not write the audit row itself, because an audit event belongs to the
 * transaction that acts on it and a restore has no transaction.
 */
function recordRestoredFrom(
  path: string,
  manifest: BackupManifest,
  dbKey: Uint8Array | null,
): void {
  const opened = openDatabase({
    path,
    key: dbKey === null ? null : Buffer.from(dbKey),
    role: 'cli',
    loadVec: false,
  });
  try {
    // Ids and a timestamp, never a path: a filesystem path in a database row is a path that leaks
    // a host's directory layout into every export and every support transcript.
    opened.db
      .prepare(
        `INSERT INTO app_meta (key, value, updated_at) VALUES ('restored_from', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(
        JSON.stringify({
          instanceId: manifest.instanceId,
          createdAt: manifest.createdAt,
          appVersion: manifest.app.version,
        }),
        Date.now(),
      );
  } finally {
    opened.db.close();
  }
}
