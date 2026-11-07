/**
 * The migration suite `02` §3.12.6 and `11` §3.1.8 name (`M1-T14`).
 *
 * Four properties, each with its own failure it is the only guard against:
 *
 *  - **`migrations.fresh-equals-migrated`** — a database built by running the migrations has the
 *    same schema as one built from `src/schema/*.ts` directly. Without it the two drift, and the
 *    symptom appears only for hosts who *upgrade* while every test (which starts fresh) passes.
 *  - **`migrations.checksums-locked`** — no released migration has been edited.
 *  - **`migrations.crash-resume`** — killing the runner mid-upgrade and restarting completes, and
 *    the result equals a clean run.
 *  - **idempotent rerun** — running `migrate()` twice applies nothing the second time. `02`
 *    §3.12.2 has `apps/server` call it on every boot, so this is the common path, not an edge.
 *
 * The snapshot-upgrade loop (`migrations.upgrade-from-<version>`) is wired and iterates an empty
 * list, because no release exists yet. It is here rather than deferred so the first release adds a
 * fixture rather than also writing the test.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { BRAND, StorageError } from '@comvivo/shared';
import Database from 'better-sqlite3-multiple-ciphers';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, describe, expect, it } from 'vitest';
import { writeSourcePathsTsconfig } from '../../../scripts/support/paths-tsconfig.js';
import { assertLockMatches, lockFor, lockViolations, readLock } from './migrate/lock.js';
import {
  appliedMigrations,
  isForeignKeyPragma,
  MIGRATIONS_TABLE,
  migrate,
} from './migrate/runner.js';
import { snapshotFixtures } from './migrate/snapshots.js';
import {
  checksumOf,
  detectLayout,
  fileMigrationSource,
  splitStatements,
  staticMigrationSource,
} from './migrate/source.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');
const CRASH_RUNNER = join(HERE, 'migrate/testing/crash-runner.mjs');
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..');
const MIGRATIONS_DIR = join(PACKAGE_ROOT, 'migrations');
const LOCK_PATH = join(PACKAGE_ROOT, 'migrations.lock.json');

const source = fileMigrationSource(MIGRATIONS_DIR);
const APP_VERSION = '0.0.0-test';

const temporaries: string[] = [];
afterEach(() => {
  for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), `${BRAND.slug}-migrate-`));
  temporaries.push(path);
  return path;
}

/** A fresh connection with the extension loaded and the pragmas a real one has. */
function open(file = ':memory:'): Database.Database {
  const db = new Database(file);
  db.pragma('trusted_schema = ON');
  sqliteVec.load(db);
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * `sqlite_schema`, normalised for comparison (`02` §3.12.6).
 *
 * Sorted, whitespace-collapsed, and excluding four things:
 *
 *  - `vec_memory_%` and `trg_memory_items_vec_%`, which `02` §3.12.6 names — they are created at
 *    runtime by `EmbeddingSpaceManager` from configuration, so a migrated database has them only
 *    if a space was created and a fresh one never does;
 *  - the bookkeeping table, which exists only where migrations ran;
 *  - **`sqlite_%`**, which `02` §3.12.6 does *not* name and which this test needed. Measured: the
 *    runner's closing `PRAGMA optimize` runs `ANALYZE`, and that creates `sqlite_stat1` and
 *    `sqlite_stat4` — both with non-null `sql`. So the migrated side had two objects the fresh
 *    side did not, and the comparison failed for a reason with nothing to do with schema drift.
 *    Query-planner statistics are not schema. Spec amended.
 */
function normalizedSchema(db: Database.Database): readonly string[] {
  return (
    db
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
         WHERE sql IS NOT NULL
           AND name NOT LIKE 'sqlite_%'
           AND name NOT LIKE 'vec_memory_%'
           AND name NOT LIKE 'trg_memory_items_vec_%'
           AND name <> ?
         ORDER BY type, name`,
      )
      .all(MIGRATIONS_TABLE) as { type: string; name: string; sql: string }[]
  ).map((row) => `${row.type} ${row.name} ${row.sql.replaceAll(/\s+/g, ' ').trim()}`);
}

describe('migrations.fresh-equals-migrated', { tags: ['db'] }, () => {
  it('produces the same schema as applying the committed SQL directly', () => {
    // The "fresh" side is the migration SQL applied without the runner — which is what
    // `drizzle-kit push` does, minus the runner's bookkeeping, pragma toggling and FK check. If
    // the runner ever transformed a statement (it skips `PRAGMA foreign_keys`, and could grow
    // more), this is what would notice.
    const migrated = open();
    const fresh = open();
    try {
      migrate(migrated, source, { appVersion: APP_VERSION });
      for (const migration of source.list()) {
        for (const statement of migration.sql) {
          if (isForeignKeyPragma(statement)) continue;
          fresh.exec(statement);
        }
      }
      expect(normalizedSchema(migrated)).toEqual(normalizedSchema(fresh));
      expect(normalizedSchema(migrated).length).toBeGreaterThan(150);
    } finally {
      migrated.close();
      fresh.close();
    }
  });

  it('leaves the database consistent and intact', () => {
    const db = open();
    try {
      const result = migrate(db, source, { appVersion: APP_VERSION });
      expect(result.applied).toBe(source.list().length);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('turns foreign keys back on afterwards', () => {
    // The runner toggles `foreign_keys` OFF around each migration because a pragma inside a
    // transaction is silently ignored. Leaving it off would mean the application runs without
    // referential integrity and nothing would say so.
    const db = open();
    try {
      migrate(db, source, { appVersion: APP_VERSION });
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('an idempotent rerun', { tags: ['db'] }, () => {
  it('applies nothing the second time', () => {
    // `02` §3.12.2 calls `migrate()` on every boot, so this is the common path.
    const db = open();
    try {
      expect(migrate(db, source, { appVersion: APP_VERSION }).applied).toBeGreaterThan(0);
      expect(migrate(db, source, { appVersion: APP_VERSION })).toEqual({ applied: 0, ids: [] });
      expect(appliedMigrations(db)).toHaveLength(source.list().length);
    } finally {
      db.close();
    }
  });

  it('records the app version and a duration for each migration', () => {
    const db = open();
    try {
      migrate(db, source, { appVersion: APP_VERSION, nowMs: () => 1_700_000_000_000 });
      for (const row of appliedMigrations(db)) {
        expect(row.app_version).toBe(APP_VERSION);
        expect(row.applied_at).toBe(1_700_000_000_000);
        expect(row.duration_ms).toBeGreaterThanOrEqual(0);
        expect(row.kind).toBe('sql');
      }
    } finally {
      db.close();
    }
  });
});

describe('SCHEMA_TOO_NEW and checksum drift', { tags: ['db'] }, () => {
  it('refuses a database holding a migration this build does not know', () => {
    // The older-binary-against-newer-data case. Running anyway would apply this build's view of
    // the schema over data written by a version that knew more about it.
    const db = open();
    try {
      migrate(db, source, { appVersion: APP_VERSION });
      db.prepare(
        `INSERT INTO ${MIGRATIONS_TABLE} (id, checksum, applied_at, app_version, duration_ms, kind)
         VALUES ('9999_from_the_future', 'deadbeef', 0, '9.9.9', 0, 'sql')`,
      ).run();

      const attempt = () => migrate(db, source, { appVersion: APP_VERSION });
      expect(attempt).toThrow(StorageError);
      expect(attempt).toThrow(/newer version/);
      try {
        attempt();
      } catch (error) {
        expect((error as StorageError).storageCode).toBe('SCHEMA_TOO_NEW');
      }
    } finally {
      db.close();
    }
  });

  it('refuses a migration whose file changed after it was applied', () => {
    const db = open();
    try {
      migrate(db, source, { appVersion: APP_VERSION });
      const first = source.list()[0];
      expect(first).toBeDefined();
      db.prepare(`UPDATE ${MIGRATIONS_TABLE} SET checksum = 'edited' WHERE id = ?`).run(
        first?.id ?? '',
      );
      expect(() => migrate(db, source, { appVersion: APP_VERSION })).toThrow(
        /differ from the files on disk/,
      );
      // The dev escape hatch, for a migration edited before release.
      expect(() =>
        migrate(db, source, { appVersion: APP_VERSION, allowChecksumDrift: true }),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe('migrations.checksums-locked', () => {
  it('matches every released migration against the files on disk', () => {
    expect(() => assertLockMatches(readLock(LOCK_PATH), source)).not.toThrow();
  });

  it('is empty until the first release, which is why the mechanism is tested below', () => {
    // Asserted rather than assumed: if a release adds entries and this starts failing, the
    // comment in `migrations.lock.json` is what needs updating, not the lock.
    expect(Object.keys(readLock(LOCK_PATH).released)).toEqual([]);
  });

  it('detects an edited and a removed release', () => {
    // The teeth. With an empty lock the assertion above passes vacuously, so the mechanism is
    // exercised against a synthetic lock built from the real migrations.
    const real = lockFor({ released: {} }, source, 'v0.1.0');
    expect(lockViolations(real, source)).toEqual([]);

    const ids = Object.keys(real.released);
    const firstId = ids[0] ?? '';
    const edited = {
      released: { ...real.released, [firstId]: { checksum: 'tampered', release: 'v0.1.0' } },
    };
    expect(lockViolations(edited, source).map((entry) => entry.kind)).toEqual(['checksum']);

    const removed = {
      released: { ...real.released, '0099_deleted': { checksum: 'x', release: 'v0.1.0' } },
    };
    expect(lockViolations(removed, source).map((entry) => entry.kind)).toEqual(['missing']);
  });

  it('records when a migration first shipped, not when the lock was last written', () => {
    const atFirst = lockFor({ released: {} }, source, 'v0.1.0');
    const atSecond = lockFor(atFirst, source, 'v0.2.0');
    for (const entry of Object.values(atSecond.released)) expect(entry.release).toBe('v0.1.0');
  });
});

describe('the migration source reads both layouts', () => {
  it('reads the committed journal layout', () => {
    expect(detectLayout(MIGRATIONS_DIR)).toBe('journal');
    const list = source.list();
    expect(list.map((migration) => migration.id)).toEqual([
      '0000_initial_schema',
      '0001_search_and_guards',
    ]);
    for (const migration of list) {
      expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(migration.sql.length).toBeGreaterThan(0);
    }
  });

  it('reads a folder layout, including a migration split across files', () => {
    // drizzle-kit v1's layout (`02` D16 re-evaluates it at M14). Our runner reads both so that
    // upgrade is a decision rather than a rewrite.
    const root = tempDir();
    const first = join(root, '20261101120000_init');
    writeFileSync(join(mkdirp(first), 'migration.sql'), 'CREATE TABLE a (x INTEGER);\n');
    const second = join(root, '20261102120000_more');
    mkdirp(second);
    writeFileSync(join(second, '01_first.sql'), 'CREATE TABLE b (x INTEGER);\n');
    writeFileSync(join(second, '02_second.sql'), 'CREATE TABLE c (x INTEGER);\n');

    expect(detectLayout(root)).toBe('folder');
    const list = fileMigrationSource(root).list();
    expect(list.map((migration) => migration.id)).toEqual([
      '20261101120000_init',
      '20261102120000_more',
    ]);
    // Several files in one folder become one migration, so its checksum covers all of them.
    expect(list[1]?.sql).toHaveLength(2);
  });

  it('refuses a .sql file the journal does not list', () => {
    // The defect I shipped during `M1-T13`: the file existed and the journal did not mention it,
    // so nothing would ever have applied it. Silence is the wrong answer here.
    const root = tempDir();
    writeFileSync(join(root, '0000_known.sql'), 'CREATE TABLE a (x INTEGER);\n');
    writeFileSync(join(root, '0001_orphan.sql'), 'CREATE TABLE b (x INTEGER);\n');
    mkdirp(join(root, 'meta'));
    writeFileSync(
      join(root, 'meta', '_journal.json'),
      JSON.stringify({ entries: [{ idx: 0, when: 1, tag: '0000_known' }] }),
    );
    expect(() => fileMigrationSource(root).list()).toThrow(/not in the journal/);
  });

  it('refuses a journal entry whose file is gone', () => {
    const root = tempDir();
    mkdirp(join(root, 'meta'));
    writeFileSync(
      join(root, 'meta', '_journal.json'),
      JSON.stringify({ entries: [{ idx: 0, when: 1, tag: '0000_vanished' }] }),
    );
    expect(() => fileMigrationSource(root).list()).toThrow(/do not exist/);
  });

  it('normalises newlines so a checksum is the same on every platform', () => {
    // `migrations.lock.json` is compared across platforms, and a Windows checkout would otherwise
    // produce a different digest for a byte-identical migration.
    expect(checksumOf('CREATE TABLE a;\nCREATE TABLE b;\n')).toBe(
      checksumOf('CREATE TABLE a;\r\nCREATE TABLE b;\r\n'),
    );
  });

  it('drops comment-only fragments rather than counting them as statements', () => {
    expect(
      splitStatements('-- a banner\n--> statement-breakpoint\nCREATE TABLE a (x INTEGER);'),
    ).toEqual(['CREATE TABLE a (x INTEGER);']);
  });
});

describe('migrations.crash-resume', { tags: ['db', 'slow'] }, () => {
  it('completes after the runner is killed mid-upgrade, matching a clean run', () => {
    // `02` §3.12.6 asks for the runner to be killed in a child process during a three-migration
    // upgrade. Per-migration commits are what make this recoverable: `_schema_migrations` is an
    // accurate account of what ran, so a restart resumes rather than guessing.
    const root = tempDir();
    writeMigrationSet(root);

    const dbPath = join(root, 'data.db');

    // Kill after the second migration commits. A SIGKILL exits non-zero, and so does a child that
    // never started — so the proof that it ran is the bookkeeping table below, not the status.
    const killed = runChild([dbPath, root, '2']);
    // **Measured: the signal arrives as an exit code, not as a signal.** `node_modules/.bin/tsx`
    // is a shell shim, so the process `execFileSync` spawns is the shim — it observes its own
    // child being killed and exits `128 + 9 = 137`, leaving `signal` null. Asserting
    // `signal === 'SIGKILL'` would therefore fail on a correctly killed child.
    expect(killed.status, killed.output).toBe(128 + 9);
    // The guard that this failed by being *killed* rather than by crashing. Its first version
    // matched `Cannot find module`, and the real failure said `Cannot find package` — so it let a
    // child that never started look like a successful kill, and the test failed four steps later
    // on a missing table instead. A negative assertion needs the positive one next to it.
    expect(killed.output, 'the child must fail by being killed, not by crashing').not.toMatch(
      /ReferenceError|Cannot find (module|package)|ERR_MODULE_NOT_FOUND|SyntaxError|is not defined/,
    );

    const partial = open(dbPath);
    try {
      expect(
        (
          partial.prepare(`SELECT id FROM ${MIGRATIONS_TABLE} ORDER BY id`).all() as {
            id: string;
          }[]
        ).map((row) => row.id),
      ).toEqual(['0000_one', '0001_two']);
    } finally {
      partial.close();
    }

    // Restart: the runner finishes the remaining migration.
    const resumed = runChild([dbPath, root, '0']);
    expect(resumed.status, resumed.output).toBe(0);

    const clean = join(root, 'clean.db');
    const cleanRun = runChild([clean, root, '0']);
    expect(cleanRun.status, cleanRun.output).toBe(0);

    const resumedDb = open(dbPath);
    const cleanDb = open(clean);
    try {
      expect(normalizedSchema(resumedDb)).toEqual(normalizedSchema(cleanDb));
      expect(
        (
          resumedDb.prepare(`SELECT id FROM ${MIGRATIONS_TABLE} ORDER BY id`).all() as {
            id: string;
          }[]
        ).map((row) => row.id),
      ).toEqual(['0000_one', '0001_two', '0002_three']);
    } finally {
      resumedDb.close();
      cleanDb.close();
    }
  });
});

describe('the snapshot-upgrade loop', () => {
  it('finds the released snapshots, of which there are none yet', () => {
    // `02` §3.12.6's `migrations.upgrade-from-<version>`, wired now so the first release adds a
    // fixture rather than also writing the test. `M14-T4` owns the release step.
    expect(snapshotFixtures()).toEqual([]);
  });

  it('upgrades a snapshot to HEAD, proven against one built on the spot', () => {
    // **The empty list above cannot prove the loop works.** The first version of this suite had
    // only `it.each(snapshotFixtures())`, which with no fixtures runs no cases and passes — and
    // it would have failed the moment a real fixture appeared, because it handed the `.gz` path
    // straight to SQLite. So the body is exercised here against a snapshot produced by
    // `scripts/make-db-snapshot.ts` at HEAD, which is the same shape a release fixture has.
    const work = tempDir();
    const snapshot = join(work, 'v0.0.0.sqlite.gz');
    buildSnapshot(snapshot);
    expectUpgradeToHead(snapshot);
  });

  it.each(snapshotFixtures())('upgrades the released %s to HEAD', (fixture) => {
    expectUpgradeToHead(fixture);
  });
});

describe('a static source, for tests and the snapshot loop', () => {
  it('yields exactly what it was given', () => {
    const migrations = [{ id: '0000_x', sql: ['CREATE TABLE a (x INTEGER)'], checksum: 'abc' }];
    expect(staticMigrationSource(migrations).list()).toEqual(migrations);
  });
});

/**
 * Decompress a snapshot and migrate it to HEAD, asserting the upgrade is sound.
 *
 * `02` §3.12.6 asks for `integrity_check`, an empty `foreign_key_check`, a schema equal to a fresh
 * migration, and preserved row counts. The row counts are the part a schema comparison cannot see:
 * a table rebuild that forgets to copy its rows produces exactly the right schema.
 */
function expectUpgradeToHead(fixturePath: string): void {
  const work = tempDir();
  const dbPath = join(work, 'upgraded.sqlite');
  writeFileSync(dbPath, gunzipSync(readFileSync(fixturePath)));

  const db = open(dbPath);
  const fresh = open();
  try {
    const before = rowCounts(db);
    migrate(db, source, { appVersion: APP_VERSION });
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);

    migrate(fresh, source, { appVersion: APP_VERSION });
    expect(normalizedSchema(db)).toEqual(normalizedSchema(fresh));

    // Every table that had rows still has at least as many. A data migration that documents a
    // change would relax this for its own table; none do yet.
    for (const [table, count] of Object.entries(before)) {
      expect(rowCounts(db)[table] ?? 0, `${table} kept its rows`).toBeGreaterThanOrEqual(count);
    }
    expect(Object.keys(before).length).toBeGreaterThan(0);
  } finally {
    db.close();
    fresh.close();
  }
}

/** Row counts for every non-empty user table. */
function rowCounts(db: Database.Database): Record<string, number> {
  const tables = (
    db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'
           AND name NOT LIKE 'vec_memory_%' AND name <> ?`,
      )
      .all(MIGRATIONS_TABLE) as { name: string }[]
  ).map((row) => row.name);
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const row = db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number };
    if (row.n > 0) counts[table] = row.n;
  }
  return counts;
}

