/**
 * The SQLite error mapping (`02` §4.3).
 *
 * Synthetic errors, deliberately: provoking a real `SQLITE_FULL` needs a full disk and a real
 * `SQLITE_CORRUPT` needs a damaged file, and neither is something a unit suite should arrange. What
 * matters here is the **table** — which SQLite code means which `StorageErrorCode` — and the one
 * judgement that cannot be read off the error at all.
 *
 * That judgement: `SQLITE_NOTADB` is what a wrong key and a non-database file both produce, because
 * an encrypted page and a random page are the same bytes without the key. Mapping it to
 * `STORAGE_CORRUPT` when a key was supplied would tell a host with a healthy database and a
 * mistyped key that their data is corrupt — and the obvious next step from "corrupt" is to restore
 * a backup *over* it.
 */
import { StorageError } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import {
  constraintNameOf,
  isSqliteError,
  isUniqueViolation,
  mapSqliteError,
  raisedCodeOf,
  storageCodeFor,
} from './errors.js';

/** An error shaped like better-sqlite3's. */
function sqlite(code: string, message = 'something went wrong'): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe('recognising a SQLite error', () => {
  it('accepts an Error with a SQLITE_ code', () => {
    expect(isSqliteError(sqlite('SQLITE_BUSY'))).toBe(true);
  });

  it('refuses anything else, including a lookalike', () => {
    expect(isSqliteError(new Error('plain'))).toBe(false);
    expect(isSqliteError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false);
    expect(isSqliteError({ code: 'SQLITE_BUSY' })).toBe(false);
    expect(isSqliteError(undefined)).toBe(false);
  });
});

describe('the mapping table (02 §4.3)', () => {
  it.each([
    ['SQLITE_CONSTRAINT', 'STORAGE_CONSTRAINT'],
    ['SQLITE_CONSTRAINT_UNIQUE', 'STORAGE_CONSTRAINT'],
    ['SQLITE_CONSTRAINT_FOREIGNKEY', 'STORAGE_CONSTRAINT'],
    ['SQLITE_BUSY', 'STORAGE_BUSY'],
    ['SQLITE_BUSY_SNAPSHOT', 'STORAGE_BUSY'],
    ['SQLITE_LOCKED', 'STORAGE_BUSY'],
    ['SQLITE_CORRUPT', 'STORAGE_CORRUPT'],
    ['SQLITE_CORRUPT_VTAB', 'STORAGE_CORRUPT'],
    ['SQLITE_FULL', 'STORAGE_DISK_SPACE_LOW'],
    ['SQLITE_IOERR', 'STORAGE_IO'],
    ['SQLITE_IOERR_READ', 'STORAGE_IO'],
    ['SQLITE_READONLY', 'STORAGE_WRITE_IN_READ'],
    ['SQLITE_READONLY_DBMOVED', 'STORAGE_WRITE_IN_READ'],
  ])('maps %s to %s', (code, expected) => {
    expect(storageCodeFor(sqlite(code))).toBe(expected);
  });

  it('falls back to STORAGE_IO for a code it has never seen', () => {
    // Open rather than exhaustive on purpose: SQLite adds extended result codes, and a mapping
    // that threw on an unknown one would turn a new SQLite release into an outage.
    expect(storageCodeFor(sqlite('SQLITE_SOMETHING_NEW'))).toBe('STORAGE_IO');
  });
});

describe('SQLITE_NOTADB — the judgement the error cannot make', () => {
  it('is a wrong key when the database was opened with one', () => {
    expect(storageCodeFor(sqlite('SQLITE_NOTADB'), { encrypted: true })).toBe(
      'STORAGE_KEY_INVALID',
    );
  });

  it('is corruption when it was not', () => {
    expect(storageCodeFor(sqlite('SQLITE_NOTADB'), { encrypted: false })).toBe('STORAGE_CORRUPT');
    expect(storageCodeFor(sqlite('SQLITE_NOTADB'))).toBe('STORAGE_CORRUPT');
  });

  it('tells the host not to restore over a database that may be fine', () => {
    // The sentence that matters. "Corrupt" invites a restore; a wrong key must not.
    const error = mapSqliteError(sqlite('SQLITE_NOTADB'), { encrypted: true });
    expect(error.storageCode).toBe('STORAGE_KEY_INVALID');
    expect(error.hint).toContain('do not restore over it');
  });
});

