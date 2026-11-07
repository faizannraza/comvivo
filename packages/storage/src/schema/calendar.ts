/**
 * Calendar (`02` §3.3.5; semantics in `07` §3.1).
 *
 * `07` §56 states the rule that explains almost every column here: **wall-clock time plus an IANA
 * zone is the source of truth, and instants are derived caches.** So `events` carries both — the
 * `*_local` text columns are authoritative and the `*_at` epoch-ms columns exist only so a date
 * range can be an index scan. When the platform's tzdata changes, `02` §3.13.7 recomputes every
 * derived instant from the wall-clock original; if the instants were authoritative there would be
 * nothing to recompute *from*, and a recurring 08:00 chore would drift an hour twice a year.
 *
 * ## Why a series is rows plus a rule, not expanded occurrences
 *
 * A weekly event is one row with an `rrule`, not 52 rows. Expanding would make "unbounded weekly"
 * unrepresentable and would turn a title edit into 52 writes. The cost is that *one* changed
 * occurrence needs somewhere to live, which is `event_overrides` — keyed by `recurrence_id`, the
 * occurrence's original wall-clock start, so the override survives the series being moved.
 */
import {
  DurationSchema,
  ErrorInfoSchema,
  EventPatchSchema,
  EventSourceSchema,
  LocationSchema,
} from '@comvivo/core';
import { z } from '@comvivo/shared';
import { sql } from 'drizzle-orm';
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import {
  bool,
  boolCheckSql,
  createdAt,
  instantMs,
  jsonOf,
  labelRef,
  tid,
  tzText,
  updatedAt,
  version,
} from './_columns.js';
import { groups, members } from './groups.js';