/** Build a snapshot at HEAD, the way `M14-T4`'s release step will. */
function buildSnapshot(outPath: string): void {
  const outDir = dirname(outPath);
  execFileSync(
    join(REPO_ROOT, 'node_modules/.bin/tsx'),
    [join(REPO_ROOT, 'scripts/make-db-snapshot.ts'), '--version', 'v0.0.0', '--out', outDir],
    { cwd: REPO_ROOT, stdio: 'pipe', encoding: 'utf8' },
  );
}

/** `mkdir -p`, returning the path. */
function mkdirp(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

/** Three tiny migrations, so the crash test does not depend on the real schema's size. */
function writeMigrationSet(root: string): void {
  const names = ['0000_one', '0001_two', '0002_three'];
  for (const [index, name] of names.entries()) {
    writeFileSync(
      join(root, `${name}.sql`),
      `CREATE TABLE t${String(index)} (id INTEGER PRIMARY KEY, note TEXT);\n`,
    );
  }
  mkdirp(join(root, 'meta'));
  writeFileSync(
    join(root, 'meta', '_journal.json'),
    JSON.stringify({
      entries: names.map((tag, idx) => ({ idx, when: idx + 1, tag })),
    }),
  );
}

/**
 * Run the crash script under `tsx`, in a child process.
 *
 * `TSX_TSCONFIG_PATH` is not optional. `tsconfig.base.json` declares the workspace `paths`, which
 * `packages/storage/tsconfig.json` inherits, and that map redirects
 * `better-sqlite3-multiple-ciphers` to the **declaration file** the package ships but hides behind
 * its `exports`. tsx then *executes* the `.d.ts` and the child dies with `ReferenceError: Database
 * is not defined` — the same trap `M1-T8`'s worker hit, which is why
 * `writeSourcePathsTsconfig` filters `.d.ts` targets and why it is shared.
 *
 * Worth noting how this failed: the child exited non-zero, which is exactly what the crash test
 * *wants* from the kill step, so the first assertion passed and the test only failed later on a
 * missing table. A child-process test has to prove the child did its work, not merely that it
 * died — so the resumed run asserts `status === 0`.
 */
function runChild(args: readonly string[]): {
  status: number;
  signal?: string | null;
  output: string;
} {
  const tsconfig = writeSourcePathsTsconfig(tempDir(), REPO_ROOT, 'tsconfig.child.json');
  try {
    const output = execFileSync(join(REPO_ROOT, 'node_modules/.bin/tsx'), [CRASH_RUNNER, ...args], {
      cwd: PACKAGE_ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
      env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig },
    });
    return { status: 0, signal: null, output };
  } catch (error) {
    const failure = error as {
      status?: number;
      signal?: string | null;
      stderr?: string;
      stdout?: string;
      message?: string;
    };
    return {
      status: failure.status ?? -1,
      signal: failure.signal ?? null,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}${failure.message ?? ''}`,
    };
  }
}

/** The fixture count, so a reader can see the loop is wired rather than absent. */
export function committedMigrationCount(): number {
  return readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).length;
}
