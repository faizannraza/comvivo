/**
 * The channel error taxonomy (`06` §3.15, CH-12).
 *
 * Thirteen kinds, each with a recovery the engine selects on. The reason this is a closed union
 * rather than a message string is spine §11.6's rule against silent catches: a `catch` that cannot
 * name what went wrong either retries something permanent — burning a group's budget on a 400 —
 * or gives up on something transient, which looks to a family like the bot ignoring them.
 *
 * Each adapter owns a fixture-tested mapping from its platform's codes to these kinds, which is
 * where the platform-specific knowledge belongs. This file owns only the vocabulary and the one
 * decision every caller needs: whether to try again.
 */

/**
 * Why a channel operation failed.
 *
 * The comments are the recovery, because the kind's whole purpose is to select one — reading this
 * union should tell you what happens next without opening the engine.
 */
export type ChannelErrorKind =
  /** `retryAfterMs` is set. Retryable, and **not** counted against the attempt budget. */
  | 'rate_limited'
  /** 5xx or a network failure **before the request was sent**. Retryable. */
  | 'transient'
  /** May have been delivered. Handled per `deliveryVerification` (`06` §3.13). */
  | 'ambiguous'
  /** Token invalid or revoked. The adapter reports health `auth_failed` and loops stop. */
  | 'auth_revoked'
  /** Another process holds the same credentials — Telegram 409, Signal's lock file. */
  | 'instance_conflict'
  /** Kicked, removed, archived or blocked. The conversation becomes `detached`. */
  | 'chat_access_lost'
  /** Cannot DM this user: never started, blocked, or DMs closed. */
  | 'user_unreachable'
  /** `newPlatformChatId` is set. Retry immediately against the new id. */
  | 'chat_migrated'
  /** A specific right is missing. Produces a diagnostic and a fix-it guide (`06` §3.20.3). */
  | 'permission_missing'
  /** Re-split at 80% once, then fall back to plain. */
  | 'message_too_long'
  /** Re-send as plain text, once. */
  | 'markup_rejected'
  /** The target message or poll is gone (edit, react, delete). Dropped silently. */
  | 'not_found'
  /** A permanent bug. Logged with a fixture, and the outbox row is marked `failed`. */
  | 'bad_request';

/** What a kind can carry beyond its name. */
export interface ChannelErrorDetails {
  readonly platformCode?: string | number;
  /** Set on `rate_limited`: the platform told us when to come back. */
  readonly retryAfterMs?: number;
  /** Set on `chat_migrated`. */
  readonly newPlatformChatId?: string;
  /** Set on `permission_missing`: which right, in the platform's own words. */
  readonly permission?: string;
  readonly cause?: unknown;
}

/**
 * The kinds worth trying again, as a **total** mapping rather than an `includes` over an array.
 *
 * `06` §3.15 writes `['rate_limited', 'transient', 'ambiguous', 'chat_migrated'].includes(kind)`.
 * A `Record` over the union says the same thing and makes adding a fourteenth kind a **compile
 * error here**, where somebody has to decide whether it retries. An array silently answers `false`
 * for a kind nobody classified, and `false` is the direction that loses a message: a new transient
 * kind would be treated as permanent and the reply would never arrive.
 *
 * This is the same argument `01` §7.5's `KIND_IS_RETRYABLE` makes for model errors, and the two
 * are deliberately shaped alike.
 */
const KIND_IS_RETRYABLE: Readonly<Record<ChannelErrorKind, boolean>> = {
  rate_limited: true,
  transient: true,
  // May have been delivered. Retrying is still right, because `deliveryVerification` decides
  // whether the retry is a duplicate — and a lost reply is worse than a verified one.
  ambiguous: true,
  chat_migrated: true,
  auth_revoked: false,
  instance_conflict: false,
  chat_access_lost: false,
  user_unreachable: false,
  permission_missing: false,
  // Not retryable **as sent**: the recovery is to re-split or re-render, which produces a
  // different request rather than the same one again.
  message_too_long: false,
  markup_rejected: false,
  not_found: false,
  bad_request: false,
};

/**
 * A channel operation that failed, with the kind that decides what happens next.
 *
 * The message is for a log and a developer. It is **never** shown to a member: a platform's error
 * text has carried message content before, and `08` §3.16 keeps content out of logs above `debug`.
 */
export class ChannelError extends Error {
  readonly kind: ChannelErrorKind;
  readonly details: ChannelErrorDetails;

  constructor(kind: ChannelErrorKind, message: string, details: ChannelErrorDetails = {}) {
    super(message);
    this.name = 'ChannelError';
    this.kind = kind;
    this.details = details;
  }

  /** Whether the dispatcher should try the same request again (`06` §3.15). */
  get retryable(): boolean {
    return KIND_IS_RETRYABLE[this.kind];
  }
}

/** Every kind, for a test that wants to walk them and for `doctor`'s listing. */
export const CHANNEL_ERROR_KINDS: readonly ChannelErrorKind[] = Object.freeze(
  Object.keys(KIND_IS_RETRYABLE) as ChannelErrorKind[],
);

/** Whether a kind retries, without constructing an error to ask. */
export function isRetryableKind(kind: ChannelErrorKind): boolean {
  return KIND_IS_RETRYABLE[kind];
}
