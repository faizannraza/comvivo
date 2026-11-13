/**
 * The circuit breaker (`05` §3.5.1 stage 2, §3.5.3.10; `M2-T9`).
 *
 * One per provider. It opens after **5 consecutive infrastructure failures within 60 s** and goes
 * **half-open after 30 s**. Those numbers are `05` §3.5.1's; what this module adds is the answer to
 * a question the numbers do not settle: *which failures count?*
 *
 * ## Not every error is a breaker failure
 *
 * `05` §3.5.3.10's table is explicit, and the distinctions matter:
 *
 *  - A **429** is back-pressure, not a fault. The provider is up and told us when to come back; a
 *    breaker that opened on rate limits would turn a busy minute into a five-minute outage.
 *  - An **abort** is the caller's decision. Counting it would mean a member cancelling three
 *    questions in a row broke the provider.
 *  - A **400**, a **401**, a **403**, a **404** and a **413** are *our* bugs or the host's
 *    configuration. Opening the circuit would hide them behind a generic "provider unavailable"
 *    for thirty seconds and then fail the same way again.
 *
 * What counts is a timeout, a network failure, a 5xx, an overload and an unclassified error: the
 * failures where waiting actually helps.
 *
 * ## Consecutive, and within a window
 *
 * Both conditions, because either alone is wrong. Counting non-consecutively would let five
 * failures spread over an hour of healthy traffic open the circuit. Dropping the window would let a
 * provider that failed five times last Tuesday open it today.
 */
import { ModelCallError, type ModelCallErrorKind, type ProviderId } from '@comvivo/core';
import type { Clock } from '@comvivo/shared';

/**
 * Which failure kinds count toward opening the circuit (`05` §3.5.3.10's "breaker failure" column).
 *
 * A total `Record`, so a new `ModelCallErrorKind` is a compile error here rather than silently
 * counting — or silently not counting, which is the direction that leaves a dead provider in
 * rotation.
 */
export const COUNTS_TOWARD_BREAKER: Readonly<Record<ModelCallErrorKind, boolean>> = {
  // Waiting helps.
  timeout: true,
  network: true,
  overloaded: true,
  server: true,
  unknown: true,
  // Back-pressure: the provider is up and said when to come back.
  rate_limited: false,
  // The caller's decision.
  aborted: false,
  // Ours or the host's to fix; a circuit would hide it.
  bad_request: false,
  auth: false,
  permission: false,
  billing: false,
  model_not_found: false,
  request_too_large: false,
};

export const BREAKER_DEFAULTS = {
  /** Consecutive infrastructure failures that open the circuit. */
  threshold: 5,
  /** The window those failures must fall inside, in milliseconds. */
  windowMs: 60_000,
  /** How long the circuit stays open before a trial request is allowed. */
  cooldownMs: 30_000,
} as const;

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerOptions {
  readonly clock: Clock;
  readonly provider: ProviderId;
  readonly threshold?: number;
  readonly windowMs?: number;
  readonly cooldownMs?: number;
  /** Called on every state change, for `11` §3.10.2's metric and the admin notice. */
  readonly onStateChange?: (from: BreakerState, to: BreakerState, provider: ProviderId) => void;
}

/** Thrown instead of calling the provider while the circuit is open. */
export class CircuitOpenError extends ModelCallError {
  constructor(provider: ProviderId, retryAfterMs: number) {
    super('overloaded', provider, { retryAfterMs });
    this.name = 'CircuitOpenError';
  }
}

/**
 * A per-provider circuit breaker.
 *
 * The state machine is three states and four transitions, and the half-open one is the interesting
 * one: **a single trial request**. Letting several through would mean a provider coming back from an
 * outage is met with the whole backlog at once, which is how an outage repeats itself.
 */
export class CircuitBreaker {
  readonly #clock: Clock;
  readonly #provider: ProviderId;
  readonly #threshold: number;
  readonly #windowMs: number;
  readonly #cooldownMs: number;
  readonly #onStateChange: BreakerOptions['onStateChange'];

  #state: BreakerState = 'closed';
  /** Timestamps of the consecutive failures so far, oldest first. */
  #failures: number[] = [];
  #openedAtMs = 0;
  /** True while the half-open trial request is in flight, so only one goes through. */
  #trialInFlight = false;

