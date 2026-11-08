/**
 * `ForwardInfoSchema` and `AttachmentRefSchema` (`06` §1327, §1351; `02` §3.3.9).
 */
import { capped } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
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

  it('keeps the 1 KiB column cap unreachable, by bounding the fields instead', () => {
    // The old name was "enforces the 1 KiB column cap" and the body asserted that an **under**-cap
    // value parses, which the cap plays no part in. No over-cap case was tried, and none is
    // possible: `fromName` is `.max(256)` and `originalSentAt` is `.max(64)`, so the largest value
    // this schema admits serialises to well under 1024 bytes. Found by the M1 independent review.
    //
    // So `capped()` here is defence in depth for a JSON column whose shape may grow, and the
    // honest claim is the arithmetic: the field bounds are what hold the column under its cap.
    // This test fails if a field is widened past the point where that stops being true — which is
    // when the cap would start doing the work and would need its own over-cap case.
    expect(FORWARD_INFO_MAX_BYTES).toBe(1024);
    const largest = { fromName: 'a'.repeat(256), originalSentAt: 'b'.repeat(64) };
    expect(ForwardInfoSchema.parse(largest)).toEqual(largest);

    // Measured, not reasoned about: the biggest admissible value, as bytes on the wire.
    const bytes = Buffer.byteLength(JSON.stringify(largest), 'utf8');
    expect(bytes).toBeLessThan(FORWARD_INFO_MAX_BYTES);
    // With room to spare, so a small addition to the shape does not silently cross the line.
    expect(bytes).toBeLessThan(FORWARD_INFO_MAX_BYTES / 2);

    // And the cap wrapper is still live on this schema rather than decorative — a value that
    // exceeds it is refused even though the field bounds mean no parse can construct one. Proven
    // against the wrapper directly, since the schema's own fields cannot reach the cap.
    expect(
      capped(z.object({ big: z.string() }), FORWARD_INFO_MAX_BYTES, 'probe').safeParse({
        big: 'x'.repeat(FORWARD_INFO_MAX_BYTES),
      }).success,
    ).toBe(false);
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
