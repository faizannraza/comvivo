/**
 * `backup.roundtrip` (`M1-T27` AC; `02` §9.3, §3.14).
 *
 * `02` §9.3 words it as:
 *
 * > seed, `createBackup`, `restoreBackup` into a new dataDir, then a logical dump (all tables as
 * > sorted JSONL, excluding `app_meta.restored_from`) equals the original. A **recovery-key-only**
 * > restore into an empty dataDir succeeds (A10); a passphrase-slot restore succeeds when the slot
 * > exists.
 *
 * The logical dump is the assertion that matters, and `exportDomainState` already is one — every
 * row of every table as canonical JSON, with the volatile columns excluded. Comparing files byte
 * for byte would be the wrong test: `VACUUM INTO` renumbers free pages, so two snapshots of the
 * same data differ as *files* and are identical as *databases*.
 *
 * The recovery-key-only case is `01` §14 A10, and it is the one that has to be arranged honestly:
 * the restore is given a `RestoreUnlock` that holds the printed key and **nothing else**, into a
 * data directory with no `keyring.json`. If it could reach the master key through some other
 * object, the test would prove nothing.
 */

import * as nodeFs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '@comvivo/shared';
import {
  AAD,
  derivePurposeKey,
  KEY_PURPOSE,
  randomBytes,
  unwrap,
  wrap,
  wrappersSecretStream,
} from '@comvivo/shared/crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/open.js';
import { exportDomainState } from '../testing/domain-state.js';
import { createBackup } from './create.js';
import { BACKUP_MANIFEST_FORMAT, type BackupManifest } from './manifest.js';
import { type RestoreUnlock, restoreBackup, verifyBackup } from './restore.js';
import {
  BACKUP_FORMAT_LITERAL,
  type BackupHeader,
  backupSlotsFor,
  keyringSnapshotFor,
} from './testing/header.js';

const INSTANCE = 'inst_01jbkr0000000000000000000000';
const CREATED = '2026-11-11T13:00:00Z';
/** The migrations this "binary" knows, for `02` §3.14.4 step 6. */
const KNOWN = ['0000_initial', '0001_search'];

/** A string that exists nowhere else, for the at-rest scan. */
const BACKUP_CANARY = 'VorpalThimbleGnomon77';

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

/** The canary in four spellings, as `02` §9.3's at-rest criterion requires. */
function containsCanary(path: string): boolean {
  const bytes = nodeFs.readFileSync(path);
  return [
    Buffer.from(BACKUP_CANARY, 'utf8'),
    Buffer.from(BACKUP_CANARY, 'utf16le'),
    Buffer.from(BACKUP_CANARY.toLowerCase(), 'utf8'),
    Buffer.from(BACKUP_CANARY.toUpperCase(), 'utf8'),
  ].some((needle) => bytes.includes(needle));
}

