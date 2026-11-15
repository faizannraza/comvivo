/**
 * `MessageReader`/`MessageRepository` against `02` §3.7.1 and §3.3.3 (`M1-T17`).
 *
 * Three things here are load-bearing beyond the generic conventions:
 *
 *  - **Dedupe (Q-ING-1).** A platform retries any ack it did not see, so redelivery is routine.
 *    The repository must recognise it and name the message already stored.
 *  - **The eligibility filter (I1).** Every read that returns content takes an `EligibleLabelSet`
 *    and must return nothing outside it — including when the set is *empty*, which is the case a
 *    wrong `IN ()` would turn into "everything".
 *  - **Window ordering.** `limit` means "the most recent N", returned oldest first. A forward scan
 *    reversed by the caller would give the oldest N and look plausible.
 */
import type { NotPromise } from '@comvivo/core';
import { computeEligible, type EligibleLabelSet, expectWritten, type Label } from '@comvivo/core';
import { StorageError } from '@comvivo/shared';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { dedupeKey } from './messages.js';
import {
  ABSENT_GROUP,
  attachmentId,
  conversationId,
  groupLabel,
  member,
  messageId,
  person,
  T0,
  withRepos,
} from './testing/harness.js';

/** Everything eligible, which is what `StubInformationFlow` says about a group-readable label. */
function eligibleFor(
  world: Parameters<Parameters<typeof withRepos>[0]>[0],
  labels: readonly Label[],
): EligibleLabelSet {
  const snapshot = world.repos.groups.snapshot(world.groupId);
  if (snapshot === undefined) throw new Error('fixture: no group');
  const interned = world.store.write((uow) =>
    labels.map((label) => [world.repos.labels.intern(uow, label), label] as const),
  );
  return computeEligible(new Map(interned), { kind: 'group', groupId: world.groupId }, snapshot, {
    canRead: () => true,
  });
}

/** An eligible set that admits nothing — the case a wrong `IN ()` turns into "everything". */
function eligibleNone(world: Parameters<Parameters<typeof withRepos>[0]>[0]): EligibleLabelSet {
  const snapshot = world.repos.groups.snapshot(world.groupId);
  if (snapshot === undefined) throw new Error('fixture: no group');
  return computeEligible(new Map(), { kind: 'group', groupId: world.groupId }, snapshot, {
    canRead: () => false,
  });
}

