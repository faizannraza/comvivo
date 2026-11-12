/**
 * The calendar repository (`02` §3.7.1, §3.3.5; semantics in `07`).
 *
 * ## Why `upcomingOneOff` and `activeSeries` are two methods
 *
 * `02` §3.3.10 splits Q-CTX-6 from Q-CTX-6b, and the reason is in the data: a recurring event is
 * **one row** whose `start_at` is its *first* occurrence. So a range scan over `start_at` finds
 * every one-off in the window and misses a weekly dinner that started last year — which is most of
 * a group's actual calendar. The series are fetched separately, by whether their recurrence is
 * still live, and `07` expands them.
 *
 * A single method hiding both would have to return expanded occurrences, which means expanding
 * `rrule`s in storage — and `07` owns that, because expansion needs the group's zone, the tzdata
 * version and the exception dates reasoned about together.
 *
 * ## Why an edit splits
 *
 * Editing one occurrence writes a **new row** that keeps the `seriesId` and records
 * `splitFromEventId`. The series row is untouched, so "move this week's dinner" does not rewrite
 * next week's, and `bySeries` still finds both.
 */
import type {
  CalendarReader,
  CalendarRepository,
  EligibleLabelSet,
  Event,
  EventAttendee,
  Label,
  NewEvent,
  RsvpResponse,
  TxToken,
  WriteResult,
} from '@comvivo/core';
import { duplicate, notFound, writeConflict, writeOk } from '@comvivo/core';
import {
  type CalendarSubscriptionId,
  type EventId,
  type GroupId,
  type MemberId,
  StorageError,
} from '@comvivo/shared';
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, or, type SQL, sql } from 'drizzle-orm';
import type { Temporal } from 'temporal-polyfill';
import { type Db, exactlyOne, maybeOne, type Patch } from '../db/drizzle.js';
import { isUniqueViolation } from '../db/errors.js';
import type { LabelStore } from '../ifc/label-store.js';
import { eventAttendees, events } from '../schema/index.js';
import { toEvent, toEventAttendee } from './rows.js';

export class SqliteCalendarRepository implements CalendarReader, CalendarRepository {
  readonly #db: Db;
  readonly #labels: LabelStore;

  constructor(db: Db, labels: LabelStore) {
    this.#db = db;
    this.#labels = labels;
  }

