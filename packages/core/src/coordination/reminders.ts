/**
 * Reminder JSON columns (`02` §3.3.5; `07` §3.2.1).
 */
import type {
  GroupId,
  LabelId,
  MemberId,
  OutboxId,
  ReaderSetId,
  ReminderFiringId,
  ReminderId,
} from '@comvivo/shared';
import { idSchema, timeZoneIdSchema, z } from '@comvivo/shared';
import { Temporal } from 'temporal-polyfill';
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

/* ────────────────────────── The reminder aggregate (`02` §3.3.5) ────────────────────────── */

/**
 * `02` §3.3.5's `reminders.kind`.
 *
 * Who it is for, not how often it repeats — recurrence lives in `schedule`. `self`, `others` and
 * `group` are reminders somebody asked for; `event_lead`, `task_due` and `list` are **derived**
 * from another entity, which is why `text` is nullable: a derived reminder renders from its target
 * rather than carrying its own wording.
 */
export const REMINDER_KINDS = [
  'self',
  'others',
  'group',
  'event_lead',
  'task_due',
  'list',
] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

/** `02` §3.3.5's `reminders.delivery`. `auto` lets `07` choose DM or group by audience. */
export const REMINDER_DELIVERIES = ['dm', 'group', 'auto'] as const;
export type ReminderDelivery = (typeof REMINDER_DELIVERIES)[number];

/**
 * `02` §3.3.5's `reminders.anchor` — the field that decides what "9am" means.
 *
 * `fixed_zone` fires at 9am in the reminder's own zone for everyone; `member_local` fires at 9am
 * wherever each recipient is. The distinction is the whole of `07`'s travelling-member problem,
 * and it cannot be derived from anything else: "take your pills at 9" is member-local and "the
 * call is at 9" is fixed.
 */
export const REMINDER_ANCHORS = ['fixed_zone', 'member_local'] as const;
export type ReminderAnchor = (typeof REMINDER_ANCHORS)[number];

/**
 * `02` §3.3.5's `reminders.status`.
 *
 * `snoozed` is a status rather than only a timestamp, so a sweep can skip snoozed reminders
 * without reading `snoozed_until` — and `completed_series` is distinct from `done` because a
 * recurring reminder that finished its run is not the same as one occurrence being dealt with.
 */
export const REMINDER_STATUSES = [
  'scheduled',
  'snoozed',
  'done',
  'cancelled',
  'completed_series',
] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

/** A reminder (`02` §3.3.5; semantics in `07`). */
export interface Reminder {
  readonly id: ReminderId;
  readonly groupId: GroupId;
  readonly kind: ReminderKind;
  readonly text: string | undefined;
  readonly recipients: ReminderRecipients;
  readonly delivery: ReminderDelivery;
  readonly schedule: ReminderSchedule;
  readonly anchor: ReminderAnchor;
  /** What it is about — an event or task id — for `reminders_about_idx`. */
  readonly aboutRef: string | undefined;
  /**
   * Who may see this reminder, **frozen at creation** (`02` §3.3.5).
   *
   * `NOT NULL`, and that is the point: a reminder's audience is decided when it is created and does
   * not follow membership changes afterwards. A reminder set up for "the parents" keeps firing to
   * the people who were the parents, rather than silently widening when somebody joins.
   */
  readonly audienceReaderSetId: ReaderSetId;
  readonly labelId: LabelId;
  readonly createdByMemberId: MemberId | undefined;
  /** `02` D3's derived instant. `undefined` when nothing is scheduled (paused, done). */
  readonly nextFireAt: Temporal.Instant | undefined;
  readonly status: ReminderStatus;
  readonly snoozedUntil: Temporal.Instant | undefined;
  readonly staleAfter: string | undefined;
  readonly tzdataVersion: string;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
  readonly version: number;
}

export interface NewReminder {
  readonly id: ReminderId;
  readonly groupId: GroupId;
  readonly kind: ReminderKind;
  readonly text?: string | undefined;
  readonly recipients: ReminderRecipients;
  readonly delivery: ReminderDelivery;
  readonly schedule: ReminderSchedule;
  readonly anchor: ReminderAnchor;
  readonly aboutRef?: string | undefined;
  readonly audienceReaderSetId: ReaderSetId;
  readonly createdByMemberId?: MemberId | undefined;
  /** The first fire time, derived by `07` from `schedule` and `anchor`. */
  readonly nextFireAt?: Temporal.Instant | undefined;
  readonly staleAfter?: string | undefined;
  readonly tzdataVersion: string;
}

/** `02` §3.3.5's `reminder_firings.outcome`. */
/**
 * `02` §3.3.5's `reminder_firings.outcome`.
 *
 * `sent_late` and `missed` are separate from `sent` because they are the two ways a scheduler can
 * fail a host: late is a reminder that still arrived, missed is one that never did, and collapsing
 * them would hide the difference between a slow instance and a broken one.
 * `skipped_entity_gone` is the derived-reminder case — the event it was about was deleted.
 */
export const FIRING_OUTCOMES = ['sent', 'sent_late', 'missed', 'skipped_entity_gone'] as const;
export type FiringOutcome = (typeof FIRING_OUTCOMES)[number];

/**
 * One firing of a reminder (`02` §3.3.5).
 *
 * `occurrenceKey` plus `reminder_firings_occurrence_uq` is what makes firing **exactly once**: the
 * scheduler can run twice for the same occurrence — after a crash, or on two workers — and the
 * second insert loses. That is `I6` for reminders, and it is enforced by the index rather than by
 * the scheduler remembering.
 */
export interface ReminderFiring {
  readonly id: ReminderFiringId;
  readonly reminderId: ReminderId;
  readonly groupId: GroupId;
  readonly occurrenceKey: string;
  readonly scheduledFor: Temporal.Instant;
  readonly firedAt: Temporal.Instant;
  readonly outcome: FiringOutcome;
  readonly outboxIds: readonly OutboxId[];
  readonly ackedByMemberId: MemberId | undefined;
  readonly ackAt: Temporal.Instant | undefined;
}

/**
 * Whether a reminder is due to fire at or before `at`.
 *
 * Snooze wins over the schedule: `02` §3.3.5 has both columns and a snoozed reminder must not fire
 * on its original time. Written once here because the comparison is easy to get backwards, and
 * backwards means a snoozed reminder firing immediately — which is the most annoying possible
 * failure of a snooze.
 *
 * `scheduled` **and** `snoozed` both count as live: a snoozed reminder is waiting, not finished,
 * and treating it as inactive would mean a snooze silently cancelled the reminder.
 */
export function isDue(
  reminder: Pick<Reminder, 'status' | 'nextFireAt' | 'snoozedUntil'>,
  at: Temporal.Instant,
): boolean {
  if (reminder.status !== 'scheduled' && reminder.status !== 'snoozed') return false;
  const when = reminder.snoozedUntil ?? reminder.nextFireAt;
  if (when === undefined) return false;
  return Temporal.Instant.compare(when, at) <= 0;
}
