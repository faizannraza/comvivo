/**
 * The storage schema as plain data, for `scripts/schema-doc.ts` (`02` §3.3.13, §4, `M1-T35`).
 *
 * Two sources, because the schema has two halves and neither can describe the other:
 *
 *   - **Drizzle** owns the tables. `getTableConfig` reports what the schema modules declare —
 *     columns with their SQL types, nullability and defaults, indexes with their uniqueness and
 *     partial-index predicates, foreign keys with their delete behaviour, and check constraints.
 *     Reading the declarations rather than a migrated database keeps this runnable without the
 *     native module, which is what lets it run in the docs job.
 *   - **The migrations** own everything Drizzle cannot express: the FTS5 and vec0 virtual tables,
 *     and the triggers that keep them and `I4` true (`02` §3.4, §3.5, §3.7.5). Those are raw SQL
 *     by necessity, so they are read back out of the `.sql` files by name.
 *
 * A generated reference is only worth having if it cannot drift, so the generator reads the real
 * declarations and `--check` fails CI on any difference.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { is } from 'drizzle-orm';
import { getTableConfig, type SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import * as schema from '../../packages/storage/src/schema/index.js';

export interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly primary: boolean;
  readonly hasDefault: boolean;
  /** `table.column`, with the delete behaviour, when this column references another table. */
  readonly references?: string;
}

export interface IndexInfo {
  readonly name: string;
  readonly unique: boolean;
  readonly partial: boolean;
  readonly columns: readonly string[];
}

export interface TableInfo {
  readonly name: string;
  /** The schema module that declares it — `messages.ts`, `memory.ts`, … */
  readonly module: string;
  readonly columns: readonly ColumnInfo[];
  readonly indexes: readonly IndexInfo[];
  readonly checks: readonly string[];
  readonly primaryKey: readonly string[];
}

/** A virtual table or trigger: SQL-only, so named rather than described. */
export interface SqlObject {
  readonly kind: 'virtual table' | 'trigger';
  readonly name: string;
  readonly migration: string;
  /** For a virtual table, the module it is `USING`: `fts5` or `vec0`. */
  readonly using?: string;
  /** For a trigger, when it fires — `after insert on messages`. */
  readonly when?: string;
  /** For a trigger, the table it is attached to. */
  readonly on?: string;
}

const SCHEMA_DIR = 'packages/storage/src/schema';
const MIGRATIONS_DIR = 'packages/storage/migrations';

/**
 * Which module declares each exported table, by reading the sources.
 *
 * Drizzle does not record it, and the grouping is most of what makes the reference readable: 78
 * tables in one alphabetical list is a wall, and the same 78 under their modules is a map of the
 * domain.
 */
