/**
 * Budget windows (`05` §3.9.3; `02` §3.3.7; `M3-T30`).
 *
 * `05` §3.9.3: "Daily (midnight to midnight in the group timezone) and monthly (calendar month in
 * the group timezone)." Both halves of that sentence matter, and the second one is the reason this
 * module exists rather than a `Date.now() - 86_400_000` at the call site.
 *
 * ## Why the group's zone, and not UTC
 *
 * A daily budget that reset at UTC midnight would reset at 1 a.m. for a family in Madrid and at
 * 4 p.m. for one in Auckland. The second case is the one that breaks: a group would spend its whole
 * daily allowance over breakfast, be told the budget was reached at lunchtime, and get it back in
 * the middle of the afternoon — on a schedule nobody could explain. `02` §3.3.7 stores the rollup
 * under a **local** day for this reason, and this module is what produces that key.
 *
 * ## Why a local day is not 24 hours
 *
 * A DST transition makes a local day 23 or 25 hours long, and in Lord Howe 23.5 or 24.5. Every
 * boundary here is therefore computed by **calendar arithmetic** — `add({days: 1}).startOfDay()`,
 * never `add({hours: 24})`. The difference is invisible for 363 days a year and then, twice a year,
 * a group's budget resets an hour early or an hour late, which is the kind of bug that gets
 * reported as "it stopped answering" and closed as unreproducible.
 */
import type { TimeZoneId } from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';

/** Which of `05` §3.9.3's two windows. Also the `{period}` in the member and admin copy. */
export type BudgetPeriod = 'day' | 'month';

/**
 * One window, as the inclusive range of local days `UsageReader.spend` takes, plus when it ends.
 *
 * Days rather than instants, because the rollup `02` §3.3.7 maintains is keyed by local day: the
 * guard runs on every turn and a scan of `usage_records` between two instants would grow without
 * bound. `resetAt` is an instant because it is shown to a person — `err.budget_member`'s
 * `{resetAt}` — and "when does this come back" is a moment, not a date.
 */
export interface BudgetWindow {
  readonly period: BudgetPeriod;
  /** `YYYY-MM-DD`, inclusive. */
  readonly fromDay: string;
  /** `YYYY-MM-DD`, inclusive. The current day or the last day of the current month. */
  readonly toDay: string;
  /** The first instant of the next window, in the group's zone. */
  readonly resetAt: Temporal.Instant;
}

/**
 * The group's local date for an instant, `YYYY-MM-DD` (`02` §3.3.7's `dayLocal`).
 *
 * The one function the **usage hook** needs: `UsageContext.dayLocal` is "supplied rather than
 * derived" precisely because only the caller knows the zone, and this is the caller's half.
 */
export function localDay(at: Temporal.Instant, zone: TimeZoneId): string {
  return at.toZonedDateTimeISO(zone).toPlainDate().toString();
}

/** Midnight to midnight in the group's zone (`05` §3.9.3). */
export function dailyWindow(at: Temporal.Instant, zone: TimeZoneId): BudgetWindow {
  const now = at.toZonedDateTimeISO(zone);
  const today = now.toPlainDate().toString();
  return {
    period: 'day',
    fromDay: today,
    toDay: today,
    // Calendar arithmetic, then `startOfDay`: on a 23-hour day `add({hours: 24})` would land in the
    // day after next, and on a 25-hour day it would land before the reset it is meant to be.
    resetAt: now.add({ days: 1 }).startOfDay().toInstant(),
  };
}

/** The calendar month in the group's zone (`05` §3.9.3). */
export function monthlyWindow(at: Temporal.Instant, zone: TimeZoneId): BudgetWindow {
  const today = at.toZonedDateTimeISO(zone).toPlainDate();
  const first = today.with({ day: 1 });
  return {
    period: 'month',
    fromDay: first.toString(),
    // The last day of **this** month, not today: the range is the window, and a monthly window
    // that ended today would be a month-to-date range wearing a month's name. No future rows
    // exist, so the two read the same today and only the first survives a clock skew.
    toDay: first.with({ day: first.daysInMonth }).toString(),
    // `startOfDay` through `toZonedDateTime`, which is the documented way to get a month's first
    // instant in a zone — and it is right even when that midnight is skipped by a transition.
    resetAt: first.add({ months: 1 }).toZonedDateTime(zone).toInstant(),
  };
}

/**
 * Both windows, in the order the ladder reads them.
 *
 * `05` §3.9.3's trigger column is "either window", so a caller that forgot one would silently
 * apply half the ladder. Returned as a pair so there is nothing to forget.
 */
export function budgetWindows(
  at: Temporal.Instant,
  zone: TimeZoneId,
): readonly [BudgetWindow, BudgetWindow] {
  return [dailyWindow(at, zone), monthlyWindow(at, zone)];
}
