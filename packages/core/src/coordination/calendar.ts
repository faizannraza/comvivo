/**
 * Calendar JSON columns (`02` §3.3.5; `07` §3.1).
 */
import { capped, z } from '@comvivo/shared';

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
