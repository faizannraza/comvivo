/**
 * The pre-migration backup, the data-migration mechanism, and the parts of the runner the
 * end-to-end suite does not reach (`M1-T14`).
 *
 * `migrations.int.test.ts` exercises the real migrations against a real database. This covers the
 * paths that only appear when something goes wrong or when an option is set — and `backup.ts`
 * above all, because `02` §3.12.2 makes upgrades forward-only, which makes the backup **the**
 * rollback path. A rollback path nobody has run is a rollback path that does not work.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND, exitCodeFor, StorageError } from '@comvivo/shared';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/open.js';
import {
  assertSpaceForBackup,
  databaseBytesOf,
  mainDatabaseFile,
  nodeSpaceProbe,
  PRE_MIGRATE_DIR,
  preMigrationBackup,
  preMigrationBackupName,
  pruneOldBackups,
  REQUIRED_FREE_SPACE_MULTIPLE,
  type SpaceProbe,
} from './backup.js';
import { type DataMigration, dataMigrationFor, dataMigrations } from './data/index.js';
import { assertLockMatches, lockFor, readLock, writeLock } from './lock.js';
import { appliedMigrations, hasUserTables, MIGRATIONS_TABLE, migrate } from './runner.js';
import { compareVersions, SNAPSHOT_PATTERN, snapshotFixtures } from './snapshots.js';
import { type Migration, staticMigrationSource } from './source.js';

const temporaries: string[] = [];
afterEach(() => {
  for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), `${BRAND.slug}-parts-`));
  temporaries.push(path);
  return path;
}

/** A database with one table holding a row, so it counts as non-empty. */
function seededDb(file: string): Database.Database {
  const db = new Database(file);
  db.exec('CREATE TABLE things (id INTEGER PRIMARY KEY, note TEXT)');
  db.prepare("INSERT INTO things (note) VALUES ('kept')").run();
  return db;
}

/**
 * The same database, **encrypted** — which is what every default install is.
 *
 * Opened through `openDatabase` so the cipher, the `legacy=4` compatibility and the hex validation
 * are the product's own. This fixture is the one the suite was missing: with only the plaintext
 * one above, `preMigrationBackup`'s verification opened an *encrypted* snapshot with no key, threw
 * a raw `SQLITE_NOTADB`, and every migration of a real host would have stopped there. Found at
 * `M1-T27`.
 */
function seededEncryptedDb(file: string, key: Buffer): Database.Database {
  // `role: 'main'` because this creates the file; every other role sets `fileMustExist`.
  const { db } = openDatabase({ path: file, key, role: 'main', loadVec: false });
  db.exec('CREATE TABLE things (id INTEGER PRIMARY KEY, note TEXT)');
  db.prepare("INSERT INTO things (note) VALUES ('kept')").run();
  return db;
}

/** A 32-byte key, fixed so a failure is reproducible. */
const DB_KEY = Buffer.alloc(32, 0x5e);

const migrationOf = (id: string, sql: readonly string[]): Migration => ({
  id,
  sql,
  checksum: `sum-${id}`,
});

