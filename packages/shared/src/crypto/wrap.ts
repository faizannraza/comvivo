/**
 * AES-256-GCM key wrapping (`08` §3.7.1).
 *
 * Used wherever one key encrypts another: keyring slots wrapping the root data key, blob DEKs
 * under the blob KEK, the per-backup DEK in a `VBK1` envelope, and vault entries.
 *
 * Three decisions, each of which is load-bearing:
 *
 *  - **A 96-bit random nonce**, not a counter. A counter would be better — it cannot repeat — but
 *    it needs durable state, and the one place that state could live is the database this key is
 *    being used to open. `08` §3.7.1 takes the random-nonce bound instead and keeps wraps per KEK
 *    far below 2^32: the keyring tracks `wrapCount`, blobs are counted per `kekGen`, and
 *    `comvivo doctor` advises `rotate-data` at 2^30.
 *  - **AAD is mandatory.** Without it, a wrapped key lifted out of one row and pasted into another
 *    decrypts perfectly — so somebody with write access to the database could swap one blob's DEK
 *    for another's and read it. The AAD strings are in `labels.ts`, and this function will not let
 *    a caller omit them.
 *  - **One sealed format.** `nonce ‖ ciphertext ‖ tag` in one buffer, because the three-field
 *    version invites a row where the tag was written and the nonce was not, and the failure then
 *    looks like corruption rather than a bug.
 */
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { fillRandom } from './random.js';

/** AES-256-GCM: a 256-bit key. */
export const WRAP_KEY_BYTES = 32;
/** `08` §3.7.1's 96-bit nonce, which is also GCM's efficient size. */
export const NONCE_BYTES = 12;
/** GCM's full 128-bit tag. Truncating it would weaken authentication for 4 saved bytes. */
export const TAG_BYTES = 16;

/** Why an unwrap failed. Never says *which*, to a caller that might be a remote one. */
export class UnwrapFailed extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UnwrapFailed';
  }
}

function assertKey(key: Uint8Array): void {
  if (key.length !== WRAP_KEY_BYTES) {
    throw new RangeError(
      `AES-256-GCM needs a ${String(WRAP_KEY_BYTES)}-byte key, got ${String(key.length)}`,
    );
  }
}

function assertAad(aad: string): void {
  if (aad === '') {
    // Not a defensive nicety. An empty AAD is what makes a wrapped key portable between rows, and
    // a portable wrapped key is a database-write-to-blob-read escalation.
    throw new RangeError(
      'wrapping needs additional data to bind the ciphertext to its context (see labels.ts). ' +
        'Without it a wrapped key lifted into another row would decrypt.',
    );
  }
}

/**
 * Wrap `plaintext` under `key`, bound to `aad`.
 *
 * Returns `nonce ‖ ciphertext ‖ tag`.
 */
export function wrap(key: Uint8Array, plaintext: Uint8Array, aad: string): Buffer {
  assertKey(key);
  assertAad(aad);

  const nonce = Buffer.allocUnsafe(NONCE_BYTES);
  fillRandom(nonce);

  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
}

/**
 * Unwrap what `wrap` produced, under the same key and the same `aad`.
 *
 * Throws `UnwrapFailed` for every reason — wrong key, wrong AAD, tampered ciphertext, truncated
 * buffer — and deliberately does not say which. A caller that could distinguish "wrong key" from
 * "wrong AAD" could use the difference as an oracle, and no legitimate caller needs to know.
 */
export function unwrap(key: Uint8Array, sealed: Uint8Array, aad: string): Buffer {
  assertKey(key);
  assertAad(aad);

  if (sealed.length < NONCE_BYTES + TAG_BYTES) {
    // Shorter than a nonce plus a tag, so there is nothing to attempt. Still `UnwrapFailed` rather
    // than `RangeError`: to the caller it is the same event, and a different exception type here
    // would be a length oracle.
    throw new UnwrapFailed('the sealed value is too short to be an AES-256-GCM wrap');
  }

  const nonce = sealed.subarray(0, NONCE_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const ciphertext = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES);

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (cause) {
    throw new UnwrapFailed('could not unwrap: wrong key, wrong context, or tampered data', {
      cause,
    });
  }
}

/** The length of a sealed value, so a schema or a parser can check it without unwrapping. */
export function sealedLength(plaintextBytes: number): number {
  return NONCE_BYTES + plaintextBytes + TAG_BYTES;
}
