/**
 * The failure paths of `createBackup` and `restoreBackup` (`M1-T27`; `02` §3.14.1, §3.14.4).
 *
 * The roundtrip suite shows the pipeline working. This one shows it refusing, which is the half a
 * host meets on the worst day of their year — and the half where a wrong answer is expensive: a
 * restore that proceeds past a check it should have failed leaves a database nobody can trust, and
 * one that fails a check it should have passed leaves a host without their data at all.
 *
 * Each case names the mechanism, because the mechanisms are not interchangeable. A digest mismatch
 * and a `quick_check` failure both mean "the archive is bad" and point at completely different
 * causes: the first is a transport or filesystem fault after the backup, the second is damage that
 * predates it.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '@comvivo/shared';
import {
  AAD,
  BACKUP_MANIFEST_FORMAT,
  derivePurposeKey,
  KEY_PURPOSE,
  unwrap,
  wrappersSecretStream,
} from '@comvivo/shared/crypto';
import { pack as tarPack } from 'tar-stream';
import { afterEach, describe, expect, it } from 'vitest';
import { sealBackup } from '../crypto/backup-envelope.js';
import { openDatabase } from '../db/open.js';
import { archiveName, createBackup, pruneArchives, tableRowCounts } from './create.js';
import {
  type BackupManifest,
  BLOB_INDEX_ENTRY,
  MANIFEST_DB_PATH,
  MANIFEST_ENTRY,
} from './manifest.js';
import { assertServerStopped, type RestoreUnlock, restoreBackup, verifyBackup } from './restore.js';
import { type HeaderKeys, headerFor } from './testing/header.js';

const INSTANCE = 'inst_01jbkf0000000000000000000000';
const CREATED = '2026-11-11T15:00:00Z';
const KNOWN = ['0000_initial', '0001_search'];

const temporaries: string[] = [];
afterEach(() => {
  for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(tag: string): string {
  const path = mkdtempSync(join(tmpdir(), `${BRAND.slug}-${tag}-`));
  temporaries.push(path);
  return path;
}

function keysOf(): HeaderKeys {
  return {
    rootDataKey: Buffer.alloc(32, 0x31),
    masterSlotKey: Buffer.alloc(32, 0x41),
    recoverySlotKey: Buffer.alloc(32, 0x51),
    passphraseSlotKey: Buffer.alloc(32, 0x61),
    blobIdKey: Buffer.alloc(32, 0x71),
  };
}

function manifestStub(
  overrides: Partial<Omit<BackupManifest, 'db' | 'tables' | 'blobs'>> = {},
): Omit<BackupManifest, 'db' | 'tables' | 'blobs'> {
  return {
    format: BACKUP_MANIFEST_FORMAT,
    formatVersion: 1,
    createdAt: CREATED,
    instanceId: INSTANCE,
    app: {
      version: '0.1.0',
      node: process.versions.node,
      sqlite: '3.53.4',
      sqlite3mc: 'SQLite3 Multiple Ciphers 2.4.0',
      sqliteVec: 'v0.1.9',
    },
    schema: { lastMigrationId: '0001_search', migrationCount: 2 },
    embeddingSpaces: [],
    tzdataVersion: '2026a',
    ...overrides,
  };
}

function unlockWith(slotKey: Buffer): RestoreUnlock {
  return {
    dekFor: (header) => {
      for (const slot of header.slots) {
        const ref =
          slot.kind === 'backup-kek'
            ? String(slot.gen)
            : slot.kind === 'recovery'
              ? slot.rkId
              : slot.kdf.salt;
        try {
          return unwrap(
            slotKey,
            Buffer.from(slot.sealed, 'base64url'),
            AAD.backupDek(header.instanceId, header.createdAt, slot.kind, ref),
          );
        } catch {}
      }
      return undefined;
    },
    rootDataKeyFor: (header) => {
      for (const generation of header.keyringSnapshot.generations) {
        for (const slot of generation.slots) {
          try {
            return {
              gen: generation.gen,
              key: unwrap(
                slotKey,
                Buffer.from(slot.wrap.sealed, 'base64url'),
                AAD.keyringSlot(header.instanceId, generation.gen, slot.id, slot.kind),
              ),
            };
          } catch {}
        }
      }
      return undefined;
    },
  };
}

/**
 * Build an archive from a chosen manifest and a chosen database file.
 *
 * The only way to reach the manifest's own checks: the digest and the row counts live *inside* the
 * encrypted tar, so an archive whose manifest lies has to be built deliberately. Corrupting the
 * ciphertext instead would fail authentication first and prove nothing about either check.
 */
