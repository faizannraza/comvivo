/**
 * Reminders and their firing ledger (`02` §3.3.5; `07` §3.2).
 *
 * A reminder is the feature with the least tolerance for being wrong: firing twice is annoying,
 * firing never is a broken promise, and firing at the wrong hour after a clock change is both.
 * Two columns carry that weight.
 *
 * **`next_fire_at` is derived, and `reminders_due_idx` is partial on it.** The schedule is the
 * source of truth (`07` §56); `next_fire_at` is a cache so the due query is an index range scan
 * over only the reminders that can still fire. `tzdata_version` records which tzdata computed it,
 * so `02` §3.13.7 can find and recompute exactly the stale ones.
 *
 * **`reminder_firings` is the exactly-once record.** `reminder_firings_occurrence_uq` on
 * `(reminder_id, occurrence_key)` is what makes "never fire an occurrence twice" a database
 * guarantee rather than a hope: the row is inserted **in the same transaction** as the outbox rows
 * (KD-8), so a crash between deciding to fire and enqueuing cannot leave the decision without the
 * message or the message without the record. That is invariant **I6** for reminders.
 */
import { ReminderRecipientsSchema, ReminderScheduleSchema } from '@comvivo/core';
import { idSchema, z } from '@comvivo/shared';
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { createdAt, instantMs, jsonOf, labelRef, tid, updatedAt, version } from './_columns.js';
import { groups, members } from './groups.js';
import { readerSets } from './ifc.js';

export const reminders = sqliteTable(
  'reminders',
  {
    id: tid('rem')('id').primaryKey(),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    kind: text('kind', {
      enum: ['self', 'others', 'group', 'event_lead', 'task_due', 'list'],
    }).notNull(),
    /** ≤ 500 chars. `NULL` for the derived kinds, which render from their target. */
    text: text('text'),
    recipients: jsonOf(ReminderRecipientsSchema, 'reminders.recipients')('recipients').notNull(),
    delivery: text('delivery', { enum: ['dm', 'group', 'auto'] }).notNull(),
    schedule: jsonOf(ReminderScheduleSchema, 'reminders.schedule')('schedule').notNull(),
    /**
     * `fixed_zone` fires at one instant for everyone; `member_local` fires at each recipient's own
     * local time. A daily 07:00 nudge means different instants for a group spread across zones.
     */
    anchor: text('anchor', { enum: ['fixed_zone', 'member_local'] }).notNull(),
    /** `evt_`/`tsk_`/`lst_`/`plns_` — the thing this reminder is about. */
    aboutRef: text('about_ref'),
    /** Frozen at creation: who may see this reminder, independent of membership changes. */
    audienceReaderSetId: integer('audience_reader_set_id')
      .notNull()
      .references(() => readerSets.id),
    labelId: labelRef().notNull(),
    /** The deferred-intent principal (`03` §3.3.11): the reminder acts with *their* authority. */
    createdByMemberId: tid('mbr')('created_by_member_id').references(() => members.id),
    /** Derived; the spine's `fireAt`. */
    nextFireAt: instantMs('next_fire_at'),
    status: text('status', {
      enum: ['scheduled', 'snoozed', 'done', 'cancelled', 'completed_series'],
    })
      .notNull()
      .default('scheduled'),
    snoozedUntil: instantMs('snoozed_until'),
    /** A duration override: how late is too late to still be worth sending. */
    staleAfter: text('stale_after'),
    tzdataVersion: text('tzdata_version').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    // Q-COO-1: the due scan. Partial, so finished reminders leave the index entirely.
    index('reminders_due_idx')
      .on(t.groupId, t.nextFireAt)
      .where(sql`${t.status} IN ('scheduled','snoozed')`),
    // Q-COO-2: "what reminds about this event", needed when the event moves or is deleted.
    index('reminders_about_idx').on(t.aboutRef).where(sql`${t.aboutRef} IS NOT NULL`),
  ],
);

export const reminderFirings = sqliteTable(
  'reminder_firings',
  {
    id: tid('rfr')('id').primaryKey(),
    reminderId: tid('rem')('reminder_id')
      .notNull()
      .references(() => reminders.id, { onDelete: 'cascade' }),
    /** Denormalised; the cascade arrives through `reminder_id`. */
    groupId: tid('grp')('group_id').notNull(),
    /**
     * Identifies the occurrence, not the attempt:
     * `o:<instant>` | `r:<wallclock>` | `i:<n>` | `l:<evt>:<recId>:<before>:<ver>` | `s:<k>`.
     */
    occurrenceKey: text('occurrence_key').notNull(),
    scheduledFor: instantMs('scheduled_for').notNull(),
    firedAt: instantMs('fired_at').notNull(),
    /**
     * `sent_late` and `missed` are distinct outcomes: a reminder delivered after an outage is
     * still useful, one past its `stale_after` is not, and a user who was never told should see
     * that it was dropped rather than assume it never existed.
     */
    outcome: text('outcome', {
      enum: ['sent', 'sent_late', 'missed', 'skipped_entity_gone'],
    }).notNull(),
    outboxIds: jsonOf(
      z.array(idSchema('obx')).max(50),
      'reminder_firings.outbox_ids',
    )('outbox_ids').notNull(),
    ackedByMemberId: tid('mbr')('acked_by_member_id'),
    ackAt: instantMs('ack_at'),
  },
  // Never fire an occurrence twice (I6). Inserted in the same transaction as the outbox rows.
  (t) => [uniqueIndex('reminder_firings_occurrence_uq').on(t.reminderId, t.occurrenceKey)],
);
