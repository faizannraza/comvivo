/**
 * The committed `search_and_guards` migration, and what it installs (`M1-T13`).
 *
 * The first test here is the one that makes the whole generated-migration design safe: **the
 * committed SQL equals what the generator produces from the current schema.** Without it, adding a
 * labeled table would compile, pass review, and ship with no I4 guard — the generator would know,
 * and nothing would ask it. `02` §3.2 D5 calls the triggers structural defense in depth; a
 * generator whose output is never compared to the file is defense in depth that has quietly
 * stopped existing.
 *
 * It runs as a test rather than as a `pnpm verify` step so that `pnpm test` and CI's dist-free
 * jobs both exercise it without lengthening the verify chain.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StorageError } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import { MIGRATION_PATH, renderMigration } from '../../../../scripts/gen-guard-triggers.js';
import {
  assertValidSpace,
  createVec0SpaceSql,
  dropVec0SpaceSql,
  VALID_TO_OPEN_ENDED,
  VEC0_CHUNK_SIZE,
  vec0TableName,
} from '../search/vec0.js';
import {
  groupImmutableTables,
  guardedTables,
  IMMUTABLE_GUARDS,
  labeledColumns,
  parentLookups,
  schemaColumns,
  schemaTableNames,
} from './guards.sql.js';
import { FTS_TABLES } from './search.sql.js';
import { seedGroup, withMigratedDb } from './testing/migrated-db.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('the committed migration is generated, not hand-written', () => {
  it('matches what the generator produces from the current schema', () => {
    const committed = readFileSync(resolve(REPO_ROOT, MIGRATION_PATH), 'utf8');
    expect(committed).toBe(renderMigration());
  });

  it('declares every FTS table with contentless delete and secure delete', () => {
    const committed = readFileSync(resolve(REPO_ROOT, MIGRATION_PATH), 'utf8');
    for (const table of FTS_TABLES) {
      expect(committed).toContain(`CREATE VIRTUAL TABLE ${table} USING fts5(`);
      // `secure-delete` removes tokens immediately rather than at the next merge. Without it a
      // redacted message's words stay recoverable from the index file, which is `00`'s
      // "delete anything" promise failing in the one place nobody looks.
      expect(committed).toContain(
        `INSERT INTO ${table}(${table}, rank) VALUES('secure-delete', 1)`,
      );
    }
    expect(committed).toContain('contentless_delete=1');
  });
});

describe('a group move is refused (I4)', { tags: ['db'] }, () => {
  /**
   * The hole: a parent moved **and relabeled** in one statement.
   *
   * `event_attendees.note_label_id` reaches its group through `events`, so its I4 trigger watches
   * the label column and `event_id` — not `group_id`, which `event_attendees` does not have. The
   * parent's own trigger blocks a bare `group_id` move, because that would leave its label in the
   * old group. Moving and relabeling together satisfied it, and every attendee row was then
   * carrying a label from the old group under a parent in the new one, with no trigger firing.
   * Found by the M1 independent review, which also noted that `guards.sql.ts` claimed a "complete
   * guard".
   */
  it('refuses moving an event between groups, even with a valid new label', () => {
    withMigratedDb((db) => {
      const own = seedGroup(db, 'gm1');
      const other = seedGroup(db, 'gm2');
      const eventId = 'evt_01jgm10000000000000000000';

      db.prepare(
        `INSERT INTO events (id, group_id, series_id, title, all_day, tz, start_local, start_at,
           rdates, exdates, status, busy, source, label_id, ics_uid, tzdata_version,
           created_at, updated_at, version)
         VALUES (?, ?, ?, 'Recital', 0, 'UTC', '2026-11-17T19:00', 0, '[]', '[]', 'confirmed',
           1, 'local', ?, ?, '2026a', 0, 0, 1)`,
      ).run(eventId, own.groupId, eventId, own.labelId, eventId);

      // The attendee's note label belongs to the event's group, which is correct today.
      db.prepare(
        `INSERT INTO event_attendees (event_id, member_id, rsvp, note_label_id, updated_at)
         VALUES (?, ?, 'accepted', ?, 0)`,
      ).run(eventId, own.memberId, own.labelId);

      // The move-and-relabel that used to be accepted.
      expect(() =>
        db
          .prepare('UPDATE events SET group_id = ?, label_id = ? WHERE id = ?')
          .run(other.groupId, other.labelId, eventId),
      ).toThrow(/I4_GROUP_IMMUTABLE/);

      // Nothing moved, so the attendee's label still matches its parent's group.
      const row = db.prepare('SELECT group_id FROM events WHERE id = ?').get(eventId) as {
        group_id: string;
      };
      expect(row.group_id).toBe(own.groupId);
    });
  });

  it('still allows an update that does not change the group', () => {
    // The trigger is `WHEN NEW.group_id IS NOT OLD.group_id`, so listing `group_id` in a `SET`
    // without changing it is untouched — which is what an ORM-generated full-row update does.
    withMigratedDb((db) => {
      const own = seedGroup(db, 'gm3');
      const eventId = 'evt_01jgm30000000000000000000';
      db.prepare(
        `INSERT INTO events (id, group_id, series_id, title, all_day, tz, start_local, start_at,
           rdates, exdates, status, busy, source, label_id, ics_uid, tzdata_version,
           created_at, updated_at, version)
         VALUES (?, ?, ?, 'Recital', 0, 'UTC', '2026-11-17T19:00', 0, '[]', '[]', 'confirmed',
           1, 'local', ?, ?, '2026a', 0, 0, 1)`,
      ).run(eventId, own.groupId, eventId, own.labelId, eventId);

      expect(() =>
        db
          .prepare('UPDATE events SET group_id = ?, title = ? WHERE id = ?')
          .run(own.groupId, 'Renamed', eventId),
      ).not.toThrow();
      const row = db.prepare('SELECT title FROM events WHERE id = ?').get(eventId) as {
        title: string;
      };
      expect(row.title).toBe('Renamed');
    });
  });

  it('guards every table a labeled row derives its group from', () => {
    // 25 tables: the labeled ones that carry `group_id` themselves, plus the three parents the
    // others reach through. Pinned so a new labeled table cannot arrive without one.
    const tables = groupImmutableTables();
    expect(tables).toHaveLength(25);
    for (const parent of parentLookups()) {
      expect(tables, `${parent.parent} is a parent and must be guarded`).toContain(parent.parent);
    }
    // And every one of them is installed in the committed migration, not merely generated.
    withMigratedDb((db) => {
      const installed = new Set(
        (
          db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE ?")
            .all('%_group_immutable') as { name: string }[]
        ).map((row) => row.name),
      );
      expect(installed.size).toBe(25);
      for (const table of tables) {
        expect(installed, table).toContain(`trg_${table}_group_immutable`);
      }
    });
  });
});

