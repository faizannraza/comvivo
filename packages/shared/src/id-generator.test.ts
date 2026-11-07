/**
 * `TypeIdGenerator` and `SystemRng`.
 *
 * The generator is cross-checked against `typeid-js` on every prefix in the registry, which is the
 * assertion that matters: these ids go into URLs, audit rows and permalinks, and an encoding that
 * our parser accepted and the library refused would mean ids written and then unreadable.
 */
import { TypeID } from 'typeid-js';
import { describe, expect, it } from 'vitest';
import { encodeTypeIdSuffix, SystemRng, TypeIdGenerator } from './id-generator.js';
import { isId, KNOWN_PREFIXES, parseId } from './ids.js';
import { VirtualClock } from './testing/virtual-clock.js';
import { SystemClock } from './time/clock.js';
import { isUuidV7, timestampOf } from './uuidv7.js';

const START = '2026-11-04T12:00:00Z';
const START_MS = Date.UTC(2026, 10, 4, 12, 0, 0);

const make = (): TypeIdGenerator => new TypeIdGenerator(new SystemClock());

describe('TypeIdGenerator', () => {
  it('produces an id our own parser accepts', () => {
    const id = make().next('grp');
    expect(parseId('grp', id).ok).toBe(true);
  });

  it('produces an id typeid-js accepts, for every prefix in the registry', () => {
    // The cross-check. Our encoder is written out rather than taken from the library — the
    // encoding is the one part of an id that can never change, because it is in every log line and
    // URL a host has — so this is what keeps the two in agreement.
    const generator = make();
    for (const prefix of KNOWN_PREFIXES) {
      const id = generator.next(prefix);
      expect(() => TypeID.fromString(id), prefix).not.toThrow();
      expect(TypeID.fromString(id).getType(), prefix).toBe(prefix);
    }
  });

  it('brands the id with its prefix', () => {
    const id = make().next('mbr');
    expect(isId('mbr', id)).toBe(true);
    expect(isId('grp', id)).toBe(false);
  });

  it('embeds a UUIDv7 with the right version and variant bits', () => {
    const id = make().next('grp');
    const uuid = TypeID.fromString(id).toUUIDBytes();
    expect(isUuidV7(uuid)).toBe(true);
  });

  it('embeds the current time, to the millisecond', () => {
    const before = Date.now();
    const id = make().next('grp');
    const after = Date.now();
    const ms = timestampOf(TypeID.fromString(id).toUUIDBytes());
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
  });

  it('takes the time from the injected clock, not the wall clock', () => {
    // The reason the clock is a parameter: otherwise the monotonic counter could only be tested by
    // generating 4,096 ids inside one real millisecond.
    const clock = new VirtualClock(START);
    const id = new TypeIdGenerator(clock).next('grp');
    expect(timestampOf(TypeID.fromString(id).toUUIDBytes())).toBe(START_MS);
  });

  it('is monotonic within a millisecond', () => {
    // `01` §6.2, invariants I6 and I7: the turn journal and the outbox read id order as sequence.
    const generator = new TypeIdGenerator(new VirtualClock(START));
    const ids = Array.from({ length: 500 }, () => generator.next('obx'));
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(500);
  });

  it('keeps sorting across millisecond boundaries', async () => {
    const clock = new VirtualClock(START);
    const generator = new TypeIdGenerator(clock);
    const ids: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      ids.push(generator.next('trn'), generator.next('trn'));
      await clock.advance('PT0.001S');
    }
    expect(ids).toEqual([...ids].sort());
  });

  it('produces distinct ids across instances, so two processes do not collide', () => {
    // Two generators on the same clock: the random tail is what keeps them apart, and a host
    // running the server and a CLI command at once relies on it.
    const clock = new VirtualClock(START);
    const a = new TypeIdGenerator(clock);
    const b = new TypeIdGenerator(clock);
    const ids = new Set([
      ...Array.from({ length: 200 }, () => a.next('msg')),
      ...Array.from({ length: 200 }, () => b.next('msg')),
    ]);
    expect(ids.size).toBe(400);
  });

  it('is not reproducible, unlike the deterministic generator', () => {
    const clock = new VirtualClock(START);
    expect(new TypeIdGenerator(clock).next('grp')).not.toBe(new TypeIdGenerator(clock).next('grp'));
  });

  it('refuses a prefix outside the registry at compile time', () => {
    // @ts-expect-error 'zzz' is not an IdPrefix
    expect(() => make().next('zzz')).toBeDefined();
  });
});

describe('encodeTypeIdSuffix', () => {
  it('matches typeid-js for the same bytes', () => {
    for (let seed = 0; seed < 32; seed += 1) {
      const bytes = new Uint8Array(16);
      for (let i = 0; i < 16; i += 1) bytes[i] = (seed * 31 + i * 7) & 0xff;
      // Clear the top three bits, which a real UUID always has room for.
      bytes[0] = (bytes[0] ?? 0) & 0x1f;
      const ours = encodeTypeIdSuffix(bytes);
      const theirs = TypeID.fromUUIDBytes('grp', bytes).toString().slice('grp_'.length);
      expect(ours, `seed ${String(seed)}`).toBe(theirs);
    }
  });

  it('produces 26 characters of lowercase Crockford base32', () => {
    const bytes = new Uint8Array(16).fill(0xff);
    bytes[0] = 0x00;
    const suffix = encodeTypeIdSuffix(bytes);
    expect(suffix).toHaveLength(26);
    expect(suffix).toMatch(/^[0-7][0-9a-hjkmnp-tv-z]{25}$/);
  });

  it('encodes all-zero bytes as 26 zeroes', () => {
    expect(encodeTypeIdSuffix(new Uint8Array(16))).toBe('0'.repeat(26));
  });
});

describe('SystemRng', () => {
  it('returns floats in [0, 1)', () => {
    const rng = new SystemRng();
    for (let i = 0; i < 1_000; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('returns integers in [0, max)', () => {
    const rng = new SystemRng();
    for (let i = 0; i < 1_000; i += 1) {
      const value = rng.nextInt(7);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(7);
    }
  });

  it('covers the whole range of a small bound', () => {
    // A generator that never returned the top value would bias every fairness decision that uses
    // it, and the bug would be invisible in aggregate.
    const rng = new SystemRng();
    const seen = new Set<number>();
    for (let i = 0; i < 2_000; i += 1) seen.add(rng.nextInt(4));
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
  });

  it('refuses a bound that is not a positive integer', () => {
    const rng = new SystemRng();
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => rng.nextInt(bad)).toThrow(RangeError);
    }
  });

  it('forks into an independent generator, and says so by ignoring the label', () => {
    // `ports/rng.ts` promises `fork` derives a child from `(seed, label)`. A `SystemRng` has no
    // seed, so it cannot keep that promise — and pretending to would make a caller think their
    // draws were reproducible. Two forks with the same label must therefore differ.
    const rng = new SystemRng();
    const a = rng.fork('fairness');
    const b = rng.fork('fairness');
    const drawsA = Array.from({ length: 20 }, () => a.nextInt(1_000_000));
    const drawsB = Array.from({ length: 20 }, () => b.nextInt(1_000_000));
    expect(drawsA).not.toEqual(drawsB);
  });
});