describe('the pre-migration backup (02 §3.12.4)', { tags: ['db'] }, () => {
  it('writes a verified copy named from the migration range', () => {
    const root = tempDir();
    const db = seededDb(join(root, 'data.db'));
    try {
      const path = preMigrationBackup(db, {
        key: null,
        backupDir: join(root, 'backups'),
        fromLastId: '0001_two',
        toLastId: '0003_four',
        keep: 3,
        nowMs: 1_700_000_000_000,
      });
      expect(path).toContain(join('backups', PRE_MIGRATE_DIR));
      expect(path.endsWith('0001_two__0003_four__1700000000000.db')).toBe(true);
      expect(existsSync(path)).toBe(true);

      // The copy is a usable database holding the same row — a backup that cannot be opened is
      // the failure mode `quick_check` exists to catch, and this is the positive case.
      const copy = new Database(path, { readonly: true });
      try {
        expect((copy.prepare('SELECT note FROM things').get() as { note: string }).note).toBe(
          'kept',
        );
        expect(copy.pragma('quick_check', { simple: true })).toBe('ok');
      } finally {
        copy.close();
      }
    } finally {
      db.close();
    }
  });

  it('names an empty history `empty` rather than omitting it', () => {
    expect(
      // Narrowed to the three fields the name is built from, so a function that does not need a
      // key does not demand one — a signature over-wide by a `Pick` is a signature that lies.
      preMigrationBackupName({
        fromLastId: 'empty',
        toLastId: '0000_initial_schema',
        nowMs: 1,
      }),
    ).toBe('empty__0000_initial_schema__1.db');
  });

  it('fails loudly when the copy cannot be written', () => {
    // Migrations are forward-only, so an upgrade must not start without its rollback path. A
    // backup that silently did not happen is worse than a refused upgrade.
    const root = tempDir();
    const db = seededDb(join(root, 'data.db'));
    try {
      const attempt = () =>
        preMigrationBackup(db, {
          key: null,
          // A path whose parent is a *file*, so `mkdirSync` cannot create the directory.
          backupDir: join(root, 'data.db', 'nope'),
          fromLastId: 'empty',
          toLastId: '0000_x',
          keep: 3,
          nowMs: 1,
        });
      expect(attempt).toThrow(StorageError);
    } finally {
      db.close();
    }
  });

  it('verifies an encrypted snapshot, which a keyless open cannot do', () => {
    const root = tempDir();
    const db = seededEncryptedDb(join(root, 'data.db'), DB_KEY);
    try {
      // The positive case for every real host. `VACUUM INTO` under SQLite3MultipleCiphers writes an
      // **encrypted** copy (SP-3, asserted at `M1-T2`), so the `quick_check` that makes it a
      // rollback path has to open it with the same key.
      const path = preMigrationBackup(db, {
        key: DB_KEY,
        backupDir: join(root, 'backups'),
        fromLastId: 'empty',
        toLastId: '0001_one',
        keep: 3,
        nowMs: 1_700_000_000_001,
      });
      expect(existsSync(path)).toBe(true);

      // And the snapshot really is encrypted — otherwise this test would pass against a build that
      // wrote plaintext backups, which is the far worse failure.
      expect(() => new Database(path, { readonly: true }).pragma('quick_check')).toThrow();
      const copy = openDatabase({ path, key: DB_KEY, readonly: true, role: 'cli', loadVec: false });
      try {
        expect((copy.db.prepare('SELECT note FROM things').get() as { note: string }).note).toBe(
          'kept',
        );
      } finally {
        copy.db.close();
      }
    } finally {
      db.close();
    }
  });

  it('refuses an encrypted snapshot it was given the wrong key for', () => {
    const root = tempDir();
    const db = seededEncryptedDb(join(root, 'data.db'), DB_KEY);
    try {
      // A verification that cannot open the copy must **fail**, not pass. This is the case the
      // keyless version got wrong in the other direction: it could never open an encrypted copy,
      // so it never verified one.
      expect(() =>
        preMigrationBackup(db, {
          key: Buffer.alloc(32, 0x99),
          backupDir: join(root, 'backups'),
          fromLastId: 'empty',
          toLastId: '0001_one',
          keep: 3,
          nowMs: 1_700_000_000_002,
        }),
      ).toThrow(StorageError);
    } finally {
      db.close();
    }
  });

  it('refuses to overwrite an existing copy', () => {
    // `VACUUM INTO` will not overwrite, and that is the behaviour we want: a name collision means
    // two upgrades started in the same millisecond, and replacing the first copy would destroy
    // the only rollback path for one of them.
    const root = tempDir();
    const db = seededDb(join(root, 'data.db'));
    const options = {
      key: null,
      backupDir: join(root, 'backups'),
      fromLastId: 'empty',
      toLastId: '0000_x',
      keep: 5,
      nowMs: 42,
    };
    try {
      preMigrationBackup(db, options);
      expect(() => preMigrationBackup(db, options)).toThrow(StorageError);
    } finally {
      db.close();
    }
  });

  it('keeps the newest copies and prunes by age, not by name', () => {
    // The names begin with the *from* id, so sorting by name would evict by migration order
    // rather than by age — and a re-run of the same upgrade would delete the copy taken before
    // the first attempt, which is the one actually wanted.
    const directory = join(tempDir(), PRE_MIGRATE_DIR);
    mkdirSync(directory, { recursive: true });
    const names = ['0009_z__0010_z__1.db', '0001_a__0002_a__2.db', '0005_m__0006_m__3.db'];
    for (const [index, name] of names.entries()) {
      const path = join(directory, name);
      new Database(path).close();
      // Oldest first in this order: index 0 is the oldest.
      const seconds = 1_700_000_000 + index * 60;
      utimesSync(path, seconds, seconds);
    }
    const removed = pruneOldBackups(directory, 2);
    expect(removed).toEqual(['0009_z__0010_z__1.db']);
    expect(readdirSync(directory).sort()).toEqual(['0001_a__0002_a__2.db', '0005_m__0006_m__3.db']);
  });

  it('does nothing when the directory is absent or the count is negative', () => {
    expect(pruneOldBackups(join(tempDir(), 'missing'), 3)).toEqual([]);
    expect(pruneOldBackups(tempDir(), -1)).toEqual([]);
  });
});

