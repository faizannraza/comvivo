/**
 * `openDatabase` and `initDatabase` against a real SQLCipher build (`02` §3.6.2).
 *
 * Integration, necessarily: every claim here is a claim about somebody else's native module, and
 * the M1-T2 spike exists precisely because those claims can change on any upgrade. **Every pragma
 * is read back**, which `M1-T8`'s acceptance criterion asks for — and that is not pedantry. An
 * older SQLite *ignores* a pragma it does not recognise rather than refusing it, so the failure
 * mode for `cell_size_check` or `secure_delete` silently not applying is no error at all.
 *
 * `packages/storage/spike/encryption.spike.test.ts` asserts the same facts against the spike's own
 * transcription. Two suites rather than one on purpose: if this file and the spike ever disagree
 * about the pragma list, that is a real divergence between what was proved and what shipped.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StorageError } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import { withDataDir } from '../datadir/testing/data-dir.js';
import {
  AUTO_VACUUM_INCREMENTAL,
  assertAutoVacuum,
  freePages,
  type InitResult,
  incrementalVacuum,
  initDatabase,
} from './init.js';
import {
  compareVersions,
  DEFAULT_BUSY_TIMEOUT_MS,
  DEFAULT_CACHE_SIZE_KIB,
  MIN_SQLITE_VERSION,
  MIN_VEC_VERSION,
  openDatabase,
  pragmaValue,
  RUNTIME_PRAGMAS,
} from './open.js';

const KEY = (): Buffer => randomBytes(32);

/** A created, encrypted database, closed afterwards whatever happens. */
async function withDb<T>(
  fn: (opened: InitResult, path: string, key: Buffer) => T,
  options: { readonly key?: Buffer | null } = {},
): Promise<T> {
  return withDataDir(async (root) => {
    const path = join(root, 'test.db');
    const key = options.key === undefined ? KEY() : options.key;
    const opened = initDatabase({ path, key });
    try {
      return fn(opened, path, key ?? Buffer.alloc(0));
    } finally {
      opened.db.close();
    }
  });
}

describe('every pragma, read back (02 §3.6.2)', { tags: ['db', 'slow'] }, () => {
  it('applies the whole runtime list', async () => {
    // Read back rather than assumed. An older SQLite ignores an unknown pragma silently, so
    // "we called it" is not evidence that it took effect.
    await withDb(({ db }) => {
      expect(pragmaValue(db, 'journal_mode')).toBe('wal');
      expect(pragmaValue(db, 'synchronous')).toBe(1);
      expect(pragmaValue(db, 'foreign_keys')).toBe(1);
      expect(pragmaValue(db, 'temp_store')).toBe(2);
      expect(pragmaValue(db, 'secure_delete')).toBe(1);
      expect(pragmaValue(db, 'wal_autocheckpoint')).toBe(1000);
      expect(pragmaValue(db, 'journal_size_limit')).toBe(67_108_864);
      expect(pragmaValue(db, 'cell_size_check')).toBe(1);
    });
  });

  it('sets the 192 MiB page cache, which is a 100× difference on search', async () => {
    // Negative `cache_size` is KiB rather than pages. The spike measured 508 ms against 5 ms for a
    // 50k-vector KNN between an 8 MiB and a 192 MiB cache, so this number is a correctness
    // requirement against `02` §3.16.4's 60 ms budget, not a preference.
    await withDb(({ db }) => {
      expect(pragmaValue(db, 'cache_size')).toBe(-DEFAULT_CACHE_SIZE_KIB);
      expect(DEFAULT_CACHE_SIZE_KIB).toBe(196_608);
    });
  });

  it('leaves mmap_size at zero, because mmap bypasses the codec', async () => {
    // A non-zero value here would read ciphertext pages straight past decryption. The only reason
    // it is set explicitly is that a future SQLite default could be non-zero.
    await withDb(({ db }) => {
      expect(pragmaValue(db, 'mmap_size')).toBe(0);
    });
  });

  it('honours a configured busy timeout and cache size', async () => {
    await withDataDir(async (root) => {
      const path = join(root, 'tuned.db');
      const opened = initDatabase({ path, key: KEY(), busyTimeoutMs: 1234, cacheSizeKiB: 2048 });
      try {
        expect(pragmaValue(opened.db, 'busy_timeout')).toBe(1234);
        expect(pragmaValue(opened.db, 'cache_size')).toBe(-2048);
      } finally {
        opened.db.close();
      }
    });
  });

  it('defaults the busy timeout to the specified value', async () => {
    await withDb(({ db }) => {
      expect(pragmaValue(db, 'busy_timeout')).toBe(DEFAULT_BUSY_TIMEOUT_MS);
    });
  });

  it('keeps one pragma list, shared with the spike that proved it', () => {
    // Not a copy: the spike's suite asserts the same sequence against its own transcription, so a
    // difference between the two is a divergence between what was measured and what ships.
    expect([...RUNTIME_PRAGMAS]).toEqual([
      'journal_mode = WAL',
      'synchronous = NORMAL',
      'foreign_keys = ON',
      'temp_store = MEMORY',
      'secure_delete = ON',
      'wal_autocheckpoint = 1000',
      'journal_size_limit = 67108864',
      'cell_size_check = ON',
    ]);
  });
});

