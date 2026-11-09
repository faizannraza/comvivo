/**
 * The entity, alias and subject channels, and the embedding write path (`M1-T18`).
 *
 * `memory_entities`, `memory_entity_aliases` and `memory_item_entities` have **no repository yet**
 * — `04`'s entity resolution is a later task — so these rows are seeded with raw SQL. That is the
 * right call here rather than a shortcut: the port's job is to *query* those tables, and inventing
 * a repository to write them would be guessing at an interface `04` will specify.
 *
 * The alias channel carries the subtlest `I1` point in this subsystem, and it gets its own test:
 * the label filter is on the **alias**, not on the entity. An alias is a name someone used, so
 * knowing it is knowing something about the conversation it came from — filtering on the entity
 * would leak a nickname learned in a private exchange to the whole group.
 */
import { expectWritten } from '@comvivo/core';
import { StorageError } from '@comvivo/shared';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import {
  entityId,
  fingerprintFor,
  groupLabel,
  memoryId,
  memoryItem,
  withRepos,
} from '../repos/testing/harness.js';

/** An eligible set over interned label ids, shaped as the port expects one. */
function eligibleOf(groupId: string, ids: readonly number[]): never {
  return {
    groupId,
    ids: [...new Set(ids)].toSorted((left, right) => left - right),
    audienceKey: 'g|s:',
    epoch: '0:0',
  } as unknown as never;
}

/** A unit vector of the given dimension, so `putEmbedding`'s normalisation check passes. */
function unit(dims: number): Float32Array {
  const vector = new Float32Array(dims);
  vector[0] = 1;
  return vector;
}

