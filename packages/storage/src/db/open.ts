/**
 * `openDatabase` (`02` §3.6.2).
 *
 * The pragma sequence here is not a list of preferences. `M1-T2`'s spike measured each of these
 * against a real SQLCipher build on two architectures, and three of them are load-bearing in ways
 * that are invisible until they are wrong:
 *
 *  - **`cache_size` defaults to 192 MiB, and it is not a tuning knob.** With a page cache smaller
 *    than the vector index, *every* KNN query re-reads and re-decrypts the whole partition. The
 *    spike measured **508 ms at 8 MiB against 5 ms at 192 MiB** for 50k × 384-d vectors — a 100×
 *    cliff from one pragma, landing 8× on the wrong side of `02` §3.16.4's 60 ms budget. The
 *    symptom otherwise is "search feels slow" with nothing in the logs.
 *  - **`mmap_size` stays 0.** Memory-mapped I/O bypasses the codec, so a non-zero value reads
 *    ciphertext pages straight past decryption.
 *  - **The read after `PRAGMA key` is the actual key check.** `PRAGMA key` always reports success,
 *    whatever key it is given; the first read of `sqlite_master` is where a wrong key surfaces.
 *    Omitting it would let a wrong key open "successfully" and fail later, somewhere else.
 *
 * `packages/storage/spike/open.ts` holds the transcription the spike proved, and its suite is a
 * permanent regression test against the same facts — so if this file and that one ever disagree
 * about the pragma list, a test says so.
 */

import { StorageError } from '@comvivo/shared';
// The fork, by its real name. The `better-sqlite3` alias in `package.json` exists only so
// `drizzle-orm/better-sqlite3/driver.js`'s top-level `import 'better-sqlite3'` resolves (measured
// in `M1-T2`); TypeScript cannot follow types through that alias, and `tsconfig.paths.json` maps
// the real name to the declarations the package ships but hides behind its `exports`.
import Database from 'better-sqlite3-multiple-ciphers';
import * as sqliteVec from 'sqlite-vec';
import { mapSqliteError } from './errors.js';

/** `02` §3.6.2's cipher choice. `sqlcipher` is the default (ADR-005); `chacha20` is offered. */
export type Cipher = 'sqlcipher' | 'chacha20';

/** Which kind of connection this is (`02` D22). */
export type ConnectionRole = 'main' | 'worker' | 'cli';

export interface OpenOptions {
  readonly path: string;
  /** `null` only when `privacy.encryptAtRest` is false, which `doctor` warns about. */
  readonly key: Buffer | null;
  readonly readonly?: boolean;
  readonly role: ConnectionRole;
  readonly cipher?: Cipher;
  readonly busyTimeoutMs?: number;
  readonly cacheSizeKiB?: number;
  /** Set false in the one place that must open before the extension exists: `doctor --repair`. */
  readonly loadVec?: boolean;
  /**
   * Run on a **newly created, empty** database, after the key is accepted and **before** the
   * runtime pragmas.
   *
   * That window exists for one reason, and it is measured rather than assumed:
   * **`PRAGMA auto_vacuum = INCREMENTAL` silently does nothing once `journal_mode = WAL` is set.**
   *
   * | order | `auto_vacuum` reads back |
   * |---|---|
   * | `auto_vacuum` then WAL | 2 (incremental) |
   * | WAL then `auto_vacuum` | **0** |
   *
   * Measured on better-sqlite3-multiple-ciphers 13.0.3, encrypted and plain. `02` §3.6.2 has
   * `openDatabase` apply the pragma list and `initDatabase` set `auto_vacuum` afterwards; followed
   * literally, every database this product created would silently be unable to reclaim space, and
   * the only fix after the fact is a full `VACUUM`. So creation-time pragmas go here.
   */
  readonly onCreated?: (db: Database.Database) => void;
}

/**
 * `02` §3.6.2's default page cache: 192 MiB. **Not a tuning knob** — see the header.
 *
 * `comvivo doctor` warns when the configured cache is smaller than the largest vector partition
 * (`09` §C), because that is the configuration that silently costs 100× on every search.
 */
export const DEFAULT_CACHE_SIZE_KIB = 196_608;

