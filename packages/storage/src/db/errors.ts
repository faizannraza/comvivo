/**
 * SQLite's errors, mapped once (`02` §4.3).
 *
 * One place, deliberately. The alternative is every repository doing its own `catch` and reading
 * `error.code`, and three things go wrong with that: the strings are undocumented native-module
 * detail, a `SQLITE_BUSY` handled in one place and not another produces a bug that only appears
 * under load, and nothing can then promise that a given failure always looks the same to a host.
 *
 * Two judgements shape the table below.
 *
 * **A wrong key and a corrupt file look identical to SQLite.** `SQLITE_NOTADB` is what you get
 * from a database opened with the wrong key *and* from a file that is not a database at all,
 * because an encrypted page and a random page are indistinguishable without the key. So the
 * mapping cannot decide between them on the error alone, and `open.ts` supplies the context: if a
 * key was given, a failed read is `STORAGE_KEY_INVALID`; if none was, it is `STORAGE_CORRUPT`.
 * Getting this backwards would tell a host with a healthy database and a mistyped key that their
 * data is corrupt — and the obvious next step from "corrupt" is to restore a backup over it.
 *
 * **An expected uniqueness conflict is not an error.** `02` §4.3 is explicit: dedupe and
 * idempotency conflicts are *returned* as duplicate results, not thrown. `isUniqueViolation` is
 * what lets a caller tell the two apart, because the alternative — catching `STORAGE_CONSTRAINT`
 * and assuming it was the dedupe index — swallows a genuine foreign-key or check violation.
 */
import { StorageError, type StorageErrorCode } from '@comvivo/shared';

/** The error shape better-sqlite3 throws. `code` is the extended result code's name. */
export interface SqliteError extends Error {
  readonly code?: string;
  readonly errno?: number;
}

/** Is this a `SqliteError`? Narrow enough to be useful, loose enough to survive an upgrade. */
export function isSqliteError(value: unknown): value is SqliteError {
  return (
    value instanceof Error &&
    typeof (value as SqliteError).code === 'string' &&
    (value as SqliteError).code?.startsWith('SQLITE_') === true
  );
}

/** Context the mapping needs but the error does not carry. */
export interface MapOptions {
  /**
   * Was the database opened with a key?
   *
   * The one thing that distinguishes "wrong key" from "not a database", because an encrypted page
   * and a corrupt page are the same bytes to SQLite without the key.
   */
  readonly encrypted?: boolean;
  /** What was being attempted, for the message. Never SQL, which can contain content. */
  readonly operation?: string;
}

/**
 * `RAISE(ABORT, '<CODE>')` messages, which triggers use to enforce invariants in the database.
 *
 * `02` §4.3: a trigger that aborts with one of these names should surface as that code rather than
 * as a generic constraint failure, because these are *our* invariants (I4's label/group match,
 * memory immutability, the audit chain's append-only rule) and each has its own explanation.
 */
const RAISED_CODES: readonly StorageErrorCode[] = [
  'I4_LABEL_GROUP_MISMATCH',
  'MEMORY_CONTENT_IMMUTABLE',
  'AUDIT_APPEND_ONLY',
];

/**
 * What each mapped code means and what to do about it.
 *
 * One table rather than a `describe()` switch plus a separate `HINTS` map. The first version had
 * both, and `switch-exhaustiveness-check` was right to object: with thirty-odd codes in the union
 * and nine of them reachable from here, a `switch` with a `default` is a list that silently stops
 * matching the type it switches on. A partial record says "these are the ones this file produces"
 * directly, and keeps a code's wording next to its advice so the two cannot drift.
 */
const DESCRIPTIONS: Partial<
  Record<StorageErrorCode, { readonly message: string; readonly hint: string }>