describe('the entity and alias channels (04 §3.6.3)', { tags: ['db'] }, () => {
  it('finds memories linked to an entity, newest validity first', () => {
    withRepos((world) => {
      const label = groupLabel(world.groupId);
      const items = world.store.write((uow) =>
        [
          { tag: 'p1f', validFrom: Temporal.Instant.from('2026-03-01T00:00:00Z') },
          { tag: 'p2f', validFrom: Temporal.Instant.from('2026-06-01T00:00:00Z') },
        ].map((spec) =>
          expectWritten(
            world.repos.memories.insert(
              uow,
              memoryItem(spec.tag, world.groupId, {
                id: memoryId(spec.tag),
                validFrom: spec.validFrom,
              }),
              label,
              fingerprintFor(spec.tag),
            ),
            `memory ${spec.tag}`,
          ),
        ),
      );
      const entity = entityId('e1f');
      world.db
        .prepare(
          `INSERT INTO memory_entities (id, group_id, entity_type, possible_same_as, created_at)
           VALUES (?, ?, 'person', '[]', 0)`,
        )
        .run(entity, world.groupId);
      for (const item of items) {
        world.db
          .prepare('INSERT INTO memory_item_entities (memory_rid, entity_id) VALUES (?, ?)')
          .run(item.rid, entity);
      }

      const hits = world.repos.memorySearch.byEntities({
        groupId: world.groupId,
        entityIds: [entity],
        limit: 10,
        maxState: 1,
        eligible: eligibleOf(
          world.groupId,
          items.map((item) => item.labelId),
        ),
      });
      // `04` §3.6.3 orders this channel by `valid_from DESC`, so the `limit` keeps the most recent.
      expect(hits.map((hit) => hit.ref)).toEqual([memoryId('p2f'), memoryId('p1f')]);
      // No score of its own — an entity either matches or it does not — so `04`'s fusion weights
      // the channel rather than the rows within it.
      expect(hits.every((hit) => hit.distance === 0)).toBe(true);
    });
  });

  it('returns nothing for an empty entity list, rather than everything', () => {
    withRepos((world) => {
      const item = world.store.write((uow) =>
        expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('p3f', world.groupId),
            groupLabel(world.groupId),
            fingerprintFor('p3f'),
          ),
          'a memory',
        ),
      );
      // An `IN ()` with no values is the same hazard as the empty eligible set: rendered wrongly
      // it becomes a tautology, and this channel would return every memory in the group.
      expect(
        world.repos.memorySearch.byEntities({
          groupId: world.groupId,
          entityIds: [],
          limit: 10,
          maxState: 1,
          eligible: eligibleOf(world.groupId, [item.labelId]),
        }),
      ).toEqual([]);
    });
  });

  it('filters aliases by the label of the item that introduced them', () => {
    withRepos((world) => {
      const openLabel = groupLabel(world.groupId);
      const privateLabel = groupLabel(world.groupId, { sensitivity: 'sensitive' });
      const [open, hidden] = world.store.write((uow) => [
        expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('q1f', world.groupId),
            openLabel,
            fingerprintFor('q1f'),
          ),
          'an open item',
        ),
        expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('q2f', world.groupId, { id: memoryId('q2f') }),
            privateLabel,
            fingerprintFor('q2f'),
          ),
          'a private item',
        ),
      ]);
      const entity = entityId('e2f');
      world.db
        .prepare(
          `INSERT INTO memory_entities (id, group_id, entity_type, possible_same_as, created_at)
           VALUES (?, ?, 'person', '[]', 0)`,
        )
        .run(entity, world.groupId);
      // The same entity, two aliases, introduced under two different labels — which is exactly the
      // situation the per-alias label exists for: one group chat learned "Sam", one private
      // exchange learned a nickname.
      for (const [alias, labelId] of [
        ['sam', open.labelId],
        ['sammy', hidden.labelId],
      ] as const) {
        world.db
          .prepare(
            `INSERT INTO memory_entity_aliases (entity_id, group_id, alias_norm, alias_display, label_id)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(entity, world.groupId, alias, alias, labelId);
      }

      const openOnly = world.repos.memorySearch.aliases({
        groupId: world.groupId,
        aliasNorms: ['sam', 'sammy'],
        eligible: eligibleOf(world.groupId, [open.labelId]),
      });
      // Only the alias whose *introducing label* is eligible. Filtering on the entity instead
      // would leak the nickname to the whole group.
      expect(openOnly.map((match) => match.aliasNorm)).toEqual(['sam']);

      const both = world.repos.memorySearch.aliases({
        groupId: world.groupId,
        aliasNorms: ['sam', 'sammy'],
        eligible: eligibleOf(world.groupId, [open.labelId, hidden.labelId]),
      });
      expect(both.map((match) => match.aliasNorm).toSorted()).toEqual(['sam', 'sammy']);
      expect(both.every((match) => match.entityId === entity)).toBe(true);
    });
  });

  it('keeps aliases group-scoped', () => {
    withRepos((world) => {
      const item = world.store.write((uow) =>
        expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('q3f', world.otherGroupId, { groupId: world.otherGroupId }),
            groupLabel(world.otherGroupId),
            fingerprintFor('q3f'),
          ),
          'a memory elsewhere',
        ),
      );
      const entity = entityId('e3f');
      world.db
        .prepare(
          `INSERT INTO memory_entities (id, group_id, entity_type, possible_same_as, created_at)
           VALUES (?, ?, 'person', '[]', 0)`,
        )
        .run(entity, world.otherGroupId);
      world.db
        .prepare(
          `INSERT INTO memory_entity_aliases (entity_id, group_id, alias_norm, alias_display, label_id)
           VALUES (?, ?, 'sam', 'Sam', ?)`,
        )
        .run(entity, world.otherGroupId, item.labelId);
      expect(
        world.repos.memorySearch.aliases({
          groupId: world.groupId,
          aliasNorms: ['sam'],
          eligible: eligibleOf(world.groupId, [item.labelId]),
        }),
      ).toEqual([]);
    });
  });

  it('finds memories by subject, hydrated in the order the channel ranked them', () => {
    withRepos((world) => {
      const label = groupLabel(world.groupId);
      const items = world.store.write((uow) =>
        [
          { tag: 'r1f', validFrom: Temporal.Instant.from('2026-03-01T00:00:00Z') },
          { tag: 'r2f', validFrom: Temporal.Instant.from('2026-06-01T00:00:00Z') },
        ].map((spec) =>
          expectWritten(
            world.repos.memories.insert(
              uow,
              memoryItem(spec.tag, world.groupId, {
                id: memoryId(spec.tag),
                validFrom: spec.validFrom,
                subjects: [{ ref: 'group', role: 'about' }],
              }),
              label,
              fingerprintFor(spec.tag),
            ),
            `memory ${spec.tag}`,
          ),
        ),
      );
      const found = world.repos.memorySearch.bySubjects({
        groupId: world.groupId,
        subjectRefs: [{ type: 'group' }],
        limit: 10,
        maxState: 1,
        eligible: eligibleOf(
          world.groupId,
          items.map((item) => item.labelId),
        ),
      });
      // `IN` does not preserve order, so the hydration re-sorts into the order the channel
      // decided — newest validity first.
      expect(found.map((item) => item.id)).toEqual([memoryId('r2f'), memoryId('r1f')]);
    });
  });
});

describe('putEmbedding (02 §3.5)', { tags: ['db'] }, () => {
  it('writes the vector and marks the item done', () => {
    withRepos((world) => {
      world.store.write((uow) =>
        world.repos.embeddingSpaces.ensure(uow, { provider: 'test', model: 'dim4', dims: 4 }),
      );
      const item = world.store.write((uow) =>
        expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('s1f', world.groupId),
            groupLabel(world.groupId),
            fingerprintFor('s1f'),
          ),
          'a memory',
        ),
      );
      const stored = world.store.write((uow) =>
        expectWritten(
          world.repos.memories.putEmbedding(uow, world.groupId, item.id, item.labelId, unit(4)),
          'an embedding',
        ),
      );
      expect(stored.embeddingState).toBe('done');
      expect(world.repos.memories.embeddingBacklog(world.groupId, 10)).toHaveLength(0);
    });
  });

  it('is retryable, because the embed job can run twice', () => {
    withRepos((world) => {
      world.store.write((uow) =>
        world.repos.embeddingSpaces.ensure(uow, { provider: 'test', model: 'dim4', dims: 4 }),
      );
      const item = world.store.write((uow) =>
        expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('s2f', world.groupId),
            groupLabel(world.groupId),
            fingerprintFor('s2f'),
          ),
          'a memory',
        ),
      );
      world.store.write((uow) =>
        world.repos.memories.putEmbedding(uow, world.groupId, item.id, item.labelId, unit(4)),
      );
      // vec0 has no upsert, so the second write deletes first. Without that, a retried job would
      // fail on the rowid and the item would stay `pending` forever.
      expect(() =>
        world.store.write((uow) =>
          world.repos.memories.putEmbedding(uow, world.groupId, item.id, item.labelId, unit(4)),
        ),
      ).not.toThrow();
      expect(
        world.db.prepare('SELECT count(*) AS n FROM vec_memory_test_dim4').get() as { n: number },
      ).toEqual({ n: 1 });
    });
  });

  it('refuses when the label moved under the job', () => {
    withRepos((world) => {
      world.store.write((uow) =>
        world.repos.embeddingSpaces.ensure(uow, { provider: 'test', model: 'dim4', dims: 4 }),
      );
      const item = world.store.write((uow) =>
        expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('s3f', world.groupId),
            groupLabel(world.groupId),
            fingerprintFor('s3f'),
          ),
          'a memory',
        ),
      );
      // The re-check `02` §3.5 asks for. The job embedded outside a transaction, and a relabel
      // landed in between — so the vector is still right and the metadata it computed is not. A
      // vec row with a stale `label_id` is an `I1` leak until something notices.
      const stale = world.store.write((uow) =>
        world.repos.memories.putEmbedding(uow, world.groupId, item.id, item.labelId + 1, unit(4)),
      );
      expect(stale.kind).toBe('conflict');
    });
  });

  it('refuses a retracted item', () => {
    withRepos((world) => {
      world.store.write((uow) =>
        world.repos.embeddingSpaces.ensure(uow, { provider: 'test', model: 'dim4', dims: 4 }),
      );
      const item = world.store.write((uow) =>
        expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('s4f', world.groupId),
            groupLabel(world.groupId),
            fingerprintFor('s4f'),
          ),
          'a memory',
        ),
      );
      world.store.write((uow) =>
        world.repos.memories.forget(
          uow,
          world.groupId,
          item.id,
          'forgotten',
          Temporal.Instant.from('2026-11-08T12:00:00Z'),
        ),
      );
      const refused = world.store.write((uow) =>
        world.repos.memories.putEmbedding(uow, world.groupId, item.id, item.labelId, unit(4)),
      );
      // Embedding a forgotten memory would put it back in the vector index — a forget that did not
      // forget, arriving through a job rather than through a read.
      expect(refused.kind).toBe('conflict');
    });
  });

  it('refuses a dimension mismatch and a non-unit vector, with hints', () => {
    withRepos((world) => {
      world.store.write((uow) =>
        world.repos.embeddingSpaces.ensure(uow, { provider: 'test', model: 'dim4', dims: 4 }),
      );
      const item = world.store.write((uow) =>
        expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('s5f', world.groupId),
            groupLabel(world.groupId),
            fingerprintFor('s5f'),
          ),
          'a memory',
        ),
      );
      let caught: unknown;
      try {
        world.store.write((uow) =>
          world.repos.memories.putEmbedding(uow, world.groupId, item.id, item.labelId, unit(8)),
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StorageError);
      // Checked here rather than left to sqlite-vec, whose error is about a blob length and says
      // nothing about the configuration that caused it (`04` F17).
      expect((caught as StorageError).message).toContain('8 dimensions');
      expect((caught as StorageError).hint).toContain('re-embed migration');

      const notUnit = new Float32Array([2, 0, 0, 0]);
      let second: unknown;
      try {
        world.store.write((uow) =>
          world.repos.memories.putEmbedding(uow, world.groupId, item.id, item.labelId, notUnit),
        );
      } catch (error) {
        second = error;
      }
      expect(second).toBeInstanceOf(StorageError);
      // `02` §3.5 stores unit vectors so the default L2 metric ranks the same as cosine. A
      // non-unit vector changes the ranking with no error at all, which is why this is checked.
      expect((second as StorageError).message).toContain('not unit-normalised');
    });
  });

  it('is a no-op with no active space, leaving the item pending', () => {
    withRepos((world) => {
      const item = world.store.write((uow) =>
        expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('s6f', world.groupId),
            groupLabel(world.groupId),
            fingerprintFor('s6f'),
          ),
          'a memory',
        ),
      );
      const result = world.store.write((uow) =>
        world.repos.memories.putEmbedding(uow, world.groupId, item.id, item.labelId, unit(4)),
      );
      // `ok`, not a refusal: nothing is wrong, there is simply nowhere to put it yet. The item
      // stays `pending` so the job picks it up once a space exists.
      expect(result.kind).toBe('ok');
      expect(world.repos.memories.embeddingBacklog(world.groupId, 10)).toHaveLength(1);
    });
  });

  it('reports a missing item as not_found', () => {
    withRepos((world) => {
      const missing = world.store.write((uow) =>
        world.repos.memories.putEmbedding(uow, world.groupId, memoryId('zzf'), 1, unit(4)),
      );
      expect(missing.kind).toBe('not_found');
    });
  });
});

describe('setEmbeddingState', { tags: ['db'] }, () => {
  it('moves the state without a version, because the job owns the column', () => {
    withRepos((world) => {
      const item = world.store.write((uow) =>
        expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('t1f', world.groupId),
            groupLabel(world.groupId),
            fingerprintFor('t1f'),
          ),
          'a memory',
        ),
      );
      const failed = world.store.write((uow) =>
        expectWritten(
          world.repos.memories.setEmbeddingState(uow, world.groupId, item.id, 'failed'),
          'a failed embedding',
        ),
      );
      expect(failed.embeddingState).toBe('failed');
      // Unversioned: making it conflict with a concurrent lifecycle change would fail an embedding
      // for a reason the job cannot act on.
      expect(failed.version).toBe(item.version);
      // And `failed` leaves the backlog, so a model error does not make the job spin.
      expect(world.repos.memories.embeddingBacklog(world.groupId, 10)).toHaveLength(0);
    });
  });

  it('reports a missing item as not_found', () => {
    withRepos((world) => {
      expect(
        world.store.write((uow) =>
          world.repos.memories.setEmbeddingState(uow, world.groupId, memoryId('zzf'), 'done'),
        ).kind,
      ).toBe('not_found');
    });
  });
});