  constructor(options: BreakerOptions) {
    this.#clock = options.clock;
    this.#provider = options.provider;
    this.#threshold = options.threshold ?? BREAKER_DEFAULTS.threshold;
    this.#windowMs = options.windowMs ?? BREAKER_DEFAULTS.windowMs;
    this.#cooldownMs = options.cooldownMs ?? BREAKER_DEFAULTS.cooldownMs;
    this.#onStateChange = options.onStateChange;
  }

  /** The state a caller or `doctor` would see, after accounting for an elapsed cooldown. */
  get state(): BreakerState {
    this.#maybeHalfOpen();
    return this.#state;
  }

  /** How many consecutive counting failures are on record. */
  get consecutiveFailures(): number {
    return this.#failures.length;
  }

  /**
   * Run `fn` through the breaker.
   *
   * A rejection is classified before it is counted, and then **rethrown unchanged**: the breaker
   * observes, it does not rewrite. A caller that needed to know a 429's `retry-after` must still
   * get the original error.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.#maybeHalfOpen();
    if (this.#state === 'open') {
      const waited = this.#clock.now().epochMilliseconds - this.#openedAtMs;
      throw new CircuitOpenError(this.#provider, Math.max(0, this.#cooldownMs - waited));
    }
    if (this.#state === 'half_open') {
      if (this.#trialInFlight) {
        // A second request during the trial is refused rather than queued: the point of the trial
        // is to learn with **one** request whether the provider is back.
        throw new CircuitOpenError(this.#provider, this.#cooldownMs);
      }
      this.#trialInFlight = true;
    }

    try {
      const result = await fn();
      this.#onSuccess();
      return result;
    } catch (error) {
      this.#onFailure(error);
      throw error;
    }
  }

  /** Force the circuit closed. For `doctor --fix` and for a test that needs a clean slate. */
  reset(): void {
    this.#failures = [];
    this.#trialInFlight = false;
    this.#transition('closed');
  }

  #onSuccess(): void {
    this.#failures = [];
    this.#trialInFlight = false;
    if (this.#state !== 'closed') this.#transition('closed');
  }

  #onFailure(error: unknown): void {
    this.#trialInFlight = false;
    const counts = error instanceof ModelCallError && COUNTS_TOWARD_BREAKER[error.kind];
    if (!counts) {
      // A non-counting failure does not reset the streak either: a 429 between two timeouts does
      // not make the provider healthy, and clearing the count there would stop the breaker opening
      // during exactly the kind of degraded minute it exists for.
      return;
    }
    const now = this.#clock.now().epochMilliseconds;
    this.#failures.push(now);
    this.#failures = this.#failures.filter((at) => now - at <= this.#windowMs);

    if (this.#state === 'half_open' || this.#failures.length >= this.#threshold) {
      this.#openedAtMs = now;
      if (this.#state !== 'open') this.#transition('open');
    }
  }

  /** Move `open` → `half_open` once the cooldown has elapsed. */
  #maybeHalfOpen(): void {
    if (this.#state !== 'open') return;
    const elapsed = this.#clock.now().epochMilliseconds - this.#openedAtMs;
    if (elapsed >= this.#cooldownMs) this.#transition('half_open');
  }

  #transition(to: BreakerState): void {
    const from = this.#state;
    if (from === to) return;
    this.#state = to;
    this.#onStateChange?.(from, to, this.#provider);
  }
}

/** One breaker per provider, created on first use. */
export class BreakerRegistry {
  readonly #options: Omit<BreakerOptions, 'provider'>;
  readonly #breakers = new Map<ProviderId, CircuitBreaker>();

  constructor(options: Omit<BreakerOptions, 'provider'>) {
    this.#options = options;
  }

  for(provider: ProviderId): CircuitBreaker {
    const existing = this.#breakers.get(provider);
    if (existing !== undefined) return existing;
    const breaker = new CircuitBreaker({ ...this.#options, provider });
    this.#breakers.set(provider, breaker);
    return breaker;
  }

  /** Every provider's state, for `doctor` and the dashboard's health panel. */
  states(): Readonly<Record<string, BreakerState>> {
    return Object.fromEntries([...this.#breakers].map(([provider, b]) => [provider, b.state]));
  }
}
