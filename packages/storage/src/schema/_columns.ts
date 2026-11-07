/**
 * Custom column types (`02` §3.1).
 *
 * Every table in this database is built from these, and the reason they exist rather than bare
 * `text()` and `integer()` is that **a column mapper is the last place a bad value can be caught**.
 * Above it, zod validates what comes in from a channel, an API or a config file. Below it, SQLite
 * will store whatever it is handed. Between the two sits the one layer that sees every value on its
 * way in *and* on its way back out, which makes it the right place for the three invariants `02`
 * §3.1 asks for:
 *
 *  - **Ids are parsed on read**, not cast. A malformed TypeID coming back from a column means the
 *    row is corrupt, and `02` §4.3's `STORAGE_ID_INVALID` says so instead of handing the caller a
 *    branded string that is not one.
 *  - **Instants are epoch milliseconds**, because an ISO string in an integer column sorts
 *    lexicographically and a `REAL` loses precision. `Clock.now()` already truncates to ms, and
 *    this is where that becomes a property of the schema rather than a convention.
 *  - **JSON columns are validated both ways**, with a tag naming the column. `01` §1 requires zod
 *    at every boundary and a JSON column is one: the value was serialised by a build that may not
 *    be this one.
 *
 * ## What these deliberately do not do
 *
 * They do not catch a wrong *column*. `tid('grp')` on a column holding member ids will happily
 * reject every value, loudly, on the first read — which is the right failure, but it is a schema
 * bug found at runtime rather than at compile time. `02` §3.3's tables are what make the pairing
 * correct; these make a mismatch impossible to ignore.
 */
import {
  type Id,
  type IdPrefix,
  type LabelId,
  parseId,
  parseOrThrow,
  parseTimeZoneId,
  StorageError,
  type TimeZoneId,
  unwrapId,
  type z,
} from '@comvivo/shared';
import { customType, integer } from 'drizzle-orm/sqlite-core';
import { Temporal } from 'temporal-polyfill';

/**
 * A TypeID column: `TEXT`, parsed on read (`02` §3.1).
 *
 * `toDriver` passes the value through because the only way to hold an `Id<P>` is to have parsed or
 * generated one — the brand is unforgeable without a cast. `fromDriver` parses, because the value
 * came off a disk that may have been restored, hand-edited, or written by a different build.
 */
export const tid = <P extends IdPrefix>(prefix: P) =>
  customType<{ data: Id<P>; driverData: string }>({
    dataType: () => 'text',
    toDriver: (value) => value,
    fromDriver: (value) => unwrapId(parseId(prefix, value), 'STORAGE_ID_INVALID'),
  });

/**
 * `02` §3.1: every instant column is `INTEGER` epoch milliseconds.
 *
 * Integer rather than text, and ms rather than seconds or nanoseconds, for three reasons that each
 * rule out an alternative:
 *
 *  - an **ISO string** sorts lexicographically, which happens to agree with chronological order
 *    only while every value has the same shape and offset — so `2026-01-01T00:00:00Z` and
 *    `2026-01-01T00:00:00.000Z` are the same instant and different strings;
 *  - **seconds** cannot express the ordering the turn journal and the outbox depend on (I6, I7),
 *    where two events in the same second must still be ordered;
 *  - **nanoseconds** exceed `Number.MAX_SAFE_INTEGER` as a JS number around 1970 + 104 days, so
 *    they would have to be `BigInt` — and SQLite would store them as 8-byte integers that
 *    `better-sqlite3` returns as `BigInt` only when asked, which is a trap waiting for one
 *    forgotten option.
 *
 * `Clock.now()` already truncates to ms (`M1-T3`), so a value arriving here with sub-millisecond
 * precision came from somewhere that bypassed the clock — and is rejected rather than silently
 * truncated, because a silent truncation makes two distinct instants compare equal.
 */
