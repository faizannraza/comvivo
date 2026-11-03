/**
 * `DeterministicIdGenerator` — reproducible TypeIDs.
 *
 * `11` §3.1.7: valid TypeIDs, with the timestamp taken from the injected `Clock` and the random
 * bits from the injected `Rng`, monotonic within a millisecond.
 *
 * Why it has to be deterministic: golden transcripts (`11` §3.5) compare whole conversations, and
 * an id appears in a turn trace, an audit event, an outbox row and a permalink. A random id would
 * make every transcript differ on every run, so the goldens would have to normalise ids away — and
 * then they would stop catching the bug where the *wrong* id is used, which for this product is
 * invariant **I4** failing.
 *
 * Monotonicity is not cosmetic either. The turn journal and the outbox rely on id order being
 * creation order (`01` §6.2, invariants I6 and I7), so two ids minted in the same millisecond must
 * still sort correctly.
 */
import { fromUUIDBytes } from 'typeid-js';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator, IdPrefix, TypedId } from '../ports/ids.js';
import type { SeededRng } from './seeded-rng.js';

/** The 12 bits UUIDv7 reserves for `rand_a`, used here as the within-millisecond counter. */
const COUNTER_BITS = 12;
const COUNTER_MAX = (1 << COUNTER_BITS) - 1;

export class DeterministicIdGenerator implements IdGenerator {
  readonly #clock: Clock;
  readonly #rng: SeededRng;
  #lastMs = -1;
  #counter = 0;

  constructor(clock: Clock, rng: SeededRng) {
    this.#clock = clock;
    this.#rng = rng;
  }

  generate<B extends string>(prefix: IdPrefix, _brand?: B): TypedId<B> {
    const bytes = this.#uuidV7Bytes();
    return fromUUIDBytes(prefix, bytes).toString() as TypedId<B>;
  }

  /**
   * UUIDv7, laid out per RFC 9562 §5.7 with the "replace leftmost random bits with an increased
   * counter" monotonicity method:
   *
   *   bytes 0–5   48-bit big-endian Unix millisecond timestamp
   *   byte  6     version (0b0111) in the high nibble, then the top 4 bits of the counter
   *   byte  7     the low 8 bits of the counter
   *   byte  8     variant (0b10) in the top 2 bits, then 6 random bits
   *   bytes 9–15  56 random bits
   */
  #uuidV7Bytes(): Uint8Array {
    const ms = this.#clock.now().epochMilliseconds;

    if (ms === this.#lastMs) {
      this.#counter += 1;
      if (this.#counter > COUNTER_MAX) {
        // 4096 ids inside one virtual millisecond means the clock is not being advanced. Failing
        // loudly is far better than silently minting out-of-order ids, which would break the
        // ordering the turn journal and outbox depend on.
        throw new RangeError(
          `more than ${String(COUNTER_MAX + 1)} ids generated in virtual millisecond ${String(ms)}. ` +
            'Advance the VirtualClock between batches, or the ids stop being monotonic.',
        );
      }
    } else {
      this.#lastMs = ms;
      // A fresh random starting point per millisecond, so ids are not trivially guessable while
      // still being reproducible for a given seed.
      this.#counter = this.#rng.nextInt(COUNTER_MAX + 1) >>> 1;
    }

    const bytes = new Uint8Array(16);
    // 48-bit timestamp, big-endian. `ms` is well under 2^48 until the year 10889.
    bytes[0] = (ms / 2 ** 40) & 0xff;
    bytes[1] = (ms / 2 ** 32) & 0xff;
    bytes[2] = (ms / 2 ** 24) & 0xff;
    bytes[3] = (ms / 2 ** 16) & 0xff;
    bytes[4] = (ms / 2 ** 8) & 0xff;
    bytes[5] = ms & 0xff;

    bytes[6] = 0x70 | ((this.#counter >>> 8) & 0x0f);
    bytes[7] = this.#counter & 0xff;

    const randomA = this.#rng.nextUint32();
    bytes[8] = 0x80 | ((randomA >>> 24) & 0x3f);
    bytes[9] = (randomA >>> 16) & 0xff;
    bytes[10] = (randomA >>> 8) & 0xff;
    bytes[11] = randomA & 0xff;

    const randomB = this.#rng.nextUint32();
    bytes[12] = (randomB >>> 24) & 0xff;
    bytes[13] = (randomB >>> 16) & 0xff;
    bytes[14] = (randomB >>> 8) & 0xff;
    bytes[15] = randomB & 0xff;

    return bytes;
  }
}
