/**
 * The retry policy (`06` §3.14, §3.15; `M3-T7`).
 *
 * Four things here are decisions rather than arithmetic, and each one is tested as such:
 *
 * **`retryAfter` is a floor, not a replacement.** When a platform says "wait 30 seconds" that is a
 * lower bound we impose on ourselves, never a reason to come back sooner than our own backoff.
 * Going back early on Discord is how an app reaches the 10 000 invalid requests per 10 minutes that
 * gets it banned (`06` §3.14).
 *
 * **The jitter is one-sided.** `U(0.5, 1.0)` of the backoff and never above it, so a herd of rows
 * that failed on one outage spreads out as the platform returns without any of them landing past
 * the cap.
 *
 * **`rate_limited` does not count toward attempts.** A platform telling us to slow down is not the
 * send failing; eight 429s in a busy minute would otherwise burn the whole budget of a message that
 * was never properly attempted.
 *
 * **`defer` is not `fail`.** The platform is down and the message is still worth sending, so the
 * row keeps its place with `nextAttemptAt` five minutes out. `fail` is for the kinds §3.15 calls
 * permanent, where the engine's recovery behaviour takes over instead.
 *
 * The last block cross-checks `planRetry` against `isRetryableKind`, because two lists of which
 * kinds are retryable is how a kind comes to be retried in one place and dropped in the other.
 */
import type { Rng } from '@comvivo/shared';
import { SeededRng } from '@comvivo/shared/testing';
import { describe, expect, it } from 'vitest';
import { CHANNEL_ERROR_KINDS, type ChannelErrorKind, isRetryableKind } from './errors.js';
import {
  DEFER_MS,
  JITTER_FLOOR,
  MAX_TRANSIENT_ATTEMPTS,
  planRetry,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  retryDelayMs,
} from './retry.js';

/** An `Rng` pinned to one draw, for the two ends of the jitter window. */
function fixedRng(value: number): Rng {
  const rng: Rng = {
    next: () => value,
    nextInt: (maxExclusive: number) => Math.floor(value * maxExclusive),
    fork: () => rng,
  };
  return rng;
}

const LOWEST = fixedRng(0);
const HIGHEST = fixedRng(1);

/** The un-jittered backoff `06` §3.14 defines for attempt `n`. */
const backoff = (attempt: number): number => Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);

describe('retryDelayMs', () => {
  it('is 06 §3.14’s formula at both ends of the jitter window', () => {
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const full = backoff(attempt);
      expect(retryDelayMs(attempt, HIGHEST), `attempt ${String(attempt)} high`).toBe(full);
      expect(retryDelayMs(attempt, LOWEST), `attempt ${String(attempt)} low`).toBe(
        Math.round(full * JITTER_FLOOR),
      );
    }
  });

  it('caps at 60 s', () => {
    // `base × 2^6` is 64 s, so the cap binds from the sixth attempt on.
    expect(backoff(5)).toBe(32_000);
    expect(backoff(6)).toBe(RETRY_CAP_MS);
    expect(retryDelayMs(6, HIGHEST)).toBe(RETRY_CAP_MS);
    expect(retryDelayMs(20, HIGHEST)).toBe(RETRY_CAP_MS);
  });

  it('never exceeds the backoff, however the jitter falls', () => {
    // One-sided by construction. Two-sided jitter would put some of a herd past the cap, which is
    // the one number a platform's own guidance tends to be specific about.
    const rng = new SeededRng(7);
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      for (let draw = 0; draw < 200; draw += 1) {
        const delay = retryDelayMs(attempt, rng);
        expect(delay, `attempt ${String(attempt)}`).toBeLessThanOrEqual(backoff(attempt));
        expect(delay).toBeGreaterThanOrEqual(Math.floor(backoff(attempt) * JITTER_FLOOR));
      }
    }
  });

  it('treats `retryAfter` as a floor', () => {
    // Never shorter than the platform asked for, and never shorter than our own backoff either.
    expect(retryDelayMs(1, LOWEST, 30_000)).toBe(30_000);
    expect(retryDelayMs(1, LOWEST)).toBe(1_000);
    expect(retryDelayMs(10, HIGHEST, 5_000)).toBe(RETRY_CAP_MS);
    // A `retryAfter` beyond the cap is still honoured: the cap bounds *our* backoff, not the
    // platform's instruction.
    expect(retryDelayMs(1, HIGHEST, 120_000)).toBe(120_000);
  });

  it('is reproducible from a seed, which is why the jitter comes from `Rng`', () => {
    // `08` §3.7.1: `Rng` is the seedable PRNG, for things that must replay. A simulated week
    // (`11` §3.1.7) includes an outage at 09:00 and the digest that lands late because of it; an
    // unseeded jitter makes that timeline different on every run.
    const first = Array.from({ length: 8 }, (_, n) => retryDelayMs(n + 1, new SeededRng(42)));
    const second = Array.from({ length: 8 }, (_, n) => retryDelayMs(n + 1, new SeededRng(42)));
    expect(second).toEqual(first);
  });

  it('refuses an attempt below one', () => {
    for (const attempt of [0, -1, 1.5, Number.NaN]) {
      expect(() => retryDelayMs(attempt, LOWEST), String(attempt)).toThrow(RangeError);
    }
  });
});