describe('the parent lookups name real tables', () => {
  // `GROUP_VIA_PARENT` is three entries of **string literals** — a table, its parent, and the
  // column that points at it. A typo in any of them is a silently missing I4 guard: the generator
  // would emit a trigger referencing a table that does not exist, or worse, reference the wrong
  // one and compare against a group it has no business reading.
  //
  // `schemaTableNames()` existed for exactly this and its docstring said "used by the guard tests
  // to validate the lookups" while **no test used it**. Found by the M1 independent review.
  it('names a table and a parent that exist in the schema', () => {
    const tables = new Set(schemaTableNames());
    // 78 is the schema's table count, which `M1-T12` recorded. Pinned rather than bounded: both
    // sides of the comparison below are computed, so an empty set would make it pass over nothing.
    expect(tables.size).toBe(78);
    for (const lookup of parentLookups()) {
      expect(tables, `${lookup.table} is not a table in the schema`).toContain(lookup.table);
      expect(tables, `${lookup.parent} is not a table in the schema`).toContain(lookup.parent);
    }
  });

  it('names a `via` column that exists on the child, and an id on the parent', () => {
    for (const lookup of parentLookups()) {
      const child = schemaColumns(lookup.table);
      expect(child, `${lookup.table} has no columns`).toBeDefined();
      expect(child ?? [], `${lookup.table}.${lookup.via}`).toContain(lookup.via);
      // The generated trigger joins on the parent's `id`, so the parent must have one.
      expect(schemaColumns(lookup.parent) ?? [], `${lookup.parent}.id`).toContain('id');
    }
  });

  it('covers exactly the three tables 02 §3.3 gives no group_id', () => {
    // Pinned, so a fourth such table cannot be added without someone deciding how its group is
    // reached — which is the moment the I4 guard either gets written or silently does not.
    expect(
      parentLookups()
        .map((lookup) => lookup.table)
        .toSorted(),
    ).toEqual(['event_attendees', 'poll_votes', 'proposal_votes']);
  });
});

