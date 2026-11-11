/**
 * Cryptographic domain separators — **frozen wire constants**.
 *
 * These strings go into HKDF `info` parameters and AEAD additional data. Every key this product
 * derives and every blob and backup it writes depends on them being byte-identical forever: change
 * one and every existing host's database becomes unopenable, every blob undecryptable, every backup
 * unrestorable. There is no migration for a changed domain separator, only data loss.
 *
 * So, three rules, each of which has a test:
 *
 *  1. **They are literals, never derived from `BRAND`.** `02` §3.6.1 writes them as
 *     `"village/v1/" + purpose`, from when the product's codename was Village. Wiring them to
 *     `BRAND` would be the obvious tidy-up and would turn the next rename into silent, total data
 *     loss for every existing install. The brand guard is told to skip this file for exactly that
 *     reason, which is the narrowest possible exemption and the only one that is a *correctness*
 *     requirement rather than a convenience.
 *  2. **They carry a version.** `v1` is not decoration: it is the escape hatch that makes a future
 *     change possible at all, by deriving a second key alongside the first.
 *  3. **A rename must not touch them.** If the product is renamed again, these stay as they are,
 *     and the stale-looking name is the correct value. A future reader tempted to "fix" it should
 *     read this comment and the test below it.
 */

/**
 * The product identifier inside a domain separator.
 *
 * Deliberately a literal. See rule 1 above — this is the one string in the codebase that must
 * survive a rename **unchanged**.
 */
const DOMAIN = 'comvivo';

/** The current version of the key tree and the wire formats. */
const VERSION = 'v1';

/**
 * HKDF `info` for a purpose-derived key (`02` §3.6.1).
 *
 * `derive(purpose) = HKDF-SHA256(ikm=RDK_g, salt=instanceId, info=keyInfo(purpose), L=32)`.
 */
export function keyInfo(purpose: string): string {
  return `${DOMAIN}/${VERSION}/${purpose}`;
}

/** Every purpose `02` §3.6.1 derives, so a typo is a compile error rather than a wrong key. */
export const KEY_PURPOSE = {
  /** The SQLCipher raw key. */
  db: 'db',
  /** The blob key-encryption key for generation `g`; `blobs.kek_version` stores `g`. */
  blobKek: 'blob-kek',
  /** Wraps the per-backup DEK in the `VBK1` envelope. */
  backupKek: 'backup-kek',
  /** The secrets vault (`08` §3.7.2). */
  vault: 'vault',
  /** The recovery-key slot's own derivation (`08` §3.7.4). */
  rkSlot: 'rk-slot',
  /** Column encryption, used only in the `02` §3.6.5 plaintext fallback. */
  field: 'field',
  /** Blind-token FTS, used only in the `02` §3.6.5 plaintext fallback. */
  ftsToken: 'fts-token',
} as const satisfies Record<string, string>;

export type KeyPurpose = (typeof KEY_PURPOSE)[keyof typeof KEY_PURPOSE];

/**
 * The token MAC key for epoch `e` (`08` §3.7.12).
 *
 * The epoch is in the label rather than the salt so that bumping it invalidates every session and
 * CSRF token at once, which is what "log everybody out" has to mean.
 */
export function tokenMacPurpose(epoch: number): string {
  if (!Number.isInteger(epoch) || epoch < 0) {
    throw new RangeError(`a token-MAC epoch must be a non-negative integer, got ${String(epoch)}`);
  }
  return `token-mac/epoch=${String(epoch)}`;
}

/** The `keyring.json` format identifier (`08` §3.7.4). Also the keyring AAD's prefix. */
export const KEYRING_FORMAT = `${DOMAIN}-keyring/1`;

/**
 * AEAD additional data, which binds a ciphertext to its context.
 *
 * Without AAD, a wrapped key lifted from one row and pasted into another would decrypt fine — so
 * an attacker with write access to the database could swap a blob's DEK for another blob's and
 * read it. These strings are what make that fail.
 */
export const AAD = {
  /**
   * A blob body's first chunk (`08` §3.7.10).
   *
   * **Not used by the blob store**, and `M1-T25` found out why: the address depends on the
   * plaintext hash, which a streaming writer only knows at EOF, while a secretstream's additional
   * data must be supplied with the first push. `02` §3.11's write path therefore binds the 8-byte
   * file prefix in chunk 0 and the address in the **wrapped DEK's** AAD (`blobDek` below), which
   * it can compute. Kept because these separators are frozen (see the header) and because a
   * future blob whose address is known before its content — a pre-assigned upload slot — would
   * want exactly this.
   */
  blobBody: (blobAddr: string, mime: string): string =>
    `${DOMAIN}/blob/${VERSION}|${blobAddr}|${mime}`,

  /** A blob's wrapped DEK, bound to the address and the KEK generation (`08` §3.7.10). */
  blobDek: (blobAddr: string, generation: number): string =>
    `${DOMAIN}/blob-dek/${VERSION}|${blobAddr}|gen=${String(generation)}`,

  /**
   * A keyring slot (`08` §3.7.4).
   *
   * Binds **four** things: the instance, the generation, the slot id and the slot kind — so a slot
   * cannot be swapped between generations *or between instances*, and a master slot cannot be
   * passed off as a recovery slot.
   *
   * The first version of this function bound only the kind and the generation, which was weaker
   * than `08` §3.7.4 specifies in exactly the way that matters: without the instance id, a keyring
   * slot copied from one host's `keyring.json` into another's would have unwrapped.
   */
  keyringSlot: (instanceId: string, generation: number, slotId: string, kind: string): string =>
    `${KEYRING_FORMAT}|${instanceId}|gen=${String(generation)}|slot=${slotId}|kind=${kind}`,

  /** A vault entry, bound to its key path (`08` §3.7.2). */
  vaultEntry: (path: string): string => `${DOMAIN}/vault/${VERSION}|${path}`,
} as const;

/** The file magics (`08` §3.7.10, §3.7.11). Four bytes each, and equally frozen. */
export const MAGIC = {
  /** A blob body file. */
  blob: 'VBL1',
  /** A backup archive. */
  backup: 'VBK1',
} as const;

/**
 * Exported for the test that asserts these are literals.
 *
 * A test can compare `keyInfo('db')` to a literal and pass whether or not the implementation reads
 * `BRAND`; comparing these to `BRAND.slug` and requiring them to **differ** is what actually
 * catches the tidy-up this file exists to prevent — once the product is renamed. Until then the
 * test asserts the exact strings, which is the same protection by a different route.
 */
export const DOMAIN_SEPARATOR_PARTS = Object.freeze({ domain: DOMAIN, version: VERSION });
