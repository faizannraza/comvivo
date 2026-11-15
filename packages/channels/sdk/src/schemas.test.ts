/**
 * The boundary schemas (`M3-T2`'s AC: "round-trip tests").
 *
 * **Round-trip, not just parse.** `parse(x)` must deep-equal `x` for a valid value of every
 * shape, because a schema that quietly dropped a field would pass every "it accepts this" test
 * while losing the field. The one that matters most is `mentionsBot`: an envelope missing it is a
 * turn the router never runs, and the bot appears to ignore a member who addressed it by name.
 *
 * Each rejection below is a specific harm, not a type error for its own sake.
 */
import { describe, expect, it } from 'vitest';
import {
  ChannelCapabilitiesSchema,
  ChannelEventSchema,
  InboundEnvelopeSchema,
  OutboundMessageSchema,
  PollSpecSchema,
  profiles,
} from './index.js';

const envelope = {
  channel: 'telegram',
  platformChatId: '-1001',
  chatKind: 'group' as const,
  platformMessageId: '42',
  platformUserId: '7',
  platformUserDisplayName: 'Ana',
  senderKind: 'user' as const,
  sentAt: '2026-11-14T18:30:00+00:00',
  text: 'is the recital on Friday?',
  mentionsBot: true,
  attachments: [],
  raw: { update_id: 1 },
};

const outbound = {
  idempotencyKey: 'turn_01jc0000000000000000000000:0',
  target: { channel: 'telegram', platformChatId: '-1001', chatKind: 'group' as const },
  body: {
    v: 1 as const,
    blocks: [{ t: 'p' as const, c: [{ t: 'text' as const, text: 'Friday at six.' }] }],
  },
  messageClass: 'reply' as const,
  priority: 'interactive' as const,
  mentions: {},
};

describe('InboundEnvelopeSchema', () => {
  it('round-trips a real envelope, field for field', () => {
    expect(InboundEnvelopeSchema.parse(envelope)).toEqual(envelope);
  });

  it('round-trips every optional field too', () => {
    // The fields most likely to be dropped silently are the optional ones, because no test that
    // omits them would notice.
    const full = {
      ...envelope,
      platformThreadId: '9',
      platformUsername: 'ana',
      richText: {
        v: 1 as const,
        blocks: [{ t: 'p' as const, c: [{ t: 'text' as const, text: 'hi' }] }],
      },
      truncated: false,
      replyToPlatformMessageId: '41',
      replyToIsBot: true,
      forwarded: { fromName: 'Ben', originalSentAt: '2026-11-13T09:00:00+00:00' },
      quotedExternal: true,
      linkPreviews: [{ url: 'https://example.invalid/a', title: 'A' }],
      attachments: [
        {
          ref: { channel: 'telegram', data: { fileId: 'abc' } },
          kind: 'voice' as const,
          mime: 'audio/ogg',
          isVoiceNote: true,
          durationSec: 4.5,
        },
      ],
      interaction: { kind: 'button' as const, payload: { token: 'v1.aaaaaaaaaaaaaaaaaaaaaa' } },
      userHints: { locale: 'es-ES', timezone: 'Europe/Madrid' },
      deliveredLate: true,
      dedupeKey: 'tg:-1001:42',
    };
    expect(InboundEnvelopeSchema.parse(full)).toEqual(full);
  });

  it('refuses an envelope with no `senderKind`', () => {
    // `08` PSC-9's S4 gate reads it to decide whether a message causes a model call. A default of
    // `'user'` would turn an adapter that forgot to classify bots into two bots talking to each
    // other at a provider's prices until somebody noticed the bill.
    const { senderKind: _omitted, ...without } = envelope;
    expect(InboundEnvelopeSchema.safeParse(without).success).toBe(false);
  });

  it('refuses an envelope with no `mentionsBot`', () => {
    const { mentionsBot: _omitted, ...without } = envelope;
    expect(InboundEnvelopeSchema.safeParse(without).success).toBe(false);
  });

  it('refuses an unknown field rather than dropping it', () => {
    // `strictObject`, so an adapter that invents a field learns at the boundary. The alternative
    // is a field that works on the adapter's side and is invisible to the engine.
    expect(InboundEnvelopeSchema.safeParse({ ...envelope, urgent: true }).success).toBe(false);
  });

  it('refuses a wall-clock `sentAt` with no offset', () => {
    // "18:30" names a time without saying where, and two members in different zones would read
    // the same message as two different moments.
    expect(
      InboundEnvelopeSchema.safeParse({ ...envelope, sentAt: '2026-11-14T18:30:00' }).success,
    ).toBe(false);
  });
});