describe('every labeled column is detected', () => {
  // The cross-check `guards.sql.ts` promises in two separate docstrings and that existed nowhere.
  //
  // `labeledColumns()` finds a label column **by name** — `label_id` or `*_label_id` — because
  // `labelRef()` returns a plain `integer()` and drizzle keeps no marker on it. That is fine while
  // the convention holds and silent when it does not: a `labelRef('visibility')` column would get
  // no I4 trigger, the detected count would stay where it was, and `02` §9's "abort for every
  // labeled table" would have a hole with every test green. Found by the M1 independent review,
  // which also found that two comments already claimed this test existed.
  const SCHEMA_DIR = resolve(dirname(fileURLToPath(import.meta.url)));

  /** `labelRef(` call sites in the schema modules, with comments removed. */
  function callSites(): { file: string; count: number }[] {
    const files = readdirSync(SCHEMA_DIR)
      .filter((name) => name.endsWith('.ts'))
      // `_columns.ts` defines `labelRef`; `guards.sql.ts` and the tests only discuss it.
      .filter((name) => !/^(?:_columns|guards\.sql|index)\.ts$/.test(name))
      .filter((name) => !/\.test\.ts$/.test(name));
    return files.map((file) => {
      const source = readFileSync(resolve(SCHEMA_DIR, file), 'utf8')
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/\/\/.*$/gm, '');
      return { file, count: [...source.matchAll(/\blabelRef\s*\(/g)].length };
    });
  }

  it('finds exactly as many columns as there are `labelRef(` call sites', () => {
    const sites = callSites();
    const total = sites.reduce((sum, entry) => sum + entry.count, 0);
    expect(
      labeledColumns().length,
      'a `labelRef()` column whose name is not `label_id` or `*_label_id` is invisible to ' +
        '`labeledColumns()` and therefore has no I4 trigger. Per-file call sites: ' +
        sites
          .filter((entry) => entry.count > 0)
          .map((entry) => `${entry.file}=${String(entry.count)}`)
          .join(' '),
    ).toBe(total);
  });

  it('reads real files, so the comparison is not two zeroes', () => {
    // Both sides of the assertion above are computed, so an empty scan would make it pass.
    const sites = callSites();
    expect(sites.length).toBeGreaterThan(10);
    expect(sites.reduce((sum, entry) => sum + entry.count, 0)).toBe(31);
    expect(labeledColumns()).toHaveLength(31);
  });
});

describe('what the migration installs', { tags: ['db'] }, () => {
  it('creates the FTS tables and records secure-delete in each one’s config', () => {
    withMigratedDb((db) => {
      for (const table of FTS_TABLES) {
        // A contentless table supports a full rowid scan (confirmed by the `M1-T2` spike), which
        // is what `search.verify`'s parity check depends on.
        expect(() => db.prepare(`SELECT rowid FROM ${table} LIMIT 1`).all()).not.toThrow();

        // **Read back, not assumed.** FTS5 keeps its options in a `%_config` shadow table, so the
        // setting is observable — measured: a table without it has only a `version` row.
        //
        // What is deliberately *not* asserted here: that the deleted token's bytes are gone from
        // the index. I probed that first and it is false at this scale — the term stays in
        // `%_data` with and without the option, because the leaf page is not rewritten for a
        // single row. `secure-delete` changes how a deletion is recorded (overwriting entries
        // rather than appending tombstones), and the observable guarantees are this config row
        // plus the row no longer matching, which `fts-sync.prop.int.test.ts` covers.
        const config = db
          .prepare(`SELECT v FROM ${table}_config WHERE k = 'secure-delete'`)
          .get() as { v: number } | undefined;
        expect(config?.v, `${table} has secure-delete`).toBe(1);
      }
    });
  });

  it('installs a trigger for every guarded table', () => {
    withMigratedDb((db) => {
      const tables = new Set(
        (
          db
            .prepare("SELECT DISTINCT tbl_name FROM sqlite_master WHERE type = 'trigger'")
            .all() as { tbl_name: string }[]
        ).map((row) => row.tbl_name),
      );
      for (const table of guardedTables()) expect(tables, table).toContain(table);
    });
  });

  it('keeps every parent lookup pointing at a real table and column', () => {
    // `GROUP_VIA_PARENT` is the one hand-written part of the I4 generator, so it is the part that
    // can rot: a renamed column would produce a trigger that compiles as SQL and silently never
    // matches, which is a guard that passes everything.
    for (const lookup of parentLookups()) {
      const parentColumns = schemaColumns(lookup.parent);
      expect(parentColumns, `${lookup.parent} exists`).toBeDefined();
      expect(parentColumns ?? [], `${lookup.parent}.group_id`).toContain('group_id');
      const ownColumns = schemaColumns(lookup.table);
      expect(ownColumns ?? [], `${lookup.table}.${lookup.via}`).toContain(lookup.via);
      // And the whole reason the lookup exists: the table really has no `group_id` of its own.
      expect(ownColumns ?? []).not.toContain('group_id');
    }
  });
});

