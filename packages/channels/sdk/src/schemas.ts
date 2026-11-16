/**
 * zod schemas for the shapes that cross a trust boundary (`06` §4.1; `01` §2).
 *
 * `CLAUDE.md` §2: validate every boundary. Five of the contract's types are boundaries and the
 * rest are not, which is why this file is shorter than `contract.ts`:
 *
 *  - **`InboundEnvelope`** is a platform's own JSON, normalised by an adapter we may not have
 *    written. Every field is attacker-influenced — a display name is chosen by the sender, a
 *    link preview is written by the linked page, `raw` is whatever arrived.
 *  - **`ChannelEvent`** likewise.
 *  - **`OutboundMessage`** and **`PollSpec`** go the other way, and are validated because the
 *    *engine* is the thing being checked: an idempotency key that is not derived from
 *    `(turnId, index)` breaks invariant **I6**, and a `messageClass` the outbox did not set
 *    bypasses quiet hours (`01` §14 A24).
 *  - **`ChannelCapabilities`** is a host-supplied profile for a third-party adapter, and a wrong
 *    `lengthUnit` or `maxMessageChars` is a message the platform refuses.
 *
 * `AdapterContext`, `ChannelAdapter` and the render types are **not** here: they carry functions,
 * they never cross a process boundary, and a schema over them could only check that methods are
 * present — which is `06` C23's job in the conformance kit, against a real adapter.
 *
 * ## Round-trip, not just parse
 *
 * `schemas.test.ts` asserts `parse(x)` deep-equals `x` for a valid value of each shape. A schema
 * that quietly dropped a field would otherwise pass every "it accepts this" test while losing
 * `mentionsBot` — and an envelope missing that field is a turn the router never runs.
 */
import { RichTextSchema } from '@comvivo/core';
import { z } from 'zod';
import { INTERACTION_TOKEN_PATTERN } from './interactions/token.js';
import { REACTION_KEYS } from './reactions.js';

/** `06` §3.3: an adapter's own identifiers are opaque to us, but not unbounded. */
const PLATFORM_ID_MAX = 256;
/** A display name is sender-chosen. Long enough for any real name, short enough to log. */
const DISPLAY_NAME_MAX = 512;
/** `06` §3.2's most generous `maxMessageChars` is 100 000 (`ideal`); this is the hard ceiling. */
const TEXT_MAX = 200_000;

const platformId = z.string().min(1).max(PLATFORM_ID_MAX);
const isoInstant = z.iso.datetime({ offset: true });
const channelId = z.string().min(1).max(64);

// --- Capabilities -------------------------------------------------------------------------------

export const PollLimitsSchema = z
  .strictObject({
    minOptions: z.int().min(1),
    maxOptions: z.int().min(1),
    maxQuestionChars: z.int().min(1),
    maxOptionChars: z.int().min(1),
    multiSelect: z.boolean(),
    maxDurationSec: z.int().min(1).nullable(),
    voterIdentity: z.boolean(),
  })
  // A platform that accepts fewer options than it requires is a profile nobody can satisfy, and
  // `choosePollMode` would pick `native` and then fail on every poll.
  .refine((limits) => limits.maxOptions >= limits.minOptions, {
    message: 'maxOptions must be at least minOptions',
  });

export const ButtonLimitsSchema = z.strictObject({
  maxPerMessage: z.int().min(1),
  maxPerRow: z.int().min(1),
  maxLabelChars: z.int().min(1),
  tokenMaxBytes: z.int().min(1),
});

export const ChannelCapabilitiesSchema = z
  .strictObject({
    threads: z.boolean(),
    reactions: z.boolean(),
    edits: z.boolean(),
    deletes: z.boolean(),
    nativePolls: z.boolean(),
    buttons: z.boolean(),
    typingIndicator: z.boolean(),
    voiceNotes: z.boolean(),
    images: z.boolean(),
    files: z.boolean(),
    maxMessageChars: z.int().min(1),
    markup: z.enum([
      'telegram-html',
      'discord-md',
      'slack-mrkdwn',
      'matrix-html',
      'plain',
      'web-md',
    ]),
    mentionsByUserId: z.boolean(),
    dmInitiation: z.enum(['any', 'after-user-contact', 'none']),
    readsAllGroupMessages: z.enum(['yes', 'requires-setup']),
    lengthUnit: z.enum(['utf16', 'utf8-bytes']),
    inboundEdits: z.boolean(),
    inboundDeletes: z.boolean(),
    pollLimits: PollLimitsSchema.nullable(),
    buttonLimits: ButtonLimitsSchema.nullable(),
    reactionSet: z.enum(['any', 'restricted']),
    maxReactionsPerMessage: z.int().min(1).nullable(),
    ephemeral: z.enum(['none', 'best-effort', 'interaction-only', 'reliable']),
    silentSend: z.boolean(),
    datetimeTokens: z.boolean(),
    deliveryVerification: z.enum(['native-idempotent', 'verifiable', 'none']),
    memberListing: z.enum(['exact', 'partial', 'none']),
    maxInboundAttachmentBytes: z.int().min(1).nullable(),
    maxOutboundAttachmentBytes: z.int().min(1),
    commands: z.enum(['native', 'text']),
    deleteWindowSec: z.int().min(1).nullable(),
    linkPreviewControl: z.enum(['per-message', 'client-side']),
    massMentionTokens: z.array(z.string().min(1).max(64)).max(16),
  })
  // Two pairings the engine reads as a unit, where a mismatch is silently wrong rather than
  // loudly wrong: `choosePollMode` would pick `native` with no limits to validate against, and
  // the button renderer would have no token budget to fit a token into.
  .refine((caps) => caps.nativePolls === (caps.pollLimits !== null), {
    message:
      'nativePolls and pollLimits must agree: limits are required exactly when polls are native',
  })
  .refine((caps) => caps.buttons === (caps.buttonLimits !== null), {
    message: 'buttons and buttonLimits must agree: limits are required exactly when buttons exist',
  });

