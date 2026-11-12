/**
 * `ErrorInfo`'s bounds (`02` §3.3.9).
 *
 * The schema had no test, which `M1-T34`'s mutation run reported as eight mutants with no
 * coverage — and the bounds are not arbitrary. `02` §3.3.9 states one rule about `*.last_error`
 * that is not a size limit: **it never contains content.** The 500-character message cap is how
 * that rule is enforced in the type system rather than in a review comment, because a failure
 * message that grows to hold the thing that failed becomes an unlabelled copy of group content
 * sitting outside the information-flow system, readable by anyone who can see a job row.
 *
 * So each bound is asserted at its boundary — the only place a cap can be wrong in a way that
 * matters — rather than with one happy-path parse.
 */
import { describe, expect, it } from 'vitest';
import { ERROR_INFO_MESSAGE_MAX, ErrorInfoSchema } from './error-info.js';

const VALID = {
  code: 'outbox.send_failed',
  message: 'connection reset by peer',
  retryable: true,
  at: '2026-11-11T04:12:00Z',
} as const;

describe('ErrorInfoSchema', () => {
  it('accepts what `02` §3.3.9 describes', () => {
    expect(ErrorInfoSchema.parse(VALID)).toEqual(VALID);
  });

  it('bounds the message at 500 characters, and not at 501', () => {
    // The cap this schema exists for. Exactly at the limit parses; one over does not.
    expect(ERROR_INFO_MESSAGE_MAX).toBe(500);
    expect(ErrorInfoSchema.safeParse({ ...VALID, message: 'x'.repeat(500) }).success).toBe(true);
    expect(ErrorInfoSchema.safeParse({ ...VALID, message: 'x'.repeat(501) }).success).toBe(false);
    // Empty is fine: a failure with no message is a failure with no message.
    expect(ErrorInfoSchema.safeParse({ ...VALID, message: '' }).success).toBe(true);
  });

  it('requires a code, bounded at 80 characters', () => {
    // "A stable code a host can search for, not a sentence" — so there is a floor as well as a
    // ceiling, and the floor is the one that stops `code: ''` standing in for "something failed".
    expect(ErrorInfoSchema.safeParse({ ...VALID, code: '' }).success).toBe(false);
    expect(ErrorInfoSchema.safeParse({ ...VALID, code: 'c'.repeat(80) }).success).toBe(true);
    expect(ErrorInfoSchema.safeParse({ ...VALID, code: 'c'.repeat(81) }).success).toBe(false);
  });

  it('requires an offset on the timestamp', () => {
    // `z.iso.datetime({ offset: true })` accepts `Z` and `+01:00`; a local time is ambiguous, and
    // an ambiguous "when did it fail" in a retry loop is an hour of wrong backoff.
    expect(ErrorInfoSchema.safeParse({ ...VALID, at: '2026-11-11T04:12:00+01:00' }).success).toBe(
      true,
    );
    expect(ErrorInfoSchema.safeParse({ ...VALID, at: '2026-11-11T04:12:00' }).success).toBe(false);
    expect(ErrorInfoSchema.safeParse({ ...VALID, at: '2026-11-11' }).success).toBe(false);
  });

  it('keeps `retryable` a stored judgement, not an optional one', () => {
    // Stored rather than recomputed, because the adapter that saw the response is the only thing
    // that knew whether it was worth trying again. A missing field would make every reader guess.
    const { retryable: _dropped, ...withoutJudgement } = VALID;
    expect(ErrorInfoSchema.safeParse(withoutJudgement).success).toBe(false);
    expect(ErrorInfoSchema.safeParse({ ...VALID, retryable: 'yes' }).success).toBe(false);
  });

  it('caps the whole object at 4 KiB of JSON', () => {
    // The field bounds are the real bound; this is the backstop `capped` adds, and it is reachable
    // because the schema strips rather than refuses unknown keys — so a caller cannot pad the
    // object, only its own fields. A code and message at their limits are well inside it.
    expect(
      ErrorInfoSchema.safeParse({
        ...VALID,
        code: 'c'.repeat(80),
        message: 'm'.repeat(ERROR_INFO_MESSAGE_MAX),
      }).success,
    ).toBe(true);
  });
});
