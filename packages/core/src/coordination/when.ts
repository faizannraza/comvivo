/**
 * Recurrence and durations, shared by calendar, reminders, tasks and plans (`07` §3.1.2).
 *
 * `07` §56 settles the representation question that everything else here depends on: **wall-clock
 * time plus an IANA zone is the source of truth, and instants are derived caches.** A weekly chore
 * at 08:00 is at 08:00 after the clocks change, which means the recurrence cannot be stored as a
 * list of instants — it has to be stored as a rule plus a zone, and the `*_at` columns in `02`
 * §3.3.5 are recomputed when tzdata changes (`02` §3.13.7).
 *
 * `RecurringScheduleSchema` is `07`'s `zRecurrence` with the zone and start the stored form needs.
 * It is deliberately *not* an RFC 5545 string: `events.rrule` holds one of those because a
 * calendar feed supplies it, but a rule the product generates is kept structured so that
 * "every second Tuesday" can be shown back to a person in their own words.
 */
import { timeZoneIdSchema, z } from '@comvivo/shared';

/** An ISO 8601 duration, e.g. `PT30M`. `07` §56 persists durations as strings. */
export const DurationSchema = z.iso.duration();

/** `07`'s `zWeekday`. */
export const WeekdaySchema = z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);

/**
 * `07`'s `zRecurrence`: the structured recurrence rule.
 *
 * `bySetPos` with `byWeekday` is how "the last Friday of the month" is expressed — `byWeekday:
 * ['FR']` plus `bySetPos: -1` — which is why `bySetPos` accepts negatives.
 */
export const RecurrenceSchema = z.object({
  freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.int().min(1).max(99),
  byWeekday: z.array(WeekdaySchema).max(7).nullable(),
  byMonthDay: z.array(z.int().min(-31).max(31)).max(31).nullable(),
  /** "last Friday" is `byWeekday: ['FR']` with `bySetPos: -1`. */
  bySetPos: z.int().min(-5).max(5).nullable(),
  until: z.iso.date().nullable(),
  count: z.int().min(1).max(500).nullable(),
});

export type Recurrence = z.infer<typeof RecurrenceSchema>;

/**
 * A stored recurring schedule: the rule, where it starts, and in which zone.
 *
 * `rotations.schedule` and `tasks.recurrence` hold this (`02` §3.3.5). The zone is mandatory
 * because the rule is evaluated in wall-clock time — a daily 08:00 chore has no meaning without
 * knowing whose 08:00 — and `dtstartLocal` is a wall-clock date-time for the same reason, not an
 * instant.
 */
export const RecurringScheduleSchema = z.object({
  rule: RecurrenceSchema,
  /** Wall-clock `YYYY-MM-DDTHH:mm:ss`, or a date for all-day and by-day schedules. */
  dtstartLocal: z.string().max(40),
  zone: timeZoneIdSchema,
  /** `07` §680: a rotation may state a due time, or fall back to a whole day. */
  dueTime: z.iso.time({ precision: -1 }).nullable(),
});

export type RecurringSchedule = z.infer<typeof RecurringScheduleSchema>;
