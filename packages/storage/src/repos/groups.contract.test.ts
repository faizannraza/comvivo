/**
 * `GroupReader` / `GroupRepository` against `02` §3.7.1's conventions (`M1-T17`).
 *
 * A contract test checks the **port's** promises, not the implementation's internals: reads return
 * the object or `undefined`, writes return a `WriteResult` with the right arm, a stale version is
 * a `conflict`, and nothing crosses a group. Those are the four things every repository in this
 * milestone must do identically, so they are tested identically.
 */
import { expectWritten } from '@comvivo/core';
import { parseTimeZoneId, UTC } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import {
  ABSENT_GROUP,
  conversationId,
  group,
  groupId,
  member,
  person,
  T0,
  withRepos,
} from './testing/harness.js';

describe('GroupRepository', () => {
  it('creates a group with the schema defaults the spec states', () => {
    withRepos((world) => {
      const created = world.store.write((uow) =>
        expectWritten(
          world.repos.groups.create(uow, {
            id: groupId('new'),
            name: 'Nowak family',
            archetype: 'family',
            timezone: UTC,
          }),
          'a group',
        ),
      );
      // `02` §3.3.1's defaults, asserted here because `NewGroup` makes them optional and a caller
      // that omits them must get the row the schema would have produced.
      expect(created.locale).toBe('en');
      expect(created.historyVisibility).toBe('since_join');
      expect(created.weekStart).toBe(1);
      expect(created.status).toBe('active');
      expect(created.membershipEpoch).toBe(0);
      expect(created.version).toBe(1);
      // A group with no chat bound yet has no primary conversation and no constitution.
      expect(created.primaryConversationId).toBeUndefined();
      expect(created.constitutionVersionId).toBeUndefined();
    });
  });

  it('reports a reused id as a duplicate rather than throwing', () => {
    withRepos((world) => {
      const again = world.store.write((uow) =>
        world.repos.groups.create(uow, group(world.groupId, 'A different name')),
      );
      expect(again.kind).toBe('duplicate');
      if (again.kind !== 'duplicate') return;
      expect(again.existingId).toBe(world.groupId);
      // And the existing group is untouched: a duplicate is a refusal, not an upsert.
      expect(world.repos.groups.byId(world.groupId)?.name).toBe('Primary');
    });
  });

  it('returns undefined for a group that does not exist', () => {
    withRepos((world) => {
      expect(world.repos.groups.byId(ABSENT_GROUP)).toBeUndefined();
    });
  });

  it('refuses an update whose expected version is stale, and says so', () => {
    withRepos((world) => {
      const before = world.repos.groups.byId(world.groupId);
      expect(before).toBeDefined();
      if (before === undefined) return;

      const first = world.store.write((uow) =>
        world.repos.groups.update(uow, world.groupId, before.version, { name: 'Renamed' }),
      );
      expect(first.kind).toBe('ok');

      // The same version again: somebody else wrote in between, which is exactly what the
      // mechanism exists to catch.
      const stale = world.store.write((uow) =>
        world.repos.groups.update(uow, world.groupId, before.version, { name: 'Clobbered' }),
      );
      expect(stale.kind).toBe('conflict');
      // And the losing write changed nothing.
      expect(world.repos.groups.byId(world.groupId)?.name).toBe('Renamed');
    });
  });

  it('reports a missing row as not_found, not as a conflict', () => {
    withRepos((world) => {
      const missing = world.store.write((uow) =>
        world.repos.groups.update(uow, ABSENT_GROUP, 1, {
          name: 'x',
        }),
      );
      // The distinction matters: a caller that gets `conflict` re-reads and retries, and against a
      // row that does not exist that is an infinite loop.
      expect(missing.kind).toBe('not_found');
    });
  });

  it('applies only the fields the patch names', () => {
    withRepos((world) => {
      const before = world.repos.groups.byId(world.groupId);
      if (before === undefined) throw new Error('fixture');
      const warsaw = parseTimeZoneId('Europe/Warsaw');
      expect(warsaw).toBeDefined();
      if (warsaw === undefined) return;

      const updated = world.store.write((uow) =>
        expectWritten(
          world.repos.groups.update(uow, world.groupId, before.version, { timezone: warsaw }),
          'a group update',
        ),
      );
      expect(updated.timezone).toBe('Europe/Warsaw');
      // Untouched, because the patch did not name them.
      expect(updated.name).toBe(before.name);
      expect(updated.locale).toBe(before.locale);
      expect(updated.version).toBe(before.version + 1);
    });
  });

  it('bumps the membership epoch, returning the new value', () => {
    withRepos((world) => {
      const before = world.repos.groups.byId(world.groupId)?.membershipEpoch;
      expect(before).toBe(0);
      const next = world.store.write((uow) =>
        expectWritten(world.repos.groups.bumpMembershipEpoch(uow, world.groupId), 'an epoch bump'),
      );
      // The **new** value: a caller's next act is to invalidate a cache keyed on it, and the old
      // value would invalidate nothing.
      expect(next).toBe(1);
      expect(world.repos.groups.byId(world.groupId)?.membershipEpoch).toBe(1);
    });
  });

  it('leaves `version` alone when it bumps the epoch', () => {
    withRepos((world) => {
      const before = world.repos.groups.byId(world.groupId);
      if (before === undefined) throw new Error('fixture');
      world.store.write((uow) => world.repos.groups.bumpMembershipEpoch(uow, world.groupId));
      // Deliberate: bumping `version` here would make every role change conflict with any settings
      // edit in flight, turning a correctness mechanism into a source of spurious refusals.
      expect(world.repos.groups.byId(world.groupId)?.version).toBe(before.version);
    });
  });

  it('is not idempotent about the epoch, because each call means "eligibility may have moved"', () => {
    withRepos((world) => {
      world.store.write((uow) => {
        world.repos.groups.bumpMembershipEpoch(uow, world.groupId);
        world.repos.groups.bumpMembershipEpoch(uow, world.groupId);
      });
      expect(world.repos.groups.byId(world.groupId)?.membershipEpoch).toBe(2);
    });
  });

  it('links the constitution and the primary conversation without a version', () => {
    withRepos((world) => {
      const conv = conversationId('gx');
      world.store.write((uow) => {
        expectWritten(
          world.repos.conversations.create(uow, {
            id: conv,
            groupId: world.groupId,
            channel: 'simulator',
            platformChatId: 'chat-gl',
            kind: 'group',
            boundAt: T0,
          }),
          'a conversation',
        );
        expectWritten(
          world.repos.groups.link(uow, world.groupId, { primaryConversationId: conv }),
          'the primary link',
        );
      });
      expect(world.repos.groups.byId(world.groupId)?.primaryConversationId).toBe(conv);
      // It still bumps `version`, so a settings edit that read the group earlier is refused rather
      // than silently lost.
      expect(world.repos.groups.byId(world.groupId)?.version).toBe(2);
    });
  });

  describe('snapshot (Q-CTX-9)', () => {
    it('returns the epoch and the active members from one read', () => {
      withRepos((world) => {
        world.store.write((uow) => {
          expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
          expectWritten(world.repos.persons.create(uow, person('b')), 'person b');
          expectWritten(world.repos.members.add(uow, member('a', world.groupId)), 'member a');
          expectWritten(world.repos.members.add(uow, member('b', world.groupId)), 'member b');
        });
        const snapshot = world.repos.groups.snapshot(world.groupId);
        expect(snapshot).toBeDefined();
        if (snapshot === undefined) return;
        expect(snapshot.groupId).toBe(world.groupId);
        // Two members added, so two bumps.
        expect(snapshot.membershipEpoch).toBe(2);
        expect(snapshot.memberIds).toHaveLength(2);
        // Sorted, because `01` §7.2's cache key is built from this list and an unordered list
        // would key differently for the same membership.
        expect([...snapshot.memberIds]).toEqual([...snapshot.memberIds].toSorted());
      });
    });

    it('excludes members who have left', () => {
      withRepos((world) => {
        const added = world.store.write((uow) => {
          expectWritten(world.repos.persons.create(uow, person('c')), 'person c');
          return expectWritten(
            world.repos.members.add(uow, member('c', world.groupId)),
            'member c',
          );
        });
        expect(world.repos.groups.snapshot(world.groupId)?.memberIds).toHaveLength(1);

        world.store.write((uow) =>
          world.repos.members.setStatus(uow, world.groupId, added.id, added.version, 'left', T0),
        );
        expect(world.repos.groups.snapshot(world.groupId)?.memberIds).toHaveLength(0);
      });
    });

    it('tells "the group is gone" apart from "everyone left"', () => {
      withRepos((world) => {
        // An existing group with no members is a snapshot with an empty list.
        const empty = world.repos.groups.snapshot(world.groupId);
        expect(empty?.memberIds).toEqual([]);
        // A group that does not exist is `undefined`. `02` §3.13 has to distinguish them.
        expect(world.repos.groups.snapshot(ABSENT_GROUP)).toBeUndefined();
      });
    });
  });

  describe('list', () => {
    it('returns every group, because an instance-wide view legitimately spans groups', () => {
      withRepos((world) => {
        expect(world.repos.groups.list()).toHaveLength(2);
      });
    });

    it('narrows by status, so a sweep does not pick up a group mid-deletion', () => {
      withRepos((world) => {
        const other = world.repos.groups.byId(world.otherGroupId);
        if (other === undefined) throw new Error('fixture');
        world.store.write((uow) =>
          world.repos.groups.setStatus(uow, world.otherGroupId, other.version, 'deleting'),
        );
        expect(world.repos.groups.list({ status: 'active' }).map((g) => g.id)).toEqual([
          world.groupId,
        ]);
        expect(world.repos.groups.list({ status: 'deleting' }).map((g) => g.id)).toEqual([
          world.otherGroupId,
        ]);
      });
    });
  });
});
