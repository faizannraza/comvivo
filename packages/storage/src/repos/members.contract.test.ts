/**
 * `MemberReader` / `MemberRepository` against `02` §3.7.1 and §3.3.1 (`M1-T17`).
 *
 * Two behaviours here are not generic repository conventions and get most of the attention:
 * **handle allocation** (`05` S4: stable, unique per group, never reused) and **the membership
 * epoch** (`02` §3.2: bumped in the same transaction as any status or role change). Both are
 * correctness mechanisms whose failure is silent — a reused handle re-attributes history, and a
 * missed bump leaves a cached eligibility set outliving the authority it was computed from.
 */
import { expectWritten, notFound } from '@comvivo/core';
import { StorageError } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import { SqliteMemberRepository } from './members.js';
import { ABSENT_GROUP, member, memberId, person, T0, withRepos } from './testing/harness.js';

describe('MemberRepository', () => {
  describe('handle allocation (05 S4)', () => {
    it('allocates m1, m2, m3 in order', () => {
      withRepos((world) => {
        const handles = world.store.write((uow) =>
          ['a', 'b', 'c'].map((tag) => {
            expectWritten(world.repos.persons.create(uow, person(tag)), `person ${tag}`);
            return expectWritten(
              world.repos.members.add(uow, member(tag, world.groupId)),
              `member ${tag}`,
            ).handle;
          }),
        );
        expect(handles).toEqual(['m1', 'm2', 'm3']);
      });
    });

    it('never reuses the handle of a member who left', () => {
      withRepos((world) => {
        const first = world.store.write((uow) => {
          expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
          return expectWritten(
            world.repos.members.add(uow, member('a', world.groupId)),
            'member a',
          );
        });
        expect(first.handle).toBe('m1');

        world.store.write((uow) =>
          world.repos.members.setStatus(uow, world.groupId, first.id, first.version, 'left', T0),
        );

        const second = world.store.write((uow) => {
          expectWritten(world.repos.persons.create(uow, person('b')), 'person b');
          return expectWritten(
            world.repos.members.add(uow, member('b', world.groupId)),
            'member b',
          );
        });
        // `m2`, not `m1`. A reissued handle would silently re-attribute everything the first
        // member ever said, because `05` S4 puts the handle in the prompt and nothing else.
        expect(second.handle).toBe('m2');
      });
    });

    it('counts handles per group, so two groups both start at m1', () => {
      withRepos((world) => {
        const [here, there] = world.store.write((uow) => {
          expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
          expectWritten(world.repos.persons.create(uow, person('b')), 'person b');
          return [
            expectWritten(world.repos.members.add(uow, member('a', world.groupId)), 'here').handle,
            expectWritten(world.repos.members.add(uow, member('b', world.otherGroupId)), 'there')
              .handle,
          ];
        });
        expect([here, there]).toEqual(['m1', 'm1']);
      });
    });

    it('is not fooled by a non-numeric handle a hint put there', () => {
      withRepos((world) => {
        world.store.write((uow) => {
          expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
          expectWritten(
            world.repos.members.add(uow, member('a', world.groupId), 'mabel'),
            'a hinted member',
          );
        });
        const next = world.store.write((uow) => {
          expectWritten(world.repos.persons.create(uow, person('b')), 'person b');
          return expectWritten(world.repos.members.add(uow, member('b', world.groupId)), 'next');
        });
        // `m1`, because `mabel` is not `m<number>`. A `MAX(CAST(...))` would read it as 0 and
        // agree by accident; a `parseInt` would read `mabel` as NaN but `m3x` as 3, which is the
        // case that would actually collide.
        expect(next.handle).toBe('m1');
      });
    });

    it('refuses a hint that is taken rather than adjusting it', () => {
      withRepos((world) => {
        const taken = world.store.write((uow) => {
          expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
          return expectWritten(
            world.repos.members.add(uow, member('a', world.groupId), 'ana'),
            'the first',
          );
        });
        const refused = world.store.write((uow) => {
          expectWritten(world.repos.persons.create(uow, person('b')), 'person b');
          return world.repos.members.add(uow, member('b', world.groupId), 'ana');
        });
        // Silently appending a digit is how two imports end up disagreeing about who `ana` is.
        expect(refused.kind).toBe('duplicate');
        if (refused.kind !== 'duplicate') return;
        expect(refused.existingId).toBe(taken.id);
      });
    });
  });

  describe('the membership epoch (02 §3.2)', () => {
    it('bumps when a member is added', () => {
      withRepos((world) => {
        expect(world.repos.groups.byId(world.groupId)?.membershipEpoch).toBe(0);
        world.store.write((uow) => {
          expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
          expectWritten(world.repos.members.add(uow, member('a', world.groupId)), 'member a');
        });
        expect(world.repos.groups.byId(world.groupId)?.membershipEpoch).toBe(1);
      });
    });

    it('bumps on a role change and on a status change', () => {
      withRepos((world) => {
        const added = world.store.write((uow) => {
          expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
          return expectWritten(world.repos.members.add(uow, member('a', world.groupId)), 'member');
        });
        const afterAdd = world.repos.groups.byId(world.groupId)?.membershipEpoch;
        expect(afterAdd).toBe(1);

        const promoted = world.store.write((uow) =>
          expectWritten(
            world.repos.members.setRole(uow, world.groupId, added.id, added.version, 'admin'),
            'a promotion',
          ),
        );
        expect(world.repos.groups.byId(world.groupId)?.membershipEpoch).toBe(2);

        world.store.write((uow) =>
          world.repos.members.setStatus(
            uow,
            world.groupId,
            promoted.id,
            promoted.version,
            'left',
            T0,
          ),
        );
        expect(world.repos.groups.byId(world.groupId)?.membershipEpoch).toBe(3);
      });
    });

    it('does NOT bump on a consent or nickname change', () => {
      withRepos((world) => {
        const added = world.store.write((uow) => {
          expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
          return expectWritten(world.repos.members.add(uow, member('a', world.groupId)), 'member');
        });
        const before = world.repos.groups.byId(world.groupId)?.membershipEpoch;

        const consented = world.store.write((uow) =>
          expectWritten(
            world.repos.members.setConsent(
              uow,
              world.groupId,
              added.id,
              added.version,
              'memory_on',
            ),
            'consent',
          ),
        );
        world.store.write((uow) =>
          world.repos.members.setNickname(
            uow,
            world.groupId,
            consented.id,
            consented.version,
            'Annie',
          ),
        );

        // Deliberate asymmetry: consent governs whether `04` *extracts* memory and a nickname is a
        // display string. Neither moves who may read what, so neither invalidates an eligibility
        // cache — and bumping the epoch for them would discard every cached set on a nickname.
        expect(world.repos.groups.byId(world.groupId)?.membershipEpoch).toBe(before);
      });
    });

    it('rolls the bump back with the member when the transaction fails', () => {
      withRepos((world) => {
        const before = world.repos.groups.byId(world.groupId)?.membershipEpoch;
        expect(() =>
          world.store.write((uow) => {
            expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
            expectWritten(world.repos.members.add(uow, member('a', world.groupId)), 'member a');
            throw new Error('the caller changed its mind');
          }),
        ).toThrow('the caller changed its mind');
        // The epoch and the member go together or not at all, which is what "in the same
        // transaction" in `02` §3.2 buys.
        expect(world.repos.groups.byId(world.groupId)?.membershipEpoch).toBe(before);
        expect(world.repos.members.list(world.groupId)).toHaveLength(0);
      });
    });
  });

  it('treats a missing group on the epoch bump as corruption, not as not_found', () => {
    // Unreachable through SQLite: `members.group_id` is a foreign key, so a member row implies its
    // group row. Which is why it needs a test — the alternative to the guard is returning
    // `not_found` for a write that *did* change the member, leaving the caller to believe nothing
    // happened while the role moved and the eligibility cache stayed valid.
    //
    // The repository takes `Pick<GroupRepository, 'bumpMembershipEpoch'>`, so the one dependency
    // that can produce this is a two-line double — which is the payoff for narrowing it rather
    // than passing the whole repository.
    withRepos((world) => {
      const added = world.store.write((uow) => {
        expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
        return expectWritten(world.repos.members.add(uow, member('a', world.groupId)), 'member');
      });
      const broken = new SqliteMemberRepository(world.drizzle, {
        bumpMembershipEpoch: () => notFound(),
      });

      let caught: unknown;
      try {
        world.store.write((uow) =>
          broken.setRole(uow, world.groupId, added.id, added.version, 'admin'),
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StorageError);
      const error = caught as StorageError;
      expect(error.storageCode).toBe('STORAGE_CORRUPT');
      expect(error.hint).toContain('doctor');
      // And the transaction rolled back, so the member did not quietly change role.
      expect(world.repos.members.byId(world.groupId, added.id)?.role).toBe('member');
    });
  });

  describe('the age-band constraint (02 §3.3.1)', () => {
    it('defaults the band from the role, in the protective direction', () => {
      withRepos((world) => {
        const [adult, child] = world.store.write((uow) => {
          expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
          expectWritten(world.repos.persons.create(uow, person('b')), 'person b');
          return [
            expectWritten(
              world.repos.members.add(uow, member('a', world.groupId, { role: 'member' })),
              'an adult',
            ),
            expectWritten(
              world.repos.members.add(uow, member('b', world.groupId, { role: 'child' })),
              'a child',
            ),
          ];
        });
        expect(adult.ageBand).toBe('adult');
        // `child`, not `teen`: `03`'s protections are strongest for the youngest band, and the
        // safe direction for a missing answer is the more protective one.
        expect(child.ageBand).toBe('child');
      });
    });

    it('refuses a role and band that contradict each other, naming both', () => {
      withRepos((world) => {
        let caught: unknown;
        try {
          world.store.write((uow) => {
            expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
            return world.repos.members.add(
              uow,
              member('a', world.groupId, { role: 'member', ageBand: 'teen' }),
            );
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(StorageError);
        const error = caught as StorageError;
        expect(error.storageCode).toBe('STORAGE_CONSTRAINT');
        // The *pair*, where the CHECK constraint would only name itself.
        expect(error.message).toContain('member');
        expect(error.message).toContain('teen');
      });
    });
  });

  describe('group scoping (I4)', () => {
    it('does not find a member of another group', () => {
      withRepos((world) => {
        const elsewhere = world.store.write((uow) => {
          expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
          return expectWritten(
            world.repos.members.add(uow, member('a', world.otherGroupId)),
            'a member elsewhere',
          );
        });
        expect(world.repos.members.byId(world.groupId, elsewhere.id)).toBeUndefined();
        expect(world.repos.members.byPerson(world.groupId, elsewhere.personId)).toBeUndefined();
        expect(world.repos.members.byHandle(world.groupId, elsewhere.handle)).toBeUndefined();
        expect(world.repos.members.list(world.groupId)).toHaveLength(0);
        // And it is there, in its own group — so the test is about scoping and not about the row
        // failing to be written.
        expect(world.repos.members.byId(world.otherGroupId, elsewhere.id)?.id).toBe(elsewhere.id);
      });
    });

    it('refuses a write aimed at another group, as not_found rather than as a conflict', () => {
      withRepos((world) => {
        const elsewhere = world.store.write((uow) => {
          expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
          return expectWritten(
            world.repos.members.add(uow, member('a', world.otherGroupId)),
            'a member elsewhere',
          );
        });
        const refused = world.store.write((uow) =>
          world.repos.members.setRole(uow, world.groupId, elsewhere.id, elsewhere.version, 'admin'),
        );
        // `not_found`, which is also the answer for a row that never existed — `I4` requires the
        // caller to be unable to tell those apart.
        expect(refused.kind).toBe('not_found');
        expect(world.repos.members.byId(world.otherGroupId, elsewhere.id)?.role).toBe('member');
      });
    });

    it('sees across groups only where erasure needs to', () => {
      withRepos((world) => {
        world.store.write((uow) => {
          expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
          expectWritten(world.repos.members.add(uow, member('a', world.groupId)), 'here');
          expectWritten(
            world.repos.members.add(uow, {
              ...member('a', world.otherGroupId),
              id: memberId('a2'),
            }),
            'there',
          );
        });
        // Q-PRV-1. The one reader that spans groups, and it is named so the exception is visible.
        const all = world.repos.members.byPersonAcrossGroups(person('a').id);
        expect(all.map((m) => m.groupId).toSorted()).toEqual(
          [world.groupId, world.otherGroupId].toSorted(),
        );
      });
    });
  });

  describe('list', () => {
    it('defaults to active, and says `any` out loud', () => {
      withRepos((world) => {
        const added = world.store.write((uow) => {
          expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
          return expectWritten(world.repos.members.add(uow, member('a', world.groupId)), 'member');
        });
        world.store.write((uow) =>
          world.repos.members.setStatus(uow, world.groupId, added.id, added.version, 'left', T0),
        );
        expect(world.repos.members.list(world.groupId)).toHaveLength(0);
        expect(world.repos.members.list(world.groupId, { status: 'any' })).toHaveLength(1);
        expect(world.repos.members.list(world.groupId, { status: 'left' })).toHaveLength(1);
      });
    });
  });

  it('refuses a stale version', () => {
    withRepos((world) => {
      const added = world.store.write((uow) => {
        expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
        return expectWritten(world.repos.members.add(uow, member('a', world.groupId)), 'member');
      });
      world.store.write((uow) =>
        world.repos.members.setConsent(uow, world.groupId, added.id, added.version, 'informed'),
      );
      const stale = world.store.write((uow) =>
        world.repos.members.setConsent(uow, world.groupId, added.id, added.version, 'memory_off'),
      );
      expect(stale.kind).toBe('conflict');
      expect(world.repos.members.byId(world.groupId, added.id)?.consent).toBe('informed');
    });
  });

  it('returns not_found for a member in a group that does not exist', () => {
    withRepos((world) => {
      expect(world.repos.members.byId(ABSENT_GROUP, memberId('a'))).toBeUndefined();
    });
  });

  it('stamps leftAt when they leave and clears it if they come back', () => {
    withRepos((world) => {
      const added = world.store.write((uow) => {
        expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
        return expectWritten(world.repos.members.add(uow, member('a', world.groupId)), 'member');
      });
      expect(added.leftAt).toBeUndefined();

      const left = world.store.write((uow) =>
        expectWritten(
          world.repos.members.setStatus(uow, world.groupId, added.id, added.version, 'left', T0),
          'a departure',
        ),
      );
      expect(left.leftAt?.toString()).toBe(T0.toString());

      const back = world.store.write((uow) =>
        expectWritten(
          world.repos.members.setStatus(uow, world.groupId, left.id, left.version, 'active', T0),
          'a return',
        ),
      );
      // Cleared, so the column always answers "when did this membership end" rather than "when
      // did it last end".
      expect(back.leftAt).toBeUndefined();
    });
  });
});
