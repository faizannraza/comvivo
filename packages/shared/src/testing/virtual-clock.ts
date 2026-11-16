/**
 * `VirtualClock` — time under test control.
 *
 * `11` §3.1.7. The rule that makes this work: **time is frozen during `await`.** Virtual time moves
 * only through `advance` or `advanceTo`, even when the thing being awaited takes real seconds. That
 * is what lets `11` §8 budget "30 virtual days of a family world in ≤ 5 s": a simulated week of
 * reminders, digests and quiet hours costs nothing but the work itself.
 *
 * It is also the only way to test the parts of this product that are genuinely hard:
 *
 *  - recurrence across a DST boundary, for a family split over three timezones;
 *  - quiet hours, which must hold per member in their own zone;
 *  - the attention budget, a rate over a day that someone has to be able to replay;
 *  - fair rotation, where "whose turn" depends on when the last one closed.
 *
 * Latency measurements therefore use `performance.now()`, never this clock (`11` §3.1.7).
 */
import { Temporal } from 'temporal-polyfill';
import type { Clock, TimerHandle, Timers } from '../ports/clock.js';

/**
 * How many microtask hops a flush gives a continuation chain.
 *
 * One hop per `await` in the chain the fired timer started. Two was the original figure and it was
 * too few for anything real: the typing manager's refresh loop awaits a rate-limit acquire, then the
 * adapter call, then returns through two frames — about six hops — so the `setTimeout` for the next
 * refresh was registered *after* `advanceTo` had given up looking for due timers and jumped the
 * clock to its target. The symptom is a loop that stops after two iterations, which reads as a bug
 * in the code under test rather than in the clock driving it.
 *
 * Draining further is also the more faithful model, not a looser one: a real event loop empties the
 * microtask queue completely before the next macrotask, so the shallow flush was the inaccuracy.
 * Sixty-four, raised from sixteen at `M3-T9`: a conformance case drives a **multi-part** send,
 * which is one chain of roughly six hops per part plus the frames above it, so three parts
 * already pass sixteen. The cost is nothing — a microtask hop on an empty queue is a few
 * nanoseconds — and the failure it prevents reads as a hung adapter rather than as a short
 * flush. A chain deeper than this appears to stall, and the fix is this number rather than a
 * sleep in a test.
 */
const MICROTASK_FLUSH_HOPS = 64;

async function flushMicrotasks(): Promise<void> {
  for (let hop = 0; hop < MICROTASK_FLUSH_HOPS; hop += 1) await Promise.resolve();
}

interface ScheduledTimer {
  readonly handle: TimerHandle;
  /** Epoch nanoseconds at which it is due. */
  readonly dueAt: bigint;
  /** Insertion order, so two timers due at the same instant fire in the order they were set. */
  readonly seq: number;
  readonly fn: () => void;
}

export class VirtualClock implements Clock, Timers {
  #now: Temporal.Instant;
  #timers: ScheduledTimer[] = [];
  #nextId = 1;
  #seq = 0;

  constructor(start: Temporal.Instant | string = '2026-01-01T00:00:00Z') {
    this.#now = typeof start === 'string' ? Temporal.Instant.from(start) : start;
  }

  now(): Temporal.Instant {
    return this.#now;
  }

