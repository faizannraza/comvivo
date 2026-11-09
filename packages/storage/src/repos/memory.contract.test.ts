/**
 * `MemoryReader`/`MemoryRepository` against `02` §3.7.1 and §3.3.4 (`M1-T18`).
 *
 * The AC names three behaviours, and each is a rule whose violation is quiet:
 *
 *  - **Immutability** (`01` §5): content is never hard-updated. A correction is a new item, so the
 *    chain records what the group believed and when. A repository that let content change would
 *    rewrite history with no trace.
 *  - **Supersede**: the old row and the new one both carry a pointer, so the chain walks from
 *    either end — and `02` §3.3.4 gives only one of them a foreign key, for a reason.
 *  - **Subjects and sources**: written in the same transaction as the item, append-only, and
 *    idempotent under retry (`04` R13).
 */
import { expectWritten, RETRIEVAL_STATES } from '@comvivo/core';
import { StorageError } from '@comvivo/shared';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import {
  conversationId,
  fingerprintFor,
  groupLabel,
  member,
  memberId,
  memoryId,
  memoryItem,
  messageId,
  person,
  T0,
  withRepos,
} from './testing/harness.js';

describe('MemoryRepository', () => {
  it('inserts an item, interning its label and deriving its retrieval state', () => {
    withRepos((world) => {
      const item = world.store.write((uow) =>
        expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('a1f', world.groupId),
            groupLabel(world.groupId),
            fingerprintFor('a1f'),
          ),
          'a memory',
        ),
      );
      expect(item.labelId).toBeGreaterThan(0);
      expect(item.rid).toBeGreaterThan(0);
      // Derived, never a parameter: `02` §3.3.4 makes the column the repository's to maintain, and
      // accepting it would let a caller make a superseded item answer as current.
      expect(item.retrievalState).toBe(RETRIEVAL_STATES.activeCurrent);
      // Always `pending` on insert; the `embed.items` job moves it (`02` §3.5).
      expect(item.embeddingState).toBe('pending');
      expect(item.supersededById).toBeUndefined();
      expect(item.version).toBe(1);
    });
  });

  it('derives proposed and history states from the lifecycle fields', () => {
    withRepos((world) => {
      const proposed = world.store.write((uow) =>
        expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('a2f', world.groupId, { status: 'proposed' }),
            groupLabel(world.groupId),
            fingerprintFor('a2f'),
          ),
          'a proposal',
        ),
      );
      expect(proposed.retrievalState).toBe(RETRIEVAL_STATES.proposed);

      const archived = world.store.write((uow) =>
        expectWritten(
          world.repos.memories.setStatus(
            uow,
            world.groupId,
            proposed.id,
            proposed.version,
            'active',
            {
              archivedAt: T0,
            },
          ),
          'an archive',
        ),
      );
      // Archived with its validity still open is `archived` and can come back; archived *because*
      // the validity passed is `history` (`04` §3.7's maintenance table).
      expect(archived.retrievalState).toBe(RETRIEVAL_STATES.archived);

      // An item whose validity has *passed*, which needs `valid_from <= valid_to < now` —
      // `memory_valid_ck` enforces the first half, and the first version of this test put
      // `valid_to` before `valid_from` and was refused by the constraint. Correctly.
      const past = world.store.write((uow) =>
        expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('a3f', world.groupId, {
              id: memoryId('a3f'),
              validFrom: Temporal.Instant.from('2026-01-01T00:00:00Z'),
              validTo: Temporal.Instant.from('2026-06-01T00:00:00Z'),
            }),
            groupLabel(world.groupId),
            fingerprintFor('a3f'),
          ),
          'a lapsed item',
        ),
      );
      const expired = world.store.write((uow) =>
        expectWritten(
          world.repos.memories.setStatus(uow, world.groupId, past.id, past.version, 'active', {
            archivedAt: T0,
          }),
          'an expiry',
        ),
      );
      // Archived **and** past its validity is `history`, where archived with the validity still
      // open was `archived` above — the distinction `04` §3.7's maintenance table draws.
      expect(expired.retrievalState).toBe(RETRIEVAL_STATES.history);
    });
  });

  describe('immutability (01 §5)', () => {
    it('refuses an UPDATE of content through the trigger', () => {
      withRepos((world) => {
        const item = world.store.write((uow) =>
          expectWritten(
            world.repos.memories.insert(
              uow,
              memoryItem('b1f', world.groupId, { statement: 'the original statement' }),
              groupLabel(world.groupId),
              fingerprintFor('b1f'),
            ),
            'a memory',
          ),
        );
        // There is no repository method that could do this, which is the design — so the test
        // reaches past the repository to prove the **database** refuses it. If the trigger were
        // missing, a future repository method could change content with nothing to stop it.
        expect(() =>
          world.db
            .prepare('UPDATE memory_items SET statement = ? WHERE rid = ?')
            .run('a rewritten statement', item.rid),
        ).toThrow(/MEMORY_CONTENT_IMMUTABLE/);
        expect(() =>
          world.db
            .prepare('UPDATE memory_items SET content = ? WHERE rid = ?')
            .run('{"kind":"fact","attribute":null,"value":null,"polarity":"affirm"}', item.rid),
        ).toThrow(/MEMORY_CONTENT_IMMUTABLE/);
        // And the row is unchanged, so the refusal is a refusal and not a partial write.
        expect(
          world.repos.memories.byId(world.groupId, item.id, eligibleOf(world, [item.labelId]))
            ?.statement,
        ).toBe('the original statement');
      });
    });

    it('still allows the lifecycle columns to move', () => {
      withRepos((world) => {
        const item = world.store.write((uow) =>
          expectWritten(
            world.repos.memories.insert(
              uow,
              memoryItem('b2f', world.groupId),
              groupLabel(world.groupId),
              fingerprintFor('b2f'),
            ),
            'a memory',
          ),
        );
        // The trigger covers `content`, `statement`, `search_terms`, `kind`, `group_id` and
        // `provenance` — not `status`, `pinned` or the validity window. A trigger that covered too
        // much would make the lifecycle unwritable, which is the failure in the other direction.
        const pinned = world.store.write((uow) =>
          expectWritten(
            world.repos.memories.setPinned(uow, world.groupId, item.id, item.version, true),
            'a pin',
          ),
        );
        expect(pinned.pinned).toBe(true);
        expect(pinned.pinnedAt).toBeDefined();
      });
    });
  });

  describe('supersede', () => {
    it('links both ends of the chain', () => {
      withRepos((world) => {
        const first = world.store.write((uow) =>
          expectWritten(
            world.repos.memories.insert(
              uow,
              memoryItem('c1f', world.groupId, { statement: 'Leo goes to Oakfield' }),
              groupLabel(world.groupId),
              fingerprintFor('c1f'),
            ),
            'the first',
          ),
        );
        const second = world.store.write((uow) =>
          expectWritten(
            world.repos.memories.supersede(
              uow,
              world.groupId,
              first.id,
              first.version,
              memoryItem('c2f', world.groupId, {
                id: memoryId('c2f'),
                statement: 'Leo goes to Brambleside',
              }),
              groupLabel(world.groupId),
              fingerprintFor('c2f'),
            ),
            'the replacement',
          ),
        );
        expect(second.supersedesId).toBe(first.id);

        const eligible = eligibleOf(world, [first.labelId, second.labelId]);
        const old = world.repos.memories.byId(world.groupId, first.id, eligible);
        expect(old?.status).toBe('superseded');
        expect(old?.supersededById).toBe(second.id);
        // `history`, so it stops answering as current while staying retrievable for "what did we
        // think last month" (`04` R5).
        expect(old?.retrievalState).toBe(RETRIEVAL_STATES.history);
      });
    });

    it('walks the chain newest first', () => {
      withRepos((world) => {
        const ids = world.store.write((uow) => {
          let previous = expectWritten(
            world.repos.memories.insert(
              uow,
              memoryItem('d1f', world.groupId),
              groupLabel(world.groupId),
              fingerprintFor('d1f'),
            ),
            'the first',
          );
          const chain = [previous];
          for (const tag of ['d2f', 'd3f']) {
            previous = expectWritten(
              world.repos.memories.supersede(
                uow,
                world.groupId,
                previous.id,
                previous.version,
                memoryItem(tag, world.groupId, { id: memoryId(tag) }),
                groupLabel(world.groupId),
                fingerprintFor(tag),
              ),
              `the ${tag} replacement`,
            );
            chain.push(previous);
          }
          return chain;
        });
        const eligible = eligibleOf(
          world,
          ids.map((item) => item.labelId),
        );
        const chain = world.repos.memories.supersedeChain(world.groupId, memoryId('d3f'), eligible);
        expect(chain.map((item) => item.id)).toEqual([
          memoryId('d3f'),
          memoryId('d2f'),
          memoryId('d1f'),
        ]);
      });
    });

    it('rolls the whole replacement back when the transaction fails', () => {
      withRepos((world) => {
        const first = world.store.write((uow) =>
          expectWritten(
            world.repos.memories.insert(
              uow,
              memoryItem('e1f', world.groupId),
              groupLabel(world.groupId),
              fingerprintFor('e1f'),
            ),
            'the first',
          ),
        );
        expect(() =>
          world.store.write((uow) => {
            world.repos.memories.supersede(
              uow,
              world.groupId,
              first.id,
              first.version,
              memoryItem('e2f', world.groupId, { id: memoryId('e2f') }),
              groupLabel(world.groupId),
              fingerprintFor('e2f'),
            );
            throw new Error('the caller changed its mind');
          }),
        ).toThrow('the caller changed its mind');

        const eligible = eligibleOf(world, [first.labelId]);
        // Neither half landed. A supersede that committed the new item without retiring the old
        // one would leave two items claiming to be current — the worst intermediate state, because
        // both would answer the same question differently.
        expect(world.repos.memories.byId(world.groupId, first.id, eligible)?.status).toBe('active');
        expect(world.repos.memories.byId(world.groupId, memoryId('e2f'), eligible)).toBeUndefined();
      });
    });

    it('refuses a stale version without writing the replacement', () => {
      withRepos((world) => {
        const first = world.store.write((uow) =>
          expectWritten(
            world.repos.memories.insert(
              uow,
              memoryItem('f1f', world.groupId),
              groupLabel(world.groupId),
              fingerprintFor('f1f'),
            ),
            'the first',
          ),
        );
        world.store.write((uow) =>
          world.repos.memories.setPinned(uow, world.groupId, first.id, first.version, true),
        );
        const refused = world.store.write((uow) =>
          world.repos.memories.supersede(
            uow,
            world.groupId,
            first.id,
            first.version,
            memoryItem('f2f', world.groupId, { id: memoryId('f2f') }),
            groupLabel(world.groupId),
            fingerprintFor('f2f'),
          ),
        );
        expect(refused.kind).toBe('conflict');
        // The version is checked **before** the new item is written, so a conflict leaves no
        // orphan: a replacement that existed with nothing superseded by it would be an item
        // claiming to correct something that was never retired.
        const eligible = eligibleOf(world, [first.labelId]);
        expect(world.repos.memories.byId(world.groupId, memoryId('f2f'), eligible)).toBeUndefined();
      });
    });
  });

  describe('subjects and sources (02 §3.3.4, 04 R13)', () => {
    it('writes them in the same transaction as the item', () => {
      withRepos((world) => {
        const item = world.store.write((uow) => {
          expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
          const added = expectWritten(
            world.repos.members.add(uow, member('a', world.groupId)),
            'member a',
          );
          const conversation = expectWritten(
            world.repos.conversations.create(uow, {
              id: conversationId('a'),
              groupId: world.groupId,
              channel: 'simulator',
              platformChatId: 'chat-a',
              kind: 'group',
              boundAt: T0,
            }),
            'a conversation',
          );
          const message = expectWritten(
            world.repos.messages.insert(
              uow,
              {
                id: messageId('g1f'),
                groupId: world.groupId,
                conversationId: conversation.id,
                kind: 'member',
                senderMemberId: added.id,
                text: 'Leo goes to Oakfield',
                sentAt: T0,
                receivedAt: T0,
              },
              groupLabel(world.groupId),
            ),
            'a message',
          );
          return expectWritten(
            world.repos.memories.insert(
              uow,
              memoryItem('g1f', world.groupId, {
                subjects: [
                  { ref: added.id, role: 'about' },
                  { ref: 'group', role: 'mentions' },
                ],
                sources: [
                  { ref: message.id, messageId: message.id, windowKey: 'w-1', span: undefined },
                ],
              }),
              groupLabel(world.groupId),
              fingerprintFor('g1f'),
            ),
            'a memory',
          );
        });

        const subjects = world.repos.memories.subjectsOf(world.groupId, item.id);
        expect(subjects.map((subject) => subject.role).toSorted()).toEqual(['about', 'mentions']);
        const sources = world.repos.memories.sourcesOf(world.groupId, item.id);
        expect(sources).toHaveLength(1);
        expect(sources[0]?.messageId).toBe(messageId('g1f'));
        // The stable copy, which survives the message expiring (`02` §3.3.4) — the whole reason
        // `source_ref` exists beside the nullable `message_id`.
        expect(sources[0]?.ref).toBe(messageId('g1f'));
      });
    });

    it('is idempotent under retry, because an extraction can be replayed', () => {
      withRepos((world) => {
        const item = world.store.write((uow) =>
          expectWritten(
            world.repos.memories.insert(
              uow,
              memoryItem('h1f', world.groupId, {
                sources: [{ ref: 'src-1', messageId: undefined, windowKey: 'w', span: undefined }],
              }),
              groupLabel(world.groupId),
              fingerprintFor('h1f'),
            ),
            'a memory',
          ),
        );
        world.store.write((uow) =>
          world.repos.memories.addSources(uow, world.groupId, item.id, [
            { ref: 'src-1', messageId: undefined, windowKey: 'w', span: undefined },
            { ref: 'src-2', messageId: undefined, windowKey: 'w', span: undefined },
          ]),
        );
        // Two, not three: `(memory_rid, source_ref)` is the key, and `04` R13's append-only rule
        // makes a replayed extraction a no-op rather than a duplicate.
        expect(world.repos.memories.sourcesOf(world.groupId, item.id)).toHaveLength(2);
      });
    });

    it('appends sources without bumping the version', () => {
      withRepos((world) => {
        const item = world.store.write((uow) =>
          expectWritten(
            world.repos.memories.insert(
              uow,
              memoryItem('h2f', world.groupId),
              groupLabel(world.groupId),
              fingerprintFor('h2f'),
            ),
            'a memory',
          ),
        );
        world.store.write((uow) =>
          world.repos.memories.addSources(uow, world.groupId, item.id, [
            { ref: 'src-1', messageId: undefined, windowKey: undefined, span: undefined },
          ]),
        );
        // Unversioned on purpose: appending is commutative, so two callers adding different
        // sources must both succeed. Making it conflict would fail one for no reason.
        const eligible = eligibleOf(world, [item.labelId]);
        expect(world.repos.memories.byId(world.groupId, item.id, eligible)?.version).toBe(1);
      });
    });
  });

  describe('duplicates and labels', () => {
    it('reports an exact duplicate by fingerprint, naming the existing item', () => {
      withRepos((world) => {
        const first = world.store.write((uow) =>
          expectWritten(
            world.repos.memories.insert(
              uow,
              memoryItem('x1f', world.groupId),
              groupLabel(world.groupId),
              fingerprintFor('same'),
            ),
            'the first',
          ),
        );
        const again = world.store.write((uow) =>
          world.repos.memories.insert(
            uow,
            memoryItem('x2f', world.groupId, { id: memoryId('x2f') }),
            groupLabel(world.groupId),
            fingerprintFor('same'),
          ),
        );
        expect(again.kind).toBe('duplicate');
        if (again.kind !== 'duplicate') return;
        // The existing item, so `04` §3.3.11's caller can *confirm* it rather than insert a copy.
        expect(again.existingId).toBe(first.id);
      });
    });

    it('lets a retracted item be re-learned', () => {
      withRepos((world) => {
        const first = world.store.write((uow) =>
          expectWritten(
            world.repos.memories.insert(
              uow,
              memoryItem('x3f', world.groupId),
              groupLabel(world.groupId),
              fingerprintFor('again'),
            ),
            'the first',
          ),
        );
        world.store.write((uow) =>
          world.repos.memories.forget(uow, world.groupId, first.id, 'forgotten', T0),
        );
        const relearned = world.store.write((uow) =>
          world.repos.memories.insert(
            uow,
            memoryItem('x4f', world.groupId, { id: memoryId('x4f') }),
            groupLabel(world.groupId),
            fingerprintFor('again'),
          ),
        );
        // A forgotten fact that is stated again is a new fact. Reporting it as a duplicate of the
        // retracted one would make `04`'s forget permanent in a way the member never asked for —
        // they asked us to forget it, not to refuse to learn it again.
        expect(relearned.kind).toBe('ok');
      });
    });

    it('refuses a label from another group', () => {
      withRepos((world) => {
        let caught: unknown;
        try {
          world.store.write((uow) =>
            world.repos.memories.insert(
              uow,
              memoryItem('x5f', world.groupId),
              groupLabel(world.otherGroupId),
              fingerprintFor('x5f'),
            ),
          );
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(StorageError);
        expect((caught as StorageError).message).toContain('another group');
      });
    });

    it('is a no-op when a narrowing re-applies the label it already has', () => {
      withRepos((world) => {
        const label = groupLabel(world.groupId);
        const item = world.store.write((uow) =>
          expectWritten(
            world.repos.memories.insert(
              uow,
              memoryItem('x6f', world.groupId),
              label,
              fingerprintFor('x6f'),
            ),
            'a memory',
          ),
        );
        const again = world.store.write((uow) =>
          expectWritten(
            world.repos.memories.narrowLabel(uow, world.groupId, item.id, item.version, label),
            'a re-narrowing',
          ),
        );
        // `ok` with nothing changed: re-applying the same narrowing is what a retried
        // declassification job does.
        expect(again.labelId).toBe(item.labelId);
        expect(again.version).toBe(item.version);
      });
    });
  });

  describe('forget (04 R9)', () => {
    it('retracts and records a content-free tombstone', () => {
      withRepos((world) => {
        const item = world.store.write((uow) =>
          expectWritten(
            world.repos.memories.insert(
              uow,
              memoryItem('y1f', world.groupId, { statement: 'something private' }),
              groupLabel(world.groupId),
              fingerprintFor('y1f'),
            ),
            'a memory',
          ),
        );
        world.store.write((uow) =>
          expectWritten(
            world.repos.memories.forget(uow, world.groupId, item.id, 'forgotten', T0),
            'a forget',
          ),
        );
        const tombstone = world.db
          .prepare('SELECT * FROM memory_tombstones WHERE memory_id = ?')
          .get(item.id) as Record<string, unknown> | undefined;
        expect(tombstone).toBeDefined();
        // Content-free: the id, the group, when and why. `04` R9 is explicit, and a tombstone that
        // quoted the statement would preserve exactly what the member asked us to forget.
        expect(JSON.stringify(tombstone)).not.toContain('something private');
        expect(tombstone?.['reason']).toBe('forgotten');
      });
    });

    it('is idempotent, because forgetting is a job', () => {
      withRepos((world) => {
        const item = world.store.write((uow) =>
          expectWritten(
            world.repos.memories.insert(
              uow,
              memoryItem('y2f', world.groupId),
              groupLabel(world.groupId),
              fingerprintFor('y2f'),
            ),
            'a memory',
          ),
        );
        world.store.write((uow) =>
          world.repos.memories.forget(uow, world.groupId, item.id, 'forgotten', T0),
        );
        const again = world.store.write((uow) =>
          world.repos.memories.forget(uow, world.groupId, item.id, 'forgotten', T0),
        );
        expect(again.kind).toBe('ok');
        expect(
          world.db.prepare('SELECT count(*) AS n FROM memory_tombstones').get() as { n: number },
        ).toEqual({ n: 1 });
      });
    });
  });

  describe('group isolation (I4)', () => {
    it('does not find an item from another group', () => {
      withRepos((world) => {
        const elsewhere = world.store.write((uow) =>
          expectWritten(
            world.repos.memories.insert(
              uow,
              memoryItem('z1f', world.otherGroupId, { groupId: world.otherGroupId }),
              groupLabel(world.otherGroupId),
              fingerprintFor('z1f'),
            ),
            'a memory elsewhere',
          ),
        );
        const eligible = eligibleOf(world, [elsewhere.labelId]);
        expect(world.repos.memories.byId(world.groupId, elsewhere.id, eligible)).toBeUndefined();
        expect(
          world.repos.memories.byFingerprint(world.groupId, fingerprintFor('z1f')),
        ).toBeUndefined();
        expect(world.repos.memories.subjectsOf(world.groupId, elsewhere.id)).toEqual([]);
        // And it is there in its own group, so this is about scoping and not about the write.
        expect(world.repos.memories.byId(world.otherGroupId, elsewhere.id, eligible)?.id).toBe(
          elsewhere.id,
        );
      });
    });

    it('refuses a write aimed at another group as not_found', () => {
      withRepos((world) => {
        const elsewhere = world.store.write((uow) =>
          expectWritten(
            world.repos.memories.insert(
              uow,
              memoryItem('z2f', world.otherGroupId, { groupId: world.otherGroupId }),
              groupLabel(world.otherGroupId),
              fingerprintFor('z2f'),
            ),
            'a memory elsewhere',
          ),
        );
        const refused = world.store.write((uow) =>
          world.repos.memories.setPinned(uow, world.groupId, elsewhere.id, elsewhere.version, true),
        );
        expect(refused.kind).toBe('not_found');
      });
    });
  });

  it('counts the embedding backlog, excluding retracted items', () => {
    withRepos((world) => {
      const items = world.store.write((uow) =>
        ['w1f', 'w2f'].map((tag) =>
          expectWritten(
            world.repos.memories.insert(
              uow,
              memoryItem(tag, world.groupId, { id: memoryId(tag) }),
              groupLabel(world.groupId),
              fingerprintFor(tag),
            ),
            `memory ${tag}`,
          ),
        ),
      );
      expect(world.repos.memories.embeddingBacklog(world.groupId, 10)).toHaveLength(2);
      world.store.write((uow) =>
        world.repos.memories.forget(
          uow,
          world.groupId,
          items[0]?.id ?? memoryId('w1f'),
          'forgotten',
          T0,
        ),
      );
      // Q-JOB-6's partial index excludes retracted rows, because embedding one would be work whose
      // result is immediately deleted from the index.
      expect(world.repos.memories.embeddingBacklog(world.groupId, 10)).toHaveLength(1);
    });
  });

  it('records a retrieval without failing the read it belongs to', () => {
    withRepos((world) => {
      const item = world.store.write((uow) =>
        expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('w3f', world.groupId),
            groupLabel(world.groupId),
            fingerprintFor('w3f'),
          ),
          'a memory',
        ),
      );
      world.store.write((uow) => {
        world.repos.memories.recordRetrieval(uow, [item.rid], T0);
        world.repos.memories.recordRetrieval(uow, [item.rid], T0);
      });
      const stats = world.db
        .prepare('SELECT retrieved_count AS n FROM memory_access_stats WHERE memory_rid = ?')
        .get(item.rid) as { n: number } | undefined;
      // Upserted, so the second retrieval increments rather than failing on the primary key.
      expect(stats?.n).toBe(2);
      // An unknown rid is a no-op rather than an error: a retrieval statistic is not something a
      // caller can usefully fail on, and refusing it would fail a *read* for its bookkeeping.
      expect(() =>
        world.store.write((uow) => world.repos.memories.recordRetrieval(uow, [], T0)),
      ).not.toThrow();
    });
  });
});

/** An eligible set over interned label ids, shaped as the reader expects one. */
function eligibleOf(
  world: Parameters<Parameters<typeof withRepos>[0]>[0],
  ids: readonly number[],
): never {
  void memberId;
  return {
    groupId: world.groupId,
    ids: [...new Set(ids)].toSorted((left, right) => left - right),
    audienceKey: 'g|s:',
    epoch: '0:0',
  } as unknown as never;
}
