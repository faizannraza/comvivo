/**
 * Build a real keyring for tests.
 *
 * Deliberately **not** a hand-written JSON fixture. A keyring whose wraps were typed by hand could
 * not be unwrapped, so every test would have to stop at "the schema accepted it" — and the
 * properties worth testing are all on the other side of that line: does the master slot open, does
 * the recovery slot open, does a slot from another instance refuse.
 *
 * So this constructs one the way `comvivo init` will: a random root data key, wrapped once per
 * slot, with the AAD the real code uses. The keys come back alongside it, because a test that
 * cannot present the right key cannot test the wrong one either.
 */

import type { InstanceId } from '@comvivo/shared';
import {
  derivePurposeKey,
  KEY_PURPOSE,
  KEYRING_FORMAT,
  keyInfo,
  newScryptSalt,
  randomBytes,
  scryptKeySync,
  wrap,
} from '@comvivo/shared/crypto';
import type { Keyring } from '../keyring.js';
import { sealSlot } from '../keyring.js';

/** A fixed, syntactically valid instance id, so a failure message is readable. */
export const FIXTURE_INSTANCE = 'inst_01jd8kqd7h3f9z2m4n6p8r0t2v' as InstanceId;

/** Reduced scrypt parameters, for the same reason the crypto suite uses them. */
export const FAST_SCRYPT = { N: 1_024, r: 8, p: 1 } as const;

export interface KeyringFixture {
  readonly keyring: Keyring;
  /** The master key, which opens the `mk1` slot. */
  readonly masterKey: Buffer;
  /** The recovery **slot key** — already HKDF-derived, as `08` §3.7.6 specifies. */
  readonly recoverySlotKey: Buffer;
  /** The passphrase, when one was requested. */
  readonly passphrase?: string;
  /** The root data key, so a test can check what a slot unwrapped to. */
  readonly rootDataKey: Buffer;
  /** The static blob-id key, so a test can check it survives a generation change. */
  readonly blobIdKey: Buffer;
}

export interface FixtureOptions {
  readonly instanceId?: InstanceId;
  readonly gen?: number;
  readonly withPassphrase?: boolean;
  /** Extra retired generations, for rotation and `purge-retired` tests. */
  readonly retiredGenerations?: readonly number[];
}

/** A keyring with a master slot, a recovery slot, and optionally a passphrase slot. */
export function buildKeyring(options: FixtureOptions = {}): KeyringFixture {
  const instanceId = options.instanceId ?? FIXTURE_INSTANCE;
  const gen = options.gen ?? 1;

  const rootDataKey = randomBytes(32);
  const masterKey = randomBytes(32);
  const recoveryKey = randomBytes(32);
  // `08` §3.7.6: the recovery slot's key is HKDF(RK, salt=instanceId, info=…/rk-slot), not the
  // recovery key itself. Deriving it here rather than in the slot builder keeps the fixture honest
  // about what a caller has to do.
  const recoverySlotKey = derivePurposeKey(recoveryKey, instanceId, KEY_PURPOSE.rkSlot);
  const blobIdKey = randomBytes(32);

  const slots = [
    sealSlot({ instanceId, gen, id: 'mk1', kind: 'master', slotKey: masterKey, rootDataKey }),
    sealSlot({
      instanceId,
      gen,
      id: 'rk1',
      kind: 'recovery',
      slotKey: recoverySlotKey,
      rootDataKey,
      kdf: { alg: 'hkdf-sha256', info: keyInfo(KEY_PURPOSE.rkSlot) },
    }),
  ];

  let passphrase: string | undefined;
  if (options.withPassphrase === true) {
    passphrase = 'correct horse battery staple';
    const salt = newScryptSalt();
    const passphraseKey = scryptKeySync(passphrase, salt, FAST_SCRYPT);
    slots.push(
      sealSlot({
        instanceId,
        gen,
        id: 'pp1',
        kind: 'passphrase',
        slotKey: passphraseKey,
        rootDataKey,
        kdf: {
          alg: 'scrypt',
          N: FAST_SCRYPT.N,
          r: FAST_SCRYPT.r,
          p: FAST_SCRYPT.p,
          salt: salt.toString('base64url'),
        },
      }),
    );
  }

  // Retired generations get their own root keys, because that is what `rotate-data` produces — and
  // a fixture that reused one would hide the bug where a slot opens under the wrong generation.
  const retired = (options.retiredGenerations ?? []).map((retiredGen) => {
    const retiredRoot = randomBytes(32);
    return {
      gen: retiredGen,
      status: 'retired' as const,
      createdAt: '2026-01-01T00:00:00Z',
      slots: [
        sealSlot({
          instanceId,
          gen: retiredGen,
          id: 'mk1',
          kind: 'master' as const,
          slotKey: masterKey,
          rootDataKey: retiredRoot,
        }),
        sealSlot({
          instanceId,
          gen: retiredGen,
          id: 'rk1',
          kind: 'recovery' as const,
          slotKey: recoverySlotKey,
          rootDataKey: retiredRoot,
        }),
      ],
    };
  });

  const keyring: Keyring = {
    format: KEYRING_FORMAT,
    instanceId,
    current: gen,
    wrapCount: slots.length,
    generations: [...retired, { gen, status: 'active', createdAt: '2026-11-05T12:00:00Z', slots }],
    static: {
      blobId: {
        gen,
        wrap: {
          alg: 'A256GCM',
          // The blob-id key is wrapped by the root data key itself, under a slot-shaped AAD with
          // the reserved id `blobid` — matching `key-service.ts`'s `#unwrapStaticBlobIdKey`.
          sealed: wrap(
            rootDataKey,
            blobIdKey,
            `${KEYRING_FORMAT}|${instanceId}|gen=${String(gen)}|slot=blobid|kind=master`,
          ).toString('base64url'),
        },
      },
    },
  };

  return {
    keyring,
    masterKey,
    recoverySlotKey,
    ...(passphrase === undefined ? {} : { passphrase }),
    rootDataKey,
    blobIdKey,
  };
}