function modulesByExport(root: string): ReadonlyMap<string, string> {
  const byExport = new Map<string, string>();
  for (const file of readdirSync(join(root, SCHEMA_DIR)).toSorted()) {
    if (!file.endsWith('.ts') || file.includes('.test.') || file.endsWith('.sql.ts')) continue;
    const source = readFileSync(join(root, SCHEMA_DIR, file), 'utf8');
    for (const match of source.matchAll(/export const (\w+) = sqliteTable\(/g)) {
      byExport.set(match[1] ?? '', file);
    }
  }
  return byExport;
}

/**
 * The indexes a column-level `.unique()` creates, which `getTableConfig().indexes` does not list.
 *
 * drizzle keeps a declared `index()`/`uniqueIndex()` in `config.indexes` and a *column's* `.unique()`
 * on the column itself, and `generate` emits a `CREATE UNIQUE INDEX` for both. Reading only the
 * first meant the generated reference reported **109 indexes where the migration creates 125**, and
 * the sixteen it dropped are not incidental: `outbox_messages_idempotency_key_unique` is how `I6`
 * exactly-once intent is enforced in the database, and `turn_effects_idempotency_key_unique` is
 * `I7`. A schema reference that omits the constraint enforcing an invariant is worse than no
 * reference, because it is read as complete. Found by the M1 exit gate's reviewer, who counted the
 * `CREATE INDEX` statements.
 *
 * `partial: false`, always: a column-level unique has no `WHERE`, which is itself worth seeing in
 * the table — a uniqueness that should have been conditional is a real design question.
 */
function columnUniqueIndexes(columns: readonly SQLiteColumn[]): readonly IndexInfo[] {
  const found: IndexInfo[] = [];
  for (const column of columns) {
    // `isUnique`/`uniqueName` are drizzle's own fields on a column built with `.unique()`. They
    // are not in the public `SQLiteColumn` type, so the cast is the narrowest one that reads them.
    const flags = column as unknown as { isUnique?: boolean; uniqueName?: string };
    if (flags.isUnique !== true) continue;
    found.push({
      name: flags.uniqueName ?? `${column.name}_unique`,
      unique: true,
      partial: false,
      columns: [column.name],
    });
  }
  return found;
}

/** Every table the schema declares, grouped by module and sorted by name. */
export function tables(root: string): readonly TableInfo[] {
  const modules = modulesByExport(root);
  const found: TableInfo[] = [];
  for (const [exportName, value] of Object.entries(schema)) {
    if (!is(value, SQLiteTable)) continue;
    const config = getTableConfig(value);
    const references = new Map<string, string>();
    for (const key of config.foreignKeys) {
      const reference = key.reference();
      const target = getTableConfig(reference.foreignTable).name;
      for (const [index, column] of reference.columns.entries()) {
        const foreign = reference.foreignColumns[index]?.name ?? 'id';
        const onDelete = key.onDelete === undefined ? '' : ` on delete ${key.onDelete}`;
        references.set(column.name, `${target}.${foreign}${onDelete}`);
      }
    }
    found.push({
      name: config.name,
      module: modules.get(exportName) ?? 'unknown',
      columns: config.columns.map((column) => {
        const target = references.get(column.name);
        return {
          name: column.name,
          type: column.getSQLType(),
          notNull: column.notNull,
          primary: column.primary,
          hasDefault: column.hasDefault,
          ...(target === undefined ? {} : { references: target }),
        };
      }),
      indexes: [
        ...config.indexes.map((index) => ({
          name: index.config.name,
          unique: index.config.unique,
          partial: index.config.where !== undefined,
          // An index column is either a column or an SQL expression (`lower(handle)`), and only
          // the first has a name. The expression's text is not worth reproducing here — the
          // schema source is — so it is labelled rather than printed.
          columns: index.config.columns.map((column) =>
            'name' in column ? column.name : '(expression)',
          ),
        })),
        ...columnUniqueIndexes(config.columns),
      ].toSorted((left, right) => left.name.localeCompare(right.name)),
      checks: config.checks.map((check) => check.name).toSorted(),
      primaryKey: config.primaryKeys.flatMap((key) => key.columns.map((column) => column.name)),
    });
  }
  return found.toSorted((left, right) => left.name.localeCompare(right.name));
}

/** The virtual tables and triggers the migrations create, by name, in migration order. */
export function sqlObjects(root: string): readonly SqlObject[] {
  const found: SqlObject[] = [];
  for (const file of readdirSync(join(root, MIGRATIONS_DIR)).toSorted()) {
    if (!file.endsWith('.sql')) continue;
    const sql = readFileSync(join(root, MIGRATIONS_DIR, file), 'utf8');
    for (const match of sql.matchAll(
      /CREATE VIRTUAL TABLE (?:IF NOT EXISTS )?(\w+)\s+USING\s+(\w+)/gi,
    )) {
      const using = match[2];
      found.push({
        kind: 'virtual table',
        name: match[1] ?? '',
        migration: file,
        // Spread rather than assigned: `exactOptionalPropertyTypes` distinguishes "absent" from
        // "present and undefined", and `using` is absent for a trigger.
        ...(using === undefined ? {} : { using }),
      });
    }
    // The timing and the table come from the same statement, because a trigger's name is only
    // half of what a reader needs: `memory_items_ai` says nothing, `after insert on memory_items`
    // says what it does.
    const trigger =
      /CREATE TRIGGER (?:IF NOT EXISTS )?(\w+)\s+(BEFORE|AFTER|INSTEAD OF)\s+(INSERT|UPDATE|DELETE)(?:\s+OF\s+[\w\s,]+?)?\s+ON\s+(\w+)/gi;
    for (const match of sql.matchAll(trigger)) {
      found.push({
        kind: 'trigger',
        name: match[1] ?? '',
        migration: file,
        when: `${(match[2] ?? '').toLowerCase()} ${(match[3] ?? '').toLowerCase()}`,
        on: match[4] ?? '',
      });
    }
  }
  return found;
}

/** The migration files, in application order. */
export function migrations(root: string): readonly string[] {
  return readdirSync(join(root, MIGRATIONS_DIR))
    .filter((file) => file.endsWith('.sql'))
    .toSorted();
}