> = {
  STORAGE_KEY_INVALID: {
    message: 'the key did not open this database',
    hint:
      'The key does not open this database. If you have rotated the master key, use the current ' +
      'one; if the key file was replaced, recover with your recovery key. The database itself is ' +
      'almost certainly fine — do not restore over it until you have ruled the key out.',
  },
  STORAGE_CORRUPT: {
    message: 'the database file is damaged',
    hint:
      'The database file is damaged. Restore the most recent backup, and keep the damaged file: ' +
      'it is often still partly readable and is the only copy of anything the backup missed.',
  },
  STORAGE_BUSY: {
    message: 'the database was locked by another connection for longer than the timeout',
    hint:
      'Another connection held a write lock for longer than the timeout. This is usually a long ' +
      'backup or migration; try again once it finishes.',
  },
  STORAGE_DISK_SPACE_LOW: {
    message: 'the disk is full',
    hint:
      'The disk is full or nearly full. Free space and try again — SQLite needs room for the ' +
      'write-ahead log as well as the database itself.',
  },
  STORAGE_CONSTRAINT: {
    message: 'a write broke a database constraint',
    hint: 'This is a bug: a write broke a database constraint.',
  },
  STORAGE_WRITE_IN_READ: {
    message: 'a write was attempted on a read-only connection',
    hint:
      'This is a bug: read-only connections are for backups, exports and scans, and must not ' +
      'write.',
  },
  I4_LABEL_GROUP_MISMATCH: {
    message: 'a record was written with a label from another group (I4)',
    hint:
      'This is a bug, and an important one: a record was written with a label belonging to a ' +
      'different group, which invariant I4 exists to prevent.',
  },
  MEMORY_CONTENT_IMMUTABLE: {
    message: 'stored memory content cannot be edited in place',
    hint: 'This is a bug: stored memory content cannot be edited in place, only superseded.',
  },
  AUDIT_APPEND_ONLY: {
    message: 'the audit log is append-only',
    hint: 'This is a bug: the audit log is append-only.',
  },
};

/** The generic pair, for a code this file can produce but has nothing specific to say about. */
const GENERIC = {
  message: 'the database failed',
  hint: 'Check the disk and the data directory, then try again.',
} as const;

/**
 * Turn a caught value into a `StorageError`.
 *
 * Never rethrows the original: a caller that has to handle both a `SqliteError` and a
 * `StorageError` ends up with two code paths for one failure, and the second one is always the
 * untested one. An already-mapped `StorageError` passes through unchanged.
 */
export function mapSqliteError(caught: unknown, options: MapOptions = {}): StorageError {
  if (caught instanceof StorageError) return caught;

  const operation = options.operation === undefined ? '' : ` while ${options.operation}`;
  if (!isSqliteError(caught)) {
    // A non-SQLite failure is something unexpected rather than a known condition, so there is
    // nothing more specific to say than where to look.
    return new StorageError('STORAGE_IO', `${GENERIC.message}${operation}`, {
      hint: GENERIC.hint,
      cause: caught,
    });
  }

  const code = storageCodeFor(caught, options);
  const described = DESCRIPTIONS[code] ?? GENERIC;
  const detail: Record<string, string | number | boolean> = {
    sqliteCode: caught.code ?? 'unknown',
  };
  const constraint = constraintNameOf(caught);
  if (constraint !== undefined) detail['constraint'] = constraint;

  return new StorageError(code, `${described.message}${operation}`, {
    hint: described.hint,
    ...(code === 'STORAGE_CONSTRAINT' || RAISED_CODES.includes(code) ? { category: 'bug' } : {}),
    detail,
    cause: caught,
  });
}

