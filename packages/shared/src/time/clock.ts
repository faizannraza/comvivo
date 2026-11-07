/**
 * `SystemClock` and `SystemTimers` — the real implementations of the `Clock` and `Timers` ports
 * (`02` §3.1, `01` §4).
 *
 * Deliberately tiny, and deliberately the **only** place in the product that reads the wall clock.
 * Everything else takes a `Clock`, which is what lets `11` §3.1.7's `VirtualClock` run thirty
 * virtual days of a family's life in five seconds — and what makes recurrence across a DST
 * boundary, quiet hours per member in their own zone, and "whose turn is it" testable at all.
 *
 * `core` cannot even import this: `01` §4 bans `node:*` there and the core-purity lint bans
 * `Date`, so a module that wants the time has to say so in its constructor.
 */
import { Temporal } from 'temporal-polyfill';
import type { Clock, TimerHandle, Timers } from '../ports/clock.js';

/**
 * The wall clock, truncated to milliseconds.
 *
 * Millisecond truncation is `02` §3.1's rule, not an accident of the implementation: every instant
 * column is `INTEGER` epoch milliseconds, so a clock with microsecond resolution would produce
 * values that do not survive a round trip through storage — and tests comparing a written instant
 * to the one in hand would fail in a way that looks like a storage bug.
 */
export class SystemClock implements Clock {
  now(): Temporal.Instant {
    return Temporal.Instant.fromEpochMilliseconds(Date.now());
  }
}

/** A shared instance, because it holds no state. */
export const systemClock: Clock = new SystemClock();

/**
 * Node's timers behind the `Timers` port.
 *
 * `Timeout` objects are kept in a map rather than handed out, so a `TimerHandle` stays a plain
 * number: handles cross the port boundary into the scheduler and the worker loop, and a structure
 * carrying a live Node object would make those modules impossible to drive from a `VirtualClock`.
 */
export class SystemTimers implements Timers {
  readonly #pending = new Map<number, NodeJS.Timeout>();
  #next = 1;

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.#next;
    this.#next += 1;
    const timeout = setTimeout(() => {
      // Drop the entry before running, so a callback that schedules another timer cannot be
      // confused by a stale handle, and a long-lived process does not grow this map forever.
      this.#pending.delete(id);
      fn();
    }, ms);
    this.#pending.set(id, timeout);
    return { id };
  }

  clearTimeout(handle: TimerHandle): void {
    const timeout = this.#pending.get(handle.id);
    if (timeout === undefined) return;
    this.#pending.delete(handle.id);
    clearTimeout(timeout);
  }

  /** How many timers are outstanding. For leak assertions in tests and for `comvivo doctor`. */
  get pending(): number {
    return this.#pending.size;
  }

  /** Cancel everything, for shutdown. */
  clearAll(): void {
    for (const timeout of this.#pending.values()) clearTimeout(timeout);
    this.#pending.clear();
  }
}