  byId(groupId: GroupId, id: EventId, eligible: EligibleLabelSet): Event | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(events)
        .where(and(eq(events.groupId, groupId), eq(events.id, id), eligibleFilter(eligible))),
    );
    return row === undefined ? undefined : toEvent(row);
  }

  /** Q-CTX-6, through `events_group_start_idx`. One-off events only — see the header. */
  upcomingOneOff(query: {
    readonly groupId: GroupId;
    readonly from: Temporal.Instant;
    readonly to: Temporal.Instant;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly Event[] {
    if (query.eligible.ids.length === 0) return [];
    const rows = this.#db
      .select()
      .from(events)
      .where(
        and(
          eq(events.groupId, query.groupId),
          gte(events.startAt, query.from),
          lte(events.startAt, query.to),
          sql`${events.rrule} IS NULL`,
          sql`${events.status} <> 'cancelled'`,
          eligibleFilter(query.eligible),
        ),
      )
      .orderBy(asc(events.startAt), asc(events.rid))
      .limit(query.limit)
      .all();
    return rows.map(toEvent);
  }

  /**
   * Q-CTX-6b, through `events_group_recurring_idx` — a *partial* index on `rrule IS NOT NULL`.
   *
   * "Still live at `at`" is `recurrence_until_at IS NULL` (open-ended) **or** it is in the future.
   * The `IS NULL` arm matters: an open-ended weekly event is the common case, and a plain
   * `recurrence_until_at >= :at` would exclude every one of them.
   *
   * **Deliberately unordered**, and that is not a convenience — it is what lets the query reach its
   * index. Measured: adding `ORDER BY start_at` makes SQLite choose `events_group_start_idx`
   * instead, because that index satisfies the group filter *and* the sort while the partial index
   * would need a separate sort. The ordering buys nothing: a series' `start_at` is its **first**
   * occurrence, so ordering live series by it ranks them by when they began rather than by when
   * they next happen — and `07` expands each series into occurrences and sorts those anyway.
   *
   * So a later refactor that "tidies" an `ORDER BY` back in would silently stop using the index
   * `02` §3.3.5 declares for Q-CTX-6b. The contract test asserts the plan, which is what catches
   * that.
   */
  activeSeries(query: {
    readonly groupId: GroupId;
    readonly at: Temporal.Instant;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly Event[] {
    if (query.eligible.ids.length === 0) return [];
    const rows = this.#db
      .select()
      .from(events)
      .where(
        and(
          eq(events.groupId, query.groupId),
          isNotNull(events.rrule),
          or(sql`${events.recurrenceUntilAt} IS NULL`, gte(events.recurrenceUntilAt, query.at)),
          sql`${events.status} <> 'cancelled'`,
          eligibleFilter(query.eligible),
        ),
      )
      .limit(query.limit)
      .all();
    return rows.map(toEvent);
  }

  /** Through `events_series_idx`: the series row and every occurrence split out of it. */
  bySeries(groupId: GroupId, seriesId: EventId, eligible: EligibleLabelSet): readonly Event[] {
    if (eligible.ids.length === 0) return [];
    const rows = this.#db
      .select()
      .from(events)
      .where(
        and(eq(events.groupId, groupId), eq(events.seriesId, seriesId), eligibleFilter(eligible)),
      )
      .orderBy(asc(events.startAt), asc(events.rid))
      .all();
    return rows.map(toEvent);
  }

  /**
   * Q-COO-6, through the two disjoint partial unique indexes.
   *
   * **Not label-filtered**, like the memory fingerprint lookup and for the same reason: this asks
   * "does this feed row already exist", which is a question about the store rather than about an
   * audience. Filtering it would make an ICS refresh insert a duplicate for every event whose
   * label the refresher cannot read — and the refresher is a job, not a member.
   */
  bySourceUid(query: {
    readonly subscriptionId: CalendarSubscriptionId;
    readonly sourceUid: string;
    readonly sourceRecurrenceId?: string | undefined;
  }): Event | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(events)
        .where(
          and(
            eq(events.subscriptionId, query.subscriptionId),
            eq(events.sourceUid, query.sourceUid),
            query.sourceRecurrenceId === undefined
              ? sql`${events.sourceRecurrenceId} IS NULL`
              : eq(events.sourceRecurrenceId, query.sourceRecurrenceId),
          ),
        ),
    );
    return row === undefined ? undefined : toEvent(row);
  }

  attendeesOf(groupId: GroupId, id: EventId): readonly EventAttendee[] {
    // Scoped through the event, because `event_attendees` has no `group_id` of its own — its
    // isolation comes from the foreign key, and a read that joined nothing would cross groups.
    const rows = this.#db
      .select({ attendee: eventAttendees })
      .from(eventAttendees)
      .innerJoin(events, eq(events.id, eventAttendees.eventId))
      .where(and(eq(events.groupId, groupId), eq(eventAttendees.eventId, id)))
      .orderBy(asc(eventAttendees.memberId))
      .all();
    return rows.map((row) => toEventAttendee(row.attendee));
  }

  create(uow: TxToken, event: NewEvent, label: Label): WriteResult<Event> {
    if (label.groupId !== event.groupId) throw crossGroup();
    const labelId = this.#labels.intern(uow, label);
    try {
      const row = exactlyOne(
        this.#db
          .insert(events)
          .values({
            id: event.id,
            groupId: event.groupId,
            // An unsplit event **is** its own series, so the caller never supplies this.
            seriesId: event.id,
            title: event.title,
            notes: event.notes,
            url: event.url,
            location: event.location,
            allDay: event.allDay ?? false,
            tz: event.tz,
            startLocal: event.startLocal,
            endLocal: event.endLocal,
            startAt: event.startAt,
            endAt: event.endAt,
            rrule: event.rrule,
            rdates: [...(event.rdates ?? [])],
            exdates: [...(event.exdates ?? [])],
            recurrenceUntilAt: event.recurrenceUntilAt,
            status: event.status ?? 'confirmed',
            busy: event.busy,
            attendeesMode: event.attendeesMode ?? 'none',
            leadTimes: event.leadTimes === undefined ? undefined : [...event.leadTimes],
            source: event.source,
            subscriptionId: event.subscriptionId,
            sourceUid: event.sourceUid,
            sourceRecurrenceId: event.sourceRecurrenceId,
            contentHash:
              event.contentHash === undefined ? undefined : Buffer.from(event.contentHash),
            planId: event.planId,
            labelId,
            createdByMemberId: event.createdByMemberId,
            icsUid: event.icsUid,
            tzdataVersion: event.tzdataVersion,
            createdAt: uow.now,
            updatedAt: uow.now,
          })
          .returning(),
        'the event',
      );
      return writeOk(toEvent(row));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Three unique indexes can fire: `events.id`, `events.ics_uid`, and the feed pair. The feed
      // one is the routine case — an ICS refresh re-importing an event it already has.
      const existing =
        event.subscriptionId === undefined || event.sourceUid === undefined
          ? undefined
          : this.bySourceUid({
              subscriptionId: event.subscriptionId,
              sourceUid: event.sourceUid,
              sourceRecurrenceId: event.sourceRecurrenceId,
            });
      return duplicate(existing?.id ?? event.id);
    }
  }

  splitOccurrence(
    uow: TxToken,
    groupId: GroupId,
    seriesId: EventId,
    expectVersion: number,
    occurrence: NewEvent,
    label: Label,
  ): WriteResult<Event> {
    const series = this.#rowOf(groupId, seriesId);
    if (series === undefined) return notFound();
    if (series.version !== expectVersion) return writeConflict();
    if (occurrence.groupId !== groupId) throw crossGroup();

    const created = this.create(uow, occurrence, label);
    if (created.kind !== 'ok') return created;
    // The split row joins the series rather than starting one, and records where it came from —
    // so `bySeries` finds it and `07` knows not to expand the original for this occurrence.
    const row = maybeOne(
      this.#db
        .update(events)
        .set({ seriesId, splitFromEventId: seriesId, updatedAt: uow.now })
        .where(and(eq(events.groupId, groupId), eq(events.id, created.value.id)))
        .returning(),
    );
    return row === undefined ? notFound() : writeOk(toEvent(row));
  }

  setStatus(
    uow: TxToken,
    groupId: GroupId,
    id: EventId,
    expectVersion: number,
    status: Event['status'],
  ): WriteResult<Event> {
    return this.#versionedUpdate(uow, groupId, id, expectVersion, { status });
  }

  /**
   * Record that a stored `rrule` no longer parses.
   *
   * Unversioned, and separate from `setStatus`, because it is something **we** discovered rather
   * than something a member changed: `07` meets the bad rule while expanding, and the right
   * response is to record it and degrade rather than fail the expansion. Versioning it would make
   * the recording conflict with whatever edit produced the bad rule — so the one write that
   * explains the problem would be the one that cannot land.
   */
  markRruleInvalid(uow: TxToken, groupId: GroupId, id: EventId): WriteResult<Event> {
    const row = maybeOne(
      this.#db
        .update(events)
        .set({ rruleInvalid: true, updatedAt: uow.now })
        .where(and(eq(events.groupId, groupId), eq(events.id, id)))
        .returning(),
    );
    return row === undefined ? notFound() : writeOk(toEvent(row));
  }

  setRsvp(
    uow: TxToken,
    groupId: GroupId,
    id: EventId,
    memberId: MemberId,
    response: RsvpResponse,
    at: Temporal.Instant,
  ): WriteResult<EventAttendee> {
    // The event has to be in this group: `event_attendees` has no `group_id`, so without this
    // check a caller could RSVP to another group's event through its id alone.
    if (this.#rowOf(groupId, id) === undefined) return notFound();
    const row = exactlyOne(
      this.#db
        .insert(eventAttendees)
        .values({ eventId: id, memberId, rsvp: response, respondedAt: at, updatedAt: uow.now })
        .onConflictDoUpdate({
          target: [eventAttendees.eventId, eventAttendees.memberId],
          set: { rsvp: response, respondedAt: at, updatedAt: uow.now },
        })
        .returning(),
      'the RSVP',
    );
    return writeOk(toEventAttendee(row));
  }

  #rowOf(groupId: GroupId, id: EventId): typeof events.$inferSelect | undefined {
    return maybeOne(
      this.#db
        .select()
        .from(events)
        .where(and(eq(events.groupId, groupId), eq(events.id, id))),
    );
  }

  #versionedUpdate(
    uow: TxToken,
    groupId: GroupId,
    id: EventId,
    expectVersion: number,
    patch: Patch<typeof events.$inferInsert>,
  ): WriteResult<Event> {
    const row = maybeOne(
      this.#db
        .update(events)
        .set({ ...patch, updatedAt: uow.now, version: expectVersion + 1 })
        .where(
          and(eq(events.groupId, groupId), eq(events.id, id), eq(events.version, expectVersion)),
        )
        .returning(),
    );
    if (row !== undefined) return writeOk(toEvent(row));
    return this.#rowOf(groupId, id) === undefined ? notFound() : writeConflict();
  }
}

/** `label_id IN (eligible)`, with the empty set matching nothing (`I1`). */
function eligibleFilter(eligible: EligibleLabelSet): SQL {
  if (eligible.ids.length === 0) return sql`1 = 0`;
  return inArray(events.labelId, [...eligible.ids]);
}

function crossGroup(): StorageError {
  return new StorageError('STORAGE_CONSTRAINT', 'the event names a label of another group', {
    hint: "This is a bug and an I4 violation: intern the label against the event's own group.",
    category: 'bug',
  });
}

/** Re-exported so the read model can order a merged list the same way this one does. */
export const EVENT_ORDER = [asc(events.startAt), asc(events.rid)] as const;
export { desc as eventDesc };
