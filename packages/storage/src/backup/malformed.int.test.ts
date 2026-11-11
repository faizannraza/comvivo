/**
 * Archives that decrypt and are still not archives (`M1-T27`; `02` §3.14.4).
 *
 * Every case here is a file whose **body authenticates** — the key is right, the secretstream is
 * intact, the final tag is present — and whose contents are wrong. That is a different class of
 * failure from a tamper, and no AEAD can see it: the archive is exactly what somebody sealed.
 *
 * They matter because they are what a *newer or older or broken writer* produces, and because the
 * checks that catch them are the ones that would otherwise be dead code — a restore that trusted
 * the body's authentication would extract a tar with no manifest, find no database, and swap
 * nothing in while reporting success.
 *
 * The path-traversal case is the one that is an attack rather than a mistake: `../` in a tar entry
 * is the oldest trick there is, and an archive is a file a host may have fetched from anywhere.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '@comvivo/shared';
import {
  AAD,
  derivePurposeKey,
  KEY_PURPOSE,
  unwrap,
  wrappersSecretStream,
} from '@comvivo/shared/crypto';
import { pack as tarPack } from 'tar-stream';
import { afterEach, describe, expect, it } from 'vitest';
import { type BackupHeader, sealBackup } from '../crypto/backup-envelope.js';
import { openDatabase } from '../db/open.js';
import { createBackup } from './create.js';
import {
  type BackupManifest,
  BLOB_INDEX_ENTRY,
  MANIFEST_DB_PATH,
  MANIFEST_ENTRY,
} from './manifest.js';
import { type RestoreUnlock, readArchiveHeader, restoreBackup, verifyBackup } from './restore.js';
import { type HeaderKeys, headerFor } from './testing/header.js';

const INSTANCE = 'inst_01jbkq0000000000000000000000';
const CREATED = '2026-11-11T16:00:00Z';
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

const KEYS: HeaderKeys = {
  rootDataKey: Buffer.alloc(32, 0x31),
  masterSlotKey: Buffer.alloc(32, 0x41),
  recoverySlotKey: Buffer.alloc(32, 0x51),
  passphraseSlotKey: Buffer.alloc(32, 0x61),
  blobIdKey: Buffer.alloc(32, 0x71),
};

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

/** Seal an arbitrary set of tar entries into a valid archive. */
async function sealEntries(
  dir: string,
  entries: readonly { readonly name: string; readonly body: Buffer }[],
): Promise<string> {
  await wrappersSecretStream.ready();
  const dek = Buffer.from(wrappersSecretStream.keygen());
  const header: BackupHeader = headerFor({
    instanceId: INSTANCE,
    createdAt: CREATED,
    dek,
    keys: KEYS,
  });
  const pack = tarPack();
  const fill = (async () => {
    for (const entry of entries) {
      pack.entry({ name: entry.name, size: entry.body.length }, entry.body);
    }
    pack.finalize();
  })();
  const pieces: Uint8Array[] = [];
  await sealBackup({
    stream: wrappersSecretStream,
    dek,
    header,
    source: pack as unknown as AsyncIterable<Uint8Array>,
    write: (piece) => {
      pieces.push(Buffer.from(piece));
    },
  });
  await fill;
  const path = join(dir, 'made.vbak');
  writeFileSync(path, Buffer.concat(pieces));
  return path;
}

function restoreOf(archive: string, dataDir: string, stamp: string) {
  return {
    archive,
    dataDir,
    unlock: unlockWith(KEYS.masterSlotKey),
    stream: wrappersSecretStream,
    knownMigrationIds: KNOWN,
    stamp,
  };
}

const MANIFEST: BackupManifest = {
  format: 'village-backup',
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
  db: {
    path: MANIFEST_DB_PATH,
    bytes: 0,
    sha256: '0'.repeat(64),
    encrypted: false,
    quickCheck: 'ok',
  },
  tables: {},
  embeddingSpaces: [],
  blobs: { mode: 'shared', count: 0, bytes: 0, index: BLOB_INDEX_ENTRY },
  tzdataVersion: '2026a',
};

/** The manifest fields a caller supplies; `createBackup` computes the other three. */
function manifestInput(createdAt = CREATED): Omit<BackupManifest, 'db' | 'tables' | 'blobs'> {
  const { db: _db, tables: _tables, blobs: _blobs, ...input } = MANIFEST;
  return { ...input, createdAt };
}

