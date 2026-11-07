/**
 * `exportDomainState(groupId)` — a group's entire domain state as canonical JSON (`02` §4.1).
 *
 * `01` §11.5 and `02` §4.1 both describe this as the equality oracle for **replay and chaos**
 * tests. That is the whole reason it exists and the reason it is shaped the way it is: a chaos
 * test kills the process mid-turn, restarts it, and has to assert that the recovered state equals
 * the state a clean run would have produced. "Equals" has to mean something exact, over every
 * table, independent of insertion order and of the autoincrement ids a different interleaving
 * would hand out.
 *
 * So three decisions:
 *
 *  - **Canonical JSON** (`shared/json/canonical.ts`), so two states that differ only in key order
 *    or float formatting compare equal — and two that differ in content never do.
 *  - **Rows sorted by a stable key**, never by `rowid`. A crash and a replay insert the same rows
 *    in a different order, so `rid` differs while the state does not. Sorting by the row's own
 *    identity is what makes the comparison about content.
 *  - **Volatile columns excluded by name**, not by guesswork. `created_at`, `updated_at` and the
 *    autoincrement surrogates differ between two runs that are otherwise identical, and including
 *    them would make every chaos assertion fail for the wrong reason. The excluded set is listed
 *    explicitly below so it is reviewable, because each exclusion is also a thing this oracle
 *    stops checking.
 */
import { type CanonicalValue, canonicalJson } from '@comvivo/shared';
import type Database from 'better-sqlite3-multiple-ciphers';

/**
 * Columns that legitimately differ between two runs of the same work.
 *
 * Every entry is a blind spot, so each needs a reason:
 *
 *  - `rid`, `seq`, `id` on an `INTEGER PRIMARY KEY AUTOINCREMENT` table — a different interleaving
 *    hands out different numbers for the same rows;
 *  - `created_at`/`updated_at`/`applied_at` and the other wall-clock stamps — a replay happens
 *    later than the original;
 *  - `boot_id` — a restart is a different process incarnation by definition, which is the point
 *    of the column.
 *
 * Note what is **not** here: `label_id`. It is an interned integer and could in principle differ,
 * but `02` §3.2's interning is deterministic in canonical-key order, so two runs that label the
 * same data the same way get the same ids — and a difference in `label_id` is exactly the kind of
 * IFC bug this oracle must be able to see.
 */
export const VOLATILE_COLUMNS: ReadonlySet<string> = new Set([
  'rid',
  'seq',
  'created_at',
  'updated_at',
  'applied_at',
  'last_claimed_at',
  'observed_at',
  'boot_id',
  'duration_ms',
]);

/** Tables that hold no group-scoped domain state. */
const NON_DOMAIN_TABLES: ReadonlySet<string> = new Set([
  '_schema_migrations',
  'app_meta',
  'instance',
  'embedding_spaces',
  'job_partitions',
]);

/** A column of a table, as `PRAGMA table_info` reports it. */
interface ColumnInfo {
  readonly name: string;
  readonly pk: number;
}