const temporaries: string[] = [];
afterEach(() => {
  for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(tag: string): string {
  const path = mkdtempSync(join(tmpdir(), `${BRAND.slug}-${tag}-`));
  temporaries.push(path);
  return path;
}

/** The keys a host holds: a master key, a printed recovery key, and a passphrase-derived key. */
interface Keys {
  readonly rootDataKey: Buffer;
  readonly masterSlotKey: Buffer;
  readonly recoverySlotKey: Buffer;
  readonly passphraseSlotKey: Buffer;
  readonly blobIdKey: Buffer;
}

function keysOf(): Keys {
  return {
    rootDataKey: Buffer.alloc(32, 0x31),
    masterSlotKey: Buffer.alloc(32, 0x41),
    recoverySlotKey: Buffer.alloc(32, 0x51),
    passphraseSlotKey: Buffer.alloc(32, 0x61),
    blobIdKey: Buffer.alloc(32, 0x71),
  };
}

/** A data directory with a seeded, encrypted database — what a real instance looks like. */
function seedInstance(
  tag: string,
  keys: Keys,
  rows: number,
): { readonly dataDir: string; readonly dbKey: Buffer } {
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
  // A table with a primary key and some text, which is all the logical dump needs to tell two
  // databases apart. The real `release-small` corpus arrives with `M1-T32`'s bench seed; this is
  // the part of it the roundtrip actually exercises.
  opened.db.exec(`CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL,
                                         updated_at INTEGER NOT NULL)`);
  opened.db.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`);
  const insert = opened.db.prepare('INSERT INTO notes (id, body) VALUES (?, ?)');
  for (let index = 1; index <= rows; index += 1) insert.run(index, `note ${String(index)}`);
  opened.db.close();
  return { dataDir, dbKey };
}

/** A blob file on disk, already encrypted as `02` §3.11 leaves it. */
function seedBlob(dataDir: string, fill: number): { addr: string; path: string; sizeEnc: number } {
  const blobs = join(dataDir, 'blobs', 'aa', 'bb');
  mkdirSync(blobs, { recursive: true, mode: 0o700 });
  const addr = Buffer.alloc(32, fill).toString('hex');
  const path = join(blobs, `${addr}.blob`);
  const bytes = Buffer.alloc(128, fill);
  writeFileSync(path, bytes, { mode: 0o600 });
  return { addr, path, sizeEnc: bytes.length };
}

function manifestStub(): Omit<BackupManifest, 'db' | 'tables' | 'blobs'> {
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
    schema: { lastMigrationId: KNOWN.at(-1) ?? '0001_search', migrationCount: KNOWN.length },
    embeddingSpaces: [],
    tzdataVersion: '2026a',
  };
}

function headerFor(dek: Uint8Array, keys: Keys): BackupHeader {
  return {
    format: BACKUP_FORMAT_LITERAL,
    instanceId: INSTANCE,
    createdAt: CREATED,
    dataGen: 1,
    body: { chunkSize: 65_536 },
    slots: backupSlotsFor({ instanceId: INSTANCE, createdAt: CREATED, dek, keys }),
    keyringSnapshot: keyringSnapshotFor({ instanceId: INSTANCE, keys }),
  };
}

/** An unlock that holds exactly one key, which is how A10 is tested honestly. */
function unlockWith(which: 'master' | 'recovery' | 'passphrase', keys: Keys): RestoreUnlock {
  const slotKey =
    which === 'master'
      ? keys.masterSlotKey
      : which === 'recovery'
        ? keys.recoverySlotKey
        : keys.passphraseSlotKey;
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
            const key = unwrap(
              slotKey,
              Buffer.from(slot.wrap.sealed, 'base64url'),
              AAD.keyringSlot(header.instanceId, generation.gen, slot.id, slot.kind),
            );
            return { gen: generation.gen, key };
          } catch {}
        }
      }
      return undefined;
    },
  };
}

interface Archive {
  readonly path: string;
  readonly dataDir: string;
  readonly keys: Keys;
  readonly dump: string;
  readonly manifest: BackupManifest;
}

async function backedUp(
  tag: string,
  options: { rows?: number; blobs?: number } = {},
): Promise<Archive> {
  await wrappersSecretStream.ready();
  const keys = keysOf();
  const { dataDir, dbKey } = seedInstance(tag, keys, options.rows ?? 5);
  const blobs = Array.from({ length: options.blobs ?? 0 }, (_, index) => {
    const seeded = seedBlob(dataDir, index + 1);
    return {
      ...seeded,
      groupId: 'grp_01jbkr0000000000000000000000',
      sha256: Buffer.alloc(32, index + 1).toString('hex'),
    };
  });

  const opened = openDatabase({
    path: join(dataDir, 'db', `${BRAND.slug}.db`),
    key: dbKey,
    role: 'cli',
    loadVec: false,
  });
  const dump = exportDomainState(opened.db, 'unused', { includeUngrouped: true });
  const dek = Buffer.from(wrappersSecretStream.keygen());
  const result = await createBackup({
    db: opened.db,
    key: dbKey,
    backupDir: join(dataDir, 'backups'),
    tier: 'daily',
    stream: wrappersSecretStream,
    dek,
    header: headerFor(dek, keys),
    manifest: manifestStub(),
    blobs,
    blobMode: 'shared',
    keep: 14,
  });
  opened.db.close();
  return { path: result.path, dataDir, keys, dump, manifest: result.manifest };
}

function dumpOf(dataDir: string, keys: Keys): string {
  const dbKey = derivePurposeKey(keys.rootDataKey, INSTANCE, KEY_PURPOSE.db);
  const opened = openDatabase({
    path: join(dataDir, 'db', `${BRAND.slug}.db`),
    key: dbKey,
    readonly: true,
    role: 'cli',
    loadVec: false,
  });
  try {
    return exportDomainState(opened.db, 'unused', {
      includeUngrouped: true,
      // `02` §9.3 excludes it by name: a restore writes it, so the restored database legitimately
      // differs from the original in exactly this row.
      exclude: ['restored_from'],
    });
  } finally {
    opened.db.close();
  }
}

describe('backup.roundtrip (02 §9.3)', () => {
  it('restores into a fresh data directory, and the logical dump matches', async () => {
    const archive = await backedUp('rt1', { rows: 40 });
    const target = tempDir('rt1-into');

    const result = await restoreBackup({
      archive: archive.path,
      dataDir: target,
      unlock: unlockWith('master', archive.keys),
      stream: wrappersSecretStream,
      knownMigrationIds: KNOWN,
      stamp: '20261111T130000Z',
      blobsFrom: join(archive.dataDir, 'backups', 'blobstore'),
    });

    expect(result.manifest.tables['notes']).toBe(40);
    // The databases are compared **logically**, not byte for byte: `VACUUM INTO` renumbers free
    // pages, so two snapshots of the same data are different files and identical databases.
    expect(dumpOf(target, archive.keys)).toBe(dumpOf(archive.dataDir, archive.keys));
    // A fresh directory had no database to set aside.
    expect(result.preRestoreDir).toBeUndefined();
    // And the keyring came from the archive, which is what makes the fresh host usable.
    expect(result.keyringImported).toBe(true);
    expect(existsSync(join(target, 'keys', 'keyring.json'))).toBe(true);
  });

  it('restores with the printed recovery key and nothing else (01 §14 A10)', async () => {
    const archive = await backedUp('rt2', { rows: 7 });
    const target = tempDir('rt2-into');

    // The unlock holds **only** the recovery slot key. No master key, no keyring, no reference to
    // the DEK the archive was sealed with — which is the whole of A10's guarantee, and the only
    // arrangement in which asserting it means anything.
    const result = await restoreBackup({
      archive: archive.path,
      dataDir: target,
      unlock: unlockWith('recovery', archive.keys),
      stream: wrappersSecretStream,
      knownMigrationIds: KNOWN,
      stamp: '20261111T130100Z',
    });

    expect(result.manifest.tables['notes']).toBe(7);
    expect(dumpOf(target, archive.keys)).toBe(dumpOf(archive.dataDir, archive.keys));
  });

  it('restores through the optional passphrase slot', async () => {
    const archive = await backedUp('rt3', { rows: 3 });
    const target = tempDir('rt3-into');
    const result = await restoreBackup({
      archive: archive.path,
      dataDir: target,
      unlock: unlockWith('passphrase', archive.keys),
      stream: wrappersSecretStream,
      knownMigrationIds: KNOWN,
      stamp: '20261111T130200Z',
    });
    expect(result.manifest.tables['notes']).toBe(3);
  });

  it('refuses every key that does not open the archive', async () => {
    const archive = await backedUp('rt4', { rows: 1 });
    const target = tempDir('rt4-into');
    const stranger = unlockWith('master', {
      ...archive.keys,
      masterSlotKey: Buffer.alloc(32, 0x99),
    });
    // `BACKUP_KEY_MISMATCH`, never `BACKUP_INTEGRITY`: "your key is wrong" and "this file is
    // damaged" send a host to completely different places, and the second one sends them to a
    // destructive one.
    await expect(
      restoreBackup({
        archive: archive.path,
        dataDir: target,
        unlock: stranger,
        stream: wrappersSecretStream,
        knownMigrationIds: KNOWN,
        stamp: '20261111T130300Z',
      }),
    ).rejects.toThrow(/no key opens this archive/);
    // And nothing was written into the target: the extraction happens somewhere else first.
    expect(existsSync(join(target, 'db', `${BRAND.slug}.db`))).toBe(false);
  });

  it('puts the host’s own database back when the swap fails', async () => {
    // The outcome a restore must never produce: **no database at all**. Once
    // `setAsideExistingDb` has moved the live files, a failure in the two steps that follow used
    // to leave the data directory with no `db/comvivo.db` and a raw errno that never mentioned
    // where the old one went. Found by the M1 exit gate's reviewer.
    //
    // Triggered root-proof by putting a *file* where `keys/` has to be a directory, so
    // `writeKeyringFromArchive`'s `mkdirSync` fails with ENOTDIR — after the rename, which is the
    // window that matters.
    const archive = await backedUp('rt5b', { rows: 2 });
    const victim = seedInstance('rt5b-victim', archive.keys, 7);
    rmSync(join(victim.dataDir, 'keys'), { recursive: true, force: true });
    writeFileSync(join(victim.dataDir, 'keys'), 'not a directory');

    await expect(
      restoreBackup({
        archive: archive.path,
        dataDir: victim.dataDir,
        unlock: unlockWith('master', archive.keys),
        stream: wrappersSecretStream,
        knownMigrationIds: KNOWN,
        stamp: '20261111T140000Z',
      }),
    ).rejects.toThrow(/could not be put in place/);

    // The host's own database is back where it was, with its own rows — not stranded under a
    // stamped directory the error never named.
    const live = openDatabase({
      path: join(victim.dataDir, 'db', `${BRAND.slug}.db`),
      key: derivePurposeKey(archive.keys.rootDataKey, INSTANCE, KEY_PURPOSE.db),
      readonly: true,
      role: 'cli',
      loadVec: false,
    });
    try {
      expect((live.db.prepare('SELECT count(*) AS n FROM notes').get() as { n: number }).n).toBe(7);
    } finally {
      live.db.close();
    }
  });

  it('moves an existing database aside instead of deleting it', async () => {
    const archive = await backedUp('rt5', { rows: 2 });
    // Restore over a *different* instance's data directory, which is the frightening case: a host
    // running `restore` with the wrong archive at two in the morning.
    const victim = seedInstance('rt5-victim', archive.keys, 11);
    const result = await restoreBackup({
      archive: archive.path,
      dataDir: victim.dataDir,
      unlock: unlockWith('master', archive.keys),
      stream: wrappersSecretStream,
      knownMigrationIds: KNOWN,
      stamp: '20261111T130400Z',
    });

    expect(result.preRestoreDir).toBeDefined();
    // The old database is still there, and still has its eleven rows. That is what makes a
    // mistaken restore recoverable rather than final.
    const aside = openDatabase({
      path: join(result.preRestoreDir ?? '', `${BRAND.slug}.db`),
      key: derivePurposeKey(archive.keys.rootDataKey, INSTANCE, KEY_PURPOSE.db),
      readonly: true,
      role: 'cli',
      loadVec: false,
    });
    try {
      expect((aside.db.prepare('SELECT count(*) AS n FROM notes').get() as { n: number }).n).toBe(
        11,
      );
    } finally {
      aside.db.close();
    }
  });

  it('records what it was restored from', async () => {
    const archive = await backedUp('rt6', { rows: 2 });
    const target = tempDir('rt6-into');
    await restoreBackup({
      archive: archive.path,
      dataDir: target,
      unlock: unlockWith('master', archive.keys),
      stream: wrappersSecretStream,
      knownMigrationIds: KNOWN,
      stamp: '20261111T130500Z',
    });
    const opened = openDatabase({
      path: join(target, 'db', `${BRAND.slug}.db`),
      key: derivePurposeKey(archive.keys.rootDataKey, INSTANCE, KEY_PURPOSE.db),
      readonly: true,
      role: 'cli',
      loadVec: false,
    });
    try {
      const row = opened.db
        .prepare(`SELECT value FROM app_meta WHERE key = 'restored_from'`)
        .get() as { value: string } | undefined;
      expect(row).toBeDefined();
      const recorded = JSON.parse(row?.value ?? '{}') as Record<string, string>;
      expect(recorded['instanceId']).toBe(INSTANCE);
      expect(recorded['createdAt']).toBe(CREATED);
      // Ids and a timestamp, never a path: a filesystem path in a database row leaks a host's
      // directory layout into every export and every support transcript.
      expect(JSON.stringify(recorded)).not.toContain('/');
    } finally {
      opened.db.close();
    }
  });
});

describe('blobs (02 §3.14.1 step 4, §3.14.4 step 5)', () => {
  it('shares the blob files between archives and finds them on restore', async () => {
    const archive = await backedUp('rt7', { rows: 2, blobs: 3 });
    const store = join(archive.dataDir, 'backups', 'blobstore');
    expect(archive.manifest.blobs.count).toBe(3);
    expect(archive.manifest.blobs.mode).toBe('shared');

    const target = tempDir('rt7-into');
    const result = await restoreBackup({
      archive: archive.path,
      dataDir: target,
      unlock: unlockWith('master', archive.keys),
      stream: wrappersSecretStream,
      knownMigrationIds: KNOWN,
      stamp: '20261111T130600Z',
      blobsFrom: store,
      strict: true,
    });
    expect(result.blobsLinked).toBe(3);
    expect(result.blobsMissing).toBe(0);
  });

  it('warns about a missing blob, and refuses it under `--strict`', async () => {
    const archive = await backedUp('rt8', { rows: 2, blobs: 2 });
    const store = join(archive.dataDir, 'backups', 'blobstore');
    // One file goes missing, as it would if the host copied the archive and not the blobstore.
    const index = archive.manifest.blobs.count;
    expect(index).toBe(2);
    rmSync(join(store, `${Buffer.alloc(32, 1).toString('hex')}.vblob`), { force: true });

    const warnings: string[] = [];
    const target = tempDir('rt8-into');
    const result = await restoreBackup({
      archive: archive.path,
      dataDir: target,
      unlock: unlockWith('master', archive.keys),
      stream: wrappersSecretStream,
      knownMigrationIds: KNOWN,
      stamp: '20261111T130700Z',
      blobsFrom: store,
      warn: (code) => warnings.push(code),
    });
    // A warning, not a failure. An attachment whose file is gone is a message with a broken
    // picture; refusing the restore would lose the other fifty thousand messages too.
    expect(warnings).toEqual(['BLOB_MISSING_FILE']);
    expect(result.blobsMissing).toBe(1);

    const strictTarget = tempDir('rt8-strict');
    await expect(
      restoreBackup({
        archive: archive.path,
        dataDir: strictTarget,
        unlock: unlockWith('master', archive.keys),
        stream: wrappersSecretStream,
        knownMigrationIds: KNOWN,
        stamp: '20261111T130800Z',
        blobsFrom: store,
        strict: true,
      }),
    ).rejects.toThrow(/blob this archive references is missing/);
  });
});

describe('no plaintext ever touches disk (08 §3.7.11, M1-T27 AC)', () => {
  // The write-path spy is in `no-plaintext.int.test.ts`, which has to mock `node:fs` and therefore
  // cannot share a file with tests that use the real one.
  it('leaves no file anywhere under the data directory holding the canary', async () => {
    await wrappersSecretStream.ready();
    const keys = keysOf();
    const dataDir = tempDir('canary');
    mkdirSync(join(dataDir, 'db'), { recursive: true, mode: 0o700 });
    mkdirSync(join(dataDir, 'backups'), { recursive: true, mode: 0o700 });
    const dbKey = derivePurposeKey(keys.rootDataKey, INSTANCE, KEY_PURPOSE.db);
    const opened = openDatabase({
      path: join(dataDir, 'db', `${BRAND.slug}.db`),
      key: dbKey,
      role: 'main',
      loadVec: false,
    });
    opened.db.exec(`CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL,
                                           updated_at INTEGER NOT NULL)`);
    opened.db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    opened.db
      .prepare('INSERT INTO notes (id, body) VALUES (1, ?)')
      .run(`a secret: ${BACKUP_CANARY}`);

    const dek = Buffer.from(wrappersSecretStream.keygen());
    await createBackup({
      db: opened.db,
      key: dbKey,
      backupDir: join(dataDir, 'backups'),
      tier: 'daily',
      stream: wrappersSecretStream,
      dek,
      header: headerFor(dek, keys),
      manifest: manifestStub(),
      blobs: [],
      blobMode: 'shared',
      keep: 14,
    });
    opened.db.close();

    // The byte-level check, in four spellings, over every file the data directory now holds —
    // including the WAL and the archive. The spy above proves no plaintext *file* was created;
    // this proves no plaintext *bytes* were, which is the stronger claim and the one `02` §9.3's
    // at-rest criterion makes.
    const hits = filesUnder(dataDir).filter((path) => containsCanary(path));
    expect(hits).toEqual([]);
    // Non-vacuity: the same search finds it in a plaintext copy, so the scan is not inert.
    const leak = join(dataDir, 'leak.txt');
    writeFileSync(leak, `x ${BACKUP_CANARY} y`);
    expect(filesUnder(dataDir).filter((path) => containsCanary(path))).toEqual([leak]);
  });
});

describe('verifyBackup (02 §3.14.4)', () => {
  it('runs the same checks and leaves nothing behind', async () => {
    const archive = await backedUp('rt9', { rows: 4 });
    const target = tempDir('rt9-into');
    const manifest = await verifyBackup({
      archive: archive.path,
      dataDir: target,
      unlock: unlockWith('recovery', archive.keys),
      stream: wrappersSecretStream,
      knownMigrationIds: KNOWN,
      stamp: '20261111T130900Z',
      blobsFrom: join(archive.dataDir, 'backups', 'blobstore'),
    });
    expect(manifest.tables['notes']).toBe(4);
    // The temporary directory held a decrypted database. It is gone, and it is gone on the failure
    // paths too — which is why the deletion is in a `catch` and not only in the caller.
    expect(existsSync(join(target, '.restore-20261111T130900Z'))).toBe(false);
    expect(existsSync(join(target, 'db', `${BRAND.slug}.db`))).toBe(false);
  });

  it('refuses an archive from a newer version', async () => {
    const archive = await backedUp('rt10', { rows: 1 });
    const target = tempDir('rt10-into');
    await expect(
      verifyBackup({
        archive: archive.path,
        dataDir: target,
        unlock: unlockWith('master', archive.keys),
        stream: wrappersSecretStream,
        // This "binary" knows one fewer migration than the archive declares.
        knownMigrationIds: ['0000_initial'],
        stamp: '20261111T131000Z',
      }),
    ).rejects.toThrow(/newer version/);
  });

  it('refuses a truncated archive, and deletes what it extracted', async () => {
    const archive = await backedUp('rt11', { rows: 200 });
    const target = tempDir('rt11-into');
    const bytes = readFileSync(archive.path);
    const cut = join(target, 'cut.vbak');
    writeFileSync(cut, bytes.subarray(0, bytes.length - 64));

    await expect(
      verifyBackup({
        archive: cut,
        dataDir: target,
        unlock: unlockWith('master', archive.keys),
        stream: wrappersSecretStream,
        knownMigrationIds: KNOWN,
        stamp: '20261111T131100Z',
      }),
    ).rejects.toThrow();
    expect(existsSync(join(target, '.restore-20261111T131100Z'))).toBe(false);
    expect(randomBytes(1)).toHaveLength(1);
    expect(wrap).toBeTypeOf('function');
  });
});
