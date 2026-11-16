/**
 * The retry policy (`06` §3.14 "Retry policy", §3.15; `M3-T7`).
 *
 * One function decides what happens after a failed send, and it is pure: the error, the attempts so
 * far, and an injected `Rng`. The dispatcher that calls it is `M3-T27`, engine-side, because the
 * decision has to be written to a row inside a transaction.
 *
 * `06` §3.14: the delay for attempt `n` is `max(retryAfter ?? 0, U(0.5,1.0) × min(cap, base × 2^n))`
 * with `base = 1 s` and `cap = 60 s`.
 *
 * ## Why the jitter comes from `Rng` and not from `crypto`
 *
 * This is the use `08` §3.7.1 describes `Rng` *for*: a seedable PRNG, so that a replayed turn makes
 * the same decisions. A retry schedule is part of what a `11` §3.1.7 simulated week replays — an
 * outage at 09:00 and the digest that lands late because of it — and an unseeded jitter makes that
 * timeline different on every run. It is the mirror image of the interaction token, which must come
 * from the CSPRNG precisely because it must *not* be replayable.
 *
 * ## The three decisions, and why "defer" is not "fail"
 *
 * `06` §3.14: "`transient`: at most 8 attempts, about 4 minutes. After that the row goes back to
 * `pending`, with `nextAttemptAt` = +5 min, until it expires." That is not a failure — the platform
 * is down and the message is still worth sending — so the row keeps its place and the attempt
 * counter resets. `fail` is for the kinds §3.15 calls permanent, where sending again cannot help
 * and the engine's recovery behaviours take over instead.
 *
 * **`rate_limited` does not count toward attempts** (§3.14). A platform telling us to slow down is
 * not the send failing: eight 429s in a busy minute would otherwise burn the whole budget of a
 * message that was never attempted properly. The limiter in `ratelimit/` is what should make this
 * rare; honouring `retry_after` is what makes it correct when it is not.
 *
 * ## The measured ceiling, which is not four minutes
 *
 * `06` §3.14 says "about 4 minutes" and the arithmetic does not reach it. With `attempt` counting
 * failures that happened, the delays follow attempts 1…7 and the eighth defers, so the worst case
 * is `2+4+8+16+32+60+60 = 182 s` — just over three minutes — and the expected case is 0.75 of that,
 * about 137 s. `retry.test.ts` computes both and `06` §3.14 is corrected to the measured figures in
 * the same commit.
 */
import type { Rng } from '@comvivo/shared';
import type { ChannelErrorKind } from './errors.js';

/** `06` §3.14: `base = 1 s`. */
export const RETRY_BASE_MS = 1_000;

/** `06` §3.14: `cap = 60 s`. */
export const RETRY_CAP_MS = 60_000;

/** `06` §3.14: "at most 8 attempts". */
export const MAX_TRANSIENT_ATTEMPTS = 8;

/** `06` §3.14: "the row goes back to `pending`, with `nextAttemptAt` = +5 min". */
export const DEFER_MS = 5 * 60_000;

/** The jitter window, `U(0.5, 1.0)` (`06` §3.14). */
export const JITTER_FLOOR = 0.5;

export type RetryAction =
  /** Send again after `delayMs`. */
  | 'retry'
  /** The platform is down: back to `pending`, try again in five minutes, keep the row. */
  | 'defer'
  /** Permanent (`06` §3.15). The engine's recovery behaviour for the kind takes over. */
  | 'fail';

export interface RetryPlan {
  readonly action: RetryAction;
  /** `0` for `fail`, and for `chat_migrated`, which `06` §3.15 retries immediately on the new id. */
  readonly delayMs: number;
  /** Whether this failure increments the counted attempts. False for `rate_limited` (`06` §3.14). */
  readonly countsAsAttempt: boolean;
}

/**
 * The exponential backoff for attempt `n`, jittered and floored by the platform's own `retryAfter`.
 *
 * `max` rather than `min` against `retryAfterMs`: when a platform says "wait 30 seconds" the backoff
 * is a *lower* bound we impose on ourselves, never a reason to go back sooner. Going back early on
 * Discord is how an app reaches the 10 000 invalid requests per 10 minutes that gets it banned
 * (`06` §3.14).
 *
 * The jitter is **multiplicative and one-sided** — `U(0.5, 1.0)` of the backoff, never above it —
 * so a herd of rows that all failed on the same outage spread out as the platform comes back
 * instead of retrying in lockstep. Two-sided jitter would put some of them above the cap.
 */
export function retryDelayMs(attempt: number, rng: Rng, retryAfterMs = 0): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(
      `attempt is the number of failures so far, so at least 1, got ${String(attempt)}`,
    );
  }
  const backoff = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
  const jittered = backoff * (JITTER_FLOOR + (1 - JITTER_FLOOR) * rng.next());
  return Math.max(retryAfterMs, Math.round(jittered));
}

/**
 * `06` §3.15's `retryable` kinds, split by how they are retried.
 *
 * A `Set` rather than a `switch` in {@link planRetry}, so that the one place a kind's retry class
 * is decided is a list a reviewer can read against §3.15's table. `isRetryableKind` in `errors.ts`
 * is the same set unioned, and `retry.test.ts` asserts they agree — two lists that can disagree is
 * how a kind comes to be retryable in one place and permanent in the other.
 */
const BACKOFF_KINDS: ReadonlySet<ChannelErrorKind> = new Set<ChannelErrorKind>([
  'transient',
  // `ambiguous` may already have been delivered, so `06` §3.13's delivery verification runs first
  // and decides whether this send happens at all. When it does, it backs off like a transient.
  'ambiguous',
]);

export interface RetryState {
  /** Failures that counted. `rate_limited` ones do not (`06` §3.14). */
  readonly attempts: number;
}

/**
 * What to do after a failed send.
 *
 * Takes the **kind** and `retryAfterMs` rather than a `ChannelError`, so the engine can plan a
 * retry for a failure it reconstructed from an outbox row after a restart — where the original
 * error object is long gone but the row recorded what it was.
 */
export function planRetry(
  kind: ChannelErrorKind,
  state: RetryState,
  rng: Rng,
  retryAfterMs = 0,
): RetryPlan {
  if (kind === 'rate_limited') {
    return {
      action: 'retry',
      delayMs: retryDelayMs(state.attempts + 1, rng, retryAfterMs),
      countsAsAttempt: false,
    };
  }
  if (kind === 'chat_migrated') {
    // `06` §3.15: "newPlatformChatId set; retry immediately on new id". A backoff here would delay
    // every message to a group that Telegram upgraded to a supergroup, for no reason: the first
    // send failed because the id changed, and the new id is in hand.
    return { action: 'retry', delayMs: 0, countsAsAttempt: false };
  }
  if (!BACKOFF_KINDS.has(kind)) {
    return { action: 'fail', delayMs: 0, countsAsAttempt: false };
  }
  const attempt = state.attempts + 1;
  return attempt >= MAX_TRANSIENT_ATTEMPTS
    ? { action: 'defer', delayMs: DEFER_MS, countsAsAttempt: true }
    : { action: 'retry', delayMs: retryDelayMs(attempt, rng, retryAfterMs), countsAsAttempt: true };
}
