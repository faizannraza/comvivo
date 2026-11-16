/**
 * `@comvivo/channel-sdk`'s contract (`06` §4.1, which `01` §14 **A26** makes authoritative).
 *
 * Every platform adapter implements `ChannelAdapter` and receives an `AdapterContext`; nothing
 * else in the product knows which platform answered. The engine talks to this file, and `06`
 * §3.1's whole architecture rests on the shapes here being the only ones either side sees.
 *
 * ## Types only, deliberately
 *
 * This file declares and implements nothing. `06` §4.1 is a specification, and the value of
 * transcribing it as types is that an adapter which does not fit fails to compile rather than
 * failing in a family's group chat. The functions §4.1 lists beside these types arrive with the
 * tasks that can implement them honestly: the renderers at `M3-T4`, the splitter at `M3-T5`,
 * interactions and the choice fallback at `M3-T6`, the conformance kit at `M3-T9`.
 *
 * ## Two imports §4.1 names and this file does not
 *
 * §4.1's code block opens with `import type { Clock, Rng } from '@comvivo/core/ports'` and
 * `import type { RichText } from './richtext/ast.js'`. Neither is where those live:
 *
 *  - **`Clock` and `Rng` are in `@comvivo/shared`** (`ports/clock.ts`, `ports/rng.ts`), and
 *    `@comvivo/core` has no `ports` subpath export at all. `01` §4 puts the injected ports in
 *    `shared` so `core` can stay a pure domain; §4.1's import was written before that settled.
 *  - **`RichText` is in `@comvivo/core`** (`domain/rich-text.ts`), moved there at `M1-T11` and
 *    recorded in §3.5.1's own blockquote: `messages.rich_text` is a column, `packages/storage`
 *    may not depend on a channel package (`01` §4 as amended by A11), and two homes for one type
 *    is the outcome worth avoiding. §4.1's import line was not updated with it.
 *
 * Both are recorded in `STATUS.md` → Plan changes rather than silently followed, because the next
 * person to read §4.1 will reach for the same two imports.
 */
import type { ChannelId, MentionTarget, RichText } from '@comvivo/core';
import type { Clock, Logger, MemberId, Rng, Timers } from '@comvivo/shared';
import type { z } from 'zod';
import type { ReactionKey } from './reactions.js';

// --- Identity and shape -------------------------------------------------------------------------

/**
 * `ChannelId` comes from `@comvivo/core` and is **not** redeclared here.
 *
 * `06` §4.1 writes the union out, and `core/src/domain/channel.ts` already owns it — because the
 * `channel` columns in `02` §3.3 are `TEXT` and `packages/storage` cannot import a channel
 * package (`01` §4 as amended by A11). Two homes for one id is the thing `M1-T11` moved `RichText`
 * to avoid, and core's version is the better one anyway: it carries `mcp` (a tool call through
 * `10`'s MCP server creates a conversation like any other surface) and a `channelIdSchema` for the
 * boundary, neither of which §4.1's list has.
 */
export type Markup =
  | 'telegram-html'
  | 'discord-md'
  | 'slack-mrkdwn'
  | 'matrix-html'
  | 'plain'
  | 'web-md';

/** `05` §3.5.1's queue classes, which the outbox uses to decide what waits (`06` §3.14). */
export type Priority = 'interactive' | 'scheduled' | 'background';

// --- Capabilities -------------------------------------------------------------------------------

export interface PollLimits {
  readonly minOptions: number;
  readonly maxOptions: number;
  readonly maxQuestionChars: number;
  readonly maxOptionChars: number;
  readonly multiSelect: boolean;
  /** `null` where the platform has no limit. */
  readonly maxDurationSec: number | null;
  /** Whether the platform reports who voted, which decides whether a tally can be attributed. */
  readonly voterIdentity: boolean;
}

export interface ButtonLimits {
  readonly maxPerMessage: number;
  readonly maxPerRow: number;
  readonly maxLabelChars: number;
  /** Telegram's `callback_data` is 1–64 **bytes**, which is what sizes the interaction token. */
  readonly tokenMaxBytes: number;
}