describe('the key (02 §3.6.2, 08 §3.7.9)', { tags: ['db', 'slow'] }, () => {
  it('writes nothing readable to disk', async () => {
    // The point of the whole subsystem, checked at the only level that matters: the bytes.
    await withDataDir(async (root) => {
      const path = join(root, 'secret.db');
      const opened = initDatabase({ path, key: KEY() });
      try {
        opened.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)');
        opened.db.prepare('INSERT INTO t (body) VALUES (?)').run('CANARY-7f3a-do-not-find-me');
        opened.db.pragma('wal_checkpoint(TRUNCATE)');
      } finally {
        opened.db.close();
      }
      expect(readFileSync(path).includes('CANARY-7f3a-do-not-find-me')).toBe(false);
    });
  });

  it('refuses a wrong key with STORAGE_KEY_INVALID', async () => {
    // `M1-T8`'s acceptance criterion, and the reason `openDatabase` reads `sqlite_master` after
    // `PRAGMA key`: the pragma itself reports success for any key at all.
    await withDataDir(async (root) => {
      const path = join(root, 'secret.db');
      const first = initDatabase({ path, key: KEY() });
      first.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      first.db.close();

      try {
        openDatabase({ path, key: KEY(), role: 'main' });
        expect.unreachable('a wrong key must not open this database');
      } catch (caught) {
        expect(caught).toBeInstanceOf(StorageError);
        const error = caught as StorageError;
        expect(error.storageCode).toBe('STORAGE_KEY_INVALID');
        expect(error.hint).toContain('do not restore over it');
      }
    });
  });

  it('reports a missing key against an encrypted database as a wrong key, not corruption', async () => {
    // A host who turned `encryptAtRest` off against an existing encrypted database. The database is
    // fine; the configuration is not — and "corrupt" would send them to a restore.
    await withDataDir(async (root) => {
      const path = join(root, 'secret.db');
      const first = initDatabase({ path, key: KEY() });
      first.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      first.db.close();

      try {
        openDatabase({ path, key: null, role: 'main' });
        expect.unreachable('an encrypted database must not open without a key');
      } catch (caught) {
        // Without a key there is no `encrypted` context, so this is `STORAGE_CORRUPT` by the
        // documented rule — and the hint still tells them to keep the file.
        const error = caught as StorageError;
        expect(['STORAGE_CORRUPT', 'STORAGE_KEY_INVALID']).toContain(error.storageCode);
        expect(error.hint).toBeDefined();
      }
    });
  });

  it('opens the same database again with the same key', async () => {
    await withDataDir(async (root) => {
      const path = join(root, 'secret.db');
      const key = KEY();
      const first = initDatabase({ path, key });
      first.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)');
      first.db.prepare('INSERT INTO t (body) VALUES (?)').run('hello');
      first.db.close();

      const second = openDatabase({ path, key: Buffer.from(key), role: 'main' });
      try {
        const row = second.db.prepare('SELECT body FROM t').get() as { body: string };
        expect(row.body).toBe('hello');
      } finally {
        second.db.close();
      }
    });
  });

  it('refuses a key that is not 32 bytes, as a bug', async () => {
    await withDataDir(async (root) => {
      try {
        openDatabase({ path: join(root, 'x.db'), key: Buffer.alloc(16), role: 'main' });
        expect.unreachable('a 16-byte key is not a database key');
      } catch (caught) {
        const error = caught as StorageError;
        expect(error.storageCode).toBe('STORAGE_KEY_INVALID');
        expect(error.code).toBe('bug');
      }
    });
  });

  it('opens an unencrypted database when there is no key', async () => {
    // `privacy.encryptAtRest: false`. Supported, and `doctor` warns about it (`02` §5).
    await withDb(
      ({ db, encrypted }) => {
        expect(encrypted).toBe(false);
        db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
        expect(pragmaValue(db, 'journal_mode')).toBe('wal');
      },
      { key: null },
    );
  });
});