// --- Inbound ------------------------------------------------------------------------------------

export const AttachmentRefSchema = z.strictObject({
  channel: channelId,
  // Adapter-specific, and **the adapter** validates its own shape — `fetchAttachment` turning
  // this into a URL is where `08` §3.9's SSRF rules apply, and only the adapter knows what a
  // legitimate handle looks like for its platform.
  data: z.record(z.string(), z.unknown()),
});

export const InboundAttachmentSchema = z.strictObject({
  ref: AttachmentRefSchema,
  kind: z.enum(['image', 'voice', 'audio', 'video', 'file', 'sticker', 'location', 'contact']),
  mime: z.string().max(255).optional(),
  name: z.string().max(1_024).optional(),
  sizeBytes: z.int().min(0).optional(),
  durationSec: z.number().min(0).optional(),
  isVoiceNote: z.boolean(),
  sensitive: z.boolean().optional(),
  inline: z
    .union([
      z.strictObject({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }),
      z.strictObject({ contactName: z.string().min(1).max(DISPLAY_NAME_MAX) }),
    ])
    .optional(),
});

/** Always untrusted: the linked page wrote every field. */
export const LinkPreviewSchema = z.strictObject({
  url: z.string().min(1).max(2_048),
  title: z.string().max(1_024).optional(),
  description: z.string().max(4_096).optional(),
});

export const InboundInteractionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('button'),
    // Bounded, not shaped. `ActionButtonSchema.token` requires the full interaction-token pattern
    // because Village mints every outbound token; this one is whatever arrived. A token that does
    // not match the pattern is an *unknown* token, and `06` §3.7 step 6 owes the member "This
    // button has expired" — which the engine can only say if the envelope reaches it. Tightening
    // this to the pattern would turn a forged or stale callback into a dropped event and a member
    // staring at a button that does nothing.
    payload: z.strictObject({ token: z.string().min(1).max(4_096) }),
  }),
  z.strictObject({
    kind: z.literal('poll_vote'),
    payload: z.intersection(
      z.object({ platformPollId: platformId, platformMessageId: platformId.optional() }),
      z.union([
        z.object({ mode: z.literal('replace'), optionIndexes: z.array(z.int().min(0)).max(50) }),
        z.object({
          mode: z.literal('delta'),
          optionIndex: z.int().min(0),
          op: z.enum(['add', 'remove']),
        }),
      ]),
    ),
  }),
  z.strictObject({
    kind: z.literal('reaction'),
    payload: z.strictObject({
      targetPlatformMessageId: platformId,
      emoji: z.string().min(1).max(64),
      action: z.enum(['added', 'removed']),
    }),
  }),
  z.strictObject({
    kind: z.literal('command'),
    payload: z.strictObject({
      name: z.string().min(1).max(64),
      args: z.string().max(TEXT_MAX),
      source: z.enum(['slash', 'text']),
      interactionId: z.string().max(PLATFORM_ID_MAX).optional(),
    }),
  }),
]);

/**
 * One normalised inbound message.
 *
 * `senderKind` is required rather than defaulted: `08` PSC-9's S4 gate reads it to decide whether
 * a message causes a model call, and a default of `'user'` would make an adapter that forgot to
 * classify bots into two bots talking to each other at a provider's prices.
 */