describe('the runner’s backup integration', { tags: ['db'] }, () => {
  it('backs up a non-empty database and not an empty one', () => {
    const root = tempDir();
    const backupDir = join(root, 'backups');
    const source = staticMigrationSource([migrationOf('0000_a', ['CREATE TABLE a (x INTEGER)'])]);

    // Fresh install: nothing to lose, so no backup — `00` §3 holds first run to five minutes.
    const fresh = new Database(join(root, 'fresh.db'));
    try {
      const result = migrate(fresh, source, { appVersion: '1', backupDir, nowMs: () => 1 });
      expect(result.backupPath).toBeUndefined();
      expect(existsSync(join(backupDir, PRE_MIGRATE_DIR))).toBe(false);
    } finally {
      fresh.close();
    }

    // A database with user tables gets one.
    const existing = seededDb(join(root, 'existing.db'));
    try {
      expect(hasUserTables(existing)).toBe(true);
      const result = migrate(existing, source, { appVersion: '1', backupDir, nowMs: () => 2 });
      expect(result.backupPath).toBeDefined();
      expect(existsSync(result.backupPath ?? '')).toBe(true);
    } finally {
      existing.close();
    }
  });

  it('honours keepPreMigration', () => {
    const root = tempDir();
    const backupDir = join(root, 'backups');
    const db = seededDb(join(root, 'data.db'));
    try {
      // Cumulative sources, because the runner raises `SCHEMA_TOO_NEW` for an applied migration
      // its source no longer lists — which is the correct behaviour and was what the first
      // version of this test tripped over.
      const all = ['0000_a', '0001_b', '0002_c'].map((id) =>
        migrationOf(id, [`CREATE TABLE "${id}" (x INTEGER)`]),
      );
      for (let step = 1; step <= all.length; step += 1) {
        migrate(db, staticMigrationSource(all.slice(0, step)), {
          appVersion: '1',
          backupDir,
          keepPreMigration: 2,
          nowMs: () => step,
        });
      }
      expect(readdirSync(join(backupDir, PRE_MIGRATE_DIR))).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});

describe('data migrations (02 §3.12.1)', { tags: ['db'] }, () => {
  it('runs after the SQL of the same id, inside the same transaction', () => {
    // One transaction is the point: a data migration that committed separately could leave the
    // schema changed and the data not, with no record of which half ran.
    const root = tempDir();
    const db = new Database(join(root, 'data.db'));
    const dataMigration: DataMigration = {
      id: '0000_a',
      run(target) {
        target.prepare("INSERT INTO a (note) VALUES ('from the data migration')").run();
      },
    };
    try {
      migrate(
        db,
        staticMigrationSource([
          {
            ...migrationOf('0000_a', ['CREATE TABLE a (id INTEGER PRIMARY KEY, note TEXT)']),
            dataMigration,
          },
        ]),
        { appVersion: '1', nowMs: () => 1 },
      );
      expect((db.prepare('SELECT note FROM a').get() as { note: string }).note).toBe(
        'from the data migration',
      );
      // Recorded as `sql+data`, so `comvivo migrate status` can show which ran code.
      expect(appliedMigrations(db)[0]?.kind).toBe('sql+data');
    } finally {
      db.close();
    }
  });

  it('rolls the SQL back when the data migration throws', () => {
    const root = tempDir();
    const db = new Database(join(root, 'data.db'));
    try {
      expect(() =>
        migrate(
          db,
          staticMigrationSource([
            {
              ...migrationOf('0000_a', ['CREATE TABLE a (x INTEGER)']),
              dataMigration: {
                id: '0000_a',
                run() {
                  throw new Error('backfill failed');
                },
              },
            },
          ]),
          { appVersion: '1', nowMs: () => 1 },
        ),
      ).toThrow(/0000_a failed/);
      // The table is gone: one transaction, so the schema change went with it.
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'a'")
        .all();
      expect(tables).toEqual([]);
      expect(appliedMigrations(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('has an empty registry, and a lookup that answers for an unknown id', () => {
    expect(dataMigrations()).toEqual([]);
    expect(dataMigrationFor('0000_initial_schema')).toBeUndefined();
  });
});

describe('the runner’s failure paths', { tags: ['db'] }, () => {
  it('rolls back and reports a foreign key violation', () => {
    // A table rebuild that does not carry its children over is the usual cause, and the failure
    // is otherwise invisible until a later query trips over the dangling row.
    const root = tempDir();
    const db = new Database(join(root, 'data.db'));
    try {
      expect(() =>
        migrate(
          db,
          staticMigrationSource([
            migrationOf('0000_a', [
              'CREATE TABLE parent (id INTEGER PRIMARY KEY)',
              'CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))',
              // Inserted while `foreign_keys` is OFF, so only `foreign_key_check` can see it.
              'INSERT INTO child (id, parent_id) VALUES (1, 999)',
            ]),
          ]),
          { appVersion: '1', nowMs: () => 1 },
        ),
      ).toThrow(/foreign key violation/);
      expect(appliedMigrations(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('skips a foreign_keys pragma a migration contains', () => {
    // Such a statement is a no-op where it sits — SQLite ignores the pragma inside a transaction —
    // and its presence means the author expected it to work, so the runner does the toggling.
    const root = tempDir();
    const db = new Database(join(root, 'data.db'));
    try {
      migrate(
        db,
        staticMigrationSource([
          migrationOf('0000_a', [
            'PRAGMA foreign_keys=OFF',
            'CREATE TABLE a (x INTEGER)',
            'PRAGMA foreign_keys = ON',
          ]),
        ]),
        { appVersion: '1', nowMs: () => 1 },
      );
      expect(appliedMigrations(db)).toHaveLength(1);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      db.close();
    }
  });

  it('wraps a plain SQL error with the migration that produced it', () => {
    const root = tempDir();
    const db = new Database(join(root, 'data.db'));
    try {
      const attempt = () =>
        migrate(db, staticMigrationSource([migrationOf('0007_bad', ['NOT SQL AT ALL'])]), {
          appVersion: '1',
          nowMs: () => 1,
        });
      expect(attempt).toThrow(/0007_bad/);
      try {
        attempt();
      } catch (error) {
        expect((error as StorageError).storageCode).toBe('MIGRATION_FAILED');
        // No `backupDir` here, so there is no backup — and the hint has to say that rather than
        // point at a rollback that does not exist.
        expect((error as StorageError).hint).toContain('no pre-migration backup');
        // And names no command: `${BRAND.cliName} …` in a hint is a promise the M1 binary cannot
        // keep, which is the defect this pair of tests pins.
        expect((error as StorageError).hint).not.toContain(`${BRAND.cliName} `);
      }
    } finally {
      db.close();
    }
  });

  it('names the backup file in the hint when the run took one', () => {
    // The reason this is asserted on the *path*: the hint used to read `comvivo restore
    // pre-migrate:latest`, a command that does not exist until the CLI ships in `M9`, so a host
    // whose upgrade failed was given an instruction that answers "command not found". Found by the
    // M1 exit gate's reviewer.
    const root = tempDir();
    const backupDir = join(root, 'backups');
    const db = seededDb(join(root, 'data.db'));
    try {
      let hint = '';
      let detail: unknown;
      try {
        migrate(db, staticMigrationSource([migrationOf('0007_bad', ['NOT SQL AT ALL'])]), {
          appVersion: '1',
          backupDir,
          nowMs: () => 1,
        });
      } catch (error) {
        hint = (error as StorageError).hint ?? '';
        detail = (error as StorageError).detail;
      }
      const written = readdirSync(join(backupDir, PRE_MIGRATE_DIR));
      expect(written).toHaveLength(1);
      const path = join(backupDir, PRE_MIGRATE_DIR, written[0] ?? '');
      // The exact file, not the directory: at two in the morning the difference is whether the
      // host has to pick between three snapshots by reading mtimes.
      expect(hint).toContain(path);
      expect(hint).toContain(join(root, 'data.db'));
      expect(hint).toContain('-wal');
      expect(detail).toMatchObject({ id: '0007_bad', backupPath: path });
    } finally {
      db.close();
    }
  });

  it('creates the bookkeeping table only once', () => {
    const root = tempDir();
    const db = new Database(join(root, 'data.db'));
    try {
      expect(appliedMigrations(db)).toEqual([]);
      expect(appliedMigrations(db)).toEqual([]);
      const count = db
        .prepare('SELECT count(*) AS n FROM sqlite_master WHERE name = ?')
        .get(MIGRATIONS_TABLE) as { n: number };
      expect(count.n).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('the lock file round-trips', () => {
  it('writes and reads a lock, keeping its comment', () => {
    const path = join(tempDir(), 'migrations.lock.json');
    const source = staticMigrationSource([migrationOf('0000_a', ['CREATE TABLE a (x INTEGER)'])]);
    writeLock(path, lockFor({ released: {} }, source, 'v1.0.0'), 'a comment');
    const lock = readLock(path);
    expect(lock.released['0000_a']).toEqual({ checksum: 'sum-0000_a', release: 'v1.0.0' });
    expect(() => assertLockMatches(lock, source)).not.toThrow();
  });

  it('treats an absent lock as empty rather than as an error', () => {
    // A checkout without the file is a developer who has not released anything, not a failure.
    expect(readLock(join(tempDir(), 'nope.json'))).toEqual({ released: {} });
  });

  it('ignores a migration on disk that the lock does not mention', () => {
    // Every unreleased migration is in that state, so this asymmetry is the normal case.
    const source = staticMigrationSource([
      migrationOf('0000_a', ['CREATE TABLE a (x INTEGER)']),
      migrationOf('0001_unreleased', ['CREATE TABLE b (x INTEGER)']),
    ]);
    const lock = { released: { '0000_a': { checksum: 'sum-0000_a', release: 'v1.0.0' } } };
    expect(() => assertLockMatches(lock, source)).not.toThrow();
  });
});

describe('snapshot discovery', () => {
  it('orders versions numerically, not lexicographically', () => {
    // `v0.10.0` after `v0.9.0`: the string order would upgrade them in the wrong sequence and the
    // failure would look like a migration bug.
    const names = ['v0.9.0.sqlite.gz', 'v0.10.0.sqlite.gz', 'v0.2.0.sqlite.gz', 'v1.0.0.sqlite.gz'];
    expect([...names].sort(compareVersions)).toEqual([
      'v0.2.0.sqlite.gz',
      'v0.9.0.sqlite.gz',
      'v0.10.0.sqlite.gz',
      'v1.0.0.sqlite.gz',
    ]);
  });

  it('finds only files matching the release pattern', () => {
    const directory = tempDir();
    for (const name of ['v0.1.0.sqlite.gz', 'v0.2.0.sqlite.gz', 'notes.md', 'v0.1.0.sqlite']) {
      new Database(join(directory, 'ignored.db')).close();
      writeEmpty(join(directory, name));
    }
    expect(snapshotFixtures(directory).map((path) => path.split('/').pop())).toEqual([
      'v0.1.0.sqlite.gz',
      'v0.2.0.sqlite.gz',
    ]);
    expect(SNAPSHOT_PATTERN.test('v0.1.0.sqlite.gz')).toBe(true);
    expect(SNAPSHOT_PATTERN.test('v0.1.sqlite.gz')).toBe(false);
  });

  it('returns nothing when the directory is absent', () => {
    expect(snapshotFixtures(join(tempDir(), 'missing'))).toEqual([]);
  });
});

/** Create an empty file. */
function writeEmpty(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  rmSync(path, { force: true });
  const db = new Database(path);
  db.close();
  expect(statSync(path).isFile()).toBe(true);
}

describe('the free-space guard (12 §3.7 step 6)', () => {
  // `12` §3.7 step 6 requires free space ≥ 2.2× the database size before the backup, "else 75".
  // `REQUIRED_FREE_SPACE_MULTIPLE` existed, said `2`, and **nothing read it** — there was no
  // `statfs` call anywhere in `backup.ts`, so the requirement was published with no code behind it.
  // Found by the M1 independent review, which noticed the constant had no caller.
  const full: SpaceProbe = { freeBytes: () => 0 };
  const roomy: SpaceProbe = { freeBytes: () => 10 * 1_048_576 };

  it('is the multiple the spec states', () => {
    expect(REQUIRED_FREE_SPACE_MULTIPLE).toBe(2.2);
  });

  it('refuses when free space is below the multiple, with the code that maps to 75', () => {
    const caught = (() => {
      try {
        assertSpaceForBackup(1_000_000, '/anywhere', full);
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    expect(caught).toBeInstanceOf(StorageError);
    const error = caught as StorageError;
    expect(error.storageCode).toBe('STORAGE_DISK_SPACE_LOW');
    expect(exitCodeFor(error)).toBe(75);
    // The message has to be actionable: how much is needed and how much there is.
    expect(error.hint).toContain('free');
    expect(error.detail?.['neededBytes']).toBe(2_200_000);
    expect(error.detail?.['freeBytes']).toBe(0);
  });

  it('accepts exactly the multiple, and refuses one byte less', () => {
    // The boundary in both directions, because an off-by-one here either blocks an upgrade that
    // would have worked or allows one that runs out of space mid-migration.
    const bytes = 1_000_000;
    const needed = bytes * 2.2;
    expect(() => {
      assertSpaceForBackup(bytes, '/anywhere', { freeBytes: () => needed });
    }).not.toThrow();
    expect(() => {
      assertSpaceForBackup(bytes, '/anywhere', { freeBytes: () => needed - 1 });
    }).toThrow(StorageError);
  });

  it('allows the upgrade when the platform cannot answer', () => {
    // Deliberate: this check turns a predictable out-of-space into a clean refusal. A platform
    // whose `statfs` fails should not be able to stop an upgrade that would have worked — the
    // failure mode of being wrong here is refusing every upgrade on that platform forever.
    expect(() => {
      assertSpaceForBackup(1_000_000, '/anywhere', { freeBytes: () => undefined });
    }).not.toThrow();
  });

  it('reads the real filesystem through nodeSpaceProbe', () => {
    // Non-vacuity for the default: every case above injects a probe, so without this the real one
    // could return `undefined` always and the guard would be permanently inert.
    // `tempDir()` rather than `tmpdir()`: the probe only reads, so either would do, but
    // `scripts/hygiene`'s `no-shared-temp-dir` is a line scanner that cannot tell reading from
    // creating, and it is right that a test naming a fixed temp path is worth a second look.
    const free = nodeSpaceProbe.freeBytes(tempDir());
    expect(free).toBeTypeOf('number');
    expect(free ?? 0).toBeGreaterThan(0);
  });

  it('measures the database and its WAL', () => {
    {
      const dir = tempDir();
      const file = join(dir, 'size.db');
      const db = new Database(file);
      try {
        db.pragma('journal_mode = WAL');
        db.exec('CREATE TABLE t (x TEXT)');
        const insert = db.prepare('INSERT INTO t (x) VALUES (?)');
        for (let i = 0; i < 500; i += 1) insert.run('x'.repeat(200));
        const measured = databaseBytesOf(db);
        // Bigger than the main file alone, because the WAL holds the writes until a checkpoint —
        // and the WAL is exactly the part a naive `statSync` on the database would miss.
        expect(measured).toBeGreaterThan(statSync(file).size);
      } finally {
        db.close();
      }
    }
  });

  it('answers nothing for an in-memory database, which has no file', () => {
    // `mainDatabaseFile` is what the failed-migration hint names, and `databaseBytesOf` is what
    // the space check measures — so the in-memory case has to be a clean "no file" rather than an
    // empty path reaching `statSync`. Every other test here uses a real file, which is how this
    // branch went uncovered when the helper was extracted at the M1 exit gate.
    const db = new Database(':memory:');
    try {
      expect(mainDatabaseFile(db)).toBeUndefined();
      expect(databaseBytesOf(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('names the file of a database that has one', () => {
    const dir = tempDir();
    const file = join(dir, 'named.db');
    const db = new Database(file);
    try {
      // `endsWith`, not equality: on macOS `/var` is a symlink to `/private/var`, and SQLite
      // reports the resolved path while `mkdtemp` returns the one it was given.
      expect(mainDatabaseFile(db)).toMatch(/named\.db$/);
      expect(mainDatabaseFile(db)).toContain(`${BRAND.slug}-parts-`);
    } finally {
      db.close();
    }
  });

  it('reports the free space of a path that does not exist as unknown', () => {
    // The `catch` in `nodeSpaceProbe.freeBytes`: `statfs` on a missing path fails, and the probe
    // answers `undefined` so `assertSpaceForBackup` allows the upgrade rather than refusing one
    // that would have worked. Asserted because an exception here would escape as a raw `ENOENT`
    // from inside a space check.
    expect(nodeSpaceProbe.freeBytes(join(tempDir(), 'no', 'such', 'path'))).toBeUndefined();
  });

  it('refuses a real backup on a disk the probe reports as full', () => {
    // End to end through `preMigrationBackup`, so the guard is proven to be *wired* and not just
    // exported. The directory is created first either way, which is what lets the probe read the
    // filesystem the copy would land on.
    {
      const dir = tempDir();
      const db = new Database(join(dir, 'src.db'));
      try {
        db.exec('CREATE TABLE t (x TEXT)');
        expect(() =>
          preMigrationBackup(db, {
            key: null,
            backupDir: join(dir, 'backups'),
            fromLastId: 'empty',
            toLastId: '0001',
            keep: 3,
            nowMs: 1,
            space: full,
          }),
        ).toThrow(/not enough free space/);
        // And it succeeds with room, so the refusal is about space rather than about the backup
        // being broken.
        expect(
          preMigrationBackup(db, {
            key: null,
            backupDir: join(dir, 'backups'),
            fromLastId: 'empty',
            toLastId: '0001',
            keep: 3,
            nowMs: 2,
            space: roomy,
          }),
        ).toContain(PRE_MIGRATE_DIR);
      } finally {
        db.close();
      }
    }
  });
});