/** `02` §3.6.2's default lock timeout. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/**
 * The pragmas applied on every open, in order.
 *
 * Order matters for `journal_mode` (WAL has to be set before the first write) and is otherwise
 * stable so the sequence can be compared against the spike's.
 */
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

/** `02` §3.6.2's floors. Asserted on every open, because a mismatch corrupts rather than fails. */
export const MIN_SQLITE_VERSION = '3.45';
export const MIN_VEC_VERSION = 'v0.1.9';

/** A handle, plus what was true about the connection that produced it. */
export interface OpenDatabase {
  readonly db: Database.Database;
  readonly role: ConnectionRole;
  readonly encrypted: boolean;
  readonly readonly: boolean;
  readonly sqliteVersion: string;
  readonly vecVersion: string | undefined;
}

/**
 * Open an encrypted database, or explain why not.
 *
 * `fileMustExist` is true for every role but `main`, per `02` §3.6.2: a worker or a CLI command
 * that found no database must not **create** one. An empty database created by a `backup` command
 * would look like a fresh install to the next boot, and `12` §3.8.1 would then happily initialise
 * over the real one the host was trying to back up.
 */
export function openDatabase(options: OpenOptions): OpenDatabase {
  const cipher = options.cipher ?? 'sqlcipher';
  const isReadonly = options.readonly ?? false;
  const encrypted = options.key !== null;

  let db: Database.Database;
  try {
    db = new Database(options.path, {
      readonly: isReadonly,
      fileMustExist: options.role !== 'main',
    });
  } catch (cause) {
    throw mapSqliteError(cause, { encrypted, operation: `opening ${options.path}` });
  }

  try {
    if (options.key !== null) {
      applyKey(db, options.key, cipher);
    }
    assertKeyOpens(db, { encrypted, path: options.path });

    // Creation-time pragmas first. See `onCreated`: this is the only moment `auto_vacuum` can be
    // set, because `journal_mode = WAL` below closes the window silently.
    options.onCreated?.(db);

    for (const pragma of pragmasFor(isReadonly)) db.pragma(pragma);
    db.pragma(`busy_timeout = ${String(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS)}`);
    db.pragma(`cache_size = -${String(options.cacheSizeKiB ?? DEFAULT_CACHE_SIZE_KIB)}`);
    // Memory-mapped I/O bypasses the codec; a non-zero value would read ciphertext pages.
    db.pragma('mmap_size = 0');

    const vecVersion = options.loadVec === false ? undefined : loadVectorExtension(db);
    const sqliteVersion = assertVersions(db, vecVersion);

    return {
      db,
      role: options.role,
      encrypted,
      readonly: isReadonly,
      sqliteVersion,
      vecVersion,
    };
  } catch (error) {
    // A half-opened connection is worse than none: it holds a file descriptor and, on the main
    // role, may have created the file.
    db.close();
    throw error;
  }
}

/**
 * The pragmas that can be applied to this connection.
 *
 * `journal_mode` is a no-op on a read-only connection and `secure_delete` would be meaningless,
 * but SQLite does not error on either — so this is about not pretending to set something that
 * cannot take effect, rather than about avoiding a failure.
 */
function pragmasFor(isReadonly: boolean): readonly string[] {
  if (!isReadonly) return RUNTIME_PRAGMAS;
  return RUNTIME_PRAGMAS.filter(
    (pragma) => !pragma.startsWith('journal_mode') && !pragma.startsWith('secure_delete'),
  );
}

function applyKey(db: Database.Database, key: Buffer, cipher: Cipher): void {
  if (cipher === 'sqlcipher') {
    db.pragma("cipher='sqlcipher'");
    // `08` §3.7.9: SQLCipher v4 compatibility. Set *before* the key, because it changes the KDF
    // and page settings the key is interpreted under.
    db.pragma('legacy=4');
  } else {
    db.pragma("cipher='chacha20'");
  }

  const hex = key.toString('hex');
  // `08` §3.7.9 requires this before interpolation, and it is the reason `KeyService` hands the key
  // out as validated hex through a callback rather than as a string a caller can keep.
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new StorageError('STORAGE_KEY_INVALID', 'the database key is not 32 bytes of hex', {
      hint: 'This is a bug: the key tree derives a 256-bit database key.',
      category: 'bug',
    });
  }
  // Never logged. `02` §3.6.2 and `08` §3.7.9 both say so, and the statement is built here rather
  // than passed around so there is one place that could ever leak it.
  db.pragma(`key="x'${hex}'"`);
}

