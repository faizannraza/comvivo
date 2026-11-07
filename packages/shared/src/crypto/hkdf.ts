/**
 * HKDF-SHA256 (RFC 5869) — the one way this product turns a root key into purpose keys.
 *
 * `02` §3.6.1's key tree: every key in the product except the root data key and the static blob-id
 * key is `HKDF-SHA256(ikm = RDK_g, salt = instanceId, info = "comvivo/v1/<purpose>", L = 32)`.
 *
 * Why HKDF rather than hashing the root key with a suffix: domain separation that actually holds.
 * `sha256(rdk + "db")` and `sha256(rdk + "dbx")` are unrelated, but `sha256(rdk + "blob")` and
 * `sha256(rdk + "blob-kek")` are *prefix-related* in a way that is hard to reason about, and
 * length-extension makes the naive construction worse still. HKDF's extract-then-expand with the
 * purpose in `info` is the standard answer and Node implements it, so there is nothing to get
 * wrong here except the arguments — which is what the tests check.
 */
import { hkdfSync } from 'node:crypto';
import { keyInfo } from './labels.js';

/** Every key in `02` §3.6.1's tree is 256 bits. */
export const KEY_BYTES = 32;

/**
 * RFC 5869 HKDF-SHA256, with explicit salt and info.
 *
 * The low-level form, for the places `08` §3.7 specifies a different salt or length. Most callers
 * want `derivePurposeKey` below.
 */
export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array | string,
  info: Uint8Array | string,
  length = KEY_BYTES,
): Buffer {
  if (ikm.length === 0) {
    // RFC 5869 permits it; this product never wants it, and an empty IKM is what an uninitialised
    // or already-zeroed key buffer looks like. Failing here turns "every key is the same key"
    // into a crash.
    throw new RangeError('HKDF needs a non-empty input key; an empty IKM is almost always a bug');
  }
  if (!Number.isInteger(length) || length < 1 || length > 255 * 32) {
    throw new RangeError(`HKDF-SHA256 can produce 1–8160 bytes, not ${String(length)}`);
  }
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, length));
}

/**
 * Derive a purpose key from the root data key (`02` §3.6.1).
 *
 * `instanceId` is the salt, so two instances that somehow shared a root key would still derive
 * different purpose keys — which matters for the restore path, where a backup from one instance is
 * opened on another.
 */
export function derivePurposeKey(
  rootDataKey: Uint8Array,
  instanceId: string,
  purpose: string,
): Buffer {
  if (instanceId === '') {
    // The salt. An empty one is valid HKDF and would silently remove the per-instance separation
    // that the restore path depends on.
    throw new RangeError('a purpose key needs a non-empty instanceId as its HKDF salt');
  }
  if (purpose === '') {
    throw new RangeError('a purpose key needs a non-empty purpose');
  }
  return hkdfSha256(rootDataKey, instanceId, keyInfo(purpose), KEY_BYTES);
}