export const instantMs = customType<{ data: Temporal.Instant; driverData: number }>({
  dataType: () => 'integer',
  toDriver: (value) => {
    const ms = value.epochMilliseconds;
    assertStorableEpochMs(ms, 'write');
    // `epochNanoseconds` is the only way to see sub-millisecond precision: `epochMilliseconds`
    // truncates silently, which is exactly what must not happen without the caller knowing.
    if (value.epochNanoseconds % 1_000_000n !== 0n) {
      throw new StorageError(
        'STORAGE_JSON_INVALID',
        'an instant with sub-millisecond precision cannot be stored',
        {
          hint:
            'This is a bug: `Clock.now()` truncates to milliseconds, so a value with nanoseconds ' +
            'came from somewhere that bypassed the clock port. Truncating here would make two ' +
            'distinct instants compare equal after a round trip.',
          category: 'bug',
        },
      );
    }
    return ms;
  },
  fromDriver: (value) => {
    assertStorableEpochMs(value, 'read');
    return Temporal.Instant.fromEpochMilliseconds(value);
  },
});

/**
 * The epoch-millisecond range this product stores.
 *
 * **Lower bound: zero.** `02` §9.1 asks for negative epochs to be rejected, and the reason is that
 * nothing in this product legitimately happened before 1970 — every instant column is a message, a
 * reminder, an audit entry or a row's own `created_at`. A negative value is a corrupt row or an
 * arithmetic bug, most often a subtraction that underflowed, and storing it would put a reminder in
 * 1969 where no query will ever find it again.
 *
 * **Upper bound: Temporal's own limit**, `8_640_000_000_000_000` ms — year +275760. Measured, after
 * a first version used `Number.MAX_SAFE_INTEGER` (≈ 9.007e15): a value between the two passed the
 * guard and then threw a raw `RangeError` out of `Temporal.Instant.fromEpochMilliseconds`, which
 * bypasses the `StorageError` mapping this guard exists to provide. The bound has to be the one the
 * library actually enforces, or the check is a check that lets the failure through in a worse form.
 */
export const MAX_EPOCH_MS = 8_640_000_000_000_000;

function assertStorableEpochMs(ms: number, direction: 'read' | 'write'): void {
  if (Number.isInteger(ms) && ms >= 0 && ms <= MAX_EPOCH_MS) return;
  throw new StorageError(
    direction === 'read' ? 'STORAGE_CORRUPT' : 'STORAGE_JSON_INVALID',
    `${String(ms)} is not a storable epoch-millisecond value`,
    {
      hint:
        direction === 'read'
          ? 'A timestamp column holds a value outside the representable range, which means the row ' +
            'is damaged. Restore a backup; the damaged file is often still partly readable.'
          : 'This is a bug: nothing in this product happens before 1970, so a negative or ' +
            'non-integer instant is an arithmetic error — usually a subtraction that underflowed.',
      ...(direction === 'write' ? { category: 'bug' as const } : {}),
    },
  );
}

/**
 * A JSON column validated in **both** directions, with a tag naming it (`02` §3.1).
 *
 * The read side is the one that earns its place, and it is not defensive programming. A JSON
 * column's bytes were written by *some* build of this product, and `12` §3.8 lets a host upgrade
 * across versions — so the value in front of you may have been written by code that no longer
 * exists, under a schema that has since changed. Validating on read turns that into
 * `STORAGE_JSON_INVALID` naming the column, which `02` F9 then handles by excluding the row from
 * context and showing "corrupt record" in the dashboard, rather than into a `TypeError` three
 * layers up with no indication of which row caused it.
 *
 * `tag` is the column's name and goes into the error, because "a JSON column failed to parse" is
 * not actionable and `messages.parts` is.
 */
export const jsonOf = <S extends z.ZodType>(schema: S, tag: string) =>
  customType<{ data: z.output<S>; driverData: string }>({
    dataType: () => 'text',
    toDriver: (value) => JSON.stringify(validateJson(schema, value, tag, 'write')),
    fromDriver: (raw) => validateJson(schema, parseJsonText(raw, tag), tag, 'read'),
  });

