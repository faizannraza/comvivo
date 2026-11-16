/**
 * The token bucket (`06` §3.14; `M3-T7`).
 *
 * Three things here are not obvious from the code and are each a real failure:
 *
 * **Continuous refill.** A bucket that topped up on a tick would send Telegram's whole 20-a-minute
 * group allowance in the first second of each minute — inside the average and over the burst the
 * platform enforces. The test is that the level at half an interval is half a token.
 *
 * **A backwards clock contributes nothing.** `SystemClock` is stepped by NTP. Without the clamp, a
 * one-second correction subtracts a second of tokens from every bucket at once and the product
 * throttles itself for a reason no log would show.
 *
 * **A cost above the capacity throws.** It can never be paid, so queueing it would hold the key
 * reserved against every later waiter — a hang whose cause is one wrong number at a call site.
 */
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { bucketSpec, TokenBucket } from './bucket.js';

const T0 = Temporal.Instant.from('2026-11-15T12:00:00Z');
const at = (seconds: number): Temporal.Instant =>
  T0.add({ milliseconds: Math.round(seconds * 1000) });

/** `06` §3.14's Telegram group row: 20/min as capacity 5, refill 1 per 3 s. */
const TELEGRAM_GROUP = bucketSpec(5, 1 / 3);

describe('bucketSpec', () => {
  it('refuses a non-positive capacity or rate', () => {
    for (const [capacity, rate] of [
      [0, 1],
      [-1, 1],
      [Number.NaN, 1],
      [Number.POSITIVE_INFINITY, 1],
      [1, 0],
      [1, -1],
      [1, Number.NaN],
    ] as const) {
      expect(() => bucketSpec(capacity, rate), `${String(capacity)}/${String(rate)}`).toThrow(
        RangeError,
      );
    }
  });

  it('accepts a fractional rate, which is how 06 §3.14 writes a per-minute limit', () => {
    expect(bucketSpec(5, 1 / 3)).toEqual({ capacity: 5, refillPerSecond: 1 / 3 });
  });
});

describe('a fresh bucket', () => {
  it('starts full, so a restart does not throttle the first send', () => {
    const bucket = new TokenBucket(TELEGRAM_GROUP, T0);
    expect(bucket.level(T0)).toBe(5);
    expect(bucket.isFull(T0)).toBe(true);
    expect(bucket.waitMs(5, T0)).toBe(0);
  });
});

describe('refill', () => {
  it('is continuous, not per interval', () => {
    // The assertion that distinguishes this from a ticking bucket: half an interval is half a
    // token. A tick-based bucket reads 0 here and then 1 at three seconds.
    const bucket = new TokenBucket(TELEGRAM_GROUP, T0);
    bucket.take(5, T0);
    expect(bucket.level(T0)).toBe(0);
    expect(bucket.level(at(1.5))).toBeCloseTo(0.5, 9);
    expect(bucket.level(at(3))).toBeCloseTo(1, 9);
    expect(bucket.level(at(4.5))).toBeCloseTo(1.5, 9);
  });

  it('caps at the capacity however long the bucket is idle', () => {
    const bucket = new TokenBucket(TELEGRAM_GROUP, T0);
    bucket.take(5, T0);
    expect(bucket.level(at(86_400))).toBe(5);
    expect(bucket.level(at(86_400 * 365))).toBe(5);
  });

  it('is exact over a long idle period, because elapsed time is differenced as bigints', () => {
    // Two epoch-nanosecond values are around 1.8e18, past where a double counts integers exactly.
    // Converting before subtracting loses hundreds of nanoseconds per read, on the hot path of
    // every send; differencing first keeps the gap small enough to be exact.
    const bucket = new TokenBucket(bucketSpec(1_000_000, 1_000_000), T0);
    bucket.take(1_000_000, T0);
    expect(bucket.level(T0.add({ nanoseconds: 1_000 }))).toBeCloseTo(1, 6);
  });

  it('contributes nothing when the clock goes backwards', () => {
    const bucket = new TokenBucket(TELEGRAM_GROUP, T0);
    bucket.take(3, T0);
    expect(bucket.level(at(-1))).toBe(2);
    expect(bucket.level(at(-3600))).toBe(2);
    expect(bucket.waitMs(3, at(-3600))).toBe(3_000);
  });
});

