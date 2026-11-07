/**
 * `createTestDb` — a migrated database per test, in about a millisecond (`11` §3.1.8, `02` §4.1).
 *
 * Every repository, read-model and chaos test wants its own database, and there are going to be
 * thousands of them. Running 99 `CREATE TABLE`s and 91 `CREATE TRIGGER`s for each would cost ~17 ms
 * a test — minutes of wall clock across the suite, which is the difference between a test run
 * someone waits for and one they stop running.
 *
 * So the migrations run **once per worker** and the result is kept as a page image:
 * `db.serialize()` on the template, `new Database(buffer)` per test. Measured on this schema: 17 ms
 * to build the template, **~1.3 ms median** per clone against `11` §3.1.8's 5 ms target.
 *
 * ## What a clone has to redo
 *
 * The page image carries the schema and the data; it does **not** carry connection state. So each
 * clone re-loads sqlite-vec and re-applies pragmas. Two of those matter beyond speed:
 *
 *  - **`trusted_schema = ON`** before the extension loads, because `02` §3.5 measured that with it
 *    off, vec0 DML inside a trigger is refused at *run* time while the DDL is accepted;
 *  - **`foreign_keys = ON`**, which is per-connection and defaults off. A suite that forgot it
 *    would pass while writing rows a real connection rejects.
 *
 * FTS5 is built in, and the triggers travel with the image — verified: an insert into a clone
 * populates `messages_fts`.
 *
 * ## Why encryption takes a different path
 *
 * `createTestDb({ encrypted: true })` cannot use the page image. SQLCipher encrypts pages **on
 * their way to a file**, so an in-memory database is unencrypted whatever key it is given, and
 * deserialising a plaintext image into a keyed connection is not a meaningful test of the codec.
 * The encrypted variant therefore keeps a migrated **file** as its template and copies it, which
 * exercises the real cipher path at the cost of a 1.3 MB file copy.
 */
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '@comvivo/shared';
import Database from 'better-sqlite3-multiple-ciphers';
import * as sqliteVec from 'sqlite-vec';
import { migrate } from '../migrate/runner.js';
import { fileMigrationSource } from '../migrate/source.js';
import { MIGRATIONS_DIR } from './migrations-dir.js';
import { createTmpDbDir } from './tmp-db.js';

/** The app version recorded in `_schema_migrations` for a test database. */
const TEST_APP_VERSION = '0.0.0-test';

/** A fixed clock, so a template is identical across runs and across workers. */
const TEST_NOW_MS = 1_767_225_600_000;

export interface CreateTestDbOptions {
  /** Exercise the SQLCipher path. Off by default: `11` §3.1.8 keeps L1–L4 fast. */
  readonly encrypted?: boolean;
  /** Run inside the fresh database, before it is handed over. */
  readonly seed?: (db: Database.Database) => void;
}

/**
 * Memoised per module instance, which in Vitest means per worker.
 *
 * A `const` holding a mutable object rather than module-level `let`, which
 * `scripts/hygiene/check.ts` refuses.
 */
const templates: { image?: Buffer | undefined; encryptedPath?: string | undefined } = {};

/** The 32-byte key the encrypted variant uses. Fixed: a test key is not a secret. */
export const TEST_DB_KEY: Buffer = Buffer.alloc(32, 0x2a);

/** Apply the connection state a page image cannot carry. */
function prepareConnection(db: Database.Database): void {
  // Before `sqliteVec.load`: see the header.
  db.pragma('trusted_schema = ON');
  sqliteVec.load(db);
  db.pragma('foreign_keys = ON');
}

/** Build the in-memory template once and keep its page image. */
function templateImage(): Buffer {
  if (templates.image !== undefined) return templates.image;
  const db = new Database(':memory:');
  try {
    prepareConnection(db);
    migrate(db, fileMigrationSource(MIGRATIONS_DIR), {
      appVersion: TEST_APP_VERSION,
      nowMs: () => TEST_NOW_MS,
    });
    const image = db.serialize();
    templates.image = image;
    return image;
  } finally {
    db.close();
  }
}

/**
 * Build the encrypted file template once and keep its path.
 *
 * In a directory `cleanupTmpDbs()` does **not** know about. The first version used
 * `createTmpDbDir()`, which registers for teardown — so the first `afterEach` deleted the template
 * while the memoised path still pointed at it, and every later encrypted test failed with `ENOENT`
 * on a copy. A template is worker-lifetime state, not per-test state.
 */
function encryptedTemplatePath(): string {
  if (templates.encryptedPath !== undefined) return templates.encryptedPath;
  const path = join(mkdtempSync(join(tmpdir(), `${BRAND.slug}-template-`)), 'template.db');
  const db = new Database(path);
  try {
    db.pragma(`key = "x'${TEST_DB_KEY.toString('hex')}'"`);
    db.pragma('cipher_compatibility = 4');
    prepareConnection(db);
    migrate(db, fileMigrationSource(MIGRATIONS_DIR), {
      appVersion: TEST_APP_VERSION,
      nowMs: () => TEST_NOW_MS,
    });
    // Fold the WAL back into the main file, or the copy below would miss committed pages.
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  templates.encryptedPath = path;
  return path;
}

/**
 * A migrated database for one test.
 *
 * The caller closes it. Nothing here registers an `afterEach`, because a test that wants a
 * database to outlive one case — a template of its own, a crash fixture — should not have it
 * closed underneath it.
 */
export function createTestDb(options: CreateTestDbOptions = {}): Database.Database {
  const db = options.encrypted === true ? openEncryptedClone() : new Database(templateImage());
  try {
    prepareConnection(db);
    options.seed?.(db);
    return db;
  } catch (cause) {
    db.close();
    throw cause;
  }
}

/** Copy the encrypted template and open the copy with the same key. */
function openEncryptedClone(): Database.Database {
  const source = encryptedTemplatePath();
  const path = join(createTmpDbDir(), 'test.db');
  copyFileSync(source, path);
  const db = new Database(path);
  db.pragma(`key = "x'${TEST_DB_KEY.toString('hex')}'"`);
  db.pragma('cipher_compatibility = 4');
  return db;
}

/**
 * Write the template's page image to a file, for a test that needs a migrated database on disk
 * without paying for a migration.
 *
 * Distinct from `createTmpDbFile()`, which gives an *empty* path. This one is already migrated.
 */
export function writeMigratedDbFile(name = 'migrated.db'): string {
  const path = join(createTmpDbDir(), name);
  writeFileSync(path, templateImage());
  return path;
}

/** Discard the memoised templates. For the test that measures template build cost. */
export function resetTestDbTemplates(): void {
  templates.image = undefined;
  templates.encryptedPath = undefined;
}
