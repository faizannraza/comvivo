/**
 * `maybeOne`, `exactlyOne`, and the drizzle behaviours the repositories rest on.
 *
 * Every `not_found` and `conflict` answer in `repos/` is `maybeOne(...) === undefined`, so the two
 * things this test pins are the two things that would break it silently: that `.get()` really does
 * return `undefined` for no match, and that drizzle still *types* it as though it could not. If a
 * future release fixes the type, `maybeOne` becomes a no-op and should be deleted — this test is
 * how that gets noticed rather than carried forever.
 */

import { StorageError } from '@comvivo/shared';
import Database from 'better-sqlite3-multiple-ciphers';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, describe, expect, it } from 'vitest';
import { exactlyOne, maybeOne } from './drizzle.js';

const rows = sqliteTable('probe', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});

const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function probe() {
  const raw = new Database(':memory:');
  open.push(raw);
  raw.exec('CREATE TABLE probe (id integer primary key, name text not null)');
  const db = drizzle(raw, { schema: { rows } });
  db.insert(rows).values({ id: 1, name: 'a' }).run();
  return db;
}

describe('maybeOne', () => {
  it('returns the row when one matched', () => {
    const db = probe();
    expect(maybeOne(db.select().from(rows).where(eq(rows.id, 1)))?.name).toBe('a');
  });

  it('returns undefined when a SELECT matched nothing', () => {
    const db = probe();
    expect(maybeOne(db.select().from(rows).where(eq(rows.id, 99)))).toBeUndefined();
  });

  it('returns undefined when an UPDATE … RETURNING matched nothing', () => {
    const db = probe();
    // The case the repositories depend on: this is how a stale `expectVersion` and a missing row
    // are told apart from a successful write, in one statement.
    expect(
      maybeOne(db.update(rows).set({ name: 'b' }).where(eq(rows.id, 99)).returning()),
    ).toBeUndefined();
    // And the row that does exist is untouched, so the `UPDATE` really did match nothing.
    expect(maybeOne(db.select().from(rows).where(eq(rows.id, 1)))?.name).toBe('a');
  });

  it('returns undefined when a DELETE … RETURNING matched nothing', () => {
    const db = probe();
    expect(maybeOne(db.delete(rows).where(eq(rows.id, 99)).returning())).toBeUndefined();
  });

  it('is still needed, because drizzle types `.get()` as non-optional', () => {
    const db = probe();
    // The assertion that makes this test a tripwire rather than a restatement. `.get()`'s declared
    // return type excludes `undefined`, so a direct `=== undefined` comparison is what
    // `no-unnecessary-condition` rejects — while the runtime value above *is* `undefined`.
    //
    // Read as: the value drizzle promises is never nullish is nullish. When a release makes the
    // type honest, `satisfies` stops holding and this line fails, which is the signal to delete
    // `maybeOne`.
    const direct = db.select().from(rows).where(eq(rows.id, 99)).get();
    const declaredNonOptional: typeof direct extends undefined ? never : true = true;
    expect(declaredNonOptional).toBe(true);
    expect(direct as unknown).toBeUndefined();
  });
});

/**
 * How Drizzle treats an explicit `undefined`.
 *
 * Pinned because the answer removed a lot of code. The repositories were written with a
 * conditional spread per optional column — `...(x === undefined ? {} : { x })` — thirteen of them
 * in `messages.insert` alone, which is what pushed that method past Biome's complexity limit. The
 * spreads were defending against a behaviour Drizzle does not have.
 *
 * The third case is the one that is **not** obvious and would otherwise be found in production: an
 * `UPDATE` whose every value is `undefined` throws `No values to set` rather than being a no-op.
 * Every patch method here also sets `updated_at`, so none can reach it — but a future patch method
 * that only forwards optional fields could, and this is where that is written down.
 */
describe('Drizzle and explicit undefined', () => {
  it('treats undefined on INSERT as "not provided", so defaults still apply', () => {
    const raw = new Database(':memory:');
    open.push(raw);
    raw.exec('CREATE TABLE d (id integer primary key, note text, flag integer not null default 7)');
    const table = sqliteTable('d', {
      id: integer('id').primaryKey(),
      note: text('note'),
      flag: integer('flag').notNull().default(7),
    });
    const db = drizzle(raw, { schema: { d: table } });
    db.insert(table).values({ id: 1, note: undefined, flag: undefined }).run();
    db.insert(table).values({ id: 2 }).run();
    const explicit = maybeOne(db.select().from(table).where(eq(table.id, 1)));
    const omitted = maybeOne(db.select().from(table).where(eq(table.id, 2)));
    // `flag` took its default rather than becoming NULL, which is the fact that matters: an
    // explicit `undefined` is not a NULL. Compared field by field rather than whole rows, since
    // the ids differ by construction.
    expect(explicit?.flag).toBe(7);
    expect(explicit?.note).toBeNull();
    expect({ note: explicit?.note, flag: explicit?.flag }).toEqual({
      note: omitted?.note,
      flag: omitted?.flag,
    });
  });

  it('treats undefined on UPDATE as "leave this column alone"', () => {
    const db = probe();
    db.insert(rows).values({ id: 2, name: 'keep' }).run();
    // One real value beside the `undefined`, because an all-undefined `.set()` throws instead —
    // which is the next test, and which this one must not accidentally be.
    db.update(rows).set({ id: 2, name: undefined }).where(eq(rows.id, 2)).run();
    expect(maybeOne(db.select().from(rows).where(eq(rows.id, 2)))?.name).toBe('keep');
  });

  it('throws when EVERY value in an UPDATE is undefined', () => {
    const db = probe();
    // The trap. A patch method that forwarded only optional fields would fail here on the call
    // that changes nothing — which is the least-tested path. Every patch method in `repos/` also
    // sets `updated_at`, so none of them can reach it.
    expect(() => db.update(rows).set({ name: undefined }).where(eq(rows.id, 1)).run()).toThrow(
      /No values to set/,
    );
  });
});

describe('exactlyOne', () => {
  it('returns the row an INSERT … RETURNING yields', () => {
    const db = probe();
    expect(exactlyOne(db.insert(rows).values({ id: 7, name: 'g' }).returning(), 'a row').id).toBe(
      7,
    );
  });

  it('raises STORAGE_IO when there is no row, naming it a bug', () => {
    const db = probe();
    let caught: unknown;
    try {
      // An `UPDATE` that matches nothing, standing in for the impossible `INSERT`: the point is
      // the *guard*, and no real insert can both succeed and yield nothing.
      exactlyOne(db.update(rows).set({ name: 'x' }).where(eq(rows.id, 99)).returning(), 'a row');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StorageError);
    const error = caught as StorageError;
    expect(error.storageCode).toBe('STORAGE_IO');
    expect(error.message).toContain('a row');
    expect(error.hint).toContain('RETURNING');
  });
});
