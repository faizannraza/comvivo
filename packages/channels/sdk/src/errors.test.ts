/**
 * The channel error taxonomy (`06` §3.15, CH-12).
 *
 * The one decision every caller makes on a `ChannelError` is whether to try again, and both wrong
 * answers cost something specific: retrying a permanent failure burns a group's attempt budget and
 * fills a log with the same 400, while giving up on a transient one loses a reply that a family is
 * waiting for. So `retryable` is tested kind by kind rather than in aggregate.
 */
import { describe, expect, it } from 'vitest';
import {
  CHANNEL_ERROR_KINDS,
  ChannelError,
  type ChannelErrorKind,
  isRetryableKind,
} from './index.js';

describe('ChannelError', () => {
  it('carries the kind, the details and a name a log can group on', () => {
    const error = new ChannelError('rate_limited', 'slow down', { retryAfterMs: 4_000 });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ChannelError');
    expect(error.kind).toBe('rate_limited');
    expect(error.details.retryAfterMs).toBe(4_000);
    // The message is for a developer. It is never shown to a member: a platform's error text has
    // carried message content before, and `08` §3.16 keeps content out of logs above `debug`.
    expect(error.message).toBe('slow down');
  });

  it('defaults `details` to an empty object, so a caller can read it without a guard', () => {
    expect(new ChannelError('bad_request', 'nope').details).toEqual({});
  });

  it('retries exactly the four kinds 06 §3.15 names, and nothing else', () => {
    // Written out rather than compared against the implementation's own table, which would be the
    // implementation agreeing with itself. These four are the spec's list.
    const retryable: readonly ChannelErrorKind[] = [
      'rate_limited',
      'transient',
      'ambiguous',
      'chat_migrated',
    ];
    for (const kind of CHANNEL_ERROR_KINDS) {
      const expected = retryable.includes(kind);
      expect(new ChannelError(kind, 'x').retryable, kind).toBe(expected);
      expect(isRetryableKind(kind), kind).toBe(expected);
    }
  });

  it('has all thirteen kinds CH-12 counts', () => {
    // CH-12: "13 typed `ChannelErrorKind`s, each with a defined recovery behavior." A fourteenth
    // added without classifying it is a compile error in `errors.ts`'s `Record`, and this is the
    // count that makes the claim checkable.
    expect(CHANNEL_ERROR_KINDS).toHaveLength(13);
    expect([...CHANNEL_ERROR_KINDS].toSorted()).toEqual([
      'ambiguous',
      'auth_revoked',
      'bad_request',
      'chat_access_lost',
      'chat_migrated',
      'instance_conflict',
      'markup_rejected',
      'message_too_long',
      'not_found',
      'permission_missing',
      'rate_limited',
      'transient',
      'user_unreachable',
    ]);
  });

  it('does not retry the two whose recovery is a *different* request', () => {
    // `message_too_long` re-splits at 80% and `markup_rejected` re-sends as plain. Both recover,
    // and neither recovers by repeating what was just refused — which is what `retryable` means.
    expect(new ChannelError('message_too_long', 'x').retryable).toBe(false);
    expect(new ChannelError('markup_rejected', 'x').retryable).toBe(false);
  });

  it('retries `ambiguous`, because a lost reply is worse than a verified duplicate', () => {
    // The judgement call in the table. `deliveryVerification` (`06` §3.13) decides whether the
    // retry turns out to be a duplicate; not retrying would silently drop a message that may
    // never have arrived.
    expect(new ChannelError('ambiguous', 'x').retryable).toBe(true);
  });

  it('is frozen as a list, so a caller cannot edit the vocabulary', () => {
    expect(Object.isFrozen(CHANNEL_ERROR_KINDS)).toBe(true);
  });
});
