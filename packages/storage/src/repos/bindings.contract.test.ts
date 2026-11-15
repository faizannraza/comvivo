/**
 * `ChatBindingReader`/`ChatBindingRepository` against `02` §3.3.1, `06` §3.20–§3.21 and
 * `01` §14 **A27** (`M3-T1`).
 *
 * Two of `M3-T1`'s four acceptance criteria live here, and both are assertions about what is
 * **not** written:
 *
 *  - an unclaimed chat persists one `chat_bindings` row and nothing else — no conversation, no
 *    messages, no persons. That is A27, and it is the difference between "somebody added the bot
 *    to a chat" and "a group owns this chat";
 *  - a chat migration re-points the conversation, writes the alias and wakes the queued outbox
 *    rows **in one transaction**, so a crash cannot leave messages aimed at an id the platform no
 *    longer accepts.
 *
 * The third — single use under concurrency — needs real threads and has its own file,
 * `onboarding.concurrency.int.test.ts`. The fourth is a benchmark, `B6` in
 * `bench/storage.bench.ts`.
 */
import { expectWritten } from '@comvivo/core';
import { internedId, type ReaderSetId } from '@comvivo/shared';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import {
  conversationId,
  groupLabel,
  member,
  outboxId,
  person,
  personId,
  T0,
  withRepos,
} from './testing/harness.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (ms: number) => Temporal.Instant.fromEpochMilliseconds(T0.epochMilliseconds + ms);