/** Which `StorageErrorCode` a SQLite error means, given the open context. */
export function storageCodeFor(error: SqliteError, options: MapOptions = {}): StorageErrorCode {
  const raised = raisedCodeOf(error);
  if (raised !== undefined) return raised;

  const code = error.code ?? '';
  if (code.startsWith('SQLITE_CONSTRAINT')) return 'STORAGE_CONSTRAINT';
  if (code.startsWith('SQLITE_BUSY') || code === 'SQLITE_LOCKED') return 'STORAGE_BUSY';
  if (code === 'SQLITE_FULL' || code === 'SQLITE_IOERR_WRITE') return 'STORAGE_DISK_SPACE_LOW';
  if (code === 'SQLITE_CORRUPT' || code.startsWith('SQLITE_CORRUPT')) return 'STORAGE_CORRUPT';
  if (code === 'SQLITE_NOTADB') {
    // The judgement described in the header. With a key, the overwhelmingly likely cause is the
    // key; without one, the file genuinely is not a database.
    return options.encrypted === true ? 'STORAGE_KEY_INVALID' : 'STORAGE_CORRUPT';
  }
  if (code.startsWith('SQLITE_IOERR')) return 'STORAGE_IO';
  if (code === 'SQLITE_READONLY' || code.startsWith('SQLITE_READONLY'))
    return 'STORAGE_WRITE_IN_READ';
  return 'STORAGE_IO';
}

/** The `RAISE(ABORT, '<CODE>')` name in a trigger's message, if it is one of ours. */
export function raisedCodeOf(error: SqliteError): StorageErrorCode | undefined {
  // better-sqlite3 surfaces a `RAISE(ABORT, 'X')` as `SQLITE_CONSTRAINT_TRIGGER` with the raised
  // text in `message`. Matched as a whole word so `AUDIT_APPEND_ONLY_V2` would not be read as
  // `AUDIT_APPEND_ONLY`.
  for (const candidate of RAISED_CODES) {
    if (new RegExp(`\\b${candidate}\\b`).test(error.message)) return candidate;
  }
  return undefined;
}

/**
 * The constraint a failure names, for `detail`.
 *
 * Index and column names only — never a value. `01` §11.7 keeps message and memory content out of
 * structured detail, and a unique-constraint failure's message includes the *values* that
 * collided, which for this product can be a person's name or a phone number.
 */
export function constraintNameOf(error: SqliteError): string | undefined {
  // "UNIQUE constraint failed: members.group_id, members.person_id"
  const unique = /UNIQUE constraint failed: ([\w., ]+)/.exec(error.message);
  if (unique?.[1] !== undefined) return unique[1].trim();
  // "FOREIGN KEY constraint failed" carries no name at all.
  if (error.message.includes('FOREIGN KEY constraint failed')) return 'foreign key';
  // "CHECK constraint failed: turns_role_valid"
  const check = /CHECK constraint failed: ([\w.]+)/.exec(error.message);
  if (check?.[1] !== undefined) return check[1];
  // "NOT NULL constraint failed: turns.group_id"
  const notNull = /NOT NULL constraint failed: ([\w.]+)/.exec(error.message);
  if (notNull?.[1] !== undefined) return notNull[1];
  return undefined;
}

/**
 * Is this the uniqueness conflict a caller **expects**?
 *
 * `02` §4.3: dedupe and idempotency conflicts are returned as duplicate results rather than
 * thrown, and this is what lets a caller make that distinction honestly. The alternative — treat
 * any `STORAGE_CONSTRAINT` as "already there" — would swallow a foreign-key violation and a
 * check-constraint failure, which are bugs, and report them as a successful no-op.
 *
 * `index` narrows it further: a caller inserting into the outbox cares about *its* idempotency
 * index, not about any unique index that happens to fire.
 */
export function isUniqueViolation(caught: unknown, index?: string): boolean {
  if (!isSqliteError(caught)) {
    return caught instanceof StorageError && caught.storageCode === 'STORAGE_CONSTRAINT'
      ? matchesIndex(caught.detail?.['constraint'], index)
      : false;
  }
  if (
    caught.code !== 'SQLITE_CONSTRAINT_UNIQUE' &&
    caught.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY'
  ) {
    return false;
  }
  return matchesIndex(constraintNameOf(caught), index);
}

function matchesIndex(constraint: string | number | boolean | undefined, index?: string): boolean {
  if (index === undefined) return true;
  return typeof constraint === 'string' && constraint.includes(index);
}
