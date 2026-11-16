/**
 * Per-platform capability profiles (`06` §3.2's matrix; the constants §4.1 names).
 *
 * Every value here is transcribed from §3.2, which carries a source link per cell — the Bot API
 * changelog, Discord's reference, Slack's method docs, the Matrix spec, signal-cli's source. The
 * table is the citation; this file is the data, and `profiles.test.ts` compares the two so a drift
 * in either fails.
 *
 * ## Why these live in the SDK rather than in each adapter
 *
 * §3.2 says so, and gives the reason: **the Simulator emulates every platform**. `M3-T11`'s
 * simulator takes a profile name and behaves like that platform — a 2 000-byte Signal limit, a
 * Matrix without buttons — so the whole product can be exercised against seven platforms with no
 * credentials. If each adapter owned its own profile, the simulator could only emulate platforms
 * whose adapters were already built, which is backwards: the point is to find the bug before the
 * adapter exists.
 *
 * ## `ideal` is not a platform
 *
 * It is every capability on, every limit generous. `06` §3.3's simulator uses it as the control:
 * a test that fails under `ideal` has found a bug in the product, and one that passes under
 * `ideal` and fails under `signal` has found a degradation path that does not work. Keeping them
 * apart is what makes the second answer meaningful.
 */
import type { ChannelCapabilities, PollLimits } from './contract.js';

/** 48 hours, in seconds — Telegram's own-message delete window (`06` §3.2). */
const TELEGRAM_DELETE_WINDOW_SEC = 172_800;

/**
 * Telegram.
 *
 * Two values deserve their source read twice. `maxMessageChars` is 4 096 "characters after
 * entities parsing", which is **visible** UTF-16 and not the raw HTML the renderer produces — so
 * the splitter measures the rendered text, not the markup. And inbound reactions arrive **only
 * for admins**, so `reactions: true` describes the outbound direction while a group's members
 * reacting is invisible to us; `07`'s decision records cannot be driven by Telegram reactions.
 */
const telegram: ChannelCapabilities = Object.freeze({
  threads: true,
  reactions: true,
  edits: true,
  deletes: true,
  nativePolls: true,
  buttons: true,
  typingIndicator: true,
  // `sendChatAction` lasts ≤5 s ([api](https://core.telegram.org/bots/api#sendchataction)).
  typingRefreshSec: 4,
  voiceNotes: true,
  images: true,
  files: true,
  maxMessageChars: 4_096,
  markup: 'telegram-html',
  mentionsByUserId: true,
  dmInitiation: 'after-user-contact',
  readsAllGroupMessages: 'requires-setup',
  lengthUnit: 'utf16',
  inboundEdits: true,
  // There is no delete update type in the Bot API, so a deleted message stays in our history
  // until something else contradicts it.
  inboundDeletes: false,
  pollLimits: Object.freeze({
    minOptions: 1,
    maxOptions: 12,
    maxQuestionChars: 300,
    maxOptionChars: 100,
    multiSelect: true,
    maxDurationSec: null,
    // Votes arrive only for non-anonymous polls the bot sent.
    voterIdentity: true,
  }) satisfies PollLimits,
  buttonLimits: Object.freeze({
    maxPerMessage: 100,
    maxPerRow: 8,
    maxLabelChars: 64,
    // `callback_data` is 1–64 **bytes**, which is what sizes the interaction token.
    tokenMaxBytes: 64,
  }),
  reactionSet: 'restricted',
  maxReactionsPerMessage: 1,
  ephemeral: 'best-effort',
  silentSend: true,
  datetimeTokens: true,
  deliveryVerification: 'none',
  memberListing: 'partial',
  maxInboundAttachmentBytes: 20 * 1024 * 1024,
  maxOutboundAttachmentBytes: 50 * 1024 * 1024,
  commands: 'native',
  deleteWindowSec: TELEGRAM_DELETE_WINDOW_SEC,
  linkPreviewControl: 'per-message',
  massMentionTokens: Object.freeze([]),
});

/** Discord. `maxOutboundAttachmentBytes` dropped to 20 MiB on 2026-09-03. */
const discord: ChannelCapabilities = Object.freeze({
  threads: true,
  reactions: true,
  edits: true,
  deletes: true,
  nativePolls: true,
  buttons: true,
  typingIndicator: true,
  // Discord expires a typing state after 10 s.
  typingRefreshSec: 8,
  voiceNotes: true,
  images: true,
  files: true,
  maxMessageChars: 2_000,
  markup: 'discord-md',
  mentionsByUserId: true,
  dmInitiation: 'any',
  readsAllGroupMessages: 'requires-setup',
  lengthUnit: 'utf16',
  inboundEdits: true,
  inboundDeletes: true,
  pollLimits: Object.freeze({
    minOptions: 1,
    maxOptions: 10,
    maxQuestionChars: 300,
    maxOptionChars: 55,
    multiSelect: true,
    maxDurationSec: 32 * 24 * 60 * 60,
    voterIdentity: true,
  }) satisfies PollLimits,
  buttonLimits: Object.freeze({
    maxPerMessage: 25,
    maxPerRow: 5,
    maxLabelChars: 80,
    tokenMaxBytes: 100,
  }),
  reactionSet: 'any',
  maxReactionsPerMessage: null,
  ephemeral: 'interaction-only',
  silentSend: true,
  datetimeTokens: true,
  deliveryVerification: 'native-idempotent',
  memberListing: 'exact',
  maxInboundAttachmentBytes: null,
  maxOutboundAttachmentBytes: 20 * 1024 * 1024,
  commands: 'native',
  deleteWindowSec: null,
  linkPreviewControl: 'per-message',
  // `08` PSC-9 S6: a renderer that let these through would notify a whole server.
  massMentionTokens: Object.freeze(['@everyone', '@here']),
});

