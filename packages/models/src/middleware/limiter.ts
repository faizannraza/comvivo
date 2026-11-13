/**
 * The priority limiter (`05` §3.3.3, §3.5.1 stage 1; `M2-T9`).
 *
 * A global cap of four concurrent model calls, served in priority order, with **two slots reserved
 * for interactive routes**. The reservation is the part worth reading: without it, a nightly
 * consolidation of two hundred memories fills every slot and a member who types a question waits
 * behind a background job. `05` §3.3.3's order — `chat` > `guard` > `declassify` > `route` >
 * `extract` > `consolidate` — is a ranking of "somebody is waiting for this".
 *
 * ## Why a queue and not a semaphore
 *
 * A plain semaphore is first-come-first-served, so the order the calls happened to arrive in
 * decides who waits. A queue sorted by priority means a `chat` call that arrives while four
 * `extract` calls are queued goes next, which is the behaviour a member experiences as "it
 * answered".
 *
 * FIFO **within** a priority, because two members asking at the same moment should be served in the
 * order they asked. Ties broken by arrival sequence, not by `Promise` scheduling order, which is
 * not something to rely on.
 */
import type { ModelRoute } from '@comvivo/core';

/** `05` §3.3.3's order, most urgent first. The index is the priority. */
export const ROUTE_PRIORITY: readonly ModelRoute[] = [
  'chat',
  'guard',
  'declassify',
  'route',
  'extract',
  'consolidate',
];

/**
 * The routes a member is waiting on, which the reserved slots are for.
 *
 * `route` is deliberately **not** here even though it runs on the turn path: it is cheap, it runs
 * on Haiku, and reserving a slot for it would leave one slot for everything else. `05` §3.3.3 names
 * these three.
 */
export const INTERACTIVE_ROUTES: ReadonlySet<ModelRoute> = new Set(['chat', 'guard', 'declassify']);

export const LIMITER_DEFAULTS = {
  /** The spine's global model-call limit. */
  maxConcurrent: 4,
  /** Of those, how many only an interactive route may take. */
  reservedForInteractive: 2,
} as const;

export interface LimiterOptions {
  readonly maxConcurrent?: number;
  readonly reservedForInteractive?: number;
}

export function priorityOf(route: ModelRoute): number {
  const index = ROUTE_PRIORITY.indexOf(route);
  // An unknown route sorts last rather than first. A new route added without touching this list
  // should wait behind the ones a member is watching, not jump them.
  return index === -1 ? ROUTE_PRIORITY.length : index;
}

interface Waiter {
  readonly route: ModelRoute;
  readonly priority: number;
  readonly sequence: number;
  readonly release: () => void;
}

/**
 * A priority queue over a fixed number of slots.
 *
 * One instance per process, shared by every provider: the spine's limit of four is about *this
 * host's* outbound concurrency, not about one provider's rate limit. Per-provider back-pressure is
 * the breaker's and the `retry-after` header's business.
 */
export class PriorityLimiter {
  readonly #max: number;
  readonly #reserved: number;
  readonly #waiting: Waiter[] = [];
  #inFlight = 0;
  #interactiveInFlight = 0;
  #sequence = 0;

  constructor(options: LimiterOptions = {}) {
    this.#max = options.maxConcurrent ?? LIMITER_DEFAULTS.maxConcurrent;
    this.#reserved = options.reservedForInteractive ?? LIMITER_DEFAULTS.reservedForInteractive;
    if (this.#reserved > this.#max) {
      throw new RangeError(
        `reservedForInteractive (${String(this.#reserved)}) cannot exceed maxConcurrent ` +
          `(${String(this.#max)}): every slot would be reserved and no background route could run.`,
      );
    }
  }

  /** How many calls are running. */
  get inFlight(): number {
    return this.#inFlight;
  }

  /** How many calls are queued. A standing non-zero value means the host is under-provisioned. */
  get queued(): number {
    return this.#waiting.length;
  }

  /**
   * Run `fn` when a slot is free.
   *
   * The slot is released in a `finally`, so a throwing call does not leak one — which would
   * otherwise degrade the host permanently after a handful of provider errors.
   */
  async run<T>(route: ModelRoute, fn: () => Promise<T>): Promise<T> {
    await this.#acquire(route);
    try {
      return await fn();
    } finally {
      this.#release(route);
    }
  }

  /** Whether a route may take a slot right now. */
  #canStart(route: ModelRoute): boolean {
    if (this.#inFlight >= this.#max) return false;
    if (INTERACTIVE_ROUTES.has(route)) return true;
    // A background route may only use the unreserved slots. Counting from `inFlight` rather than
    // from a separate counter keeps the two from drifting.
    const unreserved = this.#max - this.#reserved;
    const backgroundInFlight = this.#inFlight - this.#interactiveInFlight;
    return backgroundInFlight < unreserved;
  }

  #acquire(route: ModelRoute): Promise<void> {
    if (this.#canStart(route)) {
      this.#take(route);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#sequence += 1;
      this.#waiting.push({
        route,
        priority: priorityOf(route),
        sequence: this.#sequence,
        release: resolve,
      });
    });
  }

  #take(route: ModelRoute): void {
    this.#inFlight += 1;
    if (INTERACTIVE_ROUTES.has(route)) this.#interactiveInFlight += 1;
  }

  #release(route: ModelRoute): void {
    this.#inFlight -= 1;
    if (INTERACTIVE_ROUTES.has(route)) this.#interactiveInFlight -= 1;
    this.#pump();
  }

  /**
   * Admit whoever is next and may go.
   *
   * It scans rather than popping the head, because the head may be a background route that the
   * reservation still blocks while an interactive waiter behind it can start. Scanning in sorted
   * order and admitting the first eligible waiter is what makes the reservation a reservation
   * rather than a suggestion.
   */
  #pump(): void {
    for (;;) {
      this.#waiting.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
      const index = this.#waiting.findIndex((waiter) => this.#canStart(waiter.route));
      if (index === -1) return;
      const [waiter] = this.#waiting.splice(index, 1);
      if (waiter === undefined) return;
      this.#take(waiter.route);
      waiter.release();
    }
  }
}