describe('archives that decrypt and are not archives (02 §3.14.4)', () => {
  it('refuses one with no manifest', async () => {
    const dir = tempDir('nomanifest');
    const archive = await sealEntries(dir, [{ name: 'readme.txt', body: Buffer.from('hi') }]);
    // "The body decrypted, so the key is right and the contents are not what this version writes"
    // — which is a completely different message from "your key is wrong", and the reason the two
    // error codes are separate.
    await expect(verifyBackup(restoreOf(archive, dir, 'nomanifest'))).rejects.toThrow(
      new RegExp(`has no ${MANIFEST_ENTRY}`),
    );
  });

  it('refuses one whose manifest is not JSON', async () => {
    const dir = tempDir('badjson');
    const archive = await sealEntries(dir, [{ name: MANIFEST_ENTRY, body: Buffer.from('{{{{') }]);
    await expect(verifyBackup(restoreOf(archive, dir, 'badjson'))).rejects.toThrow();
  });

  it('refuses one whose manifest is the wrong shape', async () => {
    const dir = tempDir('badshape');
    const archive = await sealEntries(dir, [
      { name: MANIFEST_ENTRY, body: Buffer.from(JSON.stringify({ format: 'something-else' })) },
    ]);
    await expect(verifyBackup(restoreOf(archive, dir, 'badshape'))).rejects.toThrow(
      /not a manifest this version understands/,
    );
  });

  it('refuses one with a manifest and no database', async () => {
    const dir = tempDir('nodb');
    const archive = await sealEntries(dir, [
      { name: MANIFEST_ENTRY, body: Buffer.from(JSON.stringify(MANIFEST)) },
    ]);
    await expect(verifyBackup(restoreOf(archive, dir, 'nodb'))).rejects.toThrow(
      new RegExp(`has no ${MANIFEST_DB_PATH}`),
    );
  });

  it('refuses a tar entry that tries to escape the extraction directory', async () => {
    const dir = tempDir('traversal');
    const archive = await sealEntries(dir, [
      { name: MANIFEST_ENTRY, body: Buffer.from(JSON.stringify(MANIFEST)) },
      { name: '../escaped.txt', body: Buffer.from('pwned') },
    ]);
    // Checked **before** any path is joined, so the file is never created — which the second
    // assertion is for: a check that refused *after* writing would be a check that lost.
    await expect(verifyBackup(restoreOf(archive, dir, 'traversal'))).rejects.toThrow();
    // `dir` is the parent of the extraction directory, so this is exactly where `../escaped.txt`
    // would land. (Not `tmpdir()` itself: a fixed temp path is shared state between tests, which
    // is what the `no-shared-temp-dir` hygiene rule exists to stop.)
    expect(existsSync(join(dir, 'escaped.txt'))).toBe(false);
  });

  it('refuses an absolute tar entry name too', async () => {
    const dir = tempDir('absolute');
    const archive = await sealEntries(dir, [
      { name: MANIFEST_ENTRY, body: Buffer.from(JSON.stringify(MANIFEST)) },
      { name: '/etc/passwd', body: Buffer.from('nope') },
    ]);
    await expect(verifyBackup(restoreOf(archive, dir, 'absolute'))).rejects.toThrow();
  });

  it('refuses a file that is too short to hold a header', () => {
    const dir = tempDir('short');
    const path = join(dir, 'tiny.vbak');
    writeFileSync(path, Buffer.from('VBK1'));
    // Four bytes: the magic is right and there is nothing after it. "Keep reading" is the correct
    // answer to a partial *stream* and the wrong answer to a whole *file*, which is why
    // `readArchiveHeader` turns the first into the second.
    expect(() => readArchiveHeader(path)).toThrow(/shorter than its own header/);
  });

  it('refuses when the keyring snapshot cannot be unwrapped, even though the body can', async () => {
    const dir = tempDir('nokeyring');
    const archive = await sealEntries(dir, [
      { name: MANIFEST_ENTRY, body: Buffer.from(JSON.stringify(MANIFEST)) },
    ]);
    const bodyOnly: RestoreUnlock = {
      dekFor: unlockWith(KEYS.masterSlotKey).dekFor,
      rootDataKeyFor: () => undefined,
    };
    // The body opens and the database key cannot be derived. A distinct message, because the cause
    // is usually a recovery key from a different generation and "no key opens this archive" would
    // send a host looking for the wrong thing.
    await expect(
      verifyBackup({ ...restoreOf(archive, dir, 'nokeyring'), unlock: bodyOnly }),
    ).rejects.toThrow(/keyring snapshot could not be unwrapped/);
  });
});

