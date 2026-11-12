/**
 * `PersonReader`/`PersonRepository` and the channel-identity pair, against `02` §3.7.1 (`M1-T17`).
 *
 * The behaviour worth most of this file is the **rename precedence** (`06`): a platform rename may
 * overwrite a platform-sourced name and never a member-chosen one. Ingestion renames on every
 * message whose `displayNameSnapshot` moved, so a repository that got this wrong would undo a
 * member's choice on their next message — a visible, repeated, hard-to-attribute annoyance.
 */
import { expectWritten, FORMER_MEMBER_NAME } from '@comvivo/core';
import { StorageError } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import { identityId, member, person, personId, T0, withRepos } from './testing/harness.js';

describe('PersonRepository', () => {
  it('creates a person who inherits the group locale and timezone', () => {
    withRepos((world) => {
      const created = world.store.write((uow) =>
        expectWritten(world.repos.persons.create(uow, person('a', 'Ana')), 'a person'),
      );
      expect(created.displayName).toBe('Ana');
      expect(created.displayNameSource).toBe('platform');
      // `undefined`, which `02` §3.3.1 spells as "inherit group" — the inheritance lives in the
      // data rather than in a default each caller would have to remember.
      expect(created.locale).toBeUndefined();
      expect(created.timezone).toBeUndefined();
      expect(created.erasedAt).toBeUndefined();
    });
  });

  it('reports a reused id as a duplicate', () => {
    withRepos((world) => {
      world.store.write((uow) => world.repos.persons.create(uow, person('a')));
      const again = world.store.write((uow) =>
        world.repos.persons.create(uow, person('a', 'Someone else')),
      );
      expect(again.kind).toBe('duplicate');
      expect(world.repos.persons.byId(personId('a'))?.displayName).toBe('Ana');
    });
  });

  it('lets a failure that is NOT a uniqueness violation propagate', () => {
    // The `throw error` half of every `create` here, and the one that matters most: reporting a
    // disk error, a foreign-key violation or a NOT NULL violation as `duplicate` is exactly the
    // confusion `02` §4.3 draws the line against — a caller would treat a write that never
    // happened as a write that had already happened, and carry on.
    withRepos((world) => {
      let caught: unknown;
      try {
        world.store.write((uow) =>
          // A NOT NULL violation, reached by handing in a value the type forbids — which is what
          // an unvalidated boundary would eventually do.
          world.repos.persons.create(uow, {
            ...person('a'),
            displayName: null as unknown as string,
          }),
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StorageError);
      expect((caught as StorageError).storageCode).toBe('STORAGE_CONSTRAINT');
      expect(world.repos.persons.byId(personId('a'))).toBeUndefined();
    });
  });

  describe('rename precedence (06)', () => {
    it('lets a platform rename replace a platform-sourced name', () => {
      withRepos((world) => {
        world.store.write((uow) => world.repos.persons.create(uow, person('a', 'ana_1990')));
        const renamed = world.store.write((uow) =>
          expectWritten(
            world.repos.persons.rename(uow, personId('a'), 'Ana Nowak', 'platform'),
            'a platform rename',
          ),
        );
        expect(renamed.displayName).toBe('Ana Nowak');
        expect(renamed.displayNameSource).toBe('platform');
      });
    });

    it('refuses to let a platform rename replace a member-chosen name', () => {
      withRepos((world) => {
        world.store.write((uow) => {
          world.repos.persons.create(uow, person('a', 'ana_1990'));
          world.repos.persons.rename(uow, personId('a'), 'Ania', 'member');
        });
        const attempt = world.store.write((uow) =>
          world.repos.persons.rename(uow, personId('a'), 'ana_1990', 'platform'),
        );
        // `ok`, because nothing is wrong — the rename simply does not apply. A refusal arm would
        // make ingestion treat a routine no-op as a failure on every message.
        expect(attempt.kind).toBe('ok');
        expect(world.repos.persons.byId(personId('a'))?.displayName).toBe('Ania');
        expect(world.repos.persons.byId(personId('a'))?.displayNameSource).toBe('member');
      });
    });

    it('lets the member change their own name again', () => {
      withRepos((world) => {
        world.store.write((uow) => {
          world.repos.persons.create(uow, person('a'));
          world.repos.persons.rename(uow, personId('a'), 'Ania', 'member');
          world.repos.persons.rename(uow, personId('a'), 'Ania N.', 'member');
        });
        expect(world.repos.persons.byId(personId('a'))?.displayName).toBe('Ania N.');
      });
    });

    it('reports a rename of a person who does not exist as not_found', () => {
      withRepos((world) => {
        const missing = world.store.write((uow) =>
          world.repos.persons.rename(uow, personId('zz'), 'X', 'platform'),
        );
        expect(missing.kind).toBe('not_found');
      });
    });
  });

  describe('preferences', () => {
    it('tells "leave alone" apart from "stop overriding the group"', () => {
      withRepos((world) => {
        world.store.write((uow) => world.repos.persons.create(uow, person('a')));
        const set = world.store.write((uow) =>
          expectWritten(
            world.repos.persons.setPreferences(uow, personId('a'), { locale: 'pl' }),
            'a locale',
          ),
        );
        expect(set.locale).toBe('pl');

        // `undefined` leaves it alone.
        const untouched = world.store.write((uow) =>
          expectWritten(world.repos.persons.setPreferences(uow, personId('a'), {}), 'a no-op'),
        );
        expect(untouched.locale).toBe('pl');

        // `null` clears it, so the next read falls back to the group's.
        const cleared = world.store.write((uow) =>
          expectWritten(
            world.repos.persons.setPreferences(uow, personId('a'), { locale: null }),
            'a clear',
          ),
        );
        expect(cleared.locale).toBeUndefined();
      });
    });
  });

  describe('erasure (08)', () => {
    it('replaces the name, clears the preferences and keeps the row', () => {
      withRepos((world) => {
        world.store.write((uow) => {
          world.repos.persons.create(uow, person('a', 'Ana'));
          world.repos.persons.setPreferences(uow, personId('a'), {
            locale: 'pl',
          });
        });
        const erased = world.store.write((uow) =>
          expectWritten(world.repos.persons.erase(uow, personId('a'), T0), 'an erasure'),
        );
        expect(erased.displayName).toBe(FORMER_MEMBER_NAME);
        // The timezone and locale go too, because a timezone narrows someone to a region.
        expect(erased.locale).toBeUndefined();
        expect(erased.timezone).toBeUndefined();
        expect(erased.erasedAt?.toString()).toBe(T0.toString());
        // The row stays: `02` §3.13 chooses referential integrity over deleting history.
        expect(world.repos.persons.byId(personId('a'))).toBeDefined();
      });
    });

    it('is idempotent, because erasure is a job and a job can be retried', () => {
      withRepos((world) => {
        world.store.write((uow) => world.repos.persons.create(uow, person('a')));
        const first = world.store.write((uow) =>
          expectWritten(world.repos.persons.erase(uow, personId('a'), T0), 'the first erasure'),
        );
        const second = world.store.write((uow) =>
          expectWritten(world.repos.persons.erase(uow, personId('a'), T0), 'the second erasure'),
        );
        expect(second.displayName).toBe(first.displayName);
        expect(second.erasedAt?.toString()).toBe(first.erasedAt?.toString());
      });
    });
  });

  it('finds the persons of a group, including those who left', () => {
    withRepos((world) => {
      const added = world.store.write((uow) => {
        expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
        expectWritten(world.repos.persons.create(uow, person('b')), 'person b');
        expectWritten(world.repos.members.add(uow, member('b', world.otherGroupId)), 'elsewhere');
        return expectWritten(world.repos.members.add(uow, member('a', world.groupId)), 'here');
      });
      world.store.write((uow) =>
        world.repos.members.setStatus(uow, world.groupId, added.id, added.version, 'left', T0),
      );
      // Q-PRV-1. `left` is included deliberately: `02` §3.13's departure path has to find the
      // person whose membership ended, and filtering to active would make it find nobody.
      expect(world.repos.persons.byGroup(world.groupId).map((p) => p.id)).toEqual([personId('a')]);
      // And it is scoped: the other group's person is not here.
      expect(world.repos.persons.byGroup(world.groupId)).toHaveLength(1);
    });
  });
});

describe('ChannelIdentityRepository', () => {
  const identity = (tag: string, platformUserId: string) => ({
    id: identityId(tag),
    channel: 'simulator' as const,
    platformUserId,
    personId: personId(tag),
    displayNameSnapshot: 'Ana',
  });

  it('resolves by (channel, platformUserId) — Q-ING-3', () => {
    withRepos((world) => {
      world.store.write((uow) => {
        expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
        expectWritten(world.repos.identities.create(uow, identity('a', 'u-1')), 'an identity');
      });
      const found = world.repos.identities.byPlatform('simulator', 'u-1');
      expect(found?.personId).toBe(personId('a'));
      expect(found?.isBot).toBe(false);
      expect(found?.dmReachable).toBe(false);
      // A different channel with the same platform id is a different account.
      expect(world.repos.identities.byPlatform('telegram', 'u-1')).toBeUndefined();
    });
  });

  it('resolves by its own id, scoped to nothing — an identity is not group-scoped', () => {
    withRepos((world) => {
      world.store.write((uow) => {
        expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
        expectWritten(world.repos.identities.create(uow, identity('a', 'u-1')), 'an identity');
      });
      // Deliberately not group-scoped: `channel_identities` has no `group_id`, because one
      // platform account belongs to a person and a person spans groups (`02` §3.3.1). What `I4`
      // forbids is learning which *other* groups someone is in, and nothing here exposes that.
      expect(world.repos.identities.byId(identityId('a'))?.platformUserId).toBe('u-1');
      expect(world.repos.identities.byId(identityId('zz'))).toBeUndefined();
    });
  });

  it('names the EXISTING identity when the platform account is taken', () => {
    withRepos((world) => {
      world.store.write((uow) => {
        expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
        expectWritten(world.repos.persons.create(uow, person('b')), 'person b');
        expectWritten(world.repos.identities.create(uow, identity('a', 'u-1')), 'the first');
      });
      const clash = world.store.write((uow) =>
        world.repos.identities.create(uow, { ...identity('b', 'u-1') }),
      );
      expect(clash.kind).toBe('duplicate');
      if (clash.kind !== 'duplicate') return;
      // The existing row's id, not the proposed one: it may point at a *different* person, which
      // is a conflict for `06`'s identity linking to resolve rather than for us to overwrite.
      expect(clash.existingId).toBe(identityId('a'));
      expect(world.repos.identities.byPlatform('simulator', 'u-1')?.personId).toBe(personId('a'));
    });
  });

  it('falls back to the proposed id when the collision was on the id itself', () => {
    withRepos((world) => {
      world.store.write((uow) => {
        expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
        expectWritten(world.repos.identities.create(uow, identity('a', 'u-1')), 'the first');
      });
      // Same **id**, different platform account: the primary key fires, not
      // `channel_identities_platform_uq` — so the lookup by `(channel, platformUserId)` finds
      // nothing and the answer has to fall back to the id that collided. Without the fallback a
      // caller would get `duplicate` with an `undefined` id and have nothing to act on.
      const clash = world.store.write((uow) =>
        world.repos.identities.create(uow, identity('a', 'u-2')),
      );
      expect(clash.kind).toBe('duplicate');
      if (clash.kind !== 'duplicate') return;
      expect(clash.existingId).toBe(identityId('a'));
    });
  });

  it('refreshes what the platform owns, in one statement', () => {
    withRepos((world) => {
      world.store.write((uow) => {
        expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
        expectWritten(world.repos.identities.create(uow, identity('a', 'u-1')), 'an identity');
      });
      const touched = world.store.write((uow) =>
        expectWritten(
          world.repos.identities.touch(uow, identityId('a'), {
            displayNameSnapshot: 'Ana Nowak',
            dmReachable: true,
            dmChatId: 'dm-7',
            lastSeenAt: T0,
          }),
          'a touch',
        ),
      );
      expect(touched.displayNameSnapshot).toBe('Ana Nowak');
      expect(touched.dmReachable).toBe(true);
      expect(touched.dmChatId).toBe('dm-7');
      // From the event, not from the clock: an identity last seen *when the message was sent* is
      // the useful fact, and a backfilled message would otherwise claim present contact.
      expect(touched.lastSeenAt?.toString()).toBe(T0.toString());
    });
  });

  it('leaves unnamed fields alone on a touch', () => {
    withRepos((world) => {
      world.store.write((uow) => {
        expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
        expectWritten(
          world.repos.identities.create(uow, { ...identity('a', 'u-1'), dmChatId: 'dm-1' }),
          'an identity',
        );
      });
      const touched = world.store.write((uow) =>
        expectWritten(
          world.repos.identities.touch(uow, identityId('a'), { lastSeenAt: T0 }),
          'a minimal touch',
        ),
      );
      expect(touched.dmChatId).toBe('dm-1');
      expect(touched.displayNameSnapshot).toBe('Ana');
    });
  });

  it('removes every identity of an erased person', () => {
    withRepos((world) => {
      world.store.write((uow) => {
        expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
        expectWritten(world.repos.identities.create(uow, identity('a', 'u-1')), 'one');
        expectWritten(
          world.repos.identities.create(uow, { ...identity('a', 'u-2'), id: identityId('a2') }),
          'two',
        );
      });
      expect(world.repos.identities.byPerson(personId('a'))).toHaveLength(2);
      const removed = world.store.write((uow) =>
        world.repos.identities.deleteForPerson(uow, personId('a')),
      );
      expect(removed).toBe(2);
      expect(world.repos.identities.byPerson(personId('a'))).toHaveLength(0);
    });
  });
});