async function forgeArchive(options: {
  readonly dir: string;
  readonly keys: HeaderKeys;
  readonly manifest: BackupManifest;
  readonly dbPath: string;
}): Promise<string> {
  await wrappersSecretStream.ready();
  const dek = Buffer.from(wrappersSecretStream.keygen());
  const pack = tarPack();
  const manifestJson = Buffer.from(JSON.stringify(options.manifest), 'utf8');
  const dbBytes = readFileSync(options.dbPath);
  const fill = (async () => {
    pack.entry({ name: MANIFEST_ENTRY, size: manifestJson.length }, manifestJson);
    pack.entry({ name: BLOB_INDEX_ENTRY, size: 1 }, '\n');
    pack.entry({ name: MANIFEST_DB_PATH, size: dbBytes.length }, dbBytes);
    pack.finalize();
  })();

  const pieces: Uint8Array[] = [];
  await sealBackup({
    stream: wrappersSecretStream,
    dek,
    header: headerFor({ instanceId: INSTANCE, createdAt: CREATED, dek, keys: options.keys }),
    source: pack as unknown as AsyncIterable<Uint8Array>,
    write: (piece) => {
      pieces.push(Buffer.from(piece));
    },
  });
  await fill;
  const path = join(options.dir, 'forged.vbak');
  writeFileSync(path, Buffer.concat(pieces));
  return path;
}

interface Made {
  readonly archive: string;
  readonly dataDir: string;
  readonly keys: HeaderKeys;
  readonly manifest: BackupManifest;
}

async function make(
  tag: string,
  options: {
    rows?: number;
    embedded?: boolean;
    manifest?: Partial<Omit<BackupManifest, 'db' | 'tables' | 'blobs'>>;
  } = {},
): Promise<Made> {
  await wrappersSecretStream.ready();
  const keys = keysOf();
  const dataDir = tempDir(tag);
  mkdirSync(join(dataDir, 'db'), { recursive: true, mode: 0o700 });
  mkdirSync(join(dataDir, 'backups'), { recursive: true, mode: 0o700 });
  const dbKey = derivePurposeKey(keys.rootDataKey, INSTANCE, KEY_PURPOSE.db);
  const opened = openDatabase({
    path: join(dataDir, 'db', `${BRAND.slug}.db`),
    key: dbKey,
    role: 'main',
    loadVec: false,
  });
  // `app_meta` because every real database has it — migration `0000` creates it, and `02` §3.14.4
  // step 8 writes `restored_from` into it. A fixture without it is a fixture no archive could
  // contain.
  opened.db.exec(`CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL,
                                         updated_at INTEGER NOT NULL)`);
  opened.db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
  const insert = opened.db.prepare('INSERT INTO notes (id, body) VALUES (?, ?)');
  for (let index = 1; index <= (options.rows ?? 3); index += 1)
    insert.run(index, `n${String(index)}`);

  const blobs = options.embedded === true ? [seedBlob(dataDir)] : [];
  const dek = Buffer.from(wrappersSecretStream.keygen());
  const result = await createBackup({
    db: opened.db,
    key: dbKey,
    backupDir: join(dataDir, 'backups'),
    tier: 'manual',
    stream: wrappersSecretStream,
    dek,
    header: headerFor({ instanceId: INSTANCE, createdAt: CREATED, dek, keys }),
    manifest: manifestStub(options.manifest),
    blobs,
    blobMode: options.embedded === true ? 'embedded' : 'shared',
    keep: 14,
  });
  opened.db.close();
  return { archive: result.path, dataDir, keys, manifest: result.manifest };
}