describe('an unencrypted instance (privacy.encryptAtRest = false)', () => {
  it('backs up and restores without a key at all', async () => {
    await wrappersSecretStream.ready();
    const dataDir = tempDir('plain');
    mkdirSync(join(dataDir, 'db'), { recursive: true, mode: 0o700 });
    mkdirSync(join(dataDir, 'backups'), { recursive: true, mode: 0o700 });
    const opened = openDatabase({
      path: join(dataDir, 'db', `${BRAND.slug}.db`),
      // `null` is `privacy.encryptAtRest: false`, which `doctor` warns about and which has to work:
      // the manifest records `encrypted: false` and the restore must not try to derive a key.
      key: null,
      role: 'main',
      loadVec: false,
    });
    opened.db.exec(`CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL,
                                           updated_at INTEGER NOT NULL)`);
    opened.db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY)');
    opened.db.exec('INSERT INTO notes VALUES (1), (2), (3)');

    const dek = Buffer.from(wrappersSecretStream.keygen());
    const result = await createBackup({
      db: opened.db,
      key: null,
      backupDir: join(dataDir, 'backups'),
      tier: 'manual',
      stream: wrappersSecretStream,
      dek,
      header: headerFor({ instanceId: INSTANCE, createdAt: CREATED, dek, keys: KEYS }),
      manifest: manifestInput(),
      blobs: [],
      blobMode: 'shared',
      keep: 14,
    });
    opened.db.close();

    expect(result.manifest.db.encrypted).toBe(false);
    const target = tempDir('plain-into');
    const restored = await restoreBackup(restoreOf(result.path, target, 'plain'));
    expect(restored.manifest.tables['notes']).toBe(3);
    // And the restored file really is plaintext, which is the point of the mode.
    expect(
      readFileSync(join(target, 'db', `${BRAND.slug}.db`))
        .subarray(0, 15)
        .toString(),
    ).toBe('SQLite format 3');
  });
});

describe('the shared blobstore', () => {
  it('copies a blob once and leaves it alone on the next backup', async () => {
    await wrappersSecretStream.ready();
    const dataDir = tempDir('shared');
    mkdirSync(join(dataDir, 'db'), { recursive: true, mode: 0o700 });
    mkdirSync(join(dataDir, 'backups'), { recursive: true, mode: 0o700 });
    mkdirSync(join(dataDir, 'blobs'), { recursive: true, mode: 0o700 });
    const dbKey = derivePurposeKey(KEYS.rootDataKey, INSTANCE, KEY_PURPOSE.db);
    const opened = openDatabase({
      path: join(dataDir, 'db', `${BRAND.slug}.db`),
      key: dbKey,
      role: 'main',
      loadVec: false,
    });
    opened.db.exec(`CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL,
                                           updated_at INTEGER NOT NULL)`);

    const addr = Buffer.alloc(32, 8).toString('hex');
    const blobPath = join(dataDir, 'blobs', `${addr}.blob`);
    writeFileSync(blobPath, Buffer.alloc(32, 8), { mode: 0o600 });
    const blobs = [
      {
        addr,
        path: blobPath,
        sizeEnc: 32,
        groupId: 'grp_01jbkq0000000000000000000000',
        sha256: 'd'.repeat(64),
      },
    ];

    const run = async (createdAt: string) => {
      const dek = Buffer.from(wrappersSecretStream.keygen());
      return createBackup({
        db: opened.db,
        key: dbKey,
        backupDir: join(dataDir, 'backups'),
        tier: 'daily',
        stream: wrappersSecretStream,
        dek,
        header: headerFor({ instanceId: INSTANCE, createdAt, dek, keys: KEYS }),
        manifest: manifestInput(createdAt),
        blobs,
        blobMode: 'shared',
        keep: 14,
      });
    };

    const first = await run('2026-11-11T16:00:00Z');
    const second = await run('2026-11-12T16:00:00Z');
    opened.db.close();

    // Copy-if-absent: the files are immutable and content-addressed, so fourteen daily archives of
    // a 2 GB blob store cost 2 GB rather than 28 GB. The second run finds the file already there.
    expect(first.blobsCopied).toBe(1);
    expect(second.blobsCopied).toBe(0);
  });
});