describe('triggers that raise our own codes', () => {
  it.each(['I4_LABEL_GROUP_MISMATCH', 'MEMORY_CONTENT_IMMUTABLE', 'AUDIT_APPEND_ONLY'])(
    'surfaces a RAISE(ABORT, %s) as that code',
    (raised) => {
      const error = sqlite('SQLITE_CONSTRAINT_TRIGGER', raised);
      expect(raisedCodeOf(error)).toBe(raised);
      expect(storageCodeFor(error)).toBe(raised);
    },
  );

  it('matches the raised name as a whole word', () => {
    // `AUDIT_APPEND_ONLY_V2` is not `AUDIT_APPEND_ONLY`. A substring match would quietly report a
    // future invariant as an old one, with the old one's explanation.
    expect(raisedCodeOf(sqlite('SQLITE_CONSTRAINT_TRIGGER', 'AUDIT_APPEND_ONLY_V2'))).toBe(
      undefined,
    );
  });

  it('marks our own invariants as bugs, not as host problems', () => {
    // A host cannot do anything about an I4 violation. Categorising it as `io.failed` would put it
    // in the same bucket as a full disk and send them looking at their hardware.
    const error = mapSqliteError(sqlite('SQLITE_CONSTRAINT_TRIGGER', 'I4_LABEL_GROUP_MISMATCH'));
    expect(error.code).toBe('bug');
    expect(error.storageCode).toBe('I4_LABEL_GROUP_MISMATCH');
    expect(error.hint).toContain('invariant I4');
  });

  it('falls back to a plain constraint failure for a trigger that raised something else', () => {
    expect(storageCodeFor(sqlite('SQLITE_CONSTRAINT_TRIGGER', 'SOME_OTHER_RULE'))).toBe(
      'STORAGE_CONSTRAINT',
    );
  });
});

describe('what goes into detail (01 §11.7)', () => {
  it('names the constraint, and never the values that collided', () => {
    // A unique-constraint message includes the **values**, which for this product can be a
    // person's name or a phone number. Only the index name belongs in structured detail.
    const error = mapSqliteError(
      sqlite(
        'SQLITE_CONSTRAINT_UNIQUE',
        'UNIQUE constraint failed: members.group_id, members.person_id',
      ),
    );
    expect(error.detail).toMatchObject({
      sqliteCode: 'SQLITE_CONSTRAINT_UNIQUE',
      constraint: 'members.group_id, members.person_id',
    });
  });

  it.each([
    ['UNIQUE constraint failed: outbox.idem_key', 'outbox.idem_key'],
    ['FOREIGN KEY constraint failed', 'foreign key'],
    ['CHECK constraint failed: turns_role_valid', 'turns_role_valid'],
    ['NOT NULL constraint failed: turns.group_id', 'turns.group_id'],
  ])('reads the constraint out of %s', (message, expected) => {
    expect(constraintNameOf(sqlite('SQLITE_CONSTRAINT', message))).toBe(expected);
  });

  it('reports no constraint when the message names none', () => {
    expect(constraintNameOf(sqlite('SQLITE_BUSY', 'database is locked'))).toBeUndefined();
    // `StorageError` merges its own code into `detail`, which is what makes a log line actionable
    // without the message — so the full detail is the pair, and `constraint` is absent.
    expect(mapSqliteError(sqlite('SQLITE_BUSY')).detail).toEqual({
      storageCode: 'STORAGE_BUSY',
      sqliteCode: 'SQLITE_BUSY',
    });
  });
});