describe('MessageRepository', () => {
  /** A group with one member and one bound conversation, built through the repositories. */
  function withChat<T>(
    fn: (
      world: Parameters<Parameters<typeof withRepos>[0]>[0],
      ids: { conversationId: ReturnType<typeof conversationId>; memberId: string },
    ) => NotPromise<T>,
  ): T {
    return withRepos((world) => {
      const ids = world.store.write((uow) => {
        expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
        const m = expectWritten(world.repos.members.add(uow, member('a', world.groupId)), 'member');
        const c = expectWritten(
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
        return { conversationId: c.id, memberId: m.id };
      });
      return fn(world, ids);
    });
  }

  it('inserts a message, interning its label', () => {
    withChat((world, ids) => {
      const inserted = world.store.write((uow) =>
        expectWritten(
          world.repos.messages.insert(
            uow,
            {
              id: messageId('a'),
              groupId: world.groupId,
              conversationId: ids.conversationId,
              kind: 'member',
              text: 'who is cooking tonight',
              sentAt: T0,
              receivedAt: T0,
            },
            groupLabel(world.groupId),
          ),
          'a message',
        ),
      );
      // An interned id, not a caller-supplied one: `02` §3.2 makes `LabelStore` the only way one
      // comes into being.
      expect(inserted.labelId).toBeGreaterThan(0);
      expect(inserted.rid).toBeGreaterThan(0);
      expect(inserted.editCount).toBe(0);
      expect(inserted.untrusted).toBe(false);
      expect(inserted.deliveredLate).toBe(false);
      expect(inserted.text).toBe('who is cooking tonight');
    });
  });

  describe('dedupe (Q-ING-1)', () => {
    it('derives the key the way 02 §3.3.3 specifies', () => {
      // Asserted against the derivation rather than against itself: a NUL separator, so
      // `('tg','a','bc')` and `('tg','ab','c')` cannot collide.
      expect(dedupeKey('tg', 'a', 'bc').equals(dedupeKey('tg', 'ab', 'c'))).toBe(false);
      expect(dedupeKey('tg', 'c1', 'm1').equals(dedupeKey('tg', 'c1', 'm1'))).toBe(true);
      expect(dedupeKey('tg', 'c1', 'm1').equals(dedupeKey('wa', 'c1', 'm1'))).toBe(false);
      // 16 bytes, not the whole digest.
      expect(dedupeKey('tg', 'c1', 'm1')).toHaveLength(16);
    });

    it('names the stored message when the platform redelivers', () => {
      withChat((world, ids) => {
        const first = world.store.write((uow) =>
          expectWritten(
            world.repos.messages.insert(
              uow,
              {
                id: messageId('a'),
                groupId: world.groupId,
                conversationId: ids.conversationId,
                kind: 'member',
                platformMessageId: 'p-1',
                text: 'hello',
                sentAt: T0,
                receivedAt: T0,
              },
              groupLabel(world.groupId),
            ),
            'the first delivery',
          ),
        );
        // The same platform message under a *different* id, which is what a retry looks like once
        // the id is generated per attempt.
        const again = world.store.write((uow) =>
          world.repos.messages.insert(
            uow,
            {
              id: messageId('b'),
              groupId: world.groupId,
              conversationId: ids.conversationId,
              kind: 'member',
              platformMessageId: 'p-1',
              text: 'hello',
              sentAt: T0,
              receivedAt: T0,
            },
            groupLabel(world.groupId),
          ),
        );
        expect(again.kind).toBe('duplicate');
        if (again.kind !== 'duplicate') return;
        expect(again.existingId).toBe(first.id);
        // One row, so the group chat does not show the message twice.
        expect(
          world.repos.messagesUnfiltered.windowUnfiltered({
            conversationId: ids.conversationId,
            limit: 10,
          }),
        ).toHaveLength(1);
      });
    });

    it('does not dedupe messages with no platform id', () => {
      withChat((world, ids) => {
        // `assistant` messages and web-chat messages have no platform id, and two of them with the
        // same text are two messages. A dedupe key over a NULL would collapse them.
        for (const tag of ['a', 'b']) {
          world.store.write((uow) =>
            expectWritten(
              world.repos.messages.insert(
                uow,
                {
                  id: messageId(tag),
                  groupId: world.groupId,
                  conversationId: ids.conversationId,
                  kind: 'assistant',
                  text: 'on it',
                  sentAt: T0,
                  receivedAt: T0,
                },
                groupLabel(world.groupId),
              ),
              `message ${tag}`,
            ),
          );
        }
        expect(
          world.repos.messagesUnfiltered.windowUnfiltered({
            conversationId: ids.conversationId,
            limit: 10,
          }),
        ).toHaveLength(2);
      });
    });

    it('finds a message by its platform id — Q-ING-5', () => {
      withChat((world, ids) => {
        world.store.write((uow) =>
          world.repos.messages.insert(
            uow,
            {
              id: messageId('a'),
              groupId: world.groupId,
              conversationId: ids.conversationId,
              kind: 'member',
              platformMessageId: 'p-1',
              text: 'hello',
              sentAt: T0,
              receivedAt: T0,
            },
            groupLabel(world.groupId),
          ),
        );
        expect(world.repos.messages.byPlatformId(ids.conversationId, 'p-1')?.id).toBe(
          messageId('a'),
        );
        expect(world.repos.messages.byPlatformId(ids.conversationId, 'p-2')).toBeUndefined();
      });
    });
  });

  describe('group isolation (I4)', () => {
    it('refuses a message naming a conversation in another group', () => {
      withChat((world, ids) => {
        void ids;
        const elsewhere = world.store.write((uow) =>
          expectWritten(
            world.repos.conversations.create(uow, {
              id: conversationId('b'),
              groupId: world.otherGroupId,
              channel: 'simulator',
              platformChatId: 'chat-b',
              kind: 'group',
              boundAt: T0,
            }),
            'a conversation elsewhere',
          ),
        );
        let caught: unknown;
        try {
          world.store.write((uow) =>
            world.repos.messages.insert(
              uow,
              {
                id: messageId('a'),
                groupId: world.groupId,
                conversationId: elsewhere.id,
                kind: 'member',
                text: 'x',
                sentAt: T0,
                receivedAt: T0,
              },
              groupLabel(world.groupId),
            ),
          );
        } catch (error) {
          caught = error;
        }
        // Thrown, not returned: the foreign keys both pass (the group exists, the conversation
        // exists) and only their *agreement* is violated. A `not_found` would let ingestion treat
        // a group-isolation error as a missing row and carry on.
        expect(caught).toBeInstanceOf(StorageError);
        expect((caught as StorageError).message).toContain('another group');
      });
    });

    it('refuses a label from another group', () => {
      withChat((world, ids) => {
        let caught: unknown;
        try {
          world.store.write((uow) =>
            world.repos.messages.insert(
              uow,
              {
                id: messageId('a'),
                groupId: world.groupId,
                conversationId: ids.conversationId,
                kind: 'member',
                text: 'x',
                sentAt: T0,
                receivedAt: T0,
              },
              groupLabel(world.otherGroupId),
            ),
          );
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(StorageError);
        expect((caught as StorageError).message).toContain('label of another group');
      });
    });

    it('does not find a message from another group by id', () => {
      withChat((world, ids) => {
        world.store.write((uow) =>
          world.repos.messages.insert(
            uow,
            {
              id: messageId('a'),
              groupId: world.groupId,
              conversationId: ids.conversationId,
              kind: 'member',
              text: 'x',
              sentAt: T0,
              receivedAt: T0,
            },
            groupLabel(world.groupId),
          ),
        );
        expect(world.repos.messages.byId(world.groupId, messageId('a'))).toBeDefined();
        expect(world.repos.messages.byId(world.otherGroupId, messageId('a'))).toBeUndefined();
        expect(world.repos.messages.byId(ABSENT_GROUP, messageId('a'))).toBeUndefined();
      });
    });
  });

  describe('the eligibility filter (I1)', () => {
    it('returns nothing at all for an empty eligible set', () => {
      withChat((world, ids) => {
        world.store.write((uow) =>
          world.repos.messages.insert(
            uow,
            {
              id: messageId('a'),
              groupId: world.groupId,
              conversationId: ids.conversationId,
              kind: 'member',
              text: 'secret',
              sentAt: T0,
              receivedAt: T0,
            },
            groupLabel(world.groupId),
          ),
        );
        const none = eligibleNone(world);
        expect(none.ids).toHaveLength(0);
        // The direction that matters. An `IN ()` that emitted a tautology would turn "this
        // audience may read nothing" into "may read everything", which is the worst possible way
        // for `I1` to fail — and the row *is* there, so this is not vacuous.
        expect(
          world.repos.messages.window({ conversationId: ids.conversationId, limit: 10 }, none),
        ).toHaveLength(0);
        expect(world.repos.messages.hydrate([messageId('a')], none)).toHaveLength(0);
        expect(
          world.repos.messages.bySender(world.groupId, ids.memberId as never, { limit: 10 }, none),
        ).toHaveLength(0);
        // And unfiltered sees it, which is what proves the filter is what hid it.
        expect(
          world.repos.messagesUnfiltered.windowUnfiltered({
            conversationId: ids.conversationId,
            limit: 10,
          }),
        ).toHaveLength(1);
      });
    });

    it('returns only the messages whose label is eligible', () => {
      withChat((world, ids) => {
        const readable = groupLabel(world.groupId);
        const hidden = groupLabel(world.groupId, { sensitivity: 'sensitive' });
        world.store.write((uow) => {
          world.repos.messages.insert(
            uow,
            {
              id: messageId('a'),
              groupId: world.groupId,
              conversationId: ids.conversationId,
              kind: 'member',
              text: 'ordinary',
              sentAt: T0,
              receivedAt: T0,
            },
            readable,
          );
          world.repos.messages.insert(
            uow,
            {
              id: messageId('b'),
              groupId: world.groupId,
              conversationId: ids.conversationId,
              kind: 'member',
              text: 'private',
              sentAt: T0,
              receivedAt: T0,
            },
            hidden,
          );
        });
        // Only the first label is eligible, so only the first message comes back.
        const eligible = eligibleFor(world, [readable]);
        const visible = world.repos.messages.window(
          { conversationId: ids.conversationId, limit: 10 },
          eligible,
        );
        expect(visible.map((m) => m.id)).toEqual([messageId('a')]);
        // Both are stored.
        expect(
          world.repos.messagesUnfiltered.windowUnfiltered({
            conversationId: ids.conversationId,
            limit: 10,
          }),
        ).toHaveLength(2);
      });
    });

    it('drops an ineligible id silently when hydrating', () => {
      withChat((world, ids) => {
        const readable = groupLabel(world.groupId);
        const hidden = groupLabel(world.groupId, { untrusted: true });
        world.store.write((uow) => {
          world.repos.messages.insert(
            uow,
            {
              id: messageId('a'),
              groupId: world.groupId,
              conversationId: ids.conversationId,
              kind: 'member',
              text: 'a',
              sentAt: T0,
              receivedAt: T0,
            },
            readable,
          );
          world.repos.messages.insert(
            uow,
            {
              id: messageId('b'),
              groupId: world.groupId,
              conversationId: ids.conversationId,
              kind: 'member',
              text: 'b',
              sentAt: T0,
              receivedAt: T0,
            },
            hidden,
          );
        });
        // Silent and deliberate: `02` §3.3.9 makes a trace's manifest hold ids only so the
        // dashboard re-checks at render time. Raising would make a trace unreadable to anyone
        // whose eligible set has since narrowed.
        const hydrated = world.repos.messages.hydrate(
          [messageId('a'), messageId('b')],
          eligibleFor(world, [readable]),
        );
        expect(hydrated.map((m) => m.id)).toEqual([messageId('a')]);
      });
    });
  });

  describe('the context window (Q-CTX-1)', () => {
    it('returns the most recent N, oldest first', () => {
      withChat((world, ids) => {
        const label = groupLabel(world.groupId);
        world.store.write((uow) => {
          for (const tag of ['a', 'b', 'c', 'd']) {
            world.repos.messages.insert(
              uow,
              {
                id: messageId(tag),
                groupId: world.groupId,
                conversationId: ids.conversationId,
                kind: 'member',
                text: tag,
                sentAt: T0,
                receivedAt: T0,
              },
              label,
            );
          }
        });
        const window = world.repos.messages.window(
          { conversationId: ids.conversationId, limit: 2 },
          eligibleFor(world, [label]),
        );
        // The last two, in reading order. A forward scan reversed by the caller would give
        // `['a','b']` — the oldest two — and look just as plausible.
        expect(window.map((m) => m.text)).toEqual(['c', 'd']);
      });
    });

    it('pages further back on rid, not on sentAt', () => {
      withChat((world, ids) => {
        const label = groupLabel(world.groupId);
        // Deliberately out of order in `sent_at`: a backfilled message carries a `sent_at` from
        // before messages already stored, and two messages can share a millisecond. Paging on a
        // non-unique, non-monotonic key either skips rows or repeats them.
        const times = [
          Temporal.Instant.from('2026-11-08T12:00:02Z'),
          Temporal.Instant.from('2026-11-08T12:00:00Z'),
          Temporal.Instant.from('2026-11-08T12:00:01Z'),
        ];
        world.store.write((uow) => {
          for (const [index, tag] of ['a', 'b', 'c'].entries()) {
            const sentAt = times[index];
            if (sentAt === undefined) throw new Error('fixture');
            world.repos.messages.insert(
              uow,
              {
                id: messageId(tag),
                groupId: world.groupId,
                conversationId: ids.conversationId,
                kind: 'member',
                text: tag,
                sentAt,
                receivedAt: T0,
              },
              label,
            );
          }
        });
        const eligible = eligibleFor(world, [label]);
        const newest = world.repos.messages.window(
          { conversationId: ids.conversationId, limit: 1 },
          eligible,
        );
        expect(newest.map((m) => m.text)).toEqual(['c']);
        const older = world.repos.messages.window(
          { conversationId: ids.conversationId, limit: 2, beforeRid: newest[0]?.rid },
          eligible,
        );
        // Insertion order, which is what `rid` records — not `sent_at` order, which would be
        // `['b','c']` and would have skipped `a` entirely.
        expect(older.map((m) => m.text)).toEqual(['a', 'b']);
      });
    });

    it('scopes the window to one conversation', () => {
      withChat((world, ids) => {
        const label = groupLabel(world.groupId);
        const second = world.store.write((uow) =>
          expectWritten(
            world.repos.conversations.create(uow, {
              id: conversationId('b'),
              groupId: world.groupId,
              channel: 'simulator',
              platformChatId: 'chat-b2',
              kind: 'group',
              boundAt: T0,
            }),
            'a second conversation',
          ),
        );
        world.store.write((uow) => {
          world.repos.messages.insert(
            uow,
            {
              id: messageId('a'),
              groupId: world.groupId,
              conversationId: ids.conversationId,
              kind: 'member',
              text: 'here',
              sentAt: T0,
              receivedAt: T0,
            },
            label,
          );
          world.repos.messages.insert(
            uow,
            {
              id: messageId('b'),
              groupId: world.groupId,
              conversationId: second.id,
              kind: 'member',
              text: 'there',
              sentAt: T0,
              receivedAt: T0,
            },
            label,
          );
        });
        const eligible = eligibleFor(world, [label]);
        expect(
          world.repos.messages
            .window({ conversationId: ids.conversationId, limit: 10 }, eligible)
            .map((m) => m.text),
        ).toEqual(['here']);
      });
    });
  });

  it('pages the unfiltered window the same way the filtered one does', () => {
    withChat((world, ids) => {
      const label = groupLabel(world.groupId);
      world.store.write((uow) => {
        for (const tag of ['a', 'b', 'c'] as const) {
          world.repos.messages.insert(
            uow,
            {
              id: messageId(tag),
              groupId: world.groupId,
              conversationId: ids.conversationId,
              kind: 'member',
              text: tag,
              sentAt: T0,
              receivedAt: T0,
            },
            label,
          );
        }
      });
      const newest = world.repos.messagesUnfiltered.windowUnfiltered({
        conversationId: ids.conversationId,
        limit: 1,
      });
      expect(newest.map((m) => m.text)).toEqual(['c']);
      // The same contract on purpose, so retention and export can reuse a caller's paging logic
      // without a second set of assumptions about what `limit` means.
      const older = world.repos.messagesUnfiltered.windowUnfiltered({
        conversationId: ids.conversationId,
        limit: 2,
        beforeRid: newest[0]?.rid,
      });
      expect(older.map((m) => m.text)).toEqual(['a', 'b']);
    });
  });

  describe('edits and tombstones (02 §3.3.3, 06 §3.24)', () => {
    it('overwrites the text and counts the edit', () => {
      withChat((world, ids) => {
        const inserted = world.store.write((uow) =>
          expectWritten(
            world.repos.messages.insert(
              uow,
              {
                id: messageId('a'),
                groupId: world.groupId,
                conversationId: ids.conversationId,
                kind: 'member',
                text: 'tomorow',
                sentAt: T0,
                receivedAt: T0,
              },
              groupLabel(world.groupId),
            ),
            'a message',
          ),
        );
        const edited = world.store.write((uow) =>
          expectWritten(
            world.repos.messages.applyEdit(uow, world.groupId, inserted.id, {
              text: 'tomorrow',
              editedAt: T0,
            }),
            'an edit',
          ),
        );
        expect(edited.text).toBe('tomorrow');
        expect(edited.editCount).toBe(1);
        expect(edited.editedAt?.toString()).toBe(T0.toString());
        // The prior text is gone: `02` §3.3.3 is explicit, and the reason is that an edit history
        // is a record of what someone decided not to say.
        expect(JSON.stringify(edited)).not.toContain('tomorow');
      });
    });

    it('tells a platform delete apart from an erasure', () => {
      withChat((world, ids) => {
        world.store.write((uow) => {
          for (const tag of ['a', 'b']) {
            world.repos.messages.insert(
              uow,
              {
                id: messageId(tag),
                groupId: world.groupId,
                conversationId: ids.conversationId,
                kind: 'member',
                text: 'oops',
                sentAt: T0,
                receivedAt: T0,
              },
              groupLabel(world.groupId),
            );
          }
        });
        const deleted = world.store.write((uow) =>
          expectWritten(
            world.repos.messages.tombstone(
              uow,
              world.groupId,
              messageId('a'),
              'platform_delete',
              T0,
            ),
            'a platform delete',
          ),
        );
        const redacted = world.store.write((uow) =>
          expectWritten(
            world.repos.messages.tombstone(uow, world.groupId, messageId('b'), 'redaction', T0),
            'a redaction',
          ),
        );
        expect(deleted.text).toBe('');
        expect(deleted.deletedAt).toBeDefined();
        expect(deleted.redactedAt).toBeDefined();
        // An erasure stamps only `redacted_at`, so an operator can tell "the sender deleted this"
        // from "we erased a person" — the first is the member's act and the second is ours.
        expect(redacted.deletedAt).toBeUndefined();
        expect(redacted.redactedAt).toBeDefined();
        // The rows stay, so everything referencing them still resolves.
        expect(
          world.repos.messagesUnfiltered.windowUnfiltered({
            conversationId: ids.conversationId,
            limit: 10,
          }),
        ).toHaveLength(2);
      });
    });
  });

  describe('retention (Q-RET-1)', () => {
    it('deletes only the expired, up to the limit', () => {
      withChat((world, ids) => {
        const past = Temporal.Instant.from('2026-11-01T00:00:00Z');
        const future = Temporal.Instant.from('2027-01-01T00:00:00Z');
        world.store.write((uow) => {
          for (const [tag, until] of [
            ['a', past],
            ['b', past],
            ['c', future],
            ['d', undefined],
          ] as const) {
            world.repos.messages.insert(
              uow,
              {
                id: messageId(tag),
                groupId: world.groupId,
                conversationId: ids.conversationId,
                kind: 'member',
                text: tag,
                sentAt: T0,
                receivedAt: T0,
                ...(until === undefined ? {} : { retentionUntil: until }),
              },
              groupLabel(world.groupId),
            );
          }
        });
        // `limit` is mandatory: retention runs against a database a host is also using, and an
        // unbounded DELETE would hold the write lock for as long as it takes.
        const first = world.store.write((uow) =>
          world.repos.messages.deleteExpired(uow, world.groupId, T0, 1),
        );
        expect(first).toBe(1);
        const second = world.store.write((uow) =>
          world.repos.messages.deleteExpired(uow, world.groupId, T0, 10),
        );
        expect(second).toBe(1);
        const third = world.store.write((uow) =>
          world.repos.messages.deleteExpired(uow, world.groupId, T0, 10),
        );
        expect(third).toBe(0);
        // The future one and the exempt one survive. `NULL` means exempt — a constitution pin
        // (`03`) — and not "expire immediately".
        const left = world.repos.messagesUnfiltered.windowUnfiltered({
          conversationId: ids.conversationId,
          limit: 10,
        });
        expect(left.map((m) => m.text).toSorted()).toEqual(['c', 'd']);
      });
    });

    it('does not reach into another group', () => {
      withChat((world, ids) => {
        world.store.write((uow) =>
          world.repos.messages.insert(
            uow,
            {
              id: messageId('a'),
              groupId: world.groupId,
              conversationId: ids.conversationId,
              kind: 'member',
              text: 'a',
              sentAt: T0,
              receivedAt: T0,
              retentionUntil: Temporal.Instant.from('2026-11-01T00:00:00Z'),
            },
            groupLabel(world.groupId),
          ),
        );
        const removed = world.store.write((uow) =>
          world.repos.messages.deleteExpired(uow, world.otherGroupId, T0, 10),
        );
        expect(removed).toBe(0);
        expect(world.repos.messages.byId(world.groupId, messageId('a'))).toBeDefined();
      });
    });
  });

  it('relabels without changing the message (03 declassification)', () => {
    withChat((world, ids) => {
      const before = groupLabel(world.groupId, { sensitivity: 'sensitive' });
      const after = groupLabel(world.groupId);
      const inserted = world.store.write((uow) =>
        expectWritten(
          world.repos.messages.insert(
            uow,
            {
              id: messageId('a'),
              groupId: world.groupId,
              conversationId: ids.conversationId,
              kind: 'member',
              text: 'the news',
              sentAt: T0,
              receivedAt: T0,
            },
            before,
          ),
          'a message',
        ),
      );
      const relabelled = world.store.write((uow) =>
        expectWritten(
          world.repos.messages.relabel(uow, world.groupId, inserted.id, after),
          'a relabel',
        ),
      );
      expect(relabelled.labelId).not.toBe(inserted.labelId);
      expect(relabelled.text).toBe('the news');
      // And the new label is what the reads now filter on.
      expect(
        world.repos.messages
          .window({ conversationId: ids.conversationId, limit: 10 }, eligibleFor(world, [after]))
          .map((m) => m.id),
      ).toEqual([messageId('a')]);
    });
  });

  it('reports an insert into a conversation that does not exist as not_found', () => {
    withRepos((world) => {
      const missing = world.store.write((uow) =>
        world.repos.messages.insert(
          uow,
          {
            id: messageId('a'),
            groupId: world.groupId,
            conversationId: conversationId('zz'),
            kind: 'member',
            text: 'x',
            sentAt: T0,
            receivedAt: T0,
          },
          groupLabel(world.groupId),
        ),
      );
      expect(missing.kind).toBe('not_found');
    });
  });
});

describe('attachments (02 §3.3.3; 01 §14 A25)', () => {
  /** A group with a conversation, as `withChat` builds but reachable from this block. */
  function withChat<T>(
    fn: (
      world: Parameters<Parameters<typeof withRepos>[0]>[0],
      conversation: ReturnType<typeof conversationId>,
    ) => NotPromise<T>,
  ): T {
    return withRepos((world) => {
      const conversation = world.store.write((uow) => {
        expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
        expectWritten(world.repos.members.add(uow, member('a', world.groupId)), 'member');
        return expectWritten(
          world.repos.conversations.create(uow, {
            id: conversationId('a'),
            groupId: world.groupId,
            channel: 'telegram',
            platformChatId: 'chat-a',
            kind: 'group',
            boundAt: T0,
          }),
          'a conversation',
        ).id;
      });
      return fn(world, conversation);
    });
  }

  const photo = (tag: string, overrides: Record<string, unknown> = {}) => ({
    id: attachmentId(tag),
    kind: 'image' as const,
    fileName: 'kitchen.jpg',
    mime: 'image/jpeg',
    sizeBytes: 1_482_301,
    platformRef: { channel: 'telegram' as const, data: { fileId: `AgACAg-${tag}` } },
    ...overrides,
  });

  function withPhoto<T>(
    fn: (
      world: Parameters<Parameters<typeof withRepos>[0]>[0],
      conversation: ReturnType<typeof conversationId>,
    ) => NotPromise<T>,
  ): T {
    return withChat((world, conversation) => {
      world.store.write((uow) =>
        expectWritten(
          world.repos.messages.insert(
            uow,
            {
              id: messageId('ph'),
              groupId: world.groupId,
              conversationId: conversation,
              kind: 'member',
              text: 'look at this',
              sentAt: T0,
              receivedAt: T0,
            },
            groupLabel(world.groupId),
            [photo('p1f')],
          ),
          'a message with a photo',
        ),
      );
      return fn(world, conversation);
    });
  }

  it('records the ref and nothing else — A25 forbids a download here', () => {
    withPhoto((world) => {
      const [attached] = world.repos.messages.attachments(world.groupId, messageId('ph'));
      expect(attached).toBeDefined();
      if (attached === undefined) return;
      // `pending`, no digest. The fetch job stores the file (`02` §3.11) and then the `media.*`
      // jobs read it; ingestion's 20 ms budget cannot contain a download, which is the whole of
      // A25 and the reason this status is the only one `insert` can write.
      expect(attached.status).toBe('pending');
      expect(attached.blobSha256).toBeUndefined();
      expect(attached.derivedMessageId).toBeUndefined();
      expect(attached.platformRef).toEqual({
        channel: 'telegram',
        data: { fileId: 'AgACAg-p1f' },
      });
      expect(attached.mime).toBe('image/jpeg');
      expect(attached.fileName).toBe('kitchen.jpg');
      // No blob row exists, so `attachments_blob_idx` — Q-BLOB-1's GC scan — has nothing to find.
      expect((world.db.prepare('SELECT count(*) AS n FROM blobs').get() as { n: number }).n).toBe(
        0,
      );
    });
  });

  it('carries the fetch job’s id, because the enqueue happens first', () => {
    withChat((world, conversation) => {
      // A25's ordering: the job's payload names the attachment, so the id is the caller's to mint
      // and the row carries the job it waits on. The alternative needs a second `UPDATE` to join
      // them, which is a second place the link can be left unwritten.
      const jobId = world.store.write((uow) => {
        const kind = world.repos.jobKinds.register('attachment.fetch', {
          parse: (value: unknown) => value,
          safeParse: (value: unknown) => ({ success: true as const, data: value }),
        } as never);
        const queued = world.repos.jobs.enqueue(uow, kind, {
          partitionKey: world.groupId,
          payload: { attachmentId: attachmentId('p2f') } as never,
        });
        if (queued.kind !== 'enqueued') throw new Error('fixture: the fetch job was not enqueued');
        expectWritten(
          world.repos.messages.insert(
            uow,
            {
              id: messageId('ph'),
              groupId: world.groupId,
              conversationId: conversation,
              kind: 'member',
              text: 'and this one',
              sentAt: T0,
              receivedAt: T0,
            },
            groupLabel(world.groupId),
            [photo('p2f', { fetchJobId: queued.id })],
          ),
          'a message with a photo',
        );
        return queued.id;
      });
      expect(world.repos.messages.attachments(world.groupId, messageId('ph'))[0]?.fetchJobId).toBe(
        jobId,
      );
    });
  });

  it('gives an attachment its message’s label, never a second intern', () => {
    withPhoto((world) => {
      // `02` §3.3.3: equal, by construction. Compared in SQL because `Attachment` deliberately
      // does not carry `labelId` — a caller able to see both could compare them and decide, and
      // that is a decision with one correct answer.
      const row = world.db
        .prepare(
          `SELECT a.label_id AS attachment, m.label_id AS message
             FROM message_attachments a JOIN messages m ON m.id = a.message_id`,
        )
        .get() as { attachment: number; message: number };
      expect(row.attachment).toBe(row.message);
    });
  });

  it('writes several attachments in one transaction, oldest first', () => {
    withChat((world, conversation) => {
      world.store.write((uow) =>
        expectWritten(
          world.repos.messages.insert(
            uow,
            {
              id: messageId('ph'),
              groupId: world.groupId,
              conversationId: conversation,
              kind: 'member',
              text: 'the whole album',
              sentAt: T0,
              receivedAt: T0,
            },
            groupLabel(world.groupId),
            [photo('p3f'), photo('p4f', { kind: 'video', mime: 'video/mp4' })],
          ),
          'a message with two attachments',
        ),
      );
      const attached = world.repos.messages.attachments(world.groupId, messageId('ph'));
      expect(attached.map((each) => each.kind)).toEqual(['image', 'video']);
      // A media group arrives in one transaction with one `created_at`, so the id is what orders
      // them — without it the second tie-break the order would be the planner's choice.
      expect(attached.map((each) => each.id)).toEqual([attachmentId('p3f'), attachmentId('p4f')]);
    });
  });

  it('returns nothing for a message in another group (I4)', () => {
    withPhoto((world) => {
      expect(world.repos.messages.attachments(world.otherGroupId, messageId('ph'))).toEqual([]);
    });
  });

  it('records a stored outcome with its digest and measured size', () => {
    withPhoto((world) => {
      const sha256 = 'a'.repeat(64);
      world.store.write((uow) => {
        // The blob has to exist first: `attachments_blob_fk` is composite on
        // `(group_id, blob_sha256)`, so a digest naming a blob of another group is refused by the
        // database rather than by a check in the repository.
        world.db
          .prepare(
            `INSERT INTO blobs
               (group_id, sha256, size_bytes, mime, storage_addr, wrapped_dek, wrap_nonce,
                kek_version, state, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'stored', ?)`,
          )
          .run(
            world.groupId,
            sha256,
            1_482_301,
            'image/jpeg',
            `addr-${sha256}`,
            Buffer.alloc(48),
            Buffer.alloc(24),
            1,
            T0.epochMilliseconds,
          );
        expectWritten(
          world.repos.messages.recordAttachmentOutcome(uow, world.groupId, attachmentId('p1f'), {
            status: 'stored',
            blobSha256: sha256,
            sizeBytes: 1_482_301,
            mime: 'image/png',
          }),
          'the outcome',
        );
      });
      const [attached] = world.repos.messages.attachments(world.groupId, messageId('ph'));
      expect(attached?.status).toBe('stored');
      expect(attached?.blobSha256).toBe(sha256);
      // The sniffed type overwrites the platform's declared one, which was `image/jpeg`.
      expect(attached?.mime).toBe('image/png');
    });
  });

  it('records a refusal without a digest, so blob GC never sees the row', () => {
    withPhoto((world) => {
      world.store.write((uow) =>
        expectWritten(
          world.repos.messages.recordAttachmentOutcome(uow, world.groupId, attachmentId('p1f'), {
            status: 'too_large',
          }),
          'the outcome',
        ),
      );
      const [attached] = world.repos.messages.attachments(world.groupId, messageId('ph'));
      // `too_large` is the host's setting working, not a failure — which is why `02` §3.3.3 has
      // seven statuses rather than a boolean and an error string.
      expect(attached?.status).toBe('too_large');
      expect(attached?.blobSha256).toBeUndefined();
    });
  });

  it('refuses an outcome for an attachment of another group (I4)', () => {
    withPhoto((world) => {
      expect(
        world.store.write((uow) =>
          world.repos.messages.recordAttachmentOutcome(
            uow,
            world.otherGroupId,
            attachmentId('p1f'),
            { status: 'failed' },
          ),
        ).kind,
      ).toBe('not_found');
      expect(world.repos.messages.attachments(world.groupId, messageId('ph'))[0]?.status).toBe(
        'pending',
      );
    });
  });
});
