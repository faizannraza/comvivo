/**
 * `schedule.next.test` (`M1-T24`; `02` §3.10.5, §9.1).
 *
 * `02` §9.1 names seven cases and every one of them is here, because each is a zone behaviour that
 * breaks a naive implementation in a different direction:
 *
 *  - a **gap** that swallows the scheduled wall time;
 *  - an **overlap** that offers it twice;
 *  - a weekly schedule crossing a transition, where the day is right and the hour moves;
 *  - a **30-minute** DST offset, which breaks anything assuming whole hours;
 *  - a **45-minute** zone offset, which breaks anything assuming whole hours *without* DST;
 *  - a **skipped calendar day**, where the date itself does not exist;
 *  - an **impossible** date, which must be refused rather than searched for forever.
 */
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { StorageError } from '../errors.js';
import { nextFireAfter } from './schedule.js';

/** The fire time as a wall clock in `tz`, which is what a schedule is actually stated in. */
function wall(instant: Temporal.Instant, tz: string): string {
  return instant.toZonedDateTimeISO(tz).toPlainDateTime().toString({ smallestUnit: 'minute' });
}

function at(iso: string): Temporal.Instant {
  return Temporal.Instant.from(iso);
}

/**
 * A start instant given as a **wall clock in the zone**.
 *
 * A schedule is stated in local terms, so a test's starting point should be too. Written as an
 * offset instead, two of these cases were wrong in a way that looked like a bug in the evaluator:
 * `2011-12-28T00:00+13:00` is 2011-12-27 in Apia, because Samoa was at **−11:00** before the date
 * line crossing — the very change the case is about.
 */
function localStart(tz: string, local: string): Temporal.Instant {
  return Temporal.PlainDateTime.from(local).toZonedDateTime(tz).toInstant();
}

