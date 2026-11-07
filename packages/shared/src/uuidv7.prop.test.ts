/**
 * UUIDv7 properties (RFC 9562 §5.7 and §6.2 method 1).
 *
 * The property that matters is **sortability**: ids must sort lexicographically in creation order,
 * because the turn journal and the outbox read id order *as* sequence (`01` §6.2, invariants I6
 * and I7). A unit test with two ids cannot establish that; a property test over thousands of
 * timestamps and burst sizes can.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { encodeTypeIdSuffix } from './id-generator.js';
import { fcConfig } from './testing/fc-config.js';
import { COUNTER_MAX, isUuidV7, MAX_MS, timestampOf, UuidV7Source } from './uuidv7.js';

/** A deterministic byte source, so a counterexample is reproducible. */
function sourceWithSeed(seed: number): UuidV7Source {
  let state = seed | 1;
  const nextByte = (): number => {
    state = (state * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
    return (state >>> 16) & 0xff;
  };
  return new UuidV7Source(
    (target) => {
      for (let i = 0; i < target.length; i += 1) target[i] = nextByte();
    },
    () => nextByte() & COUNTER_MAX,
  );
}

describe('a UUIDv7 is well formed', { tags: ['prop'] }, () => {
  it('always has the version and variant bits', () => {
    fc.assert(
      fc.property(fc.nat({ max: 2 ** 44 }), fc.nat({ max: 10_000 }), (ms, seed) => {
        const bytes = sourceWithSeed(seed).next(ms);
        expect(bytes).toHaveLength(16);
        expect(isUuidV7(bytes)).toBe(true);
      }),
      fcConfig(),
    );
  });

  it('round-trips the timestamp it was given', () => {
    fc.assert(
      fc.property(fc.nat({ max: 2 ** 44 }), (ms) => {
        expect(timestampOf(sourceWithSeed(1).next(ms))).toBe(ms);
      }),
      fcConfig(),
    );
  });
});

describe('ids sort by creation order', { tags: ['prop'] }, () => {
  it('sorts lexicographically for a non-decreasing clock', () => {
    // The property the turn journal and the outbox read as semantics. Note the comparison is on
    // the **encoded string**, not on the bytes: that is what a SQL `ORDER BY id` does.
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: 5 }), { minLength: 2, maxLength: 60 }),
        fc.nat({ max: 10_000 }),
        (deltas, seed) => {
          const source = sourceWithSeed(seed);
          let ms = 1_700_000_000_000;
          const ids: string[] = [];
          for (const delta of deltas) {
            ms += delta;
            ids.push(encodeTypeIdSuffix(source.next(ms)));
          }
          expect(ids).toEqual([...ids].sort());
        },
      ),
      fcConfig(),
    );
  });

  it('keeps sorting through a burst inside one millisecond', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 200 }), fc.nat({ max: 10_000 }), (count, seed) => {
        const source = sourceWithSeed(seed);
        const ids = Array.from({ length: count }, () =>
          encodeTypeIdSuffix(source.next(1_700_000_000_000)),
        );
        expect(ids).toEqual([...ids].sort());
        // And they are distinct, which a counter that failed to advance would break.
        expect(new Set(ids).size).toBe(count);
      }),
      fcConfig(),
    );
  });

  it('still sorts when the clock steps backwards', () => {
    // NTP steps, and a `VirtualClock` can be rewound. An id that sorted before an existing one
    // would silently reorder the turn journal, so the source keeps counting inside the newer
    // millisecond instead.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5_000 }), fc.nat({ max: 10_000 }), (step, seed) => {
        const source = sourceWithSeed(seed);
        const base = 1_700_000_000_000;
        const first = encodeTypeIdSuffix(source.next(base));
        const afterStepBack = encodeTypeIdSuffix(source.next(base - step));
        expect(afterStepBack > first).toBe(true);
      }),
      fcConfig(),
    );
  });
});

