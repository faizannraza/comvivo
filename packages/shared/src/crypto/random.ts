/**
 * The only source of randomness for anything that has to be unpredictable (`08` §3.7.1).
 *
 * `08` PSC-8 restricts `node:crypto` to this directory and `storage/src/crypto`, enforced by
 * dependency-cruiser. That is not tidiness: it means a reviewer looking for "where does this
 * product get its keys, nonces and tokens from" has one directory to read, and a pull request that
 * reaches for `node:crypto` anywhere else fails the build with a reason.
 *
 * The distinction from `ports/rng.ts` matters and is easy to get wrong. `Rng` is a **seedable
 * PRNG** for things that must be *reproducible* — fair chore assignment, tie-breaking, the
 * proactivity sampler — because `00` §3.6 promises every action has a "why" trail and "chance" is
 * not an answer. This module is for things that must be *unguessable*. Using one where the other
 * belongs is a bug in both directions: a seeded PRNG for a session token is a vulnerability, and a
 * CSPRNG for a fairness decision makes it unreplayable.
 */
import {
  randomBytes as nodeRandomBytes,
  randomInt as nodeRandomInt,
  randomFillSync,
} from 'node:crypto';

/**
 * Crockford base32, **uppercase** — typed codes are shown on a console and read aloud.
 *
 * Excludes `I`, `L`, `O` and `U`: the first three because people confuse them with `1` and `0`,
 * and `U` because Crockford drops it to avoid accidental obscenities in generated codes.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * `size` cryptographically random bytes.
 *
 * A thin pass-through, deliberately: the value of this module is that it is the one import site,
 * not that it adds behaviour.
 */
export function randomBytes(size: number): Buffer {
  return nodeRandomBytes(size);
}

/** Fill an existing buffer, for callers that own the allocation (the id generator, secretstream). */
export function fillRandom(target: Uint8Array): void {
  randomFillSync(target);
}

/**
 * A uniform integer in `[0, maxExclusive)`.
 *
 * `node:crypto`'s own rejection sampling, so there is no modulo bias. Worth routing through here
 * rather than letting callers reach for `% n`: a biased draw in a claim code shortens the search
 * space, and the bias is invisible in any test that only checks the range.
 */
export function randomInt(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive < 1) {
    throw new RangeError(`randomInt needs a positive integer bound, got ${String(maxExclusive)}`);
  }
  return nodeRandomInt(maxExclusive);
}

/**
 * A base64url token with `bytes` bytes of entropy.
 *
 * `08` §3.7.12's secrets are all of this shape: `vs1_<b64u 32B>`, `vmcp_<…>_<43 b64url>`,
 * `vctl_<b64u 32B>`. 32 bytes is 256 bits and encodes to 43 characters with no padding.
 *
 * base64url rather than hex because these appear in URLs and cookies, and rather than base64
 * because `+` and `/` need escaping in both.
 */
export function randomToken(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 16) {
    // 128 bits is the floor `08` §3.7.12 uses for anything long-lived. A caller asking for less
    // has almost certainly confused bytes with bits.
    throw new RangeError(
      `a token needs at least 16 bytes of entropy, got ${String(bytes)}. ` +
        'The argument is BYTES, not bits.',
    );
  }
  return randomBytes(bytes).toString('base64url');
}

/**
 * A human-typable code in Crockford base32, uppercase, in groups of four.
 *
 * `08` §3.7.12's typed codes: the pairing code (`XXXX-XXXX`, 40 bits), the host claim code
 * (`VLG-XXXX-XXXX`) and the link code. These are read off a screen and typed into a chat, so the
 * alphabet excludes `I`, `L`, `O` and `U` — the characters people confuse with `1`, `0` and each
 * other.
 *
 * Their safety does **not** come from entropy: 40 bits is guessable. It comes from a short TTL,
 * single use and a hard attempt limit, all of which `08` §3.7.12 specifies and `06` §3.20.1
 * enforces. This function is the easy half.
 */
export function randomTypedCode(groups = 2, groupSize = 4): string {
  if (!Number.isInteger(groups) || groups < 1 || !Number.isInteger(groupSize) || groupSize < 1) {
    throw new RangeError('a typed code needs at least one group of at least one character');
  }
  const parts: string[] = [];
  for (let group = 0; group < groups; group += 1) {
    let part = '';
    for (let i = 0; i < groupSize; i += 1) {
      // One rejection-sampled draw per character. Taking a byte and reducing it modulo 32 would be
      // unbiased only because 32 divides 256 — true here, and a trap the moment somebody changes
      // the alphabet. Drawing against the alphabet's real length cannot acquire that bug.
      //
      // `charAt` rather than `[index]`: the latter is `string | undefined` under
      // `noUncheckedIndexedAccess`, and the `?? ''` it needs is an unreachable branch — the index
      // is drawn from the alphabet's own length. A fallback that cannot run is worse than none: it
      // reads as a handled case and shows up as missed coverage forever.
      part += CROCKFORD.charAt(randomInt(CROCKFORD.length));
    }
    parts.push(part);
  }
  return parts.join('-');
}

/** The Crockford alphabet, exported so the code parser and this generator cannot disagree. */
export const CROCKFORD_ALPHABET = CROCKFORD;
