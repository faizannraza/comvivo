/**
 * The `comvivo keys …` operations (`08` §3.7.7, §3.7.8).
 *
 * What these tests are really about is **the crash in the middle**. Every operation that replaces
 * a key has a window where the old key could be gone and the new one not yet saved, and `08`
 * §3.7.8 says what falls out of that window: all encrypted data, unrecoverable. So each rotation
 * is driven with a fault injected at each write step, and the assertion is always the same one —
 * after the crash, something the host holds still opens the keyring that is on disk.
 *
 * `FakeKeyringIo` is what makes that reachable: the interesting failures are *between* two
 * syscalls, and a real filesystem cannot be stopped there.
 */
import { KEY_BYTES, randomBytes, scryptKeySync } from '@comvivo/shared/crypto';
import { describe, expect, it } from 'vitest';
import {
  addPassphrase,
  purgeRetired,
  type RotateDataPorts,
  type RotationJournal,
  recover,
  removeKeySlot,
  rotateData,
  rotateMaster,
  rotateRecovery,
  rotateSessions,
  type SessionEpochStore,
  status,
  verifyRecovery,
  WRAP_COUNT_ADVISORY,
} from './key-ops.js';
import { unlock } from './key-service.js';
import { currentGeneration, type Keyring, KeyringError } from './keyring.js';
import { KeyringStore } from './keyring-store.js';
import { encodeRecoveryKey } from './recovery-key.js';
import { FakeKeyringIo, type FaultPoint } from './testing/fake-io.js';
import { buildKeyring, FAST_SCRYPT, type FixtureOptions } from './testing/keyring-fixture.js';

const KEYS_DIR = '/data/keys';

/** The five points `KeyringStore.write` can be interrupted at (`testing/fake-io.ts`). */
const FAULT_POINTS: readonly FaultPoint[] = [
  'writeFile',
  'syncFile',
  'renameToPrevious',
  'renameTempIntoPlace',
  'syncDirectory',
];

function world(): { readonly store: KeyringStore; readonly io: FakeKeyringIo } {
  const io = new FakeKeyringIo();
  return { store: new KeyringStore(KEYS_DIR, io), io };
}

/** A fixture plus the printed form of its recovery key, which is what a host actually types. */
function withPrinted(options: FixtureOptions = {}): ReturnType<typeof buildKeyring> & {
  readonly printed: string;
} {
  const fixture = buildKeyring(options);
  return { ...fixture, printed: encodeRecoveryKey(fixture.recoveryKey) };
}

/** Can this key still open the current generation? The question every crash test asks. */
function opens(keyring: Keyring, slotKey: Uint8Array): boolean {
  try {
    unlock({ keyring, slotKey: Buffer.from(slotKey) }).lock();
    return true;
  } catch {
    return false;
  }
}

/** Every keyring a host could still have after a crash: the live one and `.prev`. */
async function survivors(store: KeyringStore): Promise<readonly Keyring[]> {
  const live = await store.read().catch(() => undefined);
  const previous = await store.readPrevious().catch(() => undefined);
  return [live, previous].filter((keyring): keyring is Keyring => keyring !== undefined);
}

/**
 * Crash safety for the operations that had none (`08` §3.7.7; `M1-T6` AC "each crash-safe").
 *
 * `io.armFault` appeared at exactly three sites — `rotateMaster`, `recover` and `rotateData` — so
 * five of the ten library operations had only happy-path, precondition and thrown-callback tests.
 * The generic `KeyringStore.write` crash suite does not cover them either: it proves the *write* is
 * atomic, and what these operations add is multi-step work **around** that write. Found by the M1
 * independent review.
 *
 * `rotateSessions` is the exception and is covered separately below: it never touches the keyring
 * store at all — it reads and writes a single integer through `SessionEpochStore` — so arming a
 * keyring fault would prove nothing about it. Adding `armFault` to all five mechanically would
 * have produced one test that passes for the wrong reason.
 */
describe('a crash leaves a usable keyring (08 §3.7.7)', () => {
  /** Every operation that writes the keyring, as a thunk over a fresh world. */
  const OPERATIONS: readonly {
    readonly name: string;
    run: (
      current: ReturnType<typeof world>,
      fixture: ReturnType<typeof buildKeyring>,
    ) => Promise<unknown>;
    /** Options for the fixture this operation needs. */
    readonly fixture?: FixtureOptions;
  }[] = [
    {
      name: 'rotateRecovery',
      run: ({ store }, fixture) =>
        rotateRecovery({
          store,
          keyring: fixture.keyring,
          currentSlotKey: fixture.masterKey,
          ceremony: () => Promise.resolve(true),
        }),
    },
    {
      name: 'addPassphrase',
      run: ({ store }, fixture) =>
        addPassphrase({
          store,
          keyring: fixture.keyring,
          currentSlotKey: fixture.masterKey,
          passphrase: 'correct horse battery staple',
          params: FAST_SCRYPT,
        }),
    },
    {
      name: 'removeKeySlot',
      // Needs a slot that is removable: the last recovery slot and the last master slot are not.
      fixture: { withPassphrase: true },
      run: ({ store }, fixture) =>
        removeKeySlot({
          store,
          keyring: fixture.keyring,
          gen: fixture.keyring.current,
          slotId: 'pp1',
        }),
    },
    {
      name: 'purgeRetired',
      fixture: { gen: 3, retiredGenerations: [1, 2] },
      run: ({ store }, fixture) =>
        purgeRetired({ store, keyring: fixture.keyring, blobsRewrapped: true }),
    },
  ];

  it.each(OPERATIONS)('$name survives a crash at every write step', async (operation) => {
    for (const point of FAULT_POINTS) {
      const current = world();
      const fixture = buildKeyring(operation.fixture ?? {});
      await current.store.write(fixture.keyring);

      current.io.armFault(point);
      let threw = false;
      await operation.run(current, fixture).catch(() => {
        threw = true;
      });
      // Non-vacuous, the same way the `rotateMaster` suite is: without this the loop would pass
      // for a fault that never fired, and the test would be asserting that a *successful*
      // operation leaves a usable keyring.
      expect(threw, `${operation.name}: the fault at ${point} did not fire`).toBe(true);

      const candidates = await survivors(current.store);
      expect(
        candidates.length,
        `${operation.name}: a crash at ${point} left no readable keyring`,
      ).toBeGreaterThan(0);
      // The property that matters to a host: a key they already hold still opens something that is
      // still on disk. Anything less means the data is gone with no error until a restore.
      expect(
        candidates.some((keyring) => opens(keyring, fixture.masterKey)),
        `${operation.name}: a crash at ${point} left no keyring the master key opens`,
      ).toBe(true);
    }
  });

  it('covers every keyring-writing operation, so the list cannot quietly shrink', () => {
    // `it.each([])` runs no cases and passes. Both numbers are pinned: the operations under test
    // and the fault points each one is driven through.
    expect(OPERATIONS.map((operation) => operation.name)).toEqual([
      'rotateRecovery',
      'addPassphrase',
      'removeKeySlot',
      'purgeRetired',
    ]);
    expect(FAULT_POINTS.length).toBeGreaterThan(2);
  });

  it('rotateSessions keeps the old epoch when the write fails', async () => {
    // Its own shape of the same question. `rotateSessions` writes one integer through
    // `SessionEpochStore`, so the failure that matters is that write failing — and the invariant is
    // that the **old** epoch is still what a reader sees. The opposite would be worse than it
    // sounds: a half-applied epoch bump invalidates every session, magic link and pairing code
    // while reporting that nothing happened.
    let stored = 7;
    const epochs: SessionEpochStore = {
      read: () => Promise.resolve(stored),
      write: () => Promise.reject(new Error('the settings table is read-only')),
    };
    await expect(rotateSessions(epochs)).rejects.toThrow('read-only');
    expect(stored).toBe(7);
    // And a working store still advances, so the assertion above is about the failure and not
    // about `rotateSessions` being inert.
    const working: SessionEpochStore = {
      read: () => Promise.resolve(stored),
      write: (epoch: number) => {
        stored = epoch;
        return Promise.resolve();
      },
    };
    expect(await rotateSessions(working)).toEqual({ previous: 7, epoch: 8 });
    expect(stored).toBe(8);
  });
});

