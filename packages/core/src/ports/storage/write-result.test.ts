/**
 * The `WriteResult` constructors (`02` §3.7.1).
 *
 * Thin, and tested for one reason: `expectWritten`'s **failure** arms are the ones a developer
 * meets when a fixture is wrong, and a message that does not say which arm came back sends them
 * reading the repository instead of the test.
 */
import { describe, expect, it } from 'vitest';
import { duplicate, expectWritten, notFound, writeConflict, writeOk } from './write-result.js';

describe('the constructors', () => {
  it("build exactly 02 §3.7.1's four arms", () => {
    expect(writeOk(7)).toEqual({ kind: 'ok', value: 7 });
    // No `currentVersion` on the conflict arm, deliberately: a caller handling one has to re-read
    // the row to decide, and a re-read returns the version with the state. The field would have
    // been a shortcut to merging blindly, which is what optimistic concurrency prevents.
    expect(writeConflict()).toEqual({ kind: 'conflict' });
    expect(notFound()).toEqual({ kind: 'not_found' });
    expect(duplicate('grp_1')).toEqual({ kind: 'duplicate', existingId: 'grp_1' });
  });
});

describe('expectWritten', () => {
  it('returns the value of an ok', () => {
    expect(expectWritten(writeOk('row'), 'a row')).toBe('row');
  });

  it('names the arm it got, and the existing id when there is one', () => {
    // The whole point: a fixture that hits a `duplicate` should say so and name the row it
    // collided with, rather than failing later on an `undefined`.
    expect(() => expectWritten(notFound(), 'a member')).toThrow(
      'expected a member to be written, got not_found',
    );
    expect(() => expectWritten(writeConflict(), 'a group')).toThrow(
      'expected a group to be written, got conflict',
    );
    expect(() => expectWritten(duplicate('mbr_7'), 'a member')).toThrow(
      'expected a member to be written, got duplicate (existing mbr_7)',
    );
  });
});
