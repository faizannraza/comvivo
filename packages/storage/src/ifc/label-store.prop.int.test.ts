/**
 * `labels.intern-idempotent.property` (`M1-T16`; `02` §3.2 D4).
 *
 * Interning has one job: the same value must always yield the same id, and a different value must
 * always yield a different one. Both halves matter and they fail differently — collapsing two
 * values into one id mislabels data (an **I1** hole, because the wrong audience becomes eligible),
 * while splitting one value across two ids only wastes rows and defeats the cache.
 *
 * The rollback case is the one `02` §3.2 singles out, and it is the reason the caches are filled in
 * `afterCommit` rather than inline: "a rolled-back insert would otherwise leave a cached id that
 * `AUTOINCREMENT` never reissues".
 */
import { type Audience, audienceKey, type Label, type NotPromise } from '@comvivo/core';
import {
  type GroupId,
  type Logger,
  type MemberId,
  type ReaderSetId,
  StorageError,
  SystemClock,
  TypeIdGenerator,
} from '@comvivo/shared';
import { fcConfig } from '@comvivo/shared/testing';
import type Database from 'better-sqlite3-multiple-ciphers';
import fc from 'fast-check';
import { Temporal } from 'temporal-polyfill';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '../db/tx.js';
import { seedGroup, withMigratedDb } from '../schema/testing/migrated-db.js';
import { LabelStore, labelCanonicalKey, readerSetCanonicalKey } from './label-store.js';

/** A logger that records nothing: these tests assert on rows, not on lines. */
const silent = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  content: () => {},
  child: () => silent,
} as unknown as Logger;

interface World {
  readonly db: Database.Database;
  readonly store: SqliteStore;
  readonly labels: LabelStore;
  readonly groupId: GroupId;
  /** Real member rows, because `labels.owner_member_id` and `reader_set_members` are foreign keys. */
  readonly memberIds: readonly MemberId[];
  readonly conversationId: string;
  /** Rows `seedGroup` already created, so every count below is a delta rather than an absolute. */
  readonly baseline: { readonly labels: number; readonly readerSets: number };
}

/**
 * One more member in the seeded group.
 *
 * The generator needs at least two real members: `labels.owner_member_id` and
 * `reader_set_members.member_id` are foreign keys, so invented ids fail with
 * `SQLITE_CONSTRAINT_FOREIGNKEY` — which is the schema being right and the fixture being wrong.
 */
