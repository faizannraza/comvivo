/**
 * Memory FTS, end to end (`M1-T18`; `02` §3.4, `04` R4).
 *
 * The trigger-synced path, against the real tokenizers. `fts-query.test.ts` checks the **query
 * builder** in isolation; this checks that what the builder emits actually matches what the
 * triggers indexed — which is the half a unit test cannot reach, because the answer depends on
 * `unicode61 remove_diacritics 2` and the trigram tokenizer behaving as `02` §3.4 claims.
 *
 * `02` §3.4's maintenance section promises a `search.verify` job that checks FTS/base parity; the
 * cases here are the behaviours that job would be checking *for*.
 */

import type { EligibleLabelSet } from '@comvivo/core';
import { expectWritten, type Label, type NotPromise } from '@comvivo/core';
import { describe, expect, it } from 'vitest';
import {
  eligibleOnly,
  fingerprintFor,
  groupLabel,
  member,
  memoryId,
  memoryItem,
  person,
  T0,
  type World,
  withRepos,
} from '../repos/testing/harness.js';
import { trigramCanMatch } from './fts-query.js';

describe('memory FTS (02 §3.4)', { tags: ['db'] }, () => {
  /** A world with `items` memories indexed, returning their ids and the eligible set. */
  function withIndexed<T>(
    items: readonly { tag: string; statement: string; terms?: readonly string[] }[],
    fn: (world: World, eligible: EligibleLabelSet) => NotPromise<T>,
  ): T {
    return withRepos((world) => {
      const label: Label = groupLabel(world.groupId);
      const labelIds = world.store.write((uow) => {
        expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
        expectWritten(world.repos.members.add(uow, member('a', world.groupId)), 'member a');
        return items.map(
          (item) =>
            expectWritten(
              world.repos.memories.insert(
                uow,
                memoryItem(item.tag, world.groupId, {
                  id: memoryId(item.tag),
                  statement: item.statement,
                  searchTerms: [...(item.terms ?? [])],
                }),
                label,
                fingerprintFor(item.tag),
              ),
              `memory ${item.tag}`,
            ).labelId,
        );
      });
      return fn(world, eligibleOnly(world, labelIds));
    });
  }

  it('finds a memory by a word in its statement', () => {
    withIndexed(
      [
        { tag: 'a1f', statement: 'Leo has a dentist appointment on Tuesday' },
        { tag: 'a2f', statement: 'the car needs new tyres' },
      ],
      (world, eligible) => {
        const hits = world.repos.memorySearch.text({
          groupId: world.groupId,
          query: 'dentist',
          mode: 'word',
          limit: 10,
          maxState: 1,
          eligible,
        });
        expect(hits.map((hit) => hit.ref)).toEqual([memoryId('a1f')]);
      },
    );
  });

  it('finds a memory by one of its search terms, weighted below the statement', () => {
    withIndexed(
      [
        // `terms` carries `04`'s extracted keywords. `02` §3.4 weights them 0.8 against the
        // statement's 1.0, so a statement hit should outrank a terms-only hit.
        { tag: 'b1f', statement: 'an appointment on Tuesday', terms: ['orthodontist'] },
        { tag: 'b2f', statement: 'the orthodontist called back' },
      ],
      (world, eligible) => {
        const hits = world.repos.memorySearch.text({
          groupId: world.groupId,
          query: 'orthodontist',
          mode: 'word',
          limit: 10,
          maxState: 1,
          eligible,
        });
        expect(hits).toHaveLength(2);
        // bm25 is lower-is-better, and the statement column carries more weight — so the item
        // whose *statement* matched comes first.
        expect(hits[0]?.ref).toBe(memoryId('b2f'));
        expect(hits[0]?.distance).toBeLessThan(hits[1]?.distance ?? 0);
      },
    );
  });

  it('folds diacritics, as `remove_diacritics 2` promises', () => {
    withIndexed([{ tag: 'c1f', statement: 'José Müller is the plumber' }], (world, eligible) => {
      for (const query of ['jose', 'José', 'muller', 'Müller']) {
        const hits = world.repos.memorySearch.text({
          groupId: world.groupId,
          query,
          mode: 'word',
          limit: 10,
          maxState: 1,
          eligible,
        });
        expect(
          hits.map((hit) => hit.ref),
          query,
        ).toEqual([memoryId('c1f')]);
      }
    });
  });

  it('does not match a substring in word mode, which is what trigram mode is for', () => {
    withIndexed([{ tag: 'd1f', statement: 'the Bahnhofstrasse flat' }], (world, eligible) => {
      // `unicode61` has no compound splitting (`02` §3.4's table says so), so a German compound
      // is one token and an infix query finds nothing.
      expect(
        world.repos.memorySearch.text({
          groupId: world.groupId,
          query: 'hofstrasse',
          mode: 'word',
          limit: 10,
          maxState: 1,
          eligible,
        }),
      ).toEqual([]);
      // Trigram mode does find it, which is the whole reason the second index exists.
      expect(
        world.repos.memorySearch
          .text({
            groupId: world.groupId,
            query: 'hofstrasse',
            mode: 'trigram',
            limit: 10,
            maxState: 1,
            eligible,
          })
          .map((hit) => hit.ref),
      ).toEqual([memoryId('d1f')]);
    });
  });

  it('matches CJK through the trigram index', () => {
    withIndexed([{ tag: 'e1f', statement: '今日は何を食べますか' }], (world, eligible) => {
      expect(
        world.repos.memorySearch
          .text({
            groupId: world.groupId,
            query: '何を食',
            mode: 'trigram',
            limit: 10,
            maxState: 1,
            eligible,
          })
          .map((hit) => hit.ref),
      ).toEqual([memoryId('e1f')]);
    });
  });

  it('matches nothing below three characters in trigram mode, as measured in M1-T2', () => {
    withIndexed([{ tag: 'f1f', statement: '今日は何を食べますか' }], (world, eligible) => {
      // The constraint `02` §3.4 records and `04` has to handle by falling back to vector search:
      // two CJK characters is a whole word and still matches nothing.
      expect(trigramCanMatch('何を')).toBe(false);
      expect(
        world.repos.memorySearch.text({
          groupId: world.groupId,
          query: '何を',
          mode: 'trigram',
          limit: 10,
          maxState: 1,
          eligible,
        }),
      ).toEqual([]);
      // Three does match, so the boundary is where it is claimed to be.
      expect(
        world.repos.memorySearch.text({
          groupId: world.groupId,
          query: '何を食',
          mode: 'trigram',
          limit: 10,
          maxState: 1,
          eligible,
        }),
      ).toHaveLength(1);
    });
  });

  it('keeps one group out of another group`s results', () => {
    withRepos((world) => {
      const label = groupLabel(world.groupId);
      const otherLabel = groupLabel(world.otherGroupId);
      const ids = world.store.write((uow) => {
        const here = expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('g1f', world.groupId, { statement: 'the dentist on Tuesday' }),
            label,
            fingerprintFor('g1f'),
          ),
          'here',
        );
        const there = expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('g2f', world.otherGroupId, {
              id: memoryId('g2f'),
              groupId: world.otherGroupId,
              statement: 'the dentist on Tuesday',
            }),
            otherLabel,
            fingerprintFor('g2f'),
          ),
          'there',
        );
        return [here.labelId, there.labelId];
      });
      // The scope token intersects the group's doclist (`02` §3.4). Both items have the identical
      // statement, so a missing scope filter would return both — which is `I4` through a search
      // index rather than through a query.
      const hits = world.repos.memorySearch.text({
        groupId: world.groupId,
        query: 'dentist',
        mode: 'word',
        limit: 10,
        maxState: 1,
        eligible: eligibleOnly(world, ids),
      });
      expect(hits.map((hit) => hit.ref)).toEqual([memoryId('g1f')]);
    });
  });

  it('keeps the trigram index group-scoped through the join, having no scope column', () => {
    withRepos((world) => {
      const ids = world.store.write((uow) => {
        const here = expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('h1f', world.groupId, { statement: 'Bahnhofstrasse' }),
            groupLabel(world.groupId),
            fingerprintFor('h1f'),
          ),
          'here',
        );
        const there = expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('h2f', world.otherGroupId, {
              id: memoryId('h2f'),
              groupId: world.otherGroupId,
              statement: 'Bahnhofstrasse',
            }),
            groupLabel(world.otherGroupId),
            fingerprintFor('h2f'),
          ),
          'there',
        );
        return [here.labelId, there.labelId];
      });
      // `memory_fts_tri` has no `scope` column, so the only thing keeping the groups apart is the
      // `m.group_id = ?` predicate on the joined base row (`02` §3.4). This is the test that the
      // join is actually doing it.
      const hits = world.repos.memorySearch.text({
        groupId: world.groupId,
        query: 'hofstrasse',
        mode: 'trigram',
        limit: 10,
        maxState: 1,
        eligible: eligibleOnly(world, ids),
      });
      expect(hits.map((hit) => hit.ref)).toEqual([memoryId('h1f')]);
    });
  });

  it('removes a retracted memory from both indexes', () => {
    withIndexed([{ tag: 'x1f', statement: 'the dentist on Tuesday' }], (world, eligible) => {
      expect(
        world.repos.memorySearch.text({
          groupId: world.groupId,
          query: 'dentist',
          mode: 'word',
          limit: 10,
          maxState: 3,
          eligible,
        }),
      ).toHaveLength(1);

      world.store.write((uow) =>
        world.repos.memories.forget(uow, world.groupId, memoryId('x1f'), 'forgotten', T0),
      );

      // `04` R5: retracted items are removed from both indexes rather than filtered within them.
      // So a `maxState: 3` query — which asks for everything including history — finds nothing.
      for (const mode of ['word', 'trigram'] as const) {
        expect(
          world.repos.memorySearch.text({
            groupId: world.groupId,
            query: mode === 'word' ? 'dentist' : 'dentist',
            mode,
            limit: 10,
            maxState: 3,
            eligible,
          }),
          mode,
        ).toEqual([]);
      }
    });
  });

  it('respects the retrieval-state ceiling', () => {
    withRepos((world) => {
      const label = groupLabel(world.groupId);
      const ids = world.store.write((uow) => {
        const active = expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('j1f', world.groupId, { statement: 'the dentist on Tuesday' }),
            label,
            fingerprintFor('j1f'),
          ),
          'active',
        );
        const proposed = expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('j2f', world.groupId, {
              id: memoryId('j2f'),
              statement: 'the dentist on Wednesday',
              status: 'proposed',
            }),
            label,
            fingerprintFor('j2f'),
          ),
          'proposed',
        );
        return [active.labelId, proposed.labelId];
      });
      const eligible = eligibleOnly(world, ids);
      const query = {
        groupId: world.groupId,
        query: 'dentist',
        mode: 'word' as const,
        limit: 10,
        eligible,
      };
      // `0` is active-current only; `1` is the default and includes proposed (`04` R5).
      expect(world.repos.memorySearch.text({ ...query, maxState: 0 })).toHaveLength(1);
      expect(world.repos.memorySearch.text({ ...query, maxState: 1 })).toHaveLength(2);
    });
  });

  it('returns nothing rather than raising when the query has no searchable terms', () => {
    withIndexed([{ tag: 'k1f', statement: 'the dentist on Tuesday' }], (world, eligible) => {
      // An empty `MATCH` is a syntax error, so the builder returns `null` and the port returns
      // `[]` — which keeps "the user typed two spaces" from failing a turn.
      for (const query of ['', '   ', '!!!', 'a']) {
        expect(
          world.repos.memorySearch.text({
            groupId: world.groupId,
            query,
            mode: 'word',
            limit: 10,
            maxState: 1,
            eligible,
          }),
          JSON.stringify(query),
        ).toEqual([]);
      }
    });
  });

  it('does not let FTS5 syntax in a query change the query', () => {
    withIndexed(
      [
        { tag: 'y1f', statement: 'the dentist on Tuesday' },
        { tag: 'y2f', statement: 'the plumber on Wednesday' },
      ],
      (world, eligible) => {
        // `dentist OR plumber` as *user text* must not become a disjunction: every term is a
        // quoted phrase, so this searches for the three words and `any` mode ORs them — which is
        // the builder's own operator, not the user's. The assertion that matters is that it does
        // not **raise**, which is what a raw `MATCH` would do for `"unterminated`.
        for (const query of ['dentist OR plumber', '"unterminated', 'NEAR(a b)', 'col : x']) {
          expect(
            () =>
              world.repos.memorySearch.text({
                groupId: world.groupId,
                query,
                mode: 'word',
                limit: 10,
                maxState: 1,
                eligible,
              }),
            query,
          ).not.toThrow();
        }
      },
    );
  });
});
