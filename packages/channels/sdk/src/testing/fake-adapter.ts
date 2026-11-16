/**
 * The reference adapter (`06` §3.25; `M3-T9`).
 *
 * A miniature, correct `ChannelAdapter` over {@link createFakePlatform}. Its job is to make the 24
 * conformance cases **tests rather than descriptions**: a case no implementation has ever satisfied
 * is a sentence, and a kit of 24 sentences is worth nothing to the first adapter that runs it.
 *
 * It has a second job, and in the long run the more useful one: it is what `M3-T32` reads before
 * writing the Telegram adapter. Every case that fails there will have passed here, which turns "the
 * kit is wrong" from a hunch into a claim somebody has to argue against a working implementation.
 *
 * ## What it does *not* do
 *
 * No network, no persistence, no platform quirks. Where a real adapter has to parse Telegram's
 * `message_thread_id` or Slack's `thread_ts`, this one reads a field with an obvious name. The
 * translation is still real — the fake's wire shape is deliberately not the envelope — but the
 * difficulty lives in each adapter's own fixtures, which is where `06` §3.25 puts it.
 *
 * ## The parts that are not simplified
 *
 * Four, because the cases that matter are about them:
 *
 * - **Sending** goes through the real splitter, the real renderer, the real rate limiter and the
 *   real retry policy. C06, C07, C12 and C13 are assertions about those, so a fake that hand-wrote
 *   a shortcut would be testing the shortcut.
 * - **The echo filter** is checked before anything else, because `08` PSC-9's S4 gate turns on it:
 *   two bots in one group otherwise talk to each other at a provider's prices.
 * - **The ack order** is ingest first, platform second. `06` §3.25's C05 asks for exactly that, and
 *   the reason is crash safety: a platform acked before the ingest is a message the platform will
 *   never redeliver and Village never stored.
 * - **Health** reports on the paths `06` §3.15 names, so C18's "stops its loops and reports
 *   `auth_failed` within 1 s" has something to observe.
 */
import { BRAND } from '@comvivo/shared';
import type {
  AdapterContext,
  AttachmentRef,
  ChannelAdapter,
  ChannelCapabilities,
  ChannelEvent,
  ChatProbe,
  Diagnostic,
  InboundAttachment,
  InboundEnvelope,
  MemberListing,
  OutboundMessage,
  PlatformChatRef,
  PlatformMessageRef,
  PlatformPollRef,
  PollFinalTally,
  PollSpec,
  SelfInfo,
  SentPart,
} from '../contract.js';
import { ChannelError, type ChannelErrorKind } from '../errors.js';
import { profiles } from '../profiles.js';
import { bucketKeys, bucketSpec, RateLimiter } from '../ratelimit/index.js';
import { planRetry } from '../retry.js';
import { splitAndRender } from '../richtext/split.js';
import { TypingManager } from '../typing.js';
import { type FakePlatform, FakePlatformError, type FakeUpdate } from './fake-platform.js';

/**
 * The reference capabilities.
 *
 * `profiles.telegram`'s shape with two numbers tightened: `maxMessageChars` at 400 so C07's
 * splitting property actually splits, and the button limits left as Telegram's so C09's token-fit
 * check has a real budget to check against. The channel is `simulator`, which has no entry in
 * `profiles` — C23 handles that case, because `06` §3.25's last line asks third-party plugins to
 * pass the kit and a plugin channel has no entry either.
 */
export const FAKE_CAPABILITIES: ChannelCapabilities = Object.freeze({
  ...profiles.telegram,
  maxMessageChars: 400,
});

/** `06` §3.14's Telegram row, tightened so C12's burst of 50 is observable in virtual time. */
const GLOBAL_BUCKET = bucketSpec(25, 25);
const CHAT_BUCKET = bucketSpec(5, 1 / 3);

