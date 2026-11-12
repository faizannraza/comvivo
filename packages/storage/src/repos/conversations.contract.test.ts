/**
 * `ConversationReader`/`ConversationRepository` against `02` §3.7.1 and §3.3.1 (`M1-T17`).
 *
 * The two constraints that need a test rather than a comment are `conversations_one_primary_uq` —
 * a **partial** unique index, so promoting a conversation requires demoting the current holder in
 * the same transaction — and the DM shape rules, which `core`'s `conversationShapeError` answers
 * before the write so the caller gets a sentence instead of a constraint name.
 */
import { expectWritten } from '@comvivo/core';
import { StorageError } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import { ABSENT_GROUP, conversationId, member, person, T0, withRepos } from './testing/harness.js';

/** A bound group chat in `groupId`. */
const chat = (tag: string, groupId: Parameters<typeof member>[1], extra = {}) => ({
  id: conversationId(tag),
  groupId,
  channel: 'simulator' as const,
  platformChatId: `chat-${tag}`,
  kind: 'group' as const,
  boundAt: T0,
  ...extra,
});

describe('ConversationRepository', () => {
  it('binds a chat and finds it by (group, channel, chatId) — Q-ING-2', () => {
    withRepos((world) => {
      const bound = world.store.write((uow) =>
        expectWritten(world.repos.conversations.create(uow, chat('a', world.groupId)), 'a chat'),
      );
      expect(bound.primary).toBe(false);
      expect(bound.memberId).toBeUndefined();
      expect(bound.title).toBeUndefined();
      expect(world.repos.conversations.byPlatform(world.groupId, 'simulator', 'chat-a')?.id).toBe(
        bound.id,
      );
    });
  });

  it('scopes the platform lookup on the group, because one chat can bind to several', () => {
    withRepos((world) => {
      // `conversations_platform_uq` includes `group_id`, so the same platform DM chat maps to one
      // DM conversation **per group** (`01` §14 A27).
      world.store.write((uow) => {
        expectWritten(world.repos.conversations.create(uow, chat('a', world.groupId)), 'here');
        expectWritten(
          world.repos.conversations.create(uow, {
            ...chat('b', world.otherGroupId),
            platformChatId: 'chat-a',
          }),
          'there',
        );
      });
      expect(world.repos.conversations.byPlatform(world.groupId, 'simulator', 'chat-a')?.id).toBe(
        conversationId('a'),
      );
      expect(
        world.repos.conversations.byPlatform(world.otherGroupId, 'simulator', 'chat-a')?.id,
      ).toBe(conversationId('b'));
    });
  });

  it('reports a chat already bound to this group as a duplicate', () => {
    withRepos((world) => {
      world.store.write((uow) => world.repos.conversations.create(uow, chat('a', world.groupId)));
      const again = world.store.write((uow) =>
        world.repos.conversations.create(uow, {
          ...chat('c', world.groupId),
          platformChatId: 'chat-a',
        }),
      );
      expect(again.kind).toBe('duplicate');
      if (again.kind !== 'duplicate') return;
      expect(again.existingId).toBe(conversationId('a'));
    });
  });

  describe('shape rules (02 §3.3.1)', () => {
    it('refuses a DM with no member, naming the rule', () => {
      withRepos((world) => {
        let caught: unknown;
        try {
          world.store.write((uow) =>
            world.repos.conversations.create(uow, { ...chat('a', world.groupId), kind: 'dm' }),
          );
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(StorageError);
        expect((caught as StorageError).message).toContain('must name the member');
      });
    });

    it('refuses a group conversation that names a member', () => {
      withRepos((world) => {
        let caught: unknown;
        try {
          world.store.write((uow) => {
            expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
            const m = expectWritten(
              world.repos.members.add(uow, member('a', world.groupId)),
              'member',
            );
            return world.repos.conversations.create(uow, {
              ...chat('a', world.groupId),
              memberId: m.id,
            });
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(StorageError);
        expect((caught as StorageError).message).toContain('must not name a member');
      });
    });

    it('accepts a DM that names its member', () => {
      withRepos((world) => {
        const dm = world.store.write((uow) => {
          expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
          const m = expectWritten(
            world.repos.members.add(uow, member('a', world.groupId)),
            'member',
          );
          return expectWritten(
            world.repos.conversations.create(uow, {
              ...chat('d', world.groupId),
              kind: 'dm',
              memberId: m.id,
            }),
            'a DM',
          );
        });
        expect(dm.kind).toBe('dm');
        expect(dm.memberId).toBeDefined();
      });
    });

    it('refuses a primary DM', () => {
      withRepos((world) => {
        let caught: unknown;
        try {
          world.store.write((uow) => {
            expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
            const m = expectWritten(
              world.repos.members.add(uow, member('a', world.groupId)),
              'member',
            );
            return world.repos.conversations.create(uow, {
              ...chat('d', world.groupId),
              kind: 'dm',
              memberId: m.id,
              primary: true,
            });
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(StorageError);
        expect((caught as StorageError).message).toContain('must be a group conversation');
      });
    });
  });

  describe('the primary conversation (07 SC-2)', () => {
    it('swaps the primary, demoting the previous holder', () => {
      withRepos((world) => {
        world.store.write((uow) => {
          expectWritten(
            world.repos.conversations.create(uow, { ...chat('a', world.groupId), primary: true }),
            'the first',
          );
          expectWritten(world.repos.conversations.create(uow, chat('b', world.groupId)), 'second');
        });
        expect(world.repos.conversations.primary(world.groupId)?.id).toBe(conversationId('a'));

        const promoted = world.store.write((uow) =>
          expectWritten(
            world.repos.conversations.setPrimary(uow, world.groupId, conversationId('b')),
            'a swap',
          ),
        );
        expect(promoted.primary).toBe(true);
        // Exactly one primary, which `conversations_one_primary_uq` enforces per statement — so
        // the demotion has to happen before the promotion, and this is the assertion that the
        // order is right rather than lucky.
        expect(world.repos.conversations.primary(world.groupId)?.id).toBe(conversationId('b'));
        expect(world.repos.conversations.byId(world.groupId, conversationId('a'))?.primary).toBe(
          false,
        );
      });
    });

    it('is idempotent when the conversation is already primary', () => {
      withRepos((world) => {
        world.store.write((uow) =>
          expectWritten(
            world.repos.conversations.create(uow, { ...chat('a', world.groupId), primary: true }),
            'a chat',
          ),
        );
        const again = world.store.write((uow) =>
          expectWritten(
            world.repos.conversations.setPrimary(uow, world.groupId, conversationId('a')),
            'a re-promotion',
          ),
        );
        expect(again.primary).toBe(true);
        expect(world.repos.conversations.list(world.groupId).filter((c) => c.primary)).toHaveLength(
          1,
        );
      });
    });

    it('lets two groups each have their own primary', () => {
      withRepos((world) => {
        world.store.write((uow) => {
          expectWritten(
            world.repos.conversations.create(uow, { ...chat('a', world.groupId), primary: true }),
            'here',
          );
          expectWritten(
            world.repos.conversations.create(uow, {
              ...chat('b', world.otherGroupId),
              primary: true,
            }),
            'there',
          );
        });
        expect(world.repos.conversations.primary(world.groupId)?.id).toBe(conversationId('a'));
        expect(world.repos.conversations.primary(world.otherGroupId)?.id).toBe(conversationId('b'));
      });
    });

    it('refuses to promote a DM, even one that exists', () => {
      withRepos((world) => {
        const dm = world.store.write((uow) => {
          expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
          const m = expectWritten(
            world.repos.members.add(uow, member('a', world.groupId)),
            'member',
          );
          return expectWritten(
            world.repos.conversations.create(uow, {
              ...chat('d', world.groupId),
              kind: 'dm',
              memberId: m.id,
            }),
            'a DM',
          );
        });
        let caught: unknown;
        try {
          world.store.write((uow) =>
            world.repos.conversations.setPrimary(uow, world.groupId, dm.id),
          );
        } catch (error) {
          caught = error;
        }
        // `create` refuses a DM that *asks* to be primary; this is the other door — promoting one
        // that already exists. `conversations_primary_ck` would catch it, but only as a constraint
        // name, and the demotion of the current primary would already have happened.
        expect(caught).toBeInstanceOf(StorageError);
        expect((caught as StorageError).message).toContain('must be a group conversation');
      });
    });

    it('refuses to promote a conversation in another group, as not_found', () => {
      withRepos((world) => {
        world.store.write((uow) =>
          world.repos.conversations.create(uow, chat('b', world.otherGroupId)),
        );
        const refused = world.store.write((uow) =>
          world.repos.conversations.setPrimary(uow, world.groupId, conversationId('b')),
        );
        expect(refused.kind).toBe('not_found');
      });
    });
  });

  it('sets and clears the title', () => {
    withRepos((world) => {
      world.store.write((uow) => world.repos.conversations.create(uow, chat('a', world.groupId)));
      const titled = world.store.write((uow) =>
        expectWritten(
          world.repos.conversations.setTitle(uow, world.groupId, conversationId('a'), 'Kitchen'),
          'a title',
        ),
      );
      expect(titled.title).toBe('Kitchen');
      const cleared = world.store.write((uow) =>
        expectWritten(
          world.repos.conversations.setTitle(uow, world.groupId, conversationId('a'), null),
          'a cleared title',
        ),
      );
      expect(cleared.title).toBeUndefined();
    });
  });

  it('lists by kind, scoped to the group', () => {
    withRepos((world) => {
      world.store.write((uow) => {
        expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
        const m = expectWritten(world.repos.members.add(uow, member('a', world.groupId)), 'member');
        expectWritten(world.repos.conversations.create(uow, chat('a', world.groupId)), 'a group');
        expectWritten(
          world.repos.conversations.create(uow, {
            ...chat('d', world.groupId),
            kind: 'dm',
            memberId: m.id,
          }),
          'a dm',
        );
        expectWritten(
          world.repos.conversations.create(uow, chat('b', world.otherGroupId)),
          'other',
        );
      });
      expect(world.repos.conversations.list(world.groupId)).toHaveLength(2);
      expect(world.repos.conversations.list(world.groupId, { kind: 'dm' })).toHaveLength(1);
      expect(world.repos.conversations.list(world.groupId, { kind: 'group' })).toHaveLength(1);
      expect(world.repos.conversations.list(ABSENT_GROUP)).toHaveLength(0);
    });
  });
});
