/**
 * `SystemClock` and `SystemTimers`.
 *
 * Small surface, and the tests are mostly about the two properties the rest of the product relies
 * on: the clock truncates to milliseconds (because `02` §3.1 stores every instant as `INTEGER`
 * epoch ms, so anything finer does not survive a round trip), and `SystemTimers` does not leak
 * handles (because the scheduler and the worker loop run for months).
 */
import { Temporal } from 'temporal-polyfill';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SystemClock, SystemTimers, systemClock } from './clock.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('SystemClock', () => {
  it('returns the current instant', () => {
    const before = Date.now();
    const now = new SystemClock().now().epochMilliseconds;
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  it('truncates to whole milliseconds, which is what storage can hold', () => {
    // `02` §3.1: every instant column is `INTEGER` epoch milliseconds. A clock with finer
    // resolution would produce values that change when written and read back, and the failing test
    // would look like a storage bug rather than a clock one.
    const now = new SystemClock().now();
    expect(Number.isInteger(now.epochMilliseconds)).toBe(true);
    expect(now.epochNanoseconds % 1_000_000n).toBe(0n);
  });

  it('returns a Temporal.Instant, not a Date', () => {
    expect(new SystemClock().now()).toBeInstanceOf(Temporal.Instant);
  });

  it('is in UTC, with the zone applied at the edge', () => {
    // `01` §4: instants are UTC and rendered into a zone at the boundary, never in the middle.
    // Doing it the other way round is how a reminder fires an hour late for one member of a
    // family split across zones.
    const instant = new SystemClock().now();
    expect(instant.toString()).toMatch(/Z$/);
  });

  it('exports a shared instance, since it holds no state', () => {
    expect(systemClock.now()).toBeInstanceOf(Temporal.Instant);
  });

  it('advances', () => {
    vi.useFakeTimers();
    const clock = new SystemClock();
    const first = clock.now();
    vi.advanceTimersByTime(5_000);
    expect(clock.now().epochMilliseconds - first.epochMilliseconds).toBe(5_000);
  });
});

describe('SystemTimers', () => {
  it('runs a callback after the delay', () => {
    vi.useFakeTimers();
    const timers = new SystemTimers();
    let ran = false;
    timers.setTimeout(() => {
      ran = true;
    }, 1_000);
    expect(ran).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(ran).toBe(true);
  });

  it('hands out a plain numeric handle, so a handle can cross the port boundary', () => {
    // A structure carrying a live Node `Timeout` would make the scheduler and the worker loop
    // impossible to drive from a `VirtualClock`.
    vi.useFakeTimers();
    const timers = new SystemTimers();
    const handle = timers.setTimeout(() => undefined, 1_000);
    expect(typeof handle.id).toBe('number');
    expect(JSON.stringify(handle)).toBe(`{"id":${String(handle.id)}}`);
  });

  it('cancels a pending timer', () => {
    vi.useFakeTimers();
    const timers = new SystemTimers();
    let ran = false;
    const handle = timers.setTimeout(() => {
      ran = true;
    }, 1_000);
    timers.clearTimeout(handle);
    vi.advanceTimersByTime(5_000);
    expect(ran).toBe(false);
    expect(timers.pending).toBe(0);
  });

  it('forgets a timer once it has fired, so the map cannot grow forever', () => {
    // A long-lived process sets a lot of timers. Keeping the entries would be a slow leak in the
    // one part of the product that is meant to run for months without a restart.
    vi.useFakeTimers();
    const timers = new SystemTimers();
    timers.setTimeout(() => undefined, 10);
    expect(timers.pending).toBe(1);
    vi.advanceTimersByTime(10);
    expect(timers.pending).toBe(0);
  });

  it('lets a callback schedule another timer without confusing the handles', () => {
    vi.useFakeTimers();
    const timers = new SystemTimers();
    const order: string[] = [];
    timers.setTimeout(() => {
      order.push('first');
      timers.setTimeout(() => order.push('second'), 10);
    }, 10);
    vi.advanceTimersByTime(10);
    expect(order).toEqual(['first']);
    expect(timers.pending).toBe(1);
    vi.advanceTimersByTime(10);
    expect(order).toEqual(['first', 'second']);
    expect(timers.pending).toBe(0);
  });

  it('ignores a cancel for a handle that already fired or was cancelled', () => {
    // Double-cancel happens on shutdown races. Throwing there would turn an orderly stop into a
    // crash report.
    vi.useFakeTimers();
    const timers = new SystemTimers();
    const handle = timers.setTimeout(() => undefined, 10);
    timers.clearTimeout(handle);
    expect(() => timers.clearTimeout(handle)).not.toThrow();
    expect(() => timers.clearTimeout({ id: 9_999 })).not.toThrow();
  });

  it('cancels everything on clearAll, for shutdown', () => {
    vi.useFakeTimers();
    const timers = new SystemTimers();
    let ran = 0;
    for (let i = 0; i < 5; i += 1) {
      timers.setTimeout(() => {
        ran += 1;
      }, 10);
    }
    expect(timers.pending).toBe(5);
    timers.clearAll();
    expect(timers.pending).toBe(0);
    vi.advanceTimersByTime(100);
    expect(ran).toBe(0);
  });

  it('gives each timer a distinct handle', () => {
    vi.useFakeTimers();
    const timers = new SystemTimers();
    const handles = Array.from({ length: 10 }, () => timers.setTimeout(() => undefined, 10).id);
    expect(new Set(handles).size).toBe(10);
  });
});
