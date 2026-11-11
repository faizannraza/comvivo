/**
 * `nextFireAfter` — when a recurring schedule fires next (`02` §3.10.5).
 *
 * ## Why this is hard, and why it is here
 *
 * A schedule is stated in **wall-clock** terms — "09:00 in the group's zone" — and fires at an
 * **instant**. Between the two sits the zone's history, and two cases make the conversion a real
 * algorithm rather than an addition:
 *
 *  - **A gap** (spring forward). `America/New_York` has no 02:30 on 2026-03-08. A daily 02:30
 *    schedule must still fire that day, once, shifted forward by the gap — `02` §3.10.5 says 03:30.
 *    Dropping the occurrence would silently skip a day's digest; firing twice the next day would
 *    deliver yesterday's.
 *  - **An overlap** (fall back). `America/New_York` has 01:30 **twice** on 2026-11-01. A daily
 *    01:30 schedule must fire **once**, at the earlier instant. Firing at both would send the same
 *    morning brief twice an hour apart.
 *
 * And the pathological case `02` §3.10.5 names: `Pacific/Apia` skipped 2011-12-30 entirely when it
 * crossed the date line. A daily schedule must fire on the next day that exists.
 *
 * It lives in `shared` rather than `core` because `02` §3.10.5 puts it there and `core` may import
 * it. The input is structural — a pattern, not `core`'s `ScheduleSpec` — so `shared` stays the
 * inner layer: the resolved zone arrives as a parameter, which is also what makes `TzRef`
 * resolution the scheduler's job rather than the evaluator's.
 *
 * ## Why not iterate minute by minute
 *
 * Five years is 2.6 million minutes, and `cron 0 9 30 2 *` (February 30th) has to be *proved*
 * impossible rather than timed out. So the search is **field-wise**: bump the first field that does
 * not match and reset the lower ones to their minimum, which reaches the next matching wall-clock
 * time in tens of steps rather than millions.
 */
import { Temporal } from 'temporal-polyfill';
import { StorageError } from '../errors.js';

/**
 * The pattern half of a `ScheduleSpec` (`02` §3.10.5), without its `TzRef`.
 *
 * Structural rather than an import of `core`'s `ScheduleSpec`: the zone arrives resolved, so the
 * evaluator never needs the reference — and `shared` cannot depend on `core`. A `ScheduleSpec` is
 * assignable to this.
 */
export type SchedulePattern =
  | { readonly kind: 'daily'; readonly at: string }
  | { readonly kind: 'weekly'; readonly weekdays: readonly number[]; readonly at: string }
  | { readonly kind: 'cron'; readonly expr: string }
  | { readonly kind: 'interval'; readonly everyMs: number };

/**
 * How far ahead the search will look before declaring a pattern unsatisfiable.
 *
 * `02` §3.10.5 bounds it at "366*5 days of iterations". Five years is enough for every satisfiable
 * pattern a 5-field cron can express — the longest real gap is February 29th, four years — and
 * short enough that `0 9 30 2 *` fails in milliseconds instead of hanging a scheduler tick.
 */
const MAX_DAYS_AHEAD = 366 * 5;

/**
 * A runaway guard on field-wise steps, deliberately well above what `MAX_DAYS_AHEAD` can need.
 *
 * The **date** bound is the operative one — it is what `02` §3.10.5 specifies and what refuses
 * February 30th. This exists only so a bug in the stepping cannot spin forever, and it is sized so
 * it can never be the limit that bites: the worst case is one step per non-matching month (60),
 * plus one per day (1 827), plus up to 24 hour steps and 60 minute steps on each matching day —
 * about 155 000. A first version set this to 200 000, which is close enough to that figure to
 * have silently refused a satisfiable pattern, and close enough that deleting the date bound
 * changed no test.
 */
const MAX_STEPS = 2_000_000;

/**
 * The next instant **strictly after** `after` at which `pattern` fires, in `tz`.
 *
 * Strictly after, because the scheduler calls this with the occurrence it has just fired: an
 * inclusive comparison would return the same instant forever.
 */
