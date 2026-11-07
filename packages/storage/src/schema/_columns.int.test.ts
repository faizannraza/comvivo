/**
 * The column types against a real encrypted database (`02` §3.1).
 *
 * `_columns.test.ts` tests the mappers. This tests the **agreement** between the mappers and
 * SQLite, which is a different claim and the one that would be wrong in a way no unit test could
 * see: a mapper can be internally consistent while the column it declares stores something else.
 *
 * Three things are only checkable here:
 *
 *  - the **storage class** each column actually gets (`INTEGER` versus `TEXT`), which decides how
 *    SQLite sorts and compares it;
 *  - that `bool`'s `CHECK (x IN (0,1))` is **the table's** job — a `bool()` column without one
 *    accepts `2` and reads it back as `true`, which is the hazard `boolCheck` exists for;
 *  - that an instant column **sorts chronologically**, because an integer does and a string does
 *    not, and the turn journal and the outbox read order as sequence (I6, I7).
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { type Id, StorageError, type TimeZoneId, z } from '@comvivo/shared';
import type Database from 'better-sqlite3-multiple-ciphers';
import { sqliteTable } from 'drizzle-orm/sqlite-core';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { withDataDir } from '../datadir/testing/data-dir.js';
import { initDatabase } from '../db/init.js';
import {
  bool,
  boolCheck,
  createdAt,
  instantMs,
  jsonOf,
  plainDateText,
  plainDateTimeText,
  tid,
  tzText,
  version,
} from './_columns.js';

const payloadSchema = z.object({ kind: z.enum(['text', 'image']), text: z.string().optional() });

/** A table using one of every column type, so the generated DDL can be inspected. */
const rows = sqliteTable('rows', {
  id: tid('msg')('id').primaryKey(),
  groupId: tid('grp')('group_id').notNull(),
  at: instantMs('at').notNull(),
  localAt: plainDateTimeText('local_at'),
  onDate: plainDateText('on_date'),
  tz: tzText('tz').notNull(),
  isActive: bool('is_active').notNull(),
  // No `$type`: `jsonOf`'s own `data` generic already types the column from the schema.
  payload: jsonOf(payloadSchema, 'rows.payload')('payload'),
  createdAt: createdAt(),
  version: version(),
});

/**
 * The DDL this table needs, written out.
 *
 * Hand-written rather than generated, because `M1-T11` owns `drizzle-kit generate` and this test
 * is about the column **types** rather than about the migration pipeline. The `CHECK` on
 * `is_active` comes from `boolCheck`, which is the point: it proves the expression that helper
 * produces is one SQLite accepts and enforces.
 */
const DDL = `
  CREATE TABLE rows (
    id TEXT PRIMARY KEY NOT NULL,
    group_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    local_at TEXT,
    on_date TEXT,
    tz TEXT NOT NULL,
    is_active INTEGER NOT NULL,
    payload TEXT,
    created_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    CHECK (${boolCheck('is_active')})
  )
`;

/** A raw row, as the driver returns it: snake_case keys and driver-side types. */
interface RawRow {
  readonly id: string;
  readonly group_id: string;
  readonly at: number;
  readonly local_at: string;
  readonly on_date: string;
  readonly tz: string;
  readonly is_active: number;
  readonly payload: string;
  readonly created_at: number;
  readonly version: number;
}

const MSG = 'msg_01jd8kqd7h3f9z2m4n6p8r0t2v' as Id<'msg'>;
const GROUP = 'grp_01jd8kqd7h3f9z2m4n6p8r0t2w' as Id<'grp'>;

/** An encrypted database with the table above, closed afterwards. */
async function withTable<T>(fn: (db: Database.Database) => T): Promise<T> {
  return withDataDir(async (root) => {
    const opened = initDatabase({ path: join(root, 'cols.db'), key: randomBytes(32) });
    try {
      opened.db.exec(DDL);
      return fn(opened.db);
    } finally {
      opened.db.close();
    }
  });
}

