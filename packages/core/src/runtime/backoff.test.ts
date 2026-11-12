/**
 * Equal-jitter backoff (`02` §3.10.3).
 *
 * The arithmetic is three lines, and each of the three is a decision with a failure mode on the
 * other side of it — so each gets an assertion rather than a spot check of one value.
 */
import { describe, expect, it } from 'vitest';
import { attemptsExhausted, backoffMs, JOB_BACKOFF, OUTBOX_BACKOFF } from './backoff.js';

/** A deterministic `rng`, which is why `02` §3.10.3 injects it. */
const fixed = (value: number) => () => value;

describe('backoffMs', () => {
  it('doubles the ceiling per attempt and stops at the cap', () => {
    // `d = min(cap, base · 2^(attempts−1))`, read off the spec. With `rng() = 1` the delay is the
    // whole ceiling, which is what makes the doubling visible.
    const ceilings = [1, 2, 3, 4, 5, 10, 20].map((attempts) =>
      backoffMs(attempts, OUTBOX_BACKOFF, fixed(1)),
    );
    expect(ceilings).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 600_000, 600_000]);
    // The cap is what stops a tenth retry waiting eighteen hours — `02` §3.9 allows ten attempts,
    // and `2 s · 2^9` is already 17 minutes.
    expect(backoffMs(100, OUTBOX_BACKOFF, fixed(1))).toBe(OUTBOX_BACKOFF.capMs);
  });

  it('keeps a floor of half the ceiling, so a retry is never immediate', () => {
    // Equal jitter rather than full jitter: `rng() = 0` must still wait. Full jitter would return
    // nearly zero here, which turns a backoff into a hot loop for an unlucky caller — and the
    // caller is a dispatcher that just failed to reach a platform.
    expect(backoffMs(1, OUTBOX_BACKOFF, fixed(0))).toBe(1_000);
    expect(backoffMs(3, OUTBOX_BACKOFF, fixed(0))).toBe(4_000);
    expect(backoffMs(1, OUTBOX_BACKOFF, fixed(0.5))).toBe(1_500);
  });

  it('spreads retries that failed together', () => {
    // The reason the jitter exists at all: an outage fails every queued send at once, and without
    // it they would all come back at the same instant and fail together again.
    const delays = new Set(
      Array.from({ length: 50 }, (_unused, index) =>
        backoffMs(4, OUTBOX_BACKOFF, fixed(index / 50)),
      ),
    );
    expect(delays.size).toBeGreaterThan(40);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(8_000);
      expect(delay).toBeLessThanOrEqual(16_000);
    }
  });

  it('takes a platform `retry-after` only when it asks for longer', () => {
    // `02` §3.10.3: "`retryAfterMs` overrides it when larger". A server asking for a longer wait is
    // telling us something we do not know; one asking for a shorter wait would let a client talk
    // itself out of its own backoff, which is how a rate limit becomes a ban.
    expect(backoffMs(1, OUTBOX_BACKOFF, fixed(0), 60_000)).toBe(60_000);
    expect(backoffMs(1, OUTBOX_BACKOFF, fixed(0), 10)).toBe(1_000);
  });

  it('does not go backwards for a zeroth attempt', () => {
    // A caller passing 0 would otherwise get `base · 2^-1`, a *shorter* first wait than one
    // failure earns. Clamped, because the exponent counts gaps and there is no gap before the
    // first try.
    expect(backoffMs(0, OUTBOX_BACKOFF, fixed(1))).toBe(2_000);
  });

  it('carries the two policies 02 states, which are not the same', () => {
    // The outbox retries a send ten times over minutes; a job retries eight times over hours. One
    // shared constant would have had to be wrong for one of them.
    expect(OUTBOX_BACKOFF).toEqual({ baseMs: 2_000, capMs: 600_000, maxAttempts: 10 });
    expect(JOB_BACKOFF).toEqual({ baseMs: 5_000, capMs: 3_600_000, maxAttempts: 8 });
    expect(backoffMs(1, JOB_BACKOFF, fixed(1))).toBe(5_000);
  });
});

describe('attemptsExhausted', () => {
  it('is true at the limit, not past it', () => {
    // `02` §3.9: "permanent error or attempts ≥ max". The tenth attempt is the last one, so a row
    // at ten is dead rather than due for an eleventh — an off-by-one here is an infinite retry.
    expect(attemptsExhausted(9, OUTBOX_BACKOFF.maxAttempts)).toBe(false);
    expect(attemptsExhausted(10, OUTBOX_BACKOFF.maxAttempts)).toBe(true);
    expect(attemptsExhausted(11, OUTBOX_BACKOFF.maxAttempts)).toBe(true);
  });
});
