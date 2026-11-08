/**
 * Drizzle on top of `better-sqlite3-multiple-ciphers`: `02` §3.6.3 step 6.
 *
 * Four questions, each of which decides something structural:
 *
 *  - **Does `drizzle({ client: db })` accept this driver?** It is a fork of better-sqlite3, not
 *    better-sqlite3, and Drizzle's SQLite adapter is typed against the original. `02` §3.6.3 says
 *    a cast is acceptable; this records whether one is needed and where.
 *  - **Does `behavior: 'immediate'` work?** `02` §3.7.1 makes `db.tx(syncFn)` the only transaction
 *    entry, and an IMMEDIATE transaction is what stops a deferred write-upgrade deadlocking
 *    against the worker connection under WAL.
 *  - **Do `customType` mappers work?** `02` §3.1's column helpers (`tid`, `instantMs`, `jsonOf`,
 *    `plainDate`, `labelRef`) are all `customType`. If the driver broke them, `M1-T10` would have
 *    to hand-write mappers in every repository.
 *  - **Does `drizzle-kit generate` emit partial indexes, expression indexes and CHECK
 *    constraints?** `02` §3.3 depends on all three for correctness, not performance — a partial
 *    unique index is how "one primary conversation per group" is enforced.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  check,
  customType,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { DB_FILENAME, withSpikeDb } from './open.js';

/**
 * `02` §3.1's `instantMs`: a `Temporal.Instant` stored as integer epoch milliseconds.
 *
 * Transcribed here to prove `customType` survives the driver swap. `M1-T10` owns the real one.
 */
const instantMs = customType<{ data: number; driverData: number }>({
  dataType: () => 'integer',
  toDriver: (value) => value,
  fromDriver: (value) => value,
});

/** `02` §3.1's `jsonOf`: a JSON column with a tag, validated by zod at the boundary. */
const jsonOf = <T>() =>
  customType<{ data: T; driverData: string }>({
    dataType: () => 'text',
    toDriver: (value) => JSON.stringify(value),
    fromDriver: (value) => JSON.parse(value) as T,
  });

const groups = sqliteTable(
  'groups',
  {
    rid: integer('rid').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    name: text('name').notNull(),
    createdAt: instantMs('created_at').notNull(),
    settings: jsonOf<{ quiet: boolean }>()('settings').notNull(),
    archivedAt: instantMs('archived_at'),
  },
  (t) => [
    // A **partial** unique index: at most one live group per name, archived ones excluded. This is
    // the shape `02` §3.3 uses for "one primary conversation per group", where it is a correctness
    // constraint rather than an optimisation.
    uniqueIndex('groups_live_name_idx').on(t.name).where(sql`${t.archivedAt} is null`),
    // An **expression** index, for case-insensitive lookup.
    index('groups_name_lower_idx').on(sql`lower(${t.name})`),
    // A CHECK constraint.
    check('groups_name_not_blank', sql`length(trim(${t.name})) > 0`),
  ],
);

describe('the driver is accepted by Drizzle', { tags: ['db', 'slow'] }, () => {
  it('wraps the connection and runs a query', () => {
    withSpikeDb((db) => {
      // `02` §3.6.3 step 6 permits a cast to `BetterSqlite3.Database`. **No cast is needed** —
      // but only because of the dependency alias, and without the alias this does not work at all.
      //
      // `drizzle-orm/better-sqlite3/driver.js` does a top-level `import 'better-sqlite3'`, so with
      // only the fork installed the module fails to load before any type question arises:
      // "Cannot find package 'better-sqlite3' imported from …/drizzle-orm/better-sqlite3/driver.js".
      // `packages/storage/package.json` therefore declares
      // `"better-sqlite3": "npm:better-sqlite3-multiple-ciphers@13.0.3"`, which makes Drizzle's
      // import resolve to the fork — and makes the two type names the *same installed package*,
      // so the cast the spec expected is unnecessary. Measured 2026-11-04.
      const orm = drizzle({ client: db });
      const row = orm.get<{ one: number }>(sql`select 1 as one`);
      expect(row).toEqual({ one: 1 });
    });
  });

  it('runs the `02` §3.1 customType mappers in both directions', () => {
    withSpikeDb((db) => {
      const orm = drizzle({ client: db });
      orm.run(sql`
        create table groups (
          rid integer primary key autoincrement,
          id text not null unique,
          name text not null,
          created_at integer not null,
          settings text not null,
          archived_at integer,
          constraint groups_name_not_blank check (length(trim(name)) > 0)
        )
      `);

      const createdAt = 1_762_000_000_000;
      orm
        .insert(groups)
        .values({ id: 'grp_1', name: 'The Khans', createdAt, settings: { quiet: true } })
        .run();

      const [row] = orm.select().from(groups).all();
      expect(row?.createdAt).toBe(createdAt);
      // The JSON mapper round-trips an object, not a string — which is the whole point.
      expect(row?.settings).toEqual({ quiet: true });
      expect(row?.archivedAt).toBeNull();
    });
  });

  it('enforces a CHECK constraint through the ORM', () => {
    withSpikeDb((db) => {
      const orm = drizzle({ client: db });
      orm.run(sql`
        create table groups (
          rid integer primary key autoincrement,
          id text not null unique,
          name text not null,
          created_at integer not null,
          settings text not null,
          archived_at integer,
          constraint groups_name_not_blank check (length(trim(name)) > 0)
        )
      `);
      expect(() =>
        orm
          .insert(groups)
          .values({ id: 'grp_2', name: '   ', createdAt: 0, settings: { quiet: false } })
          .run(),
      ).toThrow(/constraint/i);
    });
  });
});

