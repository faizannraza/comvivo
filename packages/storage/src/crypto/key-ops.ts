/**
 * The key operations behind `comvivo keys …` (`08` §3.7.7, §3.7.8).
 *
 * A library, not a CLI: `09` §3.11.3 owns the command surface and `M3-T13` wires it. Keeping the
 * logic here means the dangerous part is testable without a terminal, and `08` §3.7.7's "CLI-only,
 * never exposed over HTTP" stays a property of the *caller* rather than something this file has to
 * police.
 *
 * **Every operation that replaces a key is two-phase, and the order is not cosmetic.** `08` §3.7.7
 * spells `rotate-master` out as "add a slot → write the keyring → store the new MK → remove the
 * old slot", and the reason is the crash in the middle: if the old slot went away before the new
 * master key was durably stored, a power cut at that moment would leave a keyring that only opens
 * with a key nobody saved — which by §3.7.8 means the recovery key, or nothing. So the phases are
 * expressed as a callback the caller supplies, and the old slot is removed only after it returns.
 * An API that let a caller do these in the wrong order would eventually be used in the wrong
 * order.
 *
 * Crash-safety for the keyring itself comes from `KeyringStore.write` — temp → fsync → preserve
 * `.prev` → rename → fsync the directory — so each step below lands whole or not at all, and the
 * previous keyring is one rename away. `rotate-data` needs more than that because it also touches
 * the database and every blob row, so it carries its own journal.
 */

import { BRAND, type InstanceId } from '@comvivo/shared';
import {
  KEY_BYTES,
  newScryptSalt,
  randomBytes,
  SCRYPT_PARAMS,
  type ScryptParams,
  scryptKey,
} from '@comvivo/shared/crypto';
import { newRootDataKey, unlock } from './key-service.js';
import {
  currentGeneration,
  type GenerationStatus,
  generationFor,
  type Keyring,
  KeyringError,
  type KeyringGeneration,
  type KeyringSlot,
  nextSlotId,
  openSlot,
  putSlot,
  removeSlot as removeKeyringSlot,
  type SlotKind,
  STATIC_SLOT_ID,
  sealSlot,
} from './keyring.js';
import type { KeyringStore } from './keyring-store.js';
import {
  decodeRecoveryKey,
  encodeRecoveryKey,
  newRecoveryKey,
  recoverySlotKey,
} from './recovery-key.js';

/** How long `08` §3.7.6 lets a recovery key go unverified before doctor nudges. */
export const RECOVERY_NUDGE_DAYS = 180;

/* ───────────────────────────── status ───────────────────────────── */

/** One generation, as `comvivo keys status` shows it. No key material. */
export interface GenerationStatusReport {
  readonly gen: number;
  readonly status: GenerationStatus;
  readonly createdAt: string;
  readonly slots: readonly { readonly id: string; readonly kind: SlotKind }[];
  readonly isCurrent: boolean;
}

/**
 * What `comvivo keys status` prints.
 *
 * Deliberately contains **no key material and no wrapped bytes** — it is designed to be safe to
 * paste into a support thread, which is what a host will do with it. `08` §3.7.3's unlock mode is
 * not here either: that is configuration, and this is the keyring.
 */
export interface KeyStatus {
  readonly instanceId: InstanceId;
  readonly current: number;
  readonly wrapCount: number;
  readonly generations: readonly GenerationStatusReport[];
  /** `08` §3.7.8 row 2: the third unlock route, present only if the host chose it. */
  readonly hasPassphrase: boolean;
  /** Recovery slots on the current generation. One is the minimum the keyring enforces. */
  readonly recoverySlots: number;
  /** Retired generations still retained, which is what `purge-retired` would delete. */
  readonly retainedGenerations: number;
  /** The blob-id key's generation, and whether the current unlock can reach it (`08` §3.7.2). */
  readonly blobIdGeneration: number;
  /** `08` §3.7.1: `doctor` advises `rotate-data` at 2^30 wraps. */
  readonly wrapsRemaining: number;
  readonly shouldRotateData: boolean;
}

/** `08` §3.7.1's advisory threshold. Counting is the only way to know; a collision is silent. */
export const WRAP_COUNT_ADVISORY = 2 ** 30;

export function status(keyring: Keyring): KeyStatus {
  const current = currentGeneration(keyring);
  return {
    instanceId: keyring.instanceId,
    current: keyring.current,
    wrapCount: keyring.wrapCount,
    generations: keyring.generations.map((generation) => ({
      gen: generation.gen,
      status: generation.status,
      createdAt: generation.createdAt,
      slots: generation.slots.map((slot) => ({ id: slot.id, kind: slot.kind })),
      isCurrent: generation.gen === keyring.current,
    })),
    hasPassphrase: current.slots.some((slot) => slot.kind === 'passphrase'),
    recoverySlots: current.slots.filter((slot) => slot.kind === 'recovery').length,
    retainedGenerations: keyring.generations.filter((g) => g.status === 'retired').length,
    blobIdGeneration: keyring.static.blobId.gen,
    wrapsRemaining: Math.max(0, WRAP_COUNT_ADVISORY - keyring.wrapCount),
    shouldRotateData: keyring.wrapCount >= WRAP_COUNT_ADVISORY,
  };
}

/* ─────────────────────────── verify-recovery ─────────────────────────── */

export interface VerifyRecoveryResult {
  readonly ok: boolean;
  /** Which generation and slot it opened, when it did. */
  readonly gen?: number;
  readonly slotId?: string;
  /** Why not, when it did not. Never contains the typed key. */
  readonly reason?: string;
  readonly hint?: string;
}

/**
 * Check a typed recovery key against the keyring, changing nothing (`08` §3.7.6).
 *
 * The distinction this draws is the whole point: a key that fails the **checksum** is a typo and
 * the host should look at what they wrote down, while a key that decodes cleanly and then opens no
 * slot is the *wrong* key — a different host's, or one that has since been rotated. Reporting both
 * as "invalid recovery key" would leave somebody re-reading a perfectly good piece of paper.
 *
 * Tries every retained generation, not only the current one, because `08` §3.7.7 keeps old
 * generations so old backups still open — and a recovery key that opens a retired generation is
 * still useful, which `--gen` lets a host confirm.
 */
