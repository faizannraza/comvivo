/**
 * Constant-time comparison (`08` §3.7.13).
 *
 * `secureEqual(a, b) = timingSafeEqual(sha256(a), sha256(b))`.
 *
 * The SHA-256 is not belt-and-braces — it is what makes the comparison possible at all.
 * `crypto.timingSafeEqual` **throws** when its arguments differ in length, and that throw is
 * itself a timing side channel which leaks the length of the secret. Hashing first gives two
 * 32-byte inputs by construction, so the comparison is total and the length of the candidate
 * leaks nothing.
 *
 * `08` §3.7.13 also lint-bans `===` and `!==` on identifiers matching `/token|secret|code|hash|mac/i`
 * outside this directory, so the easy wrong thing is a build failure with a pointer here. That
 * rule arrives with `M1-T29`.
 */
import { timingSafeEqual } from 'node:crypto';
import { sha256 } from './hmac.js';

/**
 * `true` when `a` and `b` are the same bytes, in time independent of where they first differ.
 *
 * Accepts strings for the common case — comparing a presented token to a stored one — and encodes
 * as UTF-8. Two strings that are canonically equivalent but differently normalised are **not**
 * equal here, which is correct: a token is bytes, not text.
 */
export function secureEqual(a: Uint8Array | string, b: Uint8Array | string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

/**
 * `true` when a presented secret matches a stored SHA-256 digest.
 *
 * The shape `08` §3.7.12 actually stores: tokens are kept as digests, never in the clear, so the
 * comparison is "hash the candidate, compare to the row". Separate from `secureEqual` because
 * passing an already-hashed value to that function would hash it twice — which works, since both
 * sides get the same treatment, but means the stored digest and the comparison disagree about what
 * they are, and the next person to write a query notices too late.
 */
export function secureEqualDigest(
  presented: Uint8Array | string,
  storedDigest: Uint8Array,
): boolean {
  if (storedDigest.length !== 32) {
    throw new RangeError(
      `a stored SHA-256 digest is 32 bytes, got ${String(storedDigest.length)}. ` +
        'Comparing against something else is almost certainly a column mix-up.',
    );
  }
  return timingSafeEqual(sha256(presented), Buffer.from(storedDigest));
}
