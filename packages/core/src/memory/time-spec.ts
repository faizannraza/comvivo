/**
 * `TimeSpec` — a time a person expressed, before it becomes a scheduled instant (`04` §3.2.2).
 *
 * The four variants exist because people do not speak in instants, and collapsing what they said
 * into one would lose the part that matters:
 *
 *  - **`instant`** — "Friday at 18:00". Resolvable to a single point.
 *  - **`date`** — "on the 12th". A whole day; a reminder for it is not a reminder for midnight.
 *  - **`range`** — "between 2 and 4". Both ends matter.
 *  - **`fuzzy`** — "end of the month". `text` keeps what was said and `earliest`/`latest` bound it,
 *    so the agent can ask rather than invent a precision nobody offered.
 *
 * Every variant carries `tz`, because an instant without a zone is not a time: `04` §3.2.5 makes
 * `validFrom`/`validTo` **world time**, and a commitment made in `Asia/Kathmandu` is due at
 * +05:45 whoever reads it. The zone is validated and canonicalised by `timeZoneIdSchema`
 * (`M1-T10`), which is `04`'s `IanaTz` — a round trip through Temporal's own tzdata, because no
 * pattern can tell `Europe/London` from `Europe/Londen`.
 */
import { timeZoneIdSchema, z } from '@comvivo/shared';

/** `04`'s `IanaTz`: a zone validated against the platform's tzdata and canonicalised on the way in. */
export const ianaTzSchema = timeZoneIdSchema;

export const TimeSpecSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('instant'), at: z.iso.datetime({ offset: true }), tz: ianaTzSchema }),
  z.object({ t: z.literal('date'), date: z.iso.date(), tz: ianaTzSchema }),
  z.object({
    t: z.literal('range'),
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    tz: ianaTzSchema,
  }),
  z.object({
    t: z.literal('fuzzy'),
    text: z.string().max(80),
    earliest: z.iso.date().nullable(),
    latest: z.iso.date().nullable(),
    tz: ianaTzSchema,
  }),
]);

/** A time as a person expressed it. */
export type TimeSpec = z.infer<typeof TimeSpecSchema>;
