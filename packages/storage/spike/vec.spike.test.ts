/**
 * sqlite-vec inside SQLCipher: `02` §3.6.3 step 4, criteria U3, U5 and U6.
 *
 * The design question behind all of it is `02` §3.5 and `04` §3.2.6: memory search has to filter
 * by **eligible label ids** and by validity window *inside* the KNN query. If vec0 cannot take
 * those as metadata predicates, then either the filter moves outside the index — and a KNN that
 * returns the 10 nearest rows and *then* drops the ones you may not read returns fewer than 10
 * results, sometimes none, which is a silently bad search — or vectors move to the §3.6.5
 * in-process index. So these are not curiosity tests; each one decides a branch.
 *
 * Every test owns its database via `withSpikeDb`. No module-level state, because a file that
 * passes in declaration order and fails under shuffle is a file nobody can trust.
 */
import type Database from 'better-sqlite3-multiple-ciphers';
import { describe, expect, it } from 'vitest';
import { rowid, vec, withSpikeDb } from './open.js';

interface Row {
  readonly rowid: number;
  readonly distance: number;
}

/** The shape `02` §3.5 actually needs: a partition key, filterable metadata, and a range column. */
function createMemoryIndex(db: Database.Database, options = ''): void {
  db.exec(`
    create virtual table vec_memory_default using vec0(
      group_rid integer partition key,
      label_id integer,
      state integer,
      valid_to_ms integer,
      embedding float[4]${options === '' ? '' : `, ${options}`}
    )
  `);
}

const INSERT_MEMORY = `
  insert into vec_memory_default(rowid, group_rid, label_id, state, valid_to_ms, embedding)
  values (?, ?, ?, ?, ?, ?)
`;

/** A populated index: two groups, one retracted row, one expired row. */
function seedMemoryIndex(db: Database.Database): void {
  createMemoryIndex(db);
  const insert = db.prepare(INSERT_MEMORY);
  db.transaction(() => {
    insert.run(rowid(1), 1n, 10n, 1n, 9_000_000_000_000n, vec([1, 0, 0, 0]));
    insert.run(rowid(2), 1n, 11n, 1n, 9_000_000_000_000n, vec([0.98, 0.02, 0, 0]));
    insert.run(rowid(3), 1n, 10n, 3n, 9_000_000_000_000n, vec([0.97, 0.03, 0, 0])); // retracted
    insert.run(rowid(4), 1n, 10n, 1n, 1_000n, vec([0.96, 0.04, 0, 0])); // expired
    insert.run(rowid(5), 2n, 20n, 1n, 9_000_000_000_000n, vec([0.95, 0.05, 0, 0])); // other group
  })();
}

describe('vec0 binds rowids as integers only', { tags: ['db', 'slow'] }, () => {
  it('rejects a plain JS number, which better-sqlite3 binds as a float', () => {
    // The first thing this spike found, and it would otherwise have been a confusing runtime error
    // in `M1-T18`. Every vec0 write goes through `rowid()`.
    withSpikeDb((db) => {
      db.exec('create virtual table v using vec0(embedding float[4])');
      expect(() =>
        db.prepare('insert into v(rowid, embedding) values (?, ?)').run(1, vec([1, 0, 0, 0])),
      ).toThrow(/integers/i);
    });
  });

  it('accepts a BigInt', () => {
    withSpikeDb((db) => {
      db.exec('create virtual table v using vec0(embedding float[4])');
      expect(() =>
        db
          .prepare('insert into v(rowid, embedding) values (?, ?)')
          .run(rowid(1), vec([1, 0, 0, 0])),
      ).not.toThrow();
    });
  });
});

