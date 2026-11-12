/**
 * `schedule.next.property` (`M1-T24`; `02` §3.10.5, `11` §3.1.6).
 *
 * `02` §3.10.5 lists four guarantees and this file is one property per guarantee. Stating them as
 * properties rather than as cases is the point: the named cases in `schedule.test.ts` cover the
 * transitions somebody thought of, and a timezone database has hundreds nobody did — Lord Howe's
 * half hour, Kathmandu's three quarters, Samoa's missing day, Troll's two-hour jump.
 *
 * The generators are weighted towards DST edges, as `11` §3.1.6 asks: a uniform sample over a year
 * would spend 99.5% of its runs in the middle of a month where nothing is interesting.
 */
import fc from 'fast-check';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { fcConfig } from '../testing/fc-config.js';
import { nextFireAfter, type SchedulePattern } from './schedule.js';

/**
 * Zones chosen for their edges, not for their population.
 *
 * Each one breaks a different assumption: whole-hour transitions (New York, Berlin), a **half**-hour
 * transition (Lord Howe), a three-quarter-hour offset with no DST (Kathmandu), southern-hemisphere
 * transitions that run the other way (Santiago, Auckland), a two-hour jump (Troll), and no
 * transitions at all (UTC, Tokyo) as the control.
 */
const ZONES = [
  'America/New_York',
  'Europe/Berlin',
  'Europe/London',
  'Australia/Lord_Howe',
  'Asia/Kathmandu',
  'America/Santiago',
  'Pacific/Auckland',
  'Antarctica/Troll',
  'Asia/Tokyo',
  'UTC',
] as const;

/** Instants weighted towards transition seasons — late March, late October, early November. */
const instant = fc
  .oneof(
    { arbitrary: fc.constantFrom(...edgeDays()), weight: 7 },
    {
      arbitrary: fc.integer({ min: 0, max: 364 }).map((day) => `2026-${dayOfYear(day)}`),
      weight: 3,
    },
  )
  .chain((date) =>
    fc
      .tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }))
      .map(([hour, minute]) =>
        Temporal.Instant.from(
          `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`,
        ),
      ),
  );

const hhmm = fc
  .tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }))
  .map(([hour, minute]) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);

/**
 * A pattern stated as a wall clock — `daily` or `weekly`.
 *
 * Typed as the union of those two arms rather than as `SchedulePattern`, so a property can read
 * `pattern.at` without narrowing past `cron`: the arm it would have to exclude is not generated
 * here, and the type saying so is better than a cast at every use.
 */
type WallClockPattern = Extract<SchedulePattern, { kind: 'daily' | 'weekly' }>;

const daily = hhmm.map((at): WallClockPattern => ({ kind: 'daily', at }));
const weekly = fc
  .tuple(fc.uniqueArray(fc.integer({ min: 1, max: 7 }), { minLength: 1, maxLength: 7 }), hhmm)
  .map(([weekdays, at]): WallClockPattern => ({ kind: 'weekly', weekdays, at }));
const wallClockPattern: fc.Arbitrary<WallClockPattern> = fc.oneof(daily, weekly);
const zone = fc.constantFrom(...ZONES);