function seedMember(db: Database.Database, groupId: string, tag: string): MemberId {
  const suffix = `01j${tag}`.padEnd(26, '0').slice(0, 26);
  const personId = `prs_${suffix}`;
  const memberId = `mbr_${suffix}`;
  db.prepare(
    `INSERT INTO persons (id, display_name, display_name_source, created_at, updated_at)
     VALUES (?, 'Extra', 'platform', 0, 0)`,
  ).run(personId);
  db.prepare(
    `INSERT INTO members (id, group_id, person_id, role, age_band, handle, status, consent,
       joined_at, created_at, updated_at, version)
     VALUES (?, ?, ?, 'member', 'adult', ?, 'active', 'informed', 0, 0, 0, 1)`,
  ).run(memberId, groupId, personId, `h${tag}`);
  return memberId as MemberId;
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function withWorld<T>(fn: (world: World) => NotPromise<T>, tag = 'ls'): T {
  return withMigratedDb((db) => {
    const seeded = seedGroup(db, tag);
    const extra = seedMember(db, seeded.groupId, `${tag}x`);
    return fn({
      db,
      store: new SqliteStore({
        db,
        clock: new SystemClock(),
        logger: silent,
        ids: new TypeIdGenerator(new SystemClock()),
      }),
      labels: new LabelStore(db),
      groupId: seeded.groupId as GroupId,
      memberIds: [seeded.memberId as MemberId, extra],
      conversationId: seeded.conversationId,
      // `seedGroup` interns one reader set and one label of its own, so absolutes would be off by
      // one everywhere and the error would read as an interning bug.
      baseline: { labels: count(db, 'labels'), readerSets: count(db, 'reader_sets') },
    });
  });
}

function label(groupId: GroupId, readers: Audience, overrides: Partial<Label> = {}): Label {
  return {
    groupId,
    readers,
    owner: 'group',
    coOwners: [],
    sensitivity: 'normal',
    influence: 'none',
    untrusted: false,
    ...overrides,
  };
}

/** Every axis of a label, so the generator explores values that must not collapse together. */
function labelArbitrary(
  groupId: GroupId,
  seatId: string,
  members: readonly MemberId[],
): fc.Arbitrary<Label> {
  return fc
    .record({
      kind: fc.constantFrom('group' as const, 'members' as const),
      memberIds: fc.subarray([...members], { minLength: 0 }),
      seats: fc.subarray([seatId], { minLength: 0 }),
      owner: fc.constantFrom('group' as const, ...members),
      coOwners: fc.subarray([...members], { minLength: 0 }),
      sensitivity: fc.constantFrom('normal' as const, 'personal' as const, 'sensitive' as const),
      influence: fc.constantFrom('none' as const, 'constraints' as const),
      untrusted: fc.boolean(),
    })
    .map((parts) => {
      const readers: Audience =
        parts.kind === 'group'
          ? { kind: 'group', groupId, seats: parts.seats }
          : { kind: 'members', groupId, memberIds: parts.memberIds, seats: parts.seats };
      return label(groupId, readers, {
        owner: parts.owner,
        coOwners: parts.coOwners.filter((m) => m !== parts.owner),
        sensitivity: parts.sensitivity,
        influence: parts.influence,
        untrusted: parts.untrusted,
      });
    });
}

const temporaries: (() => void)[] = [];
afterEach(() => {
  for (const close of temporaries.splice(0)) close();
});

describe('labels.intern-idempotent.property', { tags: ['prop', 'db'] }, () => {
  /**
   * An independent canonical form of a label, computed from its fields.
   *
   * Deliberately **not** `labelCanonicalKey`: that function is the thing under test, and using it
   * to decide which values are "the same" would make the property agree with the implementation by
   * construction. This is the same information, serialised a different way.
   */
  function valueKey(value: Label): string {
    const readers =
      value.readers.kind === 'group'
        ? `group`
        : `members[${[...new Set(value.readers.memberIds)].toSorted().join(' ')}]`;
    const seats = [...new Set(value.readers.seats ?? [])].toSorted().join(' ');
    return [
      value.groupId,
      readers,
      `seats[${seats}]`,
      value.owner,
      `co[${[...new Set(value.coOwners)].toSorted().join(' ')}]`,
      value.sensitivity,
      value.influence,
      String(value.untrusted),
    ].join('/');
  }

  it('gives one id to one value and distinct ids to distinct values', () => {
    withWorld((world) => {
      const idByValue = new Map<string, number>();
      const valueById = new Map<number, string>();
      let interned = 0;

      fc.assert(
        fc.property(
          labelArbitrary(world.groupId, world.conversationId, world.memberIds),
          (value) => {
            const first = world.store.write((uow) => world.labels.intern(uow, value));
            const second = world.store.write((uow) => world.labels.intern(uow, value));
            // **Idempotent**: the second call finds the first row rather than inserting another.
            expect(second).toBe(first);
            interned += 1;

            const key = valueKey(value);
            // **Injective, both ways.** The second half is the one that matters most and the one a
            // naive version of this test misses: a canonical key that dropped a field would give two
            // *different* labels the same id, which mislabels data — the wrong audience becomes
            // eligible, and that is an I1 hole. Asserting only "same value, same id" passes happily
            // while that happens, because the collapsed pair is consistent with itself.
            const knownId = idByValue.get(key);
            if (knownId !== undefined) expect(first).toBe(knownId);
            const knownValue = valueById.get(first);
            if (knownValue !== undefined) {
              expect(knownValue, `label ${String(first)} stands for two different values`).toBe(
                key,
              );
            }
            idByValue.set(key, first);
            valueById.set(first, key);
          },
        ),
        fcConfig(),
      );

      // Non-vacuity: a generator that produced nothing would make every assertion above pass over
      // no values at all, and a generator producing one value would never test injectivity.
      expect(interned).toBeGreaterThan(20);
      expect(idByValue.size).toBeGreaterThan(3);
      // One id per distinct value and one value per distinct id, stated as a count so a collapse
      // is visible even if the per-iteration checks were reordered away.
      expect(valueById.size).toBe(idByValue.size);

      // And one row per distinct canonical key on disk, with no duplicates.
      const rows = world.db
        .prepare('SELECT count(*) AS n, count(DISTINCT canonical_key) AS k FROM labels')
        .get() as { n: number; k: number };
      expect(rows.n).toBe(rows.k);
      // A delta: `seedGroup` interned one label of its own before any of this ran.
      expect(rows.n - world.baseline.labels).toBe(idByValue.size);
    });
  });

  it('pins the stored shape of a canonical key, and the column it lands in', () => {
    // `labels.canonical_key` carries this string under a unique index, so the format is a stored
    // format: respelling it would make the new key miss every existing row, giving one value two
    // ids. That is the exact failure the property above exists to catch, arriving through a code
    // change instead of a bug. Pinned here so such a change cannot pass unnoticed — and if it is
    // ever deliberate, the migration that rewrites the column is what updates this expectation.
    withWorld((world) => {
      const [owner, other] = world.memberIds;
      if (owner === undefined || other === undefined) throw new Error('fixture needs two members');
      const value = label(
        world.groupId,
        { kind: 'members', groupId: world.groupId, memberIds: [other] },
        {
          owner,
          coOwners: [other],
          sensitivity: 'sensitive',
          influence: 'constraints',
          untrusted: true,
        },
      );

      const labelId = world.store.write((uow) => world.labels.intern(uow, value));
      const row = world.db
        .prepare('SELECT canonical_key AS key, owner_member_id AS owner FROM labels WHERE id = ?')
        .get(labelId) as { key: string; owner: string | null };

      // Field order and separator, exactly. The reader-set id leads because it is the part a
      // reader has to resolve to understand the rest.
      const [readerSetId, ...rest] = row.key.split('|');
      expect(Number(readerSetId)).toBeGreaterThan(0);
      expect(rest).toEqual([owner, other, 'sensitive', 'constraints', '1']);
      // And the function agrees with the column, which is the link that makes the format stored
      // rather than internal.
      expect(labelCanonicalKey(Number(readerSetId) as ReaderSetId, value)).toBe(row.key);
      expect(row.owner).toBe(owner);

      // A group-owned label spells the owner slot `'group'`, and leaves the column NULL.
      const owned = label(world.groupId, { kind: 'group', groupId: world.groupId });
      const ownedId = world.store.write((uow) => world.labels.intern(uow, owned));
      const ownedRow = world.db
        .prepare('SELECT canonical_key AS key, owner_member_id AS owner FROM labels WHERE id = ?')
        .get(ownedId) as { key: string; owner: string | null };
      expect(ownedRow.key.split('|').slice(1)).toEqual(['group', '', 'normal', 'none', '0']);
      expect(ownedRow.owner).toBeNull();
    });
  });

  it('separates two groups that intern the same value', () => {
    // Ids are per-group (`reader_sets_group_key_uq`, `labels_group_key_uq`), so the same label in
    // two groups is two rows. Sharing one would be an I4 hole: the eligibility filter would admit
    // a label interned by another group.
    withMigratedDb((db) => {
      const a = seedGroup(db, 'lsa');
      const b = seedGroup(db, 'lsb');
      const store = new SqliteStore({
        db,
        clock: new SystemClock(),
        logger: silent,
        ids: new TypeIdGenerator(new SystemClock()),
      });
      const labels = new LabelStore(db);

      const readersA: Audience = { kind: 'group', groupId: a.groupId as GroupId };
      const readersB: Audience = { kind: 'group', groupId: b.groupId as GroupId };
      const idA = store.write((uow) => labels.intern(uow, label(a.groupId as GroupId, readersA)));
      const idB = store.write((uow) => labels.intern(uow, label(b.groupId as GroupId, readersB)));

      expect(idA).not.toBe(idB);
      // Identical canonical keys, different groups — which is exactly what the unique index is on.
      expect(readerSetCanonicalKey(readersA)).toBe(readerSetCanonicalKey(readersB));
    });
  });

  it('caches nothing when the transaction rolls back', () => {
    // `02` §3.2's named hazard. A cache filled inside the transaction would map this value's key to
    // an id `AUTOINCREMENT` never reissues, so the next `intern` would hand out a `label_id` with
    // no `labels` row behind it — and `label_id IN (eligible)` then silently matches nothing.
    withWorld((world) => {
      const value = label(world.groupId, { kind: 'group', groupId: world.groupId });
      expect(world.labels.cacheSize.labels).toBe(0);

      expect(() =>
        world.store.write((uow) => {
          world.labels.intern(uow, value);
          throw new Error('the caller changed its mind');
        }),
      ).toThrow('changed its mind');

      // Nothing cached, and nothing on disk.
      expect(world.labels.cacheSize.labels).toBe(0);
      expect(count(world.db, 'labels')).toBe(world.baseline.labels);

      // And the next intern of the same value works, returning a real id rather than the one the
      // rolled-back insert consumed.
      const id = world.store.write((uow) => world.labels.intern(uow, value));
      expect(count(world.db, 'labels')).toBe(world.baseline.labels + 1);
      expect(world.labels.cached(id)).toEqual(value);
    }, 'lsr');
  });

  it('caches nothing when a transaction that interned the same value twice rolls back', () => {
    // The case the test above could not reach, and the one that mattered: interning **twice** in
    // one transaction. The first call inserts; the second finds the row the first inserted and
    // took the "already committed by someone, so caching it now is safe" fast path — which cached
    // an id that the rollback then took away. Every later write with that audience was refused by
    // the I4 trigger as `I4_LABEL_GROUP_MISMATCH`, for the life of the process: an
    // information-flow violation reported for a cache bug. Found by the M1 exit gate's reviewer.
    withWorld((world) => {
      const value = label(world.groupId, { kind: 'group', groupId: world.groupId });

      expect(() =>
        world.store.write((uow) => {
          const first = world.labels.intern(uow, value);
          const second = world.labels.intern(uow, value);
          // Same transaction, same value, same id — the staging has to serve the second call.
          expect(second).toBe(first);
          throw new Error('the caller changed its mind');
        }),
      ).toThrow('changed its mind');

      expect(world.labels.cacheSize.labels).toBe(0);
      expect(world.labels.cacheSize.readerSets).toBe(0);
      expect(count(world.db, 'labels')).toBe(world.baseline.labels);

      // And the id handed out next is one a row actually has: the proof is a labeled write, which
      // is what the I4 trigger refused before.
      const id = world.store.write((uow) => world.labels.intern(uow, value));
      const row = world.db.prepare('SELECT group_id FROM labels WHERE id = ?').get(id) as
        | { group_id: string }
        | undefined;
      expect(row?.group_id).toBe(world.groupId);
    }, 'lsr2');
  });

  it('fills the cache only after the commit, not during it', () => {
    // The rule stated directly: inside the transaction the cache must still be empty, because the
    // transaction may yet fail. Observed from inside `write`, which is the only place it is
    // visible.
    withWorld((world) => {
      const value = label(world.groupId, { kind: 'group', groupId: world.groupId });
      const duringTransaction = world.store.write((uow) => {
        world.labels.intern(uow, value);
        return world.labels.cacheSize.labels;
      });
      expect(duringTransaction).toBe(0);
      expect(world.labels.cacheSize.labels).toBe(1);
    }, 'lsc');
  });

  it('writes the members and seats the audience names', () => {
    withWorld((world) => {
      const readers: Audience = {
        kind: 'members',
        groupId: world.groupId,
        memberIds: [world.memberIds[0] as MemberId],
        seats: [world.conversationId],
      };
      const id = world.store.write((uow) =>
        world.labels.intern(uow, label(world.groupId, readers)),
      );

      const setId = (
        world.db.prepare('SELECT reader_set_id AS id FROM labels WHERE id = ?').get(id) as {
          id: number;
        }
      ).id;
      expect(
        world.db
          .prepare('SELECT member_id FROM reader_set_members WHERE reader_set_id = ?')
          .all(setId),
      ).toEqual([{ member_id: world.memberIds[0] }]);
      expect(
        world.db
          .prepare('SELECT conversation_id FROM reader_set_seats WHERE reader_set_id = ?')
          .all(setId),
      ).toEqual([{ conversation_id: world.conversationId }]);
      // `member_count` is what `reader_sets_group_kind_ck` is checked against.
      expect(
        world.db.prepare('SELECT member_count AS n FROM reader_sets WHERE id = ?').get(setId),
      ).toEqual({ n: 1 });
    }, 'lsm');
  });

  it('reuses one reader set across labels that differ only above it', () => {
    // The reason reader sets are interned separately: a group's labels are reader sets × a small
    // product of sensitivities, so sharing the set is most of what keeps the count near `02`
    // §3.2's "realistically ≤ 500".
    withWorld((world) => {
      const readers: Audience = { kind: 'group', groupId: world.groupId };
      const ids = world.store.write((uow) => [
        world.labels.intern(uow, label(world.groupId, readers)),
        world.labels.intern(uow, label(world.groupId, readers, { sensitivity: 'sensitive' })),
        world.labels.intern(uow, label(world.groupId, readers, { untrusted: true })),
      ]);
      expect(new Set(ids).size).toBe(3);
      expect(count(world.db, 'reader_sets') - world.baseline.readerSets).toBe(1);
    }, 'lss');
  });

  it('is order-insensitive in every list it canonicalises', () => {
    // Two spellings of one value must intern once. The sorting is in three places — member ids,
    // seats and co-owners — and a missed one would show up here as two rows.
    withWorld((world) => {
      const [first, second] = world.memberIds;
      if (first === undefined || second === undefined) throw new Error('need two members');
      const forward: Audience = {
        kind: 'members',
        groupId: world.groupId,
        memberIds: [first, second],
      };
      const reversed: Audience = {
        kind: 'members',
        groupId: world.groupId,
        memberIds: [second, first, second],
      };
      const ids = world.store.write((uow) => [
        world.labels.intern(uow, label(world.groupId, forward, { coOwners: [first, second] })),
        world.labels.intern(uow, label(world.groupId, reversed, { coOwners: [second, first] })),
      ]);
      expect(ids[0]).toBe(ids[1]);
      expect(audienceKey(forward)).toBe(audienceKey(reversed));
    }, 'lso');
  });

  it('re-derives the same ids from the database after forgetting its caches', () => {
    // `forget` exists for `maintenance.labels_gc`, which deletes rows underneath a live store. The
    // property that makes it safe is that the caches are **caches**: dropping them must change
    // nothing observable while the rows are still there. If interning drifted to treating its map
    // as the source of truth — assigning a fresh id rather than re-reading — a GC run would split
    // one value across two ids, which is the same I1 hole the property above guards.
    withWorld((world) => {
      const [owner, other] = world.memberIds;
      if (owner === undefined || other === undefined) throw new Error('fixture needs two members');
      const values = [
        label(world.groupId, { kind: 'group', groupId: world.groupId }),
        label(
          world.groupId,
          { kind: 'members', groupId: world.groupId, memberIds: [other] },
          {
            owner,
            sensitivity: 'personal',
          },
        ),
        label(
          world.groupId,
          { kind: 'group', groupId: world.groupId, seats: [world.conversationId] },
          { untrusted: true },
        ),
      ];

      const before = values.map((value) =>
        world.store.write((uow) => world.labels.intern(uow, value)),
      );
      const rowsBefore = count(world.db, 'labels');

      world.labels.forget();

      const after = values.map((value) =>
        world.store.write((uow) => world.labels.intern(uow, value)),
      );
      expect(after).toEqual(before);
      // And no new rows: every lookup went to the `SELECT` path and found what was already there.
      expect(count(world.db, 'labels')).toBe(rowsBefore);
    });
  });

  it('reports an insert that returns no row as a bug, not as a success', () => {
    // `INSERT … RETURNING id` always yields a row when it succeeds, so this branch is unreachable
    // through SQLite — which is exactly why it needs a test: the alternative to the guard is
    // `undefined.id` throwing a `TypeError` with no code, no hint and nothing a host could act on.
    // A hand-written driver double is the only way to reach it, and `02` §3.7.1's token is the
    // only thing `intern` needs besides the handle.
    const uow = { now: Temporal.Instant.from('2026-11-08T00:00:00Z'), afterCommit: () => {} };
    const groupId = 'grp_01jls000000000000000000000' as GroupId;
    const value = label(groupId, { kind: 'group', groupId });

    for (const emptyOn of ['reader_sets', 'labels'] as const) {
      // `reader_sets` is interned first, so a double that starves only `labels` has to answer the
      // reader-set insert honestly. Both guards get their own case rather than one shared double,
      // because a single stub returning `undefined` for everything would only ever reach the first.
      let nextId = 0;
      const db = {
        prepare: (sql: string) => ({
          get: (..._args: unknown[]) => {
            if (sql.startsWith('SELECT')) return undefined;
            if (sql.includes(`INSERT INTO ${emptyOn}`)) return undefined;
            nextId += 1;
            return { id: nextId };
          },
          run: () => ({ changes: 1 }),
        }),
      } as unknown as Database.Database;

      let caught: unknown;
      try {
        new LabelStore(db).intern(uow, value);
      } catch (error) {
        caught = error;
      }
      expect(caught, emptyOn).toBeInstanceOf(StorageError);
      const storageError = caught as StorageError;
      expect(storageError.storageCode, emptyOn).toBe('STORAGE_IO');
      // The *subject*, not just the shared suffix: `reader set` and `label` are different guards,
      // and an assertion both messages satisfy would pass even if only one were ever reached.
      expect(storageError.message, emptyOn).toBe(
        emptyOn === 'labels'
          ? 'interning a label returned no id'
          : 'interning a reader set returned no id',
      );
      expect(storageError.hint, emptyOn).toContain('RETURNING id');
    }
  });

  it('counts labels per group, for the gauge and the strategy switch', () => {
    withWorld((world) => {
      const before = world.labels.countFor(world.groupId);
      world.store.write((uow) =>
        world.labels.intern(uow, label(world.groupId, { kind: 'group', groupId: world.groupId })),
      );
      expect(world.labels.countFor(world.groupId)).toBe(before + 1);
    }, 'lsn');
  });
});
