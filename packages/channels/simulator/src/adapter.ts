/**
 * The simulator adapter (`06` §3.21.7, §4.1; `M3-T11`).
 *
 * A real `ChannelAdapter` over a platform that only exists in memory. It uses the **real**
 * capability profile and the **real** renderer for whichever platform it is emulating, which is the
 * whole claim `11` §3.2.6 makes for it: "a test sees exactly what a Telegram user would see". That
 * covers the HTML string, the split boundaries and the button fallbacks, because none of those are
 * re-implemented here — `splitAndRender`, `layoutActionRows` and `renderChoiceFallback` are the
 * same functions Telegram's adapter will call at `M3-T32`.
 *
 * ## What it does not do
 *
 * It does not reach the network, the filesystem or a real clock, and a lint rule in this package
 * enforces that rather than trusting it (`06` §3.21.7: "no real timers are used"). The rate limiter
 * and the typing manager are the SDK's own, driven by the injected `Timers`, so a scenario can run
 * a simulated month in milliseconds and still see the cadence a member would.
 *
 * ## The clock is checked, not assumed
 *
 * `start` refuses a context whose `clock` is not the object the platform was built with. Two clocks
 * in a deterministic run is nondeterminism that reports itself as a flaky scenario three days
 * later: the platform timestamps a message from one and the adapter schedules a refresh from the
 * other, and nothing is wrong until the two drift. An identity check is exact, costs nothing, and
 * fails at `start` with a sentence naming the problem. `M3-T17`'s host hands every adapter the same
 * clock, and the simulator is refused in production anyway.
 */
import {
  type AdapterContext,
  bucketKeys,
  type ChannelAdapter,
  ChannelError,
  type ChannelEvent,
  type ChatProbe,
  type Diagnostic,
  type InboundAttachment,
  type InboundEnvelope,
  type MemberListing,
  type OutboundMessage,
  type PlatformChatRef,
  type PlatformMember,
  type PlatformMessageRef,
  type PlatformPollRef,
  type PollFinalTally,
  type PollSpec,
  planRetry,
  RateLimiter,
  type SelfInfo,
  type SentPart,
  splitAndRender,
  TypingManager,
} from '@comvivo/channel-sdk';
import type { Clock, Rng, Timers } from '@comvivo/shared';
import { type SimPlatform, SimPlatformError } from './platform.js';
import type { SimCall, SimUpdate } from './wire.js';

/** What the adapter needs beyond its platform. */
export interface SimulatorAdapterOptions {
  readonly platform: SimPlatform;
  /** The same object the platform was built with; `start` checks it. */
  readonly clock: Clock;
  readonly timers: Timers;
  /**
   * `06` §3.5.4's truncation notice, rendered.
   *
   * Required, with no default. `splitAndRender` needs the string and `CLAUDE.md` §2 keeps bot copy
   * in versioned template files — so a default here would be an English sentence shipped inside a
   * package, invisible to every translator and to `copy:check`. The composition root can reach the
   * copy service (`packages/engine/copy/channels/en.yaml`, `M3-T18`); this package cannot.
   */
  readonly truncationNotice: string;
  /** The bucket the global rate limit uses, if a scenario wants one tighter than the default. */
  readonly rateLimit?: { readonly capacity: number; readonly refillPerSecond: number };
}

const DEFAULT_BUCKET = { capacity: 30, refillPerSecond: 30, costPerOp: 1 } as const;

/**
 * Build the adapter.
 *
 * Exported separately from {@link createSimulator} so a test can pair one platform with a second
 * adapter — which is what `06` §3.25's C15 does when it restarts an adapter against the same
 * platform and the same context.
 */