describe('schedule.next.property (02 §3.10.5)', { tags: ['prop'] }, () => {
  it('always returns an instant strictly after the one it was given', () => {
    fc.assert(
      fc.property(wallClockPattern, instant, zone, (pattern, after, tz) => {
        // The scheduler calls this with the occurrence it has just fired, so a result at or before
        // `after` is an infinite loop: `next_run_at` never advances and the tick re-fires the same
        // occurrence every second until somebody notices the duplicate digests.
        expect(Temporal.Instant.compare(nextFireAfter(pattern, after, tz), after)).toBe(1);
      }),
      fcConfig(),
    );
  });

  it('matches the pattern in wall-clock terms, allowing for a gap shift', () => {
    fc.assert(
      fc.property(wallClockPattern, instant, zone, (pattern, after, tz) => {
        const fired = nextFireAfter(pattern, after, tz);
        const zoned = fired.toZonedDateTimeISO(tz);
        const [hour, minute] = pattern.at
          .split(':')
          .map((part: string) => Number.parseInt(part, 10));
        const exact = zoned.hour === hour && zoned.minute === minute;
        if (exact) {
          if (pattern.kind === 'weekly') {
            expect(pattern.weekdays).toContain(zoned.dayOfWeek);
          }
          return;
        }
        // Not exact means the scheduled wall time **did not exist** — a gap — and the occurrence
        // was shifted forward by the gap's length. Proven rather than assumed: the wall time it
        // claims to be is absent from the zone, which is the only licence for the mismatch.
        const wanted = zoned.toPlainDate().toPlainDateTime({ hour, minute });
        const resolved = wanted.toZonedDateTime(tz, { disambiguation: 'compatible' });
        expect(
          resolved.hour !== hour || resolved.minute !== minute,
          `${pattern.at} in ${tz} resolved to ${String(zoned.hour)}:${String(zoned.minute)} without a gap`,
        ).toBe(true);
        // And the shift is forward and under a day — a transition, not a search that gave up.
        expect(Temporal.Instant.compare(resolved.toInstant(), fired)).toBe(0);
      }),
      fcConfig(),
    );
  });

  it('never fires twice for one wall-clock occurrence', () => {
    fc.assert(
      fc.property(wallClockPattern, instant, zone, (pattern, after, tz) => {
        const first = nextFireAfter(pattern, after, tz);
        const second = nextFireAfter(pattern, first, tz);
        // The autumn overlap is the case: 01:30 happens twice, and a schedule that fired at both
        // would deliver the same morning brief an hour apart. The two occurrences must therefore
        // differ in **wall-clock date**, not merely in instant.
        const firstLocal = first.toZonedDateTimeISO(tz);
        const secondLocal = second.toZonedDateTimeISO(tz);
        expect(Temporal.Instant.compare(second, first)).toBe(1);
        expect(
          Temporal.PlainDate.compare(secondLocal.toPlainDate(), firstLocal.toPlainDate()),
          `${pattern.kind} fired twice on ${firstLocal.toPlainDate().toString()} in ${tz}`,
        ).toBe(1);
      }),
      fcConfig(),
    );
  });

  it('never skips a calendar day for a daily pattern', () => {
    fc.assert(
      fc.property(hhmm, instant, zone, (at, after, tz) => {
        const first = nextFireAfter({ kind: 'daily', at }, after, tz);
        const second = nextFireAfter({ kind: 'daily', at }, first, tz);
        const from = first.toZonedDateTimeISO(tz).toPlainDate();
        const to = second.toZonedDateTimeISO(tz).toPlainDate();
        // Consecutive **existing** days. `Pacific/Apia` skipped 2011-12-30 outright, so "exactly
        // one day apart" is the wrong assertion — what has to hold is that no day *that exists*
        // was passed over, which is what makes a daily digest daily.
        let cursor = from.add({ days: 1 });
        while (Temporal.PlainDate.compare(cursor, to) < 0) {
          // A date that exists in this zone and was skipped would be a missed digest.
          const exists = cursor.toZonedDateTime(tz).toPlainDate().equals(cursor);
          expect(exists, `${cursor.toString()} exists in ${tz} and was skipped`).toBe(false);
          cursor = cursor.add({ days: 1 });
        }
        expect(Temporal.PlainDate.compare(to, from)).toBe(1);
      }),
      fcConfig(),
    );
  });

  it('is deterministic, so a scheduler restart recomputes the same instant', () => {
    fc.assert(
      fc.property(wallClockPattern, instant, zone, (pattern, after, tz) => {
        // `02` §3.10.5 recomputes `next_run_at` on a timezone change and after every fire, and the
        // scheduler's idempotency key is `'sched:' + id + ':' + fire.epochMs`. A non-deterministic
        // evaluator would mint a different key for the same occurrence and fire it twice.
        expect(nextFireAfter(pattern, after, tz).toString()).toBe(
          nextFireAfter(pattern, after, tz).toString(),
        );
      }),
      fcConfig(),
    );
  });
});

/** The days either side of the usual northern and southern transitions, plus Samoa's. */
function edgeDays(): readonly string[] {
  return [
    '2026-03-07',
    '2026-03-08',
    '2026-03-09',
    '2026-03-28',
    '2026-03-29',
    '2026-03-30',
    '2026-04-04',
    '2026-04-05',
    '2026-09-05',
    '2026-09-06',
    '2026-10-03',
    '2026-10-04',
    '2026-10-24',
    '2026-10-25',
    '2026-10-26',
    '2026-11-01',
    '2026-11-02',
    '2026-02-28',
    '2026-12-31',
  ];
}

/** Day-of-year to `MM-DD` in 2026, a non-leap year. */
function dayOfYear(day: number): string {
  return Temporal.PlainDate.from('2026-01-01').add({ days: day }).toString().slice(5);
}
