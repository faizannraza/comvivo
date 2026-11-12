/**
 * A thrown value as an `ErrorInfo` (`02` §3.3.9, §3.10.4).
 *
 * Two things are being asserted, and the second matters more than it looks. The first is the
 * `retryable` judgement, which decides whether a job comes back or goes to the dead letter. The
 * second is that **no foreign error's text survives**: `jobs.last_error` is visible to anyone who
 * can see a job row, outside the information-flow system entirely, and a handler's failure can
 * carry whatever it was working on.
 */
import { AppError, StorageError, ValidationError } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import { errorInfoOf } from './error-info.js';

describe('errorInfoOf', () => {
  it('keeps our own wording and code for a storage failure', () => {
    const info = errorInfoOf(
      new StorageError('STORAGE_BUSY', 'the database is locked by another writer'),
    );
    // The **storage** code, not the generic `ErrorCode`: it is what `exitCodeForStorageCode` and
    // `comvivo doctor` dispatch on, so a dead letter says something a host can act on.
    expect(info.code).toBe('STORAGE_BUSY');
    expect(info.message).toContain('locked');
    // `02` §3.6: a lock somebody else holds is the one storage failure worth retrying.
    expect(info.retryable).toBe(true);
    expect(errorInfoOf(new StorageError('STORAGE_CORRUPT', 'the page is damaged')).retryable).toBe(
      false,
    );
  });

  it('does not retry a validation failure or a bug', () => {
    // Neither will start succeeding: the payload is wrong or the code is. Retrying them eight
    // times would hide the cause behind an hour of identical failures.
    expect(errorInfoOf(new ValidationError('that did not parse', [])).retryable).toBe(false);
    expect(errorInfoOf(new ValidationError('x', [])).code).toBe('validation.failed');
    expect(errorInfoOf(new AppError('io.failed', 'the socket closed')).retryable).toBe(true);
    expect(errorInfoOf(new AppError('timeout', 'it took too long')).retryable).toBe(true);
    expect(errorInfoOf(new AppError('bug', 'an invariant broke')).retryable).toBe(false);
  });

  it('keeps a foreign error`s class and discards its text', () => {
    // `08` §3.10 layer 3 makes the same call for logs, and the reason is concrete: for Telegram a
    // provider error's URL *is* the bot token, and a fetch failure's message tends to carry the
    // request. The class name is a token and safe; the message is not.
    const info = errorInfoOf(
      new TypeError('cannot read properties of undefined (reading "token")'),
    );
    expect(info.code).toBe('TypeError');
    expect(info.message).not.toContain('token');
    // Retried, because the common cause of an unknown error is transient and the attempt budget
    // bounds the cost of being wrong. A non-retryable default would turn one flaky socket into a
    // dead letter a host has to notice and re-run by hand.
    expect(info.retryable).toBe(true);
  });

  it('handles an error with no name, and a throw that is not an error at all', () => {
    const nameless = new Error('x');
    Object.defineProperty(nameless, 'name', { value: '' });
    expect(errorInfoOf(nameless).code).toBe('Error');
    // `throw 'nope'` is legal JavaScript and a plugin can do it (`10`), so the mapper cannot
    // assume an `Error`.
    expect(errorInfoOf('nope')).toMatchObject({ code: 'UNKNOWN', retryable: true });
    expect(errorInfoOf(undefined).code).toBe('UNKNOWN');
    expect(errorInfoOf(undefined).message).not.toContain('undefined');
  });

  it('bounds the message, so a long validation report cannot become the column', () => {
    const info = errorInfoOf(new ValidationError('x'.repeat(2_000), []));
    // `02` §3.3.9 caps it at 500 characters. The cap is what keeps a failure from becoming a copy
    // of what failed — `ErrorInfoSchema` would refuse a longer one on write, so truncating here is
    // what makes the dead letter land at all.
    expect(info.message.length).toBeLessThanOrEqual(500);
  });

  it('stamps an instant a reader can order by', () => {
    expect(errorInfoOf(new Error('x')).at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
