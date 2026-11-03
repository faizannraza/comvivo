/**
 * The `Clock` port.
 *
 * `01` §4 and §11.4: `core` is pure, and `Date` is banned there by lint. Time arrives as a
 * dependency instead. That is not stylistic — it is what makes the parts of this product that are
 * hardest to get right testable at all:
 *
 *  - recurrence across a DST boundary, for a family split over three timezones;
 *  - quiet hours, which must hold per member in their own zone;
 *  - the attention budget, which is a rate over a day that someone has to be able to replay;
 *  - fair chore rotation, where "whose turn is it" depends on when the last one closed.
 *
 * A `VirtualClock` (`11` §3.1.7, implemented in `M0-T7`) drives 30 virtual days of a family's life
 * in under five seconds. None of that works if a module reads the wall clock.
 *
 * Implementations: `SystemClock` in `M1-T3`, `VirtualClock` in `M0-T7`.
 */
import type { Temporal } from 'temporal-polyfill';

export interface Clock {
  /** The current instant. Always UTC; render into a zone at the edge, never in the middle. */
  now(): Temporal.Instant;
}

/**
 * Drivable timers, for the worker and scheduler loops.
 *
 * Separate from `Clock` because `core` needs the clock and must never get timers: scheduling is a
 * side effect, and `core` has none. Lives in `shared` so `engine` and `storage` can both take it.
 */
export interface TimerHandle {
  readonly id: number;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}
