/**
 * `KeyService` — the key tree, and the zeroing discipline (`08` §3.7.2–§3.7.5, `02` §3.6.1).
 *
 * Two kinds of test here. The first walks `08` §3.7.8's loss table: master key gone but recovery
 * key held, both gone but a passphrase set, everything gone. Those rows are promises to a host
 * about what they can still recover, and each one is either true or it is not.
 *
 * The second is about **when keys stop existing in memory**. `02` §3.6.1 says the root data key is
 * zeroed after derivation, and that is not decoration: a core dump or a swapped page containing the
 * root key contains every key, where one containing the blob KEK contains only the blob KEK.
 */

import { BRAND, type InstanceId } from '@comvivo/shared';
import { derivePurposeKey, KEY_PURPOSE, keyInfo, randomBytes } from '@comvivo/shared/crypto';
import { describe, expect, it } from 'vitest';
import {
  isZeroed,
  KeyService,
  newBlobIdKey,
  newRootDataKey,
  passphraseSlotKey,
  unlock,
} from './key-service.js';
import { currentGeneration, KeyringError, openSlot, sealSlot } from './keyring.js';
import { buildKeyring, FAST_SCRYPT } from './testing/keyring-fixture.js';

/** Unlock with the master key, which is the ordinary path. */
function unlockWithMaster(): { service: KeyService; blobIdKey: Buffer; rootDataKey: Buffer } {
  const fixture = buildKeyring();
  const service = unlock({ keyring: fixture.keyring, slotKey: Buffer.from(fixture.masterKey) });
  return { service, blobIdKey: fixture.blobIdKey, rootDataKey: fixture.rootDataKey };
}

