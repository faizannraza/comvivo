/**
 * `ContextReadModel` and `LabelStore.groupLabels` (`M1-T19`; `02` §3.7.3, `04` §3.6.3).
 *
 * Two things are worth testing here and the rest is delegation.
 *
 * **`groupLabels` has to round-trip what interning stored.** It is the input to `computeEligible`,
 * so a label it reconstructs *differently* from the one that went in produces an eligible set that
 * is wrong in whichever direction the difference points — and `M1-T16`'s interning property cannot
 * see it, because that property never reads a label back out. So the test writes labels through
 * `intern` and asserts the reconstruction is `canRead`-equivalent to the original.
 *
 * **The message view resolves the label.** `02` §3.7.3 spells it `label: Label` because `04`
 * §3.6.3 re-checks every item with `ifc.canRead(label, …)` after hydration and fails closed. A
 * view carrying an integer could not be re-checked at all.
 */
import {
  type Audience,
  computeEligible,
  expectWritten,
  type Label,
  type NotPromise,
  StubInformationFlow,
} from '@comvivo/core';
import type { MemberId } from '@comvivo/shared';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import {
  conversationId,
  groupLabel,
  listId,
  listItemId,
  member,
  messageId,
  person,
  T0,
  taskId,
  withRepos,
} from '../repos/testing/harness.js';

const DAY = 86_400_000;
const at = (days: number) =>
  Temporal.Instant.fromEpochMilliseconds(T0.epochMilliseconds + days * DAY);

