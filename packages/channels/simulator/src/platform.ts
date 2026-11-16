/**
 * The in-memory platform (`06` §3.21.7; `11` §4.8; `M3-T11`).
 *
 * Everything a chat platform does, in one object with no clock of its own and no I/O: chats,
 * members, a message store with sequential ids, reactions, polls, typing state, a delivery ledger,
 * a send-idempotency class and a fault queue. The adapter in `adapter.ts` talks to it exactly as a
 * real adapter talks to Telegram, and `control.ts` drives it as a member would.
 *
 * ## Why this is not the conformance kit's fake
 *
 * `@comvivo/channel-sdk/testing`'s `createFakePlatform` (`M3-T9`) is a smaller object of the same
 * shape, and the duplication is **structural rather than accidental**. The kit is published inside
 * `@comvivo/channel-sdk`, this package depends on that one, and dependency-cruiser's
 * `testing-subpath-only-from-tests` keeps `/testing/` out of production code — so the simulator
 * cannot import the kit's fake, and the SDK cannot import the simulator without a cycle Turborepo
 * refuses outright. Sharing would mean putting product code behind a test subpath or inverting the
 * dependency, and `CLAUDE.md` §2 says to fix the design rather than weaken the rule.
 *
 * They are also different objects doing different jobs. The kit's fake exists to prove that 24
 * cases are tests rather than sentences, and is deliberately minimal. This one is a product
 * surface: `11`'s harness runs a simulated month through it, `13`'s browser demo *is* it, and it
 * has to emulate seven capability profiles, inject every one of `06` §3.15's thirteen error kinds,
 * and keep a ledger an I6 oracle can read.
 *
 * ## The ledger
 *
 * `11` §4.8 fixes the record: `{seq, chatId, platformMessageId, fromBot, idempotencyKey?,
 * contentHash, text, rich, at, faultApplied?}`. It is the harness's view of what the group actually
 * saw, and the idempotency key travels in it — a simulator-only field — so I6 ("exactly-once
 * intent") can be checked exactly rather than inferred from message text.
 */
import type { ChannelCapabilities, ChannelErrorKind } from '@comvivo/channel-sdk';
import type { Clock, Timers } from '@comvivo/shared';
import { BRAND } from '@comvivo/shared';
import { sha256Hex } from '@comvivo/shared/crypto';
import { type SimCall, type SimUpdate, SimUpdateSchema } from './wire.js';

/**
 * How a platform answers a repeated send (`11` §3.6 S10).
 *
 * Derived from `deliveryVerification` rather than declared as a second capability field, and that
 * is the decision: `11` §3.2.6 says "profiles also carry the send-idempotency class", and a
 * separate field could disagree with the one already in the profile. One of them would then be
 * wrong and nothing would say which.
 */
export type SimIdempotencyClass = 'native' | 'dedupe-window' | 'none';

export function idempotencyClassOf(capabilities: ChannelCapabilities): SimIdempotencyClass {
  switch (capabilities.deliveryVerification) {
    case 'native-idempotent':
      return 'native';
    case 'verifiable':
      return 'dedupe-window';
    case 'none':
      return 'none';
  }
}

/**
 * How long a `dedupe-window` platform remembers a key.
 *
 * Five minutes, which is `11` §3.6 S10's own "no content duplicates within 10 minutes" oracle
 * halved: a window the oracle cannot see past would make the class indistinguishable from `native`,
 * and the point of the class is that it is weaker.
 */
export const DEDUPE_WINDOW_MS = 300_000;

/** `11` §4.8's ledger record. */
export interface SimLedgerEntry {
  readonly seq: number;
  readonly chatId: string;
  readonly platformMessageId: string;
  readonly fromBot: boolean;
  readonly idempotencyKey?: string | undefined;
  readonly contentHash: string;
  readonly text: string;
  /** The payload as the platform received it: a rendered string, Block Kit JSON, Signal's ranges. */
  readonly rich: unknown;
  readonly at: string;
  readonly faultApplied?: string | undefined;
  /** Set when this entry repeats an `idempotencyKey` the platform has already stored. */
  readonly duplicateOf?: string | undefined;
}

/** One platform call the adapter made, with the virtual time it happened at. */
export interface SimRecordedCall {
  readonly method: string;
  readonly args: unknown;
  readonly atMs: number;
}

export type SimCallMatcher = string | ((call: SimRecordedCall) => boolean);

export function callMatches(matcher: SimCallMatcher, call: SimRecordedCall): boolean {
  return typeof matcher === 'string' ? call.method === matcher : matcher(call);
}

/**
 * A fault to inject.
 *
 * `kind` is one of `06` §3.15's thirteen, which is what `M3-T11`'s acceptance criterion asks for:
 * every kind reachable, because the engine's recovery is selected on the kind and a kind nothing
 * can produce is a recovery nothing has tested.
 *
 * `ambiguous` is a **modifier**, not the kind of the same name. `11` §3.6 S10's "ambiguous success"
 * is the platform accepting the message and the connection dropping before the response — so the
 * effect lands *and* the caller sees an error. Setting it on any kind produces that, and the
 * `ambiguous` kind on its own is the error a dispatcher classifies without the effect having
 * necessarily landed.
 */