describe('immutability and append-only', { tags: ['db'] }, () => {
  it('refuses to edit a memory’s content, and still allows its lifecycle columns', () => {
    withMigratedDb((db) => {
      const seed = seedGroup(db, 'imm');
      db.prepare(
        `INSERT INTO memory_items (id, group_id, kind, content, statement, search_terms, language,
           fingerprint, label_id, provenance, confidence, status, valid_from, contradicts, links,
           retrieval_state, pinned, portable, embedding_state, created_at, updated_at, version)
         VALUES ('mem_01jimm00000000000000000001', ?, 'note', '{}', 'a statement', '[]', 'en',
           x'00', ?, '{}', 1, 'active', 0, '[]', '[]', 0, 0, 0, 'pending', 0, 0, 1)`,
      ).run(seed.groupId, seed.labelId);

      expect(() =>
        db.prepare("UPDATE memory_items SET statement = 'edited' WHERE rid = 1").run(),
      ).toThrow(/MEMORY_CONTENT_IMMUTABLE/);
      // Supersession is how a correction is recorded, so `status` must stay writable — a guard
      // that froze the whole row would make the lifecycle impossible.
      expect(() =>
        db.prepare("UPDATE memory_items SET status = 'superseded' WHERE rid = 1").run(),
      ).not.toThrow();
    });
  });

  it('refuses to edit an interned label or reader set', () => {
    // `02` §204 states this in prose rather than as a trigger. It is enforced because a mutated
    // label changes the audience of **every** row already carrying it — I1 failing retroactively
    // and invisibly, which no later test could detect.
    withMigratedDb((db) => {
      const seed = seedGroup(db, 'lbl');
      expect(() =>
        db.prepare("UPDATE labels SET sensitivity = 'sensitive' WHERE id = ?").run(seed.labelId),
      ).toThrow(/LABEL_IMMUTABLE/);
      expect(() =>
        db.prepare('UPDATE reader_sets SET member_count = 5 WHERE id = ?').run(seed.readerSetId),
      ).toThrow(/READER_SET_IMMUTABLE/);
    });
  });

  it('names a RAISE code for every immutability guard, and maps it', () => {
    // Each `RAISE(ABORT, '<CODE>')` needs a matching `StorageErrorCode`, or `src/db/errors.ts`
    // surfaces it as `STORAGE_CONSTRAINT` — "the database failed" — which tells a host nothing.
    for (const guard of IMMUTABLE_GUARDS) {
      expect(guard.code).toMatch(/^[A-Z_]+$/);
      const error = new StorageError(guard.code as never, 'probe');
      expect(error.storageCode).toBe(guard.code);
    }
  });
});

