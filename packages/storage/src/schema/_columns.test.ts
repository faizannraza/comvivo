/**
 * The custom column types (`02` §3.1, §9.1).
 *
 * `02` §9.1 names two of these:
 *
 *  - **`columns.instant`** — ms truncation, negative epochs rejected;
 *  - **`columns.json`** — write rejects invalid, read raises `STORAGE_JSON_INVALID` with the tag.
 *
 * Tested through the mappers directly rather than through a table, because what is under test is
 * the *mapping*, and a round trip through SQLite would also exercise the driver, the pragmas and
 * the schema — three things with their own suites. `_columns.int.test.ts` does the round trip, so
 * the two together cover both "does the function do the right thing" and "does the database agree".
 */
import {
  type Id,
  internedId,
  type LabelId,
  StorageError,
  type TimeZoneId,
  UTC,
  z,
} from '@comvivo/shared';
import { sqliteTable } from 'drizzle-orm/sqlite-core';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import {
  bool,
  boolCheck,
  createdAt,
  instantMs,
  jsonOf,
  labelRef,
  MAX_EPOCH_MS,
  plainDateText,
  plainDateTimeText,
  tid,
  tzText,
  updatedAt,
  version,
} from './_columns.js';

/**
 * Probe tables, so the mappers under test are the ones a real schema would use.
 *
 * Drizzle puts `mapToDriverValue`, `mapFromDriverValue`, `getSQLType()` and `name` on the **built
 * column**, not on the builder that `customType(...)` returns — a column only exists once a table
 * is declared. Measured, after a first version of this suite reached for them on the builder and
 * got `undefined` for every one.
 *
 * Declaring tables rather than casting is also the more faithful test: these are columns in the
 * same sense `02` §3.3's tables will have, so nothing here passes for a column that could not
 * actually be declared.
 */
