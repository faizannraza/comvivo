/**
 * The keyring format and slot operations (`08` §3.7.4, `02` §3.6.1).
 *
 * Every test here is about a way a host loses their data. The keyring holds the only copies of the
 * root data key, so the failures worth proving are: a malformed file accepted, a slot that opens
 * when it should not, a slot that moves between generations or instances, and the last recovery
 * slot being removed by a command that reports success.
 */

import { BRAND, type InstanceId } from '@comvivo/shared';
import { AAD, KEYRING_FORMAT, randomBytes, wrap } from '@comvivo/shared/crypto';
import { describe, expect, it } from 'vitest';
import {
  currentGeneration,
  generationFor,
  type Keyring,
  KeyringError,
  nextSlotId,
  openSlot,
  parseKeyring,
  putSlot,
  removeSlot,
  sealSlot,
  serialiseKeyring,
} from './keyring.js';
import { buildKeyring, FIXTURE_INSTANCE } from './testing/keyring-fixture.js';

/**
 * The same format, one version newer — "a file written by a build we do not have".
 *
 * Derived from `KEYRING_FORMAT` rather than written out, so this stays a *newer* version of the
 * real format after a rename. The frozen value of `KEYRING_FORMAT` itself is asserted in
 * `shared/src/crypto/labels.test.ts`, which is the one place that may spell it out.
 */
const NEWER_FORMAT = KEYRING_FORMAT.replace(/\/\d+$/, '/2');