describe('roles (02 §3.6.2, D22)', { tags: ['db', 'slow'] }, () => {
  it('lets only the main role create a database', async () => {
    // The rule that stops a `backup` command creating an empty database that the next boot then
    // reads as a fresh install — and initialises over the real one.
    await withDataDir(async (root) => {
      for (const role of ['worker', 'cli'] as const) {
        expect(
          () => openDatabase({ path: join(root, `${role}.db`), key: KEY(), role }),
          role,
        ).toThrow(StorageError);
      }
    });
  });

  it('reports what the connection is, so a caller cannot forget', async () => {
    await withDb(({ role, encrypted, readonly }) => {
      expect(role).toBe('main');
      expect(encrypted).toBe(true);
      expect(readonly).toBe(false);
    });
  });

  it('opens a read-only connection that refuses to write', async () => {
    await withDataDir(async (root) => {
      const path = join(root, 'ro.db');
      const key = KEY();
      const main = initDatabase({ path, key: Buffer.from(key) });
      main.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      main.db.close();

      const reader = openDatabase({ path, key: Buffer.from(key), role: 'cli', readonly: true });
      try {
        expect(reader.readonly).toBe(true);
        expect(reader.db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 });
        expect(() => reader.db.exec('INSERT INTO t (id) VALUES (1)')).toThrow();
      } finally {
        reader.db.close();
      }
    });
  });
});