describe('status (08 §3.7.7)', () => {
  it('reports the generations, slots and current generation', () => {
    const { keyring } = buildKeyring({ gen: 2, retiredGenerations: [1], withPassphrase: true });
    const report = status(keyring);

    expect(report.current).toBe(2);
    expect(report.instanceId).toBe(keyring.instanceId);
    expect(report.generations.map((generation) => generation.gen)).toEqual([1, 2]);
    expect(report.generations.find((generation) => generation.gen === 2)?.isCurrent).toBe(true);
    expect(report.generations.find((generation) => generation.gen === 1)?.status).toBe('retired');
    expect(report.hasPassphrase).toBe(true);
    expect(report.recoverySlots).toBe(1);
    expect(report.retainedGenerations).toBe(1);
  });

  it('contains no key material, because a host will paste it into a support thread', () => {
    // The property that makes this safe to print, asserted structurally rather than by eye: no
    // wrap and no salt from the keyring may appear anywhere in the report.
    const { keyring } = buildKeyring({ withPassphrase: true });
    const serialised = JSON.stringify(status(keyring));

    expect(serialised).not.toContain(keyring.static.blobId.wrap.sealed);
    for (const generation of keyring.generations) {
      for (const slot of generation.slots) {
        expect(serialised).not.toContain(slot.wrap.sealed);
        if (slot.kdf?.alg === 'scrypt') expect(serialised).not.toContain(slot.kdf.salt);
      }
    }
  });

  it('says when 08 §3.7.1 advises a data rotation', () => {
    const { keyring } = buildKeyring();
    expect(status(keyring).shouldRotateData).toBe(false);
    expect(status(keyring).wrapsRemaining).toBe(WRAP_COUNT_ADVISORY - keyring.wrapCount);

    const busy = { ...keyring, wrapCount: WRAP_COUNT_ADVISORY };
    expect(status(busy).shouldRotateData).toBe(true);
    expect(status(busy).wrapsRemaining).toBe(0);
  });

  it('names the generation the blob-id key is wrapped under', () => {
    // `08` §3.7.2 wraps static keys under the current generation only, so this is the field that
    // explains why an old backup needs its own snapshot (§3.7.11).
    const { keyring } = buildKeyring({ gen: 3, retiredGenerations: [1, 2] });
    expect(status(keyring).blobIdGeneration).toBe(3);
  });
});

describe('verify-recovery (08 §3.7.6)', () => {
  it('accepts the printed key and changes nothing', () => {
    const fixture = withPrinted();
    const before = JSON.stringify(fixture.keyring);
    const result = verifyRecovery({ keyring: fixture.keyring, typed: fixture.printed });

    expect(result.ok).toBe(true);
    expect(result.gen).toBe(fixture.keyring.current);
    expect(result.slotId).toBe('rk1');
    expect(JSON.stringify(fixture.keyring)).toBe(before);
  });

  it('accepts it with the grouping and case a human would type', () => {
    const fixture = withPrinted();
    const typed = fixture.printed.toLowerCase().replace(/-/g, ' ');
    expect(verifyRecovery({ keyring: fixture.keyring, typed }).ok).toBe(true);
  });

  it('tells a typo apart from the wrong key, which is the whole point', () => {
    // These two need different answers. A checksum failure means "look at what you wrote down"; a
    // clean decode that opens nothing means "this is a different key, find a newer printout".
    // Reporting both as "invalid recovery key" leaves somebody re-reading a correct piece of paper
    // during the exact emergency the key exists for.
    const fixture = withPrinted();
    const body = fixture.printed.split('-').slice(1).join('');

    const typo = verifyRecovery({
      keyring: fixture.keyring,
      typed: `VRK1-${body.slice(0, -1)}${body.endsWith('0') ? '1' : '0'}`,
    });
    expect(typo.ok).toBe(false);
    expect(typo.reason).toContain('typo');

    const other = verifyRecovery({
      keyring: fixture.keyring,
      typed: encodeRecoveryKey(randomBytes(KEY_BYTES)),
    });
    expect(other.ok).toBe(false);
    expect(other.reason).toContain('does not open any recovery slot');
    expect(other.hint).toContain('rotate-recovery');
  });

  it('never echoes the typed key', () => {
    const fixture = withPrinted();
    const stranger = encodeRecoveryKey(randomBytes(KEY_BYTES));
    const result = verifyRecovery({ keyring: fixture.keyring, typed: stranger });

    expect(result.ok).toBe(false);
    const shown = `${result.reason ?? ''} ${result.hint ?? ''}`;
    for (const group of stranger.split('-').slice(1)) {
      expect(shown).not.toContain(group);
    }
  });

  it('opens every retained generation, which is how an old backup is verified', () => {
    // `08` §3.7.7 keeps retired generations so old backups still open, and the recovery slot is
    // wrapped under the same slot key in each — so one printed key covers all of them.
    const fixture = withPrinted({ gen: 2, retiredGenerations: [1] });
    for (const gen of [1, 2]) {
      const result = verifyRecovery({ keyring: fixture.keyring, typed: fixture.printed, gen });
      expect(result.ok, `generation ${String(gen)} should verify`).toBe(true);
      expect(result.gen).toBe(gen);
    }
  });

  it('refuses a generation that is not in the keyring', () => {
    const fixture = withPrinted();
    expect(() =>
      verifyRecovery({ keyring: fixture.keyring, typed: fixture.printed, gen: 99 }),
    ).toThrow(KeyringError);
  });
});

