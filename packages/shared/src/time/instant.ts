/**
 * A boundary schema for `Temporal.Instant` (`CLAUDE.md` §2: validate every boundary with zod).
 *
 * Every aggregate from `02` §3.3 onward carries instants that arrive from outside the process —
 * `joinedAt`, `sentAt`, an event's `startAt`, a reminder's `fireAt` — and each one needs the same
 * two things: a parse that rejects nonsense, and a *single* accepted wire form so two callers
 * cannot disagree about what a timestamp looks like.
 *
 * **The wire form is an ISO-8601 instant string**, not epoch milliseconds. A number is ambiguous
 * between seconds and milliseconds, and the symptom of guessing wrong is a date in 1970 or in the
 * year 56000 — both of which parse, so neither is caught. A string with an offset cannot be
 * misread. `Temporal.Instant` values pass through unchanged, so code that already holds one does
 * not have to serialise it just to be validated.
 *
 * The upper bound is **Temporal's own limit** rather than `Number.MAX_SAFE_INTEGER`, for the reason
 * `02`'s `instantMs` column records: a value between the two parses here and then throws a raw
 * `RangeError` out of Temporal, which is the failure this schema exists to turn into an issue.
 */
import { Temporal } from 'temporal-polyfill';
import { z } from '../zod.js';

/** Temporal's own representable range, in milliseconds either side of the epoch. */
export const MAX_INSTANT_EPOCH_MS = 8_640_000_000_000_000;

/**
 * Whether a `Temporal.Instant` is inside the range SQLite stores and Temporal represents.
 *
 * `02` §3.1's `instantMs` columns hold **non-negative** epoch milliseconds, so an instant before
 * 1970 is storable by Temporal and not by the schema. That asymmetry is deliberate and belongs to
 * the column, not here: a birthday in 1960 is a `PlainDate`, and an *event* before the epoch is a
 * bug in whatever produced it.
 */
export function isStorableInstant(value: Temporal.Instant): boolean {
  const ms = value.epochMilliseconds;
  return Number.isInteger(ms) && ms >= 0 && ms <= MAX_INSTANT_EPOCH_MS;
}

/**
 * Parse an ISO-8601 instant string, returning `undefined` rather than throwing.
 *
 * Separate from the schema so non-zod callers (a CLI argument, a header) get the same acceptance
 * rule. `Temporal.Instant.from` requires an offset or `Z`, which is what makes this unambiguous —
 * a bare `2026-11-08T10:00:00` is refused, because it names a wall time and not an instant.
 */
export function parseInstant(value: string): Temporal.Instant | undefined {
  try {
    const instant = Temporal.Instant.from(value);
    return isStorableInstant(instant) ? instant : undefined;
  } catch {
    // `from` throws `RangeError` for an out-of-range value and `SyntaxError` for a malformed one.
    // Both mean the same thing to a caller — this is not an instant — and neither is worth
    // distinguishing in a return type nobody would branch on.
    return undefined;
  }
}

/**
 * An instant at a boundary: an ISO-8601 string, or a `Temporal.Instant` already in hand.
 *
 * Transforms rather than refines, so every boundary that validates a timestamp also *normalises*
 * it — the same reasoning as `timeZoneIdSchema`. The output is always a `Temporal.Instant`, so no
 * downstream code has to ask which of the two forms it received.
 */
export const instantSchema: z.ZodType<Temporal.Instant> = z
  .union([z.string(), z.instanceof(Temporal.Instant)])
  .transform((value, context) => {
    if (typeof value !== 'string') {
      if (isStorableInstant(value)) return value;
      context.addIssue({
        code: 'custom',
        message: `instant outside the storable range: ${value.toString()}`,
      });
      return z.NEVER;
    }
    const parsed = parseInstant(value);
    if (parsed === undefined) {
      context.addIssue({
        code: 'custom',
        message: `not an ISO-8601 instant with an offset: ${JSON.stringify(value)}`,
      });
      return z.NEVER;
    }
    return parsed;
  });