describe('the vec0 space factory (02 §3.5)', { tags: ['db'] }, () => {
  const space = { slug: 'e5s384_v1', dims: 384 };

  it('creates a space and its two triggers in a real database', () => {
    withMigratedDb((db) => {
      for (const statement of createVec0SpaceSql(space)) db.exec(statement);
      const names = (
        db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%e5s384_v1%'").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      expect(names).toContain(vec0TableName(space.slug));
      expect(names).toContain('trg_memory_items_vec_e5s384_v1_ad');
      expect(names).toContain('trg_memory_items_vec_e5s384_v1_au');
    });
  });

  it('runs vec0 DML from inside a trigger, which needs trusted_schema ON', () => {
    // `02` §3.5's third measured constraint: with `trusted_schema` OFF the DDL above is accepted
    // and the trigger throws `unsafe use of virtual table` on the **first retraction** — so this
    // is the test that would have caught a helper forgetting the pragma.
    withMigratedDb((db) => {
      for (const statement of createVec0SpaceSql(space)) db.exec(statement);
      const seed = seedGroup(db, 'vec');
      db.prepare(
        `INSERT INTO memory_items (id, group_id, kind, content, statement, search_terms, language,
           fingerprint, label_id, provenance, confidence, status, valid_from, contradicts, links,
           retrieval_state, pinned, portable, embedding_state, created_at, updated_at, version)
         VALUES ('mem_01jvec00000000000000000001', ?, 'note', '{}', 's', '[]', 'en', x'00', ?,
           '{}', 1, 'active', 0, '[]', '[]', 0, 0, 0, 'done', 0, 0, 1)`,
      ).run(seed.groupId, seed.labelId);

      const row = db
        .prepare("SELECT rid FROM memory_items WHERE id = 'mem_01jvec00000000000000000001'")
        .get() as { rid: number };
      // **`02` §3.5's second constraint is broader than the spec states, measured here.** It says
      // a *rowid* must bind as a SQLite integer; in fact **every INTEGER metadata column** must,
      // and the error is different: `Expected integer for INTEGER metadata column label_id,
      // received FLOAT`. better-sqlite3 binds a plain JavaScript number as a float, so `label_id`,
      // `state` and `valid_to_ms` each need a BigInt too. `M1-T18`'s insert path binds all of them.
      db.prepare(
        `INSERT INTO ${vec0TableName(space.slug)} (rid, group_id, embedding, label_id, kind, state, valid_to_ms)
         VALUES (?, ?, ?, ?, 'note', ?, ?)`,
      ).run(
        BigInt(row.rid),
        seed.groupId,
        Buffer.from(new Float32Array(space.dims).buffer),
        BigInt(seed.labelId),
        0n,
        BigInt(VALID_TO_OPEN_ENDED),
      );
      const count = () =>
        (
          db.prepare(`SELECT count(*) AS c FROM ${vec0TableName(space.slug)}`).get() as {
            c: number;
          }
        ).c;
      expect(count()).toBe(1);

      // The trigger fires here, inside SQLite, writing to a virtual table.
      db.prepare("UPDATE memory_items SET status = 'retracted' WHERE rid = ?").run(row.rid);
      expect(count()).toBe(0);
    });
  });

  it('drops a space and its triggers', () => {
    withMigratedDb((db) => {
      for (const statement of createVec0SpaceSql(space)) db.exec(statement);
      for (const statement of dropVec0SpaceSql(space)) db.exec(statement);
      const left = (
        db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%e5s384_v1%'").all() as {
          name: string;
        }[]
      ).length;
      expect(left).toBe(0);
    });
  });

  it('refuses a slug or dimension count that would reach the DDL unchecked', () => {
    // The slug is interpolated into `CREATE VIRTUAL TABLE` — SQLite has no parameter for an
    // identifier — and it is derived from `embeddings.model`, which a host edits. So it is the one
    // value here that must be validated rather than trusted.
    for (const slug of ['has-dash', 'Upper', 'has space', '', 'x'.repeat(41), 'drop;--']) {
      expect(() => assertValidSpace({ slug, dims: 384 }), slug).toThrow(StorageError);
    }
    for (const dims of [0, -1, 1.5, 4097]) {
      expect(() => assertValidSpace({ slug: 'ok', dims }), String(dims)).toThrow(StorageError);
    }
    expect(() => assertValidSpace(space)).not.toThrow();
  });

  it('uses a chunk size divisible by 8, as vec0 requires', () => {
    expect(VEC0_CHUNK_SIZE % 8).toBe(0);
    expect(createVec0TableSqlContains(space, `chunk_size=${String(VEC0_CHUNK_SIZE)}`)).toBe(true);
  });
});

/** Whether the space's DDL contains `fragment`. */
function createVec0TableSqlContains(space: { slug: string; dims: number }, fragment: string) {
  return createVec0SpaceSql(space)[0]?.includes(fragment) ?? false;
}
