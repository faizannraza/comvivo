/**
 * `instantSchema` and its helpers (`CLAUDE.md` §2: validate every boundary with zod).
 *
 * The acceptance rule is the point of this file: **an ISO-8601 instant with an offset, or a
 * `Temporal.Instant` already in hand, and nothing else.** Two rejections carry the reasoning —
 * a bare wall time, which names a time without saying where, and epoch milliseconds, which are
 * ambiguous between seconds and milliseconds in a way that parses either way.
 */
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { instantSchema, isStorableInstant, MAX_INSTANT_EPOCH_MS, parseInstant } from './instant.js';

describe('parseInstant', () => {
  it('accepts an instant with Z or an explicit offset', () => {
    expect(parseInstant('2026-11-08T12:00:00Z')?.epochMilliseconds).toBe(
      Date.UTC(2026, 10, 8, 12, 0, 0),
    );
    // The same instant, named from Warsaw. An offset is what makes a string unambiguous.
    expect(parseInstant('2026-11-08T13:00:00+01:00')?.epochMilliseconds).toBe(
      Date.UTC(2026, 10, 8, 12, 0, 0),
    );
    expect(parseInstant('2026-11-08T12:00:00.123Z')?.epochMilliseconds).toBe(
      Date.UTC(2026, 10, 8, 12, 0, 0) + 123,
    );
  });

  it('refuses a wall time with no offset', () => {
    // `2026-11-08T10:00:00` names a time without saying where, so it is not an instant. Accepting
    // it would mean silently choosing a zone — and the zone that would get chosen is the server's,
    // which is the one nobody intended.
    expect(parseInstant('2026-11-08T10:00:00')).toBeUndefined();
    expect(parseInstant('2026-11-08')).toBeUndefined();
  });

  it('refuses nonsense without throwing', () => {
    for (const bad of ['', 'tomorrow', '1762603200000', 'not-a-date', '2026-13-45T00:00:00Z']) {
      expect(parseInstant(bad), bad).toBeUndefined();
    }
  });

  it('refuses an instant before the epoch, which the column cannot store', () => {
    // Representable by Temporal, not by `02` §3.1's `instantMs` columns, which hold non-negative
    // epoch milliseconds. The asymmetry is deliberate: a date in 1960 is a `PlainDate`, and an
    // *event* before the epoch is a bug in whatever produced it.
    expect(parseInstant('1960-01-01T00:00:00Z')).toBeUndefined();
  });

  it('refuses an instant past the storable range', () => {
    expect(parseInstant('+300000-01-01T00:00:00Z')).toBeUndefined();
  });
});

describe('isStorableInstant', () => {
  it('accepts the epoch and the upper bound', () => {
    expect(isStorableInstant(Temporal.Instant.fromEpochMilliseconds(0))).toBe(true);
    expect(isStorableInstant(Temporal.Instant.fromEpochMilliseconds(MAX_INSTANT_EPOCH_MS))).toBe(
      true,
    );
  });

  it('refuses one millisecond before the epoch', () => {
    expect(isStorableInstant(Temporal.Instant.fromEpochMilliseconds(-1))).toBe(false);
  });
});

describe('instantSchema', () => {
  it('transforms a string into a Temporal.Instant', () => {
    const parsed = instantSchema.parse('2026-11-08T12:00:00Z');
    // Transforms rather than refines, so every boundary that validates also normalises — the same
    // reasoning as `timeZoneIdSchema`. Downstream code never has to ask which form it received.
    expect(parsed).toBeInstanceOf(Temporal.Instant);
    expect(parsed.epochMilliseconds).toBe(Date.UTC(2026, 10, 8, 12, 0, 0));
  });

  it('passes a Temporal.Instant through unchanged', () => {
    const instant = Temporal.Instant.from('2026-11-08T12:00:00Z');
    expect(instantSchema.parse(instant)).toBe(instant);
  });

  it('refuses an out-of-range Temporal.Instant', () => {
    const before = Temporal.Instant.fromEpochMilliseconds(-1);
    const result = instantSchema.safeParse(before);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toContain('storable range');
  });

  it('says what it wanted when the string is not an instant', () => {
    const result = instantSchema.safeParse('2026-11-08T10:00:00');
    expect(result.success).toBe(false);
    if (result.success) return;
    // The message names the requirement, not just the failure: a developer who sees "with an
    // offset" adds a `Z` rather than guessing at the format.
    expect(result.error.issues[0]?.message).toContain('offset');
  });

  it('refuses a number, because epoch milliseconds are ambiguous', () => {
    // Seconds or milliseconds? A wrong guess gives a date in 1970 or in the year 56000, and both
    // parse — so neither is caught. A string with an offset cannot be misread.
    expect(instantSchema.safeParse(1_762_603_200_000).success).toBe(false);
    expect(instantSchema.safeParse(1_762_603_200).success).toBe(false);
  });

  it('refuses null, undefined and a Date', () => {
    expect(instantSchema.safeParse(null).success).toBe(false);
    expect(instantSchema.safeParse(undefined).success).toBe(false);
    // A `Date` is a plausible thing for a caller to reach for and is deliberately not accepted:
    // this codebase uses Temporal throughout (`01` §4), and one accepted `Date` is how the two
    // start mixing.
    expect(instantSchema.safeParse(new Date()).success).toBe(false);
  });
});
