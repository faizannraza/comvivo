/**
 * FTS5 inside SQLCipher: `02` §3.6.3 step 5 and `04:M1-T61` item (c).
 *
 * Three things have to hold or the search design changes shape:
 *
 *  - **`contentless_delete=1` works.** `02` §3.4 stores no copy of the text in the index, so the
 *    index cannot be rebuilt from itself; deleting a row has to delete its tokens. Without this,
 *    erasure leaves a searchable shadow of a deleted message.
 *  - **`secure-delete` removes tokens now, not at the next merge.** On a quiet family instance a
 *    merge may never happen, so "eventually" means "never".
 *  - **A column filter works on a contentless table.** `04` R4 puts a memory's `statement` and its
 *    `terms` in one index, and retrieval searches both or just one. Without column filters they
 *    would need two tables and two queries.
 */
import { describe, expect, it } from 'vitest';
import { withSpikeDb } from './open.js';
import {
  MEMORY_FTS,
  MEMORY_FTS_TRI,
  MESSAGES_FTS,
  scopeToken,
  secureDelete,
} from './search.sql.js';

interface Hit {
  readonly rowid: number;
}
interface Count {
  readonly c: number;
}

const GROUP_A = 'grp_01jd8zzzzzzzzzzzzzzzzzzzzz';
const GROUP_B = 'grp_01jd9zzzzzzzzzzzzzzzzzzzzz';

describe('the `02` §3.4 DDL is accepted as written', { tags: ['db', 'slow'] }, () => {
  it('creates all three tables and turns secure-delete on', () => {
    withSpikeDb((db) => {
      db.exec(MESSAGES_FTS);
      db.exec(MEMORY_FTS);
      db.exec(MEMORY_FTS_TRI);
      for (const table of ['messages_fts', 'memory_fts', 'memory_fts_tri']) {
        expect(() => db.exec(secureDelete(table)), table).not.toThrow();
      }
    });
  });

  it('refuses a DELETE on a contentless table without contentless_delete, which is why it is set', () => {
    // The counter-case, so the option is demonstrably load-bearing rather than copied from a doc.
    withSpikeDb((db) => {
      db.exec("create virtual table plain using fts5(body, content='')");
      db.prepare('insert into plain(rowid, body) values (?, ?)').run(1, 'hello family');
      expect(() => db.prepare('delete from plain where rowid = 1').run()).toThrow(
        /contentless|delete/i,
      );
    });
  });
});

describe('contentless-delete removes the row and its tokens', { tags: ['db', 'slow'] }, () => {
  it('deletes by rowid and the term stops matching', () => {
    withSpikeDb((db) => {
      db.exec(MESSAGES_FTS);
      db.exec(secureDelete('messages_fts'));
      const insert = db.prepare('insert into messages_fts(rowid, body, scope) values (?, ?, ?)');
      insert.run(1, 'the recital is next Friday', scopeToken(GROUP_A));
      insert.run(2, 'bringing flowers', scopeToken(GROUP_A));

      expect(
        (
          db
            .prepare('select count(*) as c from messages_fts where messages_fts match ?')
            .get('recital') as Count
        ).c,
      ).toBe(1);

      db.prepare('delete from messages_fts where rowid = 1').run();

      expect(
        (
          db
            .prepare('select count(*) as c from messages_fts where messages_fts match ?')
            .get('recital') as Count
        ).c,
      ).toBe(0);
      // The other row is untouched, so the delete was targeted rather than a wipe.
      expect(
        (
          db
            .prepare('select count(*) as c from messages_fts where messages_fts match ?')
            .get('flowers') as Count
        ).c,
      ).toBe(1);
    });
  });

  it('allows count(*) and a rowid scan on a contentless-delete table', () => {
    // `02` §3.6.3 step 5 asks for this explicitly: a contentless table historically refused
    // ordinary reads, and the retention sweep and the reconcile job both need to enumerate rowids.
    withSpikeDb((db) => {
      db.exec(MESSAGES_FTS);
      db.exec(secureDelete('messages_fts'));
      const insert = db.prepare('insert into messages_fts(rowid, body, scope) values (?, ?, ?)');
      for (let i = 1; i <= 50; i += 1) insert.run(i, `message ${String(i)}`, scopeToken(GROUP_A));

      expect((db.prepare('select count(*) as c from messages_fts').get() as Count).c).toBe(50);
      const rowids = db
        .prepare('select rowid from messages_fts order by rowid limit 3')
        .all() as Hit[];
      expect(rowids.map((r) => r.rowid)).toEqual([1, 2, 3]);
    });
  });

  it('does not leave the deleted text on disk, which is what erasure actually promises', () => {
    // `02` §3.14's erasure story: tokens gone immediately, then `wal_checkpoint(TRUNCATE)`. Here
    // the database is encrypted anyway, so this checks the index rather than the bytes — the
    // on-disk claim is `encryption.spike.test.ts`'s job.
    withSpikeDb((db) => {
      db.exec(MEMORY_FTS);
      db.exec(secureDelete('memory_fts'));
      db.prepare('insert into memory_fts(rowid, statement, terms, scope) values (?, ?, ?, ?)').run(
        1,
        'Sam has a doctor appointment on Thursday',
        'appointment thursday',
        scopeToken(GROUP_A),
      );
      db.prepare('delete from memory_fts where rowid = 1').run();
      for (const term of ['doctor', 'appointment', 'thursday']) {
        expect(
          (
            db
              .prepare('select count(*) as c from memory_fts where memory_fts match ?')
              .get(term) as Count
          ).c,
          term,
        ).toBe(0);
      }
    });
  });
});

