/**
 * The CSPRNG surface (`08` §3.7.1, §3.7.12).
 *
 * Randomness is the one thing you cannot test by inspection: a generator that returned a constant,
 * or that was biased, or that silently drew fewer bits than asked for, passes every test that only
 * checks the shape of its output. So these tests check distribution and range as well as format,
 * and the arguments are checked for the mistake that actually happens — bytes confused with bits.
 */
import { describe, expect, it } from 'vitest';
import {
  CROCKFORD_ALPHABET,
  fillRandom,
  randomBytes,
  randomInt,
  randomToken,
  randomTypedCode,
} from './random.js';

describe('randomBytes', () => {
  it('returns the requested number of bytes', () => {
    for (const size of [1, 16, 32, 64]) {
      expect(randomBytes(size)).toHaveLength(size);
    }
  });

  it('returns different bytes each time', () => {
    // A generator stuck on a constant is the failure that every format test misses.
    const draws = new Set(Array.from({ length: 100 }, () => randomBytes(16).toString('hex')));
    expect(draws.size).toBe(100);
  });

  it('uses the whole byte range', () => {
    // A generator producing only ASCII, or only low bytes, would halve or quarter the entropy of
    // every key derived from it while looking perfectly random in hex.
    const seen = new Set<number>();
    for (const byte of randomBytes(8_192)) seen.add(byte);
    expect(seen.size).toBeGreaterThan(250);
  });
});

describe('fillRandom', () => {
  it('fills the buffer it is given', () => {
    const target = new Uint8Array(32);
    fillRandom(target);
    expect(target.some((byte) => byte !== 0)).toBe(true);
  });

  it('fills the whole buffer, not just the start', () => {
    // A partial fill leaves a predictable tail, and in a nonce that is the kind of flaw that only
    // shows up as a broken AEAD much later.
    const tailWasTouched = Array.from({ length: 50 }, () => {
      const target = new Uint8Array(64);
      fillRandom(target);
      return target.slice(48).some((byte) => byte !== 0);
    });
    expect(tailWasTouched.filter(Boolean).length).toBeGreaterThan(45);
  });
});

describe('randomInt', () => {
  it('stays inside [0, max)', () => {
    for (let i = 0; i < 1_000; i += 1) {
      const value = randomInt(10);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(10);
    }
  });

  it('reaches every value of a small bound', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2_000; i += 1) seen.add(randomInt(5));
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it('is roughly uniform, so a biased draw is a failing test', () => {
    // Not a statistical proof — a chi-squared test in a unit suite would be flaky. This catches
    // the realistic bug: a modulo reduction that makes low values meaningfully likelier.
    const counts = new Array<number>(8).fill(0);
    const draws = 40_000;
    for (let i = 0; i < draws; i += 1) {
      const bucket = randomInt(8);
      counts[bucket] = (counts[bucket] ?? 0) + 1;
    }
    const expected = draws / 8;
    for (const [bucket, count] of counts.entries()) {
      expect(count, `bucket ${String(bucket)} got ${String(count)}`).toBeGreaterThan(
        expected * 0.8,
      );
      expect(count, `bucket ${String(bucket)} got ${String(count)}`).toBeLessThan(expected * 1.2);
    }
  });

  it('accepts a bound of 1, which always returns 0', () => {
    expect(randomInt(1)).toBe(0);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses the bound %p', (bad) => {
    expect(() => randomInt(bad)).toThrow(RangeError);
  });
});

describe('randomToken', () => {
  it('is 43 base64url characters for the default 32 bytes', () => {
    // `08` §3.7.12's session and control tokens: 256 bits, 43 characters, no padding.
    const token = randomToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('uses base64url, so it is safe in a URL and a cookie', () => {
    // `+`, `/` and `=` all need escaping in both, and a token that round-trips differently
    // through a URL is a token that fails to authenticate for reasons nobody can see.
    const tokens = Array.from({ length: 200 }, () => randomToken());
    for (const token of tokens) {
      expect(token).not.toMatch(/[+/=]/);
      expect(encodeURIComponent(token)).toBe(token);
    }
  });

  it('honours a larger size', () => {
    expect(randomToken(64)).toHaveLength(86);
  });

  it('is unpredictable across draws', () => {
    expect(new Set(Array.from({ length: 500 }, () => randomToken())).size).toBe(500);
  });

  it('refuses fewer than 16 bytes, naming the likely confusion', () => {
    // The realistic mistake is passing bits. `randomToken(128)` is fine; `randomToken(8)` is a
    // caller who meant 8 *bits* of a 128-bit token and has written a guessable secret.
    expect(() => randomToken(8)).toThrow(/BYTES, not bits/);
    expect(() => randomToken(0)).toThrow(RangeError);
    expect(() => randomToken(1.5)).toThrow(RangeError);
  });
});

describe('randomTypedCode', () => {
  it('is two groups of four by default, which is `08` §3.7.12’s pairing code', () => {
    const code = randomTypedCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  });

  it('never contains I, L, O or U', () => {
    // These are read off a console and typed into a chat. `I`/`1`, `O`/`0` and `L`/`1` are the
    // confusions that turn a working claim code into a support question.
    const codes = Array.from({ length: 300 }, () => randomTypedCode(3, 5)).join('');
    for (const excluded of ['I', 'L', 'O', 'U']) {
      expect(codes, `contains ${excluded}`).not.toContain(excluded);
    }
  });

  it('is uppercase, matching what the console prints', () => {
    const code = randomTypedCode();
    expect(code).toBe(code.toUpperCase());
  });

  it('honours the group shape', () => {
    expect(randomTypedCode(1, 4)).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(randomTypedCode(3, 3)).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$/,
    );
  });

  it('uses the whole alphabet, so no character is unreachable', () => {
    // A generator that could never emit `Z` loses entropy the specification counted on. With 32
    // characters and 8,000 draws, every one should appear.
    const drawn = new Set(randomTypedCode(200, 40).replaceAll('-', ''));
    expect(drawn.size).toBe(CROCKFORD_ALPHABET.length);
  });

  it('is unpredictable across draws', () => {
    expect(new Set(Array.from({ length: 500 }, () => randomTypedCode(4, 4))).size).toBe(500);
  });

  it.each([
    [0, 4],
    [2, 0],
    [1.5, 4],
    [2, 1.5],
    [-1, 4],
  ])('refuses groups=%p groupSize=%p', (groups, groupSize) => {
    expect(() => randomTypedCode(groups, groupSize)).toThrow(RangeError);
  });
});

describe('CROCKFORD_ALPHABET', () => {
  it('has 32 characters and excludes I, L, O and U', () => {
    expect(CROCKFORD_ALPHABET).toHaveLength(32);
    for (const excluded of ['I', 'L', 'O', 'U']) {
      expect(CROCKFORD_ALPHABET).not.toContain(excluded);
    }
  });

  it('has no duplicates, which would bias the draw', () => {
    expect(new Set(CROCKFORD_ALPHABET).size).toBe(32);
  });

  it('is exactly Crockford’s ordering, so a decoder can rely on the index', () => {
    expect(CROCKFORD_ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
  });
});
