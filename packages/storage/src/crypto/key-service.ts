/**
 * `KeyService` — unlock, derive, and hold the key tree (`08` §3.7.2–§3.7.5, `02` §3.6.1).
 *
 * One object owns every key in a running instance. That is deliberate: the alternative is each
 * subsystem deriving its own, and then "which keys does this process hold, and when were they
 * zeroed" has no answer.
 *
 * The shape follows `02` §3.6.1 exactly:
 *
 *  - **The root data key is zeroed immediately after the purpose keys are derived.** It is the one
 *    key that unlocks everything, and nothing needs it again until a rotation — which re-unlocks.
 *  - **Keys used repeatedly are kept for the process lifetime**: the blob KEK and the static
 *    blob-id key. Deriving them per call would mean re-deriving on every attachment.
 *  - **The database key’s hex string necessarily passes through a JavaScript string**, because
 *    `PRAGMA key` takes one. A string cannot be zeroed — V8 interns it and the GC may have copied
 *    it. `02` §3.6.1 records this and so does `08`; it is a real residual, stated rather than
 *    papered over, and it is why the database key is handed out through a callback that scopes its
 *    use rather than being stored as a property.
 *
 * What this file does **not** do: rotation, the recovery-key codec, and the `comvivo keys`
 * commands. Those are `M1-T6`, built on this.
 */

import { BRAND, type InstanceId } from '@comvivo/shared';
import {
  derivePurposeKey,
  isZeroed,
  KEY_BYTES,
  KEY_PURPOSE,
  randomBytes,
  scryptKey,
  tokenMacPurpose,
  withZeroed,
  zeroize,
  zeroizeAll,
} from '@comvivo/shared/crypto';
import {
  currentGeneration,
  generationFor,
  type Keyring,
  KeyringError,
  type KeyringSlot,
  openSlot,
} from './keyring.js';

/** How the instance was unlocked, for the `keys.unlocked` log line (`08` §3.7.5 step 5). */
export interface UnlockRecord {
  readonly slotKind: KeyringSlot['kind'];
  readonly slotId: string;
  readonly gen: number;
}

/** A key the service hands out. The caller must not hold it beyond its use. */
export type PurposeKey = Buffer;

export interface KeyServiceOptions {
  readonly keyring: Keyring;
  /**
   * The key the unlock source produced — the master key, or one derived from the recovery key or a
   * passphrase. **Zeroed by `unlock` before it returns**, whichever slot matched.
   */
  readonly slotKey: Uint8Array;
  /** Which generation to open. Defaults to the keyring's `current`. */
  readonly gen?: number;
  /** Restrict the attempt to slots of one kind, for `verify-recovery`. */
  readonly onlyKind?: KeyringSlot['kind'];
}

/**
 * Unlock a keyring and build the key tree.
 *
 * Slots are tried in order until one opens (`08` §3.7.5 step 2). A miss is not an error — a
 * keyring holds a master slot, a recovery slot and sometimes a passphrase slot, and only one of
 * them matches the key in hand.
 */
