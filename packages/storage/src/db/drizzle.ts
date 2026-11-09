/**
 * The Drizzle handle repositories query through (`02` §3.7.2).
 *
 * `02` §3.7.2 specifies "the Drizzle query builder with sync terminal methods (`.all()`, `.get()`,
 * `.run()`)", and the reason is stronger than style: **the custom column types in `schema/_columns.ts`
 * are the validated boundary.** `instantMs` refuses an epoch outside Temporal's representable range
 * and raises `STORAGE_CORRUPT` on the way *out* of a column; `tid` parses a TypeID and rejects a
 * malformed one; `tzText` rejects a zone this platform does not know; `jsonOf` validates against
 * the column's zod schema. A repository that issued raw SQL would read those columns as bare
 * numbers and strings and skip every one of those checks — `CLAUDE.md` §2's "validate every
 * boundary" includes the boundary between a column and a domain object.
 *
 * **Relational queries (`db.query.*`) are not used** (§3.7.2). They need the relations graph, they
 * emit a different shape of SQL than the index work in `02` §3.3.10 was planned against, and the
 * one thing a repository here must be able to state is which index a query uses.
 *
 * `better-sqlite3` is synchronous, so every terminal method is too. That is what makes `02` §3.7.1's
 * "`fn` MUST be synchronous" possible at all: an `await` inside a transaction would let another
 * task interleave statements into it.
 */
import { StorageError } from '@comvivo/shared';
import type Database from 'better-sqlite3-multiple-ciphers';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../schema/index.js';

/** The typed handle a repository holds. */
export type Db = BetterSQLite3Database<typeof schema>;

/**
 * A partial update where an absent field may be spelled as an explicit `undefined`.
 *
 * `Partial<T>` is not this type under `exactOptionalPropertyTypes`: it makes each property
 * *optional* but still refuses an explicit `undefined` as its value. Drizzle treats `undefined` in
 * a `.set()` as "leave this column alone" (measured; `maybe-one.int.test.ts` pins it), which is
 * what lets a patch be a plain object literal instead of a conditional spread per field — so the
 * parameter type has to admit the value the caller will actually pass.
 */
export type Patch<T> = { [K in keyof T]?: T[K] | undefined };

/**
 * Wrap an open `better-sqlite3` connection.
 *
 * Takes an already-open handle rather than a path: `db/open.ts` owns opening, keying and the pragma
 * list, and a second code path that opened a database would be a second place for the encryption
 * pragmas to be forgotten (`02` §3.6.2). One connection, one handle.
 *
 * `logger: false` because Drizzle's logger prints **parameters**, and a parameter here is message
 * text, a member handle or a memory. `CLAUDE.md` §2 bans content from logs above `debug`, and
 * `02` §3.7.2's slow-transaction log records the `op` and the duration for the same reason.
 */
export function makeDb(connection: Database.Database): Db {
  return drizzle(connection, { schema, logger: false });
}

/**
 * `.get()`, typed the way it actually behaves.
 *
 * Drizzle types the `.get()` terminal as returning the row type, **not** `T | undefined` — and at
 * runtime it returns `undefined` whenever nothing matched. Measured, on
 * `drizzle-orm` as pinned here: an `UPDATE … WHERE id = 99 RETURNING … .get()` against a table with
 * no such row gives `undefined`, and so does the `SELECT` form. `maybe-one.int.test.ts` pins both.
 *
 * Without this, `row === undefined` — the check every `not_found` and `conflict` answer in
 * `repos/` rests on — is flagged by `@typescript-eslint/no-unnecessary-condition` as a comparison
 * with no overlap. The rule is reading the declared type correctly; the declared type is wrong.
 * Deleting the check to satisfy it would turn "no row matched" into a crash on the next property
 * access, which is the opposite of the repair.
 *
 * So this is a **correcting** cast, not a convenience one: one place, justified by a measurement,
 * and pinned by a test that fails if a future `drizzle-orm` either fixes the type or changes the
 * behaviour. `CLAUDE.md` §2 — fix the design rather than weaken the rule — and the design fix for
 * a library type that under-reports its own nullability is to narrow it once at the boundary.
 */
export function maybeOne<T>(query: { get(): T }): T | undefined {
  return query.get();
}

/**
 * `.get()` where a row is **guaranteed**, with a loud failure if it is not.
 *
 * For `INSERT … RETURNING`: SQLite yields a row when the insert succeeds and throws when it does
 * not, so there is no third outcome. `maybeOne` would be wrong here — not because the check is
 * unnecessary, but because the only honest response to its `undefined` is to stop. Returning it
 * would push an impossible state into the caller, which is how a `TypeError` ends up three frames
 * away from the statement that caused it.
 *
 * The same guard `LabelStore.intern` already carries in longhand ("`INSERT … RETURNING id` always
 * yields a row when it succeeds"), in one place so every repository words it identically.
 */
export function exactlyOne<T>(query: { get(): T }, what: string): T {
  const row = query.get() as T | undefined;
  if (row === undefined) {
    throw new StorageError('STORAGE_IO', `writing ${what} returned no row`, {
      hint: 'This is a bug: `INSERT … RETURNING` always yields a row when it succeeds.',
      category: 'bug',
    });
  }
  return row;
}