/**
 * Slack.
 *
 * `maxMessageChars` is 12 000 for the message, with Block Kit sections capped at 3 000 each — so
 * the splitter's budget is the message and the renderer's is the section. Polls are **emulated**:
 * Slack has none, so `choosePollMode` returns `emulated` and the buttons path carries it.
 */
const slack: ChannelCapabilities = Object.freeze({
  threads: true,
  reactions: true,
  edits: true,
  deletes: true,
  nativePolls: false,
  buttons: true,
  // Plain bots cannot set a typing status; only assistant threads can.
  typingIndicator: false,
  // Plain bots have no typing API at all, so there is nothing to refresh.
  typingRefreshSec: null,
  voiceNotes: true,
  images: true,
  files: true,
  maxMessageChars: 12_000,
  markup: 'slack-mrkdwn',
  mentionsByUserId: true,
  dmInitiation: 'any',
  readsAllGroupMessages: 'yes',
  lengthUnit: 'utf16',
  inboundEdits: true,
  inboundDeletes: true,
  pollLimits: null,
  buttonLimits: Object.freeze({
    maxPerMessage: 25,
    maxPerRow: 5,
    maxLabelChars: 75,
    tokenMaxBytes: 2_000,
  }),
  reactionSet: 'any',
  maxReactionsPerMessage: null,
  ephemeral: 'best-effort',
  silentSend: false,
  datetimeTokens: true,
  deliveryVerification: 'verifiable',
  memberListing: 'exact',
  maxInboundAttachmentBytes: null,
  maxOutboundAttachmentBytes: 1024 * 1024 * 1024,
  commands: 'native',
  deleteWindowSec: null,
  linkPreviewControl: 'per-message',
  massMentionTokens: Object.freeze(['<!channel>', '<!here>', '<!everyone>']),
});

/**
 * Matrix (beta).
 *
 * No buttons at all, which is why `renderChoiceFallback` exists: a choice becomes reactions plus
 * numbered text. Polls are an unstable MSC, so `nativePolls` stays false until the proposal
 * settles — emulating them is worse than waiting only if the emulation is bad, and it is not.
 */
const matrix: ChannelCapabilities = Object.freeze({
  threads: true,
  reactions: true,
  edits: true,
  deletes: true,
  nativePolls: false,
  buttons: false,
  typingIndicator: true,
  // `PUT /typing` is sent with `timeout: 30000`.
  typingRefreshSec: 25,
  voiceNotes: true,
  images: true,
  files: true,
  // Our cap. The protocol's own event limit is 65 536 **bytes**.
  maxMessageChars: 16_000,
  markup: 'matrix-html',
  mentionsByUserId: true,
  dmInitiation: 'any',
  readsAllGroupMessages: 'yes',
  lengthUnit: 'utf16',
  inboundEdits: true,
  inboundDeletes: true,
  pollLimits: null,
  buttonLimits: null,
  reactionSet: 'any',
  maxReactionsPerMessage: null,
  ephemeral: 'none',
  // `m.notice` is suppressed by the default push rule.
  silentSend: true,
  datetimeTokens: false,
  deliveryVerification: 'native-idempotent',
  memberListing: 'exact',
  maxInboundAttachmentBytes: null,
  maxOutboundAttachmentBytes: 50 * 1024 * 1024,
  commands: 'text',
  deleteWindowSec: null,
  linkPreviewControl: 'client-side',
  massMentionTokens: Object.freeze(['@room']),
});

/**
 * Signal (experimental).
 *
 * **The byte limit is the point.** 2 000 **UTF-8 bytes**, from signal-cli's own
 * `MAX_MESSAGE_SIZE_BYTES` — roughly 500 characters of Arabic or Japanese, and the only profile
 * where `lengthUnit` is not `utf16`. A splitter that measured UTF-16 here would build messages
 * the platform refuses, for exactly the groups least able to work around it.
 *
 * `nativePolls` is **false** until SP-8 passes (`01` §14 A28), even though signal-cli 0.14.9
 * supports 2–10 options: an unproven native path is worse than a working emulation.
 */
