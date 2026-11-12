/**
 * `TimeZoneId` — a validated IANA time-zone identifier (`02` §3.1, D3).
 *
 * A branded string rather than a bare one, because this product's hardest correctness problems are
 * time-zone problems: a family split over three zones, quiet hours that must hold per member in
 * their own zone, a recurrence that crosses a DST boundary. `01` §11.4 bans `Date` from `core` for
 * the same reason. A `string` zone is one typo away from a reminder that fires at the wrong hour
 * for one person and nobody notices for a month.
 *
 * ## Validation is a round trip through Temporal, not a regex
 *
 * There is no pattern that distinguishes `Europe/London` from `Europe/Londen` — only the tzdata
 * the platform ships can. Measured on `temporal-polyfill`: resolving an instant into a zone throws
 * `RangeError` for an unknown id and succeeds for every real one, including the awkward cases this
 * product has to handle (`Australia/Lord_Howe`'s 30-minute DST, `Asia/Kathmandu`'s +05:45 offset)
 * and for fixed offsets like `+05:45`.
 *
 * ## Canonicalisation, which is the part that bites
 *
 * **Temporal normalises case**: `utc` becomes `UTC` and `EUROPE/LONDON` becomes `Europe/London`.
 * So two stored strings can denote the same zone while comparing unequal — and `02` §3.1's D3
 * calendar design stores `tz` alongside `*_local` and a derived `*_at`, which means a zone string
 * is compared against another zone string when deciding whether a derived value is still valid.
 *
 * `parseTimeZoneId` therefore returns the **canonical** form, and `02` §3.1's "validated via
 * Temporal on read" is extended to canonicalise on write as well. Logged as a refinement in
 * `STATUS.md`: validating only on read would let `europe/london` into a column and leave every
 * later comparison against `Europe/London` false.
 *
 * Link names (`US/Eastern`, `Asia/Calcutta`) are **not** collapsed to their targets, because
 * Temporal does not collapse them and because a host who chose one should keep seeing it. They are
 * valid identifiers; they are simply not unique per zone.
 */
import { Temporal } from 'temporal-polyfill';
import { z } from '../zod.js';

declare const timeZoneBrand: unique symbol;

/** An IANA zone id or fixed offset the platform's tzdata recognises, in canonical form. */
export type TimeZoneId = string & { readonly [timeZoneBrand]: true };

/** `UTC`, pre-validated. The default for anything that has no better answer. */
export const UTC = 'UTC' as TimeZoneId;

/**
 * Canonicalise and validate a zone id, or return `undefined`.
 *
 * `undefined` rather than throwing, so a boundary can decide: config reports a `config.invalid`,
 * a column mapper raises `STORAGE_JSON_INVALID`, and a user-facing form asks again.
 */
export function parseTimeZoneId(value: string): TimeZoneId | undefined {
  // An empty string is accepted by neither Temporal nor anything else, but checking it here keeps
  // the error out of the hot path for the commonest bad input.
  if (value === '') return undefined;
  try {
    // The round trip is the validation **and** the canonicalisation: `timeZoneId` comes back in the
    // form Temporal uses, which is what every later comparison will see.
    return Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(value)
      .timeZoneId as TimeZoneId;
  } catch {
    // `RangeError` for an unknown zone. Nothing else is thrown by this call, and swallowing it is
    // right: the caller asked a yes-or-no question.
    return undefined;
  }
}

/** Is this a zone the platform recognises? */
export function isTimeZoneId(value: string): value is TimeZoneId {
  return parseTimeZoneId(value) !== undefined;
}

/**
 * Is this string already canonical?
 *
 * Needed by storage: a value read back from a column should already be canonical, and one that is
 * not means something wrote around the column mapper.
 */
export function isCanonicalTimeZoneId(value: string): boolean {
  return parseTimeZoneId(value) === value;
}

/**
 * A zod schema that **transforms** to the canonical form.
 *
 * Transforming rather than refining, so every boundary that validates a zone also normalises it —
 * which is the only way `europe/london` and `Europe/London` cannot both end up in the database.
 */
export const timeZoneIdSchema: z.ZodType<TimeZoneId> = z.string().transform((value, context) => {
  const canonical = parseTimeZoneId(value);
  if (canonical === undefined) {
    context.addIssue({
      code: 'custom',
      message: `not a time zone this platform knows: ${JSON.stringify(value)}`,
    });
    return z.NEVER;
  }
  return canonical;
});