export interface SimFault {
  readonly kind: ChannelErrorKind;
  readonly retryAfterMs?: number;
  readonly ambiguous?: boolean;
  readonly newPlatformChatId?: string;
  readonly permission?: string;
  readonly platformCode?: string | number;
}

/** What the platform throws. The adapter maps it to a `ChannelError`. */
export class SimPlatformError extends Error {
  override readonly name = 'SimPlatformError';
  constructor(
    readonly fault: SimFault,
    message: string,
  ) {
    super(message);
  }
}

interface ArmedFault {
  readonly match: SimCallMatcher;
  readonly fault: SimFault;
  remaining: number;
}

interface StoredMessage {
  readonly id: string;
  readonly chatId: string;
  readonly fromBot: boolean;
  readonly idempotencyKey?: string | undefined;
  readonly atMs: number;
  text: string;
  deleted: boolean;
  readonly reactions: Map<string, Set<string>>;
}

interface StoredChat {
  readonly id: string;
  readonly kind: 'group' | 'dm';
  title?: string;
  canSend: boolean;
  botPresent: boolean;
  botAdmin: boolean;
  isForum: boolean;
  encrypted: boolean;
  extShared: boolean;
  nextMessage: number;
  migratedTo?: string;
  readonly members: Map<string, { name: string; username?: string; isBot: boolean }>;
}

interface StoredPoll {
  readonly id: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly options: readonly string[];
  readonly multiSelect: boolean;
  closed: boolean;
  /** Voter id → the option indexes they chose. One entry per voter, so a revote replaces. */
  readonly votes: Map<string, readonly number[]>;
}

export interface SimPlatformOptions {
  readonly clock: Clock;
  readonly timers: Timers;
  readonly capabilities: ChannelCapabilities;
  readonly seed: number;
  readonly selfId?: string;
  readonly selfName?: string;
  /** Called synchronously for every platform call, before it is answered (`06` §3.25 C05). */
  readonly onCall?: (call: SimRecordedCall) => void;
  /** Called for every update the platform delivers, for the recorder. */
  readonly onDeliver?: (update: SimUpdate, atMs: number) => void;
}

/**
 * Build the platform.
 *
 * Every timestamp comes from the injected clock and every id from `seed`, so two runs of the same
 * scenario produce byte-identical ledgers. That is the whole purpose of the package (`06` §3.21.7:
 * "deterministic tests"), and it is also why nothing here reads `Date`, `Math.random` or
 * `process` — a lint rule in this package enforces it, the same one `channel-sdk` has.
 */
export class SimPlatform {
  readonly selfId: string;
  readonly selfName: string;
  readonly capabilities: ChannelCapabilities;
  readonly idempotencyClass: SimIdempotencyClass;

  readonly #clock: Clock;
  readonly #timers: Timers;
  readonly #startedAtMs: number;
  readonly #onCall: ((call: SimRecordedCall) => void) | undefined;
  readonly #onDeliver: ((update: SimUpdate, atMs: number) => void) | undefined;

  readonly #chats = new Map<string, StoredChat>();
  readonly #messages = new Map<string, StoredMessage>();
  readonly #polls = new Map<string, StoredPoll>();
  readonly #typing = new Map<string, number>();
  readonly #calls: SimRecordedCall[] = [];
  readonly #ledger: SimLedgerEntry[] = [];
  readonly #armed: ArmedFault[] = [];
  readonly #sentKeys = new Map<string, { messageId: string; atMs: number }>();
  readonly #listeners: ((update: SimUpdate) => Promise<void>)[] = [];
  readonly #inFlight = new Set<Promise<unknown>>();

  #nextUpdateId: number;
  #nextSeq = 0;
  #latencyMs = 0;
  #authorised = true;
  #connectedUntilMs: number | null = null;
  #privacyMode = false;
  #hideTally = false;

  constructor(options: SimPlatformOptions) {
    this.selfId = options.selfId ?? 'sim-bot';
    this.selfName = options.selfName ?? BRAND.botDefaultName;
    this.capabilities = options.capabilities;
    this.idempotencyClass = idempotencyClassOf(options.capabilities);
    this.#clock = options.clock;
    this.#timers = options.timers;
    this.#startedAtMs = options.clock.now().epochMilliseconds;
    this.#onCall = options.onCall;
    this.#onDeliver = options.onDeliver;
    this.#nextUpdateId = options.seed;
  }

  // ---------------------------------------------------------------- time and state

  /** Virtual milliseconds since the platform was created, which is what a case asserts on. */
  nowMs(): number {
    return this.#clock.now().epochMilliseconds - this.#startedAtMs;
  }

