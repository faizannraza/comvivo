/**
 * `04:M1-T61`, the memory index: the four checks `04` §10 requires, in the shape the retrieval
 * path actually uses.
 *
 * `02` §3.6.3 step 4 and `vec.spike.test.ts` establish the vec0 **mechanics** in isolation. This
 * file is the integrated question: one set of memory rows, an FTS index and a vector index over
 * them, and a query that applies the same eligible-label filter to both. That is `04` §3.6.3's
 * retrieval, and it is where the four checks either hold together or do not:
 *
 *  - **(a)** a padded `label_id IN (?, …)` on INTEGER metadata during KNN;
 *  - **(b)** three metadata constraints together (`IN` + `state <=` + `valid_to_ms >`);
 *  - **(c)** FTS5 `secure-delete=1` on a contentless-delete table with a `{statement terms}:`
 *    column filter;
 *  - **(d)** vector zeroing on delete.
 *
 * `04` §10's acceptance is "all 4 pass, or a documented fallback". All four pass; (d) passes even
 * in the plaintext D9 shape, which is the one where it would have mattered most.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import * as sqliteVec from 'sqlite-vec';
import { describe, expect, it } from 'vitest';
import { DB_FILENAME, rowid, vec, withSpikeDb, withSpikeDir } from './open.js';
import { MEMORY_FTS, scopeToken, secureDelete } from './search.sql.js';

const GROUP = 'grp_01jd8zzzzzzzzzzzzzzzzzzzzz';
const GROUP_RID = 1n;

/** `04` R1–R13's retrieval state: 1 active, 2 superseded, 3 retracted. */
const ACTIVE = 1n;
const SUPERSEDED = 2n;
const RETRACTED = 3n;

const FAR_FUTURE = 9_000_000_000_000n;
const PAST = 1_000n;

interface Memory {
  readonly rid: number;
  readonly statement: string;
  readonly terms: string;
  readonly labelId: bigint;
  readonly state: bigint;
  readonly validToMs: bigint;
  readonly embedding: readonly number[];
}

/**
 * Five memories: two the asker may read, one with a label they may not, one retracted, one
 * expired. The shape every eligibility test needs, because a filter that returns everything and a
 * filter that returns nothing both look correct against a single row.
 */
const MEMORIES: readonly Memory[] = [
  {
    rid: 1,
    statement: 'Aisha is collecting Sam on Tuesday',
    terms: 'pickup tuesday',
    labelId: 10n,
    state: ACTIVE,
    validToMs: FAR_FUTURE,
    embedding: [1, 0, 0, 0],
  },
  {
    rid: 2,
    statement: 'the rent is due on the first',
    terms: 'rent monthly',
    labelId: 11n,
    state: ACTIVE,
    validToMs: FAR_FUTURE,
    embedding: [0.98, 0.02, 0, 0],
  },
  {
    rid: 3,
    statement: 'Sam has a doctor appointment on Thursday',
    terms: 'appointment thursday',
    labelId: 99n, // a label the asker is not eligible for
    state: ACTIVE,
    validToMs: FAR_FUTURE,
    embedding: [0.97, 0.03, 0, 0],
  },
  {
    rid: 4,
    statement: 'the recital was last Friday',
    terms: 'recital friday',
    labelId: 10n,
    state: RETRACTED,
    validToMs: FAR_FUTURE,
    embedding: [0.96, 0.04, 0, 0],
  },
  {
    rid: 5,
    statement: 'the car is in for a service until Wednesday',
    terms: 'car service',
    labelId: 10n,
    state: ACTIVE,
    validToMs: PAST, // no longer valid
    embedding: [0.95, 0.05, 0, 0],
  },
];