describe('(c) a column filter works on a contentless table', { tags: ['db', 'slow'] }, () => {
  it('searches one column, both columns, or the braced set `04` R4 needs', () => {
    withSpikeDb((db) => {
      db.exec(MEMORY_FTS);
      db.exec(secureDelete('memory_fts'));
      const insert = db.prepare(
        'insert into memory_fts(rowid, statement, terms, scope) values (?, ?, ?, ?)',
      );
      // `statement` holds the sentence; `terms` holds the extracted keywords (`04` R4).
      insert.run(1, 'Aisha is collecting Sam on Tuesday', 'pickup tuesday', scopeToken(GROUP_A));
      insert.run(2, 'the rent is due on the first', 'rent monthly', scopeToken(GROUP_A));

      const match = (query: string): number[] =>
        (
          db
            .prepare('select rowid from memory_fts where memory_fts match ? order by rowid')
            .all(query) as Hit[]
        ).map((r) => r.rowid);

      // One column.
      expect(match('statement : collecting')).toEqual([1]);
      expect(match('terms : pickup')).toEqual([1]);
      // The braced set, which is the form `04:M1-T61` (c) names.
      expect(match('{statement terms} : tuesday')).toEqual([1]);
      expect(match('{statement terms} : rent')).toEqual([2]);
      // A term that exists only in `terms` must not match a `statement`-only filter.
      expect(match('statement : pickup')).toEqual([]);
    });
  });

  it('intersects with the scope token, so a query never crosses a group', () => {
    // `02` §3.4: every query includes `scope : "<token>"`, so FTS intersects with the group's
    // doclist rather than scanning other groups' matches. Group isolation (I4) is enforced in
    // core; this is the index doing its share.
    withSpikeDb((db) => {
      db.exec(MEMORY_FTS);
      db.exec(secureDelete('memory_fts'));
      const insert = db.prepare(
        'insert into memory_fts(rowid, statement, terms, scope) values (?, ?, ?, ?)',
      );
      insert.run(1, 'the rent is due', 'rent', scopeToken(GROUP_A));
      insert.run(2, 'the rent is due', 'rent', scopeToken(GROUP_B));

      const hits = db
        .prepare('select rowid from memory_fts where memory_fts match ? order by rowid')
        .all(`scope : "${scopeToken(GROUP_A)}" AND {statement terms} : rent`) as Hit[];
      expect(hits.map((r) => r.rowid)).toEqual([1]);
    });
  });
});