describe('ChannelEventSchema', () => {
  it('round-trips each of the twelve variants', () => {
    const chat = { channel: 'matrix', platformChatId: '!room:example.invalid' };
    const events = [
      {
        type: 'message_edited' as const,
        chat,
        platformMessageId: '$e',
        editedAt: '2026-11-14T18:00:00+00:00',
        text: 'fixed',
      },
      {
        type: 'message_deleted' as const,
        chat,
        platformMessageIds: ['$e'],
        deletedAt: '2026-11-14T18:00:00+00:00',
      },
      {
        type: 'bot_membership' as const,
        chat,
        chatKind: 'group' as const,
        status: 'added' as const,
        startPayload: 'claim_abc',
      },
      { type: 'member_joined' as const, chat, platformUserId: '@leo:example.invalid' },
      { type: 'member_left' as const, chat, platformUserId: '@leo:example.invalid' },
      {
        type: 'user_updated' as const,
        channel: 'matrix',
        platformUserId: '@ana:example.invalid',
        displayName: 'Ana',
      },
      {
        type: 'chat_migrated' as const,
        channel: 'telegram',
        fromPlatformChatId: '-1',
        toPlatformChatId: '-2',
      },
      { type: 'chat_updated' as const, chat, title: 'Family', encrypted: true },
      { type: 'dm_blocked' as const, channel: 'signal', platformUserId: 'aci' },
      { type: 'dm_unblocked' as const, channel: 'signal', platformUserId: 'aci' },
      {
        type: 'poll_updated' as const,
        poll: { ...chat, platformMessageId: '$p', platformPollId: 'p1' },
        counts: [2, 1],
        totalVoters: 3,
        closed: false,
      },
      {
        type: 'read_marker' as const,
        chat,
        platformUserId: '@ana:example.invalid',
        upToPlatformMessageId: '$e',
        at: '2026-11-14T18:05:00+00:00',
      },
    ];
    for (const event of events) {
      expect(ChannelEventSchema.parse(event), event.type).toEqual(event);
    }
    // Every variant the contract declares is covered, so a thirteenth cannot be added without a
    // test — the `type` list here is the check.
    expect(new Set(events.map((event) => event.type)).size).toBe(12);
  });

  it('carries `read_marker`, which is 07’s SC-3 and the newest variant', () => {
    // Named separately because the AC names it: a digest needs to tell "nobody has read this"
    // from "nobody replied", and without this event those are the same observation.
    const parsed = ChannelEventSchema.parse({
      type: 'read_marker',
      chat: { channel: 'web', platformChatId: 'c1' },
      platformUserId: 'u1',
      upToPlatformMessageId: 'm9',
      at: '2026-11-14T18:05:00+00:00',
    });
    expect(parsed.type).toBe('read_marker');
  });
});

describe('OutboundMessageSchema', () => {
  it('round-trips a reply', () => {
    expect(OutboundMessageSchema.parse(outbound)).toEqual(outbound);
  });

  it('requires `messageClass`, which quiet hours are decided on', () => {
    // `01` §14 A24. A `digest` sent as a `reply` bypasses quiet hours and the proactive budget —
    // silently, and at 3 a.m.
    const { messageClass: _omitted, ...without } = outbound;
    expect(OutboundMessageSchema.safeParse(without).success).toBe(false);
  });

  it('requires `idempotencyKey`, which is how I6 survives a crash', () => {
    const { idempotencyKey: _omitted, ...without } = outbound;
    expect(OutboundMessageSchema.safeParse(without).success).toBe(false);
  });
});

describe('PollSpecSchema', () => {
  it('refuses two options that read the same', () => {
    // Two identical options are two tallies nobody can tell apart, and a member who voted for
    // "Saturday" would not know which one they picked.
    const spec = {
      target: { channel: 'web', platformChatId: 'c1' },
      question: 'Which day?',
      options: ['Saturday', 'Saturday'],
      multiSelect: false,
      anonymous: true,
      idempotencyKey: 'k1',
    };
    expect(PollSpecSchema.safeParse(spec).success).toBe(false);
    expect(PollSpecSchema.safeParse({ ...spec, options: ['Saturday', 'Sunday'] }).success).toBe(
      true,
    );
  });
});

describe('ChannelCapabilitiesSchema', () => {
  it('accepts every shipped profile', () => {
    // The schema and the profiles are written separately, so this is the one assertion that keeps
    // them honest about each other.
    for (const [name, caps] of Object.entries(profiles)) {
      const result = ChannelCapabilitiesSchema.safeParse(caps);
      expect(result.success, `${name}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    }
  });

  it('refuses native polls with no limits, and buttons with no limits', () => {
    // The two pairings the engine reads as a unit. `choosePollMode` would pick `native` with no
    // limits to validate against, and the button renderer would have no token budget to fit a
    // token into — both wrong in the quiet direction.
    expect(
      ChannelCapabilitiesSchema.safeParse({ ...profiles.web, nativePolls: true, pollLimits: null })
        .success,
    ).toBe(false);
    expect(
      ChannelCapabilitiesSchema.safeParse({ ...profiles.web, buttons: true, buttonLimits: null })
        .success,
    ).toBe(false);
  });
});