describe('02 §9.1`s named cases', () => {
  it('shifts a daily 02:30 forward through America/New_York`s spring gap', () => {
    const tz = 'America/New_York';
    // 2026-03-08: the clocks go 01:59 → 03:00, so **02:30 does not exist**. `02` §3.10.5 says the
    // occurrence fires at 03:30 — shifted forward by the gap — rather than being dropped, because
    // a daily schedule that skipped a day would silently lose that day's digest.
    const fired = nextFireAfter(
      { kind: 'daily', at: '02:30' },
      at('2026-03-08T00:00:00-05:00'),
      tz,
    );
    expect(wall(fired, tz)).toBe('2026-03-08T03:30');
    // And the day after is back to normal, which proves the shift was local to the gap.
    expect(wall(nextFireAfter({ kind: 'daily', at: '02:30' }, fired, tz), tz)).toBe(
      '2026-03-09T02:30',
    );
  });

  it('fires a daily 01:30 once across America/New_York`s autumn overlap', () => {
    const tz = 'America/New_York';
    // 2026-11-01: 01:30 happens **twice**, once in EDT (-04:00) and once in EST (-05:00).
    const fired = nextFireAfter(
      { kind: 'daily', at: '01:30' },
      at('2026-11-01T00:00:00-04:00'),
      tz,
    );
    expect(wall(fired, tz)).toBe('2026-11-01T01:30');
    // The **earlier** instant, which is `02` §3.10.5's rule.
    expect(fired.toString()).toBe('2026-11-01T05:30:00Z');
    // The next occurrence is the following day — **not** the second 01:30 an hour later. Firing at
    // both would deliver the same morning brief twice.
    const next = nextFireAfter({ kind: 'daily', at: '01:30' }, fired, tz);
    expect(wall(next, tz)).toBe('2026-11-02T01:30');
  });

  it('keeps a Europe/London weekly Sunday 01:30 on Sunday across 2026-10-25', () => {
    const tz = 'Europe/London';
    // Britain's clocks go back at 02:00 on 2026-10-25, so 01:30 happens twice that Sunday. The
    // weekday must still be Sunday and the fire must happen once.
    const fired = nextFireAfter(
      { kind: 'weekly', weekdays: [7], at: '01:30' },
      at('2026-10-19T00:00:00Z'),
      tz,
    );
    const zoned = fired.toZonedDateTimeISO(tz);
    expect(zoned.toPlainDate().toString()).toBe('2026-10-25');
    expect(zoned.dayOfWeek).toBe(7);
    expect(wall(fired, tz)).toBe('2026-10-25T01:30');
    // A week later, and still Sunday — the transition did not shift the weekday.
    const next = nextFireAfter({ kind: 'weekly', weekdays: [7], at: '01:30' }, fired, tz);
    expect(next.toZonedDateTimeISO(tz).dayOfWeek).toBe(7);
    expect(next.toZonedDateTimeISO(tz).toPlainDate().toString()).toBe('2026-11-01');
  });

  it('handles Australia/Lord_Howe`s 30-minute DST shift', () => {
    const tz = 'Australia/Lord_Howe';
    // Lord Howe Island shifts by **thirty** minutes, which breaks any implementation that assumes
    // a transition is an hour — and its gap on the first Sunday in October is 02:00 → 02:30.
    const fired = nextFireAfter(
      { kind: 'daily', at: '02:15' },
      localStart(tz, '2026-10-04T00:00'),
      tz,
    );
    const zoned = fired.toZonedDateTimeISO(tz);
    expect(zoned.toPlainDate().toString()).toBe('2026-10-04');
    // Inside the half-hour gap, so it is shifted forward **by the gap's length** — 02:15 + 0:30 =
    // 02:45. Not "the first instant that exists", which would be 02:30: `02` §3.10.5's wording is
    // "shifted forward by the gap", and for New York that is what makes a missing 02:30 fire at
    // 03:30 rather than at 03:00. The two rules agree whenever the schedule sits at the start of
    // the gap and differ otherwise, which is exactly what a 30-minute transition exposes.
    expect(zoned.hour).toBe(2);
    expect(zoned.minute).toBe(45);
    // And a date well away from the transition is exactly 02:15.
    expect(
      wall(
        nextFireAfter({ kind: 'daily', at: '02:15' }, localStart(tz, '2026-06-01T12:00'), tz),
        tz,
      ),
    ).toBe('2026-06-02T02:15');
  });

  it('handles Asia/Kathmandu`s 45-minute offset', () => {
    const tz = 'Asia/Kathmandu';
    // +05:45, and no DST. Nothing shifts — which is the point: a 45-minute offset breaks code that
    // converts by whole hours, and the symptom would be a digest 15 minutes early every day.
    const fired = nextFireAfter(
      { kind: 'daily', at: '07:30' },
      localStart(tz, '2026-05-01T00:00'),
      tz,
    );
    expect(wall(fired, tz)).toBe('2026-05-01T07:30');
    expect(fired.toString()).toBe('2026-05-01T01:45:00Z');
  });

  it('fires on the next day that exists when Pacific/Apia skips one', () => {
    const tz = 'Pacific/Apia';
    // Samoa crossed the date line on 2011-12-29 → 2011-12-31: **2011-12-30 never happened.** A
    // daily schedule must fire on the 29th and then on the 31st, and an implementation that walked
    // forward a calendar day at a time without checking would land on a date with no instants.
    const first = nextFireAfter(
      { kind: 'daily', at: '09:00' },
      localStart(tz, '2011-12-28T12:00'),
      tz,
    );
    expect(wall(first, tz)).toBe('2011-12-29T09:00');
    const second = nextFireAfter({ kind: 'daily', at: '09:00' }, first, tz);
    // The 30th does not exist, so the next occurrence is the 31st — and it is exactly 09:00 there,
    // because the skipped day is a date change rather than a gap in the clock.
    expect(wall(second, tz)).toBe('2011-12-31T09:00');
    expect(second.toZonedDateTimeISO(tz).dayOfWeek).toBe(6);
  });

  it('refuses a date that can never occur', () => {
    // `0 9 30 2 *` is 09:00 on February 30th. `02` §3.10.5: `SCHEDULE_NO_NEXT`. Refusing is the
    // only honest answer — searching would run to the bound and time out a scheduler tick, and
    // returning *something* would fire a schedule nobody asked for.
    let caught: unknown;
    try {
      nextFireAfter({ kind: 'cron', expr: '0 9 30 2 *' }, at('2026-01-01T00:00:00Z'), 'UTC');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StorageError);
    expect((caught as StorageError).storageCode).toBe('SCHEDULE_NO_NEXT');
    // February 29th *can* occur, so the neighbouring case must still work — otherwise the bound
    // would be rejecting leap days too.
    expect(
      nextFireAfter(
        { kind: 'cron', expr: '0 9 29 2 *' },
        at('2026-01-01T00:00:00Z'),
        'UTC',
      ).toString(),
    ).toBe('2028-02-29T09:00:00Z');
  });
});

