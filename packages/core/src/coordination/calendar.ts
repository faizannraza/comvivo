/**
 * Calendar JSON columns (`02` §3.3.5; `07` §3.1).
 */
import {
  type CalendarSubscriptionId,
  capped,
  type EventId,
  type GroupId,
  type LabelId,
  type MemberId,
  type PlanId,
  type TimeZoneId,
  z,
} from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';

/** `02` §3.3.9: `events.location` and `events.exdates` are capped at 2 KiB. */
const CALENDAR_JSON_MAX_BYTES = 2 * 1024;

/**
 * `events.location`.
 *
 * **Only `text` is pinned by a spec.** Every producer and consumer in `07` treats a location as a
 * string: the tool input is `z.string().max(300)`, and `07` §484's template renders `{location}`
 * directly. `02` nonetheless makes the column JSON rather than `text()`, which is the right call
 * for a different reason — an imported ICS event carries `LOCATION` *and* optionally `GEO`, and a
 * structured location added later should not need a migration on the busiest calendar table.
 *
 * So this is one field today, and the shape exists to be extended by `M7` without one. Inventing
 * `geo` and `room` now would be guessing at a design `07` has not made.
 */
export const LocationSchema = capped(
  z.object({ text: z.string().min(1).max(300) }),
  CALENDAR_JSON_MAX_BYTES,
  'event location',
);

export type Location = z.infer<typeof LocationSchema>;

/**
 * `events.source` (`07` §214): where an event came from.
 *
 * The three arms decide how the event may be *changed*. A `native` event is the group's own. A
 * `subscription` event is a mirror of someone else's feed, so an edit would be overwritten on the
 * next refresh — and `uid`/`sequence` are what make the refresh a diff rather than a delete and
 * re-insert, which would lose RSVPs. An `import` event came from a one-off file and is thereafter
 * the group's own, with `blobId` kept only for provenance.
 */
export const EventSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('native') }),
  z.object({
    kind: z.literal('subscription'),
    subscriptionId: z.string().max(40),
    uid: z.string().max(255),
    recurrenceId: z.string().max(40).nullable(),
    /** The feed's own `SEQUENCE`, so a stale update is ignored rather than applied. */
    sequence: z.int().min(0),
  }),
  z.object({ kind: z.literal('import'), blobId: z.string().max(80) }),
]);

export type EventSource = z.infer<typeof EventSourceSchema>;

/**
 * `event_overrides.patch` (`02` §3.3.5): what one occurrence changes about its series.
 *
 * Every field is optional because an override is a **sparse** diff — "just this week, at 7
 * instead of 6" must not restate the title, or editing the series title would silently stop
 * applying to that occurrence.
 */
export const EventPatchSchema = z.object({
  title: z.string().max(200).optional(),
  /** Wall-clock, not an instant: an override moves the occurrence in the series' own zone. */
  startLocal: z.string().max(40).optional(),
  endLocal: z.string().max(40).optional(),
  location: LocationSchema.nullable().optional(),
  notes: z.string().max(2000).optional(),
});

export type EventPatch = z.infer<typeof EventPatchSchema>;

/* ──────────────────────────── The event aggregate (`02` §3.3.5) ──────────────────────────── */

