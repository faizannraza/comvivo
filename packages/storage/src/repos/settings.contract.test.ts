/**
 * `SettingsReader`/`SettingsRepository` against ADR-014 and `01` §14 A14 (`M1-T17`).
 *
 * The rule this file exists for is **A14: no host-only keys in the database**. A value stored here
 * is readable by anyone who can read the database file, which includes a backup restored onto
 * another machine — so a passphrase or a platform token in this table would survive every boundary
 * `08` draws around secrets. The refusal is on the **write**, because a forbidden key that was
 * already written would be filtered on read and still sit in the file, and in every backup taken
 * since.
 */
import { INSTANCE_SCOPE, isPersistableSettingKey, settingScope } from '@comvivo/core';
import { StorageError } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import { memberId, personId, withRepos } from './testing/harness.js';

describe('settingScope', () => {
  it('spells each scope the way 02 §3.3.8 does', () => {
    // One function, so `'member:'` is written once: a caller that spelled it `'members:'` would
    // write settings nobody reads and read defaults forever — a failure with no error.
    expect(settingScope({ kind: 'instance' })).toBe('_instance');
    expect(settingScope({ kind: 'instance' })).toBe(INSTANCE_SCOPE);
    expect(settingScope({ kind: 'member', memberId: memberId('a') })).toBe(
      `member:${memberId('a')}`,
    );
    expect(settingScope({ kind: 'person', personId: personId('a') })).toBe(
      `person:${personId('a')}`,
    );
  });

  it('uses the bare group id for a group scope', () => {
    withRepos((world) => {
      expect(settingScope({ kind: 'group', groupId: world.groupId })).toBe(world.groupId);
    });
  });
});