const signal: ChannelCapabilities = Object.freeze({
  threads: false,
  reactions: true,
  edits: true,
  deletes: true,
  nativePolls: false,
  buttons: false,
  typingIndicator: true,
  // signal-cli's typing state shows for about 15 s.
  typingRefreshSec: 12,
  voiceNotes: true,
  images: true,
  files: true,
  maxMessageChars: 2_000,
  markup: 'plain',
  mentionsByUserId: true,
  dmInitiation: 'any',
  readsAllGroupMessages: 'yes',
  lengthUnit: 'utf8-bytes',
  inboundEdits: true,
  inboundDeletes: true,
  pollLimits: null,
  buttonLimits: null,
  reactionSet: 'any',
  maxReactionsPerMessage: null,
  ephemeral: 'none',
  silentSend: false,
  datetimeTokens: false,
  deliveryVerification: 'none',
  memberListing: 'exact',
  maxInboundAttachmentBytes: 150 * 1024 * 1024,
  maxOutboundAttachmentBytes: 150 * 1024 * 1024,
  commands: 'text',
  deleteWindowSec: null,
  linkPreviewControl: 'client-side',
  massMentionTokens: Object.freeze([]),
});

/** The web channel: ours, so everything works and the limits are our own. */
const web: ChannelCapabilities = Object.freeze({
  threads: false,
  reactions: true,
  edits: true,
  deletes: true,
  nativePolls: true,
  buttons: true,
  typingIndicator: true,
  // The dashboard client times out a `typing` SSE event after 20 s. `06` §3.11's table left this
  // blank, which `M3-T8` amends: with `maxSeconds` at 60, a one-shot event vanishes a third of
  // the way through the longest turn it is meant to cover.
  typingRefreshSec: 15,
  voiceNotes: true,
  images: true,
  files: true,
  maxMessageChars: 16_000,
  markup: 'web-md',
  mentionsByUserId: true,
  dmInitiation: 'after-user-contact',
  readsAllGroupMessages: 'yes',
  lengthUnit: 'utf16',
  inboundEdits: true,
  inboundDeletes: true,
  pollLimits: Object.freeze({
    minOptions: 2,
    maxOptions: 20,
    maxQuestionChars: 300,
    maxOptionChars: 200,
    multiSelect: true,
    maxDurationSec: null,
    voterIdentity: true,
  }) satisfies PollLimits,
  buttonLimits: Object.freeze({
    maxPerMessage: 25,
    maxPerRow: 5,
    maxLabelChars: 120,
    tokenMaxBytes: 256,
  }),
  reactionSet: 'any',
  maxReactionsPerMessage: null,
  ephemeral: 'reliable',
  silentSend: true,
  datetimeTokens: true,
  deliveryVerification: 'native-idempotent',
  memberListing: 'exact',
  maxInboundAttachmentBytes: null,
  maxOutboundAttachmentBytes: 100 * 1024 * 1024,
  commands: 'text',
  deleteWindowSec: null,
  linkPreviewControl: 'per-message',
  massMentionTokens: Object.freeze([]),
});

/**
 * Not a platform: every capability on, every limit generous.
 *
 * The **control** for the simulator. A test that fails here has found a bug in the product; one
 * that passes here and fails under `signal` has found a degradation path that does not work. Both
 * answers are useful and neither is available without this profile.
 */
const ideal: ChannelCapabilities = Object.freeze({
  threads: true,
  reactions: true,
  edits: true,
  deletes: true,
  nativePolls: true,
  buttons: true,
  typingIndicator: true,
  // Not a platform: generous, so the control profile refreshes as rarely as any real one.
  typingRefreshSec: 30,
  voiceNotes: true,
  images: true,
  files: true,
  maxMessageChars: 100_000,
  markup: 'web-md',
  mentionsByUserId: true,
  dmInitiation: 'any',
  readsAllGroupMessages: 'yes',
  lengthUnit: 'utf16',
  inboundEdits: true,
  inboundDeletes: true,
  pollLimits: Object.freeze({
    minOptions: 2,
    maxOptions: 50,
    maxQuestionChars: 1_000,
    maxOptionChars: 500,
    multiSelect: true,
    maxDurationSec: null,
    voterIdentity: true,
  }) satisfies PollLimits,
  buttonLimits: Object.freeze({
    maxPerMessage: 100,
    maxPerRow: 10,
    maxLabelChars: 500,
    tokenMaxBytes: 4_096,
  }),
  reactionSet: 'any',
  maxReactionsPerMessage: null,
  ephemeral: 'reliable',
  silentSend: true,
  datetimeTokens: true,
  deliveryVerification: 'native-idempotent',
  memberListing: 'exact',
  maxInboundAttachmentBytes: null,
  maxOutboundAttachmentBytes: 1024 * 1024 * 1024,
  commands: 'native',
  deleteWindowSec: null,
  linkPreviewControl: 'per-message',
  massMentionTokens: Object.freeze([]),
});

/** Every profile `06` §4.1 names, by the key the simulator takes. */
export const profiles: Readonly<
  Record<
    'telegram' | 'discord' | 'slack' | 'matrix' | 'signal' | 'web' | 'ideal',
    ChannelCapabilities
  >
> = Object.freeze({ telegram, discord, slack, matrix, signal, web, ideal });

export type ProfileName = keyof typeof profiles;

/** The names, for a test that walks them and for the simulator's config validation. */
export const PROFILE_NAMES: readonly ProfileName[] = Object.freeze(
  Object.keys(profiles) as ProfileName[],
);
