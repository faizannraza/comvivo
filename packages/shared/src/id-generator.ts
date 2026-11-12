/**
 * `TypeIdGenerator` and `SystemRng` — the real implementations behind the `IdGenerator` and `Rng`
 * ports (`02` §3.1, ADR-019).
 *
 * The clock is injected even here. That is not ceremony: `01` §11.10's cold-start budget and the
 * turn journal's ordering both depend on id timestamps, and a generator that read the wall clock
 * itself could not be driven by `11` §3.1.7's `VirtualClock` — so the only way to test the
 * monotonic counter under a burst would be to generate 4,096 ids in a real millisecond.
 */
import { fillRandom, randomBytes, randomInt } from './crypto/random.js';
import type { Id, IdPrefix } from './ids.js';
import type { Clock } from './ports/clock.js';
import type { IdGenerator } from './ports/ids.js';
import type { Rng } from './ports/rng.js';
import { COUNTER_MAX, UuidV7Source } from './uuidv7.js';

/** Crockford base32, lowercase, as TypeID encodes a UUID's 16 bytes into 26 characters. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * 16 bytes → 26 Crockford base32 characters.
 *
 * Written out rather than taken from `typeid-js` because that library's `TypeID` class is a
 * convenience wrapper this module does not otherwise need, and because the encoding is the one
 * part of an id that must never change: it is in every log line, URL and audit row a host has.
 * `ids.test.ts` cross-checks every id against `typeid-js`'s own parser, so a divergence is a
 * failing test rather than a corpus of unparseable ids.
 *
 * 16 bytes is 128 bits and 26 base32 characters hold 130, so the value is left-padded with two
 * zero bits — which is why a valid suffix always starts with `0`–`7`.
 */
function encodeBase32(bytes: Uint8Array): string {
  let out = '';
  // Accumulate bits big-endian, emitting a character whenever five are available.
  let buffer = 0;
  let bits = 0;
  // Two zero bits of left padding, so the total is a multiple of five.
  bits = 2;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      // `?? ''` only to satisfy `noUncheckedIndexedAccess`: the index is masked to 0–31 and the
      // alphabet has exactly 32 characters, so the lookup cannot miss. An empty string would
      // produce a short suffix, which `parseId` rejects — so even the impossible branch fails
      // loudly rather than writing a malformed id.
      out += ALPHABET[(buffer >>> bits) & 0x1f] ?? '';
    }
    // Keep the accumulator small enough for 32-bit shifts.
    buffer &= (1 << bits) - 1;
  }
  return out;
}

export class TypeIdGenerator implements IdGenerator {
  readonly #clock: Clock;
  readonly #source: UuidV7Source;

  constructor(clock: Clock) {
    this.#clock = clock;
    this.#source = new UuidV7Source(
      // A CSPRNG, not the `Rng` port. An id is not a secret — it is in URLs and logs — but it is
      // used as a dedupe key and an idempotency key, and a predictable id would let one member
      // guess another's (`08` §3.7.12 keeps the actual secrets elsewhere).
      //
      // Routed through `crypto/random.ts` rather than importing `node:crypto` here, because
      // `08` PSC-8 restricts that import to `shared/crypto` and `storage/crypto` — enforced by
      // `crypto-only-in-shared-crypto-and-storage-crypto`, which refused the first version of
      // this file.
      (target) => {
        fillRandom(target);
      },
      () => randomInt(COUNTER_MAX + 1),
    );
  }

  next<P extends IdPrefix>(prefix: P): Id<P> {
    const bytes = this.#source.next(this.#clock.now().epochMilliseconds);
    return `${prefix}_${encodeBase32(bytes)}` as Id<P>;
  }
}

/**
 * The non-cryptographic `Rng` port, backed by `node:crypto`.
 *
 * `ports/rng.ts` is explicit that this port is *not* for cryptography, and that remains true of
 * this implementation's **contract** even though it happens to use a CSPRNG: `fork` returns an
 * independent generator with no seed relationship, so nothing here is reproducible and nothing
 * should depend on it being so. Production uses this; tests use `SeededRng`.
 */
export class SystemRng implements Rng {
  next(): number {
    // 53 bits of mantissa from 7 bytes, so the float is uniform over [0, 1) rather than carrying
    // the rounding bias of `randomInt(2**32) / 2**32`.
    const bytes = randomBytes(7);
    let value = 0;
    for (const byte of bytes) value = value * 256 + byte;
    return value / 2 ** 56;
  }

  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive < 1) {
      throw new RangeError(`nextInt needs a positive integer bound, got ${String(maxExclusive)}`);
    }
    // `randomInt` rejection-samples, so there is no modulo bias.
    return randomInt(maxExclusive);
  }

  fork(_label: string): Rng {
    // Deliberately ignores the label. A `SystemRng` has no seed to derive from, and pretending
    // otherwise would make a caller think their draws were reproducible when they are not.
    return new SystemRng();
  }
}

export { encodeBase32 as encodeTypeIdSuffix };