describe('rotate-master (08 §3.7.7 row 1)', () => {
  it('ends with only the new key working', async () => {
    const { store } = world();
    const fixture = buildKeyring();
    await store.write(fixture.keyring);
    const newKey = randomBytes(KEY_BYTES);

    const result = await rotateMaster({
      store,
      keyring: fixture.keyring,
      currentMasterKey: fixture.masterKey,
      storeKey: () => Promise.resolve(),
      newMasterKey: Buffer.from(newKey),
    });

    expect(opens(result.keyring, newKey)).toBe(true);
    expect(opens(result.keyring, fixture.masterKey)).toBe(false);
    expect(result.removed.map((entry) => entry.slotId)).toEqual(['mk1']);
    expect(await store.read()).toEqual(result.keyring);
  });

  it('keeps the old key working until the new one is stored', async () => {
    // `08` §3.7.7's ordering, and the reason for it. At the moment `storeKey` runs, the keyring on
    // disk must still open with the old key — otherwise a crash inside `storeKey` leaves a keyring
    // that only opens with a key nobody saved, and by §3.7.8 that is the recovery key or nothing.
    const { store } = world();
    const fixture = buildKeyring();
    await store.write(fixture.keyring);
    const newKey = randomBytes(KEY_BYTES);

    let onDisk: Keyring | undefined;
    await rotateMaster({
      store,
      keyring: fixture.keyring,
      currentMasterKey: fixture.masterKey,
      newMasterKey: Buffer.from(newKey),
      storeKey: async () => {
        onDisk = await store.read();
      },
    });

    expect(onDisk).toBeDefined();
    if (onDisk === undefined) return;
    expect(opens(onDisk, fixture.masterKey)).toBe(true);
    expect(opens(onDisk, newKey)).toBe(true);
  });

  it('leaves the old key working if storing the new one fails', async () => {
    const { store } = world();
    const fixture = buildKeyring();
    await store.write(fixture.keyring);

    await expect(
      rotateMaster({
        store,
        keyring: fixture.keyring,
        currentMasterKey: fixture.masterKey,
        storeKey: () => Promise.reject(new Error('the keyfile is on a full disk')),
      }),
    ).rejects.toThrow('full disk');

    expect(opens(await store.read(), fixture.masterKey)).toBe(true);
  });

  it('survives a crash at every write step', async () => {
    // The property that matters: after a crash anywhere in this operation, at least one key the
    // host holds opens a keyring that is still on disk.
    for (const point of FAULT_POINTS) {
      const { store, io } = world();
      const fixture = buildKeyring();
      await store.write(fixture.keyring);
      const newKey = randomBytes(KEY_BYTES);

      io.armFault(point);
      let threw = false;
      await rotateMaster({
        store,
        keyring: fixture.keyring,
        currentMasterKey: fixture.masterKey,
        storeKey: () => Promise.resolve(),
        newMasterKey: Buffer.from(newKey),
      }).catch(() => {
        threw = true;
      });
      // Non-vacuous: without this the loop would pass for a fault that never fired, and the whole
      // test would be asserting that a *successful* rotation leaves a usable keyring.
      expect(threw, `the fault at ${point} did not fire`).toBe(true);

      const candidates = await survivors(store);
      expect(candidates.length, `a crash at ${point} left no readable keyring`).toBeGreaterThan(0);
      expect(
        candidates.some((keyring) => opens(keyring, fixture.masterKey) || opens(keyring, newKey)),
        `a crash at ${point} left no usable keyring`,
      ).toBe(true);
    }
  });

  it('gives every retained generation a slot under the new key', async () => {
    // `08` §3.7.7 row 1 says "each retained generation's RDK", and the last row says why: a
    // retired generation is what opens old backups. One that kept only the old master slot would
    // be unopenable the moment the keyfile was replaced.
    const { store } = world();
    const fixture = buildKeyring({ gen: 2, retiredGenerations: [1] });
    await store.write(fixture.keyring);
    const newKey = randomBytes(KEY_BYTES);

    const result = await rotateMaster({
      store,
      keyring: fixture.keyring,
      currentMasterKey: fixture.masterKey,
      storeKey: () => Promise.resolve(),
      newMasterKey: Buffer.from(newKey),
    });

    expect([...result.slotIds].map((entry) => entry.gen).sort()).toEqual([1, 2]);
    for (const generation of result.keyring.generations) {
      const service = unlock({
        keyring: result.keyring,
        slotKey: Buffer.from(newKey),
        gen: generation.gen,
      });
      expect(service.generation).toBe(generation.gen);
      service.lock();
    }
  });

  it('refuses a key that opens nothing, before touching the keyring', async () => {
    const { store } = world();
    const fixture = buildKeyring();
    await store.write(fixture.keyring);
    const before = await store.read();

    await expect(
      rotateMaster({
        store,
        keyring: fixture.keyring,
        currentMasterKey: randomBytes(KEY_BYTES),
        storeKey: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/opened no generation/);

    expect(await store.read()).toEqual(before);
  });

  it('counts its wraps, so the 08 §3.7.1 advisory stays meaningful', async () => {
    const { store } = world();
    const fixture = buildKeyring({ gen: 2, retiredGenerations: [1] });
    await store.write(fixture.keyring);

    const result = await rotateMaster({
      store,
      keyring: fixture.keyring,
      currentMasterKey: fixture.masterKey,
      storeKey: () => Promise.resolve(),
    });
    expect(result.keyring.wrapCount).toBe(fixture.keyring.wrapCount + 2);
  });
});

describe('rotate-recovery (08 §3.7.7 row 3)', () => {
  it('issues a new key and keeps the old one until the ceremony confirms', async () => {
    const { store } = world();
    const fixture = withPrinted();
    await store.write(fixture.keyring);

    let duringCeremony: Keyring | undefined;
    const result = await rotateRecovery({
      store,
      keyring: fixture.keyring,
      currentSlotKey: fixture.masterKey,
      ceremony: async () => {
        duringCeremony = await store.read();
        return true;
      },
    });

    // Both keys work while the user is being shown the new one — that window is the safe state.
    expect(duringCeremony).toBeDefined();
    if (duringCeremony === undefined) return;
    expect(verifyRecovery({ keyring: duringCeremony, typed: fixture.printed }).ok).toBe(true);
    expect(verifyRecovery({ keyring: duringCeremony, typed: result.printed }).ok).toBe(true);

    // Afterwards, only the new one.
    expect(verifyRecovery({ keyring: result.keyring, typed: result.printed }).ok).toBe(true);
    expect(verifyRecovery({ keyring: result.keyring, typed: fixture.printed }).ok).toBe(false);
  });

  it('keeps the old key when the user cannot retype the groups', async () => {
    // §3.7.6 step 2 exists to catch a user who has not actually written the key down. If it fails,
    // leaving them with only an unverified new key is the one outcome worth unwinding for.
    const { store } = world();
    const fixture = withPrinted();
    await store.write(fixture.keyring);

    const result = await rotateRecovery({
      store,
      keyring: fixture.keyring,
      currentSlotKey: fixture.masterKey,
      ceremony: () => Promise.resolve(false),
    });

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(verifyRecovery({ keyring: await store.read(), typed: fixture.printed }).ok).toBe(true);
  });

  it('keeps the old key when the ceremony throws', async () => {
    const { store } = world();
    const fixture = withPrinted();
    await store.write(fixture.keyring);

    await expect(
      rotateRecovery({
        store,
        keyring: fixture.keyring,
        currentSlotKey: fixture.masterKey,
        ceremony: () => Promise.reject(new Error('the terminal went away')),
      }),
    ).rejects.toThrow(/ceremony did not complete/);

    expect(verifyRecovery({ keyring: await store.read(), typed: fixture.printed }).ok).toBe(true);
  });

  it('replaces the slot in every retained generation', async () => {
    const { store } = world();
    const fixture = withPrinted({ gen: 2, retiredGenerations: [1] });
    await store.write(fixture.keyring);

    const result = await rotateRecovery({
      store,
      keyring: fixture.keyring,
      currentSlotKey: fixture.masterKey,
      ceremony: () => Promise.resolve(true),
    });

    expect([...result.added].map((entry) => entry.gen).sort()).toEqual([1, 2]);
    for (const generation of result.keyring.generations) {
      expect(generation.slots.some((slot) => slot.kind === 'recovery')).toBe(true);
    }
  });

  it('never leaves a generation without a recovery slot, even mid-operation', async () => {
    // `08` §3.7.8: the recovery key is the only route back. A window where a generation had none
    // would be a window where a lost master key meant total loss.
    const { store } = world();
    const fixture = withPrinted({ gen: 2, retiredGenerations: [1] });
    await store.write(fixture.keyring);

    const counts: number[] = [];
    await rotateRecovery({
      store,
      keyring: fixture.keyring,
      currentSlotKey: fixture.masterKey,
      ceremony: async () => {
        for (const generation of (await store.read()).generations) {
          counts.push(generation.slots.filter((slot) => slot.kind === 'recovery').length);
        }
        return true;
      },
    });

    expect(counts.length).toBe(2);
    for (const count of counts) expect(count).toBeGreaterThanOrEqual(1);
  });

  it('refuses a key that opens nothing', async () => {
    const { store } = world();
    const fixture = withPrinted();
    await store.write(fixture.keyring);

    await expect(
      rotateRecovery({
        store,
        keyring: fixture.keyring,
        currentSlotKey: randomBytes(KEY_BYTES),
        ceremony: () => Promise.resolve(true),
      }),
    ).rejects.toThrow(/opened no generation/);
  });
});

describe('recover (08 §3.7.8 row 1)', () => {
  it('establishes a new master key from the printed recovery key', async () => {
    // "MK lost, RK held → no data loss." The host ends up back on a master key rather than
    // depending on a piece of paper at every boot.
    const { store } = world();
    const fixture = withPrinted();
    await store.write(fixture.keyring);

    let stored: Buffer | undefined;
    const result = await recover({
      store,
      keyring: fixture.keyring,
      typed: fixture.printed,
      storeKey: (key) => {
        stored = Buffer.from(key);
        return Promise.resolve();
      },
    });

    expect(stored).toBeDefined();
    if (stored === undefined) return;
    expect(opens(result.keyring, stored)).toBe(true);
    expect(result.viaSlotId).toBe('rk1');
    // The printed key keeps working: recovery adds a route, it does not consume one.
    expect(verifyRecovery({ keyring: result.keyring, typed: fixture.printed }).ok).toBe(true);
  });

  it('derives the same data keys, which is what "no data loss" means', async () => {
    // The actual promise of §3.7.8 row 1. If the database key came back different, the row would
    // be a lie and the host's database would refuse to open.
    const { store } = world();
    const fixture = withPrinted();
    await store.write(fixture.keyring);

    const before = unlock({
      keyring: fixture.keyring,
      slotKey: Buffer.from(fixture.masterKey),
    }).useDatabaseKeyHex((hex) => hex);

    let stored = Buffer.alloc(0);
    const result = await recover({
      store,
      keyring: fixture.keyring,
      typed: fixture.printed,
      storeKey: (key) => {
        stored = Buffer.from(key);
        return Promise.resolve();
      },
    });

    const after = unlock({ keyring: result.keyring, slotKey: stored }).useDatabaseKeyHex(
      (hex) => hex,
    );
    expect(after).toBe(before);
  });

  it('reports a typo as a typo rather than as a wrong key', async () => {
    const { store } = world();
    const fixture = withPrinted();
    await store.write(fixture.keyring);
    const body = fixture.printed.split('-').slice(1).join('');

    await expect(
      recover({
        store,
        keyring: fixture.keyring,
        typed: `VRK1-${body.slice(0, -1)}${body.endsWith('0') ? '1' : '0'}`,
        storeKey: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/typo/);
  });

  it('refuses a key that does not open the current generation', async () => {
    // A recovery key that only opens a retired generation would appear to succeed and then fail at
    // the next boot, which is the worst possible moment to discover it.
    const { store } = world();
    const fixture = withPrinted({ gen: 2, retiredGenerations: [1] });
    const currentHasNoRecovery: Keyring = {
      ...fixture.keyring,
      generations: fixture.keyring.generations.map((generation) =>
        generation.gen === 2
          ? { ...generation, slots: generation.slots.filter((slot) => slot.kind !== 'recovery') }
          : generation,
      ),
    };
    await store.write(fixture.keyring);

    await expect(
      recover({
        store,
        keyring: currentHasNoRecovery,
        typed: fixture.printed,
        storeKey: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/does not open the current generation/);
  });

  it('survives a crash at every write step', async () => {
    for (const point of FAULT_POINTS) {
      const { store, io } = world();
      const fixture = withPrinted();
      await store.write(fixture.keyring);

      io.armFault(point);
      let threw = false;
      await recover({
        store,
        keyring: fixture.keyring,
        typed: fixture.printed,
        storeKey: () => Promise.resolve(),
      }).catch(() => {
        threw = true;
      });
      expect(threw, `the fault at ${point} did not fire`).toBe(true);

      const candidates = await survivors(store);
      expect(
        candidates.some((keyring) => verifyRecovery({ keyring, typed: fixture.printed }).ok),
        `a crash at ${point} left no keyring the recovery key opens`,
      ).toBe(true);
    }
  });
});

describe('add-passphrase (08 §3.7.8 row 2)', () => {
  it('adds a third unlock route', async () => {
    const { store } = world();
    const fixture = buildKeyring();
    await store.write(fixture.keyring);

    const { keyring, slotId } = await addPassphrase({
      store,
      keyring: fixture.keyring,
      currentSlotKey: fixture.masterKey,
      passphrase: 'correct horse battery staple',
      params: FAST_SCRYPT,
    });

    expect(slotId).toBe('pp1');
    const slot = currentGeneration(keyring).slots.find((candidate) => candidate.id === 'pp1');
    expect(slot?.kind).toBe('passphrase');
    expect(await store.read()).toEqual(keyring);
  });

  it('stores the parameters it used, so raising them later still unlocks', async () => {
    // `08` §3.7.4 records the parameters per slot for exactly this reason. Asserted by deriving
    // with the **stored** salt and parameters rather than the current defaults, and unlocking.
    const { store } = world();
    const fixture = buildKeyring();
    await store.write(fixture.keyring);
    const passphrase = 'a passphrase that is long enough';

    const { keyring } = await addPassphrase({
      store,
      keyring: fixture.keyring,
      currentSlotKey: fixture.masterKey,
      passphrase,
      params: FAST_SCRYPT,
    });

    const slot = currentGeneration(keyring).slots.find((candidate) => candidate.id === 'pp1');
    expect(slot?.kdf?.alg).toBe('scrypt');
    if (slot?.kdf?.alg !== 'scrypt') return;
    expect({ N: slot.kdf.N, r: slot.kdf.r, p: slot.kdf.p }).toEqual(FAST_SCRYPT);

    const derived = scryptKeySync(passphrase, Buffer.from(slot.kdf.salt, 'base64url'), {
      N: slot.kdf.N,
      r: slot.kdf.r,
      p: slot.kdf.p,
    });
    expect(opens(keyring, derived)).toBe(true);
  });

  it('gives each slot its own salt', async () => {
    const { store } = world();
    const fixture = buildKeyring();
    await store.write(fixture.keyring);

    const first = await addPassphrase({
      store,
      keyring: fixture.keyring,
      currentSlotKey: fixture.masterKey,
      passphrase: 'one',
      params: FAST_SCRYPT,
    });
    const second = await addPassphrase({
      store,
      keyring: first.keyring,
      currentSlotKey: fixture.masterKey,
      passphrase: 'two',
      params: FAST_SCRYPT,
    });

    const salts = currentGeneration(second.keyring)
      .slots.filter((slot) => slot.kdf?.alg === 'scrypt')
      .map((slot) => (slot.kdf?.alg === 'scrypt' ? slot.kdf.salt : ''));
    expect(salts).toHaveLength(2);
    expect(new Set(salts).size).toBe(2);
  });

  it('refuses an empty passphrase', async () => {
    const { store } = world();
    const fixture = buildKeyring();
    await expect(
      addPassphrase({
        store,
        keyring: fixture.keyring,
        currentSlotKey: fixture.masterKey,
        passphrase: '',
      }),
    ).rejects.toThrow(/needs a passphrase/);
  });

  it('refuses a key that does not open the generation', async () => {
    const { store } = world();
    const fixture = buildKeyring();
    await expect(
      addPassphrase({
        store,
        keyring: fixture.keyring,
        currentSlotKey: randomBytes(KEY_BYTES),
        passphrase: 'whatever',
        params: FAST_SCRYPT,
      }),
    ).rejects.toThrow(/opened no generation/);
  });
});

describe('remove-slot (08 §3.7.7)', () => {
  it('removes a slot and writes the keyring', async () => {
    const { store } = world();
    const fixture = buildKeyring({ withPassphrase: true });
    await store.write(fixture.keyring);

    const next = await removeKeySlot({
      store,
      keyring: fixture.keyring,
      gen: fixture.keyring.current,
      slotId: 'pp1',
    });

    expect(currentGeneration(next).slots.map((slot) => slot.id)).toEqual(['mk1', 'rk1']);
    expect(await store.read()).toEqual(next);
  });

  it('still refuses the last recovery slot, and writes nothing', async () => {
    const { store } = world();
    const fixture = buildKeyring();
    await store.write(fixture.keyring);

    await expect(
      removeKeySlot({
        store,
        keyring: fixture.keyring,
        gen: fixture.keyring.current,
        slotId: 'rk1',
      }),
    ).rejects.toThrow(KeyringError);
    expect(await store.read()).toEqual(fixture.keyring);
  });
});

describe('purge-retired (08 §3.7.7, last row)', () => {
  it('refuses until the blobs have been rewrapped', async () => {
    // The precondition is the feature. Purging early makes blobs and old backups unreadable with
    // no error at the time — the failure arrives weeks later, during a restore.
    const { store } = world();
    const fixture = buildKeyring({ gen: 2, retiredGenerations: [1] });
    await store.write(fixture.keyring);

    await expect(
      purgeRetired({ store, keyring: fixture.keyring, blobsRewrapped: false }),
    ).rejects.toThrow(/until every blob has been rewrapped/);
    expect(await store.read()).toEqual(fixture.keyring);
  });

  it('deletes retired generations once the precondition holds', async () => {
    const { store } = world();
    const fixture = buildKeyring({ gen: 3, retiredGenerations: [1, 2] });
    await store.write(fixture.keyring);

    const result = await purgeRetired({ store, keyring: fixture.keyring, blobsRewrapped: true });

    expect([...result.purged].sort()).toEqual([1, 2]);
    expect(result.keyring.generations.map((generation) => generation.gen)).toEqual([3]);
    expect(await store.read()).toEqual(result.keyring);
  });

  it('never purges the generation the blob-id key is wrapped under', async () => {
    // `02` D14: without that key every blob address becomes uncomputable, so this generation is
    // load-bearing whatever its status says.
    const { store } = world();
    const fixture = buildKeyring({ gen: 2, retiredGenerations: [1] });
    const staticOnOld: Keyring = {
      ...fixture.keyring,
      static: { blobId: { ...fixture.keyring.static.blobId, gen: 1 } },
    };
    await store.write(staticOnOld);

    const result = await purgeRetired({ store, keyring: staticOnOld, blobsRewrapped: true });
    expect(result.purged).toEqual([]);
    expect(result.keyring.generations.map((generation) => generation.gen).sort()).toEqual([1, 2]);
  });

  it('is a no-op when there is nothing retired, and writes nothing', async () => {
    const { store, io } = world();
    const fixture = buildKeyring();
    await store.write(fixture.keyring);
    const before = io.calls.filter((call) => call.startsWith('writeFile')).length;

    const result = await purgeRetired({ store, keyring: fixture.keyring, blobsRewrapped: true });

    expect(result.purged).toEqual([]);
    expect(io.calls.filter((call) => call.startsWith('writeFile')).length).toBe(before);
  });
});

describe('rotate-sessions (08 §3.7.7 row 5)', () => {
  function epochStore(initial: number): SessionEpochStore & { value: number } {
    return {
      value: initial,
      read(): Promise<number> {
        return Promise.resolve(this.value);
      },
      write(epoch: number): Promise<void> {
        this.value = epoch;
        return Promise.resolve();
      },
    };
  }

  it('increments the epoch', async () => {
    const epochs = epochStore(4);
    expect(await rotateSessions(epochs)).toEqual({ previous: 4, epoch: 5 });
    expect(epochs.value).toBe(5);
  });

  it('invalidates every derived token, because the MAC key is per epoch', () => {
    // `08` §3.7.12: the token MAC key is `…/token-mac/epoch=<e>`, so one increment is what makes
    // every session, magic link, pairing code and CSRF token stop verifying.
    const fixture = buildKeyring();
    const service = unlock({ keyring: fixture.keyring, slotKey: Buffer.from(fixture.masterKey) });
    try {
      expect(service.tokenMacKey(4).equals(service.tokenMacKey(5))).toBe(false);
    } finally {
      service.lock();
    }
  });

  it('refuses a damaged epoch rather than writing a guess', async () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      await expect(rotateSessions(epochStore(bad))).rejects.toThrow(/not a usable epoch/);
    }
  });

  it('touches no key material at all, which is why it is milliseconds and online', async () => {
    const { store, io } = world();
    const fixture = buildKeyring();
    await store.write(fixture.keyring);
    const before = io.calls.length;

    await rotateSessions(epochStore(0));
    expect(io.calls.length).toBe(before);
  });
});

describe('rotate-data (08 §3.7.7 row 2)', () => {
  interface FakePorts extends RotateDataPorts {
    journal: RotationJournal | undefined;
    log: string[];
    rekeyedWith: Buffer | undefined;
    batches: number;
  }

  function ports(): FakePorts {
    return {
      journal: undefined,
      log: [],
      rekeyedWith: undefined,
      batches: 0,
      enterMaintenance(): Promise<void> {
        this.log.push('enter');
        return Promise.resolve();
      },
      leaveMaintenance(): Promise<void> {
        this.log.push('leave');
        return Promise.resolve();
      },
      rekeyDatabase(key: Buffer): Promise<void> {
        this.log.push('rekey');
        this.rekeyedWith = Buffer.from(key);
        return Promise.resolve();
      },
      rewrapBlobs(): Promise<{ cursor?: string; done: boolean }> {
        this.batches += 1;
        this.log.push('blobs');
        return Promise.resolve({ cursor: `row${String(this.batches)}`, done: true });
      },
      rewrapVault(): Promise<void> {
        this.log.push('vault');
        return Promise.resolve();
      },
      readJournal(): Promise<RotationJournal | undefined> {
        return Promise.resolve(this.journal);
      },
      writeJournal(journal: RotationJournal): Promise<void> {
        this.journal = journal;
        return Promise.resolve();
      },
      clearJournal(): Promise<void> {
        this.journal = undefined;
        return Promise.resolve();
      },
    };
  }

  /** Every key a rotation needs: the master key and the recovery key's slot key. */
  function keysOf(fixture: ReturnType<typeof withPrinted>): readonly Uint8Array[] {
    return [fixture.masterKey, fixture.recoverySlotKey];
  }

  it('creates the new generation, rekeys, rewraps and retires the old one', async () => {
    const { store } = world();
    const fixture = withPrinted();
    await store.write(fixture.keyring);
    const subject = ports();

    const result = await rotateData({
      store,
      keyring: fixture.keyring,
      slotKeys: keysOf(fixture),
      ports: subject,
    });

    expect(result.from).toBe(1);
    expect(result.to).toBe(2);
    expect(result.keyring.current).toBe(2);
    expect(result.keyring.generations.find((g) => g.gen === 1)?.status).toBe('retired');
    expect(result.keyring.generations.find((g) => g.gen === 2)?.status).toBe('active');
    // `08` §3.7.7's step order, including that the pause brackets only the rekey — which is what
    // makes this "online" in the sense that table means.
    expect(subject.log).toEqual(['enter', 'rekey', 'leave', 'blobs', 'vault']);
    expect(subject.journal).toBeUndefined();
    expect(await store.read()).toEqual(result.keyring);
  });

  it('carries every unlock route onto the new generation', async () => {
    const { store } = world();
    const fixture = withPrinted();
    await store.write(fixture.keyring);

    const result = await rotateData({
      store,
      keyring: fixture.keyring,
      slotKeys: keysOf(fixture),
      ports: ports(),
    });

    expect([...result.carried].map((slot) => slot.kind).sort()).toEqual(['master', 'recovery']);
    expect(result.dropped).toEqual([]);
    expect(opens(result.keyring, fixture.masterKey)).toBe(true);
    expect(verifyRecovery({ keyring: result.keyring, typed: fixture.printed }).ok).toBe(true);
  });

  it('refuses without the recovery key rather than building an unrecoverable generation', async () => {
    // The finding `08` §3.7.7's step list does not mention: wrapping the new root data key under a
    // recovery slot needs the recovery key's HKDF output, so without it the new generation would
    // have no recovery slot — and by §3.7.8 that makes a lost master key total loss.
    const { store } = world();
    const fixture = withPrinted();
    await store.write(fixture.keyring);

    await expect(
      rotateData({
        store,
        keyring: fixture.keyring,
        slotKeys: [fixture.masterKey],
        ports: ports(),
      }),
    ).rejects.toThrow(/no supplied key opens a recovery slot/);
    expect(await store.read()).toEqual(fixture.keyring);
  });

  it('refuses a key set that opens nothing at all', async () => {
    // Distinct from the missing-recovery-key case: here *no* slot opens, so there is no generation
    // to rotate from and the message should say so rather than talking about recovery slots.
    const { store } = world();
    const fixture = withPrinted();
    await store.write(fixture.keyring);

    await expect(
      rotateData({
        store,
        keyring: fixture.keyring,
        slotKeys: [randomBytes(KEY_BYTES)],
        ports: ports(),
        dropUnopenedSlots: true,
      }),
    ).rejects.toThrow(/opened no generation/);
    expect(await store.read()).toEqual(fixture.keyring);
  });

  it('skips the static rewrap when a resume already did it', async () => {
    // Idempotence where it matters. On a resume the statics may already be on the new generation,
    // and rewrapping again would consume a wrap for nothing — or, if the old generation's root key
    // were no longer reachable, fail a rotation that had in fact finished that step.
    const { store } = world();
    const fixture = withPrinted();
    await store.write(fixture.keyring);
    const subject = ports();

    const first = await rotateData({
      store,
      keyring: fixture.keyring,
      slotKeys: keysOf(fixture),
      ports: subject,
    });
    expect(first.keyring.static.blobId.gen).toBe(2);

    // Re-enter at the statics phase with the work already done.
    subject.journal = {
      from: 1,
      to: 2,
      startedAt: '2026-11-05T00:00:00Z',
      phase: 'blobs-rewrapped',
    };
    const wrapsBefore = first.keyring.wrapCount;
    const again = await rotateData({
      store,
      keyring: first.keyring,
      slotKeys: keysOf(fixture),
      ports: subject,
    });

    expect(again.keyring.static.blobId.gen).toBe(2);
    expect(again.keyring.wrapCount).toBe(wrapsBefore);
  });

  it('refuses to silently drop a passphrase slot', async () => {
    const { store } = world();
    const fixture = withPrinted({ withPassphrase: true });
    await store.write(fixture.keyring);

    await expect(
      rotateData({
        store,
        keyring: fixture.keyring,
        slotKeys: keysOf(fixture),
        ports: ports(),
      }),
    ).rejects.toThrow(/no supplied key opens "pp1"/);
  });

  it('drops a slot only when the caller says so, and names what went', async () => {
    const { store } = world();
    const fixture = withPrinted({ withPassphrase: true });
    await store.write(fixture.keyring);

    const result = await rotateData({
      store,
      keyring: fixture.keyring,
      slotKeys: keysOf(fixture),
      ports: ports(),
      dropUnopenedSlots: true,
    });

    expect(result.dropped).toEqual([{ id: 'pp1', kind: 'passphrase' }]);
    expect([...result.carried].map((slot) => slot.id).sort()).toEqual(['mk1', 'rk1']);
  });

  it('carries a passphrase slot when the passphrase key is supplied, with its own kdf', async () => {
    const { store } = world();
    const fixture = withPrinted({ withPassphrase: true });
    await store.write(fixture.keyring);

    const slot = currentGeneration(fixture.keyring).slots.find((s) => s.kind === 'passphrase');
    expect(slot?.kdf?.alg).toBe('scrypt');
    // Both halves asserted, not merely narrowed: a fixture that stopped setting `passphrase` would
    // make this `return` having checked only the kdf name. Found by the M1 independent review.
    expect(fixture.passphrase, 'the fixture did not set a passphrase').toBeDefined();
    if (slot?.kdf?.alg !== 'scrypt' || fixture.passphrase === undefined) return;
    const passphraseKey = scryptKeySync(
      fixture.passphrase,
      Buffer.from(slot.kdf.salt, 'base64url'),
      { N: slot.kdf.N, r: slot.kdf.r, p: slot.kdf.p },
    );

    const result = await rotateData({
      store,
      keyring: fixture.keyring,
      slotKeys: [...keysOf(fixture), passphraseKey],
      ports: ports(),
    });

    expect(result.dropped).toEqual([]);
    // The same passphrase still unlocks, because the slot kept the salt and parameters it had.
    expect(opens(result.keyring, passphraseKey)).toBe(true);
    const carried = currentGeneration(result.keyring).slots.find((s) => s.id === 'pp1');
    expect(carried?.kdf).toEqual(slot.kdf);
  });

  it('keeps the blob-id key itself, so blob addresses survive (02 D14)', async () => {
    // The whole reason the static key is random and wrapped rather than derived. A rotation that
    // minted a new one would make every existing attachment unreachable while reporting success.
    const { store } = world();
    const fixture = withPrinted();
    await store.write(fixture.keyring);

    const result = await rotateData({
      store,
      keyring: fixture.keyring,
      slotKeys: keysOf(fixture),
      ports: ports(),
    });

    expect(result.keyring.static.blobId.gen).toBe(2);
    const service = unlock({ keyring: result.keyring, slotKey: Buffer.from(fixture.masterKey) });
    try {
      expect(service.hasBlobIdKey).toBe(true);
      expect(service.blobIdKey.equals(fixture.blobIdKey)).toBe(true);
    } finally {
      service.lock();
    }
  });

  it('gives the new generation a different database key', async () => {
    // Otherwise `rotate-data` would not rotate anything — the failure a "successful" run hides.
    const { store } = world();
    const fixture = withPrinted();
    await store.write(fixture.keyring);
    const subject = ports();

    const before = unlock({
      keyring: fixture.keyring,
      slotKey: Buffer.from(fixture.masterKey),
    }).useDatabaseKeyHex((hex) => hex);

    await rotateData({
      store,
      keyring: fixture.keyring,
      slotKeys: keysOf(fixture),
      ports: subject,
    });

    expect(subject.rekeyedWith).toBeDefined();
    expect(subject.rekeyedWith?.toString('hex')).not.toBe(before);
  });

  it('rekeys with the new generation key, not the old one', async () => {
    const { store } = world();
    const fixture = withPrinted();
    await store.write(fixture.keyring);
    const subject = ports();

    const result = await rotateData({
      store,
      keyring: fixture.keyring,
      slotKeys: keysOf(fixture),
      ports: subject,
    });

    const expected = unlock({
      keyring: result.keyring,
      slotKey: Buffer.from(fixture.masterKey),
      gen: 2,
    }).useDatabaseKeyHex((hex) => hex);
    expect(subject.rekeyedWith?.toString('hex')).toBe(expected);
  });

  it('leaves maintenance mode even when the rekey fails', async () => {
    const { store } = world();
    const fixture = withPrinted();
    await store.write(fixture.keyring);
    const subject = ports();
    subject.rekeyDatabase = (): Promise<void> =>
      Promise.reject(new Error('the database is locked by another process'));

    await expect(
      rotateData({
        store,
        keyring: fixture.keyring,
        slotKeys: keysOf(fixture),
        ports: subject,
      }),
    ).rejects.toThrow('locked by another process');

    expect(subject.log).toEqual(['enter', 'leave']);
    // The journal survives, which is what lets the next run resume rather than start again.
    expect(subject.journal?.phase).toBe('keyring-written');
  });

  it('resumes from the journal instead of creating another generation', async () => {
    const { store } = world();
    const fixture = withPrinted();
    await store.write(fixture.keyring);
    const subject = ports();
    subject.rekeyDatabase = (): Promise<void> => Promise.reject(new Error('crash'));

    await rotateData({
      store,
      keyring: fixture.keyring,
      slotKeys: keysOf(fixture),
      ports: subject,
    }).catch(() => undefined);

    const partial = await store.read();
    expect(partial.generations.map((generation) => generation.gen)).toEqual([1, 2]);

    subject.rekeyDatabase = (key: Buffer): Promise<void> => {
      subject.rekeyedWith = Buffer.from(key);
      subject.log.push('rekey');
      return Promise.resolve();
    };
    const result = await rotateData({
      store,
      keyring: partial,
      slotKeys: keysOf(fixture),
      ports: subject,
    });

    expect(result.resumed).toBe(true);
    expect(result.keyring.generations.map((generation) => generation.gen)).toEqual([1, 2]);
    expect(result.keyring.generations.find((g) => g.gen === 1)?.status).toBe('retired');
    expect(result.keyring.static.blobId.gen).toBe(2);
    expect(subject.journal).toBeUndefined();
  });

  it('resumes the blob rewrap from its cursor', async () => {
    const { store } = world();
    const fixture = withPrinted();
    await store.write(fixture.keyring);
    const subject = ports();

    let calls = 0;
    const seen: (string | undefined)[] = [];
    subject.rewrapBlobs = (options: {
      generation: number;
      from?: string;
    }): Promise<{ cursor?: string; done: boolean }> => {
      seen.push(options.from);
      calls += 1;
      return Promise.resolve({ cursor: `row${String(calls)}`, done: calls === 3 });
    };

    await rotateData({
      store,
      keyring: fixture.keyring,
      slotKeys: keysOf(fixture),
      ports: subject,
    });

    expect(calls).toBe(3);
    expect(seen).toEqual([undefined, 'row1', 'row2']);
  });

  it('refuses when the journal and the keyring disagree', async () => {
    // One was restored without the other, and guessing which is right is how a rotation corrupts a
    // keyring that was merely out of date.
    const { store } = world();
    const fixture = withPrinted();
    await store.write(fixture.keyring);
    const subject = ports();
    subject.journal = {
      from: 7,
      to: 8,
      startedAt: '2026-11-05T00:00:00Z',
      phase: 'keyring-written',
    };

    await expect(
      rotateData({
        store,
        keyring: fixture.keyring,
        slotKeys: keysOf(fixture),
        ports: subject,
      }),
    ).rejects.toThrow(/journalled/);
  });

  it('survives a crash at every write step with a usable keyring', async () => {
    for (const point of FAULT_POINTS) {
      const { store, io } = world();
      const fixture = withPrinted();
      await store.write(fixture.keyring);

      io.armFault(point);
      let threw = false;
      await rotateData({
        store,
        keyring: fixture.keyring,
        slotKeys: keysOf(fixture),
        ports: ports(),
      }).catch(() => {
        threw = true;
      });
      expect(threw, `the fault at ${point} did not fire`).toBe(true);

      const candidates = await survivors(store);
      expect(
        candidates.some((keyring) => opens(keyring, fixture.masterKey)),
        `a crash at ${point} left no keyring the master key opens`,
      ).toBe(true);
    }
  });
});