export const events = sqliteTable(
  'events',
  {
    rid: integer('rid').primaryKey({ autoIncrement: true }),
    id: tid('evt')('id').notNull().unique(),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    /** `07`: the series root id, equal to `id` for roots and one-offs. */
    seriesId: tid('evt')('series_id').notNull(),
    /** Set by a "this and following" split, so the two halves stay traceable to one original. */
    splitFromEventId: tid('evt')('split_from_event_id'),
    title: text('title').notNull(),
    notes: text('notes'),
    url: text('url'),
    location: jsonOf(LocationSchema, 'events.location')('location'),
    allDay: bool('all_day').notNull().default(false),
    tz: tzText('tz').notNull(),
    /** Authoritative wall-clock: `PlainDateTime`, or `PlainDate` when `all_day`. */
    startLocal: text('start_local').notNull(),
    /** Exclusive. All-day uses `endDateExclusive`. `NULL` means no stated end. */
    endLocal: text('end_local'),
    /** Derived `startUtc`; for all-day events, 00:00 in `tz`. */
    startAt: instantMs('start_at').notNull(),
    endAt: instantMs('end_at'),
    /** Normalised RFC 5545, without `DTSTART` — the start lives in `start_local` and `tz`. */
    rrule: text('rrule'),
    /** A feed sent a rule this build cannot parse; the event still shows, the series does not. */
    rruleInvalid: bool('rrule_invalid').notNull().default(false),
    rdates: jsonOf(z.array(z.string().max(40)).max(500), 'events.rdates')('rdates').notNull(),
    exdates: jsonOf(z.array(z.string().max(40)).max(500), 'events.exdates')('exdates').notNull(),
    /** Derived `seriesEndUtc`. `NULL` means unbounded. */
    recurrenceUntilAt: instantMs('recurrence_until_at'),
    /** `proposed` carries turn taint (`03` §3.10.2) until a member with `calendar.write` endorses. */
    status: text('status', { enum: ['proposed', 'tentative', 'confirmed', 'cancelled'] })
      .notNull()
      .default('confirmed'),
    /** `07`: all-day events default false, so "Trip" can still be marked busy deliberately. */
    busy: bool('busy').notNull(),
    attendeesMode: text('attendees_mode', { enum: ['none', 'rsvp'] })
      .notNull()
      .default('none'),
    /** `NULL` inherits the group default rather than pinning today's default forever. */
    leadTimes: jsonOf(z.array(DurationSchema).max(5).nullable(), 'events.lead_times')('lead_times'),
    source: jsonOf(EventSourceSchema, 'events.source')('source').notNull(),
    subscriptionId: tid('csub')('subscription_id'),
    sourceUid: text('source_uid'),
    sourceRecurrenceId: text('source_recurrence_id'),
    /** Lets a subscription refresh be a diff rather than a delete-and-insert, which loses RSVPs. */
    contentHash: blob('content_hash', { mode: 'buffer' }),
    planId: tid('pln')('plan_id'),
    labelId: labelRef().notNull(),
    createdByMemberId: tid('mbr')('created_by_member_id').references(() => members.id),
    updatedByMemberId: tid('mbr')('updated_by_member_id').references(() => members.id),
    /** Stable across edits, so an exported `.ics` updates the subscriber's copy in place. */
    icsUid: text('ics_uid').notNull().unique(),
    icsSequence: integer('ics_sequence').notNull().default(0),
    /** Which tzdata produced `start_at`, so `02` §3.13.7 knows what needs recomputing. */
    tzdataVersion: text('tzdata_version').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    // Q-CTX-6: the group's upcoming events, read on every turn that touches time.
    index('events_group_start_idx').on(t.groupId, t.startAt),
    // Q-CTX-6b: recurring series, which have to be expanded rather than range-scanned.
    index('events_group_recurring_idx')
      .on(t.groupId, t.recurrenceUntilAt)
      .where(sql`${t.rrule} IS NOT NULL`),
    index('events_series_idx').on(t.seriesId),
    // Q-COO-6: the subscription feed diff, as **two disjoint partial unique indexes**.
    //
    // `02` §3.3.5 writes this as one index on
    // `(subscription_id, source_uid, coalesce(source_recurrence_id, ''))`, and the `coalesce` is
    // needed there because `NULL` is distinct from `NULL` in a unique index — without it, two
    // non-recurring feed events with the same uid would both be allowed and the diff would
    // duplicate them on every refresh.
    //
    // **Measured: drizzle-kit 0.31.11 cannot emit a multi-argument function call in an index
    // column list.** It treats the rendered SQL as a column name and splits it on the comma
    // inside `coalesce`, producing
    // ``(`subscription_id`,`source_uid`,`coalesce("source_recurrence_id"`,` '')`)`` — which SQLite
    // rejects with `no such column`. A single-argument call such as `lower(name)` is fine, which
    // is why `lists_group_name_uq` works.
    //
    // Splitting on whether the recurrence id exists gives the same guarantee with no expression at
    // all, and states the intent more plainly: a feed event is identified by its uid, plus its
    // recurrence id when it has one. The one behavioural difference from `coalesce` is that a
    // literal empty-string recurrence id no longer collides with `NULL`; ingestion normalises
    // empty to `NULL`, and a feed sending `RECURRENCE-ID:` with no value is malformed anyway.
    uniqueIndex('events_subscription_src_uq')
      .on(t.subscriptionId, t.sourceUid)
      .where(sql`${t.subscriptionId} IS NOT NULL AND ${t.sourceRecurrenceId} IS NULL`),
    uniqueIndex('events_subscription_src_rec_uq')
      .on(t.subscriptionId, t.sourceUid, t.sourceRecurrenceId)
      .where(sql`${t.subscriptionId} IS NOT NULL AND ${t.sourceRecurrenceId} IS NOT NULL`),
    check('events_all_day_bool_ck', boolCheckSql(t.allDay)),
    check('events_rrule_invalid_bool_ck', boolCheckSql(t.rruleInvalid)),
    check('events_busy_bool_ck', boolCheckSql(t.busy)),
    check('events_ics_sequence_ck', sql`${t.icsSequence} >= 0`),
  ],
);

/**
 * One occurrence that differs from its series (`07` EventOverride, `01` §14 A7).
 *
 * `recurrence_id` is the occurrence's **original** wall-clock start, which is what makes the key
 * stable: moving the occurrence changes `start_at`, and if the key were the new time the override
 * would detach from the occurrence it describes.
 *
 * `cancelled` becomes an `EXDATE` on export rather than deleting anything, because a cancelled
 * occurrence is information — a subscriber needs to be told it is off.
 */
export const eventOverrides = sqliteTable(
  'event_overrides',
  {
    eventId: tid('evt')('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    /** The occurrence's original wall-clock start (`PlainDateTime` or `PlainDate`). */
    recurrenceId: text('recurrence_id').notNull(),
    patch: jsonOf(EventPatchSchema, 'event_overrides.patch')('patch').notNull(),
    /** Becomes an `EXDATE` on export. */
    cancelled: bool('cancelled').notNull().default(false),
    /** Derived for the moved occurrence. */
    startAt: instantMs('start_at'),
    version: version(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.recurrenceId] }),
    check('event_overrides_cancelled_bool_ck', boolCheckSql(t.cancelled)),
  ],
);

