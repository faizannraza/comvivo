/**
 * `eqUnindexed` and `inArrayUnindexed`: the two planner hints every IFC-filtered read by id uses.
 *
 * These exist because SQLite chooses an index by guesswork on a database with no `sqlite_stat1`,
 * and a read of the shape `id IN (<a known list>) AND group_id = ? AND label_id IN (<eligibility>)`
 * gives it three candidates. Driving from the id list is right by orders of magnitude — `M1-T33`
 * measured 13.1 ms against 0.206 ms for 200 memories — and which one the planner actually picks
 * depends on how many labels the group has, so the slow plan lands on *small* groups: the common
 * case, and one no correctness test can see because the answer is identical either way.
 *
 * So this test asserts the thing a benchmark cannot: the **plan**. Two assertions per hint, and
 * the second matters as much as the first — that the unhinted form still picks the index we are
 * steering away from. If that stops being true on a future SQLite, these hints may have become
 * unnecessary, and this test is how that gets noticed rather than carried forever.
 */

import Database from 'better-sqlite3-multiple-ciphers';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, describe, expect, it } from 'vitest';
import { eqUnindexed, inArrayUnindexed } from './drizzle.js';

/** `memory_items` reduced to the four columns the plan turns on. */
const items = sqliteTable('items', {
  rid: integer('rid').primaryKey(),
  id: text('id').notNull(),
  groupId: text('group_id').notNull(),
  labelId: integer('label_id').notNull(),
});

const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

/** The ids of 200 rows, and the 12 labels of a five-member group — a family, not a stress fixture. */
const IDS = Array.from({ length: 200 }, (_, index) => `mem_${String(index)}`);
const LABELS = Array.from({ length: 12 }, (_, index) => index + 1);

function probe() {
  const raw = new Database(':memory:');
  open.push(raw);
  raw.exec(`
    CREATE TABLE items (rid integer primary key, id text not null, group_id text not null, label_id integer not null);
    CREATE UNIQUE INDEX items_id_unique ON items (id);
    CREATE INDEX items_group_idx ON items (group_id, rid);
    CREATE INDEX items_label_idx ON items (label_id);
  `);
  const insert = raw.prepare(`INSERT INTO items (id, group_id, label_id) VALUES (?, ?, ?)`);
  // Two groups, so the group predicate is not trivially true, and every label in play.
  for (let row = 0; row < 2_000; row += 1) {
    insert.run(`mem_${String(row)}`, row % 5 === 0 ? 'grp_other' : 'grp_a', (row % 12) + 1);
  }
  return drizzle(raw, { schema: { items } });
}

/** The plan SQLite chose, as one string. */
function planOf(
  db: ReturnType<typeof probe>,
  query: { toSQL(): { sql: string; params: unknown[] } },
): string {
  const { sql, params } = query.toSQL();
  const rows = db.$client.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as {
    detail: string;
  }[];
  return rows.map((row) => row.detail).join(' | ');
}

describe('inArrayUnindexed', () => {
  it('keeps the planner off the eligibility index, so the id list drives', () => {
    const db = probe();
    const hinted = db
      .select({ rid: items.rid })
      .from(items)
      .where(
        and(
          inArray(items.id, IDS),
          eqUnindexed(items.groupId, 'grp_a'),
          inArrayUnindexed(items.labelId, LABELS),
        ),
      );
    expect(planOf(db, hinted)).toContain('items_id_unique');
  });

  it('is not steering around a plan SQLite would have chosen anyway', () => {
    const db = probe();
    const plain = db
      .select({ rid: items.rid })
      .from(items)
      .where(
        and(
          inArray(items.id, IDS),
          eqUnindexed(items.groupId, 'grp_a'),
          inArray(items.labelId, LABELS),
        ),
      );
    // Twelve labels over 2,000 rows: the planner drives from the label index and filters, which is
    // the 64× slower plan `M1-T33` measured on the real fixture.
    expect(planOf(db, plain)).toContain('items_label_idx');
  });

  it('returns exactly what the indexed form returns', () => {
    const db = probe();
    const ridsOf = (
      where: Parameters<typeof db.select>[0] extends never ? never : ReturnType<typeof and>,
    ): number[] =>
      db
        .select({ rid: items.rid })
        .from(items)
        .where(where)
        .all()
        .map((row) => row.rid);
    const hinted = ridsOf(
      and(
        inArray(items.id, IDS),
        eqUnindexed(items.groupId, 'grp_a'),
        inArrayUnindexed(items.labelId, LABELS.slice(0, 3)),
      ),
    );
    const plain = ridsOf(
      and(
        inArray(items.id, IDS),
        eq(items.groupId, 'grp_a'),
        inArray(items.labelId, LABELS.slice(0, 3)),
      ),
    );
    // The hint is about *how* to find the rows, never which rows may be returned — `I4` rests on
    // that, and a narrowed label list is the case where a mistake would show as a leak.
    //
    // **Sorted**, because changing the driving index changes the order rows come back in, and
    // neither query has an `ORDER BY`. That is not a side effect of the hint so much as a property
    // of the query: the unhinted form returned label-index order, which was no more promised than
    // id order is. A caller that needs an order asks for one — `vector()` sorts by distance.
    expect(hinted.toSorted((a, b) => a - b)).toEqual(plain.toSorted((a, b) => a - b));
    expect(hinted.length).toBeGreaterThan(0);
    expect(hinted.length).toBeLessThan(IDS.length);
  });

  it('refuses nothing, and matches nothing, for an empty list', () => {
    const db = probe();
    const empty = db
      .select({ rid: items.rid })
      .from(items)
      .where(inArrayUnindexed(items.labelId, []));
    expect(empty.all()).toEqual([]);
  });
});