describe('unlock (08 §3.7.5 step 2)', () => {
  it('opens with the master key and records which slot matched', () => {
    // `08` §3.7.5 step 5 logs `keys.unlocked {source, gen}`, and this is where that comes from.
    const fixture = buildKeyring();
    const service = unlock({ keyring: fixture.keyring, slotKey: Buffer.from(fixture.masterKey) });
    expect(service.unlockRecord).toEqual({ slotKind: 'master', slotId: 'mk1', gen: 1 });
    expect(service.generation).toBe(1);
    expect(service.instanceId).toBe(fixture.keyring.instanceId);
  });

  it('opens with the recovery slot key when the master key is gone', () => {
    // `08` §3.7.8 row 1: "MK lost, RK held → no data loss." The whole recovery story rests on
    // this working, and on it working *without* the master key being present at all.
    const fixture = buildKeyring();
    const service = unlock({
      keyring: fixture.keyring,
      slotKey: Buffer.from(fixture.recoverySlotKey),
    });
    expect(service.unlockRecord.slotKind).toBe('recovery');
  });

  it('opens with a passphrase when the master and recovery keys are both gone', async () => {
    // `08` §3.7.8 row 2. The passphrase slot is optional, and this is the only thing that makes it
    // worth having.
    const fixture = buildKeyring({ withPassphrase: true });
    const generation = currentGeneration(fixture.keyring);
    const slot = generation.slots.find((candidate) => candidate.kind === 'passphrase');
    expect(slot).toBeDefined();
    // Asserted, not merely narrowed: `fixture.passphrase` being absent would make this test
    // `return` having checked only that a slot exists — and it is the **only** test of `08`
    // §3.7.8 row 2, the passphrase unlock. Found by the M1 independent review.
    expect(fixture.passphrase, 'the fixture did not set a passphrase').toBeDefined();
    if (slot === undefined || fixture.passphrase === undefined) return;

    const slotKey = await passphraseSlotKey(fixture.passphrase, slot);
    const service = unlock({ keyring: fixture.keyring, slotKey });
    expect(service.unlockRecord.slotKind).toBe('passphrase');
  });

  it('refuses every slot when the key matches none, and never starts unencrypted', () => {
    // `08` §3.7.5 step 2 in bold: "Never start unencrypted as a fallback." The hint has to say so,
    // because a host staring at a refusal will look for a way to skip it.
    const fixture = buildKeyring();
    try {
      unlock({ keyring: fixture.keyring, slotKey: randomBytes(32) });
      expect.unreachable('a wrong key should open nothing');
    } catch (error) {
      expect((error as KeyringError).code).toBe('KEYRING_NO_MATCHING_SLOT');
      expect((error as KeyringError).hint).toContain('will not start unencrypted');
      expect((error as KeyringError).hint).toContain(`${BRAND.cliName} keys recover`);
    }
  });

  it('tries every slot, so slot order does not decide whether unlock works', () => {
    // The passphrase slot is last in the file. A loop that stopped at the first miss would make
    // passphrase mode work only by accident of ordering.
    const fixture = buildKeyring({ withPassphrase: true });
    const service = unlock({
      keyring: fixture.keyring,
      slotKey: Buffer.from(fixture.recoverySlotKey),
    });
    expect(service.unlockRecord.slotId).toBe('rk1');
  });

  it('can be restricted to one kind, for verify-recovery', () => {
    // `comvivo keys verify-recovery` has to answer "does *the recovery key* work", and a check
    // that would also accept the master key would report success on a recovery key that has never
    // been tested — which is the one question the command exists to answer.
    const fixture = buildKeyring();
    expect(() =>
      unlock({
        keyring: fixture.keyring,
        slotKey: Buffer.from(fixture.masterKey),
        onlyKind: 'recovery',
      }),
    ).toThrow(KeyringError);

    const service = unlock({
      keyring: fixture.keyring,
      slotKey: Buffer.from(fixture.recoverySlotKey),
      onlyKind: 'recovery',
    });
    expect(service.unlockRecord.slotKind).toBe('recovery');
  });

  it('reports plainly when a generation has no slot of the requested kind', () => {
    const fixture = buildKeyring();
    try {
      unlock({
        keyring: fixture.keyring,
        slotKey: Buffer.from(fixture.masterKey),
        onlyKind: 'passphrase',
      });
      expect.unreachable('there is no passphrase slot');
    } catch (error) {
      expect((error as KeyringError).message).toContain('no passphrase slot');
      expect((error as KeyringError).hint).toContain(`${BRAND.cliName} keys status`);
    }
  });

  it('opens a retired generation, which is how an old backup is read', () => {
    // `08` §3.7.7's `purge-retired` exists because retired generations are kept deliberately: old
    // backups are wrapped under them.
    //
    // The first version of `#unwrapStaticBlobIdKey` threw here, because `08` §3.7.2 wraps the
    // static keys under the **current** generation only. That would have surfaced at `M1-T27` as
    // "restoring an old backup reports a damaged keyring" — sending a host to recover a keyring
    // that was never broken.
    const fixture = buildKeyring({ gen: 2, retiredGenerations: [1] });
    const service = unlock({
      keyring: fixture.keyring,
      slotKey: Buffer.from(fixture.masterKey),
      gen: 1,
    });
    expect(service.generation).toBe(1);
    // The keys derived from that generation's root key are all there.
    expect(service.blobKek).toHaveLength(32);
    expect(service.backupKek).toHaveLength(32);
  });

  it('reports the blob-id key as unavailable from a retired generation, and says where to get it', () => {
    // Not an error condition: `08` §3.7.2 wraps static keys by the current RDK, and `08` §3.7.11
    // makes the backup's own `keyringSnapshot.static.blobId` required for exactly this reason.
    const fixture = buildKeyring({ gen: 2, retiredGenerations: [1] });
    const retired = unlock({
      keyring: fixture.keyring,
      slotKey: Buffer.from(fixture.masterKey),
      gen: 1,
    });
    expect(retired.hasBlobIdKey).toBe(false);
    try {
      void retired.blobIdKey;
      expect.unreachable('a retired generation cannot unwrap the static keys');
    } catch (error) {
      expect((error as KeyringError).code).toBe('KEYRING_GENERATION_MISSING');
      expect((error as KeyringError).hint).toContain('08 §3.7.11');
      expect((error as KeyringError).hint).toContain('keyring snapshot');
    }

    // And the current generation has it, so the branch is real rather than always-false.
    const current = unlock({ keyring: fixture.keyring, slotKey: Buffer.from(fixture.masterKey) });
    expect(current.hasBlobIdKey).toBe(true);
    expect(current.blobIdKey.equals(fixture.blobIdKey)).toBe(true);
  });

  it('zeroes the caller’s unlock key, even when no slot matched', () => {
    // The case a caller's own `finally` most often misses. A master key left live after a failed
    // unlock is a key sitting in memory for the lifetime of a process that is about to exit 78 and
    // possibly dump core.
    const fixture = buildKeyring();
    const wrong = randomBytes(32);
    expect(() => unlock({ keyring: fixture.keyring, slotKey: wrong })).toThrow();
    expect(isZeroed(wrong)).toBe(true);

    const right = Buffer.from(fixture.masterKey);
    unlock({ keyring: fixture.keyring, slotKey: right });
    expect(isZeroed(right)).toBe(true);
  });

  it('refuses a slot that holds a wrap of the wrong size', () => {
    // A wrap of a 16-byte "root key" is a format mismatch rather than an attack: the AEAD
    // authenticates it fine, and continuing would derive an entire key tree from the wrong number
    // of bytes.
    //
    // It is now caught by its **length**, before anything is unwrapped. AES-GCM preserves length,
    // so a 60-byte wrap always yields exactly 32 bytes of plaintext and a wrap of 16 bytes is 44 —
    // which means the boundary check in `keyring.ts` subsumes the post-unwrap check in
    // `key-service.ts`, and gets a better message out of it ("damaged, restore `.prev`" rather
    // than "not written by Comvivo"). This test asserts the check that actually runs.
    const fixture = buildKeyring();
    const shortKey = randomBytes(16);
    const generation = currentGeneration(fixture.keyring);
    const slot = generation.slots[0];
    expect(slot).toBeDefined();
    if (slot === undefined) return;

    // Re-seal a 16-byte "root key" under the same AAD, which is what a foreign writer would do.
    const forged = sealSlot({
      instanceId: fixture.keyring.instanceId,
      gen: generation.gen,
      id: slot.id,
      kind: slot.kind,
      slotKey: fixture.masterKey,
      rootDataKey: shortKey,
    });
    const tampered = {
      ...fixture.keyring,
      generations: fixture.keyring.generations.map((candidate) =>
        candidate.gen === generation.gen
          ? { ...candidate, slots: [forged, ...candidate.slots.slice(1)] }
          : candidate,
      ),
    };
    try {
      unlock({ keyring: tampered, slotKey: Buffer.from(fixture.masterKey) });
      expect.unreachable('a 16-byte root key should be refused');
    } catch (caught) {
      expect(caught).toBeInstanceOf(KeyringError);
      const error = caught as KeyringError;
      expect(error.code).toBe('KEYRING_MALFORMED');
      expect(error.message).toContain('holds 44 bytes, and a wrap is 60');
      expect(error.hint).toContain('damaged, not unlocked by the wrong key');
    }
  });
});

