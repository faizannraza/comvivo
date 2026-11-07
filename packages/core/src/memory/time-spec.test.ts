/**
 * `TimeSpec` (`04` §3.2.2).
 *
 * The cases that matter are the ones where a variant exists because collapsing it would lose
 * something: a date is not an instant at midnight, and a fuzzy time is not a guess.
 */
import { describe, expect, it } from 'vitest';
import { TimeSpecSchema } from './time-spec.js';

describe('the four variants', () => {
  it('accepts an instant with a zone', () => {
    const value = { t: 'instant' as const, at: '2026-11-13T18:00:00+05:00', tz: 'Asia/Karachi' };
    expect(TimeSpecSchema.parse(value)).toEqual(value);
  });

  it('accepts a whole-day date', () => {
    const value = { t: 'date' as const, date: '2026-11-13', tz: 'Europe/London' };
    expect(TimeSpecSchema.parse(value)).toEqual(value);
  });

  it('accepts a range', () => {
    const value = {
      t: 'range' as const,
      start: '2026-11-13T14:00:00Z',
      end: '2026-11-13T16:00:00Z',
      tz: 'UTC',
    };
    expect(TimeSpecSchema.parse(value)).toEqual(value);
  });

  it('accepts a fuzzy time with open bounds', () => {
    // "end of the month" with nothing known about the edges. Both bounds nullable is what keeps
    // the agent from inventing a precision nobody offered.
    const value = {
      t: 'fuzzy' as const,
      text: 'end of the month',
      earliest: null,
      latest: null,
      tz: 'America/New_York',
    };
    expect(TimeSpecSchema.parse(value)).toEqual(value);
  });
});

describe('the zone', () => {
  it('canonicalises rather than merely validating', () => {
    // `timeZoneIdSchema` transforms (`M1-T10`), so a stored `TimeSpec` never holds two spellings
    // of one zone — which `02` D3 compares to decide whether a derived instant is still valid.
    const parsed = TimeSpecSchema.parse({ t: 'date', date: '2026-11-13', tz: 'europe/london' });
    expect(parsed.tz).toBe('Europe/London');
  });

  it('refuses a zone the platform does not know', () => {
    expect(
      TimeSpecSchema.safeParse({ t: 'date', date: '2026-11-13', tz: 'Europe/Londen' }).success,
    ).toBe(false);
  });

  it('requires a zone on every variant, because an instant without one is not a time', () => {
    expect(TimeSpecSchema.safeParse({ t: 'date', date: '2026-11-13' }).success).toBe(false);
    expect(TimeSpecSchema.safeParse({ t: 'instant', at: '2026-11-13T18:00:00Z' }).success).toBe(
      false,
    );
  });
});

describe('what it refuses', () => {
  it('refuses an instant with no offset', () => {
    expect(
      TimeSpecSchema.safeParse({ t: 'instant', at: '2026-11-13T18:00:00', tz: 'UTC' }).success,
    ).toBe(false);
  });

  it('refuses a date where a datetime belongs, and the reverse', () => {
    expect(TimeSpecSchema.safeParse({ t: 'instant', at: '2026-11-13', tz: 'UTC' }).success).toBe(
      false,
    );
    expect(
      TimeSpecSchema.safeParse({ t: 'date', date: '2026-11-13T18:00:00Z', tz: 'UTC' }).success,
    ).toBe(false);
  });

  it('refuses an unknown variant and over-long fuzzy text', () => {
    expect(TimeSpecSchema.safeParse({ t: 'soon', tz: 'UTC' }).success).toBe(false);
    expect(
      TimeSpecSchema.safeParse({
        t: 'fuzzy',
        text: 'x'.repeat(81),
        earliest: null,
        latest: null,
        tz: 'UTC',
      }).success,
    ).toBe(false);
  });
});
