/**
 * The control surface (`06` §3.21.7; `M3-T11`).
 *
 * What a scenario writes against. `11` §3.3's DSL steps — `say`, `dm`, `reply`, `edit`, `react`,
 * `vote`, `press`, `command`, `join`, `leave`, `fault` — all land here, and the shape of this
 * object is what makes a scenario read like a group rather than like a wire protocol:
 * `control.user('alice').says('family', '@village what is on today?')`.
 *
 * ## Four differences from `06` §3.21.7's sketch, each one a defect in the sketch
 *
 * **`edits` and `deletes` take the chat.** §3.21.7 writes `.edits(msgId, text)` and says in the
 * line above that "message ids are sequential per chat" — so `m1` names one message per chat and a
 * bare id is ambiguous the moment a scenario has two. The ambiguity would resolve silently to
 * whichever chat the implementation happened to look at first.
 *
 * **`advance` is not here.** §3.21.7 gives the simulator `control.advance(ms)`. The clock belongs
 * to whoever created it, and in a real scenario that is `11` §3.2.2's `World`, whose `advance` has
 * to **settle** Village between steps — drain mailboxes, run due jobs, flush the outbox. A
 * `control.advance` that only moved the clock would look exactly like `World.advance` and silently
 * skip all of that, which is the failure `SettleDidNotConverge` exists to make loud.
 *
 * **`flush` is the platform's quiescence, not the system's.** §3.21.7 defines it as "all ingests
 * acked **and outbox drained**". The outbox is not visible from a channel adapter; the simulator
 * can only know that every update it delivered has been handed over and every `ingest` has
 * resolved. The system's quiescence is `World.settle()`.
 *
 * **`recordTo` takes a sink.** See `record.ts`.
 */
import type { PlatformPollRef } from '@comvivo/channel-sdk';
import type { SimFault, SimLedgerEntry, SimPlatform, SimRecordedCall } from './platform.js';
import { type ReplayOptions, replay, SimRecorder, type SimRecordSink } from './record.js';
import type { SimChat, SimFile, SimSender, SimUpdate } from './wire.js';

/** One line of a chat, as a scenario reads it back. */
export interface SimTranscriptLine {
  readonly seq: number;
  readonly platformMessageId: string;
  readonly fromBot: boolean;
  readonly text: string;
  /** The payload the renderer produced: the HTML string, the web AST, Signal's ranges. */
  readonly rich: unknown;
  readonly at: string;
  readonly idempotencyKey: string | undefined;
  readonly faultApplied: string | undefined;
  readonly duplicateOf: string | undefined;
}

export interface SaysOptions {
  readonly replyTo?: string;
  readonly replyToIsBot?: boolean;
  readonly thread?: string;
  readonly forwardedFrom?: string;
  readonly attachments?: readonly SimFile[];
  /** Name the bot, which is what `mentionsBot` reads and what privacy mode lets through. */
  readonly mentionsBot?: boolean;
  /** A slash command, as `06` §3.10 defines one. */
  readonly command?: string;
  readonly locale?: string;
  readonly timezone?: string;
  /** `08`'s anonymous-admin case, and the linked-channel one. */
  readonly as?: 'user' | 'anonymous_admin' | 'channel' | 'bot';
  readonly late?: boolean;
  readonly linkPreviews?: readonly { readonly url: string; readonly title?: string }[];
}

/** One simulated member. */
export interface SimUserHandle {
  readonly id: string;
  readonly name: string;
  joins(chatId: string): Promise<void>;
  leaves(chatId: string): Promise<void>;
  /** Post a message. Returns the platform message id, which a scenario needs to reply or react. */
  says(chatId: string, text: string, options?: SaysOptions): Promise<string>;
  edits(chatId: string, messageId: string, text: string): Promise<void>;
  deletes(chatId: string, messageId: string): Promise<void>;
  reacts(chatId: string, messageId: string, emoji: string): Promise<void>;
  unreacts(chatId: string, messageId: string, emoji: string): Promise<void>;
  /** Press a button. The token is opaque, exactly as it is on a real platform (`06` §3.7). */
  clicks(
    token: string,
    options?: { readonly chatId?: string; readonly onMessageId?: string },
  ): Promise<void>;
  votes(
    poll: Pick<PlatformPollRef, 'platformChatId' | 'platformPollId'>,
    options: readonly number[],
  ): Promise<void>;
  /** Start a DM, which is what `dmInitiation: 'after-user-contact'` waits for. */
  opensDm(): Promise<string>;
  reads(chatId: string, upToMessageId: string): Promise<void>;
  blocksDm(): Promise<void>;
  unblocksDm(): Promise<void>;
  renames(name: string): Promise<void>;
}