describe('expected conflicts are not errors (02 §4.3)', () => {
  it('recognises a unique violation', () => {
    expect(
      isUniqueViolation(sqlite('SQLITE_CONSTRAINT_UNIQUE', 'UNIQUE constraint failed: a.b')),
    ).toBe(true);
    expect(
      isUniqueViolation(sqlite('SQLITE_CONSTRAINT_PRIMARYKEY', 'UNIQUE constraint failed: a.id')),
    ).toBe(true);
  });

  it('does not mistake a foreign-key or check failure for one', () => {
    // **The reason this function exists.** A caller that treated any `STORAGE_CONSTRAINT` as
    // "already there" would swallow a foreign-key violation — a bug — and report it as a
    // successful no-op.
    expect(isUniqueViolation(sqlite('SQLITE_CONSTRAINT_FOREIGNKEY'))).toBe(false);
    expect(isUniqueViolation(sqlite('SQLITE_CONSTRAINT_CHECK'))).toBe(false);
    expect(isUniqueViolation(sqlite('SQLITE_CONSTRAINT_NOTNULL'))).toBe(false);
    expect(isUniqueViolation(sqlite('SQLITE_BUSY'))).toBe(false);
    expect(isUniqueViolation(new Error('plain'))).toBe(false);
  });

  it('can be narrowed to one index, which is what a dedupe caller needs', () => {
    // An outbox insert cares about *its* idempotency index. Any other unique index firing is a
    // different event and must not be read as "already enqueued".
    const conflict = sqlite(
      'SQLITE_CONSTRAINT_UNIQUE',
      'UNIQUE constraint failed: outbox.idem_key',
    );
    expect(isUniqueViolation(conflict, 'outbox.idem_key')).toBe(true);
    expect(isUniqueViolation(conflict, 'members.person_id')).toBe(false);
  });

  it('works on an already-mapped StorageError too', () => {
    // A repository may catch a `StorageError` from a layer below rather than a raw SQLite error.
    const mapped = mapSqliteError(
      sqlite('SQLITE_CONSTRAINT_UNIQUE', 'UNIQUE constraint failed: outbox.idem_key'),
    );
    expect(isUniqueViolation(mapped, 'outbox.idem_key')).toBe(true);
    expect(isUniqueViolation(mapped, 'something.else')).toBe(false);
    expect(isUniqueViolation(mapSqliteError(sqlite('SQLITE_BUSY')))).toBe(false);
  });
});

describe('mapping anything at all', () => {
  it('passes an already-mapped error through unchanged', () => {
    // Otherwise a `StorageError` thrown by `open.ts` would be re-wrapped by a caller's catch and
    // lose its code — which is how a `STORAGE_KEY_INVALID` becomes a generic IO failure.
    const original = new StorageError('STORAGE_KEY_INVALID', 'nope');
    expect(mapSqliteError(original)).toBe(original);
  });

  it('maps a non-SQLite throw to STORAGE_IO, keeping the cause', () => {
    const cause = new Error('the disk went away');
    const error = mapSqliteError(cause, { operation: 'reading the schema' });
    expect(error.storageCode).toBe('STORAGE_IO');
    expect(error.message).toContain('while reading the schema');
    expect(error.cause).toBe(cause);
  });

  it('maps a thrown non-Error without losing it', () => {
    const error = mapSqliteError('a string, somehow');
    expect(error.storageCode).toBe('STORAGE_IO');
    expect(error.cause).toBe('a string, somehow');
  });

  it('names the operation without ever including SQL', () => {
    // SQL text can contain message content. The operation is a short phrase chosen by the caller.
    const error = mapSqliteError(sqlite('SQLITE_BUSY'), { operation: 'opening /data/db/x.db' });
    expect(error.message).toBe(
      'the database was locked by another connection for longer than the timeout while opening /data/db/x.db',
    );
  });

  it('always carries the sqlite code in detail, so a log line is actionable', () => {
    for (const code of ['SQLITE_BUSY', 'SQLITE_CORRUPT', 'SQLITE_FULL']) {
      expect(mapSqliteError(sqlite(code)).detail).toMatchObject({ sqliteCode: code });
    }
  });

  it('gives every mapped code a hint except the open-ended fallback', () => {
    // A code with no hint is a dead end for a host. `STORAGE_IO` is the exception by design: it is
    // the bucket for things with no specific advice, and it gets the generic one.
    for (const code of ['SQLITE_BUSY', 'SQLITE_CORRUPT', 'SQLITE_FULL', 'SQLITE_CONSTRAINT']) {
      expect(mapSqliteError(sqlite(code)).hint, code).toBeDefined();
    }
    expect(mapSqliteError(new Error('x')).hint).toContain('Check the disk');
  });
});