describe('tokenizers behave as `02` §3.4 claims', { tags: ['db', 'slow'] }, () => {
  it('folds diacritics with remove_diacritics 2, so "José" is found by "jose"', () => {
    // The claim in `02` §3.4's tokenizer table, checked rather than trusted — `remove_diacritics 2`
    // (not 1) is what folds characters outside Latin-1, and getting it wrong means a member whose
    // name has an accent is unsearchable.
    withSpikeDb((db) => {
      db.exec(MESSAGES_FTS);
      db.prepare('insert into messages_fts(rowid, body, scope) values (?, ?, ?)').run(
        1,
        'José and Müller are coming',
        scopeToken(GROUP_A),
      );
      for (const query of ['jose', 'muller', 'José', 'Müller']) {
        expect(
          (
            db
              .prepare('select count(*) as c from messages_fts where messages_fts match ?')
              .get(query) as Count
          ).c,
          query,
        ).toBe(1);
      }
    });
  });

  it('accepts trigram with remove_diacritics 1 and matches a substring', () => {
    // `02` §3.6.3 step 5: `remove_diacritics 1` is the only value the trigram tokenizer accepts.
    // Substring matching is why the table exists — CJK, German compounds, typos in the middle.
    withSpikeDb((db) => {
      db.exec(MEMORY_FTS_TRI);
      db.exec(secureDelete('memory_fts_tri'));
      db.prepare('insert into memory_fts_tri(rowid, body) values (?, ?)').run(
        1,
        'Grundschulanmeldung is on Monday',
      );
      expect(
        (
          db
            .prepare('select count(*) as c from memory_fts_tri where memory_fts_tri match ?')
            .get('schulanmeldung') as Count
        ).c,
      ).toBe(1);
    });
  });

  it("accepts every remove_diacritics value, so the spec's choice of 1 is a choice", () => {
    // Measured 2026-11-04, SQLite 3.53.4: the trigram tokenizer accepts **0, 1 and 2**. `02` §3.4
    // names `remove_diacritics 1` for the trigram table and the spike was written expecting 2 to
    // be refused; it is not. 1 and 2 behave identically for Latin-1 and beyond, and **0 does not
    // fold at all** — `jose` finds nothing in `José`. So the value that matters is "not 0", and
    // the spec's 1 is correct for the right reason rather than the only option.
    withSpikeDb((db) => {
      for (const value of [0, 1, 2]) {
        expect(
          () =>
            db.exec(
              `create virtual table t${String(value)} using fts5(body, content='', ` +
                `tokenize="trigram remove_diacritics ${String(value)}")`,
            ),
          `remove_diacritics ${String(value)}`,
        ).not.toThrow();
      }
    });
  });

  it('folds diacritics in the trigram table only when the value is not 0', () => {
    withSpikeDb((db) => {
      const probe = (value: number): number => {
        const name = `t${String(value)}`;
        db.exec(
          `create virtual table ${name} using fts5(body, content='', ` +
            `tokenize="trigram remove_diacritics ${String(value)}")`,
        );
        db.prepare(`insert into ${name}(rowid, body) values (1, ?)`).run('José');
        return (
          db.prepare(`select count(*) as c from ${name} where ${name} match ?`).get('jose') as Count
        ).c;
      };
      expect(probe(0), 'remove_diacritics 0 should not fold').toBe(0);
      expect(probe(1), 'remove_diacritics 1 should fold').toBe(1);
    });
  });

  it('matches CJK through the trigram table, at three characters and not two', () => {
    // The reason `02` §3.4 keeps two tokenizers: `unicode61` has no segmentation for CJK, so a
    // Japanese or Chinese substring is only findable through the trigram index.
    //
    // And the floor is real. `の夕食` (3 characters) matches; **`夕食` (2) does not** — a trigram
    // index cannot represent a query shorter than a trigram. For English that is a curiosity; for
    // CJK it is most short queries, because two characters is a whole word. `02` §3.4 lists the
    // ≥ 3-character limit as a weakness without saying what to do about it; recorded here and in
    // the spec so `M6` retrieval falls back to vector search for a 1–2 character query rather
    // than returning nothing and looking broken.
    withSpikeDb((db) => {
      db.exec(MESSAGES_FTS);
      db.exec(MEMORY_FTS_TRI);
      const text = '明日の夕食は七時です';
      db.prepare('insert into messages_fts(rowid, body, scope) values (?, ?, ?)').run(
        1,
        text,
        scopeToken(GROUP_A),
      );
      db.prepare('insert into memory_fts_tri(rowid, body) values (?, ?)').run(1, text);

      const tri = (query: string): number =>
        (
          db
            .prepare('select count(*) as c from memory_fts_tri where memory_fts_tri match ?')
            .get(query) as Count
        ).c;
      expect(tri('の夕食'), 'three CJK characters should match').toBe(1);
      expect(tri('夕食'), 'two CJK characters cannot match a trigram index').toBe(0);
    });
  });
});

describe('bm25 ranking is available and scope can be given zero weight', {
  tags: ['db', 'slow'],
}, () => {
  it('ranks by bm25 with the scope column weighted 0.0', () => {
    // `02` §3.4: "the scope column's bm25() weight is 0.0, so scope never affects ranking". A
    // group token that contributed to relevance would make ranking depend on which group you are
    // in, which is both wrong and very hard to notice.
    withSpikeDb((db) => {
      db.exec(MESSAGES_FTS);
      const insert = db.prepare('insert into messages_fts(rowid, body, scope) values (?, ?, ?)');
      insert.run(1, 'rent rent rent', scopeToken(GROUP_A));
      insert.run(2, 'the rent is due on the first of the month', scopeToken(GROUP_A));

      const ranked = db
        .prepare(`
          select rowid, bm25(messages_fts, 1.0, 0.0) as score
          from messages_fts where messages_fts match ? order by score
        `)
        .all('rent') as { rowid: number; score: number }[];
      expect(ranked).toHaveLength(2);
      // More occurrences in a shorter document ranks first (bm25 is negative; lower is better).
      expect(ranked[0]?.rowid).toBe(1);
      expect(ranked.every((r) => Number.isFinite(r.score))).toBe(true);
    });
  });
});
