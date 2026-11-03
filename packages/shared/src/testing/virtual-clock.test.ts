/**
 * `VirtualClock` (`11` §3.1.7). The behaviours the whole simulation harness rests on: time moves
 * only when told, timers fire in order, and a microtask flush runs between them.
 */
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { VirtualClock } from './virtual-clock.js';

describe('now', () => {
  it('starts where it was told to', () => {
    expect(new VirtualClock('2026-06-01T12:00:00Z').now().toString()).toBe('2026-06-01T12:00:00Z');
  });

  it('accepts an Instant as well as a string', () => {
    const instant = Temporal.Instant.from('2027-01-01T00:00:00Z');
    expect(new VirtualClock(instant).now().equals(instant)).toBe(true);
  });

  it('does NOT move on its own, even across a real await', () => {
    // The guarantee that makes "30 virtual days in ≤ 5 s" possible (`11` §8), and the reason
    // latency is measured with performance.now() instead of this clock.
    const clock = new VirtualClock('2026-06-01T12:00:00Z');
    const before = clock.now().toString();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(clock.now().toString()).toBe(before);
        resolve();
      }, 5);
    });
  });
});

describe('advance', () => {
  it('moves time by a duration', async () => {
    const clock = new VirtualClock('2026-06-01T12:00:00Z');
    await clock.advance('PT1H30M');
    expect(clock.now().toString()).toBe('2026-06-01T13:30:00Z');
  });

  it('accepts a Temporal.Duration', async () => {
    const clock = new VirtualClock('2026-06-01T12:00:00Z');
    await clock.advance(Temporal.Duration.from({ days: 2 }));
    expect(clock.now().toString()).toBe('2026-06-03T12:00:00Z');
  });

  it('treats a day as exactly 24 hours, because advance is ELAPSED time', async () => {
    const clock = new VirtualClock('2026-11-01T00:00:00Z');
    await clock.advance('P1D');
    expect(clock.now().toString()).toBe('2026-11-02T00:00:00Z');
  });

  it('refuses a calendar unit, which has no fixed elapsed length', async () => {
    // Across a DST transition a calendar day is 23 or 25 hours, and a month is anything from 28 to
    // 31 days. Silently approximating would fire a weekly recap on the wrong day twice a year, so
    // the caller is sent to advanceTo(ZonedDateTime) instead.
    const clock = new VirtualClock();
    await expect(clock.advance('P1W')).rejects.toThrow(/calendar unit/);
    await expect(clock.advance('P1M')).rejects.toThrow(/advanceTo\(ZonedDateTime\)/);
    await expect(clock.advance('P1Y')).rejects.toThrow(/calendar unit/);
  });

  it('fires a timer that comes due', async () => {
    const clock = new VirtualClock();
    let fired = false;
    clock.setTimeout(() => {
      fired = true;
    }, 1000);
    await clock.advance('PT2S');
    expect(fired).toBe(true);
  });

  it('does not fire a timer that is not due yet', async () => {
    const clock = new VirtualClock();
    let fired = false;
    clock.setTimeout(() => {
      fired = true;
    }, 5000);
    await clock.advance('PT1S');
    expect(fired).toBe(false);
    expect(clock.pending).toBe(1);
  });

  it('fires timers in due order, not in the order they were set', async () => {
    const clock = new VirtualClock();
    const order: string[] = [];
    clock.setTimeout(() => order.push('third'), 300);
    clock.setTimeout(() => order.push('first'), 100);
    clock.setTimeout(() => order.push('second'), 200);
    await clock.advance('PT1S');
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('breaks a tie by insertion order, so two reminders at one instant are stable', async () => {
    const clock = new VirtualClock();
    const order: string[] = [];
    clock.setTimeout(() => order.push('a'), 100);
    clock.setTimeout(() => order.push('b'), 100);
    clock.setTimeout(() => order.push('c'), 100);
    await clock.advance('PT1S');
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it("sets the clock to each timer's due instant as it fires", async () => {
    const clock = new VirtualClock('2026-06-01T00:00:00Z');
    const seen: string[] = [];
    clock.setTimeout(() => seen.push(clock.now().toString()), 1000);
    clock.setTimeout(() => seen.push(clock.now().toString()), 3000);
    await clock.advance('PT10S');
    expect(seen).toEqual(['2026-06-01T00:00:01Z', '2026-06-01T00:00:03Z']);
  });

  it('flushes microtasks between timers, so a continuation runs before the next one', async () => {
    // Without the flush, work a fired timer queued would land behind a later timer and the test
    // would observe an ordering the production event loop never produces.
    const clock = new VirtualClock();
    const order: string[] = [];
    clock.setTimeout(() => {
      order.push('timer-1');
      void Promise.resolve().then(() => order.push('after-1'));
    }, 100);
    clock.setTimeout(() => order.push('timer-2'), 200);
    await clock.advance('PT1S');
    expect(order).toEqual(['timer-1', 'after-1', 'timer-2']);
  });

  it('honours a timer set by a firing timer, so self-rescheduling loops work', async () => {
    // The scheduler and the digest sweep both re-arm themselves; they must behave here as they do
    // in production.
    const clock = new VirtualClock();
    let ticks = 0;
    const rearm = (): void => {
      ticks += 1;
      if (ticks < 5) clock.setTimeout(rearm, 100);
    };
    clock.setTimeout(rearm, 100);
    await clock.advance('PT1S');
    expect(ticks).toBe(5);
  });

  it('lands exactly on the target even when the last timer fires earlier', async () => {
    const clock = new VirtualClock('2026-06-01T00:00:00Z');
    clock.setTimeout(() => undefined, 500);
    await clock.advance('PT10S');
    expect(clock.now().toString()).toBe('2026-06-01T00:00:10Z');
  });

  it('turns a runaway zero-delay loop into a clear failure rather than a hang', async () => {
    const clock = new VirtualClock();
    const spin = (): void => {
      clock.setTimeout(spin, 0);
    };
    clock.setTimeout(spin, 0);
    // The cap stops it; the point is that the test finishes instead of hanging CI for 45 minutes.
    await clock.advance('PT1S', 50);
    expect(clock.pending).toBeGreaterThan(0);
  });
});

describe('advanceTo', () => {
  it('moves to an exact instant', async () => {
    const clock = new VirtualClock('2026-06-01T00:00:00Z');
    await clock.advanceTo('2026-12-25T09:00:00Z');
    expect(clock.now().toString()).toBe('2026-12-25T09:00:00Z');
  });

  it('accepts a zoned time, which is how quiet hours are expressed', async () => {
    const clock = new VirtualClock('2026-06-01T00:00:00Z');
    await clock.advanceTo(Temporal.ZonedDateTime.from('2026-06-01T22:00:00[America/Los_Angeles]'));
    expect(clock.now().toString()).toBe('2026-06-02T05:00:00Z');
  });

  it('refuses to run backwards', async () => {
    const clock = new VirtualClock('2026-06-01T12:00:00Z');
    await expect(clock.advanceTo('2026-01-01T00:00:00Z')).rejects.toThrow(/cannot run backwards/);
  });

  it('allows advancing to the current instant, which is a no-op', async () => {
    const clock = new VirtualClock('2026-06-01T12:00:00Z');
    await clock.advanceTo('2026-06-01T12:00:00Z');
    expect(clock.now().toString()).toBe('2026-06-01T12:00:00Z');
  });
});

describe('timers', () => {
  it('reports when the next one is due', () => {
    const clock = new VirtualClock('2026-06-01T00:00:00Z');
    expect(clock.nextDueAt()).toBeNull();
    clock.setTimeout(() => undefined, 5000);
    clock.setTimeout(() => undefined, 1000);
    expect(clock.nextDueAt()?.toString()).toBe('2026-06-01T00:00:01Z');
  });

  it('can be cleared before firing', async () => {
    const clock = new VirtualClock();
    let fired = false;
    const handle = clock.setTimeout(() => {
      fired = true;
    }, 100);
    clock.clearTimeout(handle);
    await clock.advance('PT1S');
    expect(fired).toBe(false);
    expect(clock.pending).toBe(0);
  });

  it('ignores clearing a handle that already fired', async () => {
    const clock = new VirtualClock();
    const handle = clock.setTimeout(() => undefined, 100);
    await clock.advance('PT1S');
    expect(() => clock.clearTimeout(handle)).not.toThrow();
  });

  it('steps to the next timer with tick, without knowing the interval', async () => {
    const clock = new VirtualClock('2026-06-01T00:00:00Z');
    const order: number[] = [];
    clock.setTimeout(() => order.push(1), 1000);
    clock.setTimeout(() => order.push(2), 7000);

    expect(await clock.tick()).toBe(true);
    expect(order).toEqual([1]);
    expect(clock.now().toString()).toBe('2026-06-01T00:00:01Z');

    expect(await clock.tick()).toBe(true);
    expect(order).toEqual([1, 2]);

    expect(await clock.tick()).toBe(false);
  });

  it('rejects a negative delay rather than firing immediately', () => {
    const clock = new VirtualClock();
    expect(() => clock.setTimeout(() => undefined, -1)).toThrow(/non-negative/);
  });

  it('accepts a zero delay, firing on the next advance', async () => {
    const clock = new VirtualClock();
    let fired = false;
    clock.setTimeout(() => {
      fired = true;
    }, 0);
    await clock.advance('PT0S');
    expect(fired).toBe(true);
  });

  it('drops everything on clearAll', async () => {
    const clock = new VirtualClock();
    clock.setTimeout(() => undefined, 100);
    clock.setTimeout(() => undefined, 200);
    clock.clearAll();
    expect(clock.pending).toBe(0);
  });
});

describe('across a DST boundary', () => {
  it('advances real elapsed time, not wall-clock hours', async () => {
    // 2026-11-01 is the US autumn transition: 01:00 PDT repeats as 01:00 PST, so local midnight to
    // local midnight is 25 hours. A clock that advanced "24 hours of wall time" would fire a daily
    // digest at the wrong local time — the exact bug this product must not have for a family split
    // across timezones.
    const clock = new VirtualClock('2026-11-01T06:00:00Z'); // 23:00 Oct 31 PDT
    const beforeLocal = clock.now().toZonedDateTimeISO('America/Los_Angeles');
    expect(beforeLocal.hour).toBe(23);

    await clock.advance('PT25H');
    const afterLocal = clock.now().toZonedDateTimeISO('America/Los_Angeles');
    expect(afterLocal.hour).toBe(23);
    expect(afterLocal.day).toBe(1);
  });
});
