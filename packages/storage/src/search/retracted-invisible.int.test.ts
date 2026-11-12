import { expectWritten } from '@comvivo/core';
import { describe, expect, it } from 'vitest';
import {
  eligibleOnly,
  fingerprintFor,
  groupLabel,
  memoryId,
  memoryItem,
  T0,
  withRepos,
} from '../repos/testing/harness.js';

/**
 * A retracted memory must never be retrievable (`04` R5, R9).
 *
 * A regression test for a bug this task shipped and then found. `04` R5 says a retracted item is
 * "**removed** from both indexes", and the FTS and vec0 triggers do that — but the **base-table**
 * reads are not indexes and no trigger covers them. `recent`, `bySubjects`, `byEntities` and
 * `hydrate` query `memory_items` directly with `retrieval_state <= :maxState` and, as first
 * written, no status predicate. So:
 *
 *  - `forget` wrote `retrieval_state = 3`, and `recent({ maxState: 3 })` returned the item;
 *  - `setStatus(…, 'retracted')` derived `retrieval_state = 0` — because `retrievalStateFor` fell
 *    through to `activeCurrent` for a status it documented as never reaching it — and
 *    `recent({ maxState: 1 })` returned the item **as current**.
 *
 * Either way a forgotten memory kept answering questions, which is the one thing `04` R9 exists to
 * prevent. Both layers are fixed: the status predicate on every base-table read, and `history` as
 * the derived state for a retracted item. This test covers every `maxState`, because the first
 * version of the bug only showed at `3` and the second only at `0` — a test fixed to one ceiling
 * would have found one of them.
 */
describe('a retracted memory is never retrievable (04 R5, R9)', () => {
  it('does not appear in recent() after forget', () => {
    withRepos((world) => {
      const item = world.store.write((uow) =>
        expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('q1f', world.groupId, { statement: 'something private' }),
            groupLabel(world.groupId),
            fingerprintFor('q1f'),
          ),
          'a memory',
        ),
      );
      const eligible = eligibleOnly(world, [item.labelId]);
      world.store.write((uow) =>
        world.repos.memories.forget(uow, world.groupId, item.id, 'forgotten', T0),
      );
      for (const maxState of [0, 1, 2, 3] as const) {
        expect(
          world.repos.memorySearch.recent({
            groupId: world.groupId,
            limit: 10,
            maxState,
            eligible,
          }),
          `recent at maxState ${String(maxState)}`,
        ).toEqual([]);
        expect(
          world.repos.memorySearch.bySubjects({
            groupId: world.groupId,
            subjectRefs: [{ type: 'group' }],
            limit: 10,
            maxState,
            eligible,
          }),
          `bySubjects at maxState ${String(maxState)}`,
        ).toEqual([]);
      }
      expect(world.repos.memorySearch.hydrate([memoryId('q1f')], eligible)).toEqual([]);
    });
  });

  it('does not appear after a plain setStatus to retracted', () => {
    withRepos((world) => {
      const item = world.store.write((uow) =>
        expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('q2f', world.groupId),
            groupLabel(world.groupId),
            fingerprintFor('q2f'),
          ),
          'a memory',
        ),
      );
      const eligible = eligibleOnly(world, [item.labelId]);
      const retracted = world.store.write((uow) =>
        expectWritten(
          world.repos.memories.setStatus(uow, world.groupId, item.id, item.version, 'retracted'),
          'a retraction',
        ),
      );
      expect(retracted.status).toBe('retracted');
      expect(
        world.repos.memorySearch.recent({
          groupId: world.groupId,
          limit: 10,
          maxState: 1,
          eligible,
        }),
      ).toEqual([]);
    });
  });
});
