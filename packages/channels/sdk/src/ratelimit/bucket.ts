/**
 * A token bucket with continuous refill (`06` §3.14; `M3-T7`).
 *
 * `06` §3.14: "Buckets refill continuously from the injected `Clock`, so tests use a virtual
 * clock." Both halves of that sentence are load-bearing.
 *
 * **Continuous**, not per-tick. A bucket that refilled on a timer would hold its level between
 * ticks, so Telegram's "20 messages per minute per group" implemented as 20 tokens every 60 s
 * sends twenty messages in the first second of each minute and nothing for the rest — which is
 * within the average and over the burst the platform actually enforces. Refill is therefore a
 * function of elapsed time, computed on read, and `capacity` is the only thing that bounds a burst.
 *
 * **From the injected clock**, so the limiter's tests have no real timers in them at all. A rate
 * limiter tested against the wall clock is tested at one point per second of test runtime: the
 * interesting cases — a 3 s refill interval, a 60 s retry cap, a day of a group's traffic — are
 * either unreachable or make the suite unusable. `VirtualClock` covers all of them in microseconds.
 *
 * ## The two numbers, and why both
 *
 * `refillPerSecond` is the sustained rate and `capacity` is the burst. `06` §3.14's table keeps
 * them apart on purpose — Telegram groups are "capacity 5, refill 1 per 3 s" for a 20/min limit,
 * because a family's group chat is bursty: three messages land together and then nothing for a
 * minute. A bucket with capacity 1 would smooth that into three messages three seconds apart,
 * which reads as a bot that is thinking slowly.
 */
import type { Temporal } from 'temporal-polyfill';

export interface BucketSpec {
  /** The burst: the most tokens that can accumulate. */
  readonly capacity: number;
  /** The sustained rate. */
  readonly refillPerSecond: number;
}

/**
 * A validated spec.
 *
 * Both bounds are refusals rather than clamps, because a silently-corrected limit is a limit
 * nobody can reason about: `refillPerSecond: 0` is a bucket that empties once and never refills,
 * so every send after the first burst waits forever, and the symptom is a group that goes quiet
 * with nothing in the log.
 */
export function bucketSpec(capacity: number, refillPerSecond: number): BucketSpec {
  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new RangeError(`a bucket's capacity must be a positive number, got ${String(capacity)}`);
  }
  if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
    throw new RangeError(
      `a bucket's refill rate must be positive, got ${String(refillPerSecond)} per second. ` +
        'A bucket that never refills blocks every send after the first burst.',
    );
  }
  return { capacity, refillPerSecond };
}

const NANOS_PER_SECOND = 1_000_000_000n;

export class TokenBucket {
  readonly spec: BucketSpec;
  #tokens: number;
  #at: Temporal.Instant;

  /** Starts **full**: a fresh bucket must not throttle a host's first send after a restart. */
  constructor(spec: BucketSpec, startedAt: Temporal.Instant) {
    this.spec = spec;
    this.#tokens = spec.capacity;
    this.#at = startedAt;
  }

  /**
   * The level at `now`.
   *
   * Elapsed time is computed as a **difference of bigints** before it becomes a float. Two epoch
   * nanosecond values are around 1.8e18, past the point where a double counts integers exactly, so
   * converting first and subtracting after would lose hundreds of nanoseconds per read — on the
   * hot path of every send.
   *
   * A clock that goes **backwards** contributes nothing rather than draining the bucket. `Clock` is
   * a `SystemClock` in production and NTP steps it; without the clamp a one-second correction would
   * subtract a second's worth of tokens from every bucket at once, and the product would throttle
   * itself for reasons invisible in any log.
   */
  level(now: Temporal.Instant): number {
    const elapsedNanos = now.epochNanoseconds - this.#at.epochNanoseconds;
    if (elapsedNanos <= 0n) return this.#tokens;
    const seconds = Number(elapsedNanos) / Number(NANOS_PER_SECOND);
    return Math.min(this.spec.capacity, this.#tokens + seconds * this.spec.refillPerSecond);
  }

  /** True when nothing is owed: a full bucket is indistinguishable from a fresh one. */
  isFull(now: Temporal.Instant): boolean {
    return this.level(now) >= this.spec.capacity;
  }

  /**
   * How long until `cost` tokens exist, in milliseconds. `0` when they already do.
   *
   * Rounded **up**, which makes the error one-sided. A wait rounded down wakes the limiter before
   * the tokens are there — not a correctness bug, because the level is re-read, but a spin: at a
   * refill of 1 per 3 s a half-millisecond shortfall would reschedule the same timer until the
   * millisecond ticked over.
   *
   * The consequence is that a wait whose true value is exactly a millisecond can come back one
   * millisecond long: a third of a token is `0.3333333333333333`, so the shortfall is a hair over
   * two thirds and the ceiling lands on 2 001. Measured and asserted in `bucket.test.ts`. Snapping
   * to the nearest millisecond with an epsilon would give tidier numbers and introduce a case where
   * this returns zero and `take` finds the level a nanosecond short, which throws.
   */
  waitMs(cost: number, now: Temporal.Instant): number {
    this.#assertSatisfiable(cost);
    const missing = cost - this.level(now);
    if (missing <= 0) return 0;
    return Math.ceil((missing / this.spec.refillPerSecond) * 1_000);
  }

  /**
   * Spend `cost` tokens.
   *
   * Throws when they are not available, rather than going negative. The caller is the limiter,
   * which has already checked every bucket in the set — so a throw here means the atomicity of a
   * multi-key acquire has been broken, and that is a defect to surface rather than a debt to carry
   * in a negative level.
   */
  take(cost: number, now: Temporal.Instant): void {
    this.#assertSatisfiable(cost);
    const level = this.level(now);
    if (level < cost) {
      throw new RangeError(
        `took ${String(cost)} from a bucket holding ${level.toFixed(3)}. ` +
          'Check waitMs() first; a multi-key acquire must take only when every bucket can pay.',
      );
    }
    this.#tokens = level - cost;
    this.#at = now;
  }

  /**
   * A cost above the burst can never be paid, so it is a programmer error rather than a long wait.
   *
   * Without this the waiter sits in the queue for ever, holding its keys reserved against every
   * lower-priority waiter behind it — one bad cost would stop the lane and look like a hang.
   */
  #assertSatisfiable(cost: number): void {
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new RangeError(`a cost must be a positive number, got ${String(cost)}`);
    }
    if (cost > this.spec.capacity) {
      throw new RangeError(
        `a cost of ${String(cost)} exceeds the bucket's capacity of ${String(this.spec.capacity)}, ` +
          'so it can never be paid.',
      );
    }
  }
}