/** Every real table in the database, excluding SQLite's own and the FTS/vec shadow tables. */
export function domainTables(db: Database.Database): readonly string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%'
           AND name NOT LIKE '%_fts'
           AND name NOT LIKE '%_fts_%'
           AND name NOT LIKE '%_fts%data'
           AND name NOT LIKE 'vec_memory_%'
         ORDER BY name`,
      )
      .all() as { name: string }[]
  )
    .map((row) => row.name)
    .filter((name) => !NON_DOMAIN_TABLES.has(name) && !isShadowTable(name));
}

/**
 * Whether a table is an FTS5 or vec0 shadow table.
 *
 * FTS5 creates `<name>_data`, `_idx`, `_content`, `_docsize` and `_config` siblings. Matching on
 * those suffixes rather than on a prefix of the virtual table's name keeps the rule from depending
 * on what the virtual tables happen to be called.
 */
function isShadowTable(name: string): boolean {
  return /_(data|idx|content|docsize|config|rowids|chunks|vector_chunks\d+|info|auxiliary)$/.test(
    name,
  );
}

function columnsOf(db: Database.Database, table: string): readonly ColumnInfo[] {
  return db.pragma(`table_info(${JSON.stringify(table)})`) as ColumnInfo[];
}

/**
 * The columns a table's rows are ordered by.
 *
 * Its declared primary key, minus the volatile surrogates — so a table keyed only on an
 * autoincrement `rid` falls back to its own `id`, and one keyed on a composite uses that. A table
 * with no stable key at all is sorted by its whole canonical row, which is deterministic and says
 * what it can.
 */
function sortKeyColumns(columns: readonly ColumnInfo[]): readonly string[] {
  const declared = columns
    .filter((column) => column.pk > 0)
    .map((column) => column.name)
    .filter((name) => !VOLATILE_COLUMNS.has(name));
  if (declared.length > 0) return declared;
  const identity = columns.find((column) => column.name === 'id');
  return identity === undefined ? [] : [identity.name];
}

/**
 * Whether a table is scoped to one group, and under which column.
 *
 * **`groups` is scoped by its own `id`.** It has no `group_id`, so the first version of this
 * skipped it outright — the group's own name, archetype, timezone, status and membership epoch
 * were simply absent from its domain state, and the oracle happily reported two differently-named
 * groups as identical. Found by the test that renames a group and expects the state to change.
 */
function groupColumn(table: string, columns: readonly ColumnInfo[]): string | undefined {
  if (table === 'groups') return 'id';
  return columns.some((column) => column.name === 'group_id') ? 'group_id' : undefined;
}

export interface DomainStateOptions {
  /** Also exclude these columns. For a test that knows one of its own fields is volatile. */
  readonly exclude?: readonly string[];
  /** Include tables that hold no `group_id`, which are instance-wide. Off by default. */
  readonly includeUngrouped?: boolean;
}

/**
 * Every row of every group-scoped table, as canonical JSON.
 *
 * Tables with no `group_id` are skipped unless `includeUngrouped` is set: a group's state is what
 * a purge must remove and what an export must contain, and an instance-wide table is neither.
 */
export function exportDomainState(
  db: Database.Database,
  groupId: string,
  options: DomainStateOptions = {},
): string {
  const excluded = new Set([...VOLATILE_COLUMNS, ...(options.exclude ?? [])]);
  const state: Record<string, CanonicalValue> = {};

  for (const table of domainTables(db)) {
    const columns = columnsOf(db, table);
    const scope = groupColumn(table, columns);
    if (scope === undefined && options.includeUngrouped !== true) continue;

    const kept = columns.map((column) => column.name).filter((name) => !excluded.has(name));
    if (kept.length === 0) continue;

    const selected = kept.map((name) => `"${name}"`).join(', ');
    const where = scope === undefined ? '' : `WHERE "${scope}" = ?`;
    const parameters = scope === undefined ? [] : [groupId];
    const rows = db
      .prepare(`SELECT ${selected} FROM "${table}" ${where}`)
      .all(...parameters) as Record<string, unknown>[];
    if (rows.length === 0) continue;

    const sortKeys = sortKeyColumns(columns).filter((name) => kept.includes(name));
    state[table] = rows.map((row) => normalizeRow(row)).sort(compareBy(sortKeys));
  }

  return canonicalJson(state);
}

/**
 * Make one row canonical-JSON-safe.
 *
 * `Buffer` becomes lowercase hex rather than a byte array: a digest or a wrapped key is compared
 * for equality, and hex is both shorter and legible in a failure diff. `bigint` becomes a decimal
 * string, because JSON has no bigint and silently losing precision on a rowid would make two
 * different states compare equal.
 */
function normalizeRow(row: Record<string, unknown>): Record<string, CanonicalValue> {
  const out: Record<string, CanonicalValue> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) out[key] = null;
    else if (Buffer.isBuffer(value)) out[key] = value.toString('hex');
    else if (typeof value === 'bigint') out[key] = value.toString();
    else if (typeof value === 'number' || typeof value === 'string') out[key] = value;
    else {
      // SQLite returns only NULL, INTEGER, REAL, TEXT and BLOB, which the branches above cover.
      // Anything else means the driver changed under us, and the oracle cannot represent the state
      // faithfully — so it says so rather than stringifying to `[object Object]`, which would make
      // two different states compare equal and quietly disarm every replay and chaos assertion.
      throw new TypeError(
        `exportDomainState cannot represent a ${typeof value} in column ${key}: the driver ` +
          "returned a value outside SQLite's five storage classes",
      );
    }
  }
  return out;
}

/**
 * One sort-key value as a comparable string.
 *
 * A key column is a scalar in every table here, but `CanonicalValue` admits objects and arrays, so
 * the non-scalar case goes through `canonicalJson` rather than `String` — which would collapse
 * every object to `[object Object]` and make unequal rows sort as equal.
 */
function sortValue(value: CanonicalValue | undefined): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return canonicalJson(value);
}

/** Order rows by the given columns, falling back to their whole canonical form. */
function compareBy(keys: readonly string[]) {
  return (left: Record<string, CanonicalValue>, right: Record<string, CanonicalValue>): number => {
    for (const key of keys) {
      const a = sortValue(left[key]);
      const b = sortValue(right[key]);
      if (a !== b) return a < b ? -1 : 1;
    }
    const a = canonicalJson(left);
    const b = canonicalJson(right);
    return a === b ? 0 : a < b ? -1 : 1;
  };
}