describe('the suffix encoding', { tags: ['prop'] }, () => {
  it('is always 26 Crockford base32 characters starting 0–7', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 16, maxLength: 16 }), (bytes) => {
        const suffix = encodeTypeIdSuffix(bytes);
        expect(suffix).toMatch(/^[0-7][0-9a-hjkmnp-tv-z]{25}$/);
      }),
      fcConfig(),
    );
  });

  it('is injective: different bytes never encode to the same suffix', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 16, maxLength: 16 }),
        fc.uint8Array({ minLength: 16, maxLength: 16 }),
        (a, b) => {
          const same = a.length === b.length && a.every((value, index) => value === b[index]);
          if (same) return;
          expect(encodeTypeIdSuffix(a)).not.toBe(encodeTypeIdSuffix(b));
        },
      ),
      fcConfig(),
    );
  });

  it('preserves byte order, so lexicographic order is byte order', () => {
    // This is *why* sortability works: base32 big-endian means comparing the strings compares the
    // bytes, which compares the timestamps.
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 16, maxLength: 16 }),
        fc.uint8Array({ minLength: 16, maxLength: 16 }),
        (a, b) => {
          const byteOrder = Buffer.compare(Buffer.from(a), Buffer.from(b));
          const stringOrder = encodeTypeIdSuffix(a).localeCompare(encodeTypeIdSuffix(b), 'en');
          if (byteOrder === 0) return;
          expect(Math.sign(stringOrder)).toBe(Math.sign(byteOrder));
        },
      ),
      fcConfig(),
    );
  });
});

describe('the source refuses what it cannot represent', () => {
  it('rejects a non-integer or negative timestamp', () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => sourceWithSeed(1).next(bad)).toThrow(RangeError);
    }
  });

  it('rejects a timestamp past 48 bits, naming the likely mistake', () => {
    // A caller passing microseconds lands here. The alternative is a silently truncated timestamp
    // and ids that sort wrongly for ever.
    expect(() => sourceWithSeed(1).next(MAX_MS + 1)).toThrow(/Milliseconds, not microseconds/);
  });

  it('refuses more than 4,096 ids in one millisecond rather than reordering', () => {
    const source = sourceWithSeed(7);
    let generated = 0;
    expect(() => {
      for (let i = 0; i <= COUNTER_MAX + 2; i += 1) {
        source.next(1_700_000_000_000);
        generated += 1;
      }
    }).toThrow(/invariants I6, I7/);
    // Non-vacuous: it did a lot of work before refusing, rather than refusing immediately.
    expect(generated).toBeGreaterThan(1_000);
  });
});

describe('the remaining edges', () => {
  it('refuses a clock step back it cannot absorb', () => {
    // The counter is the only thing keeping an id minted after a backwards clock step from sorting
    // before an existing one. Once it is exhausted there is no honest answer left, so it refuses
    // rather than reordering the turn journal.
    const source = sourceWithSeed(3);
    const base = 1_700_000_000_000;
    source.next(base);
    expect(() => {
      for (let i = 0; i <= COUNTER_MAX + 2; i += 1) source.next(base - 1);
    }).toThrow(/moved backwards/);
  });

  it('isUuidV7 rejects the wrong length', () => {
    expect(isUuidV7(new Uint8Array(15))).toBe(false);
    expect(isUuidV7(new Uint8Array(17))).toBe(false);
  });

  it('isUuidV7 rejects a wrong version or variant', () => {
    const bytes = sourceWithSeed(1).next(1_700_000_000_000);
    expect(isUuidV7(bytes)).toBe(true);

    const wrongVersion = Uint8Array.from(bytes);
    wrongVersion[6] = 0x40; // v4
    expect(isUuidV7(wrongVersion)).toBe(false);

    const wrongVariant = Uint8Array.from(bytes);
    wrongVariant[8] = 0x00;
    expect(isUuidV7(wrongVariant)).toBe(false);
  });

  it('accepts the largest timestamp 48 bits can hold', () => {
    expect(timestampOf(sourceWithSeed(1).next(MAX_MS))).toBe(MAX_MS);
  });

  it('accepts timestamp zero', () => {
    expect(timestampOf(sourceWithSeed(1).next(0))).toBe(0);
  });
});