  /** How many timers are still pending. A non-zero count at the end of a test is usually a leak. */
  get pending(): number {
    return this.#timers.length;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`setTimeout needs a non-negative delay, got ${String(ms)}`);
    }
    const handle: TimerHandle = { id: this.#nextId };
    this.#nextId += 1;
    this.#seq += 1;
    this.#timers.push({
      handle,
      dueAt: this.#now.epochNanoseconds + BigInt(Math.round(ms)) * 1_000_000n,
      seq: this.#seq,
      fn,
    });
    return handle;
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers = this.#timers.filter((timer) => timer.handle.id !== handle.id);
  }

  /** When the next timer is due, or `null` if nothing is pending. */
  nextDueAt(): Temporal.Instant | null {
    if (this.#timers.length === 0) return null;
    const soonest = this.#timers.reduce((a, b) =>
      b.dueAt < a.dueAt || (b.dueAt === a.dueAt && b.seq < a.seq) ? b : a,
    );
    return new Temporal.Instant(soonest.dueAt);
  }

  /**
   * Move time forward, firing every timer that comes due **in order**, with a microtask flush
   * between each.
   *
   * The flush matters: a fired timer usually resolves a promise, and the continuation must run
   * before the next timer fires. Without it a reminder's follow-up work would be queued behind a
   * later timer, and the test would observe an ordering the production event loop never produces.
   *
   * A timer set *by* a firing timer is honoured if it comes due within the same advance, so
   * self-rescheduling loops (the scheduler, the digest sweep) behave as they do in production. The
   * iteration cap turns a runaway "every 0 ms" loop into a clear failure rather than a hang.
   */
  async advance(
    duration: Temporal.Duration | Temporal.DurationLike | string,
    maxIterations = 100_000,
  ): Promise<void> {
    // `DurationLike` as well as a `Duration`, so `advance({ minutes: 10 })` works. It used to be
    // refused, and the refusal was confusing rather than helpful: a plain object fell through the
    // `typeof === 'string'` check unconverted, `span.weeks` read `undefined`, and the calendar
    // guard below reported "[object Object] contains a calendar unit whose length depends on a
    // timezone" about an object containing only minutes. The guard still applies after conversion,
    // which is where it belongs.
    const span =
      duration instanceof Temporal.Duration ? duration : Temporal.Duration.from(duration);

    // `advance` moves **elapsed** time: a day is exactly 24 hours. Weeks, months and years have no
    // unambiguous elapsed length — across a DST transition a calendar day is 23 or 25 hours — so
    // they are refused rather than silently approximated. Calendar arithmetic ("tomorrow at 8am in
    // her timezone", which is what a morning brief actually means) goes through
    // `advanceTo(ZonedDateTime)`, where a zone is present to resolve it.
    if (span.weeks !== 0 || span.months !== 0 || span.years !== 0) {
      throw new RangeError(
        `advance() takes elapsed time, and ${span.toString()} contains a calendar unit whose ` +
          'length depends on a timezone. Use advance("PT…H") for elapsed time, or ' +
          'advanceTo(ZonedDateTime) for calendar time.',
      );
    }

    const nanos = BigInt(Math.round(span.total({ unit: 'nanosecond' })));
    await this.advanceTo(new Temporal.Instant(this.#now.epochNanoseconds + nanos), maxIterations);
  }

  /** Move time to an exact instant (or zoned time), firing timers along the way. */
  async advanceTo(
    target: Temporal.Instant | Temporal.ZonedDateTime | string,
    maxIterations = 100_000,
  ): Promise<void> {
    const to =
      typeof target === 'string'
        ? Temporal.Instant.from(target)
        : target instanceof Temporal.ZonedDateTime
          ? target.toInstant()
          : target;

    if (Temporal.Instant.compare(to, this.#now) < 0) {
      throw new RangeError(
        `time cannot run backwards: tried to advance to ${to.toString()} from ${this.#now.toString()}`,
      );
    }

    for (let i = 0; i < maxIterations; i += 1) {
      const due = this.#timers
        .filter((timer) => timer.dueAt <= to.epochNanoseconds)
        .sort((a, b) => (a.dueAt === b.dueAt ? a.seq - b.seq : a.dueAt < b.dueAt ? -1 : 1));
      const next = due[0];
      if (next === undefined) break;

      this.#timers = this.#timers.filter((timer) => timer.handle.id !== next.handle.id);
      this.#now = new Temporal.Instant(next.dueAt);
      next.fn();
      await flushMicrotasks();
    }

    this.#now = to;
    await flushMicrotasks();
  }

  /**
   * Advance exactly to the next due timer, or do nothing if none is pending.
   *
   * Lets a test step through a schedule one event at a time without knowing the intervals, which is
   * how the scheduler and outbox model-based tests drive their interleavings.
   */
  async tick(): Promise<boolean> {
    const due = this.nextDueAt();
    if (due === null) return false;
    await this.advanceTo(due);
    return true;
  }

  /** Drop every pending timer. For a test that is deliberately abandoning work mid-flight. */
  clearAll(): void {
    this.#timers = [];
  }
}
