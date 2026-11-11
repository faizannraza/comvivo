/**
 * Equal-jitter backoff (`02` §3.10.3, applied by §3.9 and §3.10).
 *
 * `02` states the formula once — `d = min(cap, base · 2^(attempts−1))`, `delay = d/2 + rng()·d/2`,
 * with `rng` injected so tests are deterministic — and then uses it in **two** places: the
 * transactional outbox's retry (§3.9, `base = 2 s`, `cap = 10 min`, `maxAttempts = 10`) and the job
 * queue's (§3.10.3, `base = 5 s`, `cap = 1 h`, `maxAttempts = 8`). So it lives here, in `core`,
 * rather than in either caller: two implementations of one formula would drift, and the drift would
 * show up as a retry storm on one of the two paths long after the change that caused it.
 *
 * ## Why equal jitter rather than full jitter
 *
 * Full jitter (`delay = rng() · d`) can return nearly zero, which turns a backoff into a hot loop
 * for an unlucky caller. Equal jitter keeps the floor at `d/2`, so the delay always grows while
 * still spreading retries that failed together — which is the case that matters here: a platform
 * outage fails every queued send at once, and without the jitter they would all come back at the
 * same instant and fail together again.
 */

/** `02` §3.9's outbox defaults. */
export const OUTBOX_BACKOFF = { baseMs: 2_000, capMs: 600_000, maxAttempts: 10 } as const;

/** `02` §3.10.1's job defaults. */
export const JOB_BACKOFF = { baseMs: 5_000, capMs: 3_600_000, maxAttempts: 8 } as const;

export interface BackoffPolicy {
  readonly baseMs: number;
  readonly capMs: number;
}

/**
 * How long to wait before attempt number `attempts + 1`, in milliseconds.
 *
 * `attempts` is the number already made, so the **first** retry (after one failure) waits around
 * `base`. A `retryAfterMs` from the platform overrides the computed delay **when it is larger**
 * (`02` §3.10.3): a server asking for a longer wait is telling us something we do not know, while
 * one asking for a shorter wait would let a client talk itself out of its own backoff.
 */
export function backoffMs(
  attempts: number,
  policy: BackoffPolicy,
  rng: () => number,
  retryAfterMs?: number,
): number {
  // `attempts - 1` because the exponent counts the *gaps*, not the tries: one failure means one
  // gap, at `base`. Clamped at zero so a caller that passes 0 does not get a half-base delay from
  // a negative exponent.
  const exponent = Math.max(0, attempts - 1);
  const ceiling = Math.min(policy.capMs, policy.baseMs * 2 ** exponent);
  const delay = ceiling / 2 + rng() * (ceiling / 2);
  return Math.max(Math.round(delay), retryAfterMs ?? 0);
}

/** Whether this failure has used up its attempts (`02` §3.9, §3.10.3). */
export function attemptsExhausted(attempts: number, maxAttempts: number): boolean {
  return attempts >= maxAttempts;
}
