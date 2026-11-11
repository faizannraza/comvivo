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
import { type SQL, sql } from 'drizzle-orm';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
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
/**
 * `column = value`, with the query planner told **not** to use an index on `column`.
 *
 * SQLite's unary `+` on a column reference in a `WHERE` term makes that term unusable as an index
 * constraint while leaving the comparison itself intact. It exists for exactly the case `M1-T33`
 * measured on the 1M-message fixture:
 *
 * ```
 * WHERE id IN (<200 ids>) AND group_id = ?     → SEARCH USING memory_fingerprint_idx (group_id=?)
 *                                                17.0 ms p50
 * WHERE id IN (<200 ids>) AND +group_id = ?    → SEARCH USING memory_items_id_unique (id=?)
 *                                                0.438 ms p50
 * ```
 *
 * Same 200 rows, 39× apart. Given a group predicate *and* a 200-element id list, the planner
 * prefers the group index and then filters 30,000 rows; with the hint it does 200 primary-key
 * lookups. The group equality is still evaluated, so **I4 is unchanged** — this is a hint about
 * *how* to find the rows, not about which rows are allowed.
 *
 * Use it only where a more selective term exists in the same `WHERE`. On a query whose only
 * predicate is the group, this would turn an index scan into a table scan.
 */
export function eqUnindexed(column: AnySQLiteColumn, value: unknown): SQL {
  return sql`+${column} = ${value}`;
}

/**
 * `column IN (values)`, with the query planner told **not** to use an index on `column`.
 *
 * The companion to `eqUnindexed`, and needed for the same reason on a second term. Every
 * IFC-filtered read carries an eligibility list — `label_id IN (<the audience's labels>)` — and on
 * a read that *also* has an id list, the planner has two indexable candidates and picks by
 * guesswork, because a fresh database has no `sqlite_stat1`. Which one it picks depends on how
 * many labels the group has, so the fast plan and the slow plan differ by **group size**:
 *
 * ```
 * 42 labels  (20 members):  id IN (<200>) AND  label_id IN (…) → memory_label_idx      13.1 ms
 *                           id IN (<200>) AND +label_id IN (…) → memory_items_id_unique 0.206 ms
 * 302 labels (150 members): either way                         → memory_items_id_unique 0.21 ms
 * ```
 *
 * 64× on the same 200 rows, and the *small* group is the slow one — which is the common case and
 * the one no correctness test can see. Measured in `M1-T33` on the `knn-50k` and `stress-50k-1m`
 * fixtures; `storage-benchmarks.md` carries the method.
 *
 * The list is still evaluated, so eligibility is unchanged (`I4`): this says *how* to find the
 * rows, never which rows may be returned. Use it only where a more selective term — an id or rid
 * list — exists in the same `WHERE`. On a read whose only predicate is the eligibility list,
 * driving from the label index is the right plan and this would force a table scan.
 */
export function inArrayUnindexed(column: AnySQLiteColumn, values: readonly unknown[]): SQL {
  // An empty list is `1 = 0`, matching what `inArray` does — and the callers all return early on
  // an empty eligibility set, so this is the belt rather than the braces.
  if (values.length === 0) return sql`1 = 0`;
  return sql`+${column} IN ${values}`;
}

export function maybeOne<T>(query: { get(): T }): T | undefined {
  return query.get();
}

/**
 * `.get()` where a row is **guaranteed**, with a loud failure if it is not.
 *
 * Two statement shapes qualify, and `02` has both:
 *
 *  - **`INSERT … RETURNING`** — SQLite yields a row when the insert succeeds and throws when it
 *    does not, so there is no third outcome.
 *  - **an aggregate with no `GROUP BY`** — `SELECT coalesce(sum(x), 0) …` yields exactly one row
 *    whether or not anything matched, which is what makes `UsageReader.spend` read an empty window
 *    as zeros (`M1-T21`).
 *
 * `maybeOne` would be wrong for either — not because the check is unnecessary, but because the
 * only honest response to its `undefined` is to stop. Returning it would push an impossible state
 * into the caller, which is how a `TypeError` ends up three frames away from the statement that
 * caused it; and a `?? ZERO` fallback at the call site would be a branch no test can reach.
 *
 * `NonNullable<T>` because drizzle types `.get()` differently for the two shapes: non-optional
 * after `.returning()` and `Row | undefined` after `.select()`. Stripping it here means one helper
 * serves both rather than each call site narrowing in its own way.
 *
 * The same guard `LabelStore.intern` already carries in longhand ("`INSERT … RETURNING id` always
 * yields a row when it succeeds"), in one place so every repository words it identically.
 */
export function exactlyOne<T>(query: { get(): T }, what: string): NonNullable<T> {
  const row = query.get() as T | undefined;
  if (row === undefined) {
    throw new StorageError('STORAGE_IO', `reading or writing ${what} returned no row`, {
      hint: 'This is a bug: `INSERT … RETURNING` and an aggregate without `GROUP BY` both always yield a row.',
      category: 'bug',
    });
  }
  return row as NonNullable<T>;
}
