/**
 * `VirtualClock` properties (`11` §3.1.7).
 *
 * Every deterministic test in this project trusts this class, so its guarantees need checking
 * against arbitrary inputs rather than the handful of delays a person would think to write down.
 * The ordering property is the one that matters: a reminder and the follow-up work it schedules
 * must fire in due order for **any** set of delays, because `07`'s digests and `02`'s outbox
 * retries both read ordering as semantics.
 */

import fc from 'fast-check';
import { Temporal } from 'temporal-polyfill';

import { describe, expect, it } from 'vitest';
import { fcConfig } from './fc-config.js';
import { VirtualClock } from './virtual-clock.js';

/**
 * Durations are built from **integer milliseconds**, never from a fractional-seconds string.
 *
 * `PT${ms / 1000}S` looks harmless and is not: `7316 / 1000` formats as `7.316`, but
 * `8874 / 1000` can format as `8.874000000000001`, and Temporal rejects more than nine fractional
 * digits with "Fractional time exceeds nine digits". The property test found that on its tenth
 * case — a reminder of why these tests are worth writing even for a helper.
 */
const after = (ms: number): Temporal.Duration => Temporal.Duration.from({ milliseconds: ms });

/** Delays a scheduler might plausibly use, including several at the same instant. */
const delays = fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 1, maxLength: 40 });

/** Elapsed spans, in milliseconds, kept small enough to stay inside a single advance. */
const spans = fc.array(fc.integer({ min: 0, max: 5_000 }), { minLength: 1, maxLength: 20 });

describe('VirtualClock properties', { tags: ['prop'] }, () => {
  it('fires every timer exactly once when time passes all of them', async () => {
    await fc.assert(
      fc.asyncProperty(delays, async (ms) => {
        const clock = new VirtualClock();
        const fired: number[] = [];
        ms.forEach((delay, index) => {
          clock.setTimeout(() => fired.push(index), delay);
        });

        await clock.advance(after(Math.max(...ms) + 1));

        expect(fired).toHaveLength(ms.length);
        expect([...fired].sort((a, b) => a - b)).toEqual(ms.map((_, i) => i));
        expect(clock.pending).toBe(0);
      }),
      fcConfig(),
    );
  });

  it('fires in non-decreasing due order, ties broken by insertion order', async () => {
    // The property the digest sweep and the outbox both depend on. A timer due at the same instant
    // as another must fire in the order it was set, or two reminders scheduled in one turn arrive
    // reversed.
    await fc.assert(
      fc.asyncProperty(delays, async (ms) => {
        const clock = new VirtualClock();
        const fired: { delay: number; index: number }[] = [];
        ms.forEach((delay, index) => {
          clock.setTimeout(() => fired.push({ delay, index }), delay);
        });

        await clock.advance(after(Math.max(...ms) + 1));

        const expected = ms
          .map((delay, index) => ({ delay, index }))
          .sort((a, b) => a.delay - b.delay || a.index - b.index);
        expect(fired).toEqual(expected);
      }),
      fcConfig(),
    );
  });

  it('advances by exactly the elapsed time it is given', async () => {
    await fc.assert(
      fc.asyncProperty(spans, async (steps) => {
        const start = Temporal.Instant.from('2026-01-01T00:00:00Z');
        const clock = new VirtualClock(start);
        for (const ms of steps) {
          await clock.advance(after(ms));
        }
        const total = steps.reduce((sum, ms) => sum + ms, 0);
        expect(clock.now().epochMilliseconds - start.epochMilliseconds).toBe(total);
      }),
      fcConfig(),
    );
  });

  it('never fires a cleared timer, however many are pending', async () => {
    await fc.assert(
      fc.asyncProperty(delays, fc.nat(), async (ms, pick) => {
        const clock = new VirtualClock();
        const fired: number[] = [];
        const handles = ms.map((delay, index) => clock.setTimeout(() => fired.push(index), delay));

        const cleared = pick % ms.length;
        const handle = handles[cleared];
        if (handle === undefined) return;
        clock.clearTimeout(handle);
        // Clearing twice must be harmless: a cancelled reminder is cancelled again on shutdown.
        clock.clearTimeout(handle);

        await clock.advance(after(Math.max(...ms) + 1));

        expect(fired).not.toContain(cleared);
        expect(fired).toHaveLength(ms.length - 1);
      }),
      fcConfig(),
    );
  });

  it('reports the soonest due time, or null when nothing is pending', async () => {
    await fc.assert(
      fc.asyncProperty(delays, async (ms) => {
        const clock = new VirtualClock();
        const start = clock.now().epochMilliseconds;
        for (const delay of ms) clock.setTimeout(() => {}, delay);

        const due = clock.nextDueAt();
        expect(due).not.toBeNull();
        expect((due?.epochMilliseconds ?? 0) - start).toBe(Math.min(...ms));

        clock.clearAll();
        expect(clock.nextDueAt()).toBeNull();
        expect(clock.pending).toBe(0);
      }),
      fcConfig(),
    );
  });
});
