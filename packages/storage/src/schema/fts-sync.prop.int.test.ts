/**
 * `fts.trigger-sync.property` (`M1-T13`; `02` §3.4).
 *
 * The property: **after any sequence of writes, the FTS index holds exactly the indexable rows.**
 *
 * Stating it that way is the point. The triggers are the authoritative sync path (`02` §3.4), so
 * what has to hold is not "an insert indexes the row" — that is one case — but that no reachable
 * sequence of inserts, edits, redactions and deletes can leave the index disagreeing with the base
 * table. A drifted index is the quietest possible failure: search returns a message that was
 * redacted, or silently stops returning one that exists, and nothing else in the system notices.
 * `02` §3.4's nightly `search.verify` exists because drift is survivable in production; this test
 * exists so it is not reachable in the first place.
 *
 * The model is computed from the base table by the same rules the triggers use, which is a fair
 * test only because the rules are stated in `02` §3.4 and read off the spec rather than off the
 * trigger SQL.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fcConfig } from '@comvivo/shared/testing';
import type Database from 'better-sqlite3-multiple-ciphers';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ENTITY_FTS_SOURCES } from './search.sql.js';

/** The committed guards migration, which is what a host actually runs. */
const MIGRATION_PATH_ABS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../migrations/0001_search_and_guards.sql',
);

import { type SeededGroup, seedGroup, withMigratedDb } from './testing/migrated-db.js';

/** What a test may do to a message. */
type MessageOp =
  | { readonly kind: 'insert'; readonly text: string }
  | { readonly kind: 'retext'; readonly at: number; readonly text: string }
  | { readonly kind: 'redact'; readonly at: number }
  | { readonly kind: 'unredact'; readonly at: number }
  | { readonly kind: 'delete'; readonly at: number };

const messageOp = fc.oneof(
  // Empty text is included deliberately: `02` §3.4 excludes it from the index, and a trigger that
  // indexed it would make `length(NEW.text) > 0` dead.
  fc.record({ kind: fc.constant('insert' as const), text: fc.oneof(fc.string(), fc.constant('')) }),
  fc.record({ kind: fc.constant('retext' as const), at: fc.nat(8), text: fc.string() }),
  fc.record({ kind: fc.constant('redact' as const), at: fc.nat(8) }),
  fc.record({ kind: fc.constant('unredact' as const), at: fc.nat(8) }),
  fc.record({ kind: fc.constant('delete' as const), at: fc.nat(8) }),
);

/** The mutable state one property run threads through its operations. */
interface MessageRun {
  readonly seed: SeededGroup;
  readonly insert: Database.Statement;
  readonly rids: number[];
  readonly index: number;
}

/**
 * Apply one operation.
 *
 * Extracted from the property body, which scored 30 against biome's cognitive-complexity limit of
 * 20 — the same signal that split `rotateData`, `auditPermissions` and `parseChecklist`, and the
 * same cause each time: a loop that both dispatches and acts. The dispatch is a decision table, so
 * it reads better as one.
 */
function applyMessageOp(db: Database.Database, run: MessageRun, op: MessageOp): void {
  if (op.kind === 'insert') {
    const id = `msg_01j${String(run.index + 1).padStart(23, '0')}`;
    const row = run.insert.get(
      id,
      run.seed.groupId,
      run.seed.conversationId,
      op.text,
      run.seed.labelId,
    ) as { rid: number };
    run.rids.push(row.rid);
    return;
  }
  const rid = run.rids[op.at % Math.max(run.rids.length, 1)];
  if (rid === undefined) return;
  switch (op.kind) {
    case 'retext':
      db.prepare('UPDATE messages SET text = ? WHERE rid = ?').run(op.text, rid);
      return;
    case 'redact':
      db.prepare('UPDATE messages SET redacted_at = 1 WHERE rid = ?').run(rid);
      return;
    case 'unredact':
      db.prepare('UPDATE messages SET redacted_at = NULL WHERE rid = ?').run(rid);
      return;
    case 'delete':
      db.prepare('DELETE FROM messages WHERE rid = ?').run(rid);
      return;
  }
}

