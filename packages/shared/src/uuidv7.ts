/**
 * UUIDv7 bytes, RFC 9562 §5.7, with the monotonic counter of §6.2 method 1.
 *
 * One implementation, used by both the system generator (`id-generator.ts`) and the deterministic
 * one (`testing/deterministic-ids.ts`). They were separate until `M1-T3`, and that was a real
 * hazard rather than untidiness: ids sort by creation order only because of the counter in bytes
 * 6–7, the turn journal and the outbox read that order **as** sequence (`01` §6.2, invariants I6
 * and I7), and two copies of the layout could drift so that test ids sorted and production ids
 * did not — or the reverse, which is worse, because the suite would be green.
 *
 * Layout:
 *
 *   bytes 0–5   48-bit big-endian Unix millisecond timestamp
 *   byte  6     version (0b0111) in the high nibble, then the top 4 bits of the counter
 *   byte  7     the low 8 bits of the counter
 *   byte  8     variant (0b10) in the top 2 bits, then 6 random bits
 *   bytes 9–15  56 random bits
 */

/** The 12 bits UUIDv7 reserves for `rand_a`, used here as the within-millisecond counter. */
export const COUNTER_BITS = 12;
export const COUNTER_MAX = (1 << COUNTER_BITS) - 1;

/** Fills `target` with cryptographic or seeded random bytes, depending on the caller. */
export type RandomBytes = (target: Uint8Array) => void;

/** Picks the counter's starting value for a new millisecond, in `[0, COUNTER_MAX]`. */
export type CounterSeed = () => number;

/**
 * Monotonic UUIDv7 generation, with the time and the randomness supplied.
 *
 * Stateful on purpose: the counter has to remember the last millisecond it saw. One instance per
 * generator.
 */
export class UuidV7Source {
  readonly #randomBytes: RandomBytes;
  readonly #counterSeed: CounterSeed;
  #lastMs = -1;
  #counter = 0;

  constructor(randomBytes: RandomBytes, counterSeed: CounterSeed) {
    this.#randomBytes = randomBytes;
    this.#counterSeed = counterSeed;
  }

  /** The next 16 bytes for the given millisecond. Monotonic for a non-decreasing `ms`. */
  next(ms: number): Uint8Array {
    if (!Number.isInteger(ms) || ms < 0) {
      throw new RangeError(`a UUIDv7 timestamp must be a non-negative integer, got ${String(ms)}`);
    }
    if (ms > MAX_MS) {
      // 2^48 ms is the year 10889. Worth the check anyway: a caller passing microseconds or
      // nanoseconds by mistake lands here, and the alternative is a silently truncated timestamp
      // that makes every id sort wrongly.
      throw new RangeError(
        `a UUIDv7 timestamp is 48 bits (max ${String(MAX_MS)}), got ${String(ms)}. ` +
          'Milliseconds, not microseconds.',
      );
    }

    if (ms === this.#lastMs) {
      this.#counter += 1;
      if (this.#counter > COUNTER_MAX) {
        // More than 4,096 ids in one millisecond. For the system clock this is a genuine burst and
        // the honest answer is to fail rather than mint out-of-order ids; for a `VirtualClock` it
        // means the clock is not being advanced between batches. Either way, silence here would
        // break the ordering the turn journal and the outbox depend on.
        throw new RangeError(
          `more than ${String(COUNTER_MAX + 1)} ids generated in millisecond ${String(ms)}. ` +
            'Ids would stop sorting by creation order, which the turn journal and outbox rely on ' +
            '(invariants I6, I7). Advance the clock between batches.',
        );
      }
    } else if (ms < this.#lastMs) {
      // The clock went backwards: NTP stepped, or a `VirtualClock` was rewound. Keep counting
      // inside the newer millisecond rather than emitting an id that sorts before an existing one.
      this.#counter += 1;
      if (this.#counter > COUNTER_MAX) {
        throw new RangeError(
          `the clock moved backwards from ${String(this.#lastMs)} to ${String(ms)} and the ` +
            'within-millisecond counter is exhausted, so the next id would sort before an ' +
            'existing one.',
        );
      }
      return this.#assemble(this.#lastMs);
    } else {
      this.#lastMs = ms;
      // A fresh random starting point per millisecond, so ids are not trivially guessable while
      // staying reproducible for a given seed. Halved so a burst has room to count upward.
      this.#counter = this.#counterSeed() >>> 1;
    }

    return this.#assemble(ms);
  }

  #assemble(ms: number): Uint8Array {
    const bytes = new Uint8Array(16);

    // 48-bit timestamp, big-endian. Division rather than `>>>`, which is 32-bit.
    bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
    bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
    bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
    bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
    bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
    bytes[5] = ms & 0xff;

    bytes[6] = 0x70 | ((this.#counter >>> 8) & 0x0f);
    bytes[7] = this.#counter & 0xff;

    const random = new Uint8Array(8);
    this.#randomBytes(random);
    bytes[8] = 0x80 | ((random[0] ?? 0) & 0x3f);
    for (let i = 1; i < 8; i += 1) bytes[8 + i] = random[i] ?? 0;

    return bytes;
  }
}

/** The largest timestamp 48 bits can hold. */
export const MAX_MS = 2 ** 48 - 1;

/** `true` when `bytes` has the version and variant bits RFC 9562 requires of a v7 UUID. */
export function isUuidV7(bytes: Uint8Array): boolean {
  if (bytes.length !== 16) return false;
  return ((bytes[6] ?? 0) & 0xf0) === 0x70 && ((bytes[8] ?? 0) & 0xc0) === 0x80;
}

/** The 48-bit timestamp out of a v7 UUID, for tests and for `comvivo doctor`. */
export function timestampOf(bytes: Uint8Array): number {
  let ms = 0;
  for (let i = 0; i < 6; i += 1) ms = ms * 256 + (bytes[i] ?? 0);
  return ms;
}