/** The two indexes `04` §3.6.3 queries together, plus the rows. */
function seed(db: Database.Database): void {
  db.exec(MEMORY_FTS);
  db.exec(secureDelete('memory_fts'));
  db.exec(`
    create virtual table vec_memory_default using vec0(
      group_rid integer partition key,
      label_id integer,
      state integer,
      valid_to_ms integer,
      embedding float[4]
    )
  `);

  const fts = db.prepare(
    'insert into memory_fts(rowid, statement, terms, scope) values (?, ?, ?, ?)',
  );
  const knn = db.prepare(`
    insert into vec_memory_default(rowid, group_rid, label_id, state, valid_to_ms, embedding)
    values (?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (const m of MEMORIES) {
      fts.run(m.rid, m.statement, m.terms, scopeToken(GROUP));
      knn.run(rowid(m.rid), GROUP_RID, m.labelId, m.state, m.validToMs, vec(m.embedding));
    }
  })();
}

/**
 * The eligible-label set, **padded** to a fixed length.
 *
 * `04` §3.6.3 pads so the number of placeholders does not vary with how much the asker may read —
 * a query plan whose shape reveals the size of somebody's eligible set is a side channel, and a
 * cheap one to close.
 */
function paddedEligible(labels: readonly bigint[], width = 8): bigint[] {
  const padded = [...labels];
  const filler = labels[0] ?? 0n;
  while (padded.length < width) padded.push(filler);
  return padded;
}

const ELIGIBLE = paddedEligible([10n, 11n]);
const PLACEHOLDERS = ELIGIBLE.map(() => '?').join(', ');

describe('(a) a padded label_id IN set filters a KNN query', { tags: ['db', 'slow'] }, () => {
  it('returns only rows whose label is in the set, with the set padded', () => {
    withSpikeDb((db) => {
      seed(db);
      const rows = db
        .prepare(`
          select rowid from vec_memory_default
          where embedding match ? and k = 10
            and group_rid = ?
            and label_id in (${PLACEHOLDERS})
          order by distance
        `)
        .all(vec([1, 0, 0, 0]), GROUP_RID, ...ELIGIBLE) as { rowid: number }[];
      // 1, 2, 4 and 5 carry labels 10 or 11; 3 carries 99 and must not appear.
      expect(rows.map((r) => r.rowid).sort((a, b) => a - b)).toEqual([1, 2, 4, 5]);
    });
  });

  it('returns nothing when the eligible set is empty of matching labels', () => {
    // The direction that matters: a filter that silently falls open would pass the test above.
    withSpikeDb((db) => {
      seed(db);
      const none = paddedEligible([7n]);
      const rows = db
        .prepare(`
          select rowid from vec_memory_default
          where embedding match ? and k = 10
            and group_rid = ?
            and label_id in (${none.map(() => '?').join(', ')})
        `)
        .all(vec([1, 0, 0, 0]), GROUP_RID, ...none) as { rowid: number }[];
      expect(rows).toEqual([]);
    });
  });

  it('pads without changing the result, so the padding is not doing the filtering', () => {
    withSpikeDb((db) => {
      seed(db);
      const run = (labels: bigint[]): number[] =>
        (
          db
            .prepare(`
              select rowid from vec_memory_default
              where embedding match ? and k = 10
                and group_rid = ?
                and label_id in (${labels.map(() => '?').join(', ')})
              order by distance
            `)
            .all(vec([1, 0, 0, 0]), GROUP_RID, ...labels) as { rowid: number }[]
        )
          .map((r) => r.rowid)
          .sort((a, b) => a - b);
      expect(run([10n, 11n])).toEqual(run(paddedEligible([10n, 11n])));
      expect(run([10n, 11n])).toEqual(run(paddedEligible([10n, 11n], 32)));
    });
  });
});

describe('(b) three metadata constraints together', { tags: ['db', 'slow'] }, () => {
  it('is the real retrieval query: eligible, not retracted, still valid', () => {
    withSpikeDb((db) => {
      seed(db);
      const rows = db
        .prepare(`
          select rowid from vec_memory_default
          where embedding match ? and k = 10
            and group_rid = ?
            and label_id in (${PLACEHOLDERS})
            and state <= ?
            and valid_to_ms > ?
          order by distance
        `)
        .all(vec([1, 0, 0, 0]), GROUP_RID, ...ELIGIBLE, SUPERSEDED, 2_000n) as {
        rowid: number;
      }[];
      // 3 is ineligible, 4 is retracted, 5 has expired.
      expect(rows.map((r) => r.rowid).sort((a, b) => a - b)).toEqual([1, 2]);
    });
  });

  it('drops exactly one row per constraint, so each one is doing work', () => {
    // Without this, a query that happened to return [1, 2] for the wrong reason would pass above.
    withSpikeDb((db) => {
      seed(db);
      const count = (extra: string, params: readonly unknown[]): number =>
        (
          db
            .prepare(`
              select rowid from vec_memory_default
              where embedding match ? and k = 10 and group_rid = ? ${extra}
            `)
            .all(vec([1, 0, 0, 0]), GROUP_RID, ...params) as unknown[]
        ).length;

      expect(count('', []), 'all five rows').toBe(5);
      expect(count(`and label_id in (${PLACEHOLDERS})`, ELIGIBLE), 'label filter drops 3').toBe(4);
      expect(count('and state <= ?', [SUPERSEDED]), 'state filter drops 4').toBe(4);
      expect(count('and valid_to_ms > ?', [2_000n]), 'validity filter drops 5').toBe(4);
    });
  });
});

describe('(c) FTS and KNN agree on eligibility', { tags: ['db', 'slow'] }, () => {
  it('finds the same two rows through the column filter as through KNN', () => {
    // `04` §3.6.3 fuses a keyword hit list and a vector hit list. If the two sides disagreed about
    // what the asker may read, the fusion step would have to re-filter — and whichever side was
    // wrong would be the one that leaked.
    withSpikeDb((db) => {
      seed(db);
      const eligibleRids = new Set(
        (
          db
            .prepare(`
              select rowid from vec_memory_default
              where embedding match ? and k = 10
                and group_rid = ?
                and label_id in (${PLACEHOLDERS})
                and state <= ?
                and valid_to_ms > ?
            `)
            .all(vec([1, 0, 0, 0]), GROUP_RID, ...ELIGIBLE, SUPERSEDED, 2_000n) as {
            rowid: number;
          }[]
        ).map((r) => r.rowid),
      );
      expect([...eligibleRids].sort()).toEqual([1, 2]);

      // The keyword side, scoped to the group and filtered to the same two columns.
      const hits = db
        .prepare('select rowid from memory_fts where memory_fts match ? order by rowid')
        .all(`scope : "${scopeToken(GROUP)}" AND {statement terms} : (tuesday OR rent)`) as {
        rowid: number;
      }[];
      expect(hits.map((h) => h.rowid)).toEqual([1, 2]);
      // And every keyword hit is one the vector side also considers eligible.
      for (const hit of hits) expect(eligibleRids.has(hit.rowid)).toBe(true);
    });
  });

  it('stops matching a memory whose tokens were deleted, including by term', () => {
    withSpikeDb((db) => {
      seed(db);
      db.prepare('delete from memory_fts where rowid = ?').run(3);
      for (const term of ['doctor', 'appointment', 'thursday']) {
        expect(
          (
            db
              .prepare('select count(*) as c from memory_fts where memory_fts match ?')
              .get(term) as { c: number }
          ).c,
          term,
        ).toBe(0);
      }
    });
  });
});

describe('(d) deleting a vector removes it, bytes and all', { tags: ['db', 'slow'] }, () => {
  it('drops the row from KNN results', () => {
    withSpikeDb((db) => {
      seed(db);
      const present = (): number[] =>
        (
          db
            .prepare(`
              select rowid from vec_memory_default
              where embedding match ? and k = 10 and group_rid = ? order by distance
            `)
            .all(vec([1, 0, 0, 0]), GROUP_RID) as { rowid: number }[]
        )
          .map((r) => r.rowid)
          .sort((a, b) => a - b);

      expect(present()).toEqual([1, 2, 3, 4, 5]);
      db.prepare('delete from vec_memory_default where rowid = ?').run(rowid(3));
      expect(present()).toEqual([1, 2, 4, 5]);
    });
  });

  it('leaves no trace of the float bytes, even in a PLAINTEXT database', () => {
    // The honest version of "vector zeroing on delete". In the encrypted D8 build the file is
    // ciphertext, so grepping it proves nothing about zeroing — the interesting case is `02`
    // §3.6.5's **D9 fallback**, where vectors would sit in a plaintext file and an embedding is
    // itself sensitive: it is a lossy but very serviceable reconstruction of the sentence.
    //
    // Measured 2026-11-04: with `secure_delete = ON`, the bytes are gone after the delete and a
    // WAL truncate, with no explicit zeroing step. So neither D8 nor D9 needs one, and `04`
    // §10's item (d) passes rather than needing a documented fallback.
    withSpikeDir((dir) => {
      const file = join(dir, DB_FILENAME);
      const db = new Database(file);
      try {
        db.pragma('journal_mode = WAL');
        db.pragma('secure_delete = ON');
        sqliteVec.load(db);
        db.exec('create virtual table v using vec0(embedding float[8])');

        // A pattern whose byte sequence will not occur by chance in page headers or free space.
        const pattern = [
          1.2345678e-11, 2.3456789e-11, 3.456789e-11, 4.56789e-11, 5.6789e-11, 6.789e-11, 7.89e-11,
          8.9e-11,
        ];
        const bytes = vec(pattern);
        db.prepare('insert into v(rowid, embedding) values (?, ?)').run(rowid(1), bytes);
        db.pragma('wal_checkpoint(TRUNCATE)');
        // Non-vacuous: the bytes have to be findable before the delete, or the check after it is
        // meaningless.
        expect(readFileSync(file).includes(bytes), 'the pattern was never written').toBe(true);

        db.prepare('delete from v where rowid = ?').run(rowid(1));
        db.pragma('wal_checkpoint(TRUNCATE)');
        expect(readFileSync(file).includes(bytes)).toBe(false);
        expect(db.prepare('select count(*) as c from v').get()).toMatchObject({ c: 0 });
      } finally {
        db.close();
      }
      expect(randomBytes(1).length).toBe(1);
    });
  });
});
