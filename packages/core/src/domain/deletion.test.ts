/**
 * `DeletionProgressSchema` (`02` §3.3.8, D18).
 *
 * This column is the resume point of a chunked purge, so the cases that matter are the ones a
 * resume actually needs: a numeric cursor that compares as a number, a string cursor, and `null`
 * for a step that has not started.
 */
import { describe, expect, it } from 'vitest';
import { DELETION_COUNTS_MAX_KEYS, DeletionProgressSchema } from './deletion.js';

describe('a resumable purge record', () => {
  it('accepts a numeric cursor, which is what a rid walk needs', () => {
    // `02` §3.13.4 deletes in chunks of 5 000 rows with `WHERE rid > ?`. A rid forced through a
    // string would make that a string comparison, where '1000' sorts before '99'.
    const value = { step: 'messages', cursor: 48_000, counts: { messages: 48_000 } };
    expect(DeletionProgressSchema.parse(value)).toEqual(value);
  });

  it('accepts a string cursor for a step that resumes from an id or a table name', () => {
    const value = { step: 'memory.items', cursor: 'mem_01jqw8z5h7e9r3t4y5v6k7p8q9', counts: {} };
    expect(DeletionProgressSchema.parse(value)).toEqual(value);
  });

  it('accepts a null cursor for a step that has not started', () => {
    const value = { step: 'blobs', cursor: null, counts: {} };
    expect(DeletionProgressSchema.parse(value)).toEqual(value);
  });

  it('accepts the dotted step names of 02 §3.13.4', () => {
    for (const step of ['messages', 'memory.items', 'vec.partitions', 'turns_and_traces']) {
      expect(
        DeletionProgressSchema.safeParse({ step, cursor: null, counts: {} }).success,
        step,
      ).toBe(true);
    }
  });
});

describe('what it refuses', () => {
  it.each(['Messages', 'memory items', '.messages', '1messages', '', 'a'.repeat(65)])(
    'refuses the step name %o',
    (step) => {
      expect(DeletionProgressSchema.safeParse({ step, cursor: null, counts: {} }).success).toBe(
        false,
      );
    },
  );

  it('refuses a negative counter', () => {
    const value = { step: 'messages', cursor: null, counts: { messages: -1 } };
    expect(DeletionProgressSchema.safeParse(value).success).toBe(false);
  });

  it('refuses a fractional counter', () => {
    const value = { step: 'messages', cursor: null, counts: { messages: 1.5 } };
    expect(DeletionProgressSchema.safeParse(value).success).toBe(false);
  });

  it('refuses more counters than the limit', () => {
    const counts = Object.fromEntries(
      Array.from({ length: DELETION_COUNTS_MAX_KEYS + 1 }, (_, i) => [`step.s${String(i)}`, 0]),
    );
    expect(
      DeletionProgressSchema.safeParse({ step: 'messages', cursor: null, counts }).success,
    ).toBe(false);
  });

  it('accepts exactly the limit', () => {
    const counts = Object.fromEntries(
      Array.from({ length: DELETION_COUNTS_MAX_KEYS }, (_, i) => [`step.s${String(i)}`, 0]),
    );
    expect(
      DeletionProgressSchema.safeParse({ step: 'messages', cursor: null, counts }).success,
    ).toBe(true);
  });

  it('refuses a cursor that is neither a string, an integer nor null', () => {
    for (const cursor of [1.5, true, {}, []]) {
      expect(
        DeletionProgressSchema.safeParse({ step: 'messages', cursor, counts: {} }).success,
      ).toBe(false);
    }
  });
});