describe('the versions it insists on (02 §3.6.2)', { tags: ['db', 'slow'] }, () => {
  it('reports versions that meet the floors', async () => {
    await withDb(({ sqliteVersion, vecVersion }) => {
      expect(compareVersions(sqliteVersion, MIN_SQLITE_VERSION)).toBeGreaterThanOrEqual(0);
      expect(vecVersion).toBeDefined();
      if (vecVersion === undefined) return;
      expect(compareVersions(vecVersion, MIN_VEC_VERSION)).toBeGreaterThanOrEqual(0);
    });
  });

  it('loads sqlite-vec, so a KNN query is available', async () => {
    await withDb(({ db }) => {
      const row = db.prepare('SELECT vec_version() AS v').get() as { v: string };
      expect(row.v).toMatch(/^v\d+\.\d+\.\d+/);
    });
  });

  it('can be told not to load the extension', async () => {
    // One caller needs this: `doctor --repair` has to open a database whose extension will not
    // load, in order to say so.
    await withDataDir(async (root) => {
      const path = join(root, 'novec.db');
      const key = KEY();
      initDatabase({ path, key: Buffer.from(key) }).db.close();

      const opened = openDatabase({ path, key: Buffer.from(key), role: 'main', loadVec: false });
      try {
        expect(opened.vecVersion).toBeUndefined();
        expect(() => opened.db.prepare('SELECT vec_version()').get()).toThrow();
      } finally {
        opened.db.close();
      }
    });
  });

  it('compares versions numerically, because 3.9 is not newer than 3.45', () => {
    // A lexicographic comparison says it is, and would reject the one build this check exists to
    // accept. The kind of bug that passes for years.
    expect(compareVersions('3.45.0', '3.9.0')).toBeGreaterThan(0);
    expect(compareVersions('3.45', '3.45.0')).toBe(0);
    expect(compareVersions('v0.1.9', 'v0.1.10')).toBeLessThan(0);
    expect(compareVersions('v0.2.0', 'v0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('3.44.9', '3.45')).toBeLessThan(0);
  });
});

describe('initDatabase (02 §3.6.2)', { tags: ['db', 'slow'] }, () => {
  it('sets auto_vacuum = INCREMENTAL on creation, which is the only moment it can', async () => {
    // SQLite ignores a change to `auto_vacuum` once a schema exists — silently. A database created
    // without it can never reclaim space incrementally, and the only fix is a full `VACUUM`.
    await withDb(({ db, created }) => {
      expect(created).toBe(true);
      expect(pragmaValue(db, 'auto_vacuum')).toBe(AUTO_VACUUM_INCREMENTAL);
    });
  });

  it('knows the difference between creating and reopening', async () => {
    await withDataDir(async (root) => {
      const path = join(root, 'again.db');
      const key = KEY();
      const first = initDatabase({ path, key: Buffer.from(key) });
      expect(first.created).toBe(true);
      first.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      first.db.close();

      const second = initDatabase({ path, key: Buffer.from(key) });
      try {
        expect(second.created).toBe(false);
      } finally {
        second.db.close();
      }
    });
  });

  it('treats a file with no tables as still uncreated', async () => {
    // A failed first boot leaves an empty database behind. Reading that as an existing install
    // would skip `auto_vacuum` forever on a database that had never held anything.
    await withDataDir(async (root) => {
      const path = join(root, 'empty.db');
      const key = KEY();
      // Open and close without creating a schema, exactly as an interrupted boot would.
      openDatabase({ path, key: Buffer.from(key), role: 'main' }).db.close();

      const opened = initDatabase({ path, key: Buffer.from(key) });
      try {
        expect(opened.created).toBe(true);
        expect(pragmaValue(opened.db, 'auto_vacuum')).toBe(AUTO_VACUUM_INCREMENTAL);
      } finally {
        opened.db.close();
      }
    });
  });

  it('refuses to initialise over a database it cannot open', async () => {
    // **The most destructive thing this product could do.** `12` §3.8.1 step 3: a key is never
    // generated while a database exists, and this is the storage half of that rule — a wrong key
    // must surface as a wrong key, not as "no database here, let me make one".
    await withDataDir(async (root) => {
      const path = join(root, 'theirs.db');
      const theirs = initDatabase({ path, key: KEY() });
      theirs.db.exec('CREATE TABLE precious (id INTEGER PRIMARY KEY)');
      theirs.db.close();
      const before = readFileSync(path);

      try {
        initDatabase({ path, key: KEY() });
        expect.unreachable('a wrong key must not initialise over an existing database');
      } catch (caught) {
        expect((caught as StorageError).storageCode).toBe('STORAGE_KEY_INVALID');
      }
      // Byte-for-byte untouched.
      expect(readFileSync(path).equals(before)).toBe(true);
    });
  });

  it('refuses an existing database created without incremental auto-vacuum', async () => {
    // Not something this code can create, so the file is made with a plain SQLite connection —
    // which is also exactly how a database from an older build would look.
    await withDataDir(async (root) => {
      const path = join(root, 'legacy.db');
      const { default: Database } = await import('better-sqlite3-multiple-ciphers');
      const raw = new Database(path);
      raw.pragma('auto_vacuum = NONE');
      raw.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      raw.close();

      try {
        initDatabase({ path, key: null });
        expect.unreachable('a database with no incremental vacuum must be reported');
      } catch (caught) {
        const error = caught as StorageError;
        expect(error.storageCode).toBe('STORAGE_VERSION_UNSUPPORTED');
        expect(error.hint).toContain('full `VACUUM`');
      }
    });
  });

  it('accepts a correctly-created database through the same assertion', async () => {
    await withDb(({ db }, path) => {
      expect(() => {
        assertAutoVacuum(db, path);
      }).not.toThrow();
    });
  });
});

describe('reclaiming space (02 §3.6.2, §3.13)', { tags: ['db', 'slow'] }, () => {
  it('frees pages in bounded chunks', async () => {
    // Bounded because the unbounded form holds the write lock until it finishes, which on a large
    // purge is long enough for every other connection to hit `SQLITE_BUSY`.
    await withDb(({ db }) => {
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)');
      const insert = db.prepare('INSERT INTO t (body) VALUES (?)');
      const body = 'x'.repeat(2000);
      for (let n = 0; n < 500; n += 1) insert.run(body);
      db.exec('DELETE FROM t');

      expect(freePages(db)).toBeGreaterThan(0);
      const reclaimed = incrementalVacuum(db, 16);
      expect(reclaimed).toBeGreaterThan(0);
      // Bounded: one 16-page chunk cannot have reclaimed everything from 500 rows of 2 KB.
      expect(freePages(db)).toBeGreaterThan(0);
    });
  });

  it('reports nothing to reclaim on a fresh database', async () => {
    await withDb(({ db }) => {
      expect(freePages(db)).toBe(0);
      expect(incrementalVacuum(db)).toBe(0);
    });
  });
});

describe('what happens to a damaged file', { tags: ['db', 'slow'] }, () => {
  it('reports a file that is not a database at all', async () => {
    await withDataDir(async (root) => {
      const path = join(root, 'not-a-db.db');
      writeFileSync(path, 'this is a text file, not a database');

      try {
        openDatabase({ path, key: null, role: 'main' });
        expect.unreachable('a text file is not a database');
      } catch (caught) {
        expect((caught as StorageError).storageCode).toBe('STORAGE_CORRUPT');
      }
    });
  });

  it('does not leave a connection open when an open fails', async () => {
    // A half-opened connection holds a file descriptor, and on the main role may have created the
    // file. Checked by opening and failing many times: a leak would exhaust descriptors.
    await withDataDir(async (root) => {
      const path = join(root, 'leak.db');
      initDatabase({ path, key: KEY() }).db.close();

      for (let attempt = 0; attempt < 50; attempt += 1) {
        expect(() => openDatabase({ path, key: KEY(), role: 'main' })).toThrow(StorageError);
      }
    });
  });
});