  nowIso(): string {
    return this.#clock.now().toString();
  }

  get authorised(): boolean {
    return this.#authorised;
  }

  get connected(): boolean {
    return (
      this.#connectedUntilMs === null ||
      this.#clock.now().epochMilliseconds >= this.#connectedUntilMs
    );
  }

  get privacyMode(): boolean {
    return this.#privacyMode;
  }

  // ---------------------------------------------------------------- chats and members

  /** The chat, created on first mention. A platform has no "register a chat" step. */
  chat(id: string, kind: 'group' | 'dm' = 'group'): StoredChat {
    const existing = this.#chats.get(id);
    if (existing !== undefined) return existing;
    const created: StoredChat = {
      id,
      kind,
      canSend: true,
      botPresent: true,
      botAdmin: false,
      isForum: false,
      encrypted: false,
      extShared: false,
      nextMessage: 0,
      members: new Map(),
    };
    this.#chats.set(id, created);
    return created;
  }

  chats(): readonly string[] {
    return [...this.#chats.keys()];
  }

  members(
    chatId: string,
  ): readonly { id: string; name: string; username?: string; isBot: boolean }[] {
    return [...this.chat(chatId).members.entries()].map(([id, member]) => ({ id, ...member }));
  }

  setMember(
    chatId: string,
    id: string,
    member: { name: string; username?: string; isBot?: boolean },
  ): void {
    const entry: { name: string; username?: string; isBot: boolean } = {
      name: member.name,
      isBot: member.isBot ?? false,
    };
    if (member.username !== undefined) entry.username = member.username;
    this.chat(chatId).members.set(id, entry);
  }

  removeMember(chatId: string, id: string): void {
    this.chat(chatId).members.delete(id);
  }

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
  ): void {
    const chat = this.chat(chatId);
    if (state.canSend !== undefined) chat.canSend = state.canSend;
    if (state.isAdmin !== undefined) chat.botAdmin = state.isAdmin;
    if (state.title !== undefined) chat.title = state.title;
    if (state.isForum !== undefined) chat.isForum = state.isForum;
    if (state.encrypted !== undefined) chat.encrypted = state.encrypted;
    if (state.extShared !== undefined) chat.extShared = state.extShared;
  }

  canSend(chatId: string): boolean {
    const chat = this.chat(chatId);
    return chat.canSend && chat.botPresent;
  }

  isAdmin(chatId: string): boolean {
    return this.chat(chatId).botAdmin;
  }

  /**
   * Whether the bot sees every message in this chat.
   *
   * `readsAllGroupMessages: 'requires-setup'` is Telegram's privacy mode, and the two ways out of
   * it are admin rights or the mode being off — which is exactly what `06` §3.23.1 tells a host.
   */
  readsAll(chatId: string): boolean {
    if (this.capabilities.readsAllGroupMessages === 'yes') return true;
    return !this.#privacyMode || this.isAdmin(chatId);
  }

  setPrivacyMode(on: boolean): void {
    this.#privacyMode = on;
  }

  /** Make `closePoll` answer `null`, which `06` §3.8 allows and nothing else can produce. */
  setPollTallyHidden(on: boolean): void {
    this.#hideTally = on;
  }

  // ---------------------------------------------------------------- messages

  /**
   * Claim the next message id in a chat.
   *
   * Public because an **inbound** message needs one too: the control surface decides a member's
   * message id before the platform ever sees the update, since a scenario needs the id back to
   * reply to it. The counter was briefly incremented in both places, which is the shape of bug that
   * does nothing for a while and then hands a bot message an id a member's message already has —
   * so there is one owner, and `#applyMessage` keeps it ahead of an id that arrived from outside
   * (a replay carries ids this process never issued).
   */
  reserveMessageId(chatId: string, kind: 'group' | 'dm' = 'group'): string {
    const chat = this.chat(chatId, kind);
    chat.nextMessage += 1;
    return `m${String(chat.nextMessage)}`;
  }