export const InboundEnvelopeSchema = z.strictObject({
  channel: channelId,
  platformChatId: platformId,
  chatKind: z.enum(['group', 'dm']),
  platformThreadId: platformId.optional(),
  platformMessageId: platformId,
  platformUserId: platformId,
  platformUserDisplayName: z.string().max(DISPLAY_NAME_MAX),
  platformUsername: z.string().max(DISPLAY_NAME_MAX).optional(),
  senderKind: z.enum(['user', 'anonymous_admin', 'channel', 'bot', 'system']),
  sentAt: isoInstant,
  text: z.string().max(TEXT_MAX),
  richText: RichTextSchema.optional(),
  truncated: z.boolean().optional(),
  mentionsBot: z.boolean(),
  replyToPlatformMessageId: platformId.optional(),
  replyToIsBot: z.boolean().optional(),
  forwarded: z
    .strictObject({
      fromName: z.string().max(DISPLAY_NAME_MAX).optional(),
      originalSentAt: isoInstant.optional(),
    })
    .optional(),
  quotedExternal: z.boolean().optional(),
  linkPreviews: z.array(LinkPreviewSchema).max(16).optional(),
  attachments: z.array(InboundAttachmentSchema).max(64),
  interaction: InboundInteractionSchema.optional(),
  userHints: z
    .strictObject({
      locale: z.string().max(35).optional(),
      timezone: z.string().max(64).optional(),
    })
    .optional(),
  deliveredLate: z.boolean().optional(),
  dedupeKey: z.string().max(PLATFORM_ID_MAX).optional(),
  // Unvalidated by design: it is the platform's own payload, retained only in debug mode. A
  // schema here would be a second, drifting copy of somebody else's API.
  raw: z.unknown(),
});

const chatRef = z.strictObject({
  channel: channelId,
  platformChatId: platformId,
  platformThreadId: platformId.optional(),
});
/** Exported: an adapter validating its own inbound payload needs these three. */
export const PlatformChatRefSchema = chatRef;
export const PlatformMessageRefSchema = chatRef.extend({ platformMessageId: platformId });
export const PlatformPollRefSchema = PlatformMessageRefSchema.extend({
  platformPollId: platformId,
});

const pollRef = z.strictObject({
  channel: channelId,
  platformChatId: platformId,
  platformThreadId: platformId.optional(),
  platformMessageId: platformId,
  platformPollId: platformId,
});

export const ChannelEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('message_edited'),
    chat: chatRef,
    platformMessageId: platformId,
    editedAt: isoInstant,
    text: z.string().max(TEXT_MAX),
    richText: RichTextSchema.optional(),
    attachments: z.array(InboundAttachmentSchema).max(64).optional(),
  }),
  z.strictObject({
    type: z.literal('message_deleted'),
    chat: chatRef,
    platformMessageIds: z.array(platformId).min(1).max(1_000),
    deletedAt: isoInstant,
  }),
  z.strictObject({
    type: z.literal('bot_membership'),
    chat: chatRef,
    chatKind: z.enum(['group', 'dm']),
    status: z.enum(['added', 'removed', 'banned', 'promoted', 'demoted', 'restricted']),
    byPlatformUserId: platformId.optional(),
    startPayload: z.string().max(1_024).optional(),
  }),
  z.strictObject({
    type: z.literal('member_joined'),
    chat: chatRef,
    platformUserId: platformId,
    displayName: z.string().max(DISPLAY_NAME_MAX).optional(),
  }),
  z.strictObject({
    type: z.literal('member_left'),
    chat: chatRef,
    platformUserId: platformId,
    displayName: z.string().max(DISPLAY_NAME_MAX).optional(),
  }),
  z.strictObject({
    type: z.literal('user_updated'),
    channel: channelId,
    platformUserId: platformId,
    displayName: z.string().max(DISPLAY_NAME_MAX),
    username: z.string().max(DISPLAY_NAME_MAX).optional(),
  }),
  z.strictObject({
    type: z.literal('chat_migrated'),
    channel: channelId,
    fromPlatformChatId: platformId,
    toPlatformChatId: platformId,
  }),
  z.strictObject({
    type: z.literal('chat_updated'),
    chat: chatRef,
    title: z.string().max(DISPLAY_NAME_MAX).optional(),
    isForum: z.boolean().optional(),
    encrypted: z.boolean().optional(),
    extShared: z.boolean().optional(),
  }),
  z.strictObject({ type: z.literal('dm_blocked'), channel: channelId, platformUserId: platformId }),
  z.strictObject({
    type: z.literal('dm_unblocked'),
    channel: channelId,
    platformUserId: platformId,
  }),
  z.strictObject({
    type: z.literal('poll_updated'),
    poll: pollRef,
    counts: z.array(z.int().min(0)).max(50),
    totalVoters: z.int().min(0),
    closed: z.boolean(),
  }),
  z.strictObject({
    type: z.literal('read_marker'),
    chat: chatRef,
    platformUserId: platformId,
    upToPlatformMessageId: platformId,
    at: isoInstant,
  }),
]);