describe('parseKeyring', () => {
  it('round-trips a keyring the real builder produced', () => {
    const { keyring } = buildKeyring();
    expect(parseKeyring(serialiseKeyring(keyring))).toEqual(keyring);
  });

  it('refuses text that is not JSON, pointing at the previous file', () => {
    // The hint matters as much as the refusal: a host reading this is mid-outage, and `.prev` is
    // the fastest route back.
    try {
      parseKeyring('{ not json');
      expect.unreachable('malformed JSON should be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(KeyringError);
      expect((error as KeyringError).code).toBe('KEYRING_MALFORMED');
      expect((error as KeyringError).hint).toContain('keyring.json.prev');
    }
  });

  it('distinguishes a newer format from a damaged file', () => {
    // Two very different answers: "upgrade" and "restore". Telling a host the wrong one wastes the
    // worst hour of their year.
    const { keyring } = buildKeyring();
    const newer = { ...keyring, format: NEWER_FORMAT };
    try {
      parseKeyring(JSON.stringify(newer));
      expect.unreachable('an unknown format should be refused');
    } catch (error) {
      expect((error as KeyringError).code).toBe('KEYRING_UNSUPPORTED_FORMAT');
      expect((error as KeyringError).hint).toContain('Upgrade rather than downgrade');
    }
  });

  it('refuses a keyring whose `current` points at a generation that is not there', () => {
    // Nothing could derive a key for new data. Caught at parse time, where the message can say so,
    // rather than at first write where it looks like corruption.
    const { keyring } = buildKeyring();
    expect(() => parseKeyring(JSON.stringify({ ...keyring, current: 99 }))).toThrow(
      /not in the file/,
    );
  });

  it('refuses a generation with no recovery slot', () => {
    // `08` §3.7.8: with the master key gone, the recovery key is the only route back. A generation
    // without one is a generation whose data dies with the key file.
    const { keyring } = buildKeyring();
    const stripped: Keyring = {
      ...keyring,
      generations: keyring.generations.map((generation) => ({
        ...generation,
        slots: generation.slots.filter((slot) => slot.kind !== 'recovery'),
      })),
    };
    expect(() => parseKeyring(JSON.stringify(stripped))).toThrow(/no recovery slot/);
  });

  it('refuses a generation with no slots at all', () => {
    const { keyring } = buildKeyring();
    const empty: Keyring = {
      ...keyring,
      generations: keyring.generations.map((generation) => ({ ...generation, slots: [] })),
    };
    expect(() => parseKeyring(JSON.stringify(empty))).toThrow(/unopenable|no recovery/);
  });

  it('refuses two generations with the same number', () => {
    const { keyring } = buildKeyring();
    const first = keyring.generations[0];
    expect(first).toBeDefined();
    const duplicated: Keyring = {
      ...keyring,
      generations: first === undefined ? [] : [first, first],
    };
    expect(() => parseKeyring(JSON.stringify(duplicated))).toThrow(/share a number/);
  });

  it('refuses two slots with the same id in one generation', () => {
    // Slot ids are part of the AAD, so duplicates would make two wraps indistinguishable — and
    // `removeSlot` would delete both.
    const { keyring } = buildKeyring();
    const generation = currentGeneration(keyring);
    const slot = generation.slots[0];
    expect(slot).toBeDefined();
    const duplicated: Keyring = {
      ...keyring,
      generations: keyring.generations.map((candidate) =>
        candidate.gen === generation.gen && slot !== undefined
          ? { ...candidate, slots: [slot, { ...slot }, ...candidate.slots.slice(1)] }
          : candidate,
      ),
    };
    expect(() => parseKeyring(JSON.stringify(duplicated))).toThrow(/same id/);
  });

  it('refuses a static blob-id key wrapped under a generation that is gone', () => {
    // Blob addresses depend on that key, so a dangling reference means every attachment becomes
    // unreachable — and the error has to say so, because the symptom is "my photos vanished".
    const { keyring } = buildKeyring();
    const dangling: Keyring = {
      ...keyring,
      static: { blobId: { ...keyring.static.blobId, gen: 42 } },
    };
    expect(() => parseKeyring(JSON.stringify(dangling))).toThrow(/not in the file/);
  });

  it.each([
    ['a negative generation', { current: -1 }],
    ['a fractional generation', { current: 1.5 }],
    ['a negative wrap count', { wrapCount: -1 }],
    ['a non-id instance', { instanceId: 'not-an-id' }],
  ])('refuses %s', (_label, patch) => {
    const { keyring } = buildKeyring();
    expect(() => parseKeyring(JSON.stringify({ ...keyring, ...patch }))).toThrow(KeyringError);
  });

  it('refuses a slot id that is not a safe identifier', () => {
    // Slot ids go into the AAD and into CLI output. A path separator or a pipe would let a crafted
    // keyring produce an AAD that collides with another slot's.
    const { keyring } = buildKeyring();
    const generation = currentGeneration(keyring);
    const slot = generation.slots[0];
    expect(slot).toBeDefined();
    for (const bad of ['../mk1', 'mk|1', 'MK1', '', 'a'.repeat(17)]) {
      const patched: Keyring = {
        ...keyring,
        generations: keyring.generations.map((candidate) =>
          candidate.gen === generation.gen && slot !== undefined
            ? {
                ...candidate,
                slots: [{ ...slot, id: bad }, ...candidate.slots.slice(1)],
              }
            : candidate,
        ),
      };
      expect(() => parseKeyring(JSON.stringify(patched)), bad).toThrow(KeyringError);
    }
  });
});

describe('sealSlot and openSlot', () => {
  it('round-trips the root data key', () => {
    const { keyring, masterKey, rootDataKey } = buildKeyring();
    const generation = currentGeneration(keyring);
    const slot = generation.slots.find((candidate) => candidate.kind === 'master');
    expect(slot).toBeDefined();
    if (slot === undefined) return;
    const opened = openSlot({
      instanceId: keyring.instanceId,
      gen: generation.gen,
      slot,
      slotKey: masterKey,
    });
    expect(opened?.equals(rootDataKey)).toBe(true);
  });

  it('returns undefined for the wrong key rather than throwing', () => {
    // Trying slots in turn is the normal unlock path (`08` §3.7.5 step 2), so a miss must not be
    // exceptional — otherwise the happy path runs through a catch block.
    const { keyring } = buildKeyring();
    const generation = currentGeneration(keyring);
    const slot = generation.slots[0];
    expect(slot).toBeDefined();
    if (slot === undefined) return;
    expect(
      openSlot({
        instanceId: keyring.instanceId,
        gen: generation.gen,
        slot,
        slotKey: randomBytes(32),
      }),
    ).toBeUndefined();
  });

  it('rethrows an error that is not a failed unwrap', () => {
    // The `catch` in `openSlot` turns `UnwrapFailed` into `undefined`, because a miss is the normal
    // unlock path. Everything else must keep travelling: a wrong-length key is a caller bug, and
    // swallowing it would report "that key does not match this keyring" to a host whose key is
    // fine — sending them to the recovery-key path for no reason.
    const { keyring } = buildKeyring();
    const generation = currentGeneration(keyring);
    const slot = generation.slots[0];
    expect(slot).toBeDefined();
    if (slot === undefined) return;
    expect(() =>
      openSlot({
        instanceId: keyring.instanceId,
        gen: generation.gen,
        slot,
        slotKey: randomBytes(16),
      }),
    ).toThrow(/needs a 32-byte key, got 16/);
  });

  it('refuses a slot moved to another generation', () => {
    // The AAD binds the generation, so a slot lifted from gen 1 into gen 2 cannot unwrap. Without
    // it, a retired generation's slot would open the active one.
    const { keyring, masterKey } = buildKeyring();
    const generation = currentGeneration(keyring);
    const slot = generation.slots.find((candidate) => candidate.kind === 'master');
    expect(slot).toBeDefined();
    if (slot === undefined) return;
    expect(
      openSlot({
        instanceId: keyring.instanceId,
        gen: generation.gen + 1,
        slot,
        slotKey: masterKey,
      }),
    ).toBeUndefined();
  });

  it('refuses a slot copied from another instance', () => {
    // The binding my first version of the AAD was missing. Without the instance id, a keyring slot
    // copied from one host's `keyring.json` into another's would have unwrapped.
    const { keyring, masterKey } = buildKeyring();
    const generation = currentGeneration(keyring);
    const slot = generation.slots.find((candidate) => candidate.kind === 'master');
    expect(slot).toBeDefined();
    if (slot === undefined) return;
    expect(
      openSlot({
        instanceId: 'inst_01jd9zzzzzzzzzzzzzzzzzzzzz' as InstanceId,
        gen: generation.gen,
        slot,
        slotKey: masterKey,
      }),
    ).toBeUndefined();
  });

  it('refuses a slot relabelled to another kind', () => {
    // A `master` wrap presented as a `recovery` slot would let `verify-recovery` report success
    // against the master key — telling a host their recovery key works when it has never been
    // tested.
    const { keyring, masterKey } = buildKeyring();
    const generation = currentGeneration(keyring);
    const slot = generation.slots.find((candidate) => candidate.kind === 'master');
    expect(slot).toBeDefined();
    if (slot === undefined) return;
    expect(
      openSlot({
        instanceId: keyring.instanceId,
        gen: generation.gen,
        slot: { ...slot, kind: 'recovery' },
        slotKey: masterKey,
      }),
    ).toBeUndefined();
  });

  it('refuses a slot whose id was changed', () => {
    const { keyring, masterKey } = buildKeyring();
    const generation = currentGeneration(keyring);
    const slot = generation.slots.find((candidate) => candidate.kind === 'master');
    expect(slot).toBeDefined();
    if (slot === undefined) return;
    expect(
      openSlot({
        instanceId: keyring.instanceId,
        gen: generation.gen,
        slot: { ...slot, id: 'mk9' },
        slotKey: masterKey,
      }),
    ).toBeUndefined();
  });

  it('detects a tampered wrap', () => {
    const { keyring, masterKey } = buildKeyring();
    const generation = currentGeneration(keyring);
    const slot = generation.slots.find((candidate) => candidate.kind === 'master');
    expect(slot).toBeDefined();
    if (slot === undefined) return;
    const sealed = Buffer.from(slot.wrap.sealed, 'base64url');
    sealed[20] = (sealed[20] ?? 0) ^ 0x01;
    expect(
      openSlot({
        instanceId: keyring.instanceId,
        gen: generation.gen,
        slot: { ...slot, wrap: { ...slot.wrap, sealed: sealed.toString('base64url') } },
        slotKey: masterKey,
      }),
    ).toBeUndefined();
  });

  it('opens a recovery slot with its HKDF-derived key, not the recovery key', () => {
    // `08` §3.7.6: the slot key is `HKDF(RK, salt=instanceId, info=…/rk-slot)`. A caller who
    // presented the raw recovery key would get a miss, which is correct and worth pinning.
    const { keyring, recoverySlotKey, rootDataKey } = buildKeyring();
    const generation = currentGeneration(keyring);
    const slot = generation.slots.find((candidate) => candidate.kind === 'recovery');
    expect(slot).toBeDefined();
    if (slot === undefined) return;
    const opened = openSlot({
      instanceId: keyring.instanceId,
      gen: generation.gen,
      slot,
      slotKey: recoverySlotKey,
    });
    expect(opened?.equals(rootDataKey)).toBe(true);
  });

  it('calls a wrap that is not base64url damage, not a wrong key', () => {
    // This test used to assert only `toBeUndefined()` — "either way the slot must not open" — and
    // that was the wrong bar. `Buffer.from` is lenient (`'!!!!'` decodes to zero bytes), so the
    // garbage reached the AEAD and came back as an ordinary miss, which the unlock path reports as
    // `KEYRING_NO_MATCHING_SLOT`: "the key does not match this keyring… recover with your recovery
    // key". A host whose file is merely damaged would have been sent to the recovery-key path
    // instead of to `keyring.json.prev`. Not opening is necessary; saying *why* is the product.
    const { keyring, masterKey } = buildKeyring();
    const generation = currentGeneration(keyring);
    const slot = generation.slots[0];
    expect(slot).toBeDefined();
    if (slot === undefined) return;
    try {
      openSlot({
        instanceId: keyring.instanceId,
        gen: generation.gen,
        slot: { ...slot, wrap: { ...slot.wrap, sealed: '!!!not base64!!!' } },
        slotKey: masterKey,
      });
      expect.unreachable('a malformed wrap is damage');
    } catch (caught) {
      expect(caught).toBeInstanceOf(KeyringError);
      const error = caught as KeyringError;
      expect(error.code).toBe('KEYRING_MALFORMED');
      expect(error.message).toContain('and a wrap is 60');
      expect(error.hint).toContain('damaged, not unlocked by the wrong key');
      expect(error.hint).toContain('keyring.json.prev');
    }
  });

  it('refuses a truncated wrap for the same reason', () => {
    // Correct alphabet, wrong length — a copy/paste that lost the tail. Indistinguishable from a
    // wrong key before this check, and the hint matters more here than anywhere: the bytes are
    // gone, so the recovery key really is the answer if there is no `.prev`.
    const { keyring, masterKey } = buildKeyring();
    const slot = currentGeneration(keyring).slots[0];
    expect(slot).toBeDefined();
    if (slot === undefined) return;
    expect(() =>
      openSlot({
        instanceId: keyring.instanceId,
        gen: keyring.current,
        slot: { ...slot, wrap: { ...slot.wrap, sealed: slot.wrap.sealed.slice(0, 40) } },
        slotKey: masterKey,
      }),
    ).toThrow(/holds 30 bytes, and a wrap is 60/);
  });

  it('refuses the malformed wrap at the file boundary too', () => {
    // The same defect, caught one layer earlier. A keyring read from disk should never reach
    // `openSlot` with a broken wrap at all: `parseKeyring` is the boundary, so the diagnosis
    // arrives before any unlock is attempted and before any slot key is derived.
    const { keyring } = buildKeyring();
    const damaged = {
      ...keyring,
      generations: keyring.generations.map((generation) => ({
        ...generation,
        slots: generation.slots.map((slot) => ({
          ...slot,
          wrap: { ...slot.wrap, sealed: '!!!not base64!!!' },
        })),
      })),
    };
    expect(() => parseKeyring(JSON.stringify(damaged))).toThrow(/unpadded base64url/);
  });

  it('refuses a correctly-encoded wrap of the wrong size at the boundary', () => {
    const { keyring } = buildKeyring();
    const damaged = {
      ...keyring,
      static: {
        blobId: {
          ...keyring.static.blobId,
          wrap: { ...keyring.static.blobId.wrap, sealed: 'aaaaaaaaaaaa' },
        },
      },
    };
    expect(() => parseKeyring(JSON.stringify(damaged))).toThrow(/decodes to 60 bytes/);
  });
});

describe('removeSlot', () => {
  it('removes an ordinary slot', () => {
    const { keyring } = buildKeyring({ withPassphrase: true });
    const after = removeSlot(keyring, keyring.current, 'pp1');
    expect(currentGeneration(after).slots.map((slot) => slot.id)).toEqual(['mk1', 'rk1']);
  });

  it('refuses to remove the last recovery slot', () => {
    // `M1-T5`'s acceptance criterion. A `remove-slot` that could take the last one away is a
    // command that destroys a host's data while reporting success.
    const { keyring } = buildKeyring();
    try {
      removeSlot(keyring, keyring.current, 'rk1');
      expect.unreachable('the last recovery slot must not be removable');
    } catch (error) {
      expect((error as KeyringError).code).toBe('KEYRING_LAST_RECOVERY_SLOT');
      expect((error as KeyringError).hint).toContain('rotate-recovery');
    }
  });

  it('allows removing a recovery slot when another one remains', () => {
    // Which is how `rotate-recovery` works: add the new slot, then remove the old.
    const { keyring, recoverySlotKey, rootDataKey } = buildKeyring();
    const second = sealSlot({
      instanceId: keyring.instanceId,
      gen: keyring.current,
      id: 'rk2',
      kind: 'recovery',
      slotKey: recoverySlotKey,
      rootDataKey,
    });
    const withBoth = putSlot(keyring, keyring.current, second);
    const after = removeSlot(withBoth, keyring.current, 'rk1');
    expect(currentGeneration(after).slots.map((slot) => slot.id)).toContain('rk2');
    expect(currentGeneration(after).slots.map((slot) => slot.id)).not.toContain('rk1');
  });

  it('checks per generation, because a retired generation still opens old backups', () => {
    // A retired generation whose recovery slot is gone is a set of backups nobody can restore.
    const { keyring } = buildKeyring({ gen: 2, retiredGenerations: [1] });
    expect(() => removeSlot(keyring, 1, 'rk1')).toThrow(/only recovery slot in generation 1/);
  });

  it('refuses to remove a lone recovery slot by the recovery rule, not the count rule', () => {
    // Two guards can refuse this, and which one answers matters: the recovery rule's hint tells a
    // host to run `rotate-recovery` first, and the count rule's does not. Asserting only
    // `KeyringError` let this pass while never reaching the count rule at all.
    const { keyring } = buildKeyring();
    const onlyRecovery: Keyring = {
      ...keyring,
      generations: keyring.generations.map((generation) => ({
        ...generation,
        slots: generation.slots.filter((slot) => slot.kind === 'recovery'),
      })),
    };
    try {
      removeSlot(onlyRecovery, keyring.current, 'rk1');
      expect.unreachable('the only recovery slot must not be removable');
    } catch (caught) {
      expect(caught).toBeInstanceOf(KeyringError);
      const error = caught as KeyringError;
      expect(error.code).toBe('KEYRING_LAST_RECOVERY_SLOT');
      expect(error.message).toContain('only recovery slot');
      expect(error.hint).toContain('rotate-recovery');
    }
  });

  it('refuses to empty a generation even when no recovery slot is involved', () => {
    // The count rule in its own right. `keyringSchema` refuses a generation with no recovery slot,
    // so this shape only exists in memory — which is exactly where `comvivo keys remove-slot`
    // builds its candidate before writing. A generation with no slots cannot be opened by
    // anything, so emptying one is silent data loss whatever the remaining slot's kind was.
    const { keyring } = buildKeyring();
    const onlyMaster: Keyring = {
      ...keyring,
      generations: keyring.generations.map((generation) => ({
        ...generation,
        slots: generation.slots.filter((slot) => slot.kind === 'master'),
      })),
    };
    try {
      removeSlot(onlyMaster, keyring.current, 'mk1');
      expect.unreachable('a generation cannot be emptied');
    } catch (caught) {
      expect(caught).toBeInstanceOf(KeyringError);
      const error = caught as KeyringError;
      expect(error.code).toBe('KEYRING_LAST_RECOVERY_SLOT');
      expect(error.message).toContain('is the only slot in generation');
      expect(error.hint).toContain('Add another slot first');
    }
  });

  it('leaves every other generation untouched', () => {
    // `08` §3.7.7 keeps retired generations so old backups still open, so a `remove-slot` aimed at
    // the current generation must not disturb them — and the mapping that does the removal has to
    // return the other generations unchanged, by identity, not rebuilt.
    const { keyring } = buildKeyring({ gen: 2, retiredGenerations: [1], withPassphrase: true });
    const before = keyring.generations.find((generation) => generation.gen === 1);
    expect(before).toBeDefined();

    const after = removeSlot(keyring, 2, 'pp1');

    expect(currentGeneration(after).slots.map((slot) => slot.id)).toEqual(['mk1', 'rk1']);
    expect(after.generations.find((generation) => generation.gen === 1)).toBe(before);
  });

  it('reports a slot that is not there', () => {
    const { keyring } = buildKeyring();
    expect(() => removeSlot(keyring, keyring.current, 'nope')).toThrow(/has no slot "nope"/);
  });

  it('reports a generation that is not there, mentioning purge-retired', () => {
    // The commonest cause of a missing generation is somebody having run `purge-retired`, and the
    // message should say so rather than leaving a host to guess.
    const { keyring } = buildKeyring();
    try {
      removeSlot(keyring, 99, 'rk1');
      expect.unreachable('a missing generation should be refused');
    } catch (error) {
      expect((error as KeyringError).code).toBe('KEYRING_GENERATION_MISSING');
      expect((error as KeyringError).hint).toContain('purge-retired');
    }
  });

  it('leaves the keyring it was given untouched', () => {
    // The operations are pure, so a failed write cannot leave a half-mutated keyring in memory
    // that a later write would persist.
    const { keyring } = buildKeyring({ withPassphrase: true });
    const before = serialiseKeyring(keyring);
    removeSlot(keyring, keyring.current, 'pp1');
    expect(serialiseKeyring(keyring)).toBe(before);
  });
});

describe('putSlot', () => {
  it('adds a slot and keeps the ids sorted', () => {
    const { keyring, masterKey, rootDataKey } = buildKeyring();
    const slot = sealSlot({
      instanceId: keyring.instanceId,
      gen: keyring.current,
      id: 'mk2',
      kind: 'master',
      slotKey: masterKey,
      rootDataKey,
    });
    const after = putSlot(keyring, keyring.current, slot);
    expect(currentGeneration(after).slots.map((s) => s.id)).toEqual(['mk1', 'mk2', 'rk1']);
  });

  it('leaves every other generation untouched, by identity', () => {
    // `rotate-recovery` adds a slot to the current generation while retired generations keep
    // opening old backups (`08` §3.7.7). The other generations must come back unchanged — and the
    // identity check is the one that would catch a rebuild that re-sorted or re-serialised them.
    const { keyring, masterKey, rootDataKey } = buildKeyring({ gen: 2, retiredGenerations: [1] });
    const retiredBefore = keyring.generations.find((generation) => generation.gen === 1);
    expect(retiredBefore).toBeDefined();

    const after = putSlot(
      keyring,
      2,
      sealSlot({
        instanceId: keyring.instanceId,
        gen: 2,
        id: 'mk2',
        kind: 'master',
        slotKey: masterKey,
        rootDataKey,
      }),
    );

    expect(currentGeneration(after).slots.map((slot) => slot.id)).toEqual(['mk1', 'mk2', 'rk1']);
    expect(after.generations.find((generation) => generation.gen === 1)).toBe(retiredBefore);
  });

  it('replaces a slot with the same id rather than duplicating it', () => {
    // `rotate-master` writes a new `mk` slot; if it duplicated the id, the schema would refuse the
    // file *after* the old one had been moved to `.prev`.
    const { keyring, rootDataKey } = buildKeyring();
    const replacement = sealSlot({
      instanceId: keyring.instanceId,
      gen: keyring.current,
      id: 'mk1',
      kind: 'master',
      slotKey: randomBytes(32),
      rootDataKey,
    });
    const after = putSlot(keyring, keyring.current, replacement);
    expect(currentGeneration(after).slots.filter((s) => s.id === 'mk1')).toHaveLength(1);
  });

  it('refuses a generation that is not there', () => {
    const { keyring, masterKey, rootDataKey } = buildKeyring();
    const slot = sealSlot({
      instanceId: keyring.instanceId,
      gen: 99,
      id: 'mk1',
      kind: 'master',
      slotKey: masterKey,
      rootDataKey,
    });
    expect(() => putSlot(keyring, 99, slot)).toThrow(KeyringError);
  });
});

describe('nextSlotId', () => {
  it('allocates the first free id for a kind', () => {
    const { keyring } = buildKeyring();
    const generation = currentGeneration(keyring);
    expect(nextSlotId(generation, 'master')).toBe('mk2');
    expect(nextSlotId(generation, 'recovery')).toBe('rk2');
    expect(nextSlotId(generation, 'passphrase')).toBe('pp1');
  });

  it('skips ids already in use', () => {
    const { keyring, masterKey, rootDataKey } = buildKeyring();
    const withMk2 = putSlot(
      keyring,
      keyring.current,
      sealSlot({
        instanceId: keyring.instanceId,
        gen: keyring.current,
        id: 'mk2',
        kind: 'master',
        slotKey: masterKey,
        rootDataKey,
      }),
    );
    expect(nextSlotId(currentGeneration(withMk2), 'master')).toBe('mk3');
  });

  it('produces an id the schema accepts', () => {
    const { keyring } = buildKeyring();
    const generation = currentGeneration(keyring);
    for (const kind of ['master', 'recovery', 'passphrase'] as const) {
      expect(nextSlotId(generation, kind)).toMatch(/^[a-z][a-z0-9]{0,15}$/);
    }
  });

  it('refuses rather than wrapping around once a kind is exhausted', () => {
    // 999 master slots in one generation is not a situation to paper over: returning `mk1` again
    // would overwrite a live slot, and silently taking someone's unlock route away is the one
    // failure this module exists to prevent. The ids are built directly — sealing 999 real wraps
    // would cost a second for nothing, since `nextSlotId` only reads ids.
    const { keyring, masterKey, rootDataKey } = buildKeyring();
    const template = sealSlot({
      instanceId: keyring.instanceId,
      gen: keyring.current,
      id: 'mk1',
      kind: 'master',
      slotKey: masterKey,
      rootDataKey,
    });
    const generation = {
      ...currentGeneration(keyring),
      slots: Array.from({ length: 999 }, (_, i) => ({ ...template, id: `mk${String(i + 1)}` })),
    };

    try {
      nextSlotId(generation, 'master');
      expect.unreachable('999 master slots should be refused');
    } catch (caught) {
      expect(caught).toBeInstanceOf(KeyringError);
      const error = caught as KeyringError;
      expect(error.code).toBe('KEYRING_MALFORMED');
      expect(error.message).toContain('999 master slots');
      expect(error.hint).toContain(`${BRAND.cliName} keys remove-slot`);
    }
  });

  it('still allocates a different kind when one kind is exhausted', () => {
    // The exhaustion is per kind, so a host who has churned master keys can still add a recovery
    // slot — which is the slot `08` §3.7.8 says must always be addable.
    const { keyring, masterKey, rootDataKey } = buildKeyring();
    const template = sealSlot({
      instanceId: keyring.instanceId,
      gen: keyring.current,
      id: 'mk1',
      kind: 'master',
      slotKey: masterKey,
      rootDataKey,
    });
    const generation = {
      ...currentGeneration(keyring),
      slots: Array.from({ length: 999 }, (_, i) => ({ ...template, id: `mk${String(i + 1)}` })),
    };

    expect(nextSlotId(generation, 'recovery')).toBe('rk1');
  });
});

describe('generation lookup', () => {
  it('finds the current generation', () => {
    const { keyring } = buildKeyring({ gen: 2, retiredGenerations: [1] });
    expect(currentGeneration(keyring).gen).toBe(2);
    expect(currentGeneration(keyring).status).toBe('active');
  });

  it('finds a retired generation by number', () => {
    const { keyring } = buildKeyring({ gen: 2, retiredGenerations: [1] });
    expect(generationFor(keyring, 1).status).toBe('retired');
  });

  it('throws for a generation that is not there', () => {
    const { keyring } = buildKeyring();
    expect(() => generationFor(keyring, 7)).toThrow(KeyringError);
  });

  it('throws for a `current` that was never validated', () => {
    // Reachable only by constructing a keyring in memory and skipping the parser, which is a bug
    // — and the message says so rather than pretending it is a host problem.
    const { keyring } = buildKeyring();
    const broken = { ...keyring, current: 99 } as Keyring;
    try {
      currentGeneration(broken);
      expect.unreachable('an unvalidated keyring should be refused');
    } catch (error) {
      expect((error as KeyringError).code).toBe('KEYRING_GENERATION_MISSING');
      // The message blames the data; the **hint** blames us. That split is deliberate: the keyring
      // schema already refuses this shape, so reaching here means a keyring was assembled in
      // memory without validation — which is our bug, not the host's, and the hint must not send
      // them hunting through their key files.
      expect((error as KeyringError).hint).toContain('This is a bug');
    }
  });
});

describe('the AAD matches `08` §3.7.4 exactly', () => {
  it('is the four-part keyring string, not the two-part one', () => {
    // Pinned here as well as in `shared/crypto/labels.test.ts`, because this is the module that
    // would quietly weaken it: `sealSlot` chooses what goes into the AAD.
    const { keyring, rootDataKey } = buildKeyring();
    const slotKey = randomBytes(32);
    const slot = sealSlot({
      instanceId: keyring.instanceId,
      gen: 3,
      id: 'rk7',
      kind: 'recovery',
      slotKey,
      rootDataKey,
    });
    // The same bytes must unwrap under the AAD the labels module builds, and under nothing else.
    const expected = AAD.keyringSlot(FIXTURE_INSTANCE, 3, 'rk7', 'recovery');
    expect(expected).toBe(`${KEYRING_FORMAT}|${FIXTURE_INSTANCE}|gen=3|slot=rk7|kind=recovery`);
    const resealed = wrap(slotKey, rootDataKey, expected).toString('base64url');
    expect(resealed).not.toBe(slot.wrap.sealed); // different nonce
    expect(
      openSlot({ instanceId: keyring.instanceId, gen: 3, slot, slotKey })?.equals(rootDataKey),
    ).toBe(true);
  });
});