  /** Store a message and return its id. Ids are sequential **per chat** (`06` §3.21.7). */
  #store(detail: {
    chatId: string;
    fromBot: boolean;
    text: string;
    idempotencyKey?: string | undefined;
  }): StoredMessage {
    const id = this.reserveMessageId(detail.chatId);
    const message: StoredMessage = {
      id,
      chatId: detail.chatId,
      fromBot: detail.fromBot,
      idempotencyKey: detail.idempotencyKey,
      atMs: this.nowMs(),
      text: detail.text,
      deleted: false,
      reactions: new Map(),
    };
    this.#messages.set(`${detail.chatId}/${id}`, message);
    return message;
  }

  message(chatId: string, messageId: string): StoredMessage | undefined {
    return this.#messages.get(`${chatId}/${messageId}`);
  }

  /** The message ids that exist in a chat, which is what C14 asks for. */
  delivered(chatId: string): readonly string[] {
    return [...this.#messages.values()]
      .filter((message) => message.chatId === chatId && message.fromBot && !message.deleted)
      .map((message) => message.id);
  }

  ledger(): readonly SimLedgerEntry[] {
    return [...this.#ledger];
  }

  #record(entry: Omit<SimLedgerEntry, 'seq'>): SimLedgerEntry {
    const full: SimLedgerEntry = { seq: this.#nextSeq, ...entry };
    this.#nextSeq += 1;
    this.#ledger.push(full);
    return full;
  }

  // ---------------------------------------------------------------- inbound

  onUpdate(listener: (update: SimUpdate) => Promise<void>): void {
    this.#listeners.push(listener);
  }

  /**
   * Deliver one update to the adapter.
   *
   * Validated with zod on the way in rather than trusted: `control.replay` feeds updates from a
   * recording written by an older build, and the shape it recorded is not something a type can
   * check at the point it is read back.
   */
  async deliver(update: unknown): Promise<void> {
    const parsed = SimUpdateSchema.parse(update);
    if (!this.connected) return;
    if (!this.#visible(parsed)) return;
    this.#applyInbound(parsed);
    this.#onDeliver?.(parsed, this.nowMs());
    const work = (async () => {
      for (const listener of this.#listeners) await listener(parsed);
    })();
    this.#inFlight.add(work);
    try {
      await work;
    } finally {
      this.#inFlight.delete(work);
    }
  }

  /**
   * Whether the platform shows this update to the bot at all.
   *
   * Privacy mode is the one filter a platform applies on the bot's behalf, and it is the reason
   * `06` §3.23.1 step 3 exists: a non-admin bot in a privacy-mode group sees only messages that
   * name it or reply to it. A simulator that always delivered everything would make the whole
   * "requires-setup" branch of `readsAllGroupMessages` untestable, including `06` §3.20.3's
   * diagnostic for it.
   */
  #visible(update: SimUpdate): boolean {
    if (update.type !== 'message') return true;
    if (update.chat.kind === 'dm') return true;
    if (this.readsAll(update.chat.id)) return true;
    const named = update.entities?.some((entity) => entity.type === 'bot_mention') === true;
    const commanded = update.entities?.some((entity) => entity.type === 'command') === true;
    return named || commanded || update.reply_to?.from_is_bot === true;
  }

  /** A member's message exists on the platform, so a reply or a reaction can target it. */
  /**
   * Apply an inbound update to the platform's own state.
   *
   * A real platform does this before the bot ever hears about it: a vote moves the tally, an edit
   * changes the message, a join adds a member. The simulator has to as well, or a scenario reads
   * back a platform that forgot what it just announced — which C10 found, by creating a poll,
   * voting through `deliver` and closing it to a tally of zero.
   *
   * Dispatched through a table rather than a chain of `if`s so the whole set stays under the
   * cognitive-complexity ceiling, and so an update type with no state to change is visibly absent
   * rather than falling off the end of a switch.
   */
  #applyInbound(update: SimUpdate): void {
    switch (update.type) {
      case 'poll_vote':
        this.#applyVote(update);
        return;
      case 'reaction':
        this.#applyReaction(update);
        return;
      case 'edit':
        this.#applyEdit(update);
        return;
      case 'delete':
        this.#applyDelete(update);
        return;
      case 'member':
        this.#applyMember(update);
        return;
      case 'message':
        this.#applyMessage(update);
        return;
      case 'callback':
      case 'membership':
      case 'user_updated':
      case 'chat_updated':
      case 'poll_updated':
      case 'read_marker':
      case 'dm_blocked':
        // Announcements whose state the control verb has already set, or which the platform does
        // not model: a read marker is a fact about a member's client, not about the chat. Listed
        // rather than left to a `default` so a fourteenth update type has to be classified here.
        return;
    }
  }

  #applyVote(update: Extract<SimUpdate, { type: 'poll_vote' }>): void {
    const poll = this.#polls.get(update.poll_id);
    if (poll === undefined || poll.closed) return;
    poll.votes.set(
      update.from.id,
      poll.multiSelect ? [...update.option_ids] : update.option_ids.slice(0, 1),
    );
  }

  #applyReaction(update: Extract<SimUpdate, { type: 'reaction' }>): void {
    const target = this.message(update.chat.id, update.on_message_id);
    if (target === undefined) return;
    const by = target.reactions.get(update.emoji) ?? new Set<string>();
    if (update.removed === true) by.delete(update.from.id);
    else by.add(update.from.id);
    target.reactions.set(update.emoji, by);
  }

  #applyEdit(update: Extract<SimUpdate, { type: 'edit' }>): void {
    const target = this.message(update.chat.id, update.message_id);
    if (target !== undefined) target.text = update.text;
  }

  #applyDelete(update: Extract<SimUpdate, { type: 'delete' }>): void {
    for (const id of update.message_ids) {
      const target = this.message(update.chat.id, id);
      if (target !== undefined) target.deleted = true;
    }
  }

  #applyMember(update: Extract<SimUpdate, { type: 'member' }>): void {
    if (update.joined) {
      this.setMember(update.chat.id, update.platform_user_id, {
        name: update.name ?? update.platform_user_id,
      });
    } else this.removeMember(update.chat.id, update.platform_user_id);
  }

  #applyMessage(update: Extract<SimUpdate, { type: 'message' }>): void {
    const chat = this.chat(update.chat.id, update.chat.kind);
    // Keep the counter ahead of an id that came from outside this process: a replayed recording
    // carries `m7` into a chat whose counter is at zero, and the next bot send would reuse it.
    const arrived = /^m(\d+)$/.exec(update.message_id);
    if (arrived?.[1] !== undefined) {
      chat.nextMessage = Math.max(chat.nextMessage, Number(arrived[1]));
    }
    const message: StoredMessage = {
      id: update.message_id,
      chatId: update.chat.id,
      fromBot: update.from.is_bot === true,
      atMs: this.nowMs(),
      text: update.text ?? '',
      deleted: false,
      reactions: new Map(),
    };
    this.#messages.set(`${update.chat.id}/${update.message_id}`, message);
    if (!chat.members.has(update.from.id)) {
      this.setMember(update.chat.id, update.from.id, {
        name: update.from.name,
        ...(update.from.username === undefined ? {} : { username: update.from.username }),
        isBot: update.from.is_bot === true,
      });
    }
    this.#record({
      chatId: update.chat.id,
      platformMessageId: update.message_id,
      fromBot: message.fromBot,
      contentHash: sha256Hex(update.text ?? ''),
      text: update.text ?? '',
      rich: null,
      at: update.at,
    });
  }

  /** The next update id, so a caller never has to track one. */
  nextUpdateId(): number {
    this.#nextUpdateId += 1;
    return this.#nextUpdateId;
  }

  // ---------------------------------------------------------------- faults

  /** Arm a fault, in the conformance kit's shape: a matcher and a response body. */
  failNext(match: SimCallMatcher, response: unknown, times = 1): void {
    this.#armed.push({ match, fault: asFault(response), remaining: times });
  }

  /** Arm a fault, in `06` §3.21.7's shape. */
  armFault(fault: SimFault, match: SimCallMatcher = 'sendMessage', times = 1): void {
    this.#armed.push({ match, fault: validateFault(fault), remaining: times });
  }

  clearFaults(): void {
    this.#armed.length = 0;
  }

  setLatency(ms: number): void {
    this.#latencyMs = Math.max(0, ms);
  }

  revokeAuth(): void {
    this.#authorised = false;
  }

  restoreAuth(): void {
    this.#authorised = true;
  }

  disconnect(ms: number): void {
    this.#connectedUntilMs = this.#clock.now().epochMilliseconds + ms;
  }

  // ---------------------------------------------------------------- outbound

  outbound(): readonly SimRecordedCall[] {
    return [...this.#calls];
  }

  /**
   * One platform API call.
   *
   * The order of the refusals is the order a real platform applies them, and it matters: revoked
   * credentials before anything (a dead token fails every call, including the ones a case armed), a
   * dropped connection next, then whatever a scenario armed, and the chat's own permissions last —
   * because a scenario that arms `rate_limited` on a chat the bot cannot post in is asking about
   * the rate limit.
   */
  async call(method: SimCall, args: unknown): Promise<unknown> {
    const entry: SimRecordedCall = { method, args, atMs: this.nowMs() };
    this.#calls.push(entry);
    this.#onCall?.(entry);
    if (this.#latencyMs > 0) await this.#sleep(this.#latencyMs);
    const fault = this.#refuse(entry);
    if (fault !== null) {
      // An ambiguous success lands the effect and then fails, which is `11` §3.6 S10's hardest
      // case: the caller cannot know whether to resend, and on a `none` profile resending is a
      // duplicate nobody can prevent.
      if (fault.ambiguous === true) this.#apply(method, args, fault.kind);
      throw new SimPlatformError(fault, `the platform answered ${fault.kind}`);
    }
    return this.#apply(method, args, undefined);
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#timers.setTimeout(() => {
        resolve();
      }, ms);
    });
  }

  /** The fault this call should fail with, or `null` to let it through. */
  #refuse(entry: SimRecordedCall): SimFault | null {
    if (!this.#authorised) return { kind: 'auth_revoked' };
    if (!this.connected) return { kind: 'transient' };
    const at = this.#armed.findIndex((armed) => callMatches(armed.match, entry));
    const armed = at === -1 ? undefined : this.#armed[at];
    if (armed !== undefined) {
      armed.remaining -= 1;
      if (armed.remaining <= 0) this.#armed.splice(at, 1);
      return armed.fault;
    }
    return this.#refuseByState(entry);
  }

  /** The refusals that come from the chat rather than from a scenario. */
  #refuseByState(entry: SimRecordedCall): SimFault | null {
    const chatId = (entry.args as { chat?: unknown }).chat;
    if (typeof chatId !== 'string') return null;
    const chat = this.#chats.get(chatId);
    if (chat?.migratedTo !== undefined) {
      return { kind: 'chat_migrated', newPlatformChatId: chat.migratedTo };
    }
    if (!WRITES.has(entry.method as SimCall)) return null;
    if (chat !== undefined && !chat.botPresent) return { kind: 'chat_access_lost' };
    if (chat !== undefined && !chat.canSend) {
      return { kind: 'permission_missing', permission: 'can_send_messages' };
    }
    return null;
  }

  /** Perform the call's effect and return what the platform answers. */
  #apply(method: SimCall, args: unknown, faultApplied: string | undefined): unknown {
    switch (method) {
      case 'sendMessage':
        return this.#send(args as SendArgs, faultApplied);
      case 'editMessage':
        return this.#edit(args as { chat: string; message_id: string; text: string });
      case 'deleteMessage':
        return this.#delete(args as { chat: string; message_id: string });
      case 'react':
      case 'unreact':
        return this.#react(method, args as ReactArgs);
      case 'createPoll':
        return this.#createPoll(args as PollArgs);
      case 'closePoll':
        return this.#closePoll(args as { chat: string; poll_id: string });
      case 'setTyping':
        return this.#setTyping(args as { chat: string; on: boolean });
      case 'getFile':
        return { bytes: fileBytes((args as { file_id: string }).file_id) };
      case 'verifyDelivery':
        return this.#verify(args as VerifyArgs);
      case 'listMembers':
      case 'probe':
      case 'openDm':
      case 'leave':
      case 'answerInteraction':
      case 'describeSelf':
      case 'describeUser':
      case 'ackUpdate':
      case 'ackCallback':
        // Recorded and acknowledged, with no state of their own. The adapter reads the answers to
        // these off the platform directly (`members`, `canSend`), because they are queries rather
        // than effects — and a query whose result travelled back through `unknown` would be cast
        // twice for nothing.
        return { ok: true };
    }
  }

  #send(args: SendArgs, faultApplied: string | undefined): SendResult {
    const known = this.#sentKeys.get(args.idempotencyKey);
    if (known !== undefined && this.#dedupes(known.atMs)) {
      return { message_id: known.messageId, at: this.nowIso(), deduped: true };
    }
    const message = this.#store({
      chatId: args.chat,
      fromBot: true,
      text: args.plainText ?? '',
      idempotencyKey: args.idempotencyKey,
    });
    this.#sentKeys.set(args.idempotencyKey, { messageId: message.id, atMs: message.atMs });
    this.#record({
      chatId: args.chat,
      platformMessageId: message.id,
      fromBot: true,
      idempotencyKey: args.idempotencyKey,
      contentHash: sha256Hex(args.plainText ?? ''),
      text: args.plainText ?? '',
      rich: args.payload,
      at: this.nowIso(),
      faultApplied,
      duplicateOf: known === undefined ? undefined : known.messageId,
    });
    return { message_id: message.id, at: this.nowIso(), deduped: false };
  }

  /** Whether a repeat of a key this platform has seen answers with the first message. */
  #dedupes(firstAtMs: number): boolean {
    switch (this.idempotencyClass) {
      case 'native':
        return true;
      case 'dedupe-window':
        return this.nowMs() - firstAtMs <= DEDUPE_WINDOW_MS;
      case 'none':
        return false;
    }
  }

  #edit(args: { chat: string; message_id: string; text: string }): { ok: true } {
    const message = this.message(args.chat, args.message_id);
    if (message === undefined || message.deleted) {
      throw new SimPlatformError({ kind: 'not_found' }, 'no such message');
    }
    message.text = args.text;
    return { ok: true };
  }

  #delete(args: { chat: string; message_id: string }): { ok: true } {
    const message = this.message(args.chat, args.message_id);
    if (message === undefined || message.deleted) {
      throw new SimPlatformError({ kind: 'not_found' }, 'no such message');
    }
    const window = this.capabilities.deleteWindowSec;
    if (window !== null && this.nowMs() - message.atMs > window * 1000) {
      throw new SimPlatformError({ kind: 'bad_request' }, 'the delete window has closed');
    }
    message.deleted = true;
    return { ok: true };
  }

  #react(method: 'react' | 'unreact', args: ReactArgs): { ok: true } {
    const message = this.message(args.chat, args.message_id);
    if (message === undefined || message.deleted) {
      throw new SimPlatformError({ kind: 'not_found' }, 'no such message');
    }
    const by = message.reactions.get(args.emoji) ?? new Set<string>();
    if (method === 'react') {
      const cap = this.capabilities.maxReactionsPerMessage;
      const mine = [...message.reactions.values()].filter((set) => set.has(this.selfId)).length;
      if (cap !== null && mine >= cap && !by.has(this.selfId)) {
        throw new SimPlatformError(
          { kind: 'bad_request' },
          `the platform allows the bot ${String(cap)} reaction(s) per message`,
        );
      }
      by.add(this.selfId);
    } else by.delete(this.selfId);
    message.reactions.set(args.emoji, by);
    return { ok: true };
  }

  reactions(chatId: string, messageId: string): Readonly<Record<string, readonly string[]>> {
    const message = this.message(chatId, messageId);
    if (message === undefined) return {};
    return Object.fromEntries(
      [...message.reactions.entries()]
        .filter(([, by]) => by.size > 0)
        .map(([emoji, by]) => [emoji, [...by]]),
    );
  }

  #createPoll(args: PollArgs): { poll_id: string; message_id: string } {
    const message = this.#store({
      chatId: args.chat,
      fromBot: true,
      text: args.question,
      idempotencyKey: args.idempotencyKey,
    });
    const id = `poll-${message.chatId}-${message.id}`;
    this.#polls.set(id, {
      id,
      chatId: args.chat,
      messageId: message.id,
      options: args.options,
      multiSelect: args.multiSelect,
      closed: false,
      votes: new Map(),
    });
    this.#record({
      chatId: args.chat,
      platformMessageId: message.id,
      fromBot: true,
      idempotencyKey: args.idempotencyKey,
      contentHash: sha256Hex(`${args.question}\n${args.options.join('\n')}`),
      text: args.question,
      rich: { poll: { question: args.question, options: args.options } },
      at: this.nowIso(),
    });
    return { poll_id: id, message_id: message.id };
  }

  #closePoll(args: { chat: string; poll_id: string }): {
    counts: number[];
    total_voters: number;
  } | null {
    const poll = this.#polls.get(args.poll_id);
    if (poll === undefined) throw new SimPlatformError({ kind: 'not_found' }, 'no such poll');
    poll.closed = true;
    return this.pollTally(args.poll_id);
  }

  poll(id: string): StoredPoll | undefined {
    return this.#polls.get(id);
  }

  pollTally(id: string): { counts: number[]; total_voters: number } | null {
    const poll = this.#polls.get(id);
    if (poll === undefined) return null;
    // `06` §3.8: a platform may report no final counts, and the adapter has to answer `null`
    // rather than zeroes. Which platforms do that is **not** derivable from a capability — Telegram
    // and Discord both return counts from their close call — so it is a scenario's choice rather
    // than a guess from `voterIdentity`, and the branch is reachable on purpose.
    if (this.#hideTally) return null;
    const counts = poll.options.map(() => 0);
    for (const chosen of poll.votes.values()) {
      for (const index of chosen) {
        const current = counts[index];
        if (current !== undefined) counts[index] = current + 1;
      }
    }
    return { counts, total_voters: poll.votes.size };
  }

  vote(pollId: string, voter: string, options: readonly number[]): void {
    const poll = this.#polls.get(pollId);
    if (poll === undefined) throw new SimPlatformError({ kind: 'not_found' }, 'no such poll');
    if (poll.closed) throw new SimPlatformError({ kind: 'bad_request' }, 'the poll is closed');
    poll.votes.set(voter, poll.multiSelect ? [...options] : options.slice(0, 1));
  }

  #setTyping(args: { chat: string; on: boolean }): { ok: true } {
    if (args.on) this.#typing.set(args.chat, this.nowMs());
    else this.#typing.delete(args.chat);
    return { ok: true };
  }

  /** Whether the bot is showing a typing indicator in a chat, and when it was last refreshed. */
  typingSince(chatId: string): number | null {
    return this.#typing.get(chatId) ?? null;
  }

  #verify(args: VerifyArgs): 'delivered' | 'not_found' | 'unknown' {
    if (this.capabilities.deliveryVerification === 'none') return 'unknown';
    const known = this.#sentKeys.get(args.idempotencyKey);
    if (known === undefined) return 'not_found';
    return 'delivered';
  }

  // ---------------------------------------------------------------- lifecycle verbs

  async addBot(
    chatId: string,
    options: { by?: string; startPayload?: string } = {},
  ): Promise<void> {
    const chat = this.chat(chatId);
    chat.botPresent = true;
    chat.canSend = true;
    await this.deliver({
      type: 'membership',
      update_id: this.nextUpdateId(),
      chat: { id: chatId, kind: chat.kind },
      status: 'added',
      ...(options.by === undefined ? {} : { by: options.by }),
      ...(options.startPayload === undefined ? {} : { start_payload: options.startPayload }),
      at: this.nowIso(),
    });
  }

  async kickBot(chatId: string): Promise<void> {
    const chat = this.chat(chatId);
    chat.botPresent = false;
    chat.canSend = false;
    await this.deliver({
      type: 'membership',
      update_id: this.nextUpdateId(),
      chat: { id: chatId, kind: chat.kind },
      status: 'removed',
      at: this.nowIso(),
    });
  }

  /**
   * Upgrade a chat's id, the way Telegram turns a group into a supergroup.
   *
   * Recorded on the chat rather than armed as a fault, because it is **permanent**: the old id
   * never works again. An armed one-shot would let a retry against the old id succeed, which is the
   * loop `06` §3.15 warns about — and `M3-T9` found exactly that, when a one-shot fake made
   * retrying the old id look correct.
   */
  migrate(chatId: string, to: string): void {
    const chat = this.chat(chatId);
    chat.migratedTo = to;
    const moved = this.chat(to, chat.kind);
    for (const [id, member] of chat.members) moved.members.set(id, member);
    moved.canSend = chat.canSend;
    moved.botAdmin = chat.botAdmin;
  }

  migratedTo(chatId: string): string | undefined {
    return this.#chats.get(chatId)?.migratedTo;
  }

  /**
   * Wait until nothing is in flight.
   *
   * Only the platform's own half of `06` §3.21.7's `flush()`: every delivered update has been
   * handed to the adapter and the adapter's `ingest` has resolved. Village's outbox is not visible
   * from here, so quiescence of the *system* is `11` §3.2.2's `settle()` and belongs to the
   * harness — see `control.ts`.
   */
  async settle(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.all([...this.#inFlight]);
  }
}

/** The calls that write to a chat, and so can be refused by its permissions. */
const WRITES: ReadonlySet<SimCall> = new Set<SimCall>([
  'sendMessage',
  'editMessage',
  'deleteMessage',
  'react',
  'unreact',
  'createPoll',
  'setTyping',
]);

interface SendArgs {
  readonly chat: string;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly plainText?: string;
}
interface SendResult {
  readonly message_id: string;
  readonly at: string;
  readonly deduped: boolean;
}
interface ReactArgs {
  readonly chat: string;
  readonly message_id: string;
  readonly emoji: string;
}
interface PollArgs {
  readonly chat: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly multiSelect: boolean;
  readonly idempotencyKey: string;
}
interface VerifyArgs {
  readonly chat: string;
  readonly idempotencyKey: string;
}

/**
 * Read a fault out of whatever a caller armed.
 *
 * `06` §3.25 types `failNext`'s second argument as "a fixture or raw payload", and an `errors/*`
 * fixture's body is the platform's own error shape — `{kind, retryAfterMs}` here. The first version
 * of the kit's equivalent threw every non-`Error` body as `bad_request`, which made **every** error
 * fixture map to one kind and turned a failing fake into what looked like a failing adapter.
 */
function asFault(response: unknown): SimFault {
  if (response instanceof SimPlatformError) return validateFault(response.fault);
  if (typeof response === 'object' && response !== null && 'kind' in response) {
    return validateFault(response as SimFault);
  }
  return { kind: 'bad_request' };
}

/**
 * Refuse a fault that describes something no platform does.
 *
 * `ambiguous: true` means the effect landed and the caller was told it failed, and `06` §3.15
 * defines exactly one kind for that: `ambiguous`, "may have been delivered". `transient` is
 * defined as a failure "**before the request was sent**", so a transient that landed is a
 * contradiction — and an adapter cannot be expected to mark its retry a possible duplicate from
 * an error that says the first attempt never happened.
 *
 * A refusal rather than a coercion, because the scenario is the thing that is wrong and a
 * silently corrected scenario measures something other than what it says. Written after a test
 * of mine armed the modifier on the wrong kind and read correct behaviour as a bug.
 */
function validateFault(fault: SimFault): SimFault {
  if (fault.ambiguous === true && fault.kind !== 'ambiguous') {
    throw new RangeError(
      `a fault cannot be \`${fault.kind}\` and ambiguous at once: 06 §3.15 defines ` +
        `\`${fault.kind}\` as a failure the request did not survive, and \`ambiguous\` as the ` +
        'one kind that may have been delivered. Arm `ambiguous` with `ambiguous: true` for an ' +
        'ambiguous success, or without it for a failure the adapter cannot classify.',
    );
  }
  return fault;
}

/**
 * Synthetic bytes for an attachment, derived from its id.
 *
 * Deterministic so a scenario can assert the *bytes* rather than only the length — a stream that
 * returned the right number of wrong bytes is a bug a length check misses. The size is encoded in
 * the id (`photo-2048b`) so a case can ask for one over the cap without a registry.
 */
export function fileBytes(fileId: string): Uint8Array {
  const match = /-(\d+)b$/.exec(fileId);
  const size = match === null ? 32 : Math.min(Number(match[1]), 8 * 1024 * 1024);
  const out = new Uint8Array(size);
  for (let at = 0; at < out.length; at += 1) {
    out[at] = (fileId.charCodeAt(at % fileId.length) + at) % 256;
  }
  return out;
}
