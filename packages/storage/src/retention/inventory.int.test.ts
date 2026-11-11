/**
 * The purge inventory, checked against the drizzle schema rather than against itself (`M1-T26`).
 *
 * `inventory.ts` discovers what a purge must empty by introspecting `sqlite_schema`. A test that
 * introspected the same way would prove only that the function is deterministic: a bug in the
 * introspection — a missed virtual table, a shadow table included, a filter inverted — would be
 * invisible to it, because both sides would be wrong together.
 *
 * So this enumerates the same sets from the **drizzle table objects**, which is a completely
 * different source: TypeScript values built at import time rather than SQL read from a migrated
 * database. The two agree only if both are right.
 */
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import * as schema from '../schema/index.js';
import { withMigratedDb } from '../schema/testing/migrated-db.js';
import { groupScopedTables, labeledTables, vectorTables } from './inventory.js';

/** Every drizzle-declared table, by name. */
function declaredTables(): ReadonlyMap<string, SQLiteTable> {
  const tables = new Map<string, SQLiteTable>();
  for (const value of Object.values(schema)) {
    if (is(value, SQLiteTable)) tables.set(getTableName(value), value);
  }
  return tables;
}

/** The names of a drizzle table's columns, as SQL sees them. */
function columnNames(table: SQLiteTable): readonly string[] {
  return Object.values(getTableColumns(table)).map((column) => column.name);
}

/**
 * Tables `inventory.ts` deliberately leaves out, with the reason.
 *
 * Kept here as data so that removing a reason from the production filter fails this test rather
 * than quietly widening the purge.
 */
const EXCLUDED: Readonly<Record<string, string>> = {
  // `02` §3.3.8: the row recording that a group was deleted must survive the group. It carries a
  // `group_id` with no foreign key precisely so that introspection cannot purge the evidence.
  deletions: 'survives the group it records (02 §3.3.8)',
};

describe('the group-scoped inventory (02 §3.13.4)', () => {
  it('finds exactly the tables the drizzle schema says hold a group id', () => {
    withMigratedDb((db) => {
      const found = new Set(groupScopedTables(db).map((entry) => entry.table));
      const expected = new Set(
        [...declaredTables()]
          .filter(([name, table]) => name === 'groups' || columnNames(table).includes('group_id'))
          .map(([name]) => name)
          .filter((name) => !(name in EXCLUDED)),
      );

      // Spelled as two sorted arrays, so a failure names the tables rather than reporting that two
      // sets differ in size.
      expect([...found].sort()).toEqual([...expected].sort());
      // Non-vacuity: the schema has dozens of group-scoped tables, and a filter that matched
      // nothing would satisfy the equality above against an equally-broken expectation.
      expect(found.size).toBeGreaterThan(40);
      for (const [name, reason] of Object.entries(EXCLUDED)) {
        expect(found.has(name), `${name} is excluded: ${reason}`).toBe(false);
      }
    });
  });

  it('puts every child before the table it references, and `groups` last', () => {
    withMigratedDb((db) => {
      const order = groupScopedTables(db).map((entry) => entry.table);
      const position = new Map(order.map((name, index) => [name, index]));

      // The property, asserted against the real foreign keys: for every FK from A to B where both
      // are in the inventory, A is emitted first. This is what keeps each step's count its own —
      // delete the parent first and the cascade does the child's work inside one statement.
      const violations: string[] = [];
      for (const [name, table] of declaredTables()) {
        const childAt = position.get(name);
        if (childAt === undefined) continue;
        for (const parent of parentNames(db, name)) {
          const parentAt = position.get(parent);
          if (parentAt === undefined || parent === name) continue;
          if (childAt > parentAt) violations.push(`${name} after ${parent}`);
        }
        void table;
      }
      expect(violations).toEqual([]);
      expect(order.at(-1)).toBe('groups');
    });
  });

  it('is stable across calls, because `deletions.progress` resumes by step name', () => {
    withMigratedDb((db) => {
      const first = groupScopedTables(db).map((entry) => entry.table);
      const second = groupScopedTables(db).map((entry) => entry.table);
      expect(second).toEqual(first);
    });
  });

  it('excludes FTS and vec shadow tables, which are maintained by their virtual table', () => {
    withMigratedDb((db) => {
      const found = groupScopedTables(db).map((entry) => entry.table);
      // The shadow tables exist — otherwise this asserts nothing — and none of them is in the
      // inventory. Writing to one directly corrupts the index it belongs to.
      const shadows = (
        db
          .prepare(
            `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
          )
          .all() as { name: string }[]
      )
        .map((row) => row.name)
        .filter((name) => /_(data|idx|content|docsize|config)$/.test(name));
      expect(shadows.length).toBeGreaterThan(3);
      for (const shadow of shadows) expect(found).not.toContain(shadow);
    });
  });
});

describe('the labeled inventory (02 §3.13.3, Q-PRV-3)', () => {
  it('finds exactly the tables the drizzle schema gives a `label_id`', () => {
    withMigratedDb((db) => {
      const found = labeledTables(db);
      const expected = [...declaredTables()]
        .filter(([, table]) => columnNames(table).includes('label_id'))
        .map(([name]) => name)
        .sort();
      expect([...found]).toEqual(expected);
      // `02` §3.2 labels everything a member can see. If this number ever drops, a table stopped
      // being labeled and `deleteByLabelOwner` stopped covering it.
      expect(found.length).toBeGreaterThan(20);
    });
  });
});

describe('the vector inventory (02 §3.13.4)', () => {
  it('finds no space before one is created, and the space table after', () => {
    withMigratedDb((db) => {
      // A fresh database has no space: `04` §3.8 creates one when an embedding provider is
      // configured, so a purge on a text-only instance must find nothing rather than fail.
      expect(vectorTables(db)).toEqual([]);

      db.exec(
        `CREATE VIRTUAL TABLE vec_memory_test USING vec0(
           rid INTEGER PRIMARY KEY, embedding float[4],
           group_id TEXT partition key, label_id INTEGER, received INTEGER)`,
      );
      expect(vectorTables(db)).toEqual(['vec_memory_test']);
    });
  });
});

/** The tables `table`'s foreign keys point at, read from SQLite rather than from drizzle. */
function parentNames(db: Parameters<typeof groupScopedTables>[0], table: string): readonly string[] {
  return (db.pragma(`foreign_key_list(${JSON.stringify(table)})`) as { table: string }[]).map(
    (row) => row.table,
  );
}