/**
 * What a platform can do (`06` §3.2's matrix, spine §7.1 plus §12-1's refinements).
 *
 * Read by the renderers, the splitter, the poll chooser and the outbox — so a wrong value here is
 * not a cosmetic problem: `maxMessageChars` with the wrong `lengthUnit` splits a Signal message
 * in the middle of a grapheme, and `linkPreviewControl` read as `per-message` on a client-side
 * platform leaks a URL's preview to a group that should not have seen it.
 */
export interface ChannelCapabilities {
  readonly threads: boolean;
  readonly reactions: boolean;
  readonly edits: boolean;
  readonly deletes: boolean;
  readonly nativePolls: boolean;
  readonly buttons: boolean;
  readonly typingIndicator: boolean;
  readonly voiceNotes: boolean;
  readonly images: boolean;
  readonly files: boolean;
  readonly maxMessageChars: number;
  readonly markup: Markup;
  readonly mentionsByUserId: boolean;
  readonly dmInitiation: 'any' | 'after-user-contact' | 'none';
  readonly readsAllGroupMessages: 'yes' | 'requires-setup';

  /**
   * Whether `maxMessageChars` counts UTF-16 code units or UTF-8 bytes.
   *
   * Signal's limit is **2 000 UTF-8 bytes**, which is roughly 500 characters of Arabic or
   * Japanese. Measuring it in UTF-16 would let the splitter build a message the platform refuses.
   */
  readonly lengthUnit: 'utf16' | 'utf8-bytes';
  readonly inboundEdits: boolean;
  readonly inboundDeletes: boolean;
  readonly pollLimits: PollLimits | null;
  readonly buttonLimits: ButtonLimits | null;
  readonly reactionSet: 'any' | 'restricted';
  readonly maxReactionsPerMessage: number | null;
  readonly ephemeral: 'none' | 'best-effort' | 'interaction-only' | 'reliable';
  readonly silentSend: boolean;
  readonly datetimeTokens: boolean;
  readonly deliveryVerification: 'native-idempotent' | 'verifiable' | 'none';
  readonly memberListing: 'exact' | 'partial' | 'none';
  readonly maxInboundAttachmentBytes: number | null;
  readonly maxOutboundAttachmentBytes: number;
  readonly commands: 'native' | 'text';
  /** Telegram deletes own messages for 48 hours only; `null` where there is no window. */
  readonly deleteWindowSec: number | null;

  /**
   * Whether the bot can suppress a link preview **per message** (`08` PSC-9 S5).
   *
   * `client-side` means the decision belongs to each member's client, so a URL in a reply may
   * render a preview the group did not ask for — which is an egress of the linked page's content
   * to whoever opened the chat. The renderer cannot prevent it and says so rather than pretending.
   */
  readonly linkPreviewControl: 'per-message' | 'client-side';
  /**
   * Tokens a renderer must neutralise (`08` PSC-9 S6).
   *
   * Discord `@everyone`/`@here`, Slack `<!channel>`/`<!here>`/`<!everyone>`, Matrix `@room`. A
   * model that was asked to summarise a message containing one of these would otherwise notify a
   * whole server — the injection is in the *content*, so the fix is in the renderer.
   */
  readonly massMentionTokens: readonly string[];
}

// --- Platform references ------------------------------------------------------------------------

export interface PlatformChatRef {
  readonly channel: ChannelId;
  readonly platformChatId: string;
  readonly platformThreadId?: string;
}
export interface PlatformMessageRef extends PlatformChatRef {
  readonly platformMessageId: string;
}
export interface PlatformPollRef extends PlatformMessageRef {
  readonly platformPollId: string;
}

// --- Inbound ------------------------------------------------------------------------------------

export type AttachmentKind =
  | 'image'
  | 'voice'
  | 'audio'
  | 'video'
  | 'file'
  | 'sticker'
  | 'location'
  | 'contact';

/**
 * An opaque handle an adapter can later fetch.
 *
 * `data` is adapter-specific and **the adapter validates it with its own zod schema**: a handle
 * that crossed a process boundary is untrusted input, and `fetchAttachment` turning it into a URL
 * is exactly the place `08` §3.9's SSRF rules apply.
 */