describe('the A14 host-only rule', () => {
  it('refuses anything whose key names a credential', () => {
    for (const key of [
      'anthropic.apiKey',
      'telegram.bot_token',
      'db.passphrase',
      'smtp.password',
      'matrix.credential',
      'keyfile.path',
      'signing.private_key',
      'some.SECRET.thing',
    ]) {
      expect(isPersistableSettingKey(key), key).toBe(false);
    }
  });

  it('allows ordinary runtime settings', () => {
    for (const key of [
      'quietHours.start',
      'proactivity.enabled',
      'memory.retentionDays',
      'dashboard.theme',
      'model.chat',
    ]) {
      expect(isPersistableSettingKey(key), key).toBe(true);
    }
  });

  it('is case-insensitive, because the separator and the case are a caller style choice', () => {
    expect(isPersistableSettingKey('Anthropic.ApiKey')).toBe(false);
    expect(isPersistableSettingKey('ANTHROPIC.API_KEY')).toBe(false);
  });

  it('throws on the write, naming the word that tripped it', () => {
    withRepos((world) => {
      let caught: unknown;
      try {
        world.store.write((uow) =>
          world.repos.settings.set(uow, INSTANCE_SCOPE, 'anthropic.apiKey', '"sk-x"'),
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StorageError);
      const error = caught as StorageError;
      expect(error.storageCode).toBe('STORAGE_CONSTRAINT');
      // The word, so a developer fixes it in one step.
      expect(error.message).toContain('apikey');
      expect(error.hint).toContain('backup');
      // And nothing was written.
      expect(world.repos.settings.get(INSTANCE_SCOPE, 'anthropic.apiKey')).toBeUndefined();
    });
  });
});

describe('SettingsRepository', () => {
  it('sets, reads and overwrites', () => {
    withRepos((world) => {
      const set = world.store.write((uow) =>
        world.repos.settings.set(uow, INSTANCE_SCOPE, 'dashboard.theme', '"dark"', 'host'),
      );
      expect(set.value).toBe('"dark"');
      expect(set.updatedBy).toBe('host');
      expect(world.repos.settings.get(INSTANCE_SCOPE, 'dashboard.theme')).toBe('"dark"');

      world.store.write((uow) =>
        world.repos.settings.set(uow, INSTANCE_SCOPE, 'dashboard.theme', '"light"'),
      );
      expect(world.repos.settings.get(INSTANCE_SCOPE, 'dashboard.theme')).toBe('"light"');
      // Not attributed to whoever made the last change: an update with no `updatedBy` means
      // nobody is named, and keeping the previous one would misattribute this change.
      expect(world.repos.settings.byScope(INSTANCE_SCOPE)[0]?.updatedBy).toBeUndefined();
    });
  });

  it('keeps the same key in different scopes apart', () => {
    withRepos((world) => {
      const groupScope = settingScope({ kind: 'group', groupId: world.groupId });
      world.store.write((uow) => {
        world.repos.settings.set(uow, INSTANCE_SCOPE, 'quietHours.start', '"22:00"');
        world.repos.settings.set(uow, groupScope, 'quietHours.start', '"21:00"');
      });
      expect(world.repos.settings.get(INSTANCE_SCOPE, 'quietHours.start')).toBe('"22:00"');
      expect(world.repos.settings.get(groupScope, 'quietHours.start')).toBe('"21:00"');
    });
  });

  describe('resolve', () => {
    it('returns the first scope in the chain that has a value', () => {
      withRepos((world) => {
        const groupScope = settingScope({ kind: 'group', groupId: world.groupId });
        const memberScope = settingScope({ kind: 'member', memberId: memberId('a') });
        world.store.write((uow) => {
          world.repos.settings.set(uow, INSTANCE_SCOPE, 'quietHours.start', '"22:00"');
          world.repos.settings.set(uow, groupScope, 'quietHours.start', '"21:00"');
        });
        // Most specific first. The member has none, so the group's wins.
        const chain = [memberScope, groupScope, INSTANCE_SCOPE];
        expect(world.repos.settings.resolve(chain, 'quietHours.start')?.value).toBe('"21:00"');

        world.store.write((uow) =>
          world.repos.settings.set(uow, memberScope, 'quietHours.start', '"23:00"'),
        );
        expect(world.repos.settings.resolve(chain, 'quietHours.start')?.value).toBe('"23:00"');
      });
    });

    it('respects the chain order, not the order the rows came back in', () => {
      withRepos((world) => {
        const groupScope = settingScope({ kind: 'group', groupId: world.groupId });
        world.store.write((uow) => {
          // Written instance-first, so a `resolve` that trusted the row order would answer
          // `"22:00"` — the `IN` clause does not preserve the chain's order, which is why the
          // implementation maps and then walks the chain.
          world.repos.settings.set(uow, INSTANCE_SCOPE, 'a.key', '"22:00"');
          world.repos.settings.set(uow, groupScope, 'a.key', '"21:00"');
        });
        expect(world.repos.settings.resolve([groupScope, INSTANCE_SCOPE], 'a.key')?.value).toBe(
          '"21:00"',
        );
        // And the reverse chain gives the reverse answer, which is what proves the order is read.
        expect(world.repos.settings.resolve([INSTANCE_SCOPE, groupScope], 'a.key')?.value).toBe(
          '"22:00"',
        );
      });
    });

    it('returns undefined for an empty chain and for a key nobody set', () => {
      withRepos((world) => {
        expect(world.repos.settings.resolve([], 'a.key')).toBeUndefined();
        expect(world.repos.settings.resolve([INSTANCE_SCOPE], 'nothing.here')).toBeUndefined();
      });
    });
  });

  it('unsets one key, so the next read falls through', () => {
    withRepos((world) => {
      const groupScope = settingScope({ kind: 'group', groupId: world.groupId });
      world.store.write((uow) => {
        world.repos.settings.set(uow, INSTANCE_SCOPE, 'a.key', '"instance"');
        world.repos.settings.set(uow, groupScope, 'a.key', '"group"');
      });
      const removed = world.store.write((uow) =>
        world.repos.settings.unset(uow, groupScope, 'a.key'),
      );
      expect(removed).toBe(true);
      expect(world.repos.settings.resolve([groupScope, INSTANCE_SCOPE], 'a.key')?.value).toBe(
        '"instance"',
      );
      // Unsetting what is not there is `false`, not an error: a clear is idempotent.
      expect(world.store.write((uow) => world.repos.settings.unset(uow, groupScope, 'a.key'))).toBe(
        false,
      );
    });
  });

  it('clears a whole scope, for a member who left or a group being deleted', () => {
    withRepos((world) => {
      const memberScope = settingScope({ kind: 'member', memberId: memberId('a') });
      world.store.write((uow) => {
        world.repos.settings.set(uow, memberScope, 'a.key', '1');
        world.repos.settings.set(uow, memberScope, 'b.key', '2');
        world.repos.settings.set(uow, INSTANCE_SCOPE, 'c.key', '3');
      });
      const cleared = world.store.write((uow) => world.repos.settings.clearScope(uow, memberScope));
      expect(cleared).toBe(2);
      expect(world.repos.settings.byScope(memberScope)).toHaveLength(0);
      // And the instance scope is untouched.
      expect(world.repos.settings.byScope(INSTANCE_SCOPE)).toHaveLength(1);
    });
  });

  it('rolls back with its transaction', () => {
    withRepos((world) => {
      expect(() =>
        world.store.write((uow) => {
          world.repos.settings.set(uow, INSTANCE_SCOPE, 'a.key', '1');
          throw new Error('changed my mind');
        }),
      ).toThrow('changed my mind');
      expect(world.repos.settings.get(INSTANCE_SCOPE, 'a.key')).toBeUndefined();
    });
  });
});
