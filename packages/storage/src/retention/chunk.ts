/**
 * The one chunked delete every long deletion is built from (`02` D18).
 *
 * `02` D18 refuses a one-million-row cascade in a single transaction, so nothing here deletes
 * without a `LIMIT`. SQLite's `DELETE` has no `LIMIT` unless it was compiled with
 * `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`, which this build is not — so the rows are selected first and
 * deleted by key, and `limit` means what it says rather than being a suggestion.
 *
 * ## Why this takes a table *name*
 *
 * The purge's table list is introspected (`inventory.ts`), so there is no drizzle object to hand.
 * Two things make the SQL safe: the name comes from `sqlite_schema` — it is a table that exists,
 * never caller input — and it goes through drizzle's `sql.identifier`, which quotes it. Every value
 * is bound. The alternative is a `switch` over fifty drizzle tables, which is the list the
 * introspection exists in order not to maintain.
 *
 * ## vec0 has no `rowid`
 *
 * Measured against sqlite-vec 0.1.9: `SELECT rowid FROM vec_memory_x` fails with *no such column:
 * rowid*, because a vec0 virtual table exposes only its declared columns. Its `rid INTEGER PRIMARY
 * KEY` is the key, `DELETE … WHERE rid IN (…)` works, and `DELETE … WHERE group_id = ?` works too
 * (an unbounded partition delete, which `02` §3.13.4 allows and this does not use). That is the
 * whole reason `GroupScopedTable` carries a `virtual` flag: one wrong column name here would make
 * a purge fail on any instance that has embeddings configured, and on no instance that does not.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '../db/drizzle.js';
import type { GroupScopedTable } from './inventory.js';

/** The key column a chunked delete addresses rows by. */
function keyColumn(entry: Pick<GroupScopedTable, 'virtual'>): string {
  return entry.virtual ? 'rid' : 'rowid';
}

/**
 * Delete up to `limit` rows of `entry` belonging to `groupId`. Returns how many.
 *
 * Zero means the table is clean for this group, which is how the purge loop knows to move on.
 */
export function deleteGroupChunk(
  db: Db,
  entry: GroupScopedTable,
  groupId: string,
  limit: number,
): number {
  const ident = sql.identifier(entry.table);
  const key = sql.identifier(keyColumn(entry));
  const scope = sql.identifier(entry.column);
  const doomed = db.all<{ k: number }>(
    sql`SELECT ${key} AS k FROM ${ident} WHERE ${scope} = ${groupId} LIMIT ${limit}`,
  );
  if (doomed.length === 0) return 0;
  db.run(
    sql`DELETE FROM ${ident} WHERE ${key} IN (${sql.join(
      doomed.map((row) => sql`${row.k}`),
      sql`, `,
    )})`,
  );
  return doomed.length;
}

/**
 * Delete up to `limit` rows of `table` whose `column` equals `value`. Returns how many.
 *
 * The same primitive for the tables a group reaches through something other than `group_id`:
 * `jobs` and `job_schedules` are scoped by `partition_key`, and an erasure walks
 * `channel_identities` and `sessions` by `person_id`. Those tables are not in the group inventory —
 * they have no `group_id` — so without this they would be missed by the introspection and left to
 * no cascade at all.
 */
export function deleteByColumnChunk(
  db: Db,
  table: string,
  column: string,
  value: string,
  limit: number,
): number {
  return deleteGroupChunk(db, { table, column, virtual: false }, value, limit);
}
