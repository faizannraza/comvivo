/**
 * `ForwardInfoSchema` and `AttachmentRefSchema` (`06` §1327, §1351; `02` §3.3.9).
 */
import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_REF_MAX_BYTES,
  AttachmentRefSchema,
  FORWARD_INFO_MAX_BYTES,
  ForwardInfoSchema,
} from './message-content.js';

describe('ForwardInfo', () => {
  it('accepts a forward with both fields', () => {
    const value = { fromName: 'Ada', originalSentAt: '2026-11-01T10:00:00Z' };
    expect(ForwardInfoSchema.parse(value)).toEqual(value);
  });

  it('accepts an empty object, which records a forward of unknown origin', () => {
    // Telegram withholds the sender's name when forward privacy is on, and Signal gives nothing.
    // An empty object is still the fact that sets `messages.untrusted` (`06` §139).
    expect(ForwardInfoSchema.parse({})).toEqual({});
  });

  it('keeps originalSentAt as the platform sent it, without normalising', () => {
    // A platform may give a date with no time. Normalising would invent precision, and this field
    // is display provenance that scheduling never reads.
    for (const originalSentAt of ['2026-11-01', '2026-11-01T10:00', 'Nov 1']) {
      expect(ForwardInfoSchema.parse({ originalSentAt })).toEqual({ originalSentAt });
    }
  });

  it('refuses an over-long name or timestamp', () => {
    expect(ForwardInfoSchema.safeParse({ fromName: 'a'.repeat(257) }).success).toBe(false);
    expect(ForwardInfoSchema.safeParse({ originalSentAt: 'a'.repeat(65) }).success).toBe(false);
  });

  it('enforces the 1 KiB column cap', () => {
    expect(FORWARD_INFO_MAX_BYTES).toBe(1024);
    const value = { fromName: 'a'.repeat(250), originalSentAt: 'b'.repeat(64) };
    expect(ForwardInfoSchema.safeParse(value).success).toBe(true);
  });
});

describe('AttachmentRef', () => {
  it('accepts each platform shape 06 §408 lists', () => {
    const refs = [
      { channel: 'telegram', data: { fileId: 'AgACAgQAAx' } },
      { channel: 'discord', data: { channelId: '1', messageId: '2', attachmentId: '3', url: 'u' } },
      { channel: 'slack', data: { urlPrivateDownload: 'https://files.slack.com/x' } },
      { channel: 'matrix', data: { mxc: 'mxc://x/y', file: { key: { k: 'secret' }, iv: 'iv' } } },
      { channel: 'signal', data: { id: '42' } },
      { channel: 'bluebubbles', data: { guid: 'p_1' } },
    ];
    for (const ref of refs) {
      expect(AttachmentRefSchema.parse(ref), ref.channel).toEqual(ref);
    }
  });

  it('accepts an empty data object', () => {
    expect(AttachmentRefSchema.parse({ channel: 'web', data: {} })).toEqual({
      channel: 'web',
      data: {},
    });
  });

  it('requires a channel, because the fetch job uses it to pick the adapter', () => {
    expect(AttachmentRefSchema.safeParse({ data: {} }).success).toBe(false);
    expect(AttachmentRefSchema.safeParse({ channel: 'Telegram', data: {} }).success).toBe(false);
  });

  it('requires data to be an object rather than any JSON value', () => {
    for (const data of ['string', 42, null, ['a']]) {
      expect(AttachmentRefSchema.safeParse({ channel: 'telegram', data }).success).toBe(false);
    }
  });

  it('enforces the 2 KiB column cap', () => {
    expect(ATTACHMENT_REF_MAX_BYTES).toBe(2048);
    const big = { channel: 'telegram', data: { fileId: 'a'.repeat(4096) } };
    const outcome = AttachmentRefSchema.safeParse(big);
    expect(outcome.success).toBe(false);
    if (outcome.success) return;
    expect(outcome.error.issues[0]?.message).toContain('2048-byte limit');
  });
});