/** What a test may do to a memory item. */
type MemoryOp =
  | { readonly kind: 'insert'; readonly statement: string; readonly terms: readonly string[] }
  | { readonly kind: 'retract'; readonly at: number }
  | { readonly kind: 'reactivate'; readonly at: number }
  | { readonly kind: 'delete'; readonly at: number };

/** The same split for memory items. */
function applyMemoryOp(db: Database.Database, run: MessageRun, op: MemoryOp): void {
  if (op.kind === 'insert') {
    const row = run.insert.get(
      `mem_01j${String(run.index + 1).padStart(23, '0')}`,
      run.seed.groupId,
      op.statement,
      JSON.stringify(op.terms),
      run.seed.labelId,
    ) as { rid: number };
    run.rids.push(row.rid);
    return;
  }
  const rid = run.rids[op.at % Math.max(run.rids.length, 1)];
  if (rid === undefined) return;
  switch (op.kind) {
    case 'retract':
      db.prepare("UPDATE memory_items SET status = 'retracted' WHERE rid = ?").run(rid);
      return;
    case 'reactivate':
      db.prepare("UPDATE memory_items SET status = 'active' WHERE rid = ?").run(rid);
      return;
    case 'delete':
      db.prepare('DELETE FROM memory_items WHERE rid = ?').run(rid);
      return;
  }
}

/** The rids `02` §3.4 says `messages_fts` must hold, read from the base table. */
function indexableMessageRids(db: Database.Database): number[] {
  return (
    db
      .prepare(
        `SELECT rid FROM messages
         WHERE group_id IS NOT NULL AND redacted_at IS NULL AND length(text) > 0
         ORDER BY rid`,
      )
      .all() as { rid: number }[]
  ).map((row) => row.rid);
}

function ftsRowids(db: Database.Database, table: string): number[] {
  return (db.prepare(`SELECT rowid FROM ${table} ORDER BY rowid`).all() as { rowid: number }[]).map(
    (row) => row.rowid,
  );
}

describe('fts.trigger-sync.property — messages', { tags: ['prop', 'db'] }, () => {
  it('keeps messages_fts equal to the indexable rows after any sequence of writes', () => {
    fc.assert(
      fc.property(fc.array(messageOp, { minLength: 1, maxLength: 24 }), (ops) => {
        withMigratedDb((db) => {
          const seed = seedGroup(db, 'fts');
          const insert = db.prepare(
            `INSERT INTO messages (id, group_id, conversation_id, kind, text, untrusted, label_id,
               sent_at, received_at, delivered_late, truncated, edit_count)
             VALUES (?, ?, ?, 'member', ?, 0, ?, 0, 0, 0, 0, 0) RETURNING rid`,
          );
          const rids: number[] = [];
          for (const [index, op] of ops.entries()) {
            applyMessageOp(db, { seed, insert, rids, index }, op);
          }

          expect(ftsRowids(db, 'messages_fts')).toEqual(indexableMessageRids(db));
        });
      }),
      fcConfig(),
    );
  });

  it('indexes the scope token so one group never matches another', () => {
    // The `scope` column is what makes the FTS index intersect with a group's doclist rather than
    // scanning every group's matches (`02` §3.4). A missing or wrong token would not fail any
    // "is it indexed" test — it would silently make search cross-group, which is I4 failing.
    withMigratedDb((db) => {
      const a = seedGroup(db, 'ftsa');
      const b = seedGroup(db, 'ftsb');
      const insert = db.prepare(
        `INSERT INTO messages (id, group_id, conversation_id, kind, text, untrusted, label_id,
           sent_at, received_at, delivered_late, truncated, edit_count)
         VALUES (?, ?, ?, 'member', ?, 0, ?, 0, 0, 0, 0, 0)`,
      );
      insert.run(
        'msg_01jfa000000000000000000001',
        a.groupId,
        a.conversationId,
        'rhubarb',
        a.labelId,
      );
      insert.run(
        'msg_01jfb000000000000000000002',
        b.groupId,
        b.conversationId,
        'rhubarb',
        b.labelId,
      );

      const tokenOf = (groupId: string) => `g${groupId.slice(4)}`;
      const hits = (groupId: string) =>
        (
          db
            .prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?')
            .all(`scope : "${tokenOf(groupId)}" AND (body : "rhubarb")`) as { rowid: number }[]
        ).length;

      expect(hits(a.groupId)).toBe(1);
      expect(hits(b.groupId)).toBe(1);
      // Both messages are in the index; the scope token is the only thing separating them.
      expect(
        (
          db
            .prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?')
            .all('body : "rhubarb"') as { rowid: number }[]
        ).length,
      ).toBe(2);
    });
  });
});