describe('the measured ceiling (06 §3.14’s "about 4 minutes")', () => {
  it('is 182 s of backoff across eight attempts, not 240', () => {
    // `06` §3.14 says "at most 8 attempts, about 4 minutes". With `attempt` counting failures that
    // happened, the delays follow attempts 1…7 and the eighth defers, so the worst case is
    // 2+4+8+16+32+60+60. The spec is corrected to this figure in the same commit as this test.
    let worst = 0;
    let expected = 0;
    for (let attempts = 0; attempts < MAX_TRANSIENT_ATTEMPTS; attempts += 1) {
      const high = planRetry('transient', { attempts }, HIGHEST);
      const low = planRetry('transient', { attempts }, LOWEST);
      if (high.action !== 'retry') continue;
      worst += high.delayMs;
      expected += (high.delayMs + low.delayMs) / 2;
    }
    expect(worst).toBe(182_000);
    expect(Math.round(expected / 1_000)).toBe(137);
  });
});

describe('planRetry', () => {
  it('retries `rate_limited` without counting it', () => {
    const plan = planRetry('rate_limited', { attempts: 7 }, HIGHEST, 12_000);
    expect(plan.action).toBe('retry');
    expect(plan.countsAsAttempt).toBe(false);
    expect(plan.delayMs).toBe(RETRY_CAP_MS);
  });

  it('never defers or fails a `rate_limited`, however many have arrived', () => {
    // The whole point of not counting it: a busy minute of 429s must not consume the budget of a
    // send that was never properly attempted.
    for (const attempts of [0, 8, 100]) {
      expect(planRetry('rate_limited', { attempts }, HIGHEST).action, String(attempts)).toBe(
        'retry',
      );
    }
  });

  it('backs off a `transient` and counts it', () => {
    const plan = planRetry('transient', { attempts: 0 }, HIGHEST);
    expect(plan).toEqual({ action: 'retry', delayMs: 2_000, countsAsAttempt: true });
  });

  it('defers at the eighth attempt rather than failing', () => {
    // `06` §3.14: "After that the row goes back to `pending`, with `nextAttemptAt` = +5 min, until
    // it expires." The platform is down; the message is still worth sending.
    expect(planRetry('transient', { attempts: 6 }, HIGHEST).action).toBe('retry');
    expect(planRetry('transient', { attempts: MAX_TRANSIENT_ATTEMPTS - 1 }, HIGHEST)).toEqual({
      action: 'defer',
      delayMs: DEFER_MS,
      countsAsAttempt: true,
    });
    expect(planRetry('transient', { attempts: 50 }, HIGHEST).action).toBe('defer');
  });

  it('treats `ambiguous` like a transient, after 06 §3.13 has had its say', () => {
    expect(planRetry('ambiguous', { attempts: 0 }, HIGHEST)).toEqual({
      action: 'retry',
      delayMs: 2_000,
      countsAsAttempt: true,
    });
  });

  it('retries `chat_migrated` immediately on the new id', () => {
    // `06` §3.15. A backoff here would delay every message to a group Telegram upgraded to a
    // supergroup, for no reason: the send failed because the id changed and the new id is in hand.
    expect(planRetry('chat_migrated', { attempts: 3 }, HIGHEST)).toEqual({
      action: 'retry',
      delayMs: 0,
      countsAsAttempt: false,
    });
  });

  it('fails every permanent kind', () => {
    for (const kind of CHANNEL_ERROR_KINDS) {
      if (isRetryableKind(kind)) continue;
      expect(planRetry(kind, { attempts: 0 }, HIGHEST), kind).toEqual({
        action: 'fail',
        delayMs: 0,
        countsAsAttempt: false,
      });
    }
  });

  it('plans from a kind and a count, so a row read back after a restart can be retried', () => {
    // The dispatcher (`M3-T27`) plans from an outbox row, where the original error object is long
    // gone and the row recorded what it was.
    const kind: ChannelErrorKind = 'transient';
    expect(planRetry(kind, { attempts: 2 }, HIGHEST).delayMs).toBe(8_000);
  });
});

describe('agreement with the error taxonomy', () => {
  it('plans a retry for exactly the kinds 06 §3.15 calls retryable', () => {
    // Two lists of which kinds are retryable is how a kind comes to be retried in one place and
    // dropped in the other — with the symptom being a message that vanishes on one platform.
    for (const kind of CHANNEL_ERROR_KINDS) {
      const plan = planRetry(kind, { attempts: 0 }, HIGHEST);
      expect(plan.action !== 'fail', kind).toBe(isRetryableKind(kind));
    }
  });

  it('covers every kind in the taxonomy', () => {
    expect(CHANNEL_ERROR_KINDS.length).toBeGreaterThan(0);
    for (const kind of CHANNEL_ERROR_KINDS) {
      expect(['retry', 'defer', 'fail'], kind).toContain(
        planRetry(kind, { attempts: 0 }, HIGHEST).action,
      );
    }
  });
});
