/**
 * A thrown value as an `ErrorInfo` (`02` §3.3.9, §3.10.4).
 *
 * `02` §3.10.4's pseudocode calls this `toErrorInfo`, and the reason it is not just
 * `{ message: String(error) }` is the rule `ErrorInfo` exists to enforce: **it never contains
 * content**. A handler's failure can carry whatever it was working on — a message that could not be
 * delivered, a memory that could not be embedded — and `jobs.last_error` is a column visible to
 * anyone who can see a job row, outside the information-flow system entirely.
 *
 * So the message is taken from our own errors, whose wording `01` §11.7 already holds to the
 * no-content rule, and replaced with a constant for anything else. A foreign error's text is
 * **not** copied: `08` §3.10 layer 3 makes the same call for logs, and for Telegram a provider
 * error's URL *is* the bot token.
 */
import { ERROR_INFO_MESSAGE_MAX, type ErrorInfo } from '@comvivo/core';
import { AppError, StorageError } from '@comvivo/shared';

/** What a failure with nothing safe to say looks like. */
const OPAQUE = 'the handler failed; see the logs for the scrubbed error';

export function errorInfoOf(error: unknown): ErrorInfo {
  const at = new Date().toISOString();
  if (error instanceof StorageError) {
    return {
      // The storage code rather than the generic `ErrorCode`: it is what `exitCodeForStorageCode`
      // and `village doctor` dispatch on, so a dead letter says what a host can act on.
      code: error.storageCode,
      message: error.message.slice(0, ERROR_INFO_MESSAGE_MAX),
      // `02` §3.6/§3.7 makes `STORAGE_BUSY` the one storage failure worth retrying — a lock
      // somebody else holds. Everything else is a bug, corruption or a missing key, and a retry
      // would fail identically while hiding the cause behind eight more attempts.
      retryable: error.storageCode === 'STORAGE_BUSY',
      at,
    };
  }
  if (error instanceof AppError) {
    return {
      code: error.code,
      // Our own wording, truncated — a `ValidationError`'s issue list can be long.
      message: error.message.slice(0, ERROR_INFO_MESSAGE_MAX),
      // A `BugError` or a `ValidationError` will not start succeeding: the payload is wrong or the
      // code is. `IoError` and `TimeoutError` are the transient ones.
      retryable: error.code === 'io.failed' || error.code === 'timeout',
      at,
    };
  }
  if (error instanceof Error) {
    return {
      // The class name is a token rather than a sentence, so it is both safe and useful:
      // `TypeError` means a bug, `AbortError` means the timeout fired.
      code: error.name.length > 0 ? error.name : 'Error',
      message: OPAQUE,
      // Unknown errors are retried, because the common cause is transient — a socket, a lock — and
      // the attempt budget bounds the cost of being wrong. A non-retryable default would turn one
      // flaky network call into a dead letter a host has to notice and re-run by hand.
      retryable: true,
      at,
    };
  }
  return { code: 'UNKNOWN', message: OPAQUE, retryable: true, at };
}