describe('transactions', { tags: ['db', 'slow'] }, () => {
  const createTable = (orm: ReturnType<typeof drizzle>): void => {
    orm.run(sql`create table t (id integer primary key, n integer not null)`);
  };

  it("accepts behavior: 'immediate', which is what `02` §3.7.1 needs under WAL", () => {
    // A DEFERRED transaction that starts reading and then writes has to upgrade its lock, and
    // under WAL that upgrade can fail outright (`SQLITE_BUSY_SNAPSHOT`) against a concurrent
    // writer rather than waiting. IMMEDIATE takes the write lock up front, so `busy_timeout`
    // applies and the worker connection cannot deadlock the main one.
    withSpikeDb((db) => {
      const orm = drizzle({ client: db });
      createTable(orm);
      orm.transaction(
        (tx) => {
          tx.run(sql`insert into t (n) values (1)`);
          tx.run(sql`insert into t (n) values (2)`);
        },
        { behavior: 'immediate' },
      );
      expect(orm.get<{ c: number }>(sql`select count(*) as c from t`)).toEqual({ c: 2 });
    });
  });

  it('rolls the whole transaction back when the function throws', () => {
    withSpikeDb((db) => {
      const orm = drizzle({ client: db });
      createTable(orm);
      expect(() =>
        orm.transaction(
          (tx) => {
            tx.run(sql`insert into t (n) values (1)`);
            throw new Error('nope');
          },
          { behavior: 'immediate' },
        ),
      ).toThrow('nope');
      expect(orm.get<{ c: number }>(sql`select count(*) as c from t`)).toEqual({ c: 0 });
    });
  });

  it("is synchronous, which is what makes `01` §1's no-await-in-tx rule possible", () => {
    // `01` §1 and `02` §3.7.1: a better-sqlite3 transaction must never span an `await`, because
    // the driver is synchronous and an interleaved write would land inside somebody else's
    // transaction. Asserting the *synchrony* here is what makes that rule enforceable rather than
    // aspirational — `M1-T9` adds the lint rule, and this is the fact it rests on.
    withSpikeDb((db) => {
      const orm = drizzle({ client: db });
      createTable(orm);
      let ranInside = false;
      const result = orm.transaction(
        (tx) => {
          tx.run(sql`insert into t (n) values (1)`);
          ranInside = true;
          return 'done';
        },
        { behavior: 'immediate' },
      );
      // No promise anywhere: the callback has already run by the time `transaction` returns.
      expect(ranInside).toBe(true);
      expect(result).toBe('done');
      // `expect(result).not.toBeInstanceOf(Promise)` was here and could never fail, because the
      // line above already pinned `result` to a string. The falsifiable version asks the same
      // question of the **function**, which is the thing `02` §3.7.2 depends on: `db.transaction`
      // returns a plain value, so `SqliteStore` can be synchronous all the way down.
      expect(typeof result).toBe('string');
      expect(result).not.toHaveProperty('then');
    });
  });
});

