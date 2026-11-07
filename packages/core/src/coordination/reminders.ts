/**
 * Reminder JSON columns (`02` §3.3.5; `07` §3.2.1).
 */
import { idSchema, timeZoneIdSchema, z } from '@comvivo/shared';
import { DurationSchema, RecurrenceSchema } from './when.js';

/**
 * `reminders.recipients` (`07` §528).
 *
 * Three arms rather than a member list, because *who* a reminder is for also decides *where* it
 * goes and who may see that it exists. `self` is a private note to one person; `members` is a
 * named set; `group` names a conversation, which is the only arm that makes the reminder visible
 * to everyone in it. Flattening these into one array would lose the distinction between "remind
 * the three of us" and "announce to the group", which `03`'s disclosure guard reads.
 */
export const ReminderRecipientsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('self') }),
  z.object({ kind: z.literal('members'), ids: z.array(idSchema('mbr')).min(1).max(64) }),
  z.object({ kind: z.literal('group'), conversationId: idSchema('cnv') }),
]);

export type ReminderRecipients = z.infer<typeof ReminderRecipientsSchema>;

/**
 * `reminders.schedule` (`07` §528): the five ways a reminder can be timed.
 *
 * The two *derived* arms are the interesting ones. `lead` and `task_due` do not carry a time at
 * all — they carry a reference plus an offset, so moving the event moves the reminder. Storing a
 * resolved instant instead would leave a reminder firing for a dinner that was rescheduled, which
 * is the single most obvious way a reminder system loses trust.
 *
 * `rrule` keeps `dtstartLocal` and `zone` separate from the rule for `07` §56's reason: the
 * recurrence is wall-clock, so "every Tuesday at 18:00" survives a DST change.
 */
export const ReminderScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: z.string().max(80) }),
  z.object({
    kind: z.literal('rrule'),
    dtstartLocal: z.string().max(40),
    zone: timeZoneIdSchema,
    rule: RecurrenceSchema,
  }),
  z.object({
    kind: z.literal('interval'),
    every: DurationSchema,
    from: z.iso.datetime({ offset: true }),
    until: z.iso.datetime({ offset: true }).nullable(),
  }),
  // Derived: the reminder follows the event.
  z.object({ kind: z.literal('lead'), eventId: idSchema('evt'), before: DurationSchema }),
  z.object({ kind: z.literal('task_due'), taskId: idSchema('tsk'), before: DurationSchema }),
]);

export type ReminderSchedule = z.infer<typeof ReminderScheduleSchema>;