export function nextFireAfter(
  pattern: SchedulePattern,
  after: Temporal.Instant,
  tz: string,
): Temporal.Instant {
  if (pattern.kind === 'interval') {
    // No zone, and `02` §3.10.5's `interval` arm carries none: "every 15 minutes" is elapsed time.
    //
    // Worth being precise about *why* rather than hand-waving at DST, because the obvious reason is
    // wrong: `Temporal`'s arithmetic over a **time** unit is exact even on a `ZonedDateTime`, so
    // `after.toZonedDateTimeISO(tz).add({ milliseconds })` gives the same instant. Measured. The
    // zone would start to matter for a *date* unit — "every day" is not "every 86 400 000 ms"
    // across a transition — which is exactly what the `daily` arm is for.
    return after.add({ milliseconds: pattern.everyMs });
  }
  const fields = compile(pattern);
  // `02` §3.10.5: start from the minute **after** `after`, floored. This is the spec's wording and
  // it saves an iteration in the common case, but it is **not** what guarantees strictness — the
  // re-check further down is, and it has to be, because an occurrence in a repeated hour can
  // resolve to an instant at or before `after` however the search started. Measured: deleting
  // either one alone changes no behaviour, because each covers the other.
  let candidate = after
    .toZonedDateTimeISO(tz)
    .add({ minutes: 1 })
    .round({ smallestUnit: 'minute', roundingMode: 'floor' })
    .toPlainDateTime();
  const limit = after.toZonedDateTimeISO(tz).add({ days: MAX_DAYS_AHEAD }).toPlainDateTime();

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (Temporal.PlainDateTime.compare(candidate, limit) > 0) break;
    const advanced = advanceToMatch(candidate, fields);
    if (advanced === undefined) break;
    if (advanced.matched) {
      // `disambiguation: 'compatible'` is what `02` §3.10.5 specifies, and it handles both edges:
      // a wall time inside a **gap** is shifted forward by the gap's length (02:30 fires at 03:30),
      // and one inside an **overlap** resolves to the earlier instant (01:30 fires once).
      const instant = advanced.at.toZonedDateTime(tz, { disambiguation: 'compatible' }).toInstant();
      // The overlap edge needs this check rather than trusting the resolution: an occurrence in
      // the repeated hour can resolve to an instant at or before `after`, and returning it would
      // fire the same wall-clock occurrence twice.
      if (Temporal.Instant.compare(instant, after) > 0) return instant;
      candidate = advanced.at.add({ minutes: 1 });
      continue;
    }
    candidate = advanced.at;
  }
  throw new StorageError(
    'SCHEDULE_NO_NEXT',
    `that schedule has no next occurrence within ${String(MAX_DAYS_AHEAD)} days`,
    {
      hint: 'Check the day and month fields: a date like February 30th can never occur. Fix the schedule rather than widening the search.',
      category: 'validation.failed',
    },
  );
}

/* ──────────────────────────── The field matcher ──────────────────────────── */

/**
 * A compiled pattern: one predicate set per cron field.
 *
 * `daily` and `weekly` compile to the same shape as `cron`, which `02` §3.10.5 says explicitly —
 * one matcher, so a DST edge cannot behave differently for a daily schedule than for the cron
 * expression that means the same thing.
 */
interface Fields {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  /** Cron day-of-week: 0–6 with 0 = Sunday. */
  readonly daysOfWeek: ReadonlySet<number>;
  /** Whether `daysOfMonth` was `*`. Decides the union rule below. */
  readonly anyDayOfMonth: boolean;
  /** Whether `daysOfWeek` was `*`. */
  readonly anyDayOfWeek: boolean;
}

function compile(pattern: Exclude<SchedulePattern, { kind: 'interval' }>): Fields {
  if (pattern.kind === 'cron') return compileCron(pattern.expr);
  const [hour, minute] = splitHhmm(pattern.at);
  const weekdays =
    pattern.kind === 'weekly'
      ? // ISO weekdays are 1–7 with 7 = Sunday; cron's are 0–6 with 0 = Sunday. `% 7` maps both
        // 7 → 0 and 1–6 → 1–6, which is the whole conversion.
        new Set(pattern.weekdays.map((day) => day % 7))
      : all(0, 6);
  return {
    minutes: new Set([minute]),
    hours: new Set([hour]),
    daysOfMonth: all(1, 31),
    months: all(1, 12),
    daysOfWeek: weekdays,
    anyDayOfMonth: true,
    anyDayOfWeek: pattern.kind !== 'weekly',
  };
}

function compileCron(expr: string): Fields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new StorageError('SCHEDULE_NO_NEXT', 'a cron expression has five fields', {
      hint: 'Minute, hour, day-of-month, month and day-of-week. No seconds — `02` §3.10.5 works to the minute.',
      category: 'validation.failed',
    });
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    minutes: parseField(minute, 0, 59),
    hours: parseField(hour, 0, 23),
    daysOfMonth: parseField(dayOfMonth, 1, 31),
    months: parseField(month, 1, 12),
    // 0–7, with **both** 0 and 7 meaning Sunday: every cron implementation accepts both, and a
    // schedule written `0 9 * * 7` by hand should not silently never fire.
    daysOfWeek: new Set([...parseField(dayOfWeek, 0, 7)].map((day) => day % 7)),
    anyDayOfMonth: dayOfMonth === '*',
    anyDayOfWeek: dayOfWeek === '*',
  };
}

