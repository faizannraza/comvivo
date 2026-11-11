/**
 * What a purge has to empty, discovered from the database rather than listed (`02` §3.13.4).
 *
 * `02` §3.13.4 gives the purge's delete order as a sequence of table groups, and `02` §9.3's
 * `group.purge.test` gives the acceptance criterion as "zero rows with the group id in any table
 * (an introspection loop over `sqlite_schema`)". A hand-written list satisfies the first and fails
 * the second the moment a milestone adds a table — and M3 through M10 add forty of them.
 *
 * Worse, the failure would be **invisible**. Every group-scoped table cascades from `groups`
 * (`02` §3.3.1), so the purge's final `DELETE FROM groups` removes whatever the explicit steps
 * missed. The test would pass, the data would be gone, and the thing that was actually lost is the
 * property the chunking exists for: `02` D18 refuses a one-million-row cascade in a single
 * transaction because it blocks the event loop for seconds. A missed table is not a leak, it is a
 * stall — which is exactly the kind of defect that ships.
 *
 * So the inventory is introspected: every table with a `group_id` column, ordered children before
 * parents. A new table joins the purge by existing. `inventory.int.test.ts` enumerates the same set
 * from the **drizzle schema objects** instead, so the two disagree if either is wrong — one
 * enumeration checked against itself proves nothing.
 *
 * ## Why the order still matters when the cascades would cope
 *
 * Every one of these foreign keys is `ON DELETE CASCADE` or `SET NULL`, so any order deletes
 * everything. What the order buys is that each step's count is its **own** work: delete `messages`
 * before `message_attachments` and the attachment step finds nothing, reports zero, and the purge
 * concludes it is done while the real work happened invisibly inside one statement. Children first
 * keeps the chunking honest.
 */
import type Database from 'better-sqlite3-multiple-ciphers';

/** One table the purge visits, and the column that scopes it to a group. */
export interface GroupScopedTable {
  readonly table: string;
  /** `group_id`, or `id` for `groups` itself. */
  readonly column: string;
  /** vec0 virtual tables are keyed on `rid` and have no usable `rowid`. */
  readonly virtual: boolean;
}

/**
 * Tables that are never group-scoped, even though a column might suggest it.
 *
 * `deletions` is the important one and `02` §3.3.8 says why: the row recording that a group was
 * deleted must survive the group. It carries a `group_id` and deliberately **no** foreign key, so
 * introspection alone would purge the evidence of the purge.
 */
const NEVER_PURGED: ReadonlySet<string> = new Set([
  'deletions',
  // Migration bookkeeping. No `group_id`, listed for the reader rather than for the filter.
  '__drizzle_migrations',
]);

interface SqliteSchemaRow {
  readonly name: string;
  readonly sql: string | null;
}

interface ColumnRow {
  readonly name: string;
}

interface ForeignKeyRow {
  readonly table: string;
}

/**
 * Every table, in name order, with its DDL so a virtual table can be told apart.
 *
 * `type = 'table'` includes virtual tables, which is what makes a vec0 space visible at all.
 */
