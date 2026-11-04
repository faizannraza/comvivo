/**
 * The spike's own `openDatabase`, transcribed from `02` §3.6.2.
 *
 * Deliberately a copy rather than an import: `M1-T8` builds the real `src/db/open.ts`, and the
 * whole point of a spike is to establish that this exact pragma sequence works *before* anything
 * is written on top of it. When `M1-T8` lands, `open.contract.ts` below is what its tests assert
 * against, so the two cannot drift silently.
 *
 * Kept as a permanent regression suite (`02` M1-T2): these are the facts every later storage
 * decision rests on, and they are facts about somebody else's native module, which means they can
 * change under us on any upgrade. The suite is what turns that into a failing test rather than a
 * corrupted database.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '@comvivo/shared';
import Database from 'better-sqlite3-multiple-ciphers';
import * as sqliteVec from 'sqlite-vec';

/**
 * The database filename, derived rather than written out.
 *
 * `02` §3.14's backup manifest has this as a `z.literal`, and `12` §3.7's data-dir layout names
 * it — so a hard-coded string here would be frozen into every `VBK1` archive ever written and a
 * rename would become a migration. `M1-T7` takes this over as part of the data-dir layout; until
 * then the spike is the only thing that opens a database, and this is where the name lives.
 */
export const DB_FILENAME = `${BRAND.slug}.db`;

/** Prefix for the spike's throwaway directories, so a stray one is identifiable. */
export const TMP_PREFIX = `${BRAND.slug}-spike-`;

export type Cipher = 'sqlcipher' | 'chacha20';

export interface SpikeOpenOptions {
  readonly path: string;
  readonly key: Buffer | null;
  readonly cipher?: Cipher;
  readonly readonly?: boolean;
  readonly fileMustExist?: boolean;
  readonly busyTimeoutMs?: number;
  readonly cacheSizeKiB?: number;
  /** `trusted_schema=OFF` is the U6 question: do FTS and vec triggers still fire? */
  readonly trustedSchema?: boolean;
  readonly loadVec?: boolean;
}

/** `02` §3.6.2's pragma list, in order. */
export const RUNTIME_PRAGMAS = [
  'journal_mode = WAL',
  'synchronous = NORMAL',
  'foreign_keys = ON',
  'temp_store = MEMORY',
  'secure_delete = ON',
  'wal_autocheckpoint = 1000',
  'journal_size_limit = 67108864',
  'cell_size_check = ON',
] as const;

export class SpikeKeyInvalid extends Error {}

export function openSpikeDatabase(o: SpikeOpenOptions): Database.Database {
  const db = new Database(o.path, {
    readonly: o.readonly ?? false,
    fileMustExist: o.fileMustExist ?? false,
  });

  if (o.key !== null) {
    if ((o.cipher ?? 'sqlcipher') === 'sqlcipher') {
      db.pragma("cipher='sqlcipher'");
      db.pragma('legacy=4');
    } else {
      db.pragma("cipher='chacha20'");
    }
    // A raw hex key, so SQLCipher skips PBKDF2 entirely (U4). `PRAGMA key` always reports success,
    // which is why the read below is the actual check.
    db.pragma(`key="x'${o.key.toString('hex')}'"`);
  }

  try {
    db.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch (cause) {
    db.close();
    throw new SpikeKeyInvalid('the key did not open this database', { cause });
  }

  for (const pragma of RUNTIME_PRAGMAS) db.pragma(pragma);
  db.pragma(`busy_timeout = ${String(o.busyTimeoutMs ?? 5000)}`);
  db.pragma(`cache_size = -${String(o.cacheSizeKiB ?? 8192)}`);
  // `mmap_size` stays 0: memory-mapped I/O bypasses the codec, so a non-zero value would read
  // ciphertext pages straight past decryption.
  db.pragma('mmap_size = 0');
  if (o.trustedSchema === false) db.pragma('trusted_schema = OFF');

  if (o.loadVec !== false) sqliteVec.load(db);
  return db;
}

/** A float32 vector in the little-endian layout vec0 expects. */
export function vec(values: readonly number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer);
}

/**
 * vec0 rowids must bind as SQLite **integers**, and better-sqlite3 binds a plain JS `number` as a
 * float — so `.run(1, embedding)` fails with "Only integers are allows for primary key values".
 * Measured on 2026-11-03 (sqlite-vec v0.1.9); it is the first thing this spike found.
 */
export function rowid(n: number): bigint {
  return BigInt(n);
}

/**
 * Run `fn` with a throwaway directory, and remove it afterwards.
 *
 * A helper rather than a `beforeEach` assigning a module-level `let`, which is what this suite had
 * first: `scripts/hygiene`'s `no-module-level-mutable-state` refused it, and it was right to. The
 * rule's stated reason is that a module-level `let` makes a file pass in declaration order and
 * fail under shuffle — and while a `beforeEach` does reassign it, nothing in the file *says* so,
 * and the next test added below the last one inherits whatever the previous one left. Scoping the
 * state to the test that owns it removes the question instead of answering it.
 */
export function withSpikeDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `withSpikeDir`, plus an open encrypted database and a random key. */
export function withSpikeDb<T>(
  fn: (db: Database.Database, dir: string) => T,
  options: Omit<SpikeOpenOptions, 'path' | 'key'> = {},
): T {
  return withSpikeDir((dir) => {
    const db = openSpikeDatabase({
      ...options,
      path: join(dir, DB_FILENAME),
      key: randomBytes(32),
    });
    try {
      return fn(db, dir);
    } finally {
      db.close();
    }
  });
}