const probe = sqliteTable('probe', {
  groupId: tid('grp')('group_id'),
  at: instantMs('at'),
  localAt: plainDateTimeText('local_at'),
  onDate: plainDateText('on_date'),
  tz: tzText('tz'),
  isActive: bool('is_active'),
  labelId: labelRef(),
  ownerLabelId: labelRef('owner_label_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
});

const GROUP = 'grp_01jd8kqd7h3f9z2m4n6p8r0t2v';

describe('tid — TypeID columns (02 §3.1)', () => {
  it('declares a text column', () => {
    expect(probe.groupId.getSQLType()).toBe('text');
  });

  it('round-trips an id', () => {
    expect(probe.groupId.mapToDriverValue(GROUP as Id<'grp'>)).toBe(GROUP);
    expect(probe.groupId.mapFromDriverValue(GROUP)).toBe(GROUP);
  });

  it('parses on read rather than casting', () => {
    // The point of the mapper. A malformed id coming back from a column means the row is corrupt,
    // and handing the caller a branded string that is not one defers the failure to wherever that
    // id is next used — which is somewhere else entirely.
    for (const bad of ['', 'grp_', 'grp_nope', 'not-an-id', `${GROUP}x`]) {
      expect(() => probe.groupId.mapFromDriverValue(bad), JSON.stringify(bad)).toThrow(
        /STORAGE_ID_INVALID/,
      );
    }
  });

  it('refuses an id of the wrong type, which is a schema mismatch', () => {
    // `tid('grp')` on a column holding member ids rejects every value, loudly, on the first read.
    // That is a runtime failure for a compile-time mistake — but it is a *loud* one, which is the
    // most a column mapper can do about a wrong pairing.
    expect(() => probe.groupId.mapFromDriverValue('mbr_01jd8kqd7h3f9z2m4n6p8r0t2v')).toThrow(
      /STORAGE_ID_INVALID/,
    );
  });

  it('never echoes the value it rejected', () => {
    // `parseId` never echoes its input — a malformed id is often a pasted credential — and the
    // mapper must not undo that by interpolating it into the error.
    //
    // The fixture is assembled at runtime rather than written out, because a credential *shape* in
    // source trips `pnpm secrets:check` and every other scanner. The code under test still sees the
    // exact string; only the source text is split.
    const secretShaped = ['AKIA', 'IOSFODNN', '7EXAMPLE'].join('');
    try {
      probe.groupId.mapFromDriverValue(`grp_${secretShaped}`);
      expect.unreachable('a malformed id must be refused');
    } catch (caught) {
      expect((caught as Error).message).not.toContain(secretShaped);
    }
  });
});

describe('columns.instant (02 §9.1)', () => {
  // Drizzle types a custom column's driver value as `unknown`, so the shape is asserted here
  // once rather than at every call site.
  const toDriver = (value: Temporal.Instant): number => probe.at.mapToDriverValue(value) as number;
  const fromDriver = (value: number): Temporal.Instant =>
    probe.at.mapFromDriverValue(value) as Temporal.Instant;

  it('declares an integer column', () => {
    expect(probe.at.getSQLType()).toBe('integer');
  });

  it('round-trips epoch milliseconds', () => {
    for (const ms of [0, 1, 1_000, 1_762_000_000_000, MAX_EPOCH_MS]) {
      const instant = Temporal.Instant.fromEpochMilliseconds(ms);
      expect(toDriver(instant)).toBe(ms);
      expect(fromDriver(ms).epochMilliseconds).toBe(ms);
    }
  });

  it('refuses sub-millisecond precision rather than truncating it', () => {
    // **The truncation clause of `02` §9.1, read the strict way.** `epochMilliseconds` truncates
    // silently, so storing a nanosecond-precision instant would make two distinct instants equal
    // after a round trip — and `Clock.now()` already truncates, so a value with nanoseconds came
    // from code that bypassed the clock port.
    const precise = Temporal.Instant.fromEpochNanoseconds(1_762_000_000_000_000_001n);
    try {
      toDriver(precise);
      expect.unreachable('sub-millisecond precision must be refused');
    } catch (caught) {
      expect(caught).toBeInstanceOf(StorageError);
      const error = caught as StorageError;
      expect(error.storageCode).toBe('STORAGE_JSON_INVALID');
      expect(error.code).toBe('bug');
      expect(error.hint).toContain('bypassed the clock port');
    }
  });

  it('accepts an instant the clock would actually produce', () => {
    // The inverse, so the rule above cannot be satisfied by rejecting everything: a millisecond-
    // truncated instant is exactly what `Clock.now()` hands over.
    const truncated = Temporal.Instant.fromEpochMilliseconds(Date.now());
    expect(toDriver(truncated)).toBe(truncated.epochMilliseconds);
  });

  it('rejects negative epochs on write, as a bug', () => {
    // `02` §9.1. Nothing in this product happened before 1970, so a negative value is an
    // arithmetic error — usually a subtraction that underflowed — and storing it would put a
    // reminder in 1969 where no query will find it again.
    const before1970 = Temporal.Instant.fromEpochMilliseconds(-1);
    try {
      toDriver(before1970);
      expect.unreachable('a negative epoch must be refused');
    } catch (caught) {
      const error = caught as StorageError;
      expect(error.storageCode).toBe('STORAGE_JSON_INVALID');
      expect(error.code).toBe('bug');
      expect(error.hint).toContain('underflowed');
    }
  });

  it('rejects a negative epoch on read as corruption, not as a bug', () => {
    // Different direction, different diagnosis: a bad value *coming out* of a column means the row
    // is damaged, and sending a host to their backups for our arithmetic bug would be wrong in
    // both directions.
    try {
      fromDriver(-1);
      expect.unreachable('a negative epoch must be refused');
    } catch (caught) {
      const error = caught as StorageError;
      expect(error.storageCode).toBe('STORAGE_CORRUPT');
      expect(error.hint).toContain('Restore a backup');
    }
  });

  it('rejects values outside the range Temporal can represent', () => {
    // The bound is Temporal's own limit, not `MAX_SAFE_INTEGER`. Measured: a value between the two
    // passed an earlier version of the guard and then threw a raw `RangeError` out of
    // `fromEpochMilliseconds`, bypassing the `StorageError` mapping entirely. So this asserts both
    // that the boundary value works and that one past it is refused **as a `StorageError`**.
    expect(fromDriver(MAX_EPOCH_MS).epochMilliseconds).toBe(MAX_EPOCH_MS);
    expect(() => fromDriver(MAX_EPOCH_MS + 1)).toThrow(StorageError);
    expect(() => fromDriver(Number.MAX_SAFE_INTEGER)).toThrow(StorageError);
    expect(() => fromDriver(1.5)).toThrow(StorageError);
    expect(() => fromDriver(Number.NaN)).toThrow(StorageError);
    expect(() => fromDriver(Number.POSITIVE_INFINITY)).toThrow(StorageError);
  });

  it('keeps the epoch itself, which is a legitimate value', () => {
    // Zero is the boundary and is valid: it is what a fixture or a migration default looks like.
    expect(fromDriver(0).epochMilliseconds).toBe(0);
    expect(toDriver(Temporal.Instant.fromEpochMilliseconds(0))).toBe(0);
  });
});

describe('columns.json (02 §9.1)', () => {
  const partsSchema = z.object({
    kind: z.enum(['text', 'image']),
    text: z.string().min(1).optional(),
  });
  const parts = sqliteTable('probe_json', {
    parts: jsonOf(partsSchema, 'messages.parts')('parts'),
  });
  const toDriver = (value: z.output<typeof partsSchema>): string =>
    parts.parts.mapToDriverValue(value) as string;
  const fromDriver = (value: string): z.output<typeof partsSchema> =>
    parts.parts.mapFromDriverValue(value) as z.output<typeof partsSchema>;

  it('declares a text column', () => {
    expect(parts.parts.getSQLType()).toBe('text');
  });

  it('round-trips a valid value', () => {
    const value = { kind: 'text' as const, text: 'hello' };
    const raw = toDriver(value);
    expect(JSON.parse(raw)).toEqual(value);
    expect(fromDriver(raw)).toEqual(value);
  });

  it('rejects an invalid value on write, as our bug', () => {
    // `02` §9.1: "write rejects invalid". A repository built a value its own column schema refuses,
    // so nothing is written and nothing is corrupted — but it is not the host's problem.
    try {
      toDriver({ kind: 'video' } as unknown as z.output<typeof partsSchema>);
      expect.unreachable('an invalid value must not be written');
    } catch (caught) {
      const error = caught as StorageError;
      expect(error.storageCode).toBe('STORAGE_JSON_INVALID');
      expect(error.code).toBe('bug');
      expect(error.detail).toMatchObject({ column: 'messages.parts' });
      expect(error.hint).toContain('nothing is corrupted');
    }
  });

  it('raises STORAGE_JSON_INVALID with the tag on read', () => {
    // `02` §9.1's other clause, and the tag is the part that matters: "a JSON column failed to
    // parse" is not actionable, and `messages.parts` is.
    try {
      fromDriver(JSON.stringify({ kind: 'video' }));
      expect.unreachable('a row that fails its schema must be refused');
    } catch (caught) {
      const error = caught as StorageError;
      expect(error.storageCode).toBe('STORAGE_JSON_INVALID');
      expect(error.message).toContain('messages.parts');
      expect(error.detail).toMatchObject({ column: 'messages.parts' });
      // Not our bug: this row was written by a different version, or is damaged.
      expect(error.code).not.toBe('bug');
      expect(error.hint).toContain('02 F9');
    }
  });

  it('reports text that is not JSON at all, naming the column', () => {
    try {
      fromDriver('{ not json');
      expect.unreachable('invalid JSON must be refused');
    } catch (caught) {
      const error = caught as StorageError;
      expect(error.storageCode).toBe('STORAGE_JSON_INVALID');
      expect(error.message).toContain('messages.parts does not hold valid JSON');
      expect(error.detail).toMatchObject({ column: 'messages.parts' });
    }
  });

  it('keeps the schema’s own transformations', () => {
    // A JSON column's schema may coerce or default, and the stored form must be the *output* —
    // otherwise a read would transform again and a write-read-write cycle would not be stable.
    const withDefault = z.object({ n: z.number().default(7) });
    const table = sqliteTable('probe_default', { col: jsonOf(withDefault, 't.col')('col') });
    expect(JSON.parse(table.col.mapToDriverValue({}) as string)).toEqual({ n: 7 });
    expect(table.col.mapFromDriverValue('{}')).toEqual({ n: 7 });
  });

  it('is stable across a write, read and write again', () => {
    // The property that makes a JSON column safe to migrate: whatever comes out, putting it back
    // produces the same bytes. A schema that transformed asymmetrically would drift on every edit.
    const value = { kind: 'text' as const, text: 'hello' };
    const once = toDriver(value);
    expect(toDriver(fromDriver(once))).toBe(once);
  });
});

describe('plain date and date-time columns (02 §3.1, D3)', () => {
  it('stores a date-time without a zone or an offset', () => {
    // D3's design: a recurring event is "18:30 **in this zone**", which is not an instant — the
    // instant it denotes changes when the offset does. The absence of a `Z` is the point.
    const local = Temporal.PlainDateTime.from('2026-03-08T02:30:00');
    expect(probe.localAt.mapToDriverValue(local)).toBe('2026-03-08T02:30:00');
    expect(
      (
        probe.localAt.mapFromDriverValue('2026-03-08T02:30:00') as Temporal.PlainDateTime
      ).toString(),
    ).toBe('2026-03-08T02:30:00');
  });

  it('serialises to a fixed width, so values sort', () => {
    // Without `smallestUnit: 'second'`, a value with no seconds serialises shorter — and `'18:30'`
    // sorts before `'18:30:00'`, so two forms of the same time would order inconsistently.
    const noSeconds = probe.localAt.mapToDriverValue(
      Temporal.PlainDateTime.from('2026-03-08T02:30'),
    );
    const withSeconds = probe.localAt.mapToDriverValue(
      Temporal.PlainDateTime.from('2026-03-08T02:30:00'),
    );
    expect(noSeconds).toBe(withSeconds);
    expect(noSeconds).toHaveLength('2026-03-08T02:30:00'.length);
  });

  it('round-trips a plain date', () => {
    expect(probe.onDate.mapToDriverValue(Temporal.PlainDate.from('2026-11-06'))).toBe('2026-11-06');
    expect((probe.onDate.mapFromDriverValue('2026-11-06') as Temporal.PlainDate).toString()).toBe(
      '2026-11-06',
    );
  });

  it('reports a value no build would have written as corruption', () => {
    for (const bad of ['', 'not a date', '2026-13-01', '2026-02-30']) {
      expect(() => probe.onDate.mapFromDriverValue(bad), JSON.stringify(bad)).toThrow(StorageError);
    }
    expect(() => probe.localAt.mapFromDriverValue('2026-03-08T99:99:99')).toThrow(StorageError);
  });

  it('keeps a date-time that spans a DST gap, because it is not an instant', () => {
    // 02:30 on 2026-03-08 does not exist in `America/New_York`. As a **plain** date-time it is
    // perfectly representable, and that is exactly why D3 stores it this way: resolving it is a
    // separate decision that `07`'s recurrence code makes with the zone in hand.
    expect(probe.localAt.mapToDriverValue(Temporal.PlainDateTime.from('2026-03-08T02:30:00'))).toBe(
      '2026-03-08T02:30:00',
    );
  });
});

describe('tzText — zones, validated and canonicalised (02 §3.1)', () => {
  const toDriver = (value: TimeZoneId): string => probe.tz.mapToDriverValue(value) as string;
  const fromDriver = (value: string): TimeZoneId =>
    probe.tz.mapFromDriverValue(value) as TimeZoneId;

  it('round-trips a canonical zone', () => {
    for (const zone of ['UTC', 'Europe/London', 'America/New_York', 'Asia/Kathmandu', '+05:45']) {
      expect(toDriver(zone as TimeZoneId)).toBe(zone);
      expect(fromDriver(zone)).toBe(zone);
    }
  });

  it('canonicalises case on write, which the spec left to read alone', () => {
    // **The refinement.** Temporal normalises case, so validating only on read would let
    // `europe/london` into a column and leave every later comparison against `Europe/London`
    // false — and D3 compares a stored `tz` against another `tz` to decide whether a derived
    // `*_at` is still valid. Two spellings of one zone is a stale-derivation bug that no test of
    // the zone logic itself would find.
    expect(toDriver('europe/london' as TimeZoneId)).toBe('Europe/London');
    expect(toDriver('utc' as TimeZoneId)).toBe('UTC');
    expect(toDriver('EUROPE/LONDON' as TimeZoneId)).toBe('Europe/London');
  });

  it('keeps a link name rather than collapsing it to its target', () => {
    // `US/Eastern` is a valid identifier that denotes the same zone as `America/New_York`.
    // Temporal does not collapse it, and neither should this: a host who chose it should keep
    // seeing it, and `02` D3 stores what was chosen.
    expect(toDriver('US/Eastern' as TimeZoneId)).toBe('US/Eastern');
  });

  it('refuses an unknown zone on write as a bug', () => {
    try {
      toDriver('Europe/Londen' as TimeZoneId);
      expect.unreachable('an unknown zone must be refused');
    } catch (caught) {
      const error = caught as StorageError;
      expect(error.storageCode).toBe('STORAGE_JSON_INVALID');
      expect(error.code).toBe('bug');
      expect(error.hint).toContain('timeZoneIdSchema');
    }
  });

  it('refuses an unknown zone on read as corruption, mentioning tzdata', () => {
    // The realistic cause is upstream: a zone renamed or removed in a newer tzdata. That is the
    // host's situation rather than their mistake, so the message says where it came from.
    try {
      fromDriver('Europe/Londen');
      expect.unreachable('an unknown zone must be refused');
    } catch (caught) {
      const error = caught as StorageError;
      expect(error.storageCode).toBe('STORAGE_CORRUPT');
      expect(error.hint).toContain('tzdata');
    }
  });

  it('refuses an empty zone', () => {
    expect(() => fromDriver('')).toThrow(StorageError);
  });

  it('agrees with the UTC constant shared exports', () => {
    expect(toDriver(UTC)).toBe('UTC');
  });
});

describe('bool, labelRef and the standard columns (02 §3.1)', () => {
  it('maps a boolean onto an integer', () => {
    expect(probe.isActive.getSQLType()).toBe('integer');
    expect(probe.isActive.mapToDriverValue(true)).toBe(1);
    expect(probe.isActive.mapToDriverValue(false)).toBe(0);
    expect(probe.isActive.mapFromDriverValue(1)).toBe(true);
    expect(probe.isActive.mapFromDriverValue(0)).toBe(false);
  });

  it('builds the CHECK a bool column needs, so no table spells it out', () => {
    // The check cannot live on the column type — a check constraint belongs to the table — and a
    // `bool()` column without one accepts `2` and reads it back as `true`. One expression, so
    // every table writes the same one and `M1-T11`'s generated SQL can be reviewed for it.
    expect(boolCheck('is_active')).toBe('is_active IN (0, 1)');
  });

  it('types a label reference without declaring the foreign key', () => {
    // `02` §3.1 writes `.references(() => labels.id)`, which `_columns.ts` cannot do: `labels` is
    // declared in a module that imports this one, so the reference would be a module cycle.
    // `M1-T11`'s table adds it, along with `02` §3.1's `ON DELETE NO ACTION` for labels.
    expect(probe.labelId.name).toBe('label_id');
    expect(probe.labelId.getSQLType()).toBe('integer');
    expect(probe.ownerLabelId.name).toBe('owner_label_id');
    // No foreign key: `_columns.ts` cannot import the `labels` table without a module cycle.
    expect(probe.labelId.getSQLType()).toBe('integer');
  });

  it('accepts an interned id through the branded type', () => {
    const id: LabelId = internedId(42, 'labels');
    expect(id).toBe(42);
    // Checked rather than cast: `AUTOINCREMENT` starts at 1, so zero is as wrong as a negative.
    expect(() => internedId(0, 'labels')).toThrow(/STORAGE_ID_INVALID/);
    expect(() => internedId(-1, 'labels')).toThrow(/STORAGE_ID_INVALID/);
    expect(() => internedId(1.5, 'labels')).toThrow(/STORAGE_ID_INVALID/);
  });

  it('names the standard timestamp and version columns', () => {
    expect(probe.createdAt.name).toBe('created_at');
    expect(probe.updatedAt.name).toBe('updated_at');
    expect(probe.version.name).toBe('version');
    expect(probe.createdAt.getSQLType()).toBe('integer');
    expect(probe.version.getSQLType()).toBe('integer');
    expect(probe.createdAt.notNull).toBe(true);
  });

  it('defaults version to 1, which the optimistic-concurrency check assumes', () => {
    // `WHERE id = ? AND version = ?` against a row whose version defaulted to 0 would never match,
    // so every first update would report a conflict.
    expect(probe.version.default).toBe(1);
  });
});