describe('the overlap re-check (02 §3.10.5)', () => {
  it('does not return an instant before the one it was given, in a repeated hour', () => {
    const tz = 'America/New_York';
    // The case that makes the re-check load-bearing, and the only one: a **sub-hourly** cron during
    // the autumn overlap. 2026-11-01 01:30 happens twice — 05:30Z in EDT and 06:30Z in EST — and
    // `compatible` always resolves a wall time to the **earlier** of the two. So a caller already
    // past 05:30Z asks for the next occurrence and the wall-clock search offers 01:30 again, whose
    // resolution is an instant in the **past**.
    //
    // A daily or weekly schedule cannot reach this, because a wall time appears once per calendar
    // day in the search. Without a cron case, deleting the re-check changes nothing any test can
    // see — which is how it was found.
    const after = Temporal.Instant.from('2026-11-01T06:00:00Z');
    const fired = nextFireAfter({ kind: 'cron', expr: '*/30 * * * *' }, after, tz);
    expect(Temporal.Instant.compare(fired, after)).toBe(1);
    // 02:00 local. The 01:30 occurrence **already happened**, at 05:30Z, and `02` §3.10.5's rule
    // is that it fires once — so the next one is 02:00, not the second 01:30.
    expect(fired.toString()).toBe('2026-11-01T07:00:00Z');
    expect(wall(fired, tz)).toBe('2026-11-01T02:00');
  });

  it('skips the repeated hour rather than running it twice', () => {
    const tz = 'America/New_York';
    // The consequence of "fires once", written down because it is surprising and permanent: a
    // sub-hourly **wall-clock** schedule loses the repeated hour. `*/30` fires at 01:00 and 01:30
    // EDT and then not again until 02:00 EST — a one-hour gap, once a year.
    //
    // That is the right trade for a schedule stated in local terms (a digest must not arrive
    // twice), and it is why `02` §3.10.5 has a zone-free `interval` arm: work that must run every
    // thirty minutes regardless — polling the Batches API, probing a channel's auth — belongs
    // there, where elapsed time is the unit and no hour is ever repeated or missing.
    let cursor = Temporal.Instant.from('2026-11-01T04:59:00Z');
    const seen: string[] = [];
    for (let step = 0; step < 6; step += 1) {
      const next = nextFireAfter({ kind: 'cron', expr: '*/30 * * * *' }, cursor, tz);
      expect(Temporal.Instant.compare(next, cursor)).toBe(1);
      seen.push(next.toString());
      cursor = next;
    }
    expect(seen).toEqual([
      '2026-11-01T05:00:00Z',
      '2026-11-01T05:30:00Z',
      // 06:00Z and 06:30Z — the repeated 01:00 and 01:30 — are not fired.
      '2026-11-01T07:00:00Z',
      '2026-11-01T07:30:00Z',
      '2026-11-01T08:00:00Z',
      '2026-11-01T08:30:00Z',
    ]);
    // Each wall time appears exactly once, which is the guarantee; the gap is its cost.
    const walls = seen.map((iso) => wall(Temporal.Instant.from(iso), tz));
    expect(walls).toEqual([
      '2026-11-01T01:00',
      '2026-11-01T01:30',
      '2026-11-01T02:00',
      '2026-11-01T02:30',
      '2026-11-01T03:00',
      '2026-11-01T03:30',
    ]);
    expect(new Set(walls).size).toBe(walls.length);
    // And an `interval` schedule covers the hour the wall-clock one skipped, which is the point of
    // having both arms.
    const everyHalfHour = nextFireAfter(
      { kind: 'interval', everyMs: 1_800_000 },
      Temporal.Instant.from('2026-11-01T05:30:00Z'),
      tz,
    );
    expect(everyHalfHour.toString()).toBe('2026-11-01T06:00:00Z');
  });
});

