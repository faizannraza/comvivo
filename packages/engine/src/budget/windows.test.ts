/**
 * Budget windows (`05` §3.9.3; `M3-T30`).
 *
 * Every expected instant here was **measured** against this repo's `temporal-polyfill` and the
 * IANA database rather than worked out by hand, because the whole subject of the module is cases
 * where hand arithmetic is wrong. The zones are chosen for what each one breaks:
 *
 *  - **Europe/Madrid** on the two transition days: a 23-hour local day and a 25-hour one, which is
 *    where `add({hours: 24})` lands an hour out in opposite directions;
 *  - **Australia/Lord_Howe**: a *half*-hour DST shift, so a 23.5-hour day — the case that passes
 *    when somebody "fixes" the above by special-casing ±1 h;
 *  - **America/Havana**: a transition at 00:00, so the next local midnight **does not exist** and
 *    the day starts at 01:00;
 *  - **Pacific/Honolulu** and **Pacific/Auckland**: the local date is the day before and the day
 *    after the UTC date, which is what makes a UTC-keyed rollup wrong rather than merely
 *    off-by-hours.
 */
import { parseTimeZoneId, type TimeZoneId } from '@comvivo/shared';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { budgetWindows, dailyWindow, localDay, monthlyWindow } from './windows.js';

const at = (iso: string): Temporal.Instant => Temporal.Instant.from(iso);

/**
 * A `TimeZoneId`, or a thrown error.
 *
 * Throwing matters here: `parseTimeZoneId` returns `undefined` for a name it does not recognise,
 * and a typo in `Australia/Lord_Howe` that fell through as `UTC` would make every assertion below
 * pass for a reason that has nothing to do with the code under test.
 */
function zone(id: string): TimeZoneId {
  const parsed = parseTimeZoneId(id);
  if (parsed === undefined) throw new Error(`${id} is not a timezone this runtime knows`);
  return parsed;
}

/** Hours between two instants, as a number, for the day-length assertions. */
function hoursBetween(from: Temporal.Instant, to: Temporal.Instant): number {
  return Number(to.epochMilliseconds - from.epochMilliseconds) / 3_600_000;
}

describe('localDay (02 §3.3.7)', () => {
  it('is the group’s date, which is not always the UTC date', () => {
    // The two directions, and both are ordinary rather than exotic: at 06:00 UTC it is still
    // yesterday in Honolulu and already tomorrow in Auckland. A rollup keyed by the UTC date would
    // put a Honolulu family's evening and the next morning in the same bucket, and split an
    // Auckland family's single day across two.
    expect(localDay(at('2026-11-14T06:00:00Z'), zone('Pacific/Honolulu'))).toBe('2026-11-13');
    expect(localDay(at('2026-11-14T11:30:00Z'), zone('Pacific/Auckland'))).toBe('2026-11-15');
    expect(localDay(at('2026-11-14T06:00:00Z'), zone('UTC'))).toBe('2026-11-14');
  });
});

describe('dailyWindow (05 §3.9.3)', () => {
  it('covers exactly the current local day', () => {
    const window = dailyWindow(at('2026-11-14T06:00:00Z'), zone('Pacific/Honolulu'));
    expect(window.period).toBe('day');
    expect(window.fromDay).toBe('2026-11-13');
    expect(window.toDay).toBe('2026-11-13');
  });

  it('resets at the next local midnight on a 23-hour day', () => {
    // Madrid springs forward at 02:00 on 2027-03-28, so that local day is 23 hours long. Measured:
    // it begins at 2027-03-27T23:00Z and the next midnight is 2027-03-28T22:00Z.
    const window = dailyWindow(at('2027-03-28T10:00:00Z'), zone('Europe/Madrid'));
    expect(window.fromDay).toBe('2027-03-28');
    expect(window.resetAt.toString()).toBe('2027-03-28T22:00:00Z');
    expect(hoursBetween(at('2027-03-27T23:00:00Z'), window.resetAt)).toBe(23);
  });

  it('resets at the next local midnight on a 25-hour day', () => {
    // And the other direction, on 2026-10-25. The same `add({hours: 24})` that was an hour early
    // above would be an hour late here, which is why the arithmetic is calendar-based rather than
    // corrected by a constant.
    const window = dailyWindow(at('2026-10-25T10:00:00Z'), zone('Europe/Madrid'));
    expect(window.resetAt.toString()).toBe('2026-10-25T23:00:00Z');
    expect(hoursBetween(at('2026-10-24T22:00:00Z'), window.resetAt)).toBe(25);
  });

  it('handles a half-hour shift, which no ±1 h special case would', () => {
    // Lord Howe moves by thirty minutes, so 2026-10-04 is 23.5 hours long.
    const window = dailyWindow(at('2026-10-04T02:00:00Z'), zone('Australia/Lord_Howe'));
    expect(window.fromDay).toBe('2026-10-04');
    expect(window.resetAt.toString()).toBe('2026-10-04T13:00:00Z');
    expect(hoursBetween(at('2026-10-03T13:30:00Z'), window.resetAt)).toBe(23.5);
  });

  it('resets at 01:00 when the next local midnight does not exist', () => {
    // Havana springs forward **at midnight** on 2026-03-08, so 00:00 is not a time that day.
    // `startOfDay` answers 01:00, which is the only defensible reading of "when does the budget
    // come back": the first instant of the day.
    const window = dailyWindow(at('2026-03-07T20:00:00Z'), zone('America/Havana'));
    expect(window.fromDay).toBe('2026-03-07');
    expect(window.resetAt.toString()).toBe('2026-03-08T05:00:00Z');
    expect(window.resetAt.toZonedDateTimeISO(zone('America/Havana')).toPlainTime().toString()).toBe(
      '01:00:00',
    );
  });
});