describe('an unclaimed chat (M3-T1 AC, 01 §14 A27)', () => {
  it('persists one chat_bindings row and nothing else', () => {
    withRepos((world) => {
      const seen = world.store.write((uow) =>
        expectWritten(
          world.repos.chatBindings.seen(uow, {
            channel: 'simulator',
            platformChatId: 'chat-stray',
            firstSeenAt: T0,
            leaveAt: at(HOUR),
          }),
          'the unclaimed chat',
        ),
      );
      expect(seen.status).toBe('unclaimed');
      // Absent, not null. A group id on an unclaimed row would say which group somebody tried to
      // add the bot for, which is exactly the fact an accidental add must not leave behind.
      expect(seen.groupId).toBeUndefined();
      expect(seen.conversationId).toBeUndefined();

      // The AC's own words: zero `messages`, zero `persons`. Counted in SQL rather than through a
      // reader, because a reader filters by group and would answer "none you can see" for a row
      // that exists.
      const count = (table: string): number =>
        (world.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect(count('chat_bindings')).toBe(1);
      expect(count('messages')).toBe(0);
      expect(count('persons')).toBe(0);
      expect(count('conversations')).toBe(0);
      expect(count('members')).toBe(0);
      expect(count('channel_identities')).toBe(0);
    });
  });

  it('is idempotent, because the first thing a new chat does is talk at once', () => {
    withRepos((world) => {
      const chat = { channel: 'simulator' as const, platformChatId: 'chat-busy', firstSeenAt: T0 };
      const [first, second] = world.store.write((uow) => [
        expectWritten(world.repos.chatBindings.seen(uow, chat), 'the first hello'),
        expectWritten(
          world.repos.chatBindings.seen(uow, { ...chat, firstSeenAt: at(MINUTE) }),
          'the second hello',
        ),
      ]);
      expect(second.id).toBe(first.id);
      // The **first** sighting's instant survives, because `leave_at` is an hour after first
      // contact and a chat that keeps talking must not keep postponing its own departure.
      expect(second.firstSeenAt.epochMilliseconds).toBe(T0.epochMilliseconds);
    });
  });

  it('posts the unclaimed notice once, and says so by refusing the second stamp', () => {
    withRepos((world) => {
      const binding = world.store.write((uow) =>
        expectWritten(
          world.repos.chatBindings.seen(uow, {
            channel: 'simulator',
            platformChatId: 'chat-once',
            firstSeenAt: T0,
          }),
          'the chat',
        ),
      );
      world.store.write((uow) => {
        world.repos.chatBindings.noticePosted(uow, binding.id, at(MINUTE));
        world.repos.chatBindings.noticePosted(uow, binding.id, at(2 * MINUTE));
      });
      // The first stamp stands. `06` §3.20.1 posts the notice once per chat and posts it again only
      // after a remove and re-add, so a second call must be a no-op rather than a refresh.
      expect(
        world.repos.chatBindings.byPlatformChat('simulator', 'chat-once')?.unclaimedNoticeAt
          ?.epochMilliseconds,
      ).toBe(at(MINUTE).epochMilliseconds);
    });
  });

  it('lists only the chats whose leave time has passed, oldest first', () => {
    withRepos((world) => {
      world.store.write((uow) => {
        for (const [tag, leaveAt] of [
          ['late', at(2 * HOUR)],
          ['early', at(HOUR)],
          ['later', at(3 * HOUR)],
        ] as const) {
          expectWritten(
            world.repos.chatBindings.seen(uow, {
              channel: 'simulator',
              platformChatId: `chat-${tag}`,
              firstSeenAt: T0,
              leaveAt,
            }),
            tag,
          );
        }
        // No `leave_at` at all: `06` §3.20.1 leaves "where it can", and on Slack it stays silent.
        expectWritten(
          world.repos.chatBindings.seen(uow, {
            channel: 'slack',
            platformChatId: 'chat-stays',
            firstSeenAt: T0,
          }),
          'the Slack chat',
        );
      });
      expect(
        world.repos.chatBindings.dueToLeave(at(2 * HOUR + 1), 10).map((row) => row.platformChatId),
      ).toEqual(['chat-early', 'chat-late']);
    });
  });
});

describe('binding and detaching a chat (06 §3.20.2)', () => {
  it('binds to a group and conversation, and keeps the row when the bot is removed', () => {
    withRepos((world) => {
      const bound = world.store.write((uow) => {
        const binding = expectWritten(
          world.repos.chatBindings.seen(uow, {
            channel: 'simulator',
            platformChatId: 'chat-bound',
            firstSeenAt: T0,
          }),
          'the chat',
        );
        const conversation = expectWritten(
          world.repos.conversations.create(uow, {
            id: conversationId('bnd'),
            groupId: world.groupId,
            channel: 'simulator',
            platformChatId: 'chat-bound',
            kind: 'group',
            boundAt: T0,
          }),
          'the conversation',
        );
        return expectWritten(
          world.repos.chatBindings.bind(uow, binding.id, {
            groupId: world.groupId,
            conversationId: conversation.id,
          }),
          'the binding',
        );
      });
      expect(bound.status).toBe('bound');
      expect(bound.groupId).toBe(world.groupId);

      const detached = world.store.write((uow) =>
        expectWritten(world.repos.chatBindings.detach(uow, bound.id, at(HOUR)), 'the detach'),
      );
      // Resumable for 30 days (`06` §3.20.2), so the row survives and keeps its group: re-adding
      // the bot to a chat it was once bound to should resume rather than start over, and
      // `/village resume` needs the group to resume *to*.
      expect(detached.status).toBe('detached');
      expect(detached.groupId).toBe(world.groupId);
      expect(detached.detachedAt?.epochMilliseconds).toBe(at(HOUR).epochMilliseconds);
    });
  });

  it('refuses a binding whose conversation belongs to another group (I4)', () => {
    withRepos((world) => {
      expect(() =>
        world.store.write((uow) => {
          const binding = expectWritten(
            world.repos.chatBindings.seen(uow, {
              channel: 'simulator',
              platformChatId: 'chat-crossed',
              firstSeenAt: T0,
            }),
            'the chat',
          );
          expectWritten(
            world.repos.conversations.create(uow, {
              id: conversationId('xth'),
              groupId: world.otherGroupId,
              channel: 'simulator',
              platformChatId: 'chat-crossed',
              kind: 'group',
              boundAt: T0,
            }),
            'the other group’s conversation',
          );
          // The group and the conversation disagree. `trg_chat_bindings_conversation_group_upd`
          // is what refuses it — a `CHECK` cannot reach another table, so group isolation here is
          // a trigger rather than a constraint.
          return world.repos.chatBindings.bind(uow, binding.id, {
            groupId: world.groupId,
            conversationId: conversationId('xth'),
          });
        }),
      ).toThrow(
        // By **code**, which is what a caller branches on. The message is prose and the raised
        // string is SQLite's; `raised-codes.int.test.ts` is what keeps the mapping between them
        // honest, and this assertion is what made its absence visible.
        expect.objectContaining({ storageCode: 'I4_PARENT_GROUP_MISMATCH' }),
      );
    });
  });
});

describe('a chat migration (M3-T1 AC; 06 §3.21.1)', () => {
  it('re-points the conversation, writes the alias and wakes the queued rows in one tx', () => {
    withRepos((world) => {
      const fixture = world.store.write((uow) => {
        expectWritten(world.repos.persons.create(uow, person('mg')), 'a person');
        expectWritten(world.repos.members.add(uow, member('mg', world.groupId)), 'a member');
        const conversation = expectWritten(
          world.repos.conversations.create(uow, {
            id: conversationId('mgr'),
            groupId: world.groupId,
            channel: 'telegram',
            platformChatId: '-100',
            kind: 'group',
            boundAt: T0,
          }),
          'the conversation',
        );
        const binding = expectWritten(
          world.repos.chatBindings.seen(uow, {
            channel: 'telegram',
            platformChatId: '-100',
            firstSeenAt: T0,
          }),
          'the chat',
        );
        expectWritten(
          world.repos.chatBindings.bind(uow, binding.id, {
            groupId: world.groupId,
            conversationId: conversation.id,
          }),
          'the binding',
        );
        world.repos.labels.intern(uow, groupLabel(world.groupId));
        const readerSet = internedId(
          (
            world.db.prepare('SELECT id FROM reader_sets ORDER BY id LIMIT 1').get() as {
              id: number;
            }
          ).id,
          'reader_sets',
        ) as ReaderSetId;
        // Two queued rows, one of them backed off by five minutes after failing against the old
        // id — the case the wake exists for.
        for (const [tag, nextAttemptAt] of [
          ['m1f', T0],
          ['m2f', at(5 * MINUTE)],
        ] as const) {
          world.repos.outbox.enqueue(uow, {
            id: outboxId(tag),
            groupId: world.groupId,
            conversationId: conversation.id,
            idempotencyKey: `trn:${tag}`,
            messageClass: 'reply',
            payload: { text: `reply ${tag}` },
            contentHash: new Uint8Array(32).fill(tag.codePointAt(1) ?? 1),
            audienceReaderSetId: readerSet,
            guardRef: `grd-${tag}`,
            manifestLabelIds: [],
            nextAttemptAt,
          });
        }
        return { conversationId: conversation.id, bindingId: binding.id };
      });

      // Before: two distinct due times, one of them five minutes out. Snapshotted so the wake's
      // effect is a *change* rather than a coincidence — both rows ending up equal to the
      // migration's instant would also be true if they had started there.
      expect(
        world.repos.outbox
          .queued(fixture.conversationId, 10)
          .map((row) => row.nextAttemptAt.epochMilliseconds),
      ).toEqual([T0.epochMilliseconds, at(5 * MINUTE).epochMilliseconds]);

      const { moved, movedAt } = world.store.write((uow) => ({
        moved: expectWritten(
          world.repos.chatBindings.migrateChat(uow, {
            channel: 'telegram',
            fromPlatformChatId: '-100',
            toPlatformChatId: '-1001234',
          }),
          'the migration',
        ),
        // The transaction's own instant, because that is what the wake writes. Asserting `T0`
        // would assert the fixture's clock and the harness's store reads a real one.
        movedAt: uow.now,
      }));
      expect(moved.conversationId).toBe(fixture.conversationId);
      expect(moved.outboxRetargeted).toBe(2);

      // The new id resolves, the old one resolves **through the alias**, and the binding moved
      // with it. Telegram's clients send all new messages to the supergroup, but events already in
      // flight carry the basic group's id (`06` §3.21.1).
      expect(world.repos.conversations.byPlatform(world.groupId, 'telegram', '-1001234')?.id).toBe(
        fixture.conversationId,
      );
      expect(
        world.repos.conversations.byPlatform(world.groupId, 'telegram', '-100'),
      ).toBeUndefined();
      expect(world.repos.chatBindings.conversationByAlias('telegram', '-100')).toBe(
        fixture.conversationId,
      );
      expect(world.repos.chatBindings.byPlatformChat('telegram', '-1001234')?.id).toBe(
        fixture.bindingId,
      );

      // And the backed-off row is due now, so the dispatcher's next pass sends it on the new id
      // instead of waiting out a backoff earned against an address that no longer exists.
      const due = world.repos.outbox.queued(fixture.conversationId, 10);
      expect(due.map((row) => row.nextAttemptAt.epochMilliseconds)).toEqual([
        movedAt.epochMilliseconds,
        movedAt.epochMilliseconds,
      ]);
      // Both rows, not only the one that was already due. The second is the case the wake exists
      // for: it had been backed off after failing against the old id, and without this it would
      // wait out a delay earned against an address Telegram no longer accepts.
    });
  });

  it('leaves a chat with no conversation alone, because there is nothing to re-point', () => {
    withRepos((world) => {
      const result = world.store.write((uow) => {
        expectWritten(
          world.repos.chatBindings.seen(uow, {
            channel: 'telegram',
            platformChatId: '-200',
            firstSeenAt: T0,
          }),
          'an unclaimed chat',
        );
        return world.repos.chatBindings.migrateChat(uow, {
          channel: 'telegram',
          fromPlatformChatId: '-200',
          toPlatformChatId: '-1005678',
        });
      });
      // `not_found` rather than a silent success: an unclaimed chat that migrates has no
      // conversation and no queued sends, and A27 says it must not acquire either as a side effect.
      expect(result.kind).toBe('not_found');
    });
  });
});

describe('DM contexts (06 §3.4, 03 E20)', () => {
  it('records the group a DM is about, and forgets it when nobody has chosen', () => {
    withRepos((world) => {
      world.store.write((uow) => {
        expectWritten(world.repos.persons.create(uow, person('dm')), 'a person');
        world.repos.chatBindings.setDmContext(uow, {
          channel: 'simulator',
          platformChatId: 'dm-1',
          personId: personId('dm'),
          activeGroupId: world.groupId,
          setAt: T0,
        });
      });
      expect(world.repos.chatBindings.activeDmGroup('simulator', 'dm-1')).toBe(world.groupId);

      world.store.write((uow) => {
        world.repos.chatBindings.setDmContext(uow, {
          channel: 'simulator',
          platformChatId: 'dm-1',
          personId: personId('dm'),
          setAt: at(MINUTE),
        });
      });
      // `undefined`, which `03` E20 treats as "nobody has chosen" — a real state the DM router
      // asks about, not a missing value.
      expect(world.repos.chatBindings.activeDmGroup('simulator', 'dm-1')).toBeUndefined();
    });
  });
});