// --- Outbound -----------------------------------------------------------------------------------

export const ResolvedMentionSchema = z.strictObject({
  platformUserId: platformId.optional(),
  displayName: z.string().min(1).max(DISPLAY_NAME_MAX),
  username: z.string().max(DISPLAY_NAME_MAX).optional(),
  canPing: z.boolean(),
});

/**
 * One button, validated on the way **out** (`06` §3.7).
 *
 * `token` carries the full interaction-token pattern rather than a length bound, and that is the
 * one assertion in this file that is a security control rather than a shape check. `06` §3.7:
 * "No structured strings (`cnf:…`, `poll:…`) ever go into `callback_data`, `custom_id` or
 * `value`." A regex at the outbound boundary is what turns that sentence into something a build
 * can enforce, because Village is the only producer of an outbound token.
 *
 * The matching **inbound** token in `InboundInteractionSchema` is deliberately loose. See the
 * header of `interactions/token.ts`: a malformed inbound token is an *unknown* token, and `06`
 * §3.7 step 6 owes the member "This button has expired" rather than the silence a rejected
 * envelope would give them.
 */
export const ActionButtonSchema = z.strictObject({
  label: z.string().min(1).max(500),
  style: z.enum(['primary', 'secondary', 'danger']),
  token: z.string().regex(INTERACTION_TOKEN_PATTERN),
  emojiFallback: z.enum(REACTION_KEYS).optional(),
  textFallback: z.string().min(1).max(500).optional(),
});

export const SentPartSchema = z.strictObject({
  index: z.int().min(0),
  platformMessageId: platformId,
  sentAt: isoInstant,
  possibleDuplicate: z.boolean().optional(),
});

/**
 * One message to send.
 *
 * Validated on the way **out**, which is the unusual direction and the deliberate one: the thing
 * being checked is the engine. `idempotencyKey` is what makes invariant **I6** hold across a
 * crash, and `messageClass` is what quiet hours and the proactive budget are decided on
 * (`01` §14 A24) — a `digest` sent as a `reply` bypasses both, silently, at 3 a.m.
 *
 * `attachments` is **not** validated here: `OutboundAttachment.open()` is a function, and a
 * schema cannot check a stream. The outbox row's size limit is `02` §3.13's.
 */
export const OutboundMessageSchema = z.strictObject({
  idempotencyKey: z.string().min(1).max(PLATFORM_ID_MAX),
  target: z.strictObject({
    channel: channelId,
    platformChatId: platformId,
    platformThreadId: platformId.optional(),
    chatKind: z.enum(['group', 'dm']),
  }),
  body: RichTextSchema,
  messageClass: z.enum(['reply', 'requested', 'digest', 'proactive', 'system']),
  priority: z.enum(['interactive', 'scheduled', 'background']),
  replyTo: z
    .union([
      z.strictObject({ platformMessageId: platformId }),
      z.strictObject({ interactionId: z.string().min(1).max(PLATFORM_ID_MAX) }),
    ])
    .optional(),
  mentions: z.record(z.string(), ResolvedMentionSchema),
  actions: z.array(z.array(ActionButtonSchema).max(25)).max(10).optional(),
  visibility: z
    .union([
      z.strictObject({ kind: z.literal('normal') }),
      z.strictObject({
        kind: z.literal('ephemeral'),
        platformUserId: platformId,
        fallback: z.enum(['dm', 'toast', 'drop']),
      }),
    ])
    .optional(),
  notify: z.enum(['normal', 'silent']).optional(),
  linkPreview: z.boolean().optional(),
  resume: z.strictObject({ partsSent: z.array(SentPartSchema).max(100) }).optional(),
});

export const PollSpecSchema = z
  .strictObject({
    target: chatRef,
    question: z.string().min(1).max(1_000),
    options: z.array(z.string().min(1).max(500)).min(1).max(50),
    multiSelect: z.boolean(),
    anonymous: z.boolean(),
    closesAt: isoInstant.optional(),
    idempotencyKey: z.string().min(1).max(PLATFORM_ID_MAX),
    replyTo: z.strictObject({ platformMessageId: platformId }).optional(),
  })
  // Two options that read the same are two tallies nobody can tell apart, and a member voting
  // for "Saturday" would not know which one they picked.
  .refine((spec) => new Set(spec.options).size === spec.options.length, {
    message: 'poll options must be distinct',
  });

export const PollFinalTallySchema = z.strictObject({
  counts: z.array(z.int().min(0)).max(50),
  totalVoters: z.int().min(0),
});

export const IngestAckSchema = z.strictObject({
  status: z.enum(['accepted', 'duplicate', 'dropped']),
  reason: z.enum(['unclaimed', 'detached', 'filtered']).optional(),
});