/** `06` §3.15's taxonomy, keyed by what the fake throws. */
const ERROR_KINDS: Readonly<Record<string, ChannelErrorKind>> = {
  rate_limited: 'rate_limited',
  transient: 'transient',
  ambiguous: 'ambiguous',
  auth_revoked: 'auth_revoked',
  instance_conflict: 'instance_conflict',
  chat_access_lost: 'chat_access_lost',
  user_unreachable: 'user_unreachable',
  chat_migrated: 'chat_migrated',
  permission_missing: 'permission_missing',
  message_too_long: 'message_too_long',
  markup_rejected: 'markup_rejected',
  not_found: 'not_found',
  bad_request: 'bad_request',
};

/**
 * Translate what the platform threw.
 *
 * Exported because C11 is an assertion about this table, and an adapter whose mapping lived inline
 * in a `catch` would have nothing for the case to point at. `06` §3.15's `retryAfterMs` and
 * `newPlatformChatId` are carried through: the first is what makes a 429 honour the platform's own
 * number, and the second is what lets `chat_migrated` retry immediately on the new id.
 */
export function toChannelError(error: unknown): ChannelError {
  if (error instanceof ChannelError) return error;
  if (error instanceof FakePlatformError) {
    const kind = ERROR_KINDS[error.kind] ?? 'bad_request';
    const retryAfter = error.detail['retryAfterMs'];
    const to = error.detail['to'];
    return new ChannelError(kind, error.message, {
      platformCode: error.kind,
      ...(typeof retryAfter === 'number' ? { retryAfterMs: retryAfter } : {}),
      ...(typeof to === 'string' ? { newPlatformChatId: to } : {}),
      cause: error,
    });
  }
  return new ChannelError('bad_request', error instanceof Error ? error.message : 'unknown', {
    cause: error,
  });
}

export interface FakeAdapterOptions {
  /** Overrides, so a case can run the same adapter with a capability turned off. */
  readonly capabilities?: ChannelCapabilities;
}