export function verifyRecovery(options: {
  readonly keyring: Keyring;
  readonly typed: string;
  readonly gen?: number;
}): VerifyRecoveryResult {
  const { keyring, typed } = options;
  const decoded = decodeRecoveryKey(typed);
  if (!decoded.ok) {
    return { ok: false, reason: decoded.error.message, hint: decoded.error.hint };
  }

  const slotKey = recoverySlotKey(decoded.key, keyring.instanceId);
  decoded.key.fill(0);
  try {
    return verifyRecoveryWithSlotKey(keyring, slotKey, options.gen);
  } finally {
    slotKey.fill(0);
  }
}

/**
 * The slot-trying half of `verifyRecovery`, for a key that has already been decoded.
 *
 * Shared with `recover` so the printed key is decoded exactly once per operation. The caller owns
 * `slotKey` and is responsible for zeroing it.
 */
function verifyRecoveryWithSlotKey(
  keyring: Keyring,
  slotKey: Uint8Array,
  gen?: number,
): VerifyRecoveryResult {
  const generations = gen === undefined ? keyring.generations : [generationFor(keyring, gen)];

  for (const generation of generations) {
    for (const slot of generation.slots) {
      if (slot.kind !== 'recovery') continue;
      const opened = openSlot({
        instanceId: keyring.instanceId,
        gen: generation.gen,
        slot,
        slotKey,
      });
      if (opened !== undefined) {
        opened.fill(0);
        return { ok: true, gen: generation.gen, slotId: slot.id };
      }
    }
  }

  return {
    ok: false,
    reason: 'this recovery key is well formed but does not open any recovery slot',
    hint:
      'The checksum passed, so it was typed correctly — it is a different key. It may belong to ' +
      `another install, or it may have been replaced by \`${BRAND.cliName} keys ` +
      'rotate-recovery`. Check for a more recent printout.',
  };
}

/* ─────────────────────────── shared internals ─────────────────────────── */

/**
 * The root data key of every generation that any of `slotKeys` opens.
 *
 * Takes a set rather than one key because `rotate-data` has to carry **every** unlock route onto
 * the new generation, and each route has its own slot key: the master key, the recovery key's
 * HKDF output, and a passphrase's scrypt output. Misses are normal — `08` §3.7.5 step 2 tries
 * slots in turn — so a key that opens nothing is not an error here.
 */
function openEveryGeneration(
  keyring: Keyring,
  slotKeys: readonly Uint8Array[],
  kind?: SlotKind,
): Map<number, Buffer> {
  const opened = new Map<number, Buffer>();
  for (const generation of keyring.generations) {
    for (const slot of generation.slots) {
      if (kind !== undefined && slot.kind !== kind) continue;
      const rootDataKey = firstOpen(keyring, generation.gen, slot, slotKeys);
      if (rootDataKey !== undefined) {
        opened.set(generation.gen, rootDataKey);
        break;
      }
    }
  }
  return opened;
}

/** The first of `slotKeys` that opens this slot, with the key that did it. */
function firstOpenWithKey(
  keyring: Keyring,
  gen: number,
  slot: KeyringSlot,
  slotKeys: readonly Uint8Array[],
): { readonly rootDataKey: Buffer; readonly slotKey: Uint8Array } | undefined {
  for (const slotKey of slotKeys) {
    const rootDataKey = openSlot({ instanceId: keyring.instanceId, gen, slot, slotKey });
    if (rootDataKey !== undefined) return { rootDataKey, slotKey };
  }
  return undefined;
}

function firstOpen(
  keyring: Keyring,
  gen: number,
  slot: KeyringSlot,
  slotKeys: readonly Uint8Array[],
): Buffer | undefined {
  return firstOpenWithKey(keyring, gen, slot, slotKeys)?.rootDataKey;
}

/**
 * Which of `slotKeys` can unlock a generation, for the paths that need a `KeyService`.
 *
 * `unlock` takes a **slot key** and derives the tree itself; it does not accept a root data key,
 * deliberately, because handing it one would be a seam that lets a caller supply the database key.
 * So the rekey step has to find a key that opens the new generation rather than reusing the root
 * data key it already has in hand.
 */
function openerFor(
  keyring: Keyring,
  gen: number,
  slotKeys: readonly Uint8Array[],
): Uint8Array | undefined {
  for (const slot of generationFor(keyring, gen).slots) {
    const match = firstOpenWithKey(keyring, gen, slot, slotKeys);
    if (match !== undefined) {
      match.rootDataKey.fill(0);
      return match.slotKey;
    }
  }
  return undefined;
}

function zeroEach(keys: Iterable<Buffer>): void {
  for (const key of keys) key.fill(0);
}

/** Count the wraps an operation performed, so `08` §3.7.1's advisory stays meaningful. */
function withWraps(keyring: Keyring, added: number): Keyring {
  return { ...keyring, wrapCount: keyring.wrapCount + added };
}

function noGenerationOpened(what: string): KeyringError {
  return new KeyringError(
    'KEYRING_NO_MATCHING_SLOT',
    `the supplied key opened no generation, so ${what} cannot proceed`,
    'The key does not match this keyring. Use the current key material, or recover with your ' +
      `recovery key: \`${BRAND.cliName} keys recover\`.`,
  );
}

/* ─────────────────────────── rotate-master ─────────────────────────── */

export interface RotateMasterResult {
  readonly keyring: Keyring;
  /** The new master key. **Zeroed** by the time this returns: `storeKey` was given it. */
  readonly slotIds: readonly { readonly gen: number; readonly added: string }[];
  readonly removed: readonly { readonly gen: number; readonly slotId: string }[];
}

/**
 * Replace the master key (`08` §3.7.7 row 1).
 *
 * `storeKey` is where the caller persists the new master key — a keyfile, the OS keychain, a
 * mounted secret. It is called **after** the keyring holding both the old and the new slot has
 * been fsynced and renamed into place, and the old slot is removed only after it returns. So:
 *
 *  - crash before `storeKey`: the old master key still opens everything; nothing was lost;
 *  - crash during `storeKey`: both keys work, and `keys status` shows two `mk` slots, which is the
 *    recoverable state — either key opens the keyring and the host can simply run it again;
 *  - crash after `storeKey` but before the removal: same, with the new key definitely saved.
 *
 * There is no ordering in which a single crash loses the data, which is the property this shape
 * exists for. The new key is zeroed once `storeKey` has had it.
 */