/** Insert a row through the column mappers, as a repository would. */
function insert(
  db: Database.Database,
  overrides: Partial<{
    id: string;
    at: number;
    tz: string;
    isActive: number;
    payload: string | null;
  }> = {},
): void {
  db.prepare(
    `INSERT INTO rows (id, group_id, at, local_at, on_date, tz, is_active, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    overrides.id ?? rows.id.mapToDriverValue(MSG),
    rows.groupId.mapToDriverValue(GROUP),
    overrides.at ??
      rows.at.mapToDriverValue(Temporal.Instant.fromEpochMilliseconds(1_762_000_000_000)),
    rows.localAt.mapToDriverValue(Temporal.PlainDateTime.from('2026-03-08T02:30:00')),
    rows.onDate.mapToDriverValue(Temporal.PlainDate.from('2026-11-06')),
    overrides.tz ?? rows.tz.mapToDriverValue('Europe/London' as TimeZoneId),
    overrides.isActive ?? rows.isActive.mapToDriverValue(true),
    overrides.payload === undefined
      ? rows.payload.mapToDriverValue({ kind: 'text', text: 'hello' })
      : overrides.payload,
    rows.createdAt.mapToDriverValue(Temporal.Instant.fromEpochMilliseconds(1_762_000_000_000)),
  );
}

describe('the declared storage classes (02 §3.1)', { tags: ['db', 'slow'] }, () => {
  it('gives each column the affinity SQLite will sort it by', async () => {
    // The claim a unit test cannot make. `INTEGER` versus `TEXT` is what decides whether `at`
    // sorts chronologically and whether `is_active` compares as a number.
    await withTable((db) => {
      const columns = db.prepare('PRAGMA table_info(rows)').all() as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }[];
      const byName = new Map(columns.map((column) => [column.name, column]));

      expect(byName.get('id')?.type).toBe('TEXT');
      expect(byName.get('at')?.type).toBe('INTEGER');
      expect(byName.get('local_at')?.type).toBe('TEXT');
      expect(byName.get('on_date')?.type).toBe('TEXT');
      expect(byName.get('tz')?.type).toBe('TEXT');
      expect(byName.get('is_active')?.type).toBe('INTEGER');
      expect(byName.get('payload')?.type).toBe('TEXT');
      expect(byName.get('created_at')?.type).toBe('INTEGER');
      expect(byName.get('version')?.type).toBe('INTEGER');
      expect(byName.get('version')?.dflt_value).toBe('1');
    });
  });

  it('matches what the Drizzle column declared', async () => {
    // So the DDL above and the schema cannot drift: every column's `getSQLType()` is the type
    // SQLite reports, case-insensitively.
    await withTable((db) => {
      const reported = new Map(
        (db.prepare('PRAGMA table_info(rows)').all() as { name: string; type: string }[]).map(
          (column) => [column.name, column.type.toLowerCase()],
        ),
      );
      for (const column of Object.values(rows)) {
        if (typeof column !== 'object' || !('name' in column)) continue;
        expect(reported.get(column.name), column.name).toBe(column.getSQLType().toLowerCase());
      }
    });
  });
});

describe('a full round trip through SQLite', { tags: ['db', 'slow'] }, () => {
  it('reads back every value as the type it was written as', async () => {
    await withTable((db) => {
      insert(db);
      const row = db.prepare('SELECT * FROM rows').get() as RawRow;

      expect(rows.id.mapFromDriverValue(row.id)).toBe(MSG);
      expect(rows.groupId.mapFromDriverValue(row.group_id)).toBe(GROUP);
      expect((rows.at.mapFromDriverValue(row.at) as Temporal.Instant).epochMilliseconds).toBe(
        1_762_000_000_000,
      );
      expect(
        (rows.localAt.mapFromDriverValue(row.local_at) as Temporal.PlainDateTime).toString(),
      ).toBe('2026-03-08T02:30:00');
      expect((rows.onDate.mapFromDriverValue(row.on_date) as Temporal.PlainDate).toString()).toBe(
        '2026-11-06',
      );
      expect(rows.tz.mapFromDriverValue(row.tz)).toBe('Europe/London');
      expect(rows.isActive.mapFromDriverValue(row.is_active)).toBe(true);
      expect(rows.payload.mapFromDriverValue(row.payload)).toEqual({
        kind: 'text',
        text: 'hello',
      });
      expect(row.version).toBe(1);
    });
  });

  it('sorts instants chronologically, which is why they are integers', async () => {
    // The reason `02` §3.1 chose `INTEGER` epoch ms. An ISO string sorts lexicographically, which
    // agrees with chronological order only while every value has identical shape — and the turn
    // journal and the outbox read order *as* sequence (I6, I7).
    await withTable((db) => {
      const instants = [1_762_000_000_000, 999, 1_000, 0, 1_762_000_000_001];
      for (const [index, at] of instants.entries()) {
        insert(db, { id: `msg_01jd8kqd7h3f9z2m4n6p8r0t${String(index)}z`, at });
      }
      const ordered = (db.prepare('SELECT at FROM rows ORDER BY at').all() as { at: number }[]).map(
        (row) => row.at,
      );
      expect(ordered).toEqual([...instants].sort((a, b) => a - b));
    });
  });

  it('canonicalises a zone on the way in, so stored values compare equal', async () => {
    // The refinement over `02` §3.1's "validated on read". Without canonicalising on write, this
    // row would hold `europe/london` and every comparison against `Europe/London` would be false —
    // and D3's calendar design compares a stored `tz` against another `tz`.
    await withTable((db) => {
      insert(db, { tz: rows.tz.mapToDriverValue('europe/london' as TimeZoneId) as string });
      const row = db.prepare('SELECT tz FROM rows').get() as { tz: string };
      expect(row.tz).toBe('Europe/London');
    });
  });

  it('stores JSON as text that is valid JSON on disk', async () => {
    // So a host inspecting the database with `sqlite3` sees something readable, and so a future
    // migration can transform it with SQLite's own JSON functions.
    await withTable((db) => {
      insert(db);
      const row = db.prepare("SELECT json_extract(payload, '$.kind') AS kind FROM rows").get() as {
        kind: string;
      };
      expect(row.kind).toBe('text');
    });
  });
});

describe('the CHECK that belongs to the table, not the column', { tags: ['db', 'slow'] }, () => {
  it('refuses a boolean that is neither 0 nor 1', async () => {
    // **The hazard `boolCheck` exists for.** `bool()` declares `{ mode: 'boolean' }`, which maps
    // `1` to `true` and everything else to `false` (measured). Without the table's `CHECK`, a
    // migration or a hand-edit could put `2` in the column and every read would report a
    // confident `false` — indistinguishable from a real one.
    await withTable((db) => {
      expect(() => insert(db, { isActive: 2 })).toThrow(/CHECK constraint failed/);
      expect(() => insert(db, { isActive: -1 })).toThrow(/CHECK constraint failed/);
    });
  });

  it('accepts both legitimate values', async () => {
    await withTable((db) => {
      insert(db, { id: 'msg_01jd8kqd7h3f9z2m4n6p8r0t2v', isActive: 1 });
      insert(db, { id: 'msg_01jd8kqd7h3f9z2m4n6p8r0t3v', isActive: 0 });
      const values = (
        db.prepare('SELECT is_active FROM rows ORDER BY is_active').all() as {
          is_active: number;
        }[]
      ).map((row) => row.is_active);
      expect(values).toEqual([0, 1]);
    });
  });

  it('reads an out-of-range value as a confident false, which is why the CHECK matters', async () => {
    // Measured, after a first version of this test asserted `2` reads as `true` and failed:
    // `{ mode: 'boolean' }` maps `1` to `true` and **everything else to `false`**.
    //
    // That is worse than nonsense, not better. A value that reached the column around the mapper
    // reads back as a confident `false` — and for `is_active`, `is_minor` or a consent flag,
    // `false` is the direction that silently denies. Nothing in the read path can tell it apart
    // from a genuine `false`, so the `CHECK` is the only layer that can stop the value existing.
    expect(rows.isActive.mapFromDriverValue(1)).toBe(true);
    for (const stored of [2, -1, 0.5, 0]) {
      expect(rows.isActive.mapFromDriverValue(stored), String(stored)).toBe(false);
    }
    await Promise.resolve();
  });
});

describe('what a damaged row looks like coming out', { tags: ['db', 'slow'] }, () => {
  it('reports a malformed id as STORAGE_ID_INVALID', async () => {
    // Written around the mapper, which is what a hand-edit or a restore from a foreign database
    // would do.
    await withTable((db) => {
      insert(db);
      db.prepare("UPDATE rows SET group_id = 'not-an-id'").run();
      const row = db.prepare('SELECT group_id FROM rows').get() as { group_id: string };
      expect(() => rows.groupId.mapFromDriverValue(row.group_id)).toThrow(/STORAGE_ID_INVALID/);
    });
  });

  it('reports a negative instant as corruption, naming a backup', async () => {
    await withTable((db) => {
      insert(db);
      db.prepare('UPDATE rows SET at = -1').run();
      const row = db.prepare('SELECT at FROM rows').get() as { at: number };
      try {
        rows.at.mapFromDriverValue(row.at);
        expect.unreachable('a negative instant must be refused');
      } catch (caught) {
        const error = caught as StorageError;
        expect(error.storageCode).toBe('STORAGE_CORRUPT');
        expect(error.hint).toContain('Restore a backup');
      }
    });
  });

  it('reports a JSON column that no longer matches its schema, naming the column', async () => {
    await withTable((db) => {
      insert(db);
      db.prepare(`UPDATE rows SET payload = '{"kind":"video"}'`).run();
      const row = db.prepare('SELECT payload FROM rows').get() as { payload: string };
      try {
        rows.payload.mapFromDriverValue(row.payload);
        expect.unreachable('a row that fails its schema must be refused');
      } catch (caught) {
        const error = caught as StorageError;
        expect(error.storageCode).toBe('STORAGE_JSON_INVALID');
        expect(error.detail).toMatchObject({ column: 'rows.payload' });
      }
    });
  });

  it('reports an unknown zone as corruption mentioning tzdata', async () => {
    await withTable((db) => {
      insert(db);
      db.prepare("UPDATE rows SET tz = 'Europe/Londen'").run();
      const row = db.prepare('SELECT tz FROM rows').get() as { tz: string };
      try {
        rows.tz.mapFromDriverValue(row.tz);
        expect.unreachable('an unknown zone must be refused');
      } catch (caught) {
        const error = caught as StorageError;
        expect(error.storageCode).toBe('STORAGE_CORRUPT');
        expect(error.hint).toContain('tzdata');
      }
    });
  });

  it('leaves the rest of the row readable, so one bad column is not a lost row', async () => {
    // `02` F9: a row whose JSON no longer parses is excluded from context and shown as "corrupt
    // record" — which is only possible if the other columns still read.
    await withTable((db) => {
      insert(db);
      db.prepare(`UPDATE rows SET payload = '{"kind":"video"}'`).run();
      const row = db.prepare('SELECT * FROM rows').get() as RawRow;

      expect(rows.id.mapFromDriverValue(row.id)).toBe(MSG);
      expect(rows.tz.mapFromDriverValue(row.tz)).toBe('Europe/London');
      expect(() => rows.payload.mapFromDriverValue(row.payload)).toThrow(StorageError);
    });
  });
});
