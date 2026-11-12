/**
 * `ScheduleSpec` — recurring job schedules (`02` §3.10.5, owned by `02`).
 *
 * `job_schedules.spec` holds this. The design question it answers is *whose* clock a recurring job
 * runs on, and `TzRefSchema` is the answer: a nightly backup is `fixed` to the instance's zone,
 * while a member's morning digest resolves through `person.timezone ?? group.timezone` at fire
 * time. Storing a resolved zone instead would mean a member who moves keeps getting their digest
 * at their old local time until someone noticed.
 *
 * `interval` has a one-minute floor because `02` §3.10's evaluator rounds to the minute, and a
 * schedule that fires faster than the evaluator's resolution would either be dropped or spin.
 */
import { idSchema, timeZoneIdSchema, z } from '@comvivo/shared';

/** `HH:mm`, 24-hour. */
export const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const hhmm = z.string().regex(HHMM_PATTERN, 'a time of day is `HH:mm`, 24-hour');

/**
 * A 5-field cron expression — minute, hour, day-of-month, month, day-of-week. **No seconds.**
 *
 * Seconds are excluded deliberately: `02` §3.10.5's evaluator works to the minute, so a seconds
 * field would be silently ignored, which is worse than refusing it. Each field accepts a number, a
 * range, a step, a list of those, or `*`.
 */
const CRON_FIELD = String.raw`(\*|\d+|\d+-\d+)(\/\d+)?(,(\*|\d+|\d+-\d+)(\/\d+)?)*`;
export const CRON_PATTERN = new RegExp(`^${CRON_FIELD}( ${CRON_FIELD}){4}$`);

export const CronExprSchema = z
  .string()
  .max(200)
  .regex(CRON_PATTERN, 'a cron expression has 5 space-separated fields and no seconds');

/**
 * Which clock a schedule runs on.
 *
 * `member` and `group` are resolved at fire time, not at creation, so moving zones changes when a
 * digest arrives without rewriting the schedule.
 */
export const TzRefSchema = z.union([
  z.object({ fixed: timeZoneIdSchema }),
  /** Resolved as `person.timezone ?? group.timezone`. */
  z.object({ member: idSchema('mbr') }),
  z.object({ group: idSchema('grp') }),
]);

export type TzRef = z.infer<typeof TzRefSchema>;

export const ScheduleSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), at: hhmm, tz: TzRefSchema }),
  z.object({
    kind: z.literal('weekly'),
    /** ISO weekdays, 1 = Monday. */
    weekdays: z.array(z.int().min(1).max(7)).min(1).max(7),
    at: hhmm,
    tz: TzRefSchema,
  }),
  z.object({ kind: z.literal('cron'), expr: CronExprSchema, tz: TzRefSchema }),
  /** No zone: an interval is wall-clock-independent by definition. */
  z.object({ kind: z.literal('interval'), everyMs: z.int().min(60_000) }),
]);

export type ScheduleSpec = z.infer<typeof ScheduleSpecSchema>;