/**
 * The real key check.
 *
 * `PRAGMA key` reports success for any key, so the first read of `sqlite_master` is what actually
 * verifies it. Deliberately the cheapest possible read: a `count(*)` over the schema table touches
 * page 1, which is enough to fail on a wrong key and does not depend on any table existing.
 */
function assertKeyOpens(
  db: Database.Database,
  context: { readonly encrypted: boolean; readonly path: string },
): void {
  try {
    db.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch (cause) {
    throw mapSqliteError(cause, {
      encrypted: context.encrypted,
      operation: `opening ${context.path}`,
    });
  }
}

/** Load `sqlite-vec` and report its version. */
function loadVectorExtension(db: Database.Database): string {
  try {
    sqliteVec.load(db);
  } catch (cause) {
    throw new StorageError('STORAGE_EXTENSION_LOAD_FAILED', 'sqlite-vec could not be loaded', {
      hint:
        'The vector extension ships as a native binary for this platform. Reinstall dependencies ' +
        '— and if this is a container, check it is the image for this architecture.',
      cause,
    });
  }
  const row = db.prepare('SELECT vec_version() AS version').get() as { version?: string };
  if (typeof row.version !== 'string') {
    throw new StorageError(
      'STORAGE_EXTENSION_LOAD_FAILED',
      'sqlite-vec loaded but did not report a version',
      { hint: 'This is a bug, or a sqlite-vec build this version does not understand.' },
    );
  }
  return row.version;
}

/**
 * `02` §3.6.2's version floors.
 *
 * Asserted on **every** open rather than once at boot, because a worker connection loads its own
 * copy of the extension and a CLI command may run against a different installed build entirely. A
 * version mismatch here does not fail cleanly — an older SQLite silently ignores pragmas it does
 * not know, which is how `cell_size_check` or `secure_delete` would quietly stop applying.
 */
export function assertVersions(db: Database.Database, vecVersion: string | undefined): string {
  const row = db.prepare('SELECT sqlite_version() AS version').get() as { version?: string };
  const sqliteVersion = row.version ?? '0.0.0';
  if (compareVersions(sqliteVersion, MIN_SQLITE_VERSION) < 0) {
    throw new StorageError(
      'STORAGE_VERSION_UNSUPPORTED',
      `SQLite ${sqliteVersion} is older than the required ${MIN_SQLITE_VERSION}`,
      {
        hint:
          'An older SQLite ignores pragmas it does not recognise instead of refusing them, so ' +
          'this is not safe to run. Reinstall dependencies to get the pinned build.',
      },
    );
  }

  if (vecVersion !== undefined && compareVersions(vecVersion, MIN_VEC_VERSION) < 0) {
    throw new StorageError(
      'STORAGE_VERSION_UNSUPPORTED',
      `sqlite-vec ${vecVersion} is older than the required ${MIN_VEC_VERSION}`,
      { hint: 'Reinstall dependencies to get the pinned build.' },
    );
  }
  return sqliteVersion;
}

/**
 * Compare dotted versions numerically, ignoring a leading `v`.
 *
 * Numeric rather than lexicographic, because `3.9` is **not** older than `3.45` and a string
 * comparison says it is — the kind of check that passes for years and then rejects the one build
 * it was written to accept.
 */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value
      .replace(/^v/, '')
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Read a pragma's single value, for assertions and for `doctor`.
 *
 * `{ simple: true }` rather than reading the row's column, because **the column is not always
 * named after the pragma**: `PRAGMA busy_timeout` returns a column called `timeout`. The first
 * version of this function derived the key from the pragma name and silently returned `undefined`
 * for that one — which would have made every "the pragma took effect" assertion about
 * `busy_timeout` pass against nothing.
 *
 * For single-value pragmas only. `table_info` and friends return rows and need the full form.
 */
export function pragmaValue(db: Database.Database, name: string): unknown {
  return db.pragma(name, { simple: true });
}
