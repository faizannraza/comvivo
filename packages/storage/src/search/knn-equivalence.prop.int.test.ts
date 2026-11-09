/**
 * `vec.knn-equivalence.property` (`M1-T18`; `02` §3.5, `04` R5).
 *
 * ## What this proves
 *
 * sqlite-vec builds a per-chunk bitmap from the metadata constraints and computes distances only
 * for the set bits (`04` §3.6.3, verified in the v0.1.9 source). That is an *optimisation*, and an
 * optimisation that drops the wrong bits returns a plausible answer: a shorter list, in the right
 * order, missing the nearest match. Nothing about the result says it is incomplete.
 *
 * So the property compares the index against **brute force**: the same L2 distance computed in
 * TypeScript over the same vectors, filtered by the same predicates. If the index and the loop
 * disagree about the top-k, the index is wrong.
 *
 * The oracle is deliberately a different implementation, not a second call to the index — and not
 * `1 − d²/2` either, because `02` §3.5 exposes *that* as the similarity for `04` while the ranking
 * is the raw L2. Comparing against the quantity the index actually orders by is what makes a
 * disagreement meaningful.
 */
import { expectWritten, type Label } from '@comvivo/core';
import { fcConfig } from '@comvivo/shared/testing';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  fingerprintFor,
  groupLabel,
  member,
  memoryId,
  memoryItem,
  person,
  T0,
  withRepos,
} from '../repos/testing/harness.js';

/** Small enough to keep the test quick, large enough that chunking matters (`chunk_size` is 256). */
const DIMS = 8;
const ITEMS = 40;

/** A deterministic unit vector, so a failure is reproducible from the seed alone. */
function unitVector(seed: number): Float32Array {
  const values = new Float32Array(DIMS);
  // A simple LCG rather than `Math.random`: `01` §4 injects randomness, and a test that cannot be
  // replayed from its printed counterexample is a test that cannot be debugged.
  let state = (seed * 1_103_515_245 + 12_345) % 2_147_483_647;
  for (let index = 0; index < DIMS; index += 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_647;
    values[index] = state / 2_147_483_647 - 0.5;
  }
  let norm = 0;
  for (const value of values) norm += value * value;
  const length = Math.sqrt(norm);
  for (let index = 0; index < DIMS; index += 1) {
    values[index] = (values[index] ?? 0) / length;
  }
  return values;
}

/** The quantity vec0 orders by: squared-then-rooted L2, matching its default metric. */
function l2(left: Float32Array, right: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}