describe('KNN with the filters `02` §3.5 needs', { tags: ['db', 'slow'] }, () => {
  it('(a) filters by a label_id IN set inside the query', () => {
    // `04:M1-T61` item (a). The eligible-label set is computed by core `canRead` and padded to a
    // fixed length so the query plan does not leak its size — hence `IN` with repeats.
    withSpikeDb((db) => {
      seedMemoryIndex(db);
      const rows = db
        .prepare(`
          select rowid, distance from vec_memory_default
          where embedding match ? and k = 5 and group_rid = 1 and label_id in (10, 10, 10)
          order by distance
        `)
        .all(vec([1, 0, 0, 0])) as Row[];
      expect(rows.map((r) => r.rowid).sort()).toEqual([1, 3, 4]);
    });
  });

  it('(b) combines IN, a state ceiling and a validity window in one query', () => {
    // `04:M1-T61` item (b), and the real retrieval query: eligible labels, not retracted, still
    // valid. If vec0 could not do all three together, every search would over-fetch and
    // post-filter, returning fewer results than asked for without saying so.
    withSpikeDb((db) => {
      seedMemoryIndex(db);
      const rows = db
        .prepare(`
          select rowid, distance from vec_memory_default
          where embedding match ? and k = 5
            and group_rid = 1
            and label_id in (10, 11)
            and state <= 2
            and valid_to_ms > 2000
          order by distance
        `)
        .all(vec([1, 0, 0, 0])) as Row[];
      expect(rows.map((r) => r.rowid).sort()).toEqual([1, 2]);
    });
  });

  it('never crosses a partition, so one group cannot see another', () => {
    // Group isolation (I4) is enforced in core; this is the storage layer's defence in depth.
    withSpikeDb((db) => {
      seedMemoryIndex(db);
      const rows = db
        .prepare(`
          select rowid from vec_memory_default
          where embedding match ? and k = 10 and group_rid = 2
        `)
        .all(vec([1, 0, 0, 0])) as Row[];
      expect(rows.map((r) => r.rowid)).toEqual([5]);
    });
  });

  it('orders L2 the same way cosine would on unit vectors', () => {
    // `02` §3.5's table: L2 on unit vectors gives cosine's ordering, so the index stores one
    // metric and the repository normalises on write.
    withSpikeDb((db) => {
      const unit = (x: number, y: number): Buffer => {
        const n = Math.hypot(x, y);
        return vec([x / n, y / n, 0, 0]);
      };
      db.exec('create virtual table u using vec0(embedding float[4])');
      const insert = db.prepare('insert into u(rowid, embedding) values (?, ?)');
      insert.run(rowid(1), unit(1, 0));
      insert.run(rowid(2), unit(1, 0.1));
      insert.run(rowid(3), unit(0, 1));
      const rows = db
        .prepare('select rowid from u where embedding match ? and k = 3 order by distance')
        .all(unit(1, 0)) as Row[];
      expect(rows.map((r) => r.rowid)).toEqual([1, 2, 3]);
    });
  });
});