function allTables(conn: Database.Database): readonly SqliteSchemaRow[] {
  return conn
    .prepare(
      `SELECT name, sql FROM sqlite_schema
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all() as SqliteSchemaRow[];
}

function isVirtual(row: SqliteSchemaRow): boolean {
  return (row.sql ?? '').toUpperCase().includes('CREATE VIRTUAL TABLE');
}

/**
 * Which tables are shadow tables, asked of SQLite rather than guessed from their names.
 *
 * A shadow table is, by SQLite's own definition, a table whose name is `<virtual-table>_<suffix>`.
 * So the virtual tables are enumerated first and anything under one of their prefixes is a shadow
 * of it. **No suffix list**, which is the point: the first version of this carried the regex from
 * `testing/domain-state.ts` — `_(data|idx|content|docsize|config|rowids|chunks|vector_chunks\d+|`
 * `info|auxiliary)$` — and sqlite-vec 0.1.9 also creates `_metadatachunks00`, `_metadatachunks01`,
 * `_metadatachunks02` and `_metadatatext02`, none of which it matches. The vec test caught it on
 * the first run; a **purge** would have tried to `DELETE FROM vec_memory_x_metadatachunks00`,
 * which is how a vector index gets corrupted rather than emptied.
 *
 * That regex is harmless where it lives only because its query already excludes `vec_memory_%` and
 * `%_fts%` by prefix. `domain-state.ts` now delegates here, so there is one answer.
 */
export function shadowTables(conn: Database.Database): ReadonlySet<string> {
  const rows = allTables(conn);
  const prefixes = rows.filter(isVirtual).map((row) => `${row.name}_`);
  const shadows = new Set<string>();
  for (const row of rows) {
    if (prefixes.some((prefix) => row.name.startsWith(prefix))) shadows.add(row.name);
  }
  return shadows;
}

/** Every real table: shadow tables, SQLite's own and the never-purged excluded. */
function tablesOf(conn: Database.Database): readonly SqliteSchemaRow[] {
  const shadows = shadowTables(conn);
  return allTables(conn).filter(
    (row) =>
      !shadows.has(row.name) && !NEVER_PURGED.has(row.name) && row.name !== 'sqlite_sequence',
  );
}

function columnNames(conn: Database.Database, table: string): readonly string[] {
  return (conn.pragma(`table_info(${JSON.stringify(table)})`) as ColumnRow[]).map(
    (column) => column.name,
  );
}

/** The tables `table`'s foreign keys point at. */
function parentsOf(conn: Database.Database, table: string): readonly string[] {
  return (conn.pragma(`foreign_key_list(${JSON.stringify(table)})`) as ForeignKeyRow[]).map(
    (row) => row.table,
  );
}

/**
 * Order tables so that every table comes before the tables it references.
 *
 * Kahn's algorithm over the edge "child must be emitted before parent", with the alphabetically
 * first candidate chosen at each step so the order is stable across runs — a purge whose step names
 * changed between two runs would make `deletions.progress` unresumable, which is the one thing it
 * exists for.
 *
 * A cycle cannot stall the sort: whatever is left when no table has zero remaining children is
 * appended in name order. Every foreign key here is `CASCADE` or `SET NULL`, so an order that is
 * wrong is slow rather than broken — and SQLite does permit mutually-referencing tables, so this
 * has to terminate rather than assert.
 */
function childrenFirst(
  names: readonly string[],
  parents: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const present = new Set(names);
  /** How many not-yet-emitted tables reference this one. */
  const pending = new Map<string, number>(names.map((name) => [name, 0]));
  for (const name of names) {
    for (const parent of new Set(parents.get(name) ?? [])) {
      if (parent === name || !present.has(parent)) continue;
      pending.set(parent, (pending.get(parent) ?? 0) + 1);
    }
  }

  const order: string[] = [];
  const remaining = new Set(names);
  while (remaining.size > 0) {
    const ready = [...remaining].filter((name) => (pending.get(name) ?? 0) === 0).sort();
    const next = ready[0];
    if (next === undefined) {
      // A cycle. Emit the rest deterministically rather than looping forever.
      order.push(...[...remaining].sort());
      break;
    }
    order.push(next);
    remaining.delete(next);
    for (const parent of new Set(parents.get(next) ?? [])) {
      if (parent === next || !remaining.has(parent)) continue;
      pending.set(parent, (pending.get(parent) ?? 1) - 1);
    }
  }
  return order;
}

/**
 * Every table a group's rows live in, children before parents, `groups` last.
 *
 * `groups` is included and comes last: it has no `group_id`, so a column-only rule would skip the
 * group's own name, archetype, timezone and membership epoch — and the purge's final act is
 * deleting exactly that row.
 */
export function groupScopedTables(conn: Database.Database): readonly GroupScopedTable[] {
  const tables = tablesOf(conn);
  const scoped = new Map<string, GroupScopedTable>();
  for (const row of tables) {
    const column = row.name === 'groups' ? 'id' : undefined;
    const columns = columnNames(conn, row.name);
    if (column === undefined && !columns.includes('group_id')) continue;
    scoped.set(row.name, {
      table: row.name,
      column: column ?? 'group_id',
      // `CREATE VIRTUAL TABLE` is how a vec0 space is made, and its rows are addressed by the `rid`
      // column rather than by a rowid — so the generic chunked delete cannot be used on it.
      virtual: isVirtual(row),
    });
  }

  const parents = new Map<string, readonly string[]>(
    [...scoped.keys()].map((name) => [name, parentsOf(conn, name)]),
  );
  return childrenFirst([...scoped.keys()], parents).map((name) => {
    const entry = scoped.get(name);
    if (entry === undefined) throw new Error(`unreachable: ${name} left the inventory`);
    return entry;
  });
}

/**
 * Every table that carries a `label_id`, for Q-PRV-3's `deleteByLabelOwner`.
 *
 * Introspected for the same reason the purge's inventory is: `02` §3.13.3 says "all labeled
 * tables" and there are twenty-six of them today. A list would be a list of the ones that existed
 * when it was written, and the rows it forgot are *private* data belonging to a member who asked
 * for it to be deleted — the worst possible thing to miss.
 *
 * `02` §3.2's convention, enforced by `guards.int.test.ts`, is that such a column is named
 * `label_id`. A table that labels its rows under another name is invisible here, and that guard is
 * what keeps the convention from being a comment.
 */
export function labeledTables(conn: Database.Database): readonly string[] {
  return tablesOf(conn)
    .map((row) => row.name)
    .filter((name) => columnNames(conn, name).includes('label_id'))
    .sort();
}

/** The vec0 spaces that hold vectors, by table name. */
export function vectorTables(conn: Database.Database): readonly string[] {
  const shadows = shadowTables(conn);
  return allTables(conn)
    .filter((row) => row.name.startsWith('vec_memory_') && !shadows.has(row.name))
    .map((row) => row.name);
}