export interface AttachmentRef {
  readonly channel: ChannelId;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface InboundAttachment {
  readonly ref: AttachmentRef;
  readonly kind: AttachmentKind;
  readonly mime?: string;
  readonly name?: string;
  readonly sizeBytes?: number;
  readonly durationSec?: number;
  readonly isVoiceNote: boolean;
  readonly sensitive?: boolean;
  /** Location and contact arrive inline, so no fetch is needed and none should be attempted. */
  readonly inline?:
    | { readonly lat: number; readonly lon: number }
    | { readonly contactName: string };
}

/** A preview the platform generated. **Always untrusted**: the linked page wrote it. */
export interface LinkPreview {
  readonly url: string;
  readonly title?: string;
  readonly description?: string;
}

export type InboundInteraction =
  | { readonly kind: 'button'; readonly payload: { readonly token: string } }
  | {
      readonly kind: 'poll_vote';
      readonly payload: {
        readonly platformPollId: string;
        readonly platformMessageId?: string;
      } & (
        | { readonly mode: 'replace'; readonly optionIndexes: readonly number[] }
        | { readonly mode: 'delta'; readonly optionIndex: number; readonly op: 'add' | 'remove' }
      );
    }
  | {
      readonly kind: 'reaction';
      readonly payload: {
        readonly targetPlatformMessageId: string;
        readonly emoji: string;
        readonly action: 'added' | 'removed';
      };
    }
  | {
      readonly kind: 'command';
      readonly payload: {
        readonly name: string;
        readonly args: string;
        readonly source: 'slash' | 'text';
        readonly interactionId?: string;
      };
    };

/**
 * One normalised inbound message (`06` §3.3; spine §7.1 plus §12-2's additive fields).
 *
 * `senderKind` is the field `08` PSC-9's S4 gate reads: `isBot` is exactly
 * `senderKind === 'bot'`, and a bot's message must not cause a model call — two bots in one group
 * otherwise talk to each other at a provider's prices until somebody notices.
 */
export interface InboundEnvelope {
  readonly channel: ChannelId;
  readonly platformChatId: string;
  readonly chatKind: 'group' | 'dm';
  readonly platformThreadId?: string;
  readonly platformMessageId: string;
  readonly platformUserId: string;
  readonly platformUserDisplayName: string;
  readonly platformUsername?: string;
  readonly senderKind: 'user' | 'anonymous_admin' | 'channel' | 'bot' | 'system';
  readonly sentAt: string;
  readonly text: string;
  readonly richText?: RichText;
  readonly truncated?: boolean;
  readonly mentionsBot: boolean;
  readonly replyToPlatformMessageId?: string;
  readonly replyToIsBot?: boolean;
  readonly forwarded?: { readonly fromName?: string; readonly originalSentAt?: string };
  readonly quotedExternal?: boolean;
  readonly linkPreviews?: readonly LinkPreview[];
  readonly attachments: readonly InboundAttachment[];
  readonly interaction?: InboundInteraction;
  readonly userHints?: { readonly locale?: string; readonly timezone?: string };
  readonly deliveredLate?: boolean;
  readonly dedupeKey?: string;
  /** Retained **only in debug mode** (spine; `05` §3.10.1's trace rules). */
  readonly raw: unknown;
}

/**
 * Everything that happens in a chat that is not a message (`06` §3.3).
 *
 * `read_marker` adopts `07`'s proposal SC-3 — Matrix `m.read`, the web channel and Signal's
 * own-message receipts — so a digest can tell "nobody has read this" from "nobody replied".
 */
export type ChannelEvent =
  | {
      readonly type: 'message_edited';
      readonly chat: PlatformChatRef;
      readonly platformMessageId: string;
      readonly editedAt: string;
      readonly text: string;
      readonly richText?: RichText;
      readonly attachments?: readonly InboundAttachment[];
    }
  | {
      readonly type: 'message_deleted';
      readonly chat: PlatformChatRef;
      readonly platformMessageIds: readonly string[];
      readonly deletedAt: string;
    }
  | {
      readonly type: 'bot_membership';
      readonly chat: PlatformChatRef;
      readonly chatKind: 'group' | 'dm';
      readonly status: 'added' | 'removed' | 'banned' | 'promoted' | 'demoted' | 'restricted';
      readonly byPlatformUserId?: string;
      /** A deep-link payload, which is how `06` §3.20.1's claim codes arrive. */
      readonly startPayload?: string;
    }
  | {
      readonly type: 'member_joined' | 'member_left';
      readonly chat: PlatformChatRef;
      readonly platformUserId: string;
      readonly displayName?: string;
    }
  | {
      readonly type: 'user_updated';
      readonly channel: ChannelId;
      readonly platformUserId: string;
      readonly displayName: string;
      readonly username?: string;
    }
  | {
      readonly type: 'chat_migrated';
      readonly channel: ChannelId;
      readonly fromPlatformChatId: string;
      readonly toPlatformChatId: string;
    }
  | {
      readonly type: 'chat_updated';
      readonly chat: PlatformChatRef;
      readonly title?: string;
      readonly isForum?: boolean;
      readonly encrypted?: boolean;
      readonly extShared?: boolean;
    }
  | {
      readonly type: 'dm_blocked' | 'dm_unblocked';
      readonly channel: ChannelId;
      readonly platformUserId: string;
    }
  | {
      readonly type: 'poll_updated';
      readonly poll: PlatformPollRef;
      readonly counts: readonly number[];
      readonly totalVoters: number;
      readonly closed: boolean;
    }
  | {
      readonly type: 'read_marker';
      readonly chat: PlatformChatRef;
      readonly platformUserId: string;
      readonly upToPlatformMessageId: string;
      readonly at: string;
    };

/**
 * What ingestion says back.
 *
 * `dropped` carries a reason because the three are operationally different: `unclaimed` is a chat
 * nobody has set up (`06` §3.20), `detached` is one that was unbound, and `filtered` is a message
 * the gates refused. A single boolean would make a misconfigured install indistinguishable from a
 * working one that is ignoring bots.
 */
export interface IngestAck {
  readonly status: 'accepted' | 'duplicate' | 'dropped';
  readonly reason?: 'unclaimed' | 'detached' | 'filtered';
}

// --- Outbound -----------------------------------------------------------------------------------

export interface ResolvedMention {
  readonly platformUserId?: string;
  readonly displayName: string;
  readonly username?: string;
  /** False when the platform cannot ping this member, so the renderer writes plain text instead. */
  readonly canPing: boolean;
}

/**
 * One button (`06` §3.7, §4.1).
 *
 * `token` is always an opaque interaction token (`interactions/token.ts`) and never a structured
 * string: `ActionButtonSchema` enforces the shape on the way out, which is what makes `06` §3.7's
 * "no structured strings ever go into `callback_data`" structural rather than a convention.
 *
 * The two `*Fallback` fields are read only on a platform with `buttons: false`, where
 * `renderChoiceFallback` turns the row into reactions or numbered replies. Both are optional and
 * both default sensibly, so a producer that has nothing special to say sets neither.
 */
export interface ActionButton {
  readonly label: string;
  readonly style: 'primary' | 'secondary' | 'danger';
  readonly token: string;
  /**
   * A **canonical reaction key** (`reactions.ts`), not an emoji.
   *
   * `06` §3.9 narrowed this from `string` at `M3-T6`. A literal emoji here would be wrong on
   * exactly the platforms the field exists for: a producer writing `'\u2705'` loses `06` §3.7's
   * "`\u{1F44D}` `\u{1F44E}` where the platform's reaction set lacks them", because the
   * substitution is a property of the key and the platform, not of the string. A key survives the
   * map; an emoji has already thrown the map away.
   */
  readonly emojiFallback?: ReactionKey;
  /**
   * What a member types to pick this instead of its position — `"yes"` for an approve button.
   *
   * Locale-bearing, so it comes from `05`'s copy catalog and never from the SDK. Used only when
   * **every** button in the message has one and they are all distinct; otherwise the fallback
   * numbers them, because a repeated or partial marker set makes a reply ambiguous and `06` §3.7
   * ignores an ambiguous reply.
   */
  readonly textFallback?: string;
}
export type ActionRow = readonly ActionButton[];

export interface OutboundAttachment {
  readonly kind: 'image' | 'file' | 'voice';
  readonly name: string;
  readonly mime: string;
  readonly sizeBytes: number;
  open(): Promise<ReadableStream<Uint8Array>>;
}

export interface SentPart {
  readonly index: number;
  readonly platformMessageId: string;
  readonly sentAt: string;
  /** Set when a resume could not prove the part had not already arrived (`06` §3.15). */
  readonly possibleDuplicate?: boolean;
}

/**
 * One message to send (`06` §3.13).
 *
 * `idempotencyKey` is derived from `(turnId, index)` and is what makes invariant **I6
 * (exactly-once intent)** hold across a crash: the outbox row carries it, the adapter sends under
 * it, and `resume` lets a restarted send skip the parts that already landed.
 *
 * `messageClass` implements `01` §14 **A24** and is copied from the outbox row. It is not
 * decoration: quiet hours and the proactive-message budget are decided on it, so a `digest` sent
 * as a `reply` bypasses both.
 */
export interface OutboundMessage {
  readonly idempotencyKey: string;
  readonly target: PlatformChatRef & { readonly chatKind: 'group' | 'dm' };
  readonly body: RichText;
  readonly messageClass: 'reply' | 'requested' | 'digest' | 'proactive' | 'system';
  readonly priority: Priority;
  readonly replyTo?: { readonly platformMessageId: string } | { readonly interactionId: string };
  readonly mentions: Readonly<Record<MemberId, ResolvedMention>>;
  readonly actions?: readonly ActionRow[];
  readonly attachments?: readonly OutboundAttachment[];
  readonly visibility?:
    | { readonly kind: 'normal' }
    | {
        readonly kind: 'ephemeral';
        readonly platformUserId: string;
        readonly fallback: 'dm' | 'toast' | 'drop';
      };
  readonly notify?: 'normal' | 'silent';
  /** Defaults to **false**: a preview is the linked page's content, shown to everyone present. */
  readonly linkPreview?: boolean;
  readonly resume?: { readonly partsSent: readonly SentPart[] };
}

export interface SendReceipt {
  readonly parts: readonly SentPart[];
  /** True when rich markup failed and the adapter re-sent as plain text (`06` §3.5.3). */
  readonly fellBackToPlain: boolean;
}

export interface PollSpec {
  readonly target: PlatformChatRef;
  readonly question: string;
  readonly options: readonly string[];
  readonly multiSelect: boolean;
  readonly anonymous: boolean;
  readonly closesAt?: string;
  readonly idempotencyKey: string;
  readonly replyTo?: { readonly platformMessageId: string };
}

/** `counts[i]` pairs with `PollSpec.options[i]`. Adopts `07`'s SC-3. */
export interface PollFinalTally {
  readonly counts: readonly number[];
  readonly totalVoters: number;
}

// --- Describing the platform --------------------------------------------------------------------

export interface PlatformMember {
  readonly platformUserId: string;
  readonly displayName: string;
  readonly username?: string;
  readonly isBot: boolean;
  readonly isAdmin?: boolean;
}

export interface MemberListing {
  readonly members: readonly PlatformMember[];
  readonly completeness: 'exact' | 'partial';
  readonly totalCount?: number;
}

/** One thing wrong, as `06` §3.20.3's fix-it guides and `09`'s `doctor` both render it. */
export interface Diagnostic {
  readonly code: string;
  readonly severity: 'blocking' | 'degraded' | 'advisory';
  readonly params?: Readonly<Record<string, string | number>>;
}

export interface ChatProbe {
  readonly canSend: boolean;
  readonly readsAll: boolean;
  readonly isAdmin?: boolean;
  readonly title?: string;
  readonly memberCount?: number;
  readonly isForum?: boolean;
  readonly encrypted?: boolean;
  readonly extShared?: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

export interface SelfInfo {
  readonly platformUserId: string;
  readonly username?: string;
  readonly displayName: string;
  readonly appId?: string;
  /** Platform flags, e.g. `{canReadAllGroupMessages: false, canJoinGroups: true}`. */
  readonly flags: Readonly<Record<string, boolean | string>>;
}

export interface CommandSpec {
  readonly name: string;
  readonly description: string;
  readonly args: 'none' | 'text';
  readonly scope: 'group' | 'dm' | 'both';
  readonly ephemeralReply: boolean;
}

// --- What an adapter is given -------------------------------------------------------------------

/**
 * Durable key/value, namespaced per adapter. JSON values up to 64 KiB.
 *
 * **Synchronous**, because it is better-sqlite3 underneath and `01` §2's rule is that a
 * transaction never spans an `await`. An adapter that needs to write state inside a handler can
 * do it without opening a window where a crash loses the write.
 */
export interface AdapterStateStore {
  /**
   * `unknown`, not `get<T>(): T | undefined` as `06` §4.1 writes it — the adapter parses what
   * comes back.
   *
   * A generic here is an unchecked cast wearing a type parameter: the store returns whatever was
   * written, possibly by an older version of the adapter, and `T` is a promise it cannot keep.
   * `01` §2 requires every boundary validated with zod, and a durable store that survives a
   * restart and an upgrade is a boundary. `10` §3.2.4's `PluginStore` made the same call for the
   * same reason, and its comment says so: "`unknown` rather than a generic, so the plugin parses
   * what comes back."
   *
   * `typescript-eslint`'s `no-unnecessary-type-parameters` flags the generic form independently,
   * which is the rule noticing the same thing.
   */
  get(key: string): unknown;
  set(key: string, value: unknown, opts?: { readonly ttlSec?: number }): void;
  delete(key: string): void;
}

export type AdapterHealth =
  | 'starting'
  | 'healthy'
  | 'degraded'
  | 'auth_failed'
  | 'conflict'
  | 'captcha_required'
  | 'stopped';

export interface HealthReporter {
  report(
    status: AdapterHealth,
    detail?: { readonly reason: string; readonly diagnostics?: readonly Diagnostic[] },
  ): void;
}

/** A synchronous durable write, for the same reason `AdapterStateStore` is synchronous. */
export interface SendProgressSink {
  record(idempotencyKey: string, part: SentPart): void;
}

export interface BindingView {
  status(platformChatId: string): 'bound' | 'unclaimed' | 'detached';
  hasPendingClaim(channel: ChannelId): boolean;
}

export interface WebhookRegistrar {
  route(method: 'POST', path: string, handler: (req: Request) => Promise<Response>): void;
}

/** A counter/histogram facade (`06` §8), so an adapter records metrics without importing OTel. */
export interface ChannelMetrics {
  counter(name: string, value?: number, labels?: Readonly<Record<string, string>>): void;
  histogram(name: string, value: number, labels?: Readonly<Record<string, string>>): void;
}

/** What a renderer needs beyond the AST (`06` §3.5.3). */
export interface RenderContext {
  readonly mentions: Readonly<Record<MemberId, ResolvedMention>>;
  readonly self: SelfInfo;
  readonly linkPreview: boolean;
  readonly locale: string;
}

export interface RenderedPart {
  /** The platform's own payload shape — a string, Block Kit JSON, an AST. */
  readonly payload: unknown;
  /** Length in the platform's own `lengthUnit`, which is what the splitter budgets against. */
  readonly measured: number;
  /** The same content as plain text, for the fallback path and for a log line. */
  readonly plainText: string;
}

export interface AdapterContext {
  readonly channel: ChannelId;
  /** The adapter validates this with its own zod schema; see `defineAdapter`. */
  readonly config: unknown;
  readonly secrets: { get(name: string): string | undefined };
  /** A pino child bound to `{channel}`, with `08` §3.16's content redaction installed. */
  readonly logger: Logger;
  readonly clock: Clock;
  /**
   * Drivable timers (`M3-T7`).
   *
   * Added because the SDK's own machinery needs to wait: the rate limiter sleeps until a bucket
   * refills (`06` §3.14) and the typing manager refreshes on a cadence (`06` §3.11), and
   * `comvivo/channel-sdk-purity` bans `setTimeout` in this package outright. That ban is the point
   * — `VirtualClock` implements `Clock` and `Timers` together, so a 3-second refill interval and a
   * 60-second retry cap are testable in microseconds instead of being untestable.
   */
  readonly timers: Timers;
  readonly rng: Rng;
  /** Aborted by `stop()`, so every in-flight request has one thing to listen to. */
  readonly signal: AbortSignal;
  /** Injectable so a test or a proxy can replace it. */
  readonly fetch: typeof globalThis.fetch;
  /** `<dataDir>/channels/<id>/` — the Matrix crypto store, Signal's files. */
  readonly dataDir: string;
  ingest(envelope: InboundEnvelope): Promise<IngestAck>;
  ingestEvent(event: ChannelEvent): Promise<IngestAck>;
  readonly state: AdapterStateStore;
  readonly health: HealthReporter;
  readonly commands: readonly CommandSpec[];
  readonly bindings: BindingView;
  readonly sendProgress: SendProgressSink;
  readonly metrics: ChannelMetrics;
  /** Present only when the server exposes HTTP to this adapter. */
  readonly webhooks?: WebhookRegistrar;
}

/**
 * A platform adapter.
 *
 * **An optional method's presence must match its capabilities** (`06` C23, asserted by the
 * conformance kit at `M3-T9`). An adapter that declares `buttons: true` and omits
 * `answerInteraction` would accept a press it cannot acknowledge; one that declares
 * `nativePolls: false` and implements `createPoll` would have the engine choose the wrong mode.
 */
export interface ChannelAdapter {
  readonly id: ChannelId;
  readonly capabilities: ChannelCapabilities;
  start(ctx: AdapterContext): Promise<void>;
  stop(): Promise<void>;
  send(msg: OutboundMessage): Promise<SendReceipt>;
  edit?(ref: PlatformMessageRef, msg: OutboundMessage): Promise<void>;
  delete?(ref: PlatformMessageRef): Promise<void>;
  react?(ref: PlatformMessageRef, emoji: string): Promise<void>;
  unreact?(ref: PlatformMessageRef, emoji: string): Promise<void>;
  createPoll?(spec: PollSpec): Promise<PlatformPollRef>;
  /** `null` when the platform reports no final counts (`06` §3.8). */
  closePoll?(ref: PlatformPollRef): Promise<PollFinalTally | null>;
  setTyping?(chat: PlatformChatRef, on: boolean): Promise<void>;
  /**
   * `opts` is **additive** against the spine sketch (`06` §12-4): a fetch with no byte ceiling and
   * no signal is how a 2 GB "voice note" fills a host's disk.
   */
  fetchAttachment(
    ref: AttachmentRef,
    opts: { readonly maxBytes: number; readonly signal: AbortSignal },
  ): Promise<ReadableStream<Uint8Array>>;
  listMembers?(chat: PlatformChatRef): Promise<MemberListing>;
  describeSelf(): Promise<SelfInfo>;
  describeUser?(
    platformUserId: string,
  ): Promise<PlatformMember & { readonly locale?: string; readonly timezone?: string }>;
  probe?(chat: PlatformChatRef): Promise<ChatProbe>;
  openDm?(platformUserId: string): Promise<{ readonly platformChatId: string }>;
  dmLink?(payload: string): string | null;
  addToGroupLink?(payload: string): string | null;
  leave?(chat: PlatformChatRef): Promise<void>;
  verifyDelivery?(
    target: PlatformChatRef,
    idempotencyKey: string,
    partIndex: number,
    since: string,
  ): Promise<'delivered' | 'not_found' | 'unknown'>;
  /** The fast-path toast, e.g. Telegram's `answerCallbackQuery`. */
  answerInteraction?(
    interactionId: string,
    reply: { readonly text: string; readonly alert?: boolean },
  ): Promise<void>;
  /** **Synchronous and network-free** (`06` §3.4), because `07` cites it inside a decision record. */
  permalink?(ref: PlatformMessageRef): string | null;
}

/** What `defineAdapter` returns: the factory a host's config is validated against. */
export interface AdapterFactory<C> {
  readonly id: ChannelId;
  readonly configSchema: z.ZodType<C>;
  create(config: C): ChannelAdapter;
}

export type { ChannelId, MentionTarget, RichText };
