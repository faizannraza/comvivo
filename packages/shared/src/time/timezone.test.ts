/**
 * `TimeZoneId` (`02` §3.1, D3).
 *
 * The zones chosen here are not arbitrary — each one is a case this product has to get right, and
 * `02` §9.1's `schedule.next` cases name most of them:
 *
 *  - `America/New_York` and `Europe/London`, the ordinary DST cases, which disagree about *when*;
 *  - `Australia/Lord_Howe`, whose DST shift is **30 minutes**, so any code that assumes an hour is
 *    wrong there and nowhere else;
 *  - `Asia/Kathmandu` at **+05:45**, so any code that assumes whole-hour offsets is wrong;
 *  - `Pacific/Apia`, which **skipped a whole day** in 2011;
 *  - fixed offsets like `+05:45`, which a host may configure directly.
 *
 * Validation is a round trip through Temporal because no pattern can distinguish `Europe/London`
 * from `Europe/Londen` — only the platform's tzdata can.
 */
import { describe, expect, it } from 'vitest';
import {
  isCanonicalTimeZoneId,
  isTimeZoneId,
  parseTimeZoneId,
  type TimeZoneId,
  timeZoneIdSchema,
  UTC,
} from './timezone.js';

/** The zones `02` §9.1's scheduling cases name, plus the ones that break naive assumptions. */
const REAL_ZONES = [
  'UTC',
  'Europe/London',
  'America/New_York',
  'Australia/Lord_Howe',
  'Asia/Kathmandu',
  'Pacific/Apia',
  'Asia/Tokyo',
  'America/Sao_Paulo',
  'Africa/Cairo',
  'Pacific/Auckland',
];

describe('zones this product has to handle', () => {
  it.each(REAL_ZONES)('accepts %s', (zone) => {
    expect(parseTimeZoneId(zone)).toBe(zone);
    expect(isTimeZoneId(zone)).toBe(true);
  });

  it('accepts a fixed offset, including a 45-minute one', () => {
    // A host may configure an offset directly, and `Asia/Kathmandu`'s +05:45 is why a 45-minute
    // offset has to work rather than being assumed impossible.
    expect(parseTimeZoneId('+05:45')).toBe('+05:45');
    expect(parseTimeZoneId('-03:00')).toBe('-03:00');
  });

  it('keeps a link name rather than collapsing it to its target', () => {
    // `US/Eastern` denotes the same zone as `America/New_York`. Temporal does not collapse it, and
    // neither should this: `02` D3 stores what the host chose, and two identifiers for one zone is
    // a fact about tzdata rather than a problem to normalise away.
    expect(parseTimeZoneId('US/Eastern')).toBe('US/Eastern');
    expect(parseTimeZoneId('Asia/Calcutta')).toBe('Asia/Calcutta');
  });
});

describe('canonicalisation (the refinement over 02 §3.1)', () => {
  it('normalises case, which is what makes canonicalising on write necessary', () => {
    // **The finding.** Temporal normalises case, so a zone validated but not canonicalised would
    // let `europe/london` into a column — and `02` D3 compares a stored `tz` against another `tz`
    // to decide whether a derived `*_at` is still valid. Two spellings of one zone is a
    // stale-derivation bug that no test of the recurrence logic itself would find.
    expect(parseTimeZoneId('europe/london')).toBe('Europe/London');
    expect(parseTimeZoneId('EUROPE/LONDON')).toBe('Europe/London');
    expect(parseTimeZoneId('utc')).toBe('UTC');
    expect(parseTimeZoneId('aMeRiCa/nEw_YoRk')).toBe('America/New_York');
  });

  it('reports whether a string is already canonical', () => {
    expect(isCanonicalTimeZoneId('Europe/London')).toBe(true);
    expect(isCanonicalTimeZoneId('europe/london')).toBe(false);
    expect(isCanonicalTimeZoneId('nonsense')).toBe(false);
  });

  it('is idempotent, so canonicalising twice changes nothing', () => {
    for (const zone of [...REAL_ZONES, 'europe/london', 'US/Eastern']) {
      const once = parseTimeZoneId(zone);
      expect(once).toBeDefined();
      if (once === undefined) continue;
      expect(parseTimeZoneId(once)).toBe(once);
    }
  });
});

describe('zones it refuses', () => {
  it.each(['', ' ', 'Europe/Londen', 'not/a/zone', 'Mars/Olympus_Mons', '12:00', 'Europe//London'])(
    'refuses %s',
    (value) => {
      expect(parseTimeZoneId(value)).toBeUndefined();
      expect(isTimeZoneId(value)).toBe(false);
    },
  );

  it('refuses a plausible typo, which a regex could never catch', () => {
    // The reason validation is a round trip and not a pattern: `Europe/Londen` has the right
    // shape, the right separator and a real continent. Only tzdata knows it is not a zone.
    expect(isTimeZoneId('Europe/London')).toBe(true);
    expect(isTimeZoneId('Europe/Londen')).toBe(false);
  });

  it('returns undefined rather than throwing, so a boundary can choose', () => {
    // Config reports `config.invalid`, a column mapper raises `STORAGE_CORRUPT`, and a form asks
    // again. A throw here would force every caller into a `try`.
    expect(() => parseTimeZoneId('nope')).not.toThrow();
  });
});

describe('the schema transforms rather than only refining', () => {
  it('returns the canonical form from a valid input', () => {
    expect(timeZoneIdSchema.parse('europe/london')).toBe('Europe/London');
    expect(timeZoneIdSchema.parse('UTC')).toBe('UTC');
  });

  it('rejects an unknown zone with a message naming the value', () => {
    const outcome = timeZoneIdSchema.safeParse('Europe/Londen');
    expect(outcome.success).toBe(false);
    if (outcome.success) return;
    expect(outcome.error.issues[0]?.message).toContain('Europe/Londen');
  });

  it('rejects a non-string', () => {
    expect(timeZoneIdSchema.safeParse(42).success).toBe(false);
    expect(timeZoneIdSchema.safeParse(undefined).success).toBe(false);
  });

  it('normalises at the boundary, so a column never sees a non-canonical zone', () => {
    // Transform rather than refine is the whole point: a refining schema would accept
    // `europe/london` and pass it through unchanged, which is how two spellings reach the database.
    const parsed = timeZoneIdSchema.parse('aMeRiCa/nEw_YoRk');
    expect(isCanonicalTimeZoneId(parsed)).toBe(true);
  });
});

describe('the UTC constant', () => {
  it('is a pre-validated TimeZoneId', () => {
    const zone: TimeZoneId = UTC;
    expect(zone).toBe('UTC');
    expect(isCanonicalTimeZoneId(UTC)).toBe(true);
  });
});
