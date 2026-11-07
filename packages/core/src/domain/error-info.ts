/**
 * `ErrorInfo` — the last failure of a retrying thing (`02` §3.3.9, owned by `02`).
 *
 * Four columns hold this: `jobs.last_error`, `outbox_messages.last_error`,
 * `calendar_subscriptions.last_error` and whatever else acquires a retry loop. `02` §3.3.9 states
 * the shape — `{ code, message ≤ 500, retryable, at }` — and one rule about it that is not a size
 * limit: **it never contains content.**
 *
 * That rule is why `message` is bounded at 500 characters rather than left open. A failure message
 * is written by code and read by a host in a dashboard, and the moment it starts carrying the thing
 * that failed — the text of a message that could not be delivered, the body of a memory that could
 * not be embedded — the column becomes an unlabelled copy of group content sitting outside the
 * information-flow system, visible to anyone who can see a job row. `01` §11.7 forbids content in
 * logs above `debug` for the same reason; this is the storage equivalent.
 *
 * `retryable` is stored rather than recomputed because it is a judgement made with information the
 * reader no longer has. "Connection reset" is retryable, "410 Gone" is not, and the code that knew
 * which was which was the adapter that saw the response.
 */
import { capped, z } from '@comvivo/shared';

/** `02` §3.3.9 sets no byte cap for `*.last_error`; the field bounds are the bound. */
const ERROR_INFO_MAX_BYTES = 4 * 1024;

/** `02` §3.3.9: the message is bounded so a failure never becomes a copy of what failed. */
export const ERROR_INFO_MESSAGE_MAX = 500;

export const ErrorInfoSchema = capped(
  z.object({
    /** A stable code a host can search for, not a sentence. */
    code: z.string().min(1).max(80),
    message: z.string().max(ERROR_INFO_MESSAGE_MAX),
    /** A judgement made by the code that saw the failure, not re-derived by the reader. */
    retryable: z.boolean(),
    at: z.iso.datetime({ offset: true }),
  }),
  ERROR_INFO_MAX_BYTES,
  'error info',
);

export type ErrorInfo = z.infer<typeof ErrorInfoSchema>;