export function unlock(options: KeyServiceOptions): KeyService {
  const { keyring, slotKey, onlyKind } = options;
  const generation =
    options.gen === undefined ? currentGeneration(keyring) : generationFor(keyring, options.gen);

  const candidates = generation.slots.filter(
    (slot) => onlyKind === undefined || slot.kind === onlyKind,
  );
  if (candidates.length === 0) {
    throw new KeyringError(
      'KEYRING_NO_MATCHING_SLOT',
      `generation ${String(generation.gen)} has no ${onlyKind ?? 'usable'} slot`,
      `Run \`${BRAND.cliName} keys status\` to see which slots exist.`,
    );
  }

  let rootDataKey: Buffer | undefined;
  let matched: KeyringSlot | undefined;
  try {
    for (const slot of candidates) {
      const opened = openSlot({
        instanceId: keyring.instanceId,
        gen: generation.gen,
        slot,
        slotKey,
      });
      if (opened !== undefined) {
        rootDataKey = opened;
        matched = slot;
        break;
      }
    }

    if (rootDataKey === undefined || matched === undefined) {
      throw new KeyringError(
        'KEYRING_NO_MATCHING_SLOT',
        `no slot in generation ${String(generation.gen)} opened with the supplied key`,
        'The key does not match this keyring. If you have rotated the master key, the old one ' +
          'will no longer work — use the current `master.key`, or recover with your recovery ' +
          `key: \`${BRAND.cliName} keys recover\`. ${BRAND.displayName} will not start ` +
          'unencrypted as a fallback.',
      );
    }

    if (rootDataKey.length !== KEY_BYTES) {
      // A slot that unwrapped to the wrong length means the keyring was written by something that
      // is not this product. The AEAD already authenticated it, so this is not an attack — it is a
      // format mismatch, and continuing would derive a whole key tree from the wrong bytes.
      //
      // Now **subsumed** by `keyring.ts`'s `sealedSchema`, which requires every wrap to be exactly
      // `sealedLength(32)` bytes: AES-GCM preserves length, so a wrap of that size can only yield
      // 32 bytes of plaintext. Kept as a defence in depth rather than deleted, because it is the
      // last check between a wrong-sized buffer and `derivePurposeKey` — but it is unreachable
      // today, which is why it has no test of its own.
      throw new KeyringError(
        'KEYRING_MALFORMED',
        `slot ${matched.id} unwrapped to ${String(rootDataKey.length)} bytes, expected ${String(KEY_BYTES)}`,
        `This keyring was not written by ${BRAND.displayName}. Restore \`keyring.json.prev\` or a backup.`,
      );
    }

    return new KeyService(keyring, rootDataKey, {
      slotKind: matched.kind,
      slotId: matched.id,
      gen: generation.gen,
    });
  } finally {
    // The caller's unlock key is spent either way. Zeroed here rather than left to the caller
    // because this is the last function that needs it, and a key left live after a *failed* unlock
    // is the case a caller's `finally` most often misses.
    zeroize(slotKey);
    // `rootDataKey` is adopted by the `KeyService` on success and must not be zeroed here; on
    // failure it was never assigned, or we are throwing and it is unreferenced.
  }
}

/**
 * Derive a slot key from a passphrase (`08` §3.7.4's `kdf` block).
 *
 * The parameters come from the slot, not from the current defaults, so raising `N` later still
 * unlocks an old keyring — which is the entire reason `08` §3.7.4 stores them.
 */
export async function passphraseSlotKey(passphrase: string, slot: KeyringSlot): Promise<Buffer> {
  const kdf = slot.kdf;
  if (kdf === undefined || kdf.alg !== 'scrypt') {
    throw new KeyringError(
      'KEYRING_MALFORMED',
      `slot ${slot.id} is a passphrase slot without scrypt parameters`,
      'The keyring is damaged. Restore `keyring.json.prev` or recover with your recovery key.',
    );
  }
  return scryptKey(passphrase, Buffer.from(kdf.salt, 'base64url'), {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
  });
}

/**
 * The key tree for one unlocked generation.
 *
 * Holds the two keys that are used repeatedly and derives the rest on demand. `02` §3.6.1 is the
 * authority on which is which, and the split is about frequency: the blob KEK wraps a DEK per
 * attachment, while the backup KEK is used once per backup.
 */
export class KeyService {
  readonly #keyring: Keyring;
  readonly #gen: number;
  readonly #unlockRecord: UnlockRecord;

  /** Kept for the process lifetime (`02` §3.6.1). */
  #blobKek: Buffer | undefined;
  #blobIdKey: Buffer | undefined;

  /** The raw database key, held only long enough to open the database. */
  #databaseKey: Buffer | undefined;

  #locked = false;