describe('the cron field matcher (02 §3.10.5)', () => {
  const from = at('2026-01-01T00:00:00Z');
  const fire = (expr: string, start = from) =>
    nextFireAfter({ kind: 'cron', expr }, start, 'UTC').toString();

  it('reads numbers, ranges, steps and lists', () => {
    expect(fire('30 9 * * *')).toBe('2026-01-01T09:30:00Z');
    expect(fire('0 0 1 * *')).toBe('2026-02-01T00:00:00Z');
    expect(fire('*/15 * * * *')).toBe('2026-01-01T00:15:00Z');
    expect(fire('0 9-17 * * *')).toBe('2026-01-01T09:00:00Z');
    expect(fire('0 0 * * 1')).toBe('2026-01-05T00:00:00Z');
    expect(fire('0 6,18 * * *')).toBe('2026-01-01T06:00:00Z');
    // A step over a range, which is the form that catches an off-by-one in the parser.
    expect(fire('0 8-20/6 * * *')).toBe('2026-01-01T08:00:00Z');
    expect(fire('0 8-20/6 * * *', at('2026-01-01T09:00:00Z'))).toBe('2026-01-01T14:00:00Z');
  });

  it('treats both 0 and 7 as Sunday', () => {
    // Every cron implementation accepts both, and a schedule written `* * * * 7` by hand should
    // not silently never fire.
    expect(fire('0 0 * * 0')).toBe('2026-01-04T00:00:00Z');
    expect(fire('0 0 * * 7')).toBe('2026-01-04T00:00:00Z');
  });

  it('unions the day fields when both are restricted', () => {
    // The rule that surprises everybody: with **both** day-of-month and day-of-week restricted, a
    // classic cron matches either. `0 0 13 * 5` is "the 13th, **or** any Friday" — not "Friday the
    // 13th". An intersection here would make a monthly report that also runs weekly fire almost
    // never, and it would look like a scheduling bug rather than a reading of cron.
    expect(fire('0 0 13 * 5')).toBe('2026-01-02T00:00:00Z');
    // Restricting only one keeps it an ordinary filter.
    expect(fire('0 0 13 * *')).toBe('2026-01-13T00:00:00Z');
    expect(fire('0 0 * * 5')).toBe('2026-01-02T00:00:00Z');
  });

  it('does not clamp when it steps over a short month', () => {
    // January 31st plus a month is February 28th if the day is not reset first — and the search
    // would then skip the first 27 days of February. `0 0 5 * *` from the 31st must find the 5th.
    expect(fire('0 0 5 * *', at('2026-01-31T12:00:00Z'))).toBe('2026-02-05T00:00:00Z');
    expect(fire('0 0 1 3 *', at('2026-01-31T12:00:00Z'))).toBe('2026-03-01T00:00:00Z');
  });

  it('refuses a field it cannot read', () => {
    for (const expr of ['0 9 * *', '70 9 * * *', '0 25 * * *', '0 9 * * 9', '0 9-5 * * *']) {
      expect(() => fire(expr), expr).toThrow(StorageError);
    }
  });
});

describe('interval schedules', () => {
  it('adds elapsed time, with no zone', () => {
    const start = at('2026-03-08T06:30:00Z');
    // `02` §3.10.5's `interval` arm carries no `tz`, and that is the design: "every 15 minutes"
    // means elapsed time. Resolving it against a wall clock would skip or repeat an occurrence
    // across a transition — exactly what the `daily` arm is *for*.
    expect(nextFireAfter({ kind: 'interval', everyMs: 900_000 }, start, 'UTC').toString()).toBe(
      '2026-03-08T06:45:00Z',
    );
    // The same answer in a zone that is mid-transition at that instant.
    expect(
      nextFireAfter({ kind: 'interval', everyMs: 900_000 }, start, 'America/New_York').toString(),
    ).toBe('2026-03-08T06:45:00Z');
  });
});

describe('the strictness of `after`', () => {
  it('never returns the instant it was given', () => {
    const tz = 'Europe/Berlin';
    const exact = nextFireAfter({ kind: 'daily', at: '09:00' }, at('2026-05-01T00:00:00Z'), tz);
    // The scheduler calls this with the occurrence it has just fired, so an inclusive comparison
    // would return the same instant forever and the schedule would fire in a loop.
    expect(
      Temporal.Instant.compare(nextFireAfter({ kind: 'daily', at: '09:00' }, exact, tz), exact),
    ).toBe(1);
  });
});