describe('U6 — DML on vec0 from inside a trigger', { tags: ['db', 'slow'] }, () => {
  const createDeleteTrigger = (db: Database.Database): void => {
    db.exec('create table memory (rid integer primary key, body text)');
    db.exec('create virtual table vm using vec0(embedding float[4])');
    db.exec(`
      create trigger memory_ad after delete on memory begin
        delete from vm where rowid = old.rid;
      end
    `);
    db.prepare('insert into memory (rid, body) values (?, ?)').run(1, 'secret');
    db.prepare('insert into vm(rowid, embedding) values (?, ?)').run(rowid(1), vec([1, 0, 0, 0]));
  };

  const vectorCount = (db: Database.Database): number =>
    (db.prepare('select count(*) as c from vm').get() as { c: number }).c;

  it('deletes the vector row when its owner row is deleted', () => {
    // `02` §3.5: this trigger is what stops a retracted memory's vector surviving its row. If it
    // did not work, the decision matrix moves to repository-level deletes plus a nightly
    // reconcile — correct but weaker, because the window between the two is a window in which a
    // deleted memory is still findable by similarity.
    withSpikeDb((db) => {
      createDeleteTrigger(db);
      expect(vectorCount(db)).toBe(1);
      db.prepare('delete from memory where rid = 1').run();
      expect(vectorCount(db)).toBe(0);
    });
  });

  it('is REFUSED with trusted_schema = OFF, which settles the hardening question', () => {
    // Measured 2026-11-03: `unsafe use of virtual table "vm"`. With `trusted_schema=OFF`, SQLite
    // allows a virtual table inside a trigger only if it is marked `SQLITE_VTAB_INNOCUOUS`, and
    // vec0 is not. `02` §3.6.2 kept `trusted_schema` at its default ON because this was
    // *unverified*; it is now verified, and ON is the only setting under which the memory-delete
    // trigger works at all.
    //
    // Asserted rather than merely recorded, so that if a future sqlite-vec marks itself innocuous
    // this test fails and somebody gets to turn the hardening on deliberately.
    withSpikeDb((db) => {
      db.pragma('trusted_schema = OFF');
      createDeleteTrigger(db);
      // The DDL is accepted; the refusal comes when the trigger *runs*. That is the worse of the
      // two failure modes — a schema that looks fine and a delete that throws at runtime, in the
      // path that removes a retracted memory's vector.
      expect(() => db.prepare('delete from memory where rid = 1').run()).toThrow(
        /unsafe use of virtual table/i,
      );
      // And the vector survives, which is the actual harm.
      expect(vectorCount(db)).toBe(1);
    });
  });

  it('allows an FTS5 contentless trigger with trusted_schema = OFF', () => {
    // The other half of U6, and it goes the other way: FTS5 *is* innocuous, so the search-sync
    // triggers would survive the hardening even though the vector ones do not. Recorded because it
    // means `trusted_schema` is one global switch over two different answers — which is why `02`
    // §3.6.2's choice has to be ON for the whole database.
    withSpikeDb((db) => {
      db.pragma('trusted_schema = OFF');
      db.exec('create table msg (rid integer primary key, body text)');
      db.exec("create virtual table fts using fts5(body, content='')");
      db.exec(`
        create trigger msg_ai after insert on msg begin
          insert into fts(rowid, body) values (new.rid, new.body);
        end
      `);
      db.prepare('insert into msg (rid, body) values (1, ?)').run('hello family');
      expect(
        (
          db.prepare('select count(*) as c from fts where fts match ?').get('family') as {
            c: number;
          }
        ).c,
      ).toBe(1);
    });
  });
});

describe('U3 — UPDATE of a metadata column', { tags: ['db', 'slow'] }, () => {
  it('supports updating metadata in place', () => {
    // `02` §3.5 deliberately does not depend on this: its update trigger deletes and reinserts.
    // Measured 2026-11-03 (sqlite-vec v0.1.9): **supported** — so `M1-T18` can avoid rewriting an
    // embedding every time a label or a validity window changes, which on a 135k-message instance
    // is most of the writes. Asserted rather than recorded, so losing it is a failing test and a
    // documented decision rather than a silent performance regression.
    withSpikeDb((db) => {
      createMemoryIndex(db);
      db.prepare(INSERT_MEMORY).run(rowid(1), 1n, 10n, 1n, 9_000_000_000_000n, vec([1, 0, 0, 0]));
      db.prepare('update vec_memory_default set state = ? where rowid = ?').run(3n, rowid(1));
      expect(
        db.prepare('select state from vec_memory_default where rowid = 1').get(),
      ).toMatchObject({ state: 3 });
    });
  });
});

describe('U5 — the prebuilt binary reports its own build flags', { tags: ['db', 'slow'] }, () => {
  it('reports a version and a build-flags line', () => {
    // `vec_debug()` prints the flags the *prebuilt binary for this platform* was compiled with, so
    // this is the only honest way to answer U5: it answers it for the machine running the test.
    // darwin-arm64 reports `neon` (measured 2026-11-03). The linux-arm64 answer comes from the
    // Pi 5 run (owner ask H-10) and from CI's arm64 leg — which is why the assertion is on the
    // shape of the output and the report carries the value.
    withSpikeDb((db) => {
      const debug = (db.prepare('select vec_debug() as v').get() as { v: string }).v;
      expect(debug).toContain('Version: v0.1.9');
      expect(debug).toMatch(/Build flags:/);
    });
  });
});

describe('chunk_size is accepted', { tags: ['db', 'slow'] }, () => {
  it('creates an index with chunk_size=256, as `02` §3.6.3 step 4 asks', () => {
    withSpikeDb((db) => {
      expect(() => createMemoryIndex(db, 'chunk_size=256')).not.toThrow();
      expect(() =>
        db.prepare(INSERT_MEMORY).run(rowid(1), 1n, 10n, 1n, 9_000_000_000_000n, vec([1, 0, 0, 0])),
      ).not.toThrow();
    });
  });
});