/** A number, a range `a-b`, either with a step (`a-b/n`), a star, a star with a step, or a list. */
function parseField(field: string, min: number, max: number): ReadonlySet<number> {
  const values = new Set<number>();
  for (const term of field.split(',')) {
    const [range, stepText] = term.split('/') as [string, string | undefined];
    const step = stepText === undefined ? 1 : Number.parseInt(stepText, 10);
    if (!Number.isInteger(step) || step < 1) {
      throw badField(field, 'a step must be a positive integer');
    }
    const [from, to] = boundsOf(range, field, min, max);
    for (let value = from; value <= to; value += step) values.add(value);
  }
  // No empty-set check: `boundsOf` refuses `from > to` and the step is at least one, so a field
  // that parses always yields at least one value. A guard here would be a branch no input can
  // reach — found by deleting it and watching nothing fail.
  return values;
}

function boundsOf(range: string, field: string, min: number, max: number): [number, number] {
  if (range === '*') return [min, max];
  const ends = range.split('-');
  const from = Number.parseInt(ends[0] ?? '', 10);
  const to = ends.length === 2 ? Number.parseInt(ends[1] ?? '', 10) : from;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) {
    throw badField(field, 'a range reads `a-b` with `a` at or below `b`');
  }
  if (from < min || to > max)
    throw badField(field, `values run from ${String(min)} to ${String(max)}`);
  return [from, to];
}

function badField(field: string, why: string): StorageError {
  return new StorageError('SCHEDULE_NO_NEXT', `\`${field}\` is not a cron field: ${why}`, {
    hint: 'Each field accepts a number, a range, a step, a comma-separated list of those, or `*`.',
    category: 'validation.failed',
  });
}

/**
 * One field-wise step towards a match.
 *
 * Returns `{ matched: true }` when `candidate` itself matches, and otherwise the next candidate to
 * try — the first non-matching field bumped, with every lower field reset to its minimum. That
 * reset is what makes the search fast *and* correct: without it, advancing the hour would leave a
 * minute that has already been ruled out and the search would walk past the real answer.
 */
function advanceToMatch(
  candidate: Temporal.PlainDateTime,
  fields: Fields,
): { readonly matched: boolean; readonly at: Temporal.PlainDateTime } | undefined {
  if (!fields.months.has(candidate.month)) {
    // The first of the next month, at midnight. `with({ day: 1 })` before `add({ months: 1 })`
    // because the other order can clamp — 31 January plus a month is 28 February, and the search
    // would then skip the first 27 days of it.
    return {
      matched: false,
      at: candidate.with({ day: 1 }).add({ months: 1 }).with({ hour: 0, minute: 0 }),
    };
  }
  if (!matchesDay(candidate, fields)) {
    return { matched: false, at: candidate.add({ days: 1 }).with({ hour: 0, minute: 0 }) };
  }
  if (!fields.hours.has(candidate.hour)) {
    return { matched: false, at: candidate.add({ hours: 1 }).with({ minute: 0 }) };
  }
  if (!fields.minutes.has(candidate.minute)) {
    return { matched: false, at: candidate.add({ minutes: 1 }) };
  }
  return { matched: true, at: candidate };
}

/**
 * Cron's day rule, which is **not** an intersection.
 *
 * When both day-of-month and day-of-week are restricted, a classic cron matches the **union**:
 * `0 0 1 * 1` means "the first of the month *or* any Monday". Every major implementation does this
 * and it surprises everybody, so it is written out rather than left to the reader — and an
 * intersection would make `0 0 13 * 5` mean "Friday the 13th" instead of "the 13th, or any Friday".
 */
function matchesDay(candidate: Temporal.PlainDateTime, fields: Fields): boolean {
  // `Temporal`'s `dayOfWeek` is ISO: 1 = Monday … 7 = Sunday. `% 7` converts to cron's 0 = Sunday.
  const dow = candidate.dayOfWeek % 7;
  const byMonth = fields.daysOfMonth.has(candidate.day);
  const byWeek = fields.daysOfWeek.has(dow);
  if (fields.anyDayOfMonth && fields.anyDayOfWeek) return true;
  if (fields.anyDayOfMonth) return byWeek;
  if (fields.anyDayOfWeek) return byMonth;
  return byMonth || byWeek;
}

function splitHhmm(at: string): [number, number] {
  const [hour, minute] = at.split(':');
  const h = Number.parseInt(hour ?? '', 10);
  const m = Number.parseInt(minute ?? '', 10);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    throw new StorageError('SCHEDULE_NO_NEXT', `\`${at}\` is not a time of day`, {
      hint: 'A daily or weekly schedule takes `HH:mm`, 24-hour.',
      category: 'validation.failed',
    });
  }
  return [h, m];
}

function all(from: number, to: number): ReadonlySet<number> {
  const values = new Set<number>();
  for (let value = from; value <= to; value += 1) values.add(value);
  return values;
}