/** `02` §3.3.5's `events.status`. `proposed` is `07`'s "not agreed yet". */
export const EVENT_STATUSES = ['proposed', 'tentative', 'confirmed', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** Whether an event asks for RSVPs (`02` §3.3.5). */
export const ATTENDEES_MODES = ['none', 'rsvp'] as const;
export type AttendeesMode = (typeof ATTENDEES_MODES)[number];

/**
 * A calendar event (`02` §3.3.5; semantics in `07`).
 *
 * ## Why there are two of every time
 *
 * `startLocal`/`tz` and `startAt` are the same moment stored twice, and `02` D3 calls the second
 * one "derived". The local wall time is what a member *said* — "Tuesday at six" — and the instant
 * is what a query can range-scan. They are kept together because neither can reconstruct the other
 * safely: an instant alone loses the zone a recurring event recurs in (so a weekly 6pm event would
 * drift an hour across a DST boundary), and a local time alone cannot be compared to `now`.
 *
 * `tzdataVersion` is stamped for the same reason: a zone's rules change, and an event booked under
 * the old rules has to be recognisable as such when `12`'s tzdata update lands.
 *
 * ## `seriesId` and `splitFromEventId`
 *
 * A recurring event is one row with an `rrule`; `07` expands it. Editing a single occurrence
 * **splits** it into a new row that keeps the `seriesId` and records what it split from — so "move
 * this week's dinner" does not rewrite the series, and the series can still be found.
 */
export interface Event {
  readonly rid: number;
  readonly id: EventId;
  readonly groupId: GroupId;
  /** The series this belongs to. Equal to `id` for an unsplit event. */
  readonly seriesId: EventId;
  readonly splitFromEventId: EventId | undefined;
  readonly title: string;
  readonly notes: string | undefined;
  readonly url: string | undefined;
  readonly location: Location | undefined;
  readonly allDay: boolean;
  readonly tz: TimeZoneId;
  /** The wall time a member named, e.g. `2026-11-10T18:00`. */
  readonly startLocal: string;
  readonly endLocal: string | undefined;
  /** `02` D3's derived instant, for range scans (Q-CTX-6). */
  readonly startAt: Temporal.Instant;
  readonly endAt: Temporal.Instant | undefined;
  readonly rrule: string | undefined;
  /** Set when the stored `rrule` no longer parses, so `07` degrades instead of failing. */
  readonly rruleInvalid: boolean;
  readonly rdates: readonly string[];
  readonly exdates: readonly string[];
  readonly recurrenceUntilAt: Temporal.Instant | undefined;
  readonly status: EventStatus;
  readonly busy: boolean;
  readonly attendeesMode: AttendeesMode;
  readonly leadTimes: readonly string[] | undefined;
  readonly source: EventSource;
  readonly subscriptionId: CalendarSubscriptionId | undefined;
  readonly sourceUid: string | undefined;
  readonly sourceRecurrenceId: string | undefined;
  readonly contentHash: Uint8Array | undefined;
  readonly planId: PlanId | undefined;
  readonly labelId: LabelId;
  readonly createdByMemberId: MemberId | undefined;
  readonly updatedByMemberId: MemberId | undefined;
  readonly icsUid: string;
  readonly icsSequence: number;
  readonly tzdataVersion: string;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
  readonly version: number;
}

/**
 * What a caller supplies to create an event.
 *
 * `startAt`/`endAt` are **not** here: `02` D3 derives them from `startLocal` and `tz`, and a caller
 * that supplied both could make them disagree — an event that displays as Tuesday and fires on
 * Wednesday. `07` owns the conversion and passes the local time; the repository derives the instant.
 *
 * `seriesId` is also absent. An unsplit event is its own series, and letting a caller set it would
 * make it possible to create an event already claiming to belong to somebody else's recurrence.
 */
export interface NewEvent {
  readonly id: EventId;
  readonly groupId: GroupId;
  readonly title: string;
  readonly notes?: string | undefined;
  readonly url?: string | undefined;
  readonly location?: Location | undefined;
  readonly allDay?: boolean | undefined;
  readonly tz: TimeZoneId;
  readonly startLocal: string;
  readonly endLocal?: string | undefined;
  /** The derived instants, computed by the caller's `07` conversion from `startLocal` and `tz`. */
  readonly startAt: Temporal.Instant;
  readonly endAt?: Temporal.Instant | undefined;
  readonly rrule?: string | undefined;
  readonly rdates?: readonly string[] | undefined;
  readonly exdates?: readonly string[] | undefined;
  readonly recurrenceUntilAt?: Temporal.Instant | undefined;
  readonly status?: EventStatus | undefined;
  readonly busy: boolean;
  readonly attendeesMode?: AttendeesMode | undefined;
  readonly leadTimes?: readonly string[] | undefined;
  readonly source: EventSource;
  readonly subscriptionId?: CalendarSubscriptionId | undefined;
  readonly sourceUid?: string | undefined;
  readonly sourceRecurrenceId?: string | undefined;
  readonly contentHash?: Uint8Array | undefined;
  readonly planId?: PlanId | undefined;
  readonly createdByMemberId?: MemberId | undefined;
  /** `07`'s ICS identity. Unique across the instance, so a feed can be re-imported. */
  readonly icsUid: string;
  readonly tzdataVersion: string;
}

/** `02` §3.3.5's `event_attendees.response`. */
export const RSVP_RESPONSES = ['needs_action', 'accepted', 'declined', 'tentative'] as const;
export type RsvpResponse = (typeof RSVP_RESPONSES)[number];

/** One member's RSVP to an event (`02` §3.3.5). */
export interface EventAttendee {
  readonly eventId: EventId;
  readonly memberId: MemberId;
  readonly response: RsvpResponse;
  readonly respondedAt: Temporal.Instant | undefined;
}

/**
 * Whether an event occupies time, for `07`'s conflict detection.
 *
 * `busy` is a column rather than derived from the status, because the two are independent: a
 * `tentative` event can still block a slot ("might be at the dentist"), and a `confirmed` one can
 * be free-time ("school term starts"). Conflating them would make every tentative plan invisible
 * to conflict checking.
 */
export function occupiesTime(event: Pick<Event, 'busy' | 'status'>): boolean {
  return event.busy && event.status !== 'cancelled';
}