describe('LabelStore.groupLabels (Q-IFC-2)', () => {
  it('round-trips every label shape interning accepts', () => {
    withRepos((world) => {
      const who = world.store.write((uow) =>
        ['a', 'b', 'c'].map((tag) => {
          expectWritten(world.repos.persons.create(uow, person(tag)), `person ${tag}`);
          return expectWritten(
            world.repos.members.add(uow, member(tag, world.groupId)),
            `member ${tag}`,
          ).id;
        }),
      );
      const conversation = world.store.write((uow) =>
        expectWritten(
          world.repos.conversations.create(uow, {
            id: conversationId('a'),
            groupId: world.groupId,
            channel: 'simulator',
            platformChatId: 'chat-a',
            kind: 'group',
            boundAt: T0,
          }),
          'a conversation',
        ),
      ).id;

      // Every shape the canonical key distinguishes: both reader-set kinds, with and without
      // seats, group- and member-owned, co-owners, and each flag above the reader set.
      const audiences: readonly Audience[] = [
        { kind: 'group', groupId: world.groupId },
        { kind: 'group', groupId: world.groupId, seats: [conversation] },
        { kind: 'members', groupId: world.groupId, memberIds: [who[0] as MemberId] },
        { kind: 'members', groupId: world.groupId, memberIds: who as MemberId[] },
        {
          kind: 'members',
          groupId: world.groupId,
          memberIds: [who[1] as MemberId],
          seats: [conversation],
        },
      ];
      const originals: Label[] = audiences.flatMap((readers, index) => [
        {
          groupId: world.groupId,
          readers,
          owner: index % 2 === 0 ? 'group' : (who[0] as MemberId),
          coOwners: index % 3 === 0 ? [] : [who[2] as MemberId],
          sensitivity: 'normal',
          influence: 'none',
          untrusted: false,
        },
        {
          groupId: world.groupId,
          readers,
          owner: who[1] as MemberId,
          coOwners: [],
          sensitivity: 'sensitive',
          influence: 'constraints',
          untrusted: true,
        },
      ]);

      const interned = world.store.write((uow) =>
        originals.map((label) => ({ id: world.repos.labels.intern(uow, label), label })),
      );
      const loaded = world.repos.labels.groupLabels(world.groupId);

      const snapshot = world.repos.groups.snapshot(world.groupId);
      if (snapshot === undefined) throw new Error('fixture');

      for (const { id, label } of interned) {
        const reconstructed = loaded.get(id);
        expect(reconstructed, `label ${String(id)} missing from groupLabels`).toBeDefined();
        if (reconstructed === undefined) continue;
        // The fields above the reader set are compared directly.
        expect(reconstructed.owner).toBe(label.owner);
        expect([...reconstructed.coOwners].toSorted()).toEqual([...label.coOwners].toSorted());
        expect(reconstructed.sensitivity).toBe(label.sensitivity);
        expect(reconstructed.influence).toBe(label.influence);
        expect(reconstructed.untrusted).toBe(label.untrusted);
        // The reader set is compared **behaviourally**, through `canRead` over every audience in
        // play — which is the thing that actually has to match. Comparing the structure would also
        // pass for a reconstruction that happened to order a member list differently, and fail for
        // one that is equivalent; `canRead` is the question the eligible set is built from.
        for (const audience of audiences) {
          expect(
            StubInformationFlow.canRead(reconstructed, audience, snapshot),
            `label ${String(id)} vs ${JSON.stringify(audience)}`,
          ).toBe(StubInformationFlow.canRead(label, audience, snapshot));
        }
      }
      // Non-vacuity: a `groupLabels` that returned nothing would satisfy the loop above over no
      // labels at all, and one that returned everything readable would not exercise the shapes.
      expect(loaded.size).toBeGreaterThanOrEqual(interned.length);
      expect(new Set(interned.map((row) => row.id)).size).toBeGreaterThan(5);
    });
  });

  it('produces a map `computeEligible` accepts, with the same answer as canRead', () => {
    withRepos((world) => {
      // **Two** members, which this test needs rather than merely prefers: containment is
      // `label.readers ⊇ audience`, so in a one-member group a one-member reader set *does*
      // contain the whole group — and the two audiences below would be indistinguishable. A first
      // version had one member and asserted they differed, which failed against correct code.
      const who = world.store.write((uow) => {
        expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
        expectWritten(world.repos.persons.create(uow, person('b')), 'person b');
        expectWritten(world.repos.members.add(uow, member('b', world.groupId)), 'member b');
        return expectWritten(world.repos.members.add(uow, member('a', world.groupId)), 'member a')
          .id;
      });
      const privateLabel: Label = {
        groupId: world.groupId,
        readers: { kind: 'members', groupId: world.groupId, memberIds: [who] },
        owner: who,
        coOwners: [],
        sensitivity: 'personal',
        influence: 'none',
        untrusted: false,
      };
      world.store.write((uow) => {
        world.repos.labels.intern(uow, groupLabel(world.groupId));
        world.repos.labels.intern(uow, privateLabel);
      });

      const snapshot = world.repos.groups.snapshot(world.groupId);
      if (snapshot === undefined) throw new Error('fixture');
      const labels = world.repos.labels.groupLabels(world.groupId);
      // The whole point of this method: `computeEligible` takes exactly this map, and until now
      // nothing could build one from the database.
      const groupAudience = computeEligible(
        labels,
        { kind: 'group', groupId: world.groupId },
        snapshot,
        StubInformationFlow,
      );
      const memberAudience = computeEligible(
        labels,
        { kind: 'members', groupId: world.groupId, memberIds: [who] },
        snapshot,
        StubInformationFlow,
      );
      // A group audience may not read a one-member label; that member may read both.
      expect(groupAudience.ids.length).toBeLessThan(memberAudience.ids.length);
      expect(memberAudience.ids.length).toBe(labels.size);
    });
  });

  it('keeps one group`s labels out of another`s', () => {
    withRepos((world) => {
      world.store.write((uow) => {
        world.repos.labels.intern(uow, groupLabel(world.groupId));
        world.repos.labels.intern(uow, groupLabel(world.otherGroupId));
      });
      const here = world.repos.labels.groupLabels(world.groupId);
      const there = world.repos.labels.groupLabels(world.otherGroupId);
      expect(here.size).toBe(1);
      expect(there.size).toBe(1);
      // Disjoint ids: interning is per group, so the same value in two groups is two labels.
      expect([...here.keys()].some((id) => there.has(id))).toBe(false);
    });
  });
});