/** Who is coming (`02` §3.3.5). */
export const eventAttendees = sqliteTable(
  'event_attendees',
  {
    eventId: tid('evt')('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    memberId: tid('mbr')('member_id')
      .notNull()
      .references(() => members.id),
    rsvp: text('rsvp', { enum: ['needs_action', 'accepted', 'declined', 'tentative'] })
      .notNull()
      .default('needs_action'),
    /** `07` `calendar_rsvp` note, ≤ 200 chars. */
    note: text('note'),
    /** The note carries its own label: "can't come, hospital appointment" is not group-readable. */
    noteLabelId: labelRef('note_label_id'),
    respondedAt: instantMs('responded_at'),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.memberId] }),
    index('event_attendees_member_idx').on(t.memberId),
  ],
);

/** A per-occurrence RSVP: "coming to the series, but not this week". */
export const eventAttendeeOverrides = sqliteTable(
  'event_attendee_overrides',
  {
    eventId: tid('evt')('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    memberId: tid('mbr')('member_id')
      .notNull()
      .references(() => members.id),
    recurrenceId: text('recurrence_id').notNull(),
    rsvp: text('rsvp', {
      enum: ['needs_action', 'accepted', 'declined', 'tentative'],
    }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.memberId, t.recurrenceId] })],
);

/**
 * An external calendar feed (`07` §3.1.6).
 *
 * **The URL is encrypted and its host is not.** A webcal URL for a private calendar *is* the
 * credential — anyone holding it can read the calendar — so `08` keeps it in a field-encrypted
 * column. `url_host` is stored in clear because the dashboard has to show which service a
 * subscription points at, and `02` §3.11's egress allowlist checks the host before every fetch;
 * doing either from the ciphertext would mean decrypting on a page render.
 *
 * The label is `untrusted = true`: a feed is someone else's text arriving on a schedule, which is
 * exactly the injection surface `03` quarantines.
 */
export const calendarSubscriptions = sqliteTable(
  'calendar_subscriptions',
  {
    id: tid('csub')('id').primaryKey(),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** The URL embeds a secret, so it is field-encrypted per `08`. */
    urlCiphertext: blob('url_ciphertext', { mode: 'buffer' }).notNull(),
    /** In clear: the dashboard shows it and the egress allowlist checks it. */
    urlHost: text('url_host').notNull(),
    ownerMemberId: tid('mbr')('owner_member_id')
      .notNull()
      .references(() => members.id),
    /** `untrusted = true`; the audience is chosen when subscribing. */
    labelId: labelRef().notNull(),
    refreshInterval: text('refresh_interval').notNull().default('PT6H'),
    status: text('status', { enum: ['active', 'paused', 'failing', 'removed'] })
      .notNull()
      .default('active'),
    etag: text('etag'),
    lastModified: text('last_modified'),
    lastFetchAt: instantMs('last_fetch_at'),
    lastSuccessAt: instantMs('last_success_at'),
    failureCount: integer('failure_count').notNull().default(0),
    lastError: jsonOf(ErrorInfoSchema, 'calendar_subscriptions.last_error')('last_error'),
    eventCount: integer('event_count').notNull().default(0),
    color: text('color'),
    leadTimes: jsonOf(
      z.array(DurationSchema).max(5),
      'calendar_subscriptions.lead_times',
    )('lead_times').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    index('calendar_subscriptions_group_idx').on(t.groupId, t.status),
    check('calendar_subscriptions_counts_ck', sql`${t.failureCount} >= 0 AND ${t.eventCount} >= 0`),
  ],
);

/**
 * A per-member `.ics` feed token (`07` §3.1.1; one table with `09`'s `ics_feed_tokens`).
 *
 * Only the **hash** is stored. The token is a 256-bit bearer credential that grants read access to
 * a member's calendar over plain HTTP GET — anyone holding the URL is authorised — so storing it
 * would make a database read equivalent to issuing every member's calendar. `08` §3.7.11's
 * `vics_` prefix makes a leaked token recognisable in a log.
 *
 * Delivery is DM-only and the token is revoked on leave, both for the same reason.
 */
export const icsFeedTokens = sqliteTable(
  'ics_feed_tokens',
  {
    id: tid('ift')('id').primaryKey(),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    memberId: tid('mbr')('member_id')
      .notNull()
      .references(() => members.id),
    /** `sha256(token)`. The token itself is never stored. */
    tokenHash: blob('token_hash', { mode: 'buffer' }).notNull().unique(),
    scope: text('scope', { enum: ['group', 'member'] }).notNull(),
    /** `busy` exports free/busy blocks with no titles. */
    detail: text('detail', { enum: ['full', 'busy'] })
      .notNull()
      .default('full'),
    createdAt: createdAt(),
    lastUsedAt: instantMs('last_used_at'),
    revokedAt: instantMs('revoked_at'),
  },
  (t) => [index('ics_feed_tokens_member_idx').on(t.memberId)],
);
