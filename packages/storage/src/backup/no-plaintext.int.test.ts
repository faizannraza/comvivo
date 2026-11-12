/**
 * "No plaintext ever touches disk" (`08` §3.7.11; `M1-T27`'s AC names an fs spy).
 *
 * The claim is structural and so is the test: `createBackup` streams `tar(manifest, index, db)`
 * straight into the `VBK1` envelope, so the only file Node ever opens for writing is the archive
 * itself — there is no intermediate `.tar`, and the database snapshot is written by **SQLite**,
 * encrypted, not by Node.
 *
 * A `vi.mock('node:fs')` factory rather than `vi.spyOn(fs, …)`: the latter fails with *Module
 * namespace is not configurable in ESM*, which is why this lives in a file of its own — a mocked
 * `node:fs` is not something the roundtrip suite can share.
 *
 * What the spy catches that a post-hoc directory scan cannot: a plaintext temporary file written
 * and **deleted** during the run. That is precisely the failure a non-streaming implementation
 * would have — tar to `backups/.tmp/x.tar`, encrypt it, unlink it — and it would leave no trace to
 * find afterwards.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '@comvivo/shared';
import { derivePurposeKey, KEY_PURPOSE, wrappersSecretStream } from '@comvivo/shared/crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/open.js';
import { createBackup } from './create.js';
import { BACKUP_MANIFEST_FORMAT, type BackupManifest } from './manifest.js';
import { type HeaderKeys, headerFor } from './testing/header.js';
import { recordWrite, resetWriteLog, writeLog } from './testing/write-log.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    createWriteStream: (
      path: Parameters<typeof actual.createWriteStream>[0],
      options?: Parameters<typeof actual.createWriteStream>[1],
    ) => {
      recordWrite(path);
      return actual.createWriteStream(path, options);
    },
    // Spelled with the three positional parameters rather than a rest spread: `writeFileSync` is
    // overloaded, so `...rest: never[]` is not a tuple TypeScript will spread into it.
    writeFileSync: (
      path: Parameters<typeof actual.writeFileSync>[0],
      data: Parameters<typeof actual.writeFileSync>[1],
      options?: Parameters<typeof actual.writeFileSync>[2],
    ) => {
      recordWrite(path);
      actual.writeFileSync(path, data, options);
    },
    copyFileSync: (from: string, to: string, mode?: number) => {
      recordWrite(to);
      actual.copyFileSync(from, to, mode);
    },
  };
});

const INSTANCE = 'inst_01jbkn0000000000000000000000';
const CREATED = '2026-11-11T14:00:00Z';

const temporaries: string[] = [];
afterEach(() => {
  for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true });
});

function keysOf(): HeaderKeys {
  return {
    rootDataKey: Buffer.alloc(32, 0x31),
    masterSlotKey: Buffer.alloc(32, 0x41),
    recoverySlotKey: Buffer.alloc(32, 0x51),
    passphraseSlotKey: Buffer.alloc(32, 0x61),
    blobIdKey: Buffer.alloc(32, 0x71),
  };
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
    schema: { lastMigrationId: '0001_search', migrationCount: 2 },
    embeddingSpaces: [],
    tzdataVersion: '2026a',
  };
}

describe('the write path (M1-T27 AC)', () => {
  it('opens no file for writing but the archive itself', async () => {
    await wrappersSecretStream.ready();
    const keys = keysOf();
    const dataDir = mkdtempSync(join(tmpdir(), `${BRAND.slug}-nop-`));
    temporaries.push(dataDir);
    mkdirSync(join(dataDir, 'db'), { recursive: true, mode: 0o700 });
    mkdirSync(join(dataDir, 'backups'), { recursive: true, mode: 0o700 });

    const dbKey = derivePurposeKey(keys.rootDataKey, INSTANCE, KEY_PURPOSE.db);
    const opened = openDatabase({
      path: join(dataDir, 'db', `${BRAND.slug}.db`),
      key: dbKey,
      role: 'main',
      loadVec: false,
    });
    opened.db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    const insert = opened.db.prepare('INSERT INTO notes (id, body) VALUES (?, ?)');
    // Enough rows that the tar spans several chunks: a buffering implementation would have had to
    // put them somewhere, and this is where that would show.
    for (let index = 1; index <= 2000; index += 1)
      insert.run(index, `note ${String(index)} `.repeat(20));

    const dek = Buffer.from(wrappersSecretStream.keygen());
    resetWriteLog();
    try {
      const result = await createBackup({
        db: opened.db,
        key: dbKey,
        backupDir: join(dataDir, 'backups'),
        tier: 'daily',
        stream: wrappersSecretStream,
        dek,
        header: headerFor({ instanceId: INSTANCE, createdAt: CREATED, dek, keys }),
        manifest: manifestStub(),
        blobs: [],
        blobMode: 'shared',
        keep: 14,
      });
      expect(result.bytes).toBeGreaterThan(65_536);
    } finally {
      opened.db.close();
    }

    // **One** file, and it is the archive being assembled. No `.tar`, no `manifest.json` on disk,
    // no decrypted database anywhere — the manifest and the blob index go into the tar as in-memory
    // buffers, and the tar goes into the envelope as a stream.
    expect(writeLog).toEqual([expect.stringMatching(/\.vbak\.part$/)]);
  });

  it('writes the ciphertext blob copies and nothing else when blobs are shared', async () => {
    await wrappersSecretStream.ready();
    const keys = keysOf();
    const dataDir = mkdtempSync(join(tmpdir(), `${BRAND.slug}-nopb-`));
    temporaries.push(dataDir);
    mkdirSync(join(dataDir, 'db'), { recursive: true, mode: 0o700 });
    mkdirSync(join(dataDir, 'backups'), { recursive: true, mode: 0o700 });
    const blobDir = join(dataDir, 'blobs');
    mkdirSync(blobDir, { recursive: true, mode: 0o700 });

    const dbKey = derivePurposeKey(keys.rootDataKey, INSTANCE, KEY_PURPOSE.db);
    const opened = openDatabase({
      path: join(dataDir, 'db', `${BRAND.slug}.db`),
      key: dbKey,
      role: 'main',
      loadVec: false,
    });
    opened.db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');

    const addr = Buffer.alloc(32, 3).toString('hex');
    const blobPath = join(blobDir, `${addr}.blob`);
    const { writeFileSync: realWrite } = await vi.importActual<typeof import('node:fs')>('node:fs');
    realWrite(blobPath, Buffer.alloc(64, 3), { mode: 0o600 });

    const dek = Buffer.from(wrappersSecretStream.keygen());
    resetWriteLog();
    try {
      await createBackup({
        db: opened.db,
        key: dbKey,
        backupDir: join(dataDir, 'backups'),
        tier: 'daily',
        stream: wrappersSecretStream,
        dek,
        header: headerFor({ instanceId: INSTANCE, createdAt: CREATED, dek, keys }),
        manifest: manifestStub(),
        blobs: [
          {
            addr,
            path: blobPath,
            sizeEnc: 64,
            groupId: 'grp_01jbkn0000000000000000000000',
            sha256: 'c'.repeat(64),
          },
        ],
        blobMode: 'shared',
        keep: 14,
      });
    } finally {
      opened.db.close();
    }

    // A hardlink, when the filesystem allows one, writes nothing at all — so the blob may or may
    // not appear. What must hold either way is that **every** recorded path is an archive or a
    // `.vblob`, and a `.vblob` is ciphertext `02` §3.11 produced and this copies unchanged.
    expect(writeLog.length).toBeGreaterThan(0);
    for (const path of writeLog) {
      expect(path.endsWith('.vbak.part') || path.endsWith('.vblob'), path).toBe(true);
    }
  });
});
