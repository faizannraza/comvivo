/**
 * Every `RAISE(ABORT, …)` the shipped migrations contain is a code `raisedCodeOf` recognises.
 *
 * ## Why this test exists
 *
 * `RAISED_CODES` in `errors.ts` is a hand-written list, and a trigger whose code is missing from
 * it still fails the write — it just reports `STORAGE_CONSTRAINT`, "a write broke a database
 * constraint", which names neither the invariant nor the table. `errors.ts` already carried a
 * comment saying so, added at `M1-T13` when three codes were added to fix exactly that.
 *
 * Two were still missing. `I4_GROUP_IMMUTABLE` and `I4_PARENT_GROUP_MISMATCH` have been raised by
 * the guard triggers since `0001`, and both surfaced as the generic constraint error until
 * `M3-T1`, where a test that asserted the parent-group abort **by name** could not see it. A
 * comment asking the next person to remember is not a check; this is the check.
 *
 * It reads the migrations rather than `guards.sql.ts` on purpose: the files are what a host runs,
 * and a generator that stopped emitting a trigger would make a `guards.sql.ts`-based version of
 * this test pass by having nothing left to find.
 */
import { describe, expect, it } from 'vitest';
import { MIGRATION_FILES, migrationSql } from '../schema/testing/migrated-db.js';
import { isSqliteError, raisedCodeOf, type SqliteError } from './errors.js';

/** Every distinct code the migrations raise, in the order they first appear. */
function raisedInMigrations(): readonly string[] {
  const found = new Set<string>();
  for (const file of MIGRATION_FILES) {
    for (const match of migrationSql(file).matchAll(/RAISE\(ABORT,\s*'([A-Z0-9_]+)'/g)) {
      const code = match[1];
      if (code !== undefined) found.add(code);
    }
  }
  return [...found].toSorted();
}

/** A `SqliteError` shaped the way better-sqlite3 reports a trigger abort. */
function triggerAbort(code: string): SqliteError {
  const error = new Error(`SQLITE_CONSTRAINT_TRIGGER: ${code}`) as Error & {
    code?: string;
  };
  error.code = 'SQLITE_CONSTRAINT_TRIGGER';
  if (!isSqliteError(error)) throw new Error('the fixture is not shaped like a SqliteError');
  return error;
}

describe('the raised-code list and the migrations (02 §3.2 D5)', () => {
  it('recognises every code the shipped triggers raise', () => {
    const raised = raisedInMigrations();
    // Non-vacuity: a regex that matched nothing would make the loop below assert nothing at all.
    expect(raised.length).toBeGreaterThanOrEqual(8);
    const unrecognised = raised.filter((code) => raisedCodeOf(triggerAbort(code)) !== code);
    expect(unrecognised, 'add these to RAISED_CODES and DESCRIPTIONS in db/errors.ts').toEqual([]);
  });
});
