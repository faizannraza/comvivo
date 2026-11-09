/**
 * The message domain rules (`02` §3.3.3).
 *
 * Small, and one of the two things here is a product decision worth pinning: a tombstoned message
 * keeps its row, so "is it gone" cannot be answered by absence.
 */

import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { isTombstoned, MESSAGE_KINDS } from './message.js';

const T0 = Temporal.Instant.from('2026-11-08T12:00:00Z');

describe('MESSAGE_KINDS', () => {
  it("names the agent's own messages `assistant`, never the brand", () => {
    // A column **value** named after the product turns a rename into a data migration, which is
    // what ADR-024's `BRAND` indirection exists to prevent — and the product has been renamed
    // once already. Asserted by *shape*: the value is `assistant`, and no kind contains the
    // brand's name, which stays true across a future rename without quoting the old value.
    expect([...MESSAGE_KINDS]).toEqual(['member', 'assistant', 'system', 'derived', 'external']);
  });
});

describe('isTombstoned', () => {
  it('is true for a platform delete and for an erasure', () => {
    // One predicate for two columns, because they mean different things to an operator and the
    // same thing to a reader: there is no content here.
    expect(isTombstoned({ deletedAt: T0, redactedAt: T0 })).toBe(true);
    expect(isTombstoned({ deletedAt: undefined, redactedAt: T0 })).toBe(true);
    expect(isTombstoned({ deletedAt: T0, redactedAt: undefined })).toBe(true);
  });

  it('is false for an ordinary message', () => {
    // `02` §3.3.3 keeps the row and empties the text, so absence is not the test — which is why
    // this predicate exists rather than a `=== undefined` at each call site.
    expect(isTombstoned({ deletedAt: undefined, redactedAt: undefined })).toBe(false);
  });
});