export async function rotateMaster(options: {
  readonly store: KeyringStore;
  readonly keyring: Keyring;
  /** The key that currently opens the master slots. */
  readonly currentMasterKey: Uint8Array;
  readonly storeKey: (key: Buffer) => Promise<void>;
  /** Supplied only by tests that need a known key. */
  readonly newMasterKey?: Buffer;
}): Promise<RotateMasterResult> {
  const { store, keyring, currentMasterKey, storeKey } = options;
  const newMasterKey = options.newMasterKey ?? randomBytes(KEY_BYTES);
  const opened = openEveryGeneration(keyring, [currentMasterKey], 'master');
  if (opened.size === 0) {
    newMasterKey.fill(0);
    throw noGenerationOpened('rotate-master');
  }

  try {
    // Phase 1 — every retained generation gets a slot under the new key, and the old slots stay.
    let next = keyring;
    const added: { gen: number; added: string }[] = [];
    for (const [gen, rootDataKey] of opened) {
      const id = nextSlotId(generationFor(next, gen), 'master');
      next = putSlot(
        next,
        gen,
        sealSlot({
          instanceId: keyring.instanceId,
          gen,
          id,
          kind: 'master',
          slotKey: newMasterKey,
          rootDataKey,
        }),
      );
      added.push({ gen, added: id });
    }
    next = withWraps(next, added.length);
    await store.write(next);

    // Phase 2 — the caller persists the new key. Until this returns, the old key is the one that
    // works, and that is deliberate.
    await storeKey(Buffer.from(newMasterKey));

    // Phase 3 — the old slots go. Identified by *which slots opened*, not by id convention, so a
    // keyring that already had several master slots loses exactly the ones this key opened.
    const removed: { gen: number; slotId: string }[] = [];
    for (const [gen] of opened) {
      const generation = generationFor(next, gen);
      const stale = generation.slots.filter(
        (slot) =>
          slot.kind === 'master' &&
          !added.some((entry) => entry.gen === gen && entry.added === slot.id) &&
          openSlot({ instanceId: keyring.instanceId, gen, slot, slotKey: currentMasterKey }) !==
            undefined,
      );
      for (const slot of stale) {
        next = removeKeyringSlot(next, gen, slot.id);
        removed.push({ gen, slotId: slot.id });
      }
    }
    await store.write(next);

    return { keyring: next, slotIds: added, removed };
  } finally {
    newMasterKey.fill(0);
    zeroEach(opened.values());
  }
}

/* ─────────────────────────── rotate-recovery ─────────────────────────── */

export interface RotateRecoveryResult {
  readonly keyring: Keyring;
  /** The printed key, exactly as the ceremony showed it. The caller must not log this. */
  readonly printed: string;
  readonly added: readonly { readonly gen: number; readonly slotId: string }[];
  readonly removed: readonly { readonly gen: number; readonly slotId: string }[];
}

/**
 * Issue a new recovery key and replace the old slot in every retained generation (§3.7.7 row 3).
 *
 * `ceremony` is `08` §3.7.6's step 1–3: print the key, have the user retype groups 3 and 11, and
 * optionally write it to a file. It runs **after** the new slot is in the keyring on disk and
 * before the old slot is removed, for the same reason as `rotateMaster` — a crash during the
 * ceremony leaves both keys working, which is the state a host can simply re-run from.
 *
 * If `ceremony` throws or returns `false` — the user could not retype the groups, so they do not
 * actually have the key — the old slot is **kept** and the new one is removed again. Refusing to
 * complete is the safe direction: §3.7.8 says the recovery key is the only route back, so leaving
 * a host with only an unverified new key is the one outcome worth unwinding for.
 */
export async function rotateRecovery(options: {
  readonly store: KeyringStore;
  readonly keyring: Keyring;
  /** Whatever opens the current slots — master key, old recovery slot key, or passphrase key. */
  readonly currentSlotKey: Uint8Array;
  readonly ceremony: (printed: string) => Promise<boolean>;
  readonly newRecoveryKey?: Buffer;
}): Promise<RotateRecoveryResult> {
  const { store, keyring, currentSlotKey, ceremony } = options;
  const recoveryKey = options.newRecoveryKey ?? newRecoveryKey();
  const opened = openEveryGeneration(keyring, [currentSlotKey]);
  if (opened.size === 0) {
    recoveryKey.fill(0);
    throw noGenerationOpened('rotate-recovery');
  }

  const printed = encodeRecoveryKey(recoveryKey);
  const slotKey = recoverySlotKey(recoveryKey, keyring.instanceId);

  try {
    const before = keyring;
    let next = keyring;
    const added: { gen: number; slotId: string }[] = [];
    for (const [gen, rootDataKey] of opened) {
      const id = nextSlotId(generationFor(next, gen), 'recovery');
      next = putSlot(
        next,
        gen,
        sealSlot({
          instanceId: keyring.instanceId,
          gen,
          id,
          kind: 'recovery',
          slotKey,
          rootDataKey,
        }),
      );
      added.push({ gen, slotId: id });
    }
    next = withWraps(next, added.length);
    await store.write(next);

    let confirmed: boolean;
    try {
      confirmed = await ceremony(printed);
    } catch (cause) {
      await store.write(before);
      throw new KeyringError(
        'KEYRING_NO_MATCHING_SLOT',
        'the recovery-key ceremony did not complete, so the old recovery key is still in use',
        'Nothing was lost — your previous recovery key still works. Run ' +
          `\`${BRAND.cliName} keys rotate-recovery\` again when you are ready to write the new ` +
          'one down.',
        { cause },
      );
    }
    if (!confirmed) {
      await store.write(before);
      return { keyring: before, printed, added: [], removed: [] };
    }

    const removed: { gen: number; slotId: string }[] = [];
    for (const [gen] of opened) {
      const generation = generationFor(next, gen);
      const stale = generation.slots.filter(
        (slot) =>
          slot.kind === 'recovery' && !added.some((e) => e.gen === gen && e.slotId === slot.id),
      );
      for (const slot of stale) {
        next = removeKeyringSlot(next, gen, slot.id);
        removed.push({ gen, slotId: slot.id });
      }
    }
    await store.write(next);

    return { keyring: next, printed, added, removed };
  } finally {
    recoveryKey.fill(0);
    slotKey.fill(0);
    zeroEach(opened.values());
  }
}