describe('waitMs', () => {
  it('is zero while the tokens are there', () => {
    const bucket = new TokenBucket(TELEGRAM_GROUP, T0);
    expect(bucket.waitMs(1, T0)).toBe(0);
    bucket.take(4, T0);
    expect(bucket.waitMs(1, T0)).toBe(0);
    bucket.take(1, T0);
    expect(bucket.waitMs(1, T0)).toBe(3_000);
  });

  it('rounds up, so the limiter does not wake early and spin', () => {
    // 1 token at 1/3 per second is 3 000 ms exactly; a shortfall of a third of a token is 1 000 ms.
    // Rounded down, a fractional remainder would reschedule the same timer until the millisecond
    // ticked over — correct, and a busy loop.
    const bucket = new TokenBucket(bucketSpec(1, 3), T0);
    bucket.take(1, T0);
    // 1 token at 3/s is 333.33 ms.
    expect(bucket.waitMs(1, T0)).toBe(334);
  });

  it('shortens as the bucket refills', () => {
    const bucket = new TokenBucket(TELEGRAM_GROUP, T0);
    bucket.take(5, T0);
    expect(bucket.waitMs(1, T0)).toBe(3_000);
    expect(bucket.waitMs(1, at(1))).toBe(2_001);
    expect(bucket.waitMs(1, at(2.999))).toBe(1);
    expect(bucket.waitMs(1, at(3))).toBe(0);
  });

  it('errs late, never early, when the arithmetic is not exact in binary', () => {
    // At a refill of 1/3 per second the level after one second is 0.3333333333333333, not a third,
    // so the shortfall is a hair over 2/3 and the ceiling lands on 2 001 ms rather than 2 000. The
    // error is one millisecond and it is **one-sided**, which is the property that matters: a wait
    // rounded up costs a millisecond, and a wait rounded down would have the limiter wake, find the
    // tokens still missing and reschedule — a spin at every exact boundary.
    //
    // Left as rounding rather than snapped to the nearest millisecond with an epsilon. An epsilon
    // would buy tidier numbers and introduce a case where `waitMs` says zero and `take` finds the
    // level a nanosecond short, which throws.
    const third = new TokenBucket(bucketSpec(5, 1 / 3), T0);
    third.take(5, T0);
    expect(third.waitMs(1, at(1))).toBe(2_001);
    // Exact in binary, so exact here: half a token at half a token per second.
    const half = new TokenBucket(bucketSpec(5, 0.5), T0);
    half.take(5, T0);
    expect(half.waitMs(1, at(1))).toBe(1_000);
    expect(half.waitMs(3, T0)).toBe(6_000);
  });

  it('accounts for the whole cost, not just the first token', () => {
    const bucket = new TokenBucket(TELEGRAM_GROUP, T0);
    bucket.take(5, T0);
    expect(bucket.waitMs(3, T0)).toBe(9_000);
  });
});

describe('take', () => {
  it('refuses to go negative', () => {
    const bucket = new TokenBucket(TELEGRAM_GROUP, T0);
    bucket.take(5, T0);
    // A negative level is a debt the bucket would silently carry, and it would mean the atomicity
    // of a multi-key acquire had already been broken somewhere else.
    expect(() => bucket.take(1, T0)).toThrow(RangeError);
    expect(bucket.level(T0)).toBe(0);
  });

  it('refuses a cost above the capacity, rather than waiting for ever', () => {
    const bucket = new TokenBucket(TELEGRAM_GROUP, T0);
    expect(() => bucket.take(6, T0)).toThrow(/can never be paid/);
    expect(() => bucket.waitMs(6, T0)).toThrow(/can never be paid/);
  });

  it('refuses a non-positive cost', () => {
    const bucket = new TokenBucket(TELEGRAM_GROUP, T0);
    for (const cost of [0, -1, Number.NaN]) {
      expect(() => bucket.take(cost, T0), String(cost)).toThrow(RangeError);
    }
  });

  it('holds the 06 §3.14 envelope over a burst and a drain', () => {
    // The whole contract of a token bucket in one statement: over any window, takes are at most
    // `capacity + rate × window`. Here: five immediately, then one per three seconds.
    const bucket = new TokenBucket(TELEGRAM_GROUP, T0);
    let taken = 0;
    for (let second = 0; second <= 60; second += 1) {
      const now = at(second);
      while (bucket.waitMs(1, now) === 0) {
        bucket.take(1, now);
        taken += 1;
      }
    }
    // 5 of burst plus 60 s at 1 per 3 s.
    expect(taken).toBe(5 + 20);
  });
});