describe('fts.trigger-sync.property — memory', { tags: ['prop', 'db'] }, () => {
  it('keeps both memory indexes equal to the non-retracted rows', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({
              kind: fc.constant('insert' as const),
              statement: fc.string({ minLength: 1 }),
              terms: fc.array(fc.string({ minLength: 1, maxLength: 12 }), { maxLength: 4 }),
            }),
            fc.record({ kind: fc.constant('retract' as const), at: fc.nat(8) }),
            fc.record({ kind: fc.constant('reactivate' as const), at: fc.nat(8) }),
            fc.record({ kind: fc.constant('delete' as const), at: fc.nat(8) }),
          ),
          { minLength: 1, maxLength: 20 },
        ),
        (ops) => {
          withMigratedDb((db) => {
            const seed = seedGroup(db, 'mem');
            const insert = db.prepare(
              `INSERT INTO memory_items (id, group_id, kind, content, statement, search_terms,
                 language, fingerprint, label_id, provenance, confidence, status, valid_from,
                 contradicts, links, retrieval_state, pinned, portable, embedding_state,
                 created_at, updated_at, version)
               VALUES (?, ?, 'note', '{}', ?, ?, 'en', x'00', ?, '{}', 1, 'active', 0,
                 '[]', '[]', 0, 0, 0, 'pending', 0, 0, 1) RETURNING rid`,
            );
            const rids: number[] = [];
            for (const [index, op] of ops.entries()) {
              applyMemoryOp(db, { seed, insert, rids, index }, op);
            }

            const expected = (
              db
                .prepare("SELECT rid FROM memory_items WHERE status <> 'retracted' ORDER BY rid")
                .all() as { rid: number }[]
            ).map((row) => row.rid);
            expect(ftsRowids(db, 'memory_fts')).toEqual(expected);
            // Both indexes, because `02` §3.4 maintains the trigram one in the same triggers and a
            // test of only the word index would let the trigram half drift unnoticed.
            expect(ftsRowids(db, 'memory_fts_tri')).toEqual(expected);
          });
        },
      ),
      fcConfig(),
    );
  });
});