/* ─────────────────────────────── recover ─────────────────────────────── */

export interface RecoverResult {
  readonly keyring: Keyring;
  readonly gen: number;
  readonly viaSlotId: string;
  readonly addedSlotId: string;
}

/**
 * `08` §3.7.8 row 1: the master key is lost and the recovery key is held.
 *
 * Unwraps through the recovery slot and establishes a **new** master slot, so the host is back to
 * normal operation rather than depending on the printed key for every boot. No data loss, which is
 * the row's promise.
 *
 * Only the generations the recovery key opens get a master slot, and the current generation must
 * be among them — a recovery that left the current generation unopenable by the new master key
 * would appear to succeed and then fail at the next boot.
 */
export async function recover(options: {
  readonly store: KeyringStore;
  readonly keyring: Keyring;
  readonly typed: string;
  readonly storeKey: (key: Buffer) => Promise<void>;
  readonly newMasterKey?: Buffer;
}): Promise<RecoverResult> {
  const { store, keyring, typed, storeKey } = options;

  // Decoded **once**. An earlier version called `verifyRecovery` and then decoded again to get the
  // bytes, which left an unreachable "it decoded a moment ago but not now" error — and gave the
  // codec two call sites where it needs one.
  const decoded = decodeRecoveryKey(typed);
  if (!decoded.ok) {
    throw new KeyringError('KEYRING_MALFORMED', decoded.error.message, decoded.error.hint);
  }
  const slotKey = recoverySlotKey(decoded.key, keyring.instanceId);
  decoded.key.fill(0);

  const verified = verifyRecoveryWithSlotKey(keyring, slotKey);
  if (!verified.ok) {
    slotKey.fill(0);
    throw new KeyringError(
      'KEYRING_NO_MATCHING_SLOT',
      verified.reason ?? 'the recovery key did not open this keyring',
      verified.hint ?? 'Check the printed key.',
    );
  }

  const newMasterKey = options.newMasterKey ?? randomBytes(KEY_BYTES);
  const opened = openEveryGeneration(keyring, [slotKey], 'recovery');

  try {
    if (!opened.has(keyring.current)) {
      throw new KeyringError(
        'KEYRING_NO_MATCHING_SLOT',
        `the recovery key does not open the current generation (${String(keyring.current)})`,
        'This key belongs to an older generation. Restore `keyring.json.prev`, or restore from a ' +
          'backup whose keyring snapshot matches this key (08 §3.7.11).',
      );
    }

    let next = keyring;
    let addedToCurrent = '';
    for (const [gen, rootDataKey] of opened) {
      const id = nextSlotId(generationFor(next, gen), 'master');
      next = putSlot(
        next,
        gen,
        sealSlot({
          instanceId: keyring.instanceId,
          gen,
          id,
          kind: 'master',
          slotKey: newMasterKey,
          rootDataKey,
        }),
      );
      if (gen === keyring.current) addedToCurrent = id;
    }
    next = withWraps(next, opened.size);
    await store.write(next);
    await storeKey(Buffer.from(newMasterKey));

    return {
      keyring: next,
      gen: verified.gen ?? keyring.current,
      viaSlotId: verified.slotId ?? '',
      addedSlotId: addedToCurrent,
    };
  } finally {
    newMasterKey.fill(0);
    slotKey.fill(0);
    zeroEach(opened.values());
  }
}

/* ────────────────────────── add / remove slots ────────────────────────── */

/**
 * Add the optional passphrase slot (`08` §3.7.3, §3.7.8 row 2).
 *
 * The scrypt parameters are stored **with the slot**, so raising them later still unlocks an old
 * keyring — which is the entire reason `08` §3.7.4 records them rather than reading the current
 * defaults at unlock time.
 */
export async function addPassphrase(options: {
  readonly store: KeyringStore;
  readonly keyring: Keyring;
  readonly currentSlotKey: Uint8Array;
  readonly passphrase: string;
  readonly gen?: number;
  readonly params?: ScryptParams;
}): Promise<{ readonly keyring: Keyring; readonly slotId: string }> {
  const { store, keyring, currentSlotKey, passphrase } = options;
  if (passphrase.length === 0) {
    throw new KeyringError(
      'KEYRING_MALFORMED',
      'a passphrase slot needs a passphrase',
      'Choose a passphrase you will not lose: by 08 §3.7.8 it becomes a third route to your data.',
    );
  }

  const gen = options.gen ?? keyring.current;
  const generation = generationFor(keyring, gen);
  const rootDataKey = openEveryGeneration({ ...keyring, generations: [generation] }, [
    currentSlotKey,
  ]).get(gen);
  if (rootDataKey === undefined) throw noGenerationOpened('add-passphrase');

  try {
    const params = options.params ?? SCRYPT_PARAMS;
    const salt = newScryptSalt();
    const slotKey = await scryptKey(passphrase, salt, params);
    try {
      const id = nextSlotId(generation, 'passphrase');
      const next = withWraps(
        putSlot(
          keyring,
          gen,
          sealSlot({
            instanceId: keyring.instanceId,
            gen,
            id,
            kind: 'passphrase',
            slotKey,
            rootDataKey,
            kdf: { alg: 'scrypt', ...params, salt: salt.toString('base64url') },
          }),
        ),
        1,
      );
      await store.write(next);
      return { keyring: next, slotId: id };
    } finally {
      slotKey.fill(0);
    }
  } finally {
    rootDataKey.fill(0);
  }
}