/** Parse the text of a JSON column, reporting the column rather than the position. */
function parseJsonText(raw: string, tag: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new StorageError('STORAGE_JSON_INVALID', `${tag} does not hold valid JSON`, {
      hint:
        'This row is damaged. `doctor --deep` lists rows whose JSON columns no longer parse; the ' +
        'row is excluded from context rather than failing the whole read (02 F9).',
      detail: { column: tag },
      cause,
    });
  }
}

/**
 * Validate a JSON column's value against its schema.
 *
 * Both directions raise `STORAGE_JSON_INVALID`, but with different categories: a write that fails
 * is **our** bug — the code built a value its own schema refuses — while a read that fails is a
 * damaged or out-of-date row. Collapsing them would send a host to their backups for a bug in a
 * repository.
 */
function validateJson<S extends z.ZodType>(
  schema: S,
  value: unknown,
  tag: string,
  direction: 'read' | 'write',
): z.output<S> {
  try {
    return parseOrThrow(schema, value, tag);
  } catch (cause) {
    throw new StorageError(
      'STORAGE_JSON_INVALID',
      `${tag} failed its schema on ${direction}`,
      direction === 'write'
        ? {
            hint:
              'This is a bug: a repository built a value that its own column schema refuses. The ' +
              'value is not written, so nothing is corrupted.',
            category: 'bug',
            detail: { column: tag },
            cause,
          }
        : {
            hint:
              'This row was written by a different version, or is damaged. It is excluded from ' +
              'context rather than failing the whole read (02 F9); `doctor --deep` lists them.',
            detail: { column: tag },
            cause,
          },
    );
  }
}

/**
 * `02` §3.1: booleans are `INTEGER` 0/1 with `{ mode: 'boolean' }`.
 *
 * The `CHECK (x IN (0,1))` that `02` §3.1 also requires is **not** here, and cannot be: a check
 * constraint belongs to the table, not to the column type, so each table declares it.
 *
 * That split is a real hazard, and the shape of it is worth stating precisely. Measured on
 * `drizzle-orm` 0.45.4: `{ mode: 'boolean' }` maps `1` to `true` and **everything else to
 * `false`** — `2`, `-1` and `0.5` all read back as `false`. So a value that reached the column
 * around the mapper does not read as nonsense, it reads as a confident `false`. For `is_active`,
 * `is_minor` or a consent flag that is the dangerous direction: a consent flag that reads `false`
 * silently denies, and nothing in the read path can tell that apart from a genuine `false`.
 *
 * The `CHECK` is therefore what stops the value existing at all, which is the only layer that can.
 * `boolCheck` builds the expression so no table spells it out, and `M1-T11`'s generated SQL is
 * reviewed for its presence on every boolean column.
 */
export const bool = (name: string) => integer(name, { mode: 'boolean' });

/** The `CHECK` expression a `bool` column needs, so every table writes the same one. */
export const boolCheck = (column: string): string => `${column} IN (0, 1)`;

/**
 * A wall-clock date and time with no zone: `'YYYY-MM-DDTHH:mm:ss'` (`02` §3.1, D3).
 *
 * This is half of D3's calendar design, and the half that is easy to mistake for a timestamp. A
 * recurring event is "every Tuesday at 18:30 **in this zone**", which is not an instant: the
 * instant it denotes changes when the zone's offset changes. Storing the local time and the zone
 * separately, with the resolved instant *derived*, is what lets a DST change move the event
 * correctly instead of moving it an hour from where the family expects.
 *
 * Serialised without an offset and without a `Z`, so the absence is explicit rather than implied.
 */
export const plainDateTimeText = customType<{
  data: Temporal.PlainDateTime;
  driverData: string;
}>({
  dataType: () => 'text',
  // `toString` with `smallestUnit: 'second'` so the stored form is fixed-width and comparable.
  // Without it, a value with no sub-second part serialises shorter and sorts before one that has.
  toDriver: (value) => value.toString({ smallestUnit: 'second' }),
  fromDriver: (value) => {
    try {
      return Temporal.PlainDateTime.from(value);
    } catch (cause) {
      throw corrupt('a plain date-time', value, cause);
    }
  },
});