function seedBlob(dataDir: string): {
  addr: string;
  path: string;
  sizeEnc: number;
  groupId: string;
  sha256: string;
} {
  const dir = join(dataDir, 'blobs');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const addr = Buffer.alloc(32, 5).toString('hex');
  const path = join(dir, `${addr}.blob`);
  writeFileSync(path, Buffer.alloc(96, 5), { mode: 0o600 });
  return {
    addr,
    path,
    sizeEnc: 96,
    groupId: 'grp_01jbkf0000000000000000000000',
    sha256: 'e'.repeat(64),
  };
}

describe('createBackup refusals (02 §3.14.1)', () => {
  it('aborts on a snapshot that fails quick_check, rather than archiving the damage', async () => {
    await wrappersSecretStream.ready();
    const keys = keysOf();
    const dataDir = tempDir('qc');
    mkdirSync(join(dataDir, 'db'), { recursive: true, mode: 0o700 });
    mkdirSync(join(dataDir, 'backups'), { recursive: true, mode: 0o700 });
    const dbKey = derivePurposeKey(keys.rootDataKey, INSTANCE, KEY_PURPOSE.db);
    const opened = openDatabase({
      path: join(dataDir, 'db', `${BRAND.slug}.db`),
      key: dbKey,
      role: 'main',
      loadVec: false,
    });
    opened.db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY)');

    const dek = Buffer.from(wrappersSecretStream.keygen());
    // The **wrong** key for the snapshot, which is how a verification that cannot open the copy is
    // exercised without corrupting a file. The refusal is the point: an archive of a database that
    // did not verify is worse than no archive, because it looks like a rollback path.
    await expect(
      createBackup({
        db: opened.db,
        key: Buffer.alloc(32, 0xaa),
        backupDir: join(dataDir, 'backups'),
        tier: 'manual',
        stream: wrappersSecretStream,
        dek,
        header: headerFor({ instanceId: INSTANCE, createdAt: CREATED, dek, keys }),
        manifest: manifestStub(),
        blobs: [],
        blobMode: 'shared',
        keep: 14,
      }),
    ).rejects.toThrow();
    opened.db.close();

    // And the temporary snapshot is gone, on the failure path as much as the success one: it is a
    // full copy of the database, and one left behind per failure fills `backups/.tmp` with
    // ciphertext nobody will ever read.
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(join(dataDir, 'backups', '.tmp'))).toEqual([]);
  });

  it('reports a blob it cannot read instead of abandoning the write and ending the process', async () => {
    // An embedded blob whose file is missing: `addFile` throws inside the `fill` promise, which is
    // the half of `writeArchive` nobody awaits until after the seal. Before the M1 exit gate that
    // rejection was abandoned whenever the seal failed — and Node 26 ends the process on an
    // abandoned rejection, *after* the caller has already caught and reported the real error. Here
    // the failure has to come back as a thrown error from `createBackup`, not as a dead process.
    await wrappersSecretStream.ready();
    const keys = keysOf();
    const dataDir = tempDir('blobgone');
    mkdirSync(join(dataDir, 'db'), { recursive: true, mode: 0o700 });
    mkdirSync(join(dataDir, 'backups'), { recursive: true, mode: 0o700 });
    const dbKey = derivePurposeKey(keys.rootDataKey, INSTANCE, KEY_PURPOSE.db);
    const opened = openDatabase({
      path: join(dataDir, 'db', `${BRAND.slug}.db`),
      key: dbKey,
      role: 'main',
      loadVec: false,
    });
    opened.db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY)');
    const dek = Buffer.from(wrappersSecretStream.keygen());

    await expect(
      createBackup({
        db: opened.db,
        key: dbKey,
        backupDir: join(dataDir, 'backups'),
        tier: 'manual',
        stream: wrappersSecretStream,
        dek,
        header: headerFor({ instanceId: INSTANCE, createdAt: CREATED, dek, keys }),
        manifest: manifestStub(),
        // A real blob reference whose **file** is gone: the shape the manifest accepts, with
        // nothing behind it. The first version of this test passed a made-up shape and was
        // refused by the manifest's own schema instead — it never reached `writeArchive` at all,
        // which the coverage of the path it claimed to exercise is what revealed.
        blobs: [{ ...seedBlob(dataDir), path: join(dataDir, 'blobs', 'gone.blob') }],
        blobMode: 'embedded',
        keep: 14,
      }),
    ).rejects.toThrow(/ENOENT|no such file/);
    opened.db.close();

    // No half-written archive left claiming to be a rollback path, and no snapshot either.
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(join(dataDir, 'backups', '.tmp'))).toEqual([]);
    expect(
      readdirSync(join(dataDir, 'backups', 'manual')).filter((n) => n.endsWith('.vbak')),
    ).toEqual([]);
  });

  it('surfaces a write error instead of hanging on a drain that can never come', async () => {
    // The output stream failing mid-archive. Before the M1 exit gate the stream had no `'error'`
    // listener and the drain promise had no reject path, so `ENOSPC` either threw an unhandled
    // `'error'` or waited forever for a drain. Reproduced root-proof by putting a **directory**
    // where the `.part` file goes: `createWriteStream` then fails with `EISDIR`, which is the same
    // shape as a full disk from this code's point of view.
    await wrappersSecretStream.ready();
    const keys = keysOf();
    const dataDir = tempDir('eisdir');
    mkdirSync(join(dataDir, 'db'), { recursive: true, mode: 0o700 });
    const tier = join(dataDir, 'backups', 'manual');
    mkdirSync(tier, { recursive: true, mode: 0o700 });
    mkdirSync(join(tier, `${archiveName(INSTANCE, CREATED)}.part`), { recursive: true });
    const dbKey = derivePurposeKey(keys.rootDataKey, INSTANCE, KEY_PURPOSE.db);
    const opened = openDatabase({
      path: join(dataDir, 'db', `${BRAND.slug}.db`),
      key: dbKey,
      role: 'main',
      loadVec: false,
    });
    opened.db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY)');
    const dek = Buffer.from(wrappersSecretStream.keygen());

    await expect(
      createBackup({
        db: opened.db,
        key: dbKey,
        backupDir: join(dataDir, 'backups'),
        tier: 'manual',
        stream: wrappersSecretStream,
        dek,
        header: headerFor({ instanceId: INSTANCE, createdAt: CREATED, dek, keys }),
        manifest: manifestStub(),
        blobs: [],
        blobMode: 'shared',
        keep: 14,
      }),
    ).rejects.toThrow();
    opened.db.close();
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(join(dataDir, 'backups', '.tmp'))).toEqual([]);
  }, 20_000);

  it('embeds the blobs when asked, and a restore finds them inside the archive', async () => {
    const made = await make('embed', { embedded: true });
    expect(made.manifest.blobs.mode).toBe('embedded');
    // `--portable`: one file to copy off-site. The blobstore is **not** consulted on restore, which
    // is the whole point — so this passes `blobsFrom` nowhere and still finds all of them.
    const target = tempDir('embed-into');
    const result = await restoreBackup({
      archive: made.archive,
      dataDir: target,
      unlock: unlockWith(made.keys.masterSlotKey),
      stream: wrappersSecretStream,
      knownMigrationIds: KNOWN,
      stamp: 'embed',
      strict: true,
    });
    expect(result.blobsLinked).toBe(1);
    expect(result.blobsMissing).toBe(0);
  });

  it('counts rows for every table it can, and skips one it cannot', () => {
    const dataDir = tempDir('counts');
    const opened = openDatabase({
      path: join(dataDir, 'x.db'),
      key: null,
      role: 'main',
      loadVec: false,
    });
    try {
      opened.db.exec('CREATE TABLE a (id INTEGER PRIMARY KEY)');
      opened.db.exec('INSERT INTO a VALUES (1), (2)');
      // A view, which `sqlite_schema` does not report as a table, and a virtual table whose
      // `count(*)` SQLite refuses — the branch that keeps a backup from failing on someone else's
      // extension. `fts5vocab` needs a real FTS table to point at, so this uses a missing one:
      // creating it succeeds and querying it does not, which is exactly the shape.
      opened.db.exec('CREATE VIEW v AS SELECT 1');
      opened.db.exec(`CREATE VIRTUAL TABLE broken USING fts5vocab('nope', 'row')`);
      const { counts, skipped } = tableRowCounts(opened.db);
      expect(counts['a']).toBe(2);
      expect(counts['v']).toBeUndefined();
      expect(counts['broken']).toBeUndefined();
      // **Named, not just skipped.** A table counted by the restoring build and skipped by the
      // backing one read as `expected 0 ≠ actual N` and refused a sound archive, so the manifest
      // carries the skips and `tableCountDifferences` ignores them. Found at the M1 exit gate.
      expect(skipped).toContain('broken');
      expect(skipped).not.toContain('a');
    } finally {
      opened.db.close();
    }
  });

  it('prunes by age and tolerates a directory that is not there', () => {
    expect(pruneArchives(join(tempDir('prune'), 'nope'), 3)).toEqual([]);
    // A negative count is a caller bug, and deleting everything would be the worst reading of it.
    expect(pruneArchives(tempDir('prune2'), -1)).toEqual([]);

    const dir = tempDir('prune3');
    for (const name of ['a.vbak', 'b.vbak', 'c.vbak', 'notes.txt']) {
      writeFileSync(join(dir, name), 'x');
    }
    const pruned = pruneArchives(dir, 1);
    // Two archives go and the stray file stays: a rotation that deleted anything it did not
    // recognise would be a rotation that eats a host's own notes.
    expect(pruned).toHaveLength(2);
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
  });
});

