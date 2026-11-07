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
import { readFileSync } from 'node:fs';
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
import { guardedTables, IMMUTABLE_GUARDS, parentLookups, schemaColumns } from './guards.sql.js';
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