export function createFakeAdapter(
  fake: FakePlatform,
  options: FakeAdapterOptions = {},
): ChannelAdapter {
  const capabilities = options.capabilities ?? FAKE_CAPABILITIES;
  let ctx: AdapterContext | null = null;
  let limiter: RateLimiter | null = null;
  let typing: TypingManager | null = null;
  let running = false;
  let stopped = false;

  const required = (): AdapterContext => {
    if (ctx === null) throw new ChannelError('bad_request', 'the adapter was not started', {});
    return ctx;
  };

  /** Every platform call goes through here, so the error taxonomy has exactly one entry point. */
  const call = async (method: string, args: unknown): Promise<unknown> => {
    try {
      return await fake.call(method, args);
    } catch (error) {
      const mapped = toChannelError(error);
      if (mapped.kind === 'auth_revoked' || mapped.kind === 'instance_conflict') {
        // `06` §3.15: stop the loops and stay registered with the matching health status. C18 times
        // this, which is why it happens here rather than in a periodic sweep.
        running = false;
        required().health.report(mapped.kind === 'auth_revoked' ? 'auth_failed' : 'conflict', {
          reason: mapped.kind,
        });
      }
      throw mapped;
    }
  };

  const chatRef = (
    update: FakeUpdate & { chat: { id: string; thread?: string } },
  ): PlatformChatRef => ({
    channel: required().channel,
    platformChatId: update.chat.id,
    ...(update.chat.thread === undefined ? {} : { platformThreadId: update.chat.thread }),
  });

  const attachmentsOf = (
    update: Extract<FakeUpdate, { type: 'message' }>,
  ): readonly InboundAttachment[] =>
    (update.files ?? []).map((file) => ({
      ref: { channel: required().channel, data: { file_id: file.file_id } },
      kind: file.kind,
      ...(file.mime === undefined ? {} : { mime: file.mime }),
      ...(file.name === undefined ? {} : { name: file.name }),
      sizeBytes: file.bytes,
      isVoiceNote: file.voice === true,
    }));

  /**
   * One message update becomes one envelope.
   *
   * `senderKind` is first because `08` PSC-9's S4 gate reads it, and `dedupeKey` is the platform's
   * own identity for the update rather than anything derived — C02 asserts that redelivering a
   * payload yields the same one, which is only true if it comes from the payload.
   */
  const toEnvelope = (update: Extract<FakeUpdate, { type: 'message' }>): InboundEnvelope => {
    const command = update.entities?.find((entity) => entity.type === 'command');
    const mentioned = update.entities?.some((entity) => entity.type === 'bot_mention') === true;
    return {
      channel: required().channel,
      platformChatId: update.chat.id,
      chatKind: update.chat.kind,
      ...(update.chat.thread === undefined ? {} : { platformThreadId: update.chat.thread }),
      platformMessageId: update.message_id,
      platformUserId: update.from.id,
      platformUserDisplayName: update.from.name,
      ...(update.from.username === undefined ? {} : { platformUsername: update.from.username }),
      senderKind: senderKindOf(update.from),
      sentAt: update.at,
      text: update.text ?? '',
      // `06` C03: a slash command in a DM addresses the bot whether or not it was named. In a group
      // it does not, because a command aimed at another bot is still a command.
      mentionsBot: mentioned || (command !== undefined && update.chat.kind === 'dm'),
      ...replyFields(update),
      ...(update.forward_from === undefined
        ? {}
        : { forwarded: { fromName: update.forward_from } }),
      attachments: attachmentsOf(update),
      ...(command === undefined ? {} : commandInteraction(command.value)),
      ...hintFields(update),
      ...(update.late === true ? { deliveredLate: true } : {}),
      // The platform's own identity for the update, not anything derived: C02 asserts that
      // redelivering a payload yields the same dedupe identity, which is only true if it comes
      // from the payload.
      dedupeKey: String(update.update_id),
      raw: update,
    };
  };

  const toEvent = (update: FakeUpdate): ChannelEvent | null => {
    switch (update.type) {
      case 'edit':
        return {
          type: 'message_edited',
          chat: chatRef(update),
          platformMessageId: update.message_id,
          editedAt: update.at,
          text: update.text,
        };
      case 'delete':
        return {
          type: 'message_deleted',
          chat: chatRef(update),
          platformMessageIds: update.message_ids,
          deletedAt: update.at,
        };
      case 'membership':
        return {
          type: 'bot_membership',
          chat: chatRef(update),
          chatKind: update.chat.kind,
          status: update.status,
          ...(update.by === undefined ? {} : { byPlatformUserId: update.by }),
          ...(update.start_payload === undefined ? {} : { startPayload: update.start_payload }),
        };
      case 'member':
        return {
          type: update.joined ? 'member_joined' : 'member_left',
          chat: chatRef(update),
          platformUserId: update.platform_user_id,
          ...(update.name === undefined ? {} : { displayName: update.name }),
        };
      case 'dm_blocked':
        return {
          type: update.blocked ? 'dm_blocked' : 'dm_unblocked',
          channel: required().channel,
          platformUserId: update.platform_user_id,
        };
      // The four message-shaped kinds become envelopes, not events. Named rather than left to a
      // `default`, because `switch-exhaustiveness-check` is right to want them: a new update kind
      // should fail to compile here rather than fall silently into "not an event".
      case 'message':
      case 'callback':
      case 'reaction':
      case 'poll_vote':
        return null;
    }
  };

  /** An interaction update becomes an envelope with no text, which is what `06` §3.7 step 3 says. */
  const toInteractionEnvelope = (
    update: Extract<FakeUpdate, { type: 'callback' | 'reaction' | 'poll_vote' }>,
  ): InboundEnvelope => {
    const base = {
      channel: required().channel,
      platformChatId: update.chat.id,
      chatKind: update.chat.kind,
      platformUserId: update.from.id,
      platformUserDisplayName: update.from.name,
      senderKind: senderKindOf(update.from),
      sentAt: update.at,
      text: '',
      mentionsBot: false,
      attachments: [],
      raw: update,
    };
    if (update.type === 'callback') {
      return {
        ...base,
        platformMessageId: update.on_message_id,
        interaction: { kind: 'button', payload: { token: update.data } },
        dedupeKey: update.callback_id,
      };
    }
    if (update.type === 'reaction') {
      return {
        ...base,
        platformMessageId: update.on_message_id,
        interaction: {
          kind: 'reaction',
          payload: {
            targetPlatformMessageId: update.on_message_id,
            emoji: update.emoji,
            action: update.removed === true ? 'removed' : 'added',
          },
        },
        dedupeKey: String(update.update_id),
      };
    }
    return {
      ...base,
      platformMessageId: update.poll_id,
      interaction: {
        kind: 'poll_vote',
        payload: {
          platformPollId: update.poll_id,
          mode: 'replace',
          optionIndexes: update.option_ids,
        },
      },
      dedupeKey: String(update.update_id),
    };
  };

  /**
   * Handle one update.
   *
   * The echo filter is the first thing, and `06` C04's reason is `08` PSC-9's S4 gate: a bot's own
   * message must not cause a model call. The ack order is the second — ingest, then the platform —
   * because a platform acked first is a message it will never redeliver and Village never stored.
   */
  const handle = async (update: FakeUpdate): Promise<void> => {
    if (!running) return;
    if ('from' in update && update.from.id === fake.selfId) return;
    const context = required();
    if (update.type === 'callback') {
      // `06` §3.7 step 2: ack immediately, before the ingest. The press is the one event where the
      // platform's window is shorter than the turn, and Telegram rejects a second answer.
      await call('ackCallback', { callback_id: update.callback_id });
    }
    // Switched on the discriminant rather than on `toEvent(…) !== null`, which reads more directly
    // and is the only form TypeScript can narrow: an `else` after a null check knows nothing about
    // which members of the union are left.
    switch (update.type) {
      case 'message':
        await context.ingest(toEnvelope(update));
        break;
      case 'callback':
      case 'reaction':
      case 'poll_vote':
        await context.ingest(toInteractionEnvelope(update));
        break;
      case 'edit':
      case 'delete':
      case 'membership':
      case 'member':
      case 'dm_blocked': {
        const event = toEvent(update);
        if (event !== null) await context.ingestEvent(event);
        break;
      }
    }
    await call('ackUpdate', { update_id: update.update_id });
  };

  /** One attempt at one part: the limiter, then the call. */
  const attemptPart = async (
    msg: OutboundMessage,
    index: number,
    payload: unknown,
  ): Promise<SentPart> => {
    await limiter?.acquire(
      [bucketKeys.global, bucketKeys.chat(msg.target.platformChatId)],
      1,
      msg.priority,
    );
    const response = (await call('sendMessage', {
      chat: msg.target.platformChatId,
      idempotencyKey: `${msg.idempotencyKey}:${String(index)}`,
      payload,
    })) as { message_id: string; at: string };
    return { index, platformMessageId: response.message_id, sentAt: response.at };
  };

  /**
   * How long to wait before trying again, or `null` to give up and throw.
   *
   * `planRetry` is written for the **dispatcher** (`M3-T27`), which owns the outbox row and can
   * change its target. An adapter cannot, which is why `chat_migrated` is terminal here: `06` §3.15
   * retries it "immediately on new id", and the new id is in the error rather than in `msg.target`.
   * Retrying against the *old* id happened to succeed against a one-shot fake and would loop
   * against a real platform — found by C17, which saw a send resolve where it expected an error.
   */
  const delayFor = (
    failure: ChannelError,
    attempts: number,
  ): { readonly delayMs: number; readonly counts: boolean } | null => {
    if (failure.kind === 'chat_migrated') return null;
    const plan = planRetry(
      failure.kind,
      { attempts },
      required().rng,
      failure.details.retryAfterMs,
    );
    return plan.action === 'retry' ? { delayMs: plan.delayMs, counts: plan.countsAsAttempt } : null;
  };

  /** Send one part, with `06` §3.14's retry policy around it. */
  const sendPart = async (
    msg: OutboundMessage,
    index: number,
    payload: unknown,
  ): Promise<SentPart> => {
    let attempts = 0;
    for (;;) {
      try {
        return await attemptPart(msg, index, payload);
      } catch (error) {
        const failure = toChannelError(error);
        const retry = delayFor(failure, attempts);
        if (retry === null) throw failure;
        if (retry.counts) attempts += 1;
        if (retry.delayMs > 0) await sleep(required(), retry.delayMs);
      }
    }
  };

  const adapter: ChannelAdapter = {
    id: 'simulator',
    capabilities,

    async start(context) {
      if (running) return;
      ctx = context;
      stopped = false;
      limiter = new RateLimiter({
        channel: context.channel,
        clock: context.clock,
        timers: context.timers,
        specFor: (key) => (key === bucketKeys.global ? GLOBAL_BUCKET : CHAT_BUCKET),
      });
      typing = new TypingManager({
        channel: context.channel,
        capabilities,
        clock: context.clock,
        timers: context.timers,
        setTyping: (chat, on) =>
          call('setTyping', { chat: chat.platformChatId, on }).then(() => {}),
        logger: context.logger,
      });
      fake.onUpdate(handle);
      running = true;
      context.health.report('healthy');
      context.logger.info('channel.connected');
      return Promise.resolve();
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      running = false;
      await typing?.stopAll();
      limiter?.close();
      ctx?.health.report('stopped');
      ctx?.logger.info('channel.disconnected');
    },

    async send(msg) {
      const context = required();
      const parts = splitAndRender(msg.body, {
        context: {
          mentions: msg.mentions,
          self: await adapter.describeSelf(),
          linkPreview: msg.linkPreview ?? false,
          locale: 'en',
        },
        capabilities,
        truncationNotice: '… (truncated)',
      });
      const already = new Set((msg.resume?.partsSent ?? []).map((part) => part.index));
      const sent: SentPart[] = [...(msg.resume?.partsSent ?? [])];
      for (const [index, part] of parts.entries()) {
        // C13: a resume sends only what is missing. The parts already landed are carried through
        // unchanged, so the receipt describes the whole message rather than the second attempt.
        if (already.has(index)) continue;
        const part_ = await sendPart(msg, index, part.payload);
        context.sendProgress.record(msg.idempotencyKey, part_);
        sent.push(part_);
      }
      await typing?.stop(msg.target);
      return { parts: sent.toSorted((a, b) => a.index - b.index), fellBackToPlain: false };
    },

    async edit(ref, msg) {
      await call('editMessage', {
        chat: ref.platformChatId,
        message_id: ref.platformMessageId,
        idempotencyKey: msg.idempotencyKey,
      });
    },

    async delete(ref) {
      await call('deleteMessage', {
        chat: ref.platformChatId,
        message_id: ref.platformMessageId,
      });
    },

    async react(ref, emoji) {
      await call('react', { chat: ref.platformChatId, message_id: ref.platformMessageId, emoji });
    },

    async unreact(ref, emoji) {
      await call('unreact', { chat: ref.platformChatId, message_id: ref.platformMessageId, emoji });
    },

    async createPoll(spec: PollSpec): Promise<PlatformPollRef> {
      const response = (await call('createPoll', {
        chat: spec.target.platformChatId,
        question: spec.question,
        options: spec.options,
        multiSelect: spec.multiSelect,
        anonymous: spec.anonymous,
        idempotencyKey: spec.idempotencyKey,
      })) as { id: string };
      return {
        channel: required().channel,
        platformChatId: spec.target.platformChatId,
        platformMessageId: response.id,
        platformPollId: response.id,
      };
    },

    async closePoll(ref): Promise<PollFinalTally | null> {
      const response = (await call('closePoll', { poll_id: ref.platformPollId })) as {
        counts?: readonly number[];
        totalVoters?: number;
      };
      // `06` §3.8: `null` when the platform reports no final counts. Declared through
      // `deliveryVerification`-adjacent capability text rather than guessed, and C10 checks that
      // what comes back matches what the profile claims.
      return response.counts === undefined
        ? null
        : { counts: [...response.counts], totalVoters: response.totalVoters ?? 0 };
    },

    async setTyping(chat, on) {
      if (on) typing?.start(chat);
      else await typing?.stop(chat);
    },

    fetchAttachment(ref: AttachmentRef, opts) {
      const fileId = (ref.data as { file_id?: string }).file_id ?? '';
      const bytes = fake.fileBytes(fileId);
      if (bytes.length > opts.maxBytes) {
        // Refused before a byte is read, which is the point of `06` §12-4's `opts`: a fetch with no
        // ceiling is how a 2 GB "voice note" fills a host's disk.
        return Promise.reject(
          new ChannelError('bad_request', `the attachment is ${String(bytes.length)} bytes`, {
            platformCode: 'too_large',
          }),
        );
      }
      return Promise.resolve(
        new ReadableStream<Uint8Array>({
          start(controller) {
            opts.signal.throwIfAborted();
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      );
    },

    listMembers(chat): Promise<MemberListing> {
      return Promise.resolve({
        members: fake.members(chat.platformChatId).map((member) => ({
          platformUserId: member.id,
          displayName: member.name,
          ...(member.username === undefined ? {} : { username: member.username }),
          isBot: member.is_bot === true,
        })),
        completeness: 'exact',
      });
    },

    describeSelf(): Promise<SelfInfo> {
      return Promise.resolve({
        platformUserId: fake.selfId,
        username: `${BRAND.slug}_test_bot`,
        displayName: BRAND.botDefaultName,
        flags: { canReadAllGroupMessages: false },
      });
    },

    probe(chat): Promise<ChatProbe> {
      const diagnostics: Diagnostic[] = [];
      if (!fake.canSend(chat.platformChatId)) {
        diagnostics.push({ code: 'channels.cannot_post', severity: 'blocking' });
      }
      if (
        capabilities.readsAllGroupMessages === 'requires-setup' &&
        !fake.isAdmin(chat.platformChatId)
      ) {
        diagnostics.push({ code: 'channels.privacy_mode', severity: 'degraded' });
      }
      return Promise.resolve({
        canSend: fake.canSend(chat.platformChatId),
        readsAll: fake.isAdmin(chat.platformChatId),
        isAdmin: fake.isAdmin(chat.platformChatId),
        diagnostics,
      });
    },

    verifyDelivery(
      target,
      idempotencyKey,
      partIndex,
    ): Promise<'delivered' | 'not_found' | 'unknown'> {
      const key = `${idempotencyKey}:${String(partIndex)}`;
      return Promise.resolve(
        fake.sent(target.platformChatId).some((sent) => sent.idempotencyKey === key)
          ? 'delivered'
          : 'not_found',
      );
    },

    async answerInteraction(interactionId, reply) {
      await call('answerCallback', { interaction_id: interactionId, text: reply.text });
    },

    permalink(ref: PlatformMessageRef): string | null {
      return `https://fake.invalid/${ref.platformChatId}/${ref.platformMessageId}`;
    },
  };

  return adapter;
}

/** The reply pair, which `06` C03 checks together: an id with no `replyToIsBot` is half an answer. */
function replyFields(update: Extract<FakeUpdate, { type: 'message' }>): Partial<InboundEnvelope> {
  if (update.reply_to === undefined) return {};
  return {
    replyToPlatformMessageId: update.reply_to.message_id,
    replyToIsBot: update.reply_to.from_is_bot === true,
  };
}

/** `06` §3.3's `userHints`, omitted entirely rather than present and empty. */
function hintFields(update: Extract<FakeUpdate, { type: 'message' }>): Partial<InboundEnvelope> {
  if (update.locale === undefined && update.timezone === undefined) return {};
  return {
    userHints: {
      ...(update.locale === undefined ? {} : { locale: update.locale }),
      ...(update.timezone === undefined ? {} : { timezone: update.timezone }),
    },
  };
}

function commandInteraction(name: string): Partial<InboundEnvelope> {
  return { interaction: { kind: 'command', payload: { name, args: '', source: 'slash' } } };
}

/** `06` §3.3's sender classes, from the fake's flags. */
function senderKindOf(from: {
  readonly is_bot?: boolean;
  readonly anonymous?: boolean;
  readonly channel?: boolean;
}): InboundEnvelope['senderKind'] {
  if (from.is_bot === true) return 'bot';
  if (from.anonymous === true) return 'anonymous_admin';
  if (from.channel === true) return 'channel';
  return 'user';
}

/** A delay on the injected timers, so a retry is observable in virtual time. */
function sleep(context: AdapterContext, ms: number): Promise<void> {
  return new Promise((resolve) => {
    context.timers.setTimeout(() => {
      resolve();
    }, ms);
  });
}