/**
 * Remove a slot and write the keyring — `comvivo keys remove-slot` (`08` §3.7.7).
 *
 * Named for the command rather than `removeSlot`, because `keyring.ts` already exports a pure
 * `removeSlot` that returns a new keyring without touching the disk. Two different things under
 * one name is a trap: a caller who reached for the pure one and expected a write would lose the
 * change silently at the next boot.
 *
 * The last-recovery-slot guard lives in `keyring.ts` and is enforced per generation, so this is a
 * thin wrapper on purpose: a second copy of that rule is a second place for it to be wrong.
 */
export async function removeKeySlot(options: {
  readonly store: KeyringStore;
  readonly keyring: Keyring;
  readonly gen: number;
  readonly slotId: string;
}): Promise<Keyring> {
  const next = removeKeyringSlot(options.keyring, options.gen, options.slotId);
  await options.store.write(next);
  return next;
}

/* ───────────────────────────── purge-retired ───────────────────────────── */

export interface PurgeRetiredResult {
  readonly keyring: Keyring;
  readonly purged: readonly number[];
}

/**
 * Delete retired generations (`08` §3.7.7, last row).
 *
 * **Irreversible, and the warning is the feature.** A retired generation is what opens blobs that
 * have not been rewrapped and backups that have not been pruned, so purging early makes those
 * unreadable with no error at the time — the failure arrives weeks later, during a restore. The
 * spec's precondition is "after all blobs are rewrapped and old backups pruned or rewrapped", and
 * `blobsRewrapped` is how a caller asserts it: `M1-T27` can answer it from `kekGen`, and until
 * then a host says so explicitly.
 *
 * The current generation is never purged whatever its status, and the static blob-id key's
 * generation is never purged either — without it every blob address becomes uncomputable
 * (`02` D14).
 */
export async function purgeRetired(options: {
  readonly store: KeyringStore;
  readonly keyring: Keyring;
  /** The §3.7.7 precondition, asserted by the caller. */
  readonly blobsRewrapped: boolean;
}): Promise<PurgeRetiredResult> {
  const { store, keyring, blobsRewrapped } = options;
  if (!blobsRewrapped) {
    throw new KeyringError(
      'KEYRING_MALFORMED',
      'retired generations cannot be purged until every blob has been rewrapped',
      'A retired generation is what opens blobs that were written under it and backups that have ' +
        'not been pruned. Finish `rotate-data`, prune or rewrap old backups, then purge — ' +
        'purging early makes that data unreadable with no error until you try to restore it.',
    );
  }

  const keep = keyring.generations.filter(
    (generation) =>
      generation.gen === keyring.current ||
      generation.gen === keyring.static.blobId.gen ||
      generation.status !== 'retired',
  );
  const purged = keyring.generations
    .filter((generation) => !keep.includes(generation))
    .map((generation) => generation.gen);

  if (purged.length === 0) return { keyring, purged: [] };

  const next = { ...keyring, generations: keep };
  await store.write(next);
  return { keyring: next, purged };
}

/* ───────────────────────────── rotate-sessions ───────────────────────────── */

/**
 * Where `sessionEpoch` lives.
 *
 * `08` §3.7.12 keeps it in the **encrypted database settings**, specifically so a file-level edit
 * cannot roll it back and resurrect stolen sessions (§3.7's note at line 348). That makes it the
 * database's property, not the keyring's — and the database arrives in `M1-T8`. Injected rather
 * than deferred, because the operation itself is complete: read, increment, write, and derive the
 * new token MAC key. `M1-T8` supplies the real implementation over the settings table.
 */
export interface SessionEpochStore {
  read(): Promise<number>;
  /** Must be atomic with respect to a crash: a half-written epoch would invalidate nothing. */
  write(epoch: number): Promise<void>;
}

export interface RotateSessionsResult {
  readonly previous: number;
  readonly epoch: number;
}

/**
 * Invalidate every session, magic link, pairing code and CSRF token (`08` §3.7.7 row 5).
 *
 * One increment, and everything derived from the old epoch stops verifying, because the token MAC
 * key is `…/token-mac/epoch=<e>` (`08` §3.7.12). MCP personal access tokens are **not** covered —
 * they are separate by design (`10` §3.7.3), and a caller that implies otherwise would leave a
 * compromised host believing they had revoked more than they had.
 *
 * The keyring is untouched: no slot, no generation and no wrapped key changes, which is why this
 * is milliseconds and online.
 */
export async function rotateSessions(epochs: SessionEpochStore): Promise<RotateSessionsResult> {
  const previous = await epochs.read();
  if (!Number.isInteger(previous) || previous < 0) {
    throw new KeyringError(
      'KEYRING_MALFORMED',
      `the stored session epoch is ${String(previous)}, which is not a usable epoch`,
      'The database settings are damaged. Restore a backup, or run ' +
        `\`${BRAND.cliName} doctor --deep\`.`,
    );
  }
  const epoch = previous + 1;
  await epochs.write(epoch);
  return { previous, epoch };
}

/* ───────────────────────────── rotate-data ───────────────────────────── */

/**
 * The `rotation.json` journal (`08` §3.7.7 step 1, and the crash row at §3.13).
 *
 * `08` §3.13: "the rekey is atomic per SQLite3MC. Resume re-derives which gen the DB uses by trial
 * open (new, then old) and continues blob rewrapping." So the journal does not have to record
 * whether the rekey happened — the database itself answers that, and a journal that claimed
 * otherwise could be wrong. What it records is what the database cannot: which generation is being
 * rotated *to*, and how far the blob rewrap got.
 */
export interface RotationJournal {
  readonly from: number;
  readonly to: number;
  readonly startedAt: string;
  readonly phase: RotationPhase;
  /** Resumable blob-rewrap cursor: rows up to and including this id are done. */
  readonly blobCursor?: string;
}

export const ROTATION_PHASES = [
  'keyring-written',
  'database-rekeyed',
  'blobs-rewrapped',
  'statics-rewrapped',
  'complete',
] as const;
export type RotationPhase = (typeof ROTATION_PHASES)[number];