describe('restoreBackup refusals (02 §3.14.4)', () => {
  it('refuses while the server is running', () => {
    const dataDir = tempDir('lock');
    mkdirSync(join(dataDir, 'run'), { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, 'run', `${BRAND.slug}.lock`), '{}');
    // `RESTORE_SERVER_RUNNING`. A restore replaces the database file, and SQLite's answer to that
    // happening under a live process is corruption — so this is a refusal and not a warning.
    expect(() => assertServerStopped(dataDir)).toThrow(/server is running/);
    rmSync(join(dataDir, 'run', `${BRAND.slug}.lock`));
    expect(() => assertServerStopped(dataDir)).not.toThrow();
  });

  it('refuses an archive whose database does not match the manifest digest', async () => {
    const made = await make('digest', { rows: 4 });
    const target = tempDir('digest-into');
    const forged = await forgeArchive({
      dir: target,
      keys: made.keys,
      // Everything real except the digest. The body authenticates, so the AEAD sees nothing wrong
      // — and only the digest check can catch a tar entry that unpacked short or a filesystem that
      // lied about a write, which is the fault a hash exists for.
      manifest: { ...made.manifest, db: { ...made.manifest.db, sha256: 'f'.repeat(64) } },
      dbPath: join(made.dataDir, 'db', `${BRAND.slug}.db`),
    });

    await expect(
      verifyBackup({
        archive: forged,
        dataDir: target,
        unlock: unlockWith(made.keys.masterSlotKey),
        stream: wrappersSecretStream,
        knownMigrationIds: KNOWN,
        stamp: 'digest',
      }),
    ).rejects.toThrow(/does not match the digest/);
    expect(existsSync(join(target, '.restore-digest'))).toBe(false);
  });

  it('refuses an archive whose row counts do not match the manifest', async () => {
    const made = await make('counts2', { rows: 4 });
    const target = tempDir('counts2-into');
    const dbPath = join(made.dataDir, 'db', `${BRAND.slug}.db`);
    const digest = createHash('sha256').update(readFileSync(dbPath)).digest('hex');
    const forged = await forgeArchive({
      dir: target,
      keys: made.keys,
      // A correct digest and a lying table count, which is the *silently partial* restore this
      // check exists for: a `VACUUM INTO` that ran out of disk, or a tar that stopped early. The
      // digest cannot see it, because the file it hashed is the file that arrived.
      manifest: {
        ...made.manifest,
        db: { ...made.manifest.db, sha256: digest, bytes: readFileSync(dbPath).length },
        tables: { ...made.manifest.tables, notes: 999 },
      },
      dbPath,
    });

    await expect(
      verifyBackup({
        archive: forged,
        dataDir: target,
        unlock: unlockWith(made.keys.masterSlotKey),
        stream: wrappersSecretStream,
        knownMigrationIds: KNOWN,
        stamp: 'counts2',
      }),
    ).rejects.toThrow(/different row counts/);
  });

  it('refuses an archive from a different schema lineage', async () => {
    const made = await make('lineage', {
      manifest: { schema: { lastMigrationId: '0001_elsewhere', migrationCount: 2 } },
    });
    const target = tempDir('lineage-into');
    // Same number of migrations, different id: a different product line rather than a newer
    // version, and `SCHEMA_TOO_NEW` would send a host to upgrade for nothing.
    await expect(
      verifyBackup({
        archive: made.archive,
        dataDir: target,
        unlock: unlockWith(made.keys.masterSlotKey),
        stream: wrappersSecretStream,
        knownMigrationIds: KNOWN,
        stamp: 'lineage',
      }),
    ).rejects.toThrow(/does not match this build/);
  });

  it('keeps an existing keyring rather than overwriting it', async () => {
    const made = await make('keyring', { rows: 2 });
    const target = tempDir('keyring-into');
    mkdirSync(join(target, 'keys'), { recursive: true, mode: 0o700 });
    writeFileSync(join(target, 'keys', 'keyring.json'), '{"mine":true}');

    const result = await restoreBackup({
      archive: made.archive,
      dataDir: target,
      unlock: unlockWith(made.keys.masterSlotKey),
      stream: wrappersSecretStream,
      knownMigrationIds: KNOWN,
      stamp: 'keyring',
    });
    // Not overwritten. A host restoring onto their own machine keeps the keyring they can already
    // unlock, and silently replacing it is the one failure from which there is no recovery.
    expect(result.keyringImported).toBe(false);
    expect(readFileSync(join(target, 'keys', 'keyring.json'), 'utf8')).toBe('{"mine":true}');
  });

  it('refuses a body that does not authenticate', async () => {
    const made = await make('tamper', { rows: 2 });
    const target = tempDir('tamper-into');
    const bytes = readFileSync(made.archive);
    const damaged = join(target, 'damaged.vbak');
    // A flipped byte well inside the body: past the header, so the parse succeeds and the
    // secretstream is what refuses it.
    const copy = Buffer.from(bytes);
    const at = copy.length - 40;
    copy[at] = (copy[at] ?? 0) ^ 0xff;
    writeFileSync(damaged, copy);

    await expect(
      verifyBackup({
        archive: damaged,
        dataDir: target,
        unlock: unlockWith(made.keys.masterSlotKey),
        stream: wrappersSecretStream,
        knownMigrationIds: KNOWN,
        stamp: 'tamper',
      }),
    ).rejects.toThrow();
    // And the scratch directory is gone: it held a decrypted database.
    expect(existsSync(join(target, '.restore-tamper'))).toBe(false);
  });

  it('finds the blobstore without being told where it is', async () => {
    const made = await make('default-blobs', { rows: 1 });
    // No `blobsFrom`: the default is `<dataDir>/backups/blobstore`, which is where `createBackup`
    // put the files — so a restore in place needs no flag at all.
    const result = await restoreBackup({
      archive: made.archive,
      dataDir: made.dataDir,
      unlock: unlockWith(made.keys.masterSlotKey),
      stream: wrappersSecretStream,
      knownMigrationIds: KNOWN,
      stamp: 'default-blobs',
    });
    expect(result.preRestoreDir).toBeDefined();
  });
});