describe('fts.trigger-sync.property — entities', { tags: ['prop', 'db'] }, () => {
  it('gives every coordination table a distinct rowid space in entity_fts', () => {
    // `rowid = rid * 8 + typeCode` is what lets six tables share one index. If two type codes
    // collided, one table's rows would silently overwrite another's — so the arithmetic is the
    // thing to test, across the full range of rids the tables will ever reach.
    // `expect(previous ?? source.table).toBe(source.table)` was the assertion, which reduces to
    // `expect(x).toBe(x)` whenever `previous` is `undefined` — and that is the overwhelming
    // majority of iterations, because a collision is the thing being looked for and there are
    // none. So the property was asserting an identity almost every time it ran. Found by the M1
    // independent review.
    //
    // Collisions are collected and the **list** is asserted empty, which is a statement about the
    // finding rather than about a value equalling itself, and it names both tables when it fails.
    let checked = 0;
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 1_000_000 }), { minLength: 2, maxLength: 20 }), (rids) => {
        const seen = new Map<number, string>();
        const collisions: string[] = [];
        for (const rid of [...new Set(rids)]) {
          for (const source of ENTITY_FTS_SOURCES) {
            const rowid = rid * 8 + source.typeCode;
            const previous = seen.get(rowid);
            if (previous !== undefined && previous !== source.table) {
              collisions.push(`rowid ${String(rowid)}: ${previous} and ${source.table}`);
            }
            seen.set(rowid, source.table);
            checked += 1;
          }
        }
        expect(collisions, 'two tables share a rowid in entity_fts').toEqual([]);
        // Every (rid, source) pair produced a distinct rowid, which is the same claim stated as a
        // count — and unlike the loop above it fails if the formula starts mapping two pairs onto
        // one rowid even when they belong to the same table.
        expect(seen.size).toBe(new Set(rids).size * ENTITY_FTS_SOURCES.length);
      }),
      fcConfig(),
    );
    // Non-vacuity: a generator that produced nothing, or an empty `ENTITY_FTS_SOURCES`, would make
    // every assertion above pass over zero pairs.
    expect(checked).toBeGreaterThan(100);
    expect(ENTITY_FTS_SOURCES).toHaveLength(6);
  });

  it('uses the same multiplier the shipped triggers use', () => {
    // The loop above re-implements `rid * 8 + typeCode` in the test, so a trigger using a
    // different multiplier would be invisible to it — the arithmetic would be proven
    // collision-free and have nothing to do with what the database does.
    //
    // Read from the committed migration, which is what a host runs. Textual rather than
    // behavioural because the behavioural half needs a row in each of the six coordination tables;
    // `indexes and removes an event through its triggers` below does that for one of them.
    const sql = readFileSync(MIGRATION_PATH_ABS, 'utf8');
    for (const source of ENTITY_FTS_SOURCES) {
      expect(sql, `${source.table} does not use rid * 8 in entity_fts`).toContain(
        `NEW.rid * 8 + ${String(source.typeCode)}`,
      );
    }
    // The type codes are distinct and contiguous from 1, which is what keeps them inside the
    // multiplier: an eighth source would need the multiplier to grow.
    expect(ENTITY_FTS_SOURCES.map((source) => source.typeCode).toSorted()).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it('indexes and removes an event through its triggers', () => {
    withMigratedDb((db) => {
      const seed = seedGroup(db, 'evt');
      const eventId = 'evt_01je0000000000000000000001';
      db.prepare(
        `INSERT INTO events (id, group_id, series_id, title, notes, location, all_day, tz,
           start_local, start_at, rrule_invalid, rdates, exdates, status, busy, attendees_mode,
           source, label_id, ics_uid, ics_sequence, tzdata_version, created_at, updated_at, version)
         VALUES (?, ?, ?, 'Soccer practice', 'bring boots', ?, 0, 'UTC', '2026-11-13T18:00:00', 0, 0,
           '[]', '[]', 'confirmed', 1, 'none', ?, ?, ?, 0, '2026a', 0, 0, 1)`,
      ).run(
        eventId,
        seed.groupId,
        eventId,
        JSON.stringify({ text: 'The park' }),
        JSON.stringify({ kind: 'native' }),
        seed.labelId,
        `ics-${eventId}`,
      );

      const row = db.prepare('SELECT rid FROM events WHERE id = ?').get(eventId) as { rid: number };
      const expectedRowid = row.rid * 8 + 1;
      expect(ftsRowids(db, 'entity_fts')).toEqual([expectedRowid]);

      // The location's text is indexed out of the JSON column, which is why the trigger uses
      // `json_extract` rather than the raw value — indexing `{"text":"The park"}` would make the
      // braces and the key searchable.
      const hits = db
        .prepare('SELECT rowid FROM entity_fts WHERE entity_fts MATCH ?')
        .all('body : "park"') as { rowid: number }[];
      expect(hits.map((hit) => hit.rowid)).toEqual([expectedRowid]);

      db.prepare('DELETE FROM events WHERE id = ?').run(eventId);
      expect(ftsRowids(db, 'entity_fts')).toEqual([]);
    });
  });
});