describe('ContextReadModel', () => {
  /** A group with a member, a conversation, and one of each coordination entity. */
  function withContext<T>(
    fn: (
      world: Parameters<Parameters<typeof withRepos>[0]>[0],
      ids: { conversation: ReturnType<typeof conversationId>; who: MemberId },
    ) => NotPromise<T>,
  ): T {
    return withRepos((world) => {
      const label = groupLabel(world.groupId);
      const ids = world.store.write((uow) => {
        expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
        const who = expectWritten(
          world.repos.members.add(uow, member('a', world.groupId)),
          'member',
        ).id;
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
        ).id;
        expectWritten(
          world.repos.messages.insert(
            uow,
            {
              id: messageId('a1f'),
              groupId: world.groupId,
              conversationId: conversation,
              kind: 'member',
              senderMemberId: who,
              text: 'who is cooking',
              sentAt: T0,
              receivedAt: T0,
            },
            label,
          ),
          'a message',
        );
        expectWritten(
          world.repos.calendar.create(
            uow,
            {
              id: 'evt_01jctx00000000000000000001' as never,
              groupId: world.groupId,
              title: 'dinner',
              tz: 'UTC' as never,
              startLocal: '2026-11-11T18:00',
              startAt: at(1),
              busy: true,
              source: { kind: 'native' },
              icsUid: 'ctx1@test',
              tzdataVersion: '2026b',
            },
            label,
          ),
          'an event',
        );
        expectWritten(
          world.repos.tasks.create(
            uow,
            {
              id: taskId('a1f'),
              groupId: world.groupId,
              title: 'take the bins out',
              due: { kind: 'none' },
              dueAt: at(1),
            },
            label,
          ),
          'a task',
        );
        const list = expectWritten(
          world.repos.lists.create(
            uow,
            { id: listId('a1f'), groupId: world.groupId, name: 'Groceries', kind: 'grocery' },
            label,
          ),
          'a list',
        );
        expectWritten(
          world.repos.lists.addItem(
            uow,
            {
              id: listItemId('a1f'),
              listId: list.id,
              groupId: world.groupId,
              text: 'milk',
              normalizedKey: 'milk',
            },
            label,
          ),
          'a list item',
        );
        return { conversation, who };
      });
      return fn(world, ids);
    });
  }

  /** The eligible set a turn would compute, built the production way. */
  function eligibleFor(world: Parameters<Parameters<typeof withRepos>[0]>[0]) {
    const snapshot = world.repos.groups.snapshot(world.groupId);
    if (snapshot === undefined) throw new Error('fixture');
    return computeEligible(
      world.repos.context.groupLabels(world.groupId),
      { kind: 'group', groupId: world.groupId },
      snapshot,
      StubInformationFlow,
    );
  }

  it('resolves the label on every message view', () => {
    withContext((world, ids) => {
      const views = world.repos.context.recentMessages({
        conversationId: ids.conversation,
        limit: 10,
        eligible: eligibleFor(world),
      });
      expect(views).toHaveLength(1);
      const view = views[0];
      if (view === undefined) throw new Error('fixture');
      // A `Label`, not a `labelId` — `04` §3.6.3 re-checks every item with
      // `ifc.canRead(label, …)` after hydration and cannot do that with an integer.
      expect(view.label.groupId).toBe(world.groupId);
      expect(view.label.readers.kind).toBe('group');
      expect(view.text).toBe('who is cooking');
      expect(view.senderMemberId).toBe(ids.who);
    });
  });

  it('drops a message whose label it cannot resolve, failing closed', () => {
    withContext((world, ids) => {
      // A label the eligible set admits but the map does not contain. Constructed directly rather
      // than through `groupLabels`, because the situation it stands for — a label row deleted
      // under a live read — cannot be produced through the repositories.
      const eligible = eligibleFor(world);
      const emptyMap = new Map();
      const views = new (
        world.repos.context.constructor as new (
          sources: unknown,
        ) => typeof world.repos.context
      )({
        groups: world.repos.groups,
        labels: { groupLabels: () => emptyMap },
        messages: world.repos.messages,
        calendar: world.repos.calendar,
        tasks: world.repos.tasks,
        lists: world.repos.lists,
        polls: world.repos.polls,
        plans: world.repos.plans,
        decisions: world.repos.decisions,
      }).recentMessages({ conversationId: ids.conversation, limit: 10, eligible });
      // `01` §7.2's rule is to fail closed: an item the builder cannot re-check is one it must not
      // use. Returning it with a fabricated label would be worse than dropping it.
      expect(views).toEqual([]);
    });
  });

  it('returns one-off events and live series separately, unexpanded', () => {
    withContext((world) => {
      const label = groupLabel(world.groupId);
      world.store.write((uow) =>
        world.repos.calendar.create(
          uow,
          {
            id: 'evt_01jctx00000000000000000002' as never,
            groupId: world.groupId,
            title: 'weekly standup',
            tz: 'UTC' as never,
            startLocal: '2025-01-01T09:00',
            startAt: at(-400),
            busy: true,
            rrule: 'FREQ=WEEKLY',
            source: { kind: 'native' },
            icsUid: 'ctx2@test',
            tzdataVersion: '2026b',
          },
          label,
        ),
      );
      const window = world.repos.context.upcomingEvents({
        groupId: world.groupId,
        from: at(0),
        to: at(7),
        limit: 50,
        eligible: eligibleFor(world),
      });
      // The split `02` §3.3.10 draws: a range scan finds the one-off and would miss the weekly
      // standup that started last year, which is most of a real calendar.
      expect(window.oneOff.map((event) => event.title)).toEqual(['dinner']);
      expect(window.series.map((event) => event.title)).toEqual(['weekly standup']);
      // Unexpanded: storage does not expand an `rrule`, because expansion needs the zone, the
      // tzdata version and the exception dates reasoned about together — which is `07`'s.
      expect(window.series[0]?.rrule).toBe('FREQ=WEEKLY');
    });
  });

  it('picks the assignee index when an assignee is named', () => {
    withContext((world, ids) => {
      const eligible = eligibleFor(world);
      // Unassigned: the due-date query.
      expect(
        world.repos.context.openTasks({ groupId: world.groupId, limit: 10, eligible }),
      ).toHaveLength(1);
      // Named but not this member: the assignee query, which finds nothing.
      expect(
        world.repos.context.openTasks({
          groupId: world.groupId,
          assignee: ids.who,
          limit: 10,
          eligible,
        }),
      ).toEqual([]);
    });
  });

  it('pairs each active list with its unchecked items', () => {
    withContext((world) => {
      const views = world.repos.context.activeLists({
        groupId: world.groupId,
        itemLimit: 20,
        eligible: eligibleFor(world),
      });
      expect(views).toHaveLength(1);
      expect(views[0]?.list.name).toBe('Groceries');
      expect(views[0]?.items.map((item) => item.text)).toEqual(['milk']);
    });
  });

  it('returns nothing anywhere for an audience that may read nothing', () => {
    withContext((world, ids) => {
      const snapshot = world.repos.groups.snapshot(world.groupId);
      if (snapshot === undefined) throw new Error('fixture');
      // Built the production way, from a flow that admits nothing — not a hand-made empty object.
      const none = computeEligible(new Map(), { kind: 'group', groupId: world.groupId }, snapshot, {
        canRead: () => false,
      });
      expect(
        world.repos.context.recentMessages({
          conversationId: ids.conversation,
          limit: 10,
          eligible: none,
        }),
      ).toEqual([]);
      const window = world.repos.context.upcomingEvents({
        groupId: world.groupId,
        from: at(0),
        to: at(7),
        limit: 10,
        eligible: none,
      });
      expect(window.oneOff).toEqual([]);
      expect(window.series).toEqual([]);
      expect(
        world.repos.context.openTasks({ groupId: world.groupId, limit: 10, eligible: none }),
      ).toEqual([]);
      expect(
        world.repos.context.activeLists({ groupId: world.groupId, itemLimit: 10, eligible: none }),
      ).toEqual([]);
      expect(
        world.repos.context.openPolls({ groupId: world.groupId, limit: 10, eligible: none }),
      ).toEqual([]);
      expect(
        world.repos.context.activePlans({ groupId: world.groupId, limit: 10, eligible: none }),
      ).toEqual([]);
      expect(
        world.repos.context.recentDecisions({ groupId: world.groupId, limit: 10, eligible: none }),
      ).toEqual([]);
      // And the rows are there, so none of the above is vacuous.
      expect(
        world.repos.context.recentMessages({
          conversationId: ids.conversation,
          limit: 10,
          eligible: eligibleFor(world),
        }),
      ).toHaveLength(1);
    });
  });

  it('exposes the snapshot `01` §7.2 caches against', () => {
    withContext((world) => {
      const snapshot = world.repos.context.groupSnapshot(world.groupId);
      expect(snapshot?.groupId).toBe(world.groupId);
      expect(snapshot?.memberIds).toHaveLength(1);
      // The epoch moved when the member was added, which is the pair the cache key is built from.
      expect(snapshot?.membershipEpoch).toBeGreaterThan(0);
    });
  });
});
