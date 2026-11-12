/**
 * The exit-code table (`12` §4.2).
 *
 * Two things worth testing here, and the second is the point: that the table is **complete**, and
 * that every code in it is one of `12` §4.2's six. A mapping with a hole would send an
 * orchestrator a number from a different table, and the symptom is a service that will not come
 * back up after a transient lock — not a failing test.
 */
import { describe, expect, it } from 'vitest';
import {
  BugError,
  EXIT_CODES,
  type ExitCode,
  exitCodeFor,
  exitCodeForStorageCode,
  STORAGE_ERROR_CODES,
  StorageError,
} from './index.js';

const SPEC_CODES: readonly ExitCode[] = [0, 1, 65, 75, 78, 130];

describe('the table matches 12 §4.2', () => {
  it('is exactly the six codes the spec names', () => {
    expect(Object.values(EXIT_CODES).toSorted((a, b) => a - b)).toEqual([...SPEC_CODES]);
  });

  it('names the three an orchestrator branches on', () => {
    // Pinned literally, not read from the object: these three numbers appear in
    // `RestartPreventExitStatus`, in the Docker restart policy and in `12` §4.1's runbook, so
    // changing one silently changes behaviour on a host nobody is watching.
    expect(EXIT_CODES.temporary).toBe(75);
    expect(EXIT_CODES.configuration).toBe(78);
    expect(EXIT_CODES.data).toBe(65);
  });
});

describe('every storage error code is classified', () => {
  it('maps all of them to a code from the table', () => {
    // `STORAGE_ERROR_CODES` had no caller and no test. This is its first, which is also what makes
    // the exhaustive switch meaningful at run time rather than only at compile time: a code added
    // to the union and forgotten here fails `tsc`, and a code added to the union and *not* to
    // `STORAGE_ERROR_CODES` fails below.
    for (const code of STORAGE_ERROR_CODES) {
      expect(SPEC_CODES, code).toContain(exitCodeForStorageCode(code));
    }
  });

  it('lists every member of the union, so the loop above is not short', () => {
    // The array is hand-written beside the union, so the two can drift. The count is pinned
    // because a silent shrink would make the loop pass over whatever was removed. 39 since
    // `STORAGE_TX_FOREIGN` was added at the M1 exit gate for a transaction `SqliteStore` did not
    // open (38 at `M1-T26`, when `AUDIT_REANCHOR_FAILED` arrived for `08` §3.16.2's re-anchor).
    expect(STORAGE_ERROR_CODES).toHaveLength(39);
    expect(new Set(STORAGE_ERROR_CODES).size).toBe(STORAGE_ERROR_CODES.length);
  });

  it('puts a held lock at 75, which is the one 12 §3.7 promises', () => {
    expect(exitCodeForStorageCode('STORAGE_LOCKED')).toBe(75);
  });

  it('separates a wrong key from a corrupt database', () => {
    // Both look like "the database will not open". The orchestrator must not treat them alike: one
    // needs a human, the other needs recovery mode.
    expect(exitCodeForStorageCode('STORAGE_KEY_INVALID')).toBe(EXIT_CODES.configuration);
    expect(exitCodeForStorageCode('STORAGE_CORRUPT')).toBe(EXIT_CODES.data);
  });
});

describe('exitCodeFor', () => {
  it('reads the code off a StorageError', () => {
    const error = new StorageError('STORAGE_LOCKED', 'held', { hint: 'wait' });
    expect(exitCodeFor(error)).toBe(EXIT_CODES.temporary);
  });

  it('calls anything else a bug', () => {
    // An error that is not a `StorageError` reaching the top of the process is, by definition,
    // something nobody classified.
    expect(exitCodeFor(new Error('boom'))).toBe(EXIT_CODES.bug);
    expect(exitCodeFor(new BugError('impossible'))).toBe(EXIT_CODES.bug);
    expect(exitCodeFor('a string')).toBe(EXIT_CODES.bug);
    expect(exitCodeFor(undefined)).toBe(EXIT_CODES.bug);
  });
});