describe('vec.knn-equivalence.property', { tags: ['prop', 'db'] }, () => {
  it('returns the same top-k as a brute-force scan, under every filter combination', () => {
    withRepos((world) => {
      // One space, created the way configuration loading creates it.
      const space = world.store.write((uow) =>
        world.repos.embeddingSpaces.ensure(uow, {
          provider: 'test',
          model: 'unit8',
          dims: DIMS,
        }),
      );
      expect(space.status).toBe('active');

      world.store.write((uow) => {
        expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
        expectWritten(world.repos.members.add(uow, member('a', world.groupId)), 'member a');
      });

      // Two labels, so the eligible-set filter has something to exclude. Both group-readable, so
      // eligibility is a property of the *label id* here and not of `canRead` — which is the other
      // property's subject, not this one's.
      const labels: readonly Label[] = [
        groupLabel(world.groupId),
        groupLabel(world.groupId, { sensitivity: 'sensitive' }),
      ];

      const written = world.store.write((uow) =>
        Array.from({ length: ITEMS }, (_unused, index) => {
          const tag = `v${index.toString(16)}f`;
          const label = labels[index % labels.length] as Label;
          const item = expectWritten(
            world.repos.memories.insert(
              uow,
              memoryItem(tag, world.groupId, {
                id: memoryId(tag),
                // Three of the four retrieval states, so `state <= maxState` has work to do.
                status: index % 5 === 0 ? 'proposed' : 'active',
                kind: index % 3 === 0 ? 'note' : 'fact',
              }),
              label,
              fingerprintFor(tag),
            ),
            `memory ${tag}`,
          );
          const vector = unitVector(index + 1);
          expectWritten(
            world.repos.memories.putEmbedding(uow, world.groupId, item.id, item.labelId, vector),
            `embedding ${tag}`,
          );
          return { item, vector, label };
        }),
      );

      // Every item is embedded, so nothing below is vacuous for lack of vectors.
      expect(world.repos.memories.embeddingBacklog(world.groupId, 100)).toHaveLength(0);

      let compared = 0;
      let nonEmpty = 0;

      fc.assert(
        fc.property(
          fc.record({
            seed: fc.integer({ min: 1, max: 10_000 }),
            k: fc.integer({ min: 1, max: 12 }),
            maxState: fc.constantFrom(0 as const, 1 as const, 2 as const, 3 as const),
            labelIndex: fc.constantFrom(0, 1, 2),
            kinds: fc.subarray(['fact' as const, 'note' as const], { minLength: 0 }),
          }),
          (query) => {
            const eligibleLabelIds =
              query.labelIndex === 2
                ? written.map((row) => row.item.labelId)
                : written
                    .filter((row) => row.label === labels[query.labelIndex])
                    .map((row) => row.item.labelId);
            const eligible = {
              groupId: world.groupId,
              ids: [...new Set(eligibleLabelIds)].toSorted((left, right) => left - right),
              audienceKey: 'g|s:',
              epoch: '0:0',
            } as unknown as Parameters<typeof world.repos.memorySearch.vector>[0]['eligible'];

            const probe = unitVector(query.seed + 100_000);
            const fromIndex = world.repos.memorySearch.vector({
              groupId: world.groupId,
              vector: probe,
              k: query.k,
              maxState: query.maxState,
              validAt: null,
              eligible,
              ...(query.kinds.length === 0 ? {} : { kinds: query.kinds }),
            });

            // Brute force: the same filters, the same distance, computed here.
            const eligibleSet = new Set(eligible.ids);
            const expected = written
              .filter((row) => eligibleSet.has(row.item.labelId))
              .filter((row) => row.item.retrievalState <= query.maxState)
              .filter(
                (row) =>
                  query.kinds.length === 0 ||
                  query.kinds.includes(row.item.kind as 'fact' | 'note'),
              )
              .map((row) => ({ id: row.item.id, distance: l2(probe, row.vector) }))
              .toSorted((left, right) => left.distance - right.distance)
              .slice(0, query.k);

            expect(fromIndex.map((hit) => hit.ref)).toEqual(expected.map((hit) => hit.id));
            // And the distances agree, to float32 precision — which is what proves the index is
            // computing the metric the oracle thinks it is, rather than a different one that
            // happens to order the same way for these vectors.
            for (const [index, hit] of fromIndex.entries()) {
              expect(hit.distance).toBeCloseTo(expected[index]?.distance ?? Number.NaN, 4);
            }

            compared += 1;
            if (fromIndex.length > 0) nonEmpty += 1;
          },
        ),
        fcConfig(),
      );

      // Non-vacuity: a generator that only produced empty results would satisfy every assertion
      // above over empty arrays.
      expect(compared).toBeGreaterThan(20);
      expect(nonEmpty).toBeGreaterThan(compared / 2);
    });
  });

  it('drops a retracted item from the index, and does not bring it back', () => {
    withRepos((world) => {
      world.store.write((uow) =>
        world.repos.embeddingSpaces.ensure(uow, { provider: 'test', model: 'unit8', dims: DIMS }),
      );
      const label = groupLabel(world.groupId);
      const item = world.store.write((uow) => {
        const written = expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('r1f', world.groupId),
            label,
            fingerprintFor('r1f'),
          ),
          'a memory',
        );
        expectWritten(
          world.repos.memories.putEmbedding(
            uow,
            world.groupId,
            written.id,
            written.labelId,
            unitVector(7),
          ),
          'its embedding',
        );
        return written;
      });

      const eligible = {
        groupId: world.groupId,
        ids: [item.labelId],
        audienceKey: 'g|s:',
        epoch: '0:0',
      } as unknown as Parameters<typeof world.repos.memorySearch.vector>[0]['eligible'];
      const probe = unitVector(7);
      expect(
        world.repos.memorySearch.vector({
          groupId: world.groupId,
          vector: probe,
          k: 5,
          maxState: 3,
          validAt: null,
          eligible,
        }),
      ).toHaveLength(1);

      world.store.write((uow) =>
        world.repos.memories.forget(uow, world.groupId, item.id, 'forgotten', T0),
      );

      // `04` R5: a retracted item is **removed** from both indexes. The trigger takes the vec row
      // out on the status change, and `#restoreVector` must not put it back — which is the one
      // direction the re-embed dance must never go, because a forgotten memory reappearing in
      // vector search is a forget that did not forget.
      expect(
        world.repos.memorySearch.vector({
          groupId: world.groupId,
          vector: probe,
          k: 5,
          maxState: 3,
          validAt: null,
          eligible,
        }),
      ).toHaveLength(0);
    });
  });

  it('carries the vector across a label change rather than re-embedding', () => {
    withRepos((world) => {
      world.store.write((uow) =>
        world.repos.embeddingSpaces.ensure(uow, { provider: 'test', model: 'unit8', dims: DIMS }),
      );
      const wide = groupLabel(world.groupId);
      const narrow = groupLabel(world.groupId, { sensitivity: 'sensitive' });
      const item = world.store.write((uow) => {
        const written = expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('n1f', world.groupId),
            wide,
            fingerprintFor('n1f'),
          ),
          'a memory',
        );
        expectWritten(
          world.repos.memories.putEmbedding(
            uow,
            world.groupId,
            written.id,
            written.labelId,
            unitVector(11),
          ),
          'its embedding',
        );
        return written;
      });

      const narrowed = world.store.write((uow) =>
        expectWritten(
          world.repos.memories.narrowLabel(uow, world.groupId, item.id, item.version, narrow),
          'a narrowing',
        ),
      );
      expect(narrowed.labelId).not.toBe(item.labelId);
      // Still `done`, not back to `pending`: `02` §3.5 says the re-point "costs a lookup, not a
      // re-embed", and an item that fell back to `pending` would be re-embedded by the job —
      // paying for a model call to recompute a vector it already had.
      expect(narrowed.embeddingState).toBe('done');

      // And it is findable under the **new** label id, which is what proves the metadata moved
      // with it rather than the row merely surviving.
      const eligibleNew = {
        groupId: world.groupId,
        ids: [narrowed.labelId],
        audienceKey: 'g|s:',
        epoch: '0:0',
      } as unknown as Parameters<typeof world.repos.memorySearch.vector>[0]['eligible'];
      expect(
        world.repos.memorySearch.vector({
          groupId: world.groupId,
          vector: unitVector(11),
          k: 5,
          maxState: 3,
          validAt: null,
          eligible: eligibleNew,
        }),
      ).toHaveLength(1);
      // Not under the old one.
      const eligibleOld = {
        groupId: world.groupId,
        ids: [item.labelId],
        audienceKey: 'g|s:',
        epoch: '0:0',
      } as unknown as Parameters<typeof world.repos.memorySearch.vector>[0]['eligible'];
      expect(
        world.repos.memorySearch.vector({
          groupId: world.groupId,
          vector: unitVector(11),
          k: 5,
          maxState: 3,
          validAt: null,
          eligible: eligibleOld,
        }),
      ).toHaveLength(0);
    });
  });
});