describe('the key tree (02 §3.6.1)', () => {
  it('derives the database key as 64 lowercase hex characters', () => {
    // `08` §3.7.9's `PRAGMA key="x'<64 hex>'"`. The validation lives in the service so there is
    // one place it can be got wrong.
    const { service } = unlockWithMaster();
    const hex = service.useDatabaseKeyHex((value) => value);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('derives the database key that HKDF would, from the root key', () => {
    // Not a self-consistency check: the expected value is computed independently from the
    // fixture's root key, so a service that derived from the wrong input would fail.
    const fixture = buildKeyring();
    const expected = derivePurposeKey(
      fixture.rootDataKey,
      fixture.keyring.instanceId,
      KEY_PURPOSE.db,
    ).toString('hex');
    const service = unlock({ keyring: fixture.keyring, slotKey: Buffer.from(fixture.masterKey) });
    expect(service.useDatabaseKeyHex((hex) => hex)).toBe(expected);
  });

  it('gives the database key out once and then refuses', () => {
    // It is handed out to open the database and zeroed on the way back. A second caller is a bug,
    // and the message says which.
    const { service } = unlockWithMaster();
    service.useDatabaseKeyHex(() => undefined);
    expect(() => service.useDatabaseKeyHex(() => undefined)).toThrow(/already been consumed/);
  });

  it('zeroes the database key buffer even when the callback throws', () => {
    const { service } = unlockWithMaster();
    expect(() =>
      service.useDatabaseKeyHex(() => {
        throw new Error('open failed');
      }),
    ).toThrow('open failed');
    // Consumed either way, so a failed open does not leave the key live.
    expect(() => service.useDatabaseKeyHex(() => undefined)).toThrow(/already been consumed/);
  });

  it('keeps the blob KEK and the backup KEK distinct', () => {
    // If they collided, one leaked key would open both — and `08` §3.7.7's `rotate-data` would
    // silently rotate neither independently.
    const { service } = unlockWithMaster();
    expect(service.blobKek.equals(service.backupKek)).toBe(false);
    expect(service.blobKek.equals(service.vaultKey)).toBe(false);
  });

  it('unwraps the static blob-id key rather than deriving it', () => {
    // `02` D14: it is *random* and wrapped, not derived, so blob addresses survive a data
    // rotation. A service that derived it would give every generation different addresses, and
    // every attachment would become unreachable after a rotation.
    const { service, blobIdKey } = unlockWithMaster();
    expect(service.blobIdKey.equals(blobIdKey)).toBe(true);
  });

  it('reports damage when the static wrap does not open under the right generation', () => {
    // Distinct from the retired-generation case above, and the hints differ because the actions
    // do. There the keyring is fine and the caller opened the wrong generation; here the
    // generation matches and the wrap itself is corrupt, so the answer is `keyring.json.prev` or
    // a backup — whose `keyringSnapshot.static.blobId` is required precisely for this (`08`
    // §3.7.11). Reached by flipping one byte of the sealed wrap, which is what bit rot looks like.
    const fixture = buildKeyring();
    const { blobId } = fixture.keyring.static;
    const sealed = Buffer.from(blobId.wrap.sealed, 'base64url');
    sealed.writeUInt8(sealed.readUInt8(sealed.length - 1) ^ 0xff, sealed.length - 1);
    const damaged = {
      ...fixture.keyring,
      static: {
        blobId: { ...blobId, wrap: { ...blobId.wrap, sealed: sealed.toString('base64url') } },
      },
    };

    try {
      unlock({ keyring: damaged, slotKey: Buffer.from(fixture.masterKey) });
      expect.unreachable('a corrupt static wrap is not a usable keyring');
    } catch (caught) {
      expect(caught).toBeInstanceOf(KeyringError);
      const error = caught as KeyringError;
      expect(error.code).toBe('KEYRING_MALFORMED');
      expect(error.message).toContain('does not unwrap under generation 1');
      expect(error.hint).toContain('keyring.json.prev');
      expect(error.hint).toContain('08 §3.7.11');
    }
  });

  it('derives a different token-MAC key per epoch', () => {
    // `08` §3.7.12: bumping the epoch is how `rotate-sessions` invalidates every session, and it
    // only works if the new epoch's key cannot validate the old epoch's tokens.
    const { service } = unlockWithMaster();
    const keys = [0, 1, 2, 7].map((epoch) => service.tokenMacKey(epoch).toString('hex'));
    expect(new Set(keys).size).toBe(4);
  });

  it('derives the token-MAC key HKDF would, so a rotation is predictable', () => {
    const fixture = buildKeyring();
    const expected = derivePurposeKey(
      fixture.rootDataKey,
      fixture.keyring.instanceId,
      `token-mac/epoch=3`,
    );
    const service = unlock({ keyring: fixture.keyring, slotKey: Buffer.from(fixture.masterKey) });
    expect(service.tokenMacKey(3).equals(expected)).toBe(true);
  });

  it('gives two instances different keys from the same root key', () => {
    // `instanceId` is the HKDF salt. This is what keeps a restored backup from one instance from
    // sharing derived keys with another.
    const first = buildKeyring({ instanceId: 'inst_01jd8aaaaaaaaaaaaaaaaaaaaa' as InstanceId });
    const second = buildKeyring({ instanceId: 'inst_01jd8bbbbbbbbbbbbbbbbbbbbb' as InstanceId });
    const a = unlock({ keyring: first.keyring, slotKey: Buffer.from(first.masterKey) });
    const b = unlock({ keyring: second.keyring, slotKey: Buffer.from(second.masterKey) });
    expect(a.blobKek.equals(b.blobKek)).toBe(false);
  });
});

describe('zeroing (02 §3.6.1, 08 §3.7.13)', () => {
  it('zeroes the root data key as soon as the tree is derived', () => {
    // `02` §3.6.1 verbatim: "MK and RDK live in buffers that are zeroed after derivation." The
    // fixture's own copy is separate, which is what lets this be observed at all.
    const fixture = buildKeyring();
    const adopted = Buffer.from(fixture.rootDataKey);
    // `unlock` unwraps its own copy, so observe through the slot path directly.
    const generation = currentGeneration(fixture.keyring);
    const slot = generation.slots[0];
    expect(slot).toBeDefined();
    if (slot === undefined) return;
    const unwrapped = openSlot({
      instanceId: fixture.keyring.instanceId,
      gen: generation.gen,
      slot,
      slotKey: fixture.masterKey,
    });
    expect(unwrapped).toBeDefined();
    if (unwrapped === undefined) return;

    new KeyService(fixture.keyring, unwrapped, {
      slotKind: 'master',
      slotId: 'mk1',
      gen: generation.gen,
    });
    // The buffer the constructor was handed is now zeroed; the independent copy is not.
    expect(isZeroed(unwrapped)).toBe(true);
    expect(isZeroed(adopted)).toBe(false);
  });

  it('zeroes every key on lock', () => {
    const { service } = unlockWithMaster();
    const blobKek = service.blobKek;
    const blobIdKey = service.blobIdKey;
    const backupKek = service.backupKek;
    const vaultKey = service.vaultKey;

    service.lock();

    expect(isZeroed(blobKek)).toBe(true);
    expect(isZeroed(blobIdKey)).toBe(true);
    expect(isZeroed(backupKek)).toBe(true);
    expect(isZeroed(vaultKey)).toBe(true);
    expect(service.isLocked).toBe(true);
  });

  it('refuses to hand out a key after lock, naming it as a bug', () => {
    // Using a key service after shutdown is our mistake, not a host's, and the message says so
    // rather than sending them to their key files.
    const { service } = unlockWithMaster();
    service.lock();
    for (const read of [
      () => service.blobKek,
      () => service.blobIdKey,
      () => service.backupKek,
      () => service.vaultKey,
      () => service.tokenMacKey(0),
      () => service.useDatabaseKeyHex(() => undefined),
    ]) {
      // The message describes the state; the **hint** is where the blame goes. Asserting on the
      // hint rather than the message is deliberate: a host must never be sent to their key files
      // for something that is our mistake.
      try {
        read();
        expect.unreachable('a locked service should hand out nothing');
      } catch (error) {
        expect(error).toBeInstanceOf(KeyringError);
        expect((error as KeyringError).hint).toContain('This is a bug');
      }
    }
  });

  it('is safe to lock twice, because shutdown races', () => {
    const { service } = unlockWithMaster();
    service.lock();
    expect(() => service.lock()).not.toThrow();
  });

  it('releases the root key on request, after the epoch is known', () => {
    // `08` §3.7.5 step 4 reads `sessionEpoch` and derives the token MAC key. Immediately after
    // that nothing needs the root key until a rotation, which re-unlocks — so giving it up
    // shortens its life from "the process" to "boot". That is the difference between a core dump
    // holding one key and holding all of them.
    const { service } = unlockWithMaster();
    const macKey = service.tokenMacKey(1);
    expect(macKey).toHaveLength(32);

    service.zeroizeRootKey();
    // The already-derived key is untouched; only further epochs are refused.
    expect(isZeroed(macKey)).toBe(false);
    expect(() => service.tokenMacKey(2)).toThrow(/root key has been released/);
    // And the keys that are kept for the process lifetime still work.
    expect(service.blobKek).toHaveLength(32);
  });

  it('explains what to do when a later epoch is needed', () => {
    const { service } = unlockWithMaster();
    service.zeroizeRootKey();
    try {
      service.tokenMacKey(5);
      expect.unreachable('the root key is gone');
    } catch (error) {
      expect((error as KeyringError).hint).toContain('before `zeroizeRootKey`');
      expect((error as KeyringError).hint).toContain('rotate-sessions');
    }
  });

  it('is idempotent about releasing the root key', () => {
    const { service } = unlockWithMaster();
    service.zeroizeRootKey();
    expect(() => service.zeroizeRootKey()).not.toThrow();
  });
});

describe('passphraseSlotKey', () => {
  it('derives the slot key from the parameters stored with the slot', async () => {
    // `08` §3.7.4 stores `N`, `r`, `p` and the salt *with the slot*, which is what makes raising
    // them later backwards-compatible. A function that used today's defaults would lock a host out
    // of a keyring written before the change.
    const fixture = buildKeyring({ withPassphrase: true });
    const slot = currentGeneration(fixture.keyring).slots.find((s) => s.kind === 'passphrase');
    expect(slot).toBeDefined();
    // Asserted, not merely narrowed: `fixture.passphrase` being absent would make this test
    // `return` having checked only that a slot exists — and it is the **only** test of `08`
    // §3.7.8 row 2, the passphrase unlock. Found by the M1 independent review.
    expect(fixture.passphrase, 'the fixture did not set a passphrase').toBeDefined();
    if (slot === undefined || fixture.passphrase === undefined) return;
    expect(slot.kdf).toMatchObject({ alg: 'scrypt', N: FAST_SCRYPT.N });

    const key = await passphraseSlotKey(fixture.passphrase, slot);
    expect(key).toHaveLength(32);
    // And it is the key that actually opens the slot.
    const service = unlock({ keyring: fixture.keyring, slotKey: key });
    expect(service.unlockRecord.slotKind).toBe('passphrase');
  });

  it('refuses a passphrase slot with no scrypt parameters', async () => {
    const fixture = buildKeyring({ withPassphrase: true });
    const slot = currentGeneration(fixture.keyring).slots.find((s) => s.kind === 'passphrase');
    expect(slot).toBeDefined();
    if (slot === undefined) return;
    const { kdf: _dropped, ...withoutKdf } = slot;
    await expect(passphraseSlotKey('x', withoutKdf)).rejects.toThrow(/without scrypt parameters/);
  });

  it('refuses when the slot records the wrong KDF', async () => {
    const fixture = buildKeyring({ withPassphrase: true });
    const slot = currentGeneration(fixture.keyring).slots.find((s) => s.kind === 'passphrase');
    expect(slot).toBeDefined();
    if (slot === undefined) return;
    await expect(
      passphraseSlotKey('x', {
        ...slot,
        kdf: { alg: 'hkdf-sha256', info: keyInfo(KEY_PURPOSE.rkSlot) },
      }),
    ).rejects.toThrow(KeyringError);
  });
});

describe('key generation', () => {
  it('makes a 256-bit root data key from the CSPRNG', () => {
    const keys = new Set(Array.from({ length: 50 }, () => newRootDataKey().toString('hex')));
    expect(keys.size).toBe(50);
    expect(newRootDataKey()).toHaveLength(32);
  });

  it('makes a 256-bit blob-id key from the CSPRNG', () => {
    const keys = new Set(Array.from({ length: 50 }, () => newBlobIdKey().toString('hex')));
    expect(keys.size).toBe(50);
    expect(newBlobIdKey()).toHaveLength(32);
  });
});