/** A calendar date with no time and no zone: `'YYYY-MM-DD'` (`02` §3.1). */
export const plainDateText = customType<{ data: Temporal.PlainDate; driverData: string }>({
  dataType: () => 'text',
  toDriver: (value) => value.toString(),
  fromDriver: (value) => {
    try {
      return Temporal.PlainDate.from(value);
    } catch (cause) {
      throw corrupt('a plain date', value, cause);
    }
  },
});

/**
 * An IANA time-zone id, validated **and canonicalised** (`02` §3.1).
 *
 * `02` §3.1 says "validated via Temporal on read"; this canonicalises on write too, and the
 * difference matters. Temporal normalises case — `utc` becomes `UTC`, `EUROPE/LONDON` becomes
 * `Europe/London` — so validating only on read would let `europe/london` into a column and leave
 * every later comparison against the canonical form false. D3's design compares a stored `tz`
 * against another `tz` to decide whether a derived `*_at` is still valid, so two spellings of one
 * zone is a stale-derivation bug that no test of the zone logic itself would find.
 */
export const tzText = customType<{ data: TimeZoneId; driverData: string }>({
  dataType: () => 'text',
  toDriver: (value) => canonicalZone(value, 'write'),
  fromDriver: (value) => canonicalZone(value, 'read'),
});

function canonicalZone(value: string, direction: 'read' | 'write'): TimeZoneId {
  // `shared` owns what a valid zone is, so this column and `07`'s recurrence code get the same
  // answer from the same tzdata.
  const canonical = parseTimeZoneId(value);
  if (canonical !== undefined) return canonical;
  throw new StorageError(
    direction === 'read' ? 'STORAGE_CORRUPT' : 'STORAGE_JSON_INVALID',
    `${JSON.stringify(value)} is not a time zone this platform knows`,
    {
      hint:
        direction === 'read'
          ? 'A zone column holds an identifier this build’s tzdata does not have. That happens ' +
            'when a zone is renamed or removed upstream; `doctor --deep` lists affected rows.'
          : 'This is a bug: a zone should be validated at the boundary it arrived from, with ' +
            '`timeZoneIdSchema`.',
      detail: { direction },
      ...(direction === 'write' ? { category: 'bug' as const } : {}),
    },
  );
}

/**
 * A reference to an interned label (`02` §3.1, §3.2).
 *
 * **No `.references()` here**, and that is not an omission. `02` §3.1 writes
 * `integer(name).$type<LabelId>().references(() => labels.id)`, but `_columns.ts` cannot import the
 * `labels` table: `labels` is declared in a schema module that imports *this* file, so the
 * reference would be a module cycle that dependency-cruiser refuses — and refusing it is right,
 * because a cycle between the column vocabulary and the tables built from it makes the import order
 * decide whether the schema loads.
 *
 * So the foreign key is declared by the table, which is also where `02` §3.1's `ON DELETE NO ACTION`
 * for labels belongs. `M1-T11` adds it, and the generated SQL is reviewed for it.
 */
export const labelRef = (name = 'label_id') => integer(name).$type<LabelId>();

/** `02` §3.1's standard timestamp columns. */
export const createdAt = () => instantMs('created_at').notNull();
export const updatedAt = () => instantMs('updated_at').notNull();

/**
 * `02` §3.1's optimistic-concurrency column.
 *
 * Every mutable aggregate carries one, and updates use `WHERE id = ? AND version = ?`. A zero-row
 * update is `{ kind: 'conflict' }` rather than a lost write — which `02` §3.1 notes stays relevant
 * even under per-group actors, because the dashboard and the API write outside the actor.
 */
export const version = () => integer('version').notNull().default(1);

/** A read that found something no build of this product would have written. */
function corrupt(what: string, value: string, cause: unknown): StorageError {
  return new StorageError('STORAGE_CORRUPT', `${JSON.stringify(value)} is not ${what}`, {
    hint:
      'This row is damaged. `doctor --deep` lists rows whose columns no longer parse; restore a ' +
      'backup if the data matters more than the row.',
    cause,
  });
}