  constructor(keyring: Keyring, rootDataKey: Buffer, unlockRecord: UnlockRecord) {
    this.#keyring = keyring;
    this.#gen = unlockRecord.gen;
    this.#unlockRecord = unlockRecord;

    try {
      // Everything that will ever be needed from the root key is derived here, in one place, so
      // the root key's lifetime is a handful of statements rather than the process lifetime.
      this.#databaseKey = this.#derive(rootDataKey, KEY_PURPOSE.db);
      this.#blobKek = this.#derive(rootDataKey, KEY_PURPOSE.blobKek);
      this.#blobIdKey = this.#unwrapStaticBlobIdKey(rootDataKey);
      this.#backupKek = this.#derive(rootDataKey, KEY_PURPOSE.backupKek);
      this.#vaultKey = this.#derive(rootDataKey, KEY_PURPOSE.vault);
      this.#rootForTokenMac = Buffer.from(rootDataKey);
    } finally {
      // `02` §3.6.1: "MK and RDK live in buffers that are zeroed after derivation."
      zeroize(rootDataKey);
    }
  }

  #backupKek: Buffer | undefined;
  #vaultKey: Buffer | undefined;

  /**
   * A copy of the root key, kept **only** to derive token-MAC keys per epoch.
   *
   * `08` §3.7.12's token MAC key is `…/token-mac/epoch=<e>`, and the epoch lives in the encrypted
   * database settings — which is not readable until the database is open, which needs the database
   * key, which needs this constructor to have finished. So the root key cannot be fully discarded
   * here without making `rotate-sessions` require a restart.
   *
   * This is a real weakening of `02` §3.6.1's "zeroed after derivation" and it is recorded as such
   * in STATUS → Plan changes rather than hidden: the root key lives as long as the service does.
   * `zeroizeRootKey()` lets a caller give it up once the epoch is known, and the server does
   * exactly that after step 4 of `08` §3.7.5.
   */
  #rootForTokenMac: Buffer | undefined;

  /**
   * `string`, not `KeyPurpose`.
   *
   * Most purposes come from the registry, but `08` §3.7.12's token-MAC purpose is *computed* —
   * `token-mac/epoch=<e>` — so it cannot be a member of a closed union. `KeyPurpose | string`
   * would read as a safeguard and collapse to `string`, which is worse than being honest: the
   * callers that *can* use the registry do, and this signature says the rest are free-form.
   */
  #derive(rootDataKey: Uint8Array, purpose: string): Buffer {
    return derivePurposeKey(rootDataKey, this.#keyring.instanceId, purpose);
  }

  /**
   * Unwrap the static blob-id key, or `undefined` when this generation cannot.
   *
   * `08` §3.7.2 wraps the static keys "by the **current** RDK" and rewraps them on rotation, so
   * there is exactly one generation whose root key opens them. Unlocking a **retired** generation —
   * which is how `08` §3.7.7's retained generations let an old backup be read — therefore cannot
   * produce the blob-id key, and that is correct rather than a failure.
   *
   * The first version of this method threw instead, which made unlocking any retired generation
   * fail with `KEYRING_MALFORMED`. That would have surfaced at `M1-T27` as "restoring an old
   * backup reports a damaged keyring", sending a host to recover a keyring that was never broken.
   *
   * `08` §3.7.11 is where the key actually comes from in that case: the `VBK1` header's
   * `keyringSnapshot.static.blobId` is **required** precisely so a restore can recompute blob
   * addresses. So the honest answer here is "not from this unlock", and `blobIdKey` says where to
   * look instead.
   */
  #unwrapStaticBlobIdKey(rootDataKey: Uint8Array): Buffer | undefined {
    const { blobId } = this.#keyring.static;
    if (blobId.gen !== this.#gen) return undefined;

    const slot: KeyringSlot = { id: 'blobid', kind: 'master', wrap: blobId.wrap };
    const opened = openSlot({
      instanceId: this.#keyring.instanceId,
      gen: blobId.gen,
      slot,
      slotKey: rootDataKey,
    });
    if (opened === undefined) {
      // The generation matches, so this is genuine damage: the wrap does not open under the root
      // key that created it.
      throw new KeyringError(
        'KEYRING_MALFORMED',
        `the static blob-id key does not unwrap under generation ${String(blobId.gen)}`,
        'Blob addresses depend on this key. Restore `keyring.json.prev`, or restore from a ' +
          'backup — its keyring snapshot carries the blob-id key (08 §3.7.11).',
      );
    }
    return opened;
  }