export interface SimControl {
  /** A member, created on first use. */
  user(id: string, name?: string): SimUserHandle;
  addBot(
    chatId: string,
    options?: { readonly by?: string; readonly startPayload?: string },
  ): Promise<void>;
  kickBot(chatId: string): Promise<void>;
  /** Upgrade a chat's id, permanently, the way Telegram turns a group into a supergroup. */
  migrate(chatId: string, newChatId: string): void;
  revokeToken(): void;
  restoreToken(): void;
  setPrivacyMode(on: boolean): void;
  setChatState(
    chatId: string,
    state: {
      readonly canSend?: boolean;
      readonly isAdmin?: boolean;
      readonly title?: string;
      readonly isForum?: boolean;
      readonly encrypted?: boolean;
      readonly extShared?: boolean;
    },
  ): void;
  /** Arm the next matching call to fail. `06` §3.21.7's shape. */
  failNext(
    kind: SimFault['kind'],
    options?: Omit<SimFault, 'kind'> & { readonly match?: string; readonly times?: number },
  ): void;
  clearFaults(): void;
  setLatency(ms: number): void;
  disconnect(ms: number): void;
  /** Make `closePoll` answer `null`, which `06` §3.8 allows and nothing else produces. */
  setPollTallyHidden(on: boolean): void;
  /** What a chat looks like, rendered and as the renderer's payload. */
  transcript(chatId: string): readonly SimTranscriptLine[];
  /** Every platform call the adapter made. */
  outbound(): readonly SimRecordedCall[];
  /** `11` §4.8's delivery ledger, for the I6 and I7 oracles. */
  ledger(): readonly SimLedgerEntry[];
  /** The bot messages that exist in a chat, which is what a duplicate check reads. */
  delivered(chatId: string): readonly string[];
  /** Await the platform's own quiescence. See the module header: not the system's. */
  flush(): Promise<void>;
  /** Start recording to `sink`. Returns a function that stops. */
  recordTo(sink: SimRecordSink): () => void;
  /** Feed a recording's inbound half back. */
  replay(
    lines: readonly string[],
    options?: ReplayOptions,
  ): Promise<{ delivered: number; skipped: number }>;
}

/** Internal: the recorder the platform's hooks write through. */
export interface ControlRecorderSlot {
  recorder: SimRecorder | undefined;
}

/**
 * The `entities` array, when a message has one.
 *
 * The bot is treated as named when the scenario says so **or** when the text contains its handle,
 * because a scenario author writing `'@Comvivo what is on today?'` has named it and should not have
 * to say twice. The flag exists for the other direction: a message that names the bot in a way the
 * platform would not mark, which is how a privacy-mode test distinguishes the two.
 */
function entitiesOf(
  selfName: string,
  text: string,
  options: SaysOptions,
): { entities?: { type: 'bot_mention' | 'command'; value: string }[] } {
  const entities: { type: 'bot_mention' | 'command'; value: string }[] = [];
  if (options.mentionsBot === true || text.includes(`@${selfName}`)) {
    entities.push({ type: 'bot_mention', value: selfName });
  }
  if (options.command !== undefined) {
    entities.push({ type: 'command', value: options.command });
  }
  return entities.length === 0 ? {} : { entities };
}

/**
 * The wire fields a message carries only sometimes.
 *
 * Spread rather than assigned, because `exactOptionalPropertyTypes` makes a present-but-`undefined`
 * key a different type from an absent one — and the absent one is what a platform actually sends.
 */