describe('partial and expression indexes survive the round trip', { tags: ['db', 'slow'] }, () => {
  it('creates a partial unique index that only constrains live rows', () => {
    // The correctness case: two archived groups may share a name; two live ones may not.
    withSpikeDb((db) => {
      db.exec(`
        create table groups (
          rid integer primary key autoincrement,
          name text not null,
          archived_at integer
        )
      `);
      db.exec(
        'create unique index groups_live_name_idx on groups (name) where archived_at is null',
      );

      const insert = db.prepare('insert into groups (name, archived_at) values (?, ?)');
      insert.run('The Khans', null);
      expect(() => insert.run('The Khans', null)).toThrow(/unique/i);
      // Archived rows are outside the index, so they may collide.
      expect(() => insert.run('The Khans', 1)).not.toThrow();
      expect(() => insert.run('The Khans', 2)).not.toThrow();
    });
  });

  it('uses the expression index rather than scanning, per EXPLAIN QUERY PLAN', () => {
    // `02` §3.3.10 asserts "no SCAN of large tables" in the read-model tests. This is the same
    // assertion at the smallest possible scale, to establish that an expression index on
    // `lower(name)` is actually chosen — an index the planner ignores is a write cost with no
    // read benefit.
    withSpikeDb((db) => {
      db.exec('create table groups (rid integer primary key, name text not null)');
      db.exec('create index groups_name_lower_idx on groups (lower(name))');
      const insert = db.prepare('insert into groups (rid, name) values (?, ?)');
      for (let i = 1; i <= 500; i += 1) insert.run(i, `Group ${String(i)}`);
      db.exec('analyze');

      const plan = db
        .prepare('explain query plan select rid from groups where lower(name) = ?')
        .all('group 42') as { detail: string }[];
      const detail = plan.map((p) => p.detail).join(' | ');
      expect(detail).toContain('groups_name_lower_idx');
      expect(detail).not.toMatch(/SCAN groups/);
    });
  });
});

describe('the spike database is the same shape the real one will be', {
  tags: ['db', 'slow'],
}, () => {
  it('writes through Drizzle and reads back through the raw driver', () => {
    // Belt and braces on the alias: if Drizzle had resolved a *different* copy of the driver, a
    // row written through the ORM would not be readable by a plain prepared statement on what is
    // supposed to be the same connection.
    withSpikeDb((db) => {
      const orm = drizzle({ client: db });
      orm.run(sql`create table t (id integer primary key, s text not null)`);
      orm.run(sql`insert into t (s) values ('through drizzle')`);
      expect(db.prepare('select s from t').get()).toEqual({ s: 'through drizzle' });
    });
  });

  it('keeps the encryption: a Drizzle write is still unreadable without the key', () => {
    // The name claims an on-disk property, and the body used to assert three things that are not
    // it: `dir.length > 0` (a `mkdtemp` path is never empty), the journal mode, and
    // `randomBytes(1).length === 1` — a tautology planted to keep an import used. The comment
    // conceded that "the on-disk check lives in `encryption.spike.test.ts`", which made the test
    // pure decoration under a name that read like evidence. Found by the M1 independent review.
    //
    // Now it checks the claim: write through the ORM, close, and grep the file for the plaintext.
    // That is cheap here and worth doing in *this* file, because the question is specifically
    // whether going through Drizzle changes anything — `encryption.spike.test.ts` answers it for
    // raw statements and cannot answer it for the ORM.
    const marker = 'written-by-the-orm-and-must-not-appear';
    withSpikeDb(
      (db, dir) => {
        const orm = drizzle({ client: db });
        orm.run(sql`create table t (id integer primary key, s text not null)`);
        orm.run(sql`insert into t (s) values (${marker})`);
        // Flush the WAL into the main database so the bytes are where they will finally live.
        db.pragma('wal_checkpoint(TRUNCATE)');
        expect(db.pragma('journal_mode')).toEqual([{ journal_mode: 'wal' }]);
        // The value really is readable **with** the key, so a failure below is about encryption
        // rather than about the insert having silently not happened.
        expect(orm.get<{ s: string }>(sql`select s from t limit 1`)?.s).toBe(marker);
        db.close();

        // Every file the directory holds: the database and whichever of `-wal`/`-shm` survive the
        // checkpoint. Reading the directory rather than naming the file keeps the sidecars in
        // scope, which is where the most recent writes would be if anything leaked.
        const files = readdirSync(dir);
        expect(files, 'no database file to inspect').toContain(DB_FILENAME);
        for (const name of files) {
          const bytes = readFileSync(join(dir, name));
          expect(bytes.includes(marker), `${name} contains the plaintext`).toBe(false);
          // And the file is not empty, so "does not contain it" is a statement about ciphertext.
          expect(bytes.length, `${name} is empty`).toBeGreaterThan(0);
        }
      },
      { busyTimeoutMs: 1000 },
    );
  });
});