/** The steps `rotate-data` cannot do itself, because they belong to the database and the blobs. */
export interface RotateDataPorts {
  /** `08` §3.7.7 step 2: pause actors and hold the outbox. */
  enterMaintenance(): Promise<void>;
  leaveMaintenance(): Promise<void>;
  /** Step 3: `PRAGMA rekey` with the new raw key. Atomic per SQLite3MC. */
  rekeyDatabase(newDatabaseKey: Buffer): Promise<void>;
  /** Step 5: rewrap blob DEKs in resumable batches. Returns the cursor it reached. */
  rewrapBlobs(options: {
    readonly generation: number;
    readonly from?: string;
  }): Promise<{ readonly cursor?: string; readonly done: boolean }>;
  /** Step 6's vault half (`08` §3.10). The static keys are this file's job. */
  rewrapVault(generation: number): Promise<void>;
  readJournal(): Promise<RotationJournal | undefined>;
  writeJournal(journal: RotationJournal): Promise<void>;
  clearJournal(): Promise<void>;
}

export interface RotateDataResult {
  readonly keyring: Keyring;
  readonly from: number;
  readonly to: number;
  readonly resumed: boolean;
  /** Slots carried onto the new generation, so every one of these unlock routes still works. */
  readonly carried: readonly SlotRef[];
  /** Slots **not** carried, because no supplied key opened them. Empty unless acknowledged. */
  readonly dropped: readonly SlotRef[];
}

/**
 * Create a new data generation and move everything onto it (`08` §3.7.7 row 2).
 *
 * The long one, and the only operation here that is not milliseconds. The order is the spec's, and
 * each step is journalled before the next begins so a crash resumes rather than restarts:
 *
 *  1. new generation `g+1` with a slot for every key that opens `g`, plus the journal;
 *  2. maintenance mode;
 *  3. `PRAGMA rekey` to the new generation's database key;
 *  4. resume;
 *  5. rewrap blob DEKs in resumable batches;
 *  6. rewrap the static keys and the vault under the new RDK;
 *  7. mark `g` retired.
 *
 * Step 1 wraps the **new** RDK under every slot of the old generation, so every unlock route the
 * host had still works afterwards — a rotation that silently dropped their passphrase slot would
 * be a rotation that reduced their options without saying so.
 *
 * Resuming is the normal path after a crash, not an exception: `08` §3.13 says the database
 * answers which generation it is on, so this trusts `rekeyDatabase` to be idempotent-by-trial and
 * picks up from the journal's phase.
 */
export async function rotateData(options: {
  readonly store: KeyringStore;
  readonly keyring: Keyring;
  /**
   * **Every** key that must keep working: the master key, the recovery key's slot key, and a
   * passphrase's scrypt output if the host has a passphrase slot.
   *
   * A set rather than one key, and that is a finding rather than a preference. `08` §3.7.7's step
   * list for `rotate-data` does not mention the recovery key — but the new generation needs a
   * recovery slot, wrapping the new root data key under a recovery slot requires the recovery
   * key's HKDF output, and that is derived from the printed key the host keeps on paper. With only
   * the master key, the operation cannot produce a generation that satisfies `08` §3.7.8's
   * guarantee, and `keyringSchema` refuses a generation with no recovery slot. So the recovery key
   * is a **required input** to `rotate-data`, which has the useful side effect of proving the host
   * still has it before creating a generation whose last resort it is.
   */
  readonly slotKeys: readonly Uint8Array[];
  readonly ports: RotateDataPorts;
  /**
   * Acknowledge that any slot none of `slotKeys` opens will not exist on the new generation.
   *
   * Refused by default. Dropping a slot silently takes an unlock route away from the host without
   * telling them, and they would find out at the worst moment — so the caller has to say so, and
   * the result names what was dropped.
   */
  readonly dropUnopenedSlots?: boolean;
  readonly now?: () => Date;
  readonly newRootDataKey?: Buffer;
}): Promise<RotateDataResult> {
  const { store, keyring, slotKeys, ports } = options;
  const plan = planRotation(keyring, await ports.readJournal(), options.now);
  const { from, to, startedAt, resumed } = plan;

  const rootDataKey = options.newRootDataKey ?? newRootDataKey();
  let next = keyring;
  let carried: readonly SlotRef[] = [];
  let dropped: readonly SlotRef[] = [];
  let phase = plan.phase;

  try {
    if (!resumed) {
      const created = createNextGeneration({
        keyring,
        from,
        to,
        startedAt,
        slotKeys,
        rootDataKey,
        allowDrops: options.dropUnopenedSlots === true,
      });
      next = created.keyring;
      carried = created.carried;
      dropped = created.dropped;
      await store.write(next);
      await ports.writeJournal({ from, to, startedAt, phase: 'keyring-written' });
      phase = 'keyring-written';
    }

    if (phase === 'keyring-written') {
      await rekeyToNewGeneration({ keyring: next, to, slotKeys, ports });
      await ports.writeJournal({ from, to, startedAt, phase: 'database-rekeyed' });
      phase = 'database-rekeyed';
    }

    if (phase === 'database-rekeyed') {
      await rewrapEveryBlob({ ports, from, to, startedAt, cursor: plan.blobCursor });
      await ports.writeJournal({ from, to, startedAt, phase: 'blobs-rewrapped' });
      phase = 'blobs-rewrapped';
    }

    if (phase === 'blobs-rewrapped') {
      // Step 6. The static blob-id key moves to the new generation — `02` D14 keeps the *key*
      // stable and rewraps it, so blob addresses do not change.
      next = await rewrapStatics({ store, keyring: next, slotKeys, from, to });
      await ports.rewrapVault(to);
      await ports.writeJournal({ from, to, startedAt, phase: 'statics-rewrapped' });
      phase = 'statics-rewrapped';
    }

    if (phase === 'statics-rewrapped') {
      // Step 7. Retired, not deleted: it is what opens old backups until they are pruned.
      next = retireGeneration(next, from);
      await store.write(next);
      await ports.clearJournal();
    }

    return { keyring: next, from, to, resumed, carried, dropped };
  } finally {
    rootDataKey.fill(0);
  }
}

/** A slot named without its key material, for the carried/dropped report. */
interface SlotRef {
  readonly id: string;
  readonly kind: SlotKind;
}