function optionalMessageFields(options: SaysOptions): Record<string, unknown> {
  return {
    ...(options.replyTo === undefined
      ? {}
      : {
          reply_to: {
            message_id: options.replyTo,
            ...(options.replyToIsBot === undefined ? {} : { from_is_bot: options.replyToIsBot }),
          },
        }),
    ...(options.forwardedFrom === undefined ? {} : { forward_from: options.forwardedFrom }),
    ...(options.attachments === undefined ? {} : { files: [...options.attachments] }),
    ...(options.linkPreviews === undefined
      ? {}
      : { link_previews: options.linkPreviews.map((preview) => ({ ...preview })) }),
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
    ...(options.late === true ? { late: true } : {}),
  };
}

export function createSimControl(platform: SimPlatform, slot: ControlRecorderSlot): SimControl {
  const users = new Map<string, SimUserHandle>();

  const deliver = (update: SimUpdate): Promise<void> => platform.deliver(update);

  const makeUser = (id: string, name: string): SimUserHandle => {
    const sender = (options: SaysOptions = {}): SimSender => ({
      id,
      name,
      ...(options.as === 'bot' ? { is_bot: true } : {}),
      ...(options.as === 'anonymous_admin' ? { anonymous: true } : {}),
      ...(options.as === 'channel' ? { channel: true } : {}),
    });

    /**
     * The chat a verb targets.
     *
     * The `dm:` prefix decides `chatKind`, which is the one place this package encodes a
     * convention rather than reading one: `openDm` returns `dm:<userId>` and a scenario that typed
     * the id by hand would otherwise get a DM classified as a group, and with it the wrong audience.
     */
    const chatRef = (chatId: string, options: SaysOptions = {}): SimChat => ({
      id: chatId,
      kind: chatId.startsWith('dm:') ? 'dm' : 'group',
      ...(options.thread === undefined ? {} : { thread: options.thread }),
    });

    const react = async (
      chatId: string,
      messageId: string,
      emoji: string,
      removed: boolean,
    ): Promise<void> => {
      await deliver({
        type: 'reaction',
        update_id: platform.nextUpdateId(),
        chat: chatRef(chatId),
        from: sender(),
        on_message_id: messageId,
        emoji,
        ...(removed ? { removed: true } : {}),
        at: platform.nowIso(),
      });
    };

    const dmBlock = async (blocked: boolean): Promise<void> => {
      await deliver({
        type: 'dm_blocked',
        update_id: platform.nextUpdateId(),
        platform_user_id: id,
        blocked,
        at: platform.nowIso(),
      });
    };

    const handle: SimUserHandle = {
      id,
      name,

      async joins(chatId) {
        platform.setMember(chatId, id, { name });
        await deliver({
          type: 'member',
          update_id: platform.nextUpdateId(),
          chat: chatRef(chatId),
          platform_user_id: id,
          name,
          joined: true,
          at: platform.nowIso(),
        });
      },

      async leaves(chatId) {
        platform.removeMember(chatId, id);
        await deliver({
          type: 'member',
          update_id: platform.nextUpdateId(),
          chat: chatRef(chatId),
          platform_user_id: id,
          joined: false,
          at: platform.nowIso(),
        });
      },

      async says(chatId, text, options = {}) {
        platform.setMember(chatId, id, { name });
        const messageId = platform.reserveMessageId(
          chatId,
          chatId.startsWith('dm:') ? 'dm' : 'group',
        );
        await deliver({
          type: 'message',
          update_id: platform.nextUpdateId(),
          chat: chatRef(chatId, options),
          from: sender(options),
          message_id: messageId,
          at: platform.nowIso(),
          text,
          ...entitiesOf(platform.selfName, text, options),
          ...optionalMessageFields(options),
        });
        return messageId;
      },

      async edits(chatId, messageId, text) {
        await deliver({
          type: 'edit',
          update_id: platform.nextUpdateId(),
          chat: chatRef(chatId),
          message_id: messageId,
          text,
          at: platform.nowIso(),
        });
      },

      async deletes(chatId, messageId) {
        await deliver({
          type: 'delete',
          update_id: platform.nextUpdateId(),
          chat: chatRef(chatId),
          message_ids: [messageId],
          at: platform.nowIso(),
        });
      },

      reacts: (chatId, messageId, emoji) => react(chatId, messageId, emoji, false),
      unreacts: (chatId, messageId, emoji) => react(chatId, messageId, emoji, true),

      async clicks(token, options = {}) {
        const chatId = options.chatId ?? platform.chats()[0] ?? 'chat-1';
        await deliver({
          type: 'callback',
          update_id: platform.nextUpdateId(),
          chat: chatRef(chatId),
          from: sender(),
          callback_id: `cb-${String(platform.nowMs())}-${id}`,
          on_message_id: options.onMessageId ?? platform.delivered(chatId).at(-1) ?? 'm1',
          data: token,
          at: platform.nowIso(),
        });
      },

      async votes(poll, options) {
        await deliver({
          type: 'poll_vote',
          update_id: platform.nextUpdateId(),
          chat: chatRef(poll.platformChatId),
          from: sender(),
          poll_id: poll.platformPollId,
          option_ids: [...options],
          at: platform.nowIso(),
        });
      },

      async opensDm() {
        const chatId = `dm:${id}`;
        platform.chat(chatId, 'dm');
        platform.setMember(chatId, id, { name });
        await deliver({
          type: 'membership',
          update_id: platform.nextUpdateId(),
          chat: { id: chatId, kind: 'dm' },
          status: 'added',
          by: id,
          at: platform.nowIso(),
        });
        return chatId;
      },

      async reads(chatId, upToMessageId) {
        await deliver({
          type: 'read_marker',
          update_id: platform.nextUpdateId(),
          chat: chatRef(chatId),
          platform_user_id: id,
          up_to_message_id: upToMessageId,
          at: platform.nowIso(),
        });
      },

      blocksDm: () => dmBlock(true),
      unblocksDm: () => dmBlock(false),

      async renames(next) {
        await deliver({
          type: 'user_updated',
          update_id: platform.nextUpdateId(),
          platform_user_id: id,
          name: next,
          at: platform.nowIso(),
        });
      },
    };

    return handle;
  };

  return {
    user(id, name) {
      const existing = users.get(id);
      if (existing !== undefined) return existing;
      const created = makeUser(id, name ?? id);
      users.set(id, created);
      return created;
    },

    addBot: (chatId, options) => platform.addBot(chatId, options ?? {}),
    kickBot: (chatId) => platform.kickBot(chatId),
    migrate: (chatId, newChatId) => {
      platform.migrate(chatId, newChatId);
    },
    revokeToken: () => {
      platform.revokeAuth();
    },
    restoreToken: () => {
      platform.restoreAuth();
    },
    setPrivacyMode: (on) => {
      platform.setPrivacyMode(on);
    },
    setChatState: (chatId, state) => {
      platform.setChatState(chatId, state);
    },

    failNext(kind, options = {}) {
      const { match, times, ...rest } = options;
      platform.armFault({ kind, ...rest }, match ?? 'sendMessage', times ?? 1);
    },
    clearFaults: () => {
      platform.clearFaults();
    },
    setLatency: (ms) => {
      platform.setLatency(ms);
    },
    disconnect: (ms) => {
      platform.disconnect(ms);
    },
    setPollTallyHidden: (on) => {
      platform.setPollTallyHidden(on);
    },

    transcript: (chatId) =>
      platform
        .ledger()
        .filter((entry) => entry.chatId === chatId)
        .map((entry) => ({
          seq: entry.seq,
          platformMessageId: entry.platformMessageId,
          fromBot: entry.fromBot,
          text: entry.text,
          rich: entry.rich,
          at: entry.at,
          idempotencyKey: entry.idempotencyKey,
          faultApplied: entry.faultApplied,
          duplicateOf: entry.duplicateOf,
        })),

    outbound: () => platform.outbound(),
    ledger: () => platform.ledger(),
    delivered: (chatId) => platform.delivered(chatId),
    flush: () => platform.settle(),

    recordTo(sink) {
      slot.recorder = new SimRecorder(sink);
      return () => {
        slot.recorder = undefined;
      };
    },

    replay: (lines, options) => replay(lines, platform, options ?? {}),
  };
}