export function createSimulatorAdapter(options: SimulatorAdapterOptions): ChannelAdapter {
  const { platform } = options;
  const capabilities = platform.capabilities;
  let ctx: AdapterContext | undefined;
  let limiter: RateLimiter | undefined;
  let typing: TypingManager | undefined;
  let running = false;
  let subscribed = false;

  const required = (): AdapterContext => {
    if (ctx === undefined) throw new ChannelError('bad_request', 'the adapter is not started');
    return ctx;
  };

  /**
   * One platform call, with the two kinds of failure that end the adapter rather than the call.
   *
   * `06` §3.15: `auth_revoked` makes the adapter "report health `auth_failed` and loops stop", and
   * `instance_conflict` is the same shape — another process holds the credentials, and retrying is
   * two processes fighting over one bot. Reported here rather than inside `send` so the other paths
   * are covered too: a revoked token is as likely to be discovered by a reaction or a typing
   * refresh, and a host whose banner depends on which call ran first has no banner.
   */
  const call = (method: SimCall, args: unknown): Promise<unknown> =>
    platform.call(method, args).catch((error: unknown) => {
      const failure = toChannelError(error);
      if (failure.kind === 'auth_revoked' || failure.kind === 'instance_conflict') {
        running = false;
        ctx?.health.report('auth_failed', { reason: failure.kind });
      }
      throw failure;
    });

  // ---------------------------------------------------------------- inbound

  const selfInfo = (): SelfInfo => ({
    platformUserId: platform.selfId,
    displayName: platform.selfName,
    flags: {
      canReadAllGroupMessages:
        capabilities.readsAllGroupMessages === 'yes' || !platform.privacyMode,
      canJoinGroups: true,
      botPublic: false,
    },
  });

  const handle = async (update: SimUpdate): Promise<void> => {
    // A stopped adapter is deaf, and the listener outlives it: the platform holds the reference and
    // has no way to drop it. Without this line a `stop` leaves a path into an engine that has
    // already shut its stores — found by C15, which delivers one message after the stop.
    if (!running || ctx === undefined) return;
    const context = ctx;
    if (update.type === 'message') {
      // `08` PSC-9's S4 gate. The bot's own message is the first one it sees after sending, and two
      // bots in one group otherwise talk to each other at a provider's prices.
      if (update.from.id === platform.selfId) return;
      await context.ingest(toEnvelope(update, context.channel, platform.selfId));
    } else if (update.type === 'callback') {
      // `06` §3.7 step 2: the ack is first, before the ingest, because the platform's window for it
      // is shorter than the turn and Telegram refuses a second answer.
      await call('ackCallback', { callback_id: update.callback_id });
      await context.ingest(toEnvelope(update, context.channel, platform.selfId));
    } else if (update.type === 'reaction' || update.type === 'poll_vote') {
      await context.ingest(toEnvelope(update, context.channel, platform.selfId));
    } else {
      const event = toEvent(update, context.channel);
      if (event !== null) await context.ingestEvent(event);
    }
    // Last, always. A crash between the ingest and this line makes the platform redeliver, which is
    // a duplicate the dedupe key absorbs; a crash the other way round loses the message for good.
    await call('ackUpdate', { update_id: update.update_id });
  };

  // ---------------------------------------------------------------- outbound

  const attemptPart = async (
    msg: OutboundMessage,
    index: number,
    part: { readonly payload: unknown; readonly plainText: string },
  ): Promise<SentPart> => {
    await limiter?.acquire(
      [bucketKeys.global, bucketKeys.chat(msg.target.platformChatId)],
      1,
      msg.priority,
    );
    const response = (await call('sendMessage', {
      chat: msg.target.platformChatId,
      idempotencyKey: `${msg.idempotencyKey}:${String(index)}`,
      payload: part.payload,
      plainText: part.plainText,
    })) as { message_id: string; at: string; deduped: boolean };
    return { index, platformMessageId: response.message_id, sentAt: response.at };
  };

  /**
   * How long to wait before trying again, or `null` to give up and throw.
   *
   * `chat_migrated` is terminal **here** even though `06` §3.15 says "retry immediately on new id":
   * the new id is in the error and an adapter cannot change `msg.target`, which belongs to the
   * outbox row. Retrying against the old id would loop against a real platform.
   */
  const delayFor = (
    failure: ChannelError,
    attempts: number,
    rng: Rng,
  ): { readonly delayMs: number; readonly counts: boolean } | null => {
    if (failure.kind === 'chat_migrated') return null;
    const plan = planRetry(failure.kind, { attempts }, rng, failure.details.retryAfterMs);
    return plan.action === 'retry' ? { delayMs: plan.delayMs, counts: plan.countsAsAttempt } : null;
  };

  /**
   * Mark a part that may be a second copy of itself.
   *
   * `06` §3.13: a part re-sent after an ambiguous failure is a possible duplicate on a profile with
   * no idempotency, and the receipt has to say so — the dispatcher's own I6 test allows at most one
   * such part per message. On a platform that deduplicates there is nothing to declare.
   */
  const markIfDuplicate = (sent: SentPart, afterAmbiguous: boolean): SentPart =>
    afterAmbiguous && platform.idempotencyClass === 'none'
      ? { ...sent, possibleDuplicate: true }
      : sent;

  const sendPart = async (
    msg: OutboundMessage,
    index: number,
    part: { readonly payload: unknown; readonly plainText: string },
  ): Promise<SentPart> => {
    const context = required();
    const state = { attempts: 0, ambiguous: false };
    for (;;) {
      try {
        return markIfDuplicate(await attemptPart(msg, index, part), state.ambiguous);
      } catch (error) {
        await waitOrThrow(error, state, context.rng);
      }
    }
  };

  /**
   * Decide what a failed attempt means, and wait if it is worth another.
   *
   * Extracted from the loop above, which was over the cognitive-complexity ceiling. The split is
   * also the honest one: the loop's job is "keep trying", and this function's is the policy about
   * when that stops.
   */
  const waitOrThrow = async (
    error: unknown,
    state: { attempts: number; ambiguous: boolean },
    rng: Rng,
  ): Promise<void> => {
    const failure = toChannelError(error);
    if (failure.kind === 'ambiguous') state.ambiguous = true;
    const retry = delayFor(failure, state.attempts, rng);
    if (retry === null) throw failure;
    if (retry.counts) state.attempts += 1;
    if (retry.delayMs > 0) await sleep(options.timers, retry.delayMs);
  };

  const adapter: ChannelAdapter = {
    id: 'simulator',
    capabilities,

    // `async`, not a synchronous `throw` with a `Promise` return type. `06` §4.1 types `start`
    // as `Promise<void>`, so a host writing `adapter.start(ctx).catch(report)` would have a
    // synchronous throw escape past its own error handling and take the boot down — which is
    // how the refusal below, written to be helpful, would become the least helpful failure in
    // the process. Found by the test for it.
    async start(context) {
      if (running) return;
      if (context.clock !== options.clock) {
        throw new ChannelError(
          'bad_request',
          'the simulator was built with a different clock than the one in its AdapterContext. ' +
            'Two clocks in a deterministic run drift, and the symptom is a scenario that fails ' +
            'once in forty runs rather than an error here.',
        );
      }
      ctx = context;
      limiter = new RateLimiter({
        channel: context.channel,
        clock: context.clock,
        timers: context.timers,
        specFor: () => ({ ...DEFAULT_BUCKET, ...options.rateLimit }),
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
      if (!subscribed) {
        // Subscribed once for the adapter's whole life, not once per `start`. The platform has no
        // way to drop a listener, so a restart would attach a second one and ingest every message
        // twice — a duplicate the dedupe key would absorb and nothing would report.
        platform.onUpdate(handle);
        subscribed = true;
      }
      running = true;
      context.health.report('healthy');
      context.logger.info('channel.connected');
      await Promise.resolve();
    },

    async stop() {
      if (!running) return;
      running = false;
      await typing?.stopAll();
      limiter?.close();
      ctx?.health.report('stopped');
      ctx?.logger.info('channel.disconnected');
    },

    async send(msg) {
      const parts = splitAndRender(msg.body, {
        context: {
          mentions: msg.mentions,
          self: selfInfo(),
          linkPreview: msg.linkPreview ?? false,
          locale: 'en',
        },
        capabilities,
        truncationNotice: options.truncationNotice,
      });
      const already = new Set((msg.resume?.partsSent ?? []).map((part) => part.index));
      const sent: SentPart[] = [...(msg.resume?.partsSent ?? [])];
      for (const [index, part] of parts.entries()) {
        if (already.has(index)) continue;
        const one = await sendPart(msg, index, part);
        required().sendProgress.record(msg.idempotencyKey, one);
        sent.push(one);
      }
      await typing?.stop(msg.target);
      return { parts: sent.toSorted((a, b) => a.index - b.index), fellBackToPlain: false };
    },

    ...(capabilities.edits
      ? {
          async edit(ref: PlatformMessageRef, msg: OutboundMessage) {
            const [first] = splitAndRender(msg.body, {
              context: {
                mentions: msg.mentions,
                self: selfInfo(),
                linkPreview: msg.linkPreview ?? false,
                locale: 'en',
              },
              capabilities,
              truncationNotice: options.truncationNotice,
            });
            await call('editMessage', {
              chat: ref.platformChatId,
              message_id: ref.platformMessageId,
              text: first?.plainText ?? '',
            });
          },
        }
      : {}),

    ...(capabilities.deletes
      ? {
          async delete(ref: PlatformMessageRef) {
            await call('deleteMessage', {
              chat: ref.platformChatId,
              message_id: ref.platformMessageId,
            });
          },
        }
      : {}),

    ...(capabilities.reactions
      ? {
          async react(ref: PlatformMessageRef, emoji: string) {
            await call('react', {
              chat: ref.platformChatId,
              message_id: ref.platformMessageId,
              emoji,
            });
          },
          async unreact(ref: PlatformMessageRef, emoji: string) {
            await call('unreact', {
              chat: ref.platformChatId,
              message_id: ref.platformMessageId,
              emoji,
            });
          },
        }
      : {}),

    ...(capabilities.nativePolls
      ? {
          async createPoll(spec: PollSpec): Promise<PlatformPollRef> {
            const response = (await call('createPoll', {
              chat: spec.target.platformChatId,
              question: spec.question,
              options: spec.options,
              multiSelect: spec.multiSelect,
              idempotencyKey: spec.idempotencyKey,
            })) as { poll_id: string; message_id: string };
            return {
              channel: 'simulator',
              platformChatId: spec.target.platformChatId,
              platformMessageId: response.message_id,
              platformPollId: response.poll_id,
            };
          },
          async closePoll(ref: PlatformPollRef): Promise<PollFinalTally | null> {
            const tally = (await call('closePoll', {
              chat: ref.platformChatId,
              poll_id: ref.platformPollId,
            })) as { counts: number[]; total_voters: number } | null;
            return tally === null
              ? null
              : { counts: tally.counts, totalVoters: tally.total_voters };
          },
        }
      : {}),

    ...(capabilities.typingIndicator
      ? {
          setTyping(chat: PlatformChatRef, on: boolean): Promise<void> {
            return on
              ? (typing?.start(chat) ?? Promise.resolve())
              : (typing?.stop(chat) ?? Promise.resolve());
          },
        }
      : {}),

    async fetchAttachment(ref, opts) {
      const fileId = String((ref.data as { file_id?: unknown }).file_id);
      const response = (await call('getFile', { file_id: fileId })) as { bytes: Uint8Array };
      if (response.bytes.length > opts.maxBytes) {
        throw new ChannelError(
          'bad_request',
          `the attachment is ${String(response.bytes.length)} bytes against a ${String(opts.maxBytes)} cap`,
        );
      }
      const bytes = response.bytes;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },

    ...(capabilities.memberListing === 'none'
      ? {}
      : {
          async listMembers(chat: PlatformChatRef): Promise<MemberListing> {
            await call('listMembers', { chat: chat.platformChatId });
            const members = platform.members(chat.platformChatId).map(
              (member): PlatformMember => ({
                platformUserId: member.id,
                displayName: member.name,
                ...(member.username === undefined ? {} : { username: member.username }),
                isBot: member.isBot,
                isAdmin: false,
              }),
            );
            return {
              members,
              completeness: capabilities.memberListing === 'exact' ? 'exact' : 'partial',
              totalCount: members.length,
            };
          },
        }),

    describeSelf(): Promise<SelfInfo> {
      return Promise.resolve(selfInfo());
    },

    describeUser(platformUserId) {
      for (const chatId of platform.chats()) {
        const found = platform.members(chatId).find((member) => member.id === platformUserId);
        if (found !== undefined) {
          return Promise.resolve({
            platformUserId: found.id,
            displayName: found.name,
            ...(found.username === undefined ? {} : { username: found.username }),
            isBot: found.isBot,
          });
        }
      }
      return Promise.reject(new ChannelError('not_found', 'no such user'));
    },

    async probe(chat): Promise<ChatProbe> {
      await call('probe', { chat: chat.platformChatId });
      return buildProbe(platform, chat.platformChatId);
    },

    ...(capabilities.dmInitiation === 'none'
      ? {}
      : {
          async openDm(platformUserId: string): Promise<{ platformChatId: string }> {
            const chatId = `dm:${platformUserId}`;
            await call('openDm', { user: platformUserId });
            platform.chat(chatId, 'dm');
            return { platformChatId: chatId };
          },
        }),

    dmLink: (payload) => `sim://dm?start=${payload}`,
    addToGroupLink: (payload) => `sim://addgroup?start=${payload}`,

    async leave(chat) {
      await call('leave', { chat: chat.platformChatId });
      platform.setChatState(chat.platformChatId, { canSend: false });
    },

    ...(capabilities.deliveryVerification === 'none'
      ? {}
      : {
          async verifyDelivery(target: PlatformChatRef, idempotencyKey: string, partIndex: number) {
            return (await call('verifyDelivery', {
              chat: target.platformChatId,
              idempotencyKey: `${idempotencyKey}:${String(partIndex)}`,
            })) as 'delivered' | 'not_found' | 'unknown';
          },
        }),

    ...(capabilities.buttons
      ? {
          async answerInteraction(interactionId: string, reply: { text: string; alert?: boolean }) {
            await call('answerInteraction', { callback_id: interactionId, text: reply.text });
          },
        }
      : {}),

    permalink: (ref) => `sim://${ref.platformChatId}/${ref.platformMessageId}`,
  };
  return adapter;
}

function sleep(timers: Timers, ms: number): Promise<void> {
  return new Promise((resolve) => {
    timers.setTimeout(() => {
      resolve();
    }, ms);
  });
}

/** `06` §3.20.3's facts, from the platform's state. The diagnostics are the adapter's reading. */
function buildProbe(platform: SimPlatform, chatId: string): ChatProbe {
  const canSend = platform.canSend(chatId);
  const readsAll = platform.readsAll(chatId);
  const diagnostics: Diagnostic[] = [];
  if (!canSend) diagnostics.push({ code: 'channel.cannot_post', severity: 'blocking' });
  if (!readsAll) {
    diagnostics.push({ code: 'channel.privacy_mode_on', severity: 'degraded' });
  }
  return {
    canSend,
    readsAll,
    isAdmin: platform.isAdmin(chatId),
    memberCount: platform.members(chatId).length,
    diagnostics,
  };
}

/**
 * Map a platform failure onto `06` §3.15's taxonomy.
 *
 * A `ChannelError` passes through unchanged — the adapter raises some of its own, and re-wrapping
 * one would lose the kind that selects the recovery. Anything that is neither is `transient` rather
 * than `bad_request`: an unrecognised throw from a platform is far more often a socket than a bug
 * in the request, and the cost of the wrong guess is asymmetric (a retried 400 wastes one call; an
 * un-retried network blip loses a reply).
 */
export function toChannelError(error: unknown): ChannelError {
  if (error instanceof ChannelError) return error;
  if (error instanceof SimPlatformError) {
    const { kind, ...details } = error.fault;
    return new ChannelError(kind, error.message, details);
  }
  return new ChannelError('transient', error instanceof Error ? error.message : String(error));
}

// ---------------------------------------------------------------- normalisation

/**
 * Three independent booleans, one closed enum.
 *
 * `08` PSC-9's S4 gate is `senderKind === 'bot'`, so the order matters: a bot that is also posting
 * anonymously is a bot first. The other two are `06` §3.3's cases that a naive mapping drops — an
 * admin posting as the group, and a linked channel's automatic forward.
 */
function senderKind(from: {
  readonly is_bot?: boolean | undefined;
  readonly anonymous?: boolean | undefined;
  readonly channel?: boolean | undefined;
}): InboundEnvelope['senderKind'] {
  if (from.is_bot === true) return 'bot';
  if (from.anonymous === true) return 'anonymous_admin';
  if (from.channel === true) return 'channel';
  return 'user';
}

function attachmentsOf(update: Extract<SimUpdate, { type: 'message' }>): InboundAttachment[] {
  return (update.files ?? []).map((file): InboundAttachment => {
    const inline =
      file.lat !== undefined && file.lon !== undefined
        ? { lat: file.lat, lon: file.lon }
        : file.contact_name === undefined
          ? undefined
          : { contactName: file.contact_name };
    return {
      ref: { channel: 'simulator', data: { file_id: file.file_id } },
      kind: file.kind,
      ...(file.mime === undefined ? {} : { mime: file.mime }),
      ...(file.name === undefined ? {} : { name: file.name }),
      sizeBytes: file.bytes,
      isVoiceNote: file.voice === true,
      ...(inline === undefined ? {} : { inline }),
    };
  });
}

/**
 * One update, as an `InboundEnvelope`.
 *
 * The translation is real work rather than a field copy, which is the point of the wire format
 * being unlike the envelope (see `wire.ts`): snake_case to camelCase, a nested `chat` flattened, an
 * `entities` array read for the two facts the router needs, and `senderKind` decided from three
 * independent booleans.
 */
export function toEnvelope(
  update: Extract<SimUpdate, { type: 'message' | 'callback' | 'reaction' | 'poll_vote' }>,
  channel: InboundEnvelope['channel'],
  _selfId: string,
): InboundEnvelope {
  const common = {
    channel,
    platformChatId: update.chat.id,
    chatKind: update.chat.kind,
    ...(update.chat.thread === undefined ? {} : { platformThreadId: update.chat.thread }),
    platformUserId: update.from.id,
    platformUserDisplayName: update.from.name,
    ...(update.from.username === undefined ? {} : { platformUsername: update.from.username }),
    senderKind: senderKind(update.from),
    sentAt: update.at,
    attachments: [] as InboundAttachment[],
    dedupeKey: String(update.update_id),
    raw: update,
  };
  if (update.type === 'callback') {
    return {
      ...common,
      platformMessageId: update.on_message_id,
      text: '',
      mentionsBot: false,
      interaction: { kind: 'button', payload: { token: update.data } },
    };
  }
  if (update.type === 'reaction') {
    return {
      ...common,
      platformMessageId: update.on_message_id,
      text: '',
      mentionsBot: false,
      interaction: {
        kind: 'reaction',
        payload: {
          targetPlatformMessageId: update.on_message_id,
          emoji: update.emoji,
          action: update.removed === true ? 'removed' : 'added',
        },
      },
    };
  }
  if (update.type === 'poll_vote') {
    return {
      ...common,
      platformMessageId: `vote:${update.poll_id}:${update.from.id}`,
      text: '',
      mentionsBot: false,
      interaction: {
        kind: 'poll_vote',
        payload: {
          platformPollId: update.poll_id,
          mode: 'replace',
          optionIndexes: [...update.option_ids],
        },
      },
    };
  }
  return messageEnvelope(update, common);
}

type SimMessage = Extract<SimUpdate, { type: 'message' }>;

/**
 * The reply fields, when the message is one.
 *
 * `replyToIsBot` is what `05` §3.2's router reads to decide that a message is addressed to Village
 * without naming it, so it is carried as `undefined` rather than `false` when the platform did not
 * say: "not a reply to the bot" and "we do not know" are different facts.
 */
function replyFields(update: SimMessage): Partial<InboundEnvelope> {
  if (update.reply_to === undefined) return {};
  return {
    replyToPlatformMessageId: update.reply_to.message_id,
    ...(update.reply_to.from_is_bot === undefined
      ? {}
      : { replyToIsBot: update.reply_to.from_is_bot }),
  };
}

/** `06` §3.3's forward provenance, which `05` labels untrusted. */
function forwardFields(update: SimMessage): Partial<InboundEnvelope> {
  if (update.forward_from === undefined && update.forward_at === undefined) return {};
  return {
    forwarded: {
      ...(update.forward_from === undefined ? {} : { fromName: update.forward_from }),
      ...(update.forward_at === undefined ? {} : { originalSentAt: update.forward_at }),
    },
  };
}

function previewFields(update: SimMessage): Partial<InboundEnvelope> {
  if (update.link_previews === undefined) return {};
  return {
    linkPreviews: update.link_previews.map((preview) => ({
      url: preview.url,
      ...(preview.title === undefined ? {} : { title: preview.title }),
      ...(preview.description === undefined ? {} : { description: preview.description }),
    })),
  };
}

/**
 * A command, split into the name and the rest.
 *
 * The argument text is taken from after the command token in the **original** message rather than
 * re-joined from parts, because `06` §3.10's arguments are free text: a reminder's body keeps its
 * double spaces and its newlines, and a round trip through `split` would quietly normalise them.
 */
function commandFields(update: SimMessage, text: string): Partial<InboundEnvelope> {
  const command = update.entities?.find((entity) => entity.type === 'command');
  if (command === undefined) return {};
  return {
    interaction: {
      kind: 'command',
      payload: {
        name: command.value.replace(/^\//, '').split(/\s+/u)[0] ?? command.value,
        args: text.slice(text.indexOf(command.value) + command.value.length).trim(),
        source: command.source ?? 'text',
      },
    },
  };
}

function messageEnvelope(
  update: SimMessage,
  common: Omit<InboundEnvelope, 'platformMessageId' | 'text' | 'mentionsBot'>,
): InboundEnvelope {
  const text = update.text ?? '';
  return {
    ...common,
    platformMessageId: update.message_id,
    text,
    attachments: attachmentsOf(update),
    mentionsBot: update.entities?.some((entity) => entity.type === 'bot_mention') === true,
    ...(update.truncated === true ? { truncated: true } : {}),
    ...replyFields(update),
    ...forwardFields(update),
    ...(update.quoted_external === undefined ? {} : { quotedExternal: update.quoted_external }),
    ...previewFields(update),
    ...commandFields(update, text),
    ...(update.locale === undefined && update.timezone === undefined
      ? {}
      : {
          userHints: {
            ...(update.locale === undefined ? {} : { locale: update.locale }),
            ...(update.timezone === undefined ? {} : { timezone: update.timezone }),
          },
        }),
    ...(update.late === true ? { deliveredLate: true } : {}),
  };
}

/** The updates that are events rather than messages (`06` §3.3). */
export function toEvent(
  update: SimUpdate,
  channel: InboundEnvelope['channel'],
): ChannelEvent | null {
  switch (update.type) {
    case 'user_updated':
      return {
        type: 'user_updated',
        channel,
        platformUserId: update.platform_user_id,
        displayName: update.name,
        ...(update.username === undefined ? {} : { username: update.username }),
      };
    case 'dm_blocked':
      return {
        type: update.blocked ? 'dm_blocked' : 'dm_unblocked',
        channel,
        platformUserId: update.platform_user_id,
      };
    case 'message':
    case 'callback':
    case 'reaction':
    case 'poll_vote':
      // Not events. These four become `InboundEnvelope`s (`toEnvelope`), because `06` §3.3 draws
      // the line at whether a member *said* something: an envelope can start a turn and an event
      // cannot. Listed rather than left to a `default` so a fourteenth update type is a compile
      // error here, where somebody has to decide which side of that line it falls on.
      return null;
    case 'edit':
    case 'delete':
    case 'membership':
    case 'member':
    case 'chat_updated':
    case 'poll_updated':
    case 'read_marker':
      return chatEvent(update, channel);
  }
}

/** The events that belong to a chat (`06` §3.3). */
function chatEvent(
  update: Extract<
    SimUpdate,
    {
      type:
        | 'edit'
        | 'delete'
        | 'membership'
        | 'member'
        | 'chat_updated'
        | 'poll_updated'
        | 'read_marker';
    }
  >,
  channel: InboundEnvelope['channel'],
): ChannelEvent {
  const chat = (): PlatformChatRef => ({
    channel,
    platformChatId: update.chat.id,
    ...(update.chat.thread === undefined ? {} : { platformThreadId: update.chat.thread }),
  });
  switch (update.type) {
    case 'edit':
      return {
        type: 'message_edited',
        chat: chat(),
        platformMessageId: update.message_id,
        editedAt: update.at,
        text: update.text,
      };
    case 'delete':
      return {
        type: 'message_deleted',
        chat: chat(),
        platformMessageIds: [...update.message_ids],
        deletedAt: update.at,
      };
    case 'membership':
      return {
        type: 'bot_membership',
        chat: chat(),
        chatKind: update.chat.kind,
        status: update.status,
        ...(update.by === undefined ? {} : { byPlatformUserId: update.by }),
        ...(update.start_payload === undefined ? {} : { startPayload: update.start_payload }),
      };
    case 'member':
      return {
        type: update.joined ? 'member_joined' : 'member_left',
        chat: chat(),
        platformUserId: update.platform_user_id,
        ...(update.name === undefined ? {} : { displayName: update.name }),
      };
    case 'chat_updated':
      return {
        type: 'chat_updated' as const,
        chat: chat(),
        ...(update.chat.title === undefined ? {} : { title: update.chat.title }),
        ...(update.is_forum === undefined ? {} : { isForum: update.is_forum }),
        ...(update.encrypted === undefined ? {} : { encrypted: update.encrypted }),
        ...(update.ext_shared === undefined ? {} : { extShared: update.ext_shared }),
      };
    case 'poll_updated':
      return {
        type: 'poll_updated',
        poll: {
          ...chat(),
          platformMessageId: update.on_message_id,
          platformPollId: update.poll_id,
        },
        counts: [...update.counts],
        totalVoters: update.total_voters,
        closed: update.closed,
      };
    case 'read_marker':
      return {
        type: 'read_marker',
        chat: chat(),
        platformUserId: update.platform_user_id,
        upToPlatformMessageId: update.up_to_message_id,
        at: update.at,
      };
  }
}