/**
 * Where this run starts: a fresh rotation, or the middle of one that crashed.
 *
 * A journal that names generations the keyring has never heard of means one of the two was
 * restored without the other. Guessing which is right is how a rotation corrupts a keyring that
 * was merely out of date, so this refuses instead.
 */
function planRotation(
  keyring: Keyring,
  journal: RotationJournal | undefined,
  now: (() => Date) | undefined,
): {
  readonly from: number;
  readonly to: number;
  readonly startedAt: string;
  readonly phase: RotationPhase;
  readonly blobCursor: string | undefined;
  readonly resumed: boolean;
} {
  if (journal !== undefined && journal.from !== keyring.current && journal.to !== keyring.current) {
    throw new KeyringError(
      'KEYRING_MALFORMED',
      `a rotation from generation ${String(journal.from)} to ${String(journal.to)} is journalled, ` +
        `but the keyring is on generation ${String(keyring.current)}`,
      'The journal and the keyring disagree, which means one of them was restored without the ' +
        'other. Restore the matching `keyring.json` from a backup before running ' +
        `\`${BRAND.cliName} keys rotate-data\` again.`,
    );
  }

  const clock = now ?? ((): Date => new Date());
  return {
    from: journal?.from ?? keyring.current,
    to: journal?.to ?? keyring.current + 1,
    startedAt: journal?.startedAt ?? clock().toISOString(),
    phase: journal?.phase ?? 'keyring-written',
    blobCursor: journal?.blobCursor,
    resumed: journal !== undefined,
  };
}

/** Step 1: generation `to`, with an equivalent of every slot `slotKeys` can open. */
function createNextGeneration(options: {
  readonly keyring: Keyring;
  readonly from: number;
  readonly to: number;
  readonly startedAt: string;
  readonly slotKeys: readonly Uint8Array[];
  readonly rootDataKey: Uint8Array;
  readonly allowDrops: boolean;
}): {
  readonly keyring: Keyring;
  readonly carried: readonly SlotRef[];
  readonly dropped: readonly SlotRef[];
} {
  const { keyring, from, to, startedAt, slotKeys, rootDataKey, allowDrops } = options;
  const plan = rewrapSlotsForNewGeneration({
    instanceId: keyring.instanceId,
    keyring,
    source: generationFor(keyring, from),
    gen: to,
    slotKeys,
    rootDataKey,
  });

  if (plan.dropped.length > 0 && !allowDrops) {
    throw new KeyringError(
      'KEYRING_NO_MATCHING_SLOT',
      `no supplied key opens ${plan.dropped.map((slot) => `"${slot.id}"`).join(', ')}, so ` +
        `generation ${String(to)} would not have ${plan.dropped.length === 1 ? 'it' : 'them'}`,
      'Supply every key that should keep working — the master key, the recovery key, and the ' +
        'passphrase if you have a passphrase slot. Rotating without one silently removes that ' +
        'way of unlocking your data, and you would find out the next time you needed it.',
    );
  }

  const generation: KeyringGeneration = {
    gen: to,
    status: 'active',
    createdAt: startedAt,
    slots: plan.slots,
  };
  return {
    keyring: withWraps(
      { ...keyring, current: to, generations: [...keyring.generations, generation] },
      plan.slots.length,
    ),
    carried: plan.carried,
    dropped: plan.dropped,
  };
}

/**
 * Steps 2–4: pause, `PRAGMA rekey`, resume.
 *
 * The pause brackets **only** the rekey, which is what makes `rotate-data` "online" in the sense
 * `08` §3.7.7's table means — and `leaveMaintenance` runs even when the rekey throws, because a
 * host left in maintenance mode by a failed rotation has an outage rather than a failed command.
 */
async function rekeyToNewGeneration(options: {
  readonly keyring: Keyring;
  readonly to: number;
  readonly slotKeys: readonly Uint8Array[];
  readonly ports: RotateDataPorts;
}): Promise<void> {
  const { keyring, to, slotKeys, ports } = options;
  await ports.enterMaintenance();
  try {
    // Defensive, and uncovered on purpose: generation `to` was built a moment ago out of slots
    // these very keys opened, so one of them must open it. Kept because it is the last check
    // before a `KeyService` is constructed for the wrong generation, which would rekey the
    // database to a key the keyring does not hold.
    const opener = openerFor(keyring, to, slotKeys);
    if (opener === undefined) throw noGenerationOpened('the database rekey');
    const service = unlock({ keyring, slotKey: Buffer.from(opener), gen: to });
    // `useDatabaseKeyHex` is **synchronous** by design — it zeroes in a `finally`, and handing it
    // an `async` callback is the mistake that deleted the storage spike's database before the
    // child process had opened it. So the key is copied out synchronously and the awaiting happens
    // here, where the copy is ours to zero.
    const databaseKey = service.useDatabaseKeyHex((hex) => Buffer.from(hex, 'hex'));
    try {
      await ports.rekeyDatabase(databaseKey);
    } finally {
      databaseKey.fill(0);
      service.lock();
    }
  } finally {
    await ports.leaveMaintenance();
  }
}

/**
 * Step 5: rewrap every blob DEK, in resumable batches.
 *
 * The cursor goes into the journal after **every** batch, not at the end, so a crash halfway
 * through a million rows resumes rather than starts again — which is the difference between a
 * rotation a host can run on a Pi and one they abandon.
 */
async function rewrapEveryBlob(options: {
  readonly ports: RotateDataPorts;
  readonly from: number;
  readonly to: number;
  readonly startedAt: string;
  readonly cursor: string | undefined;
}): Promise<void> {
  const { ports, from, to, startedAt } = options;
  let cursor = options.cursor;
  for (;;) {
    const batch = await ports.rewrapBlobs(
      cursor === undefined ? { generation: to } : { generation: to, from: cursor },
    );
    cursor = batch.cursor ?? cursor;
    await ports.writeJournal({
      from,
      to,
      startedAt,
      phase: 'database-rekeyed',
      ...(cursor === undefined ? {} : { blobCursor: cursor }),
    });
    if (batch.done) return;
  }
}