describe('monthlyWindow (05 §3.9.3)', () => {
  it('covers the whole calendar month and resets at the next month’s first instant', () => {
    const window = monthlyWindow(at('2026-11-14T11:30:00Z'), zone('Pacific/Auckland'));
    expect(window.period).toBe('month');
    expect(window.fromDay).toBe('2026-11-01');
    expect(window.toDay).toBe('2026-11-30');
    // 2026-12-01T00:00+13:00.
    expect(window.resetAt.toString()).toBe('2026-11-30T11:00:00Z');
  });

  it('knows how long each month is, February included', () => {
    expect(monthlyWindow(at('2027-02-10T00:00:00Z'), zone('UTC')).toDay).toBe('2027-02-28');
    // 2028 is a leap year, which is the one a hard-coded 28 gets wrong for three years at a time.
    expect(monthlyWindow(at('2028-02-10T00:00:00Z'), zone('UTC')).toDay).toBe('2028-02-29');
    expect(monthlyWindow(at('2026-04-10T00:00:00Z'), zone('UTC')).toDay).toBe('2026-04-30');
  });

  it('crosses a DST boundary inside the month without moving the reset', () => {
    // March in Madrid contains the spring-forward, and the month still ends at the first instant
    // of April — 2027-04-01T00:00+02:00, which is 22:00Z on the 31st.
    const window = monthlyWindow(at('2027-03-28T10:00:00Z'), zone('Europe/Madrid'));
    expect(window.fromDay).toBe('2027-03-01');
    expect(window.toDay).toBe('2027-03-31');
    expect(window.resetAt.toString()).toBe('2027-03-31T22:00:00Z');
  });

  it('spans the month even on its first and last local day', () => {
    // The first day and the last, because a range built from "today" rather than from the month
    // would be a month-to-date range wearing a month's name — and would read as the full month on
    // the 31st, which is when nobody is looking.
    const first = monthlyWindow(at('2026-11-01T00:30:00Z'), zone('UTC'));
    const last = monthlyWindow(at('2026-11-30T23:30:00Z'), zone('UTC'));
    expect([first.fromDay, first.toDay]).toEqual(['2026-11-01', '2026-11-30']);
    expect([last.fromDay, last.toDay]).toEqual(['2026-11-01', '2026-11-30']);
  });
});

describe('budgetWindows', () => {
  it('returns the day first and the month second, so neither can be forgotten', () => {
    // `05` §3.9.3's trigger column is "either window". A caller that fetched one would apply half
    // the ladder, so there is one call that returns both.
    const [day, month] = budgetWindows(at('2026-11-14T06:00:00Z'), zone('Pacific/Honolulu'));
    expect([day.period, month.period]).toEqual(['day', 'month']);
    expect(day.fromDay).toBe('2026-11-13');
    expect(month.fromDay).toBe('2026-11-01');
    // The day sits inside the month, which is the invariant that makes "either window" coherent.
    expect(day.fromDay >= month.fromDay && day.toDay <= month.toDay).toBe(true);
  });
});