  #assertUnlocked(): void {
    if (this.#locked) {
      throw new KeyringError(
        'KEYRING_NO_MATCHING_SLOT',
        'this KeyService has been locked and its keys zeroed',
        'This is a bug: something is using the key service after shutdown. Report it with the ' +
          `output of \`${BRAND.cliName} doctor\`.`,
      );
    }
  }

  /** Which slot opened this generation, for the audit event and the log line. */
  get unlockRecord(): UnlockRecord {
    return this.#unlockRecord;
  }

  get instanceId(): InstanceId {
    return this.#keyring.instanceId;
  }

  get generation(): number {
    return this.#gen;
  }

  /**
   * Use the SQLCipher raw key, as 64 lowercase hex characters.
   *
   * A callback rather than a getter, and the key is zeroed when it returns. `08` §3.7.9 validates
   * the hex against `^[0-9a-f]{64}$` before interpolating it into `PRAGMA key`, and that check
   * happens here so there is one place it can be got wrong.
   *
   * The hex **string** cannot be zeroed — V8 interns strings — which `02` §3.6.1 records as a
   * known residual. Scoping it to a callback at least bounds how long a reference exists.
   */
  useDatabaseKeyHex<T>(fn: (hex: string) => T): T {
    this.#assertUnlocked();
    const key = this.#databaseKey;
    if (key === undefined) {
      throw new KeyringError(
        'KEYRING_NO_MATCHING_SLOT',
        'the database key has already been consumed',
        'This is a bug: the database key is handed out once, when the database is opened.',
      );
    }
    // `08` §3.7.9 requires this check before the value is interpolated into `PRAGMA key`. HKDF
    // always returns the requested length, so it cannot fail today and is **deliberately**
    // unreachable — it is the guard that keeps a future change to the derivation from putting
    // something unquoted into SQL. Left in rather than tested into reachability: making it
    // reachable would mean a seam that let a caller supply the database key, which is the one
    // thing this class exists to prevent.
    const hex = key.toString('hex');
    if (!/^[0-9a-f]{64}$/.test(hex)) {
      throw new KeyringError(
        'KEYRING_MALFORMED',
        'the derived database key is not 32 bytes of hex',
        `This is a bug. Report it with the output of \`${BRAND.cliName} doctor\`.`,
      );
    }
    try {
      return fn(hex);
    } finally {
      // The buffer can be zeroed even though the string cannot.
      zeroize(key);
      this.#databaseKey = undefined;
    }
  }

  /** The blob key-encryption key for this generation. Kept live (`02` §3.6.1). */
  get blobKek(): PurposeKey {
    this.#assertUnlocked();
    if (this.#blobKek === undefined) throw this.#gone('blob KEK');
    return this.#blobKek;
  }

  /**
   * The static blob-id key. Kept live, and stable across generations (`02` D14).
   *
   * Available only when this unlock is of the generation the static keys are wrapped under — which
   * is the current one (`08` §3.7.2). See `hasBlobIdKey` for the retired-generation case.
   */
  get blobIdKey(): PurposeKey {
    this.#assertUnlocked();
    if (this.#blobIdKey === undefined) {
      const { blobId } = this.#keyring.static;
      throw new KeyringError(
        'KEYRING_GENERATION_MISSING',
        `the static blob-id key is wrapped under generation ${String(blobId.gen)}, and this ` +
          `KeyService opened generation ${String(this.#gen)}`,
        'Static keys are wrapped by the current generation only (08 §3.7.2). To read blobs from ' +
          'a retired generation, take the blob-id key from the backup’s keyring snapshot ' +
          '(08 §3.7.11), or unlock the current generation instead.',
      );
    }
    return this.#blobIdKey;
  }

  /**
   * Whether this unlock can produce the blob-id key.
   *
   * So a caller can branch without catching: reading an old backup legitimately cannot, and a
   * `try`/`catch` around a normal condition is how a real error later gets swallowed.
   */
  get hasBlobIdKey(): boolean {
    return !this.#locked && this.#blobIdKey !== undefined;
  }

  /** The backup key-encryption key. */
  get backupKek(): PurposeKey {
    this.#assertUnlocked();
    if (this.#backupKek === undefined) throw this.#gone('backup KEK');
    return this.#backupKek;
  }

  /** The secrets-vault key (`08` §3.7.2). */
  get vaultKey(): PurposeKey {
    this.#assertUnlocked();
    if (this.#vaultKey === undefined) throw this.#gone('vault key');
    return this.#vaultKey;
  }

  /**
   * The token MAC key for a session epoch (`08` §3.7.12).
   *
   * Derived on demand because the epoch is only knowable once the database is open, and because
   * `rotate-sessions` bumps it while the process runs.
   */
  tokenMacKey(epoch: number): PurposeKey {
    this.#assertUnlocked();
    const root = this.#rootForTokenMac;
    if (root === undefined) {
      throw new KeyringError(
        'KEYRING_NO_MATCHING_SLOT',
        'the root key has been released, so no further token-MAC epochs can be derived',
        'Call `tokenMacKey` before `zeroizeRootKey`, or re-unlock. `rotate-sessions` needs the ' +
          'root key, so a long-running process should keep it until the epoch is settled.',
      );
    }
    return this.#derive(root, tokenMacPurpose(epoch));
  }

  /**
   * Give up the root key once every epoch-derived key is in hand.
   *
   * `08` §3.7.5's step 4 reads `sessionEpoch` and derives the token MAC key; immediately after
   * that, nothing needs the root key until a rotation, which re-unlocks from the keyring. Calling
   * this shortens the root key's life from "the process" to "boot", which is the difference
   * between a core dump containing one key and containing all of them.
   */
  zeroizeRootKey(): void {
    if (this.#rootForTokenMac !== undefined) {
      zeroize(this.#rootForTokenMac);
      this.#rootForTokenMac = undefined;
    }
  }

  /** Zero every key this service holds. Called on shutdown and on lock. */
  lock(): void {
    zeroizeAll(
      this.#databaseKey,
      this.#blobKek,
      this.#blobIdKey,
      this.#backupKek,
      this.#vaultKey,
      this.#rootForTokenMac,
    );
    this.#databaseKey = undefined;
    this.#blobKek = undefined;
    this.#blobIdKey = undefined;
    this.#backupKek = undefined;
    this.#vaultKey = undefined;
    this.#rootForTokenMac = undefined;
    this.#locked = true;
  }

  get isLocked(): boolean {
    return this.#locked;
  }

  /**
   * The error for a derived key that is somehow absent.
   *
   * A type-level guard, not a runtime path: `lock()` is the only thing that clears these fields
   * and it sets `#locked` at the same time, so `#assertUnlocked` always answers first. It exists
   * because the fields have to be optional for `lock()` to clear them, and `strict` then requires
   * the narrowing. Uncovered on purpose — there is no way to reach it without a bug, and
   * `refuses to hand out a key after lock, naming it as a bug` asserts the path that runs.
   */
  #gone(what: string): KeyringError {
    return new KeyringError(
      'KEYRING_NO_MATCHING_SLOT',
      `the ${what} is not available on this KeyService`,
      'This is a bug: a key was released and then used. Report it with the output of ' +
        `\`${BRAND.cliName} doctor\`.`,
    );
  }
}

/**
 * A fresh root data key for a new generation.
 *
 * Separate from the service so `comvivo init` and `rotate-data` share it, and so a test can
 * see that the key is 32 bytes of CSPRNG output rather than anything derived.
 */
export function newRootDataKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** A fresh static blob-id key (`02` D14). */
export function newBlobIdKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** Re-exported so tests can assert zeroing without reaching past the package boundary. */
export { isZeroed, withZeroed };