/** Step 7: mark the old generation retired. Not deleted — it still opens old backups. */
function retireGeneration(keyring: Keyring, gen: number): Keyring {
  return {
    ...keyring,
    generations: keyring.generations.map((generation) =>
      generation.gen === gen ? { ...generation, status: 'retired' as const } : generation,
    ),
  };
}

/**
 * Wrap the new RDK under every slot the old generation had, preserving each unlock route.
 *
 * A slot can only be carried if one of `slotKeys` opens it, because wrapping the new root data key
 * under that slot needs that slot's key. Each carried slot keeps its **own** id, kind and `kdf`,
 * so a passphrase slot moves across with the scrypt parameters it was created with and the
 * host's existing passphrase still works.
 */
function rewrapSlotsForNewGeneration(options: {
  readonly instanceId: InstanceId;
  readonly keyring: Keyring;
  readonly source: KeyringGeneration;
  readonly gen: number;
  readonly slotKeys: readonly Uint8Array[];
  readonly rootDataKey: Uint8Array;
}): {
  readonly slots: KeyringSlot[];
  readonly carried: readonly SlotRef[];
  readonly dropped: readonly SlotRef[];
} {
  const { instanceId, keyring, source, gen, slotKeys, rootDataKey } = options;
  const slots: KeyringSlot[] = [];
  const carried: SlotRef[] = [];
  const dropped: SlotRef[] = [];

  for (const slot of source.slots) {
    const match = firstOpenWithKey(keyring, source.gen, slot, slotKeys);
    if (match === undefined) {
      dropped.push({ id: slot.id, kind: slot.kind });
      continue;
    }
    match.rootDataKey.fill(0);
    slots.push(
      sealSlot({
        instanceId,
        gen,
        id: slot.id,
        kind: slot.kind,
        slotKey: match.slotKey,
        rootDataKey,
        ...(slot.kdf === undefined ? {} : { kdf: slot.kdf }),
      }),
    );
    carried.push({ id: slot.id, kind: slot.kind });
  }

  if (slots.length === 0) {
    throw noGenerationOpened('rotate-data');
  }
  if (!slots.some((slot) => slot.kind === 'recovery')) {
    // `keyringSchema` would refuse the resulting keyring anyway, but the message it gives is about
    // a malformed file rather than about the missing input — and this is the one place where
    // saying "you need the recovery key as well" is actionable.
    throw new KeyringError(
      'KEYRING_LAST_RECOVERY_SLOT',
      `no supplied key opens a recovery slot, so generation ${String(gen)} would have none`,
      'Every generation keeps a recovery slot, because by 08 §3.7.8 it is the only route back if ' +
        'the master key is lost. Run this again with the printed recovery key as well — which ' +
        'also confirms you still have it.',
    );
  }
  return { slots, carried, dropped };
}

/**
 * Move the static blob-id key onto the new generation, keeping the key itself (`02` D14).
 *
 * The key is *rewrapped*, never regenerated: `02` D14 makes it random and wrapped precisely so
 * blob addresses survive a data rotation. A rotation that minted a new one would give every
 * generation different addresses and make every existing attachment unreachable.
 *
 * Both root data keys come from the **keyring**, not from `rotateData`'s local variable, because
 * this step also runs on a resume — where the new generation already exists on disk and the local
 * `rootDataKey` of the crashed attempt is long gone.
 */
async function rewrapStatics(options: {
  readonly store: KeyringStore;
  readonly keyring: Keyring;
  readonly slotKeys: readonly Uint8Array[];
  readonly from: number;
  readonly to: number;
}): Promise<Keyring> {
  const { store, keyring, slotKeys, from, to } = options;
  if (keyring.static.blobId.gen === to) return keyring;

  const sourceGen = keyring.static.blobId.gen;
  const roots = openEveryGeneration(keyring, slotKeys);
  const sourceRoot = roots.get(sourceGen);
  const targetRoot = roots.get(to);

  try {
    // Both guards are unreachable through `rotateData` — it only reaches this step with keys that
    // built generation `to`, and the static key's own generation is one of the retained ones. They
    // stay because this is the one function that can make every blob address uncomputable, and a
    // silent `undefined` here would do it (`02` D14).
    if (targetRoot === undefined) {
      throw noGenerationOpened('the static key rewrap');
    }
    if (sourceRoot === undefined) {
      // The static keys are wrapped under one generation only, so if that generation is no longer
      // openable the blob-id key is gone — and `02` D14 means every blob address with it. Said
      // plainly rather than silently minting a new key, which would make existing blobs
      // unreachable while reporting success.
      throw new KeyringError(
        'KEYRING_MALFORMED',
        `the static blob-id key is wrapped under generation ${String(sourceGen)}, which this key ` +
          `does not open (rotating ${String(from)} to ${String(to)})`,
        'Blob addresses depend on this key. Restore `keyring.json.prev`, or restore from a ' +
          'backup — its keyring snapshot carries the blob-id key (08 §3.7.11). Do not continue: ' +
          'a new blob-id key would make every existing attachment unreachable.',
      );
    }

    const slot: KeyringSlot = {
      id: STATIC_SLOT_ID,
      kind: 'master',
      wrap: keyring.static.blobId.wrap,
    };
    const blobIdKey = openSlot({
      instanceId: keyring.instanceId,
      gen: sourceGen,
      slot,
      slotKey: sourceRoot,
    });
    if (blobIdKey === undefined) {
      throw new KeyringError(
        'KEYRING_MALFORMED',
        'the static blob-id key does not unwrap under its own generation',
        'This keyring is damaged. Restore `keyring.json.prev`, or restore from a backup.',
      );
    }

    try {
      const next = withWraps(
        {
          ...keyring,
          static: {
            blobId: {
              gen: to,
              wrap: sealSlot({
                instanceId: keyring.instanceId,
                gen: to,
                id: STATIC_SLOT_ID,
                kind: 'master',
                slotKey: targetRoot,
                rootDataKey: blobIdKey,
              }).wrap,
            },
          },
        },
        1,
      );
      await store.write(next);
      return next;
    } finally {
      blobIdKey.fill(0);
    }
  } finally {
    zeroEach(roots.values());
  }
}
