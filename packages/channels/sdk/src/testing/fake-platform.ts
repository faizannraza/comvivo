/**
 * The reference fake platform (`06` §3.25; `M3-T9`).
 *
 * `06` §3.25 asks each adapter to bring its own fake — an HTTP server speaking the Bot API, a mock
 * gateway WebSocket, a fake homeserver. This is the one the **kit itself** runs against, and it has
 * a job none of those have: proving that the 24 cases are tests rather than descriptions. A case
 * that no implementation has ever satisfied is a sentence, and a kit of 24 sentences is worth
 * nothing to the first adapter that runs it.
 *
 * So the pair in this directory is a miniature correct adapter and the platform it talks to. It is
 * also the thing `M3-T32` reads before writing the Telegram one: every case that fails there will
 * have passed here, which turns "the kit is wrong" into a claim somebody has to argue.
 *
 * ## Why the wire shape is not the envelope
 *
 * The fake's updates are deliberately *unlike* `InboundEnvelope` — snake_case, a nested `chat`, a
 * separate `entities` array, times as strings. If the fake spoke envelopes the adapter's `ingest`
 * path would be a copy, and C01 to C05 would be testing the fixture loader. The translation has to
 * be real work for the cases that check it to mean anything.
 *
 * It is not any *particular* platform's shape either, and that is the other half of the design: a
 * fake that looked like Telegram would quietly bake Telegram's assumptions into the kit, and the
 * first Matrix adapter would find the cases unrunnable.
 */
import type { VirtualClock } from '@comvivo/shared/testing';
import type { AttachmentKind } from '../contract.js';
import type { CallMatcher, FakePlatformControl, RecordedCall } from './harness.js';
import { matches } from './harness.js';

/** A chat on the fake platform. */
export interface FakeChat {
  readonly id: string;
  readonly kind: 'group' | 'dm';
  readonly title?: string;
  readonly thread?: string;
}

export interface FakeSender {
  readonly id: string;
  readonly name: string;
  readonly username?: string;
  readonly is_bot?: boolean;
  /** An admin posting as the group, which `06` §3.3 maps to `senderKind: 'anonymous_admin'`. */
  readonly anonymous?: boolean;
  /** A linked channel's automatic forward, `senderKind: 'channel'`. */
  readonly channel?: boolean;
}

export interface FakeFile {
  readonly file_id: string;
  readonly kind: AttachmentKind;
  readonly bytes: number;
  readonly mime?: string;
  readonly name?: string;
  readonly voice?: boolean;
}

/** The fake's wire format. One union, because a platform delivers one stream. */
export type FakeUpdate =
  | {
      readonly type: 'message';
      readonly update_id: number;
      readonly chat: FakeChat;
      readonly from: FakeSender;
      readonly message_id: string;
      readonly at: string;
      readonly text?: string;
      readonly entities?: readonly {
        readonly type: 'bot_mention' | 'command';
        readonly value: string;
      }[];
      readonly reply_to?: { readonly message_id: string; readonly from_is_bot?: boolean };
      readonly forward_from?: string;
      readonly files?: readonly FakeFile[];
      readonly locale?: string;
      readonly timezone?: string;
      readonly late?: boolean;
    }
  | {
      readonly type: 'callback';
      readonly update_id: number;
      readonly chat: FakeChat;
      readonly from: FakeSender;
      readonly callback_id: string;
      readonly on_message_id: string;
      readonly data: string;
      readonly at: string;
    }
  | {
      readonly type: 'reaction';
      readonly update_id: number;
      readonly chat: FakeChat;
      readonly from: FakeSender;
      readonly on_message_id: string;
      readonly emoji: string;
      readonly removed?: boolean;
      readonly at: string;
    }
  | {
      readonly type: 'poll_vote';
      readonly update_id: number;
      readonly chat: FakeChat;
      readonly from: FakeSender;
      readonly poll_id: string;
      readonly option_ids: readonly number[];
      readonly at: string;
    }
  | {
      readonly type: 'edit';
      readonly update_id: number;
      readonly chat: FakeChat;
      readonly message_id: string;
      readonly text: string;
      readonly at: string;
    }
  | {
      readonly type: 'delete';
      readonly update_id: number;
      readonly chat: FakeChat;
      readonly message_ids: readonly string[];
      readonly at: string;
    }
  | {
      readonly type: 'membership';
      readonly update_id: number;
      readonly chat: FakeChat;
      readonly status: 'added' | 'removed' | 'banned' | 'promoted' | 'demoted' | 'restricted';
      readonly by?: string;
      readonly start_payload?: string;
      readonly at: string;
    }
  | {
      readonly type: 'member';
      readonly update_id: number;
      readonly chat: FakeChat;
      readonly platform_user_id: string;
      readonly name?: string;
      readonly joined: boolean;
      readonly at: string;
    }
  | {
      readonly type: 'dm_blocked';
      readonly update_id: number;
      readonly platform_user_id: string;
      readonly blocked: boolean;
      readonly at: string;
    };

/** An armed failure, with however many shots are left. */
interface ArmedFailure {
  readonly match: CallMatcher;
  readonly response: unknown;
  remaining: number;
}

export interface FakePlatform extends FakePlatformControl {
  /** The bot's own identity, so the adapter can report `describeSelf` and filter its own echoes. */
  readonly selfId: string;
  /** Subscribed by the adapter in `start`. */
  onUpdate(listener: (update: FakeUpdate) => Promise<void>): void;
  /** Called by the adapter for every platform API call. Throws when a failure is armed. */
  call(method: string, args: unknown): Promise<unknown>;
  /** Whether the connection is currently down. */
  readonly connected: boolean;
  /** Whether the credentials have been revoked. */
  readonly authorised: boolean;
  /** Messages the adapter has sent, by chat, so C14 can look for a duplicate. */
  sent(chat: string): readonly { readonly id: string; readonly idempotencyKey: string }[];
  /** Synthetic bytes for an attachment, so C19 has something to stream. */
  fileBytes(fileId: string): Uint8Array;
  /** Members of a chat, for `listMembers`. */
  members(chat: string): readonly FakeSender[];
  setMembers(chat: string, members: readonly FakeSender[]): void;
  /** Whether the bot can post in a chat, for `probe` and C24. */
  setCanSend(chat: string, canSend: boolean): void;
  canSend(chat: string): boolean;
  /** Whether the bot is an admin there, which `readsAllGroupMessages: 'requires-setup'` needs. */
  setAdmin(chat: string, admin: boolean): void;
  isAdmin(chat: string): boolean;
}

export interface FakePlatformOptions {
  readonly clock: VirtualClock;
  readonly seed: number;
  readonly selfId?: string;
  /**
   * Called for every platform API call, synchronously, before it is answered.
   *
   * C05 is an assertion about the **order** of two acks — the platform's and the ingest's — and only
   * one of them is visible from each side. The hook lets the kit put both into one trace rather
   * than comparing two timestamps that are equal in virtual time.
   */
  onCall?: (call: RecordedCall) => void;
}

/**
 * Build one.
 *
 * Every timestamp is taken from the injected clock, and `seed` drives the synthetic message ids, so
 * a conformance run is reproducible to the byte. That matters more here than in most fakes: a case
 * that fails once in forty runs on an adapter somebody else wrote is a bug report nobody can act
 * on.
 */
export function createFakePlatform(options: FakePlatformOptions): FakePlatform {
  const { clock } = options;
  const startedAt = clock.now().epochMilliseconds;
  const selfId = options.selfId ?? 'bot-self';
  const calls: RecordedCall[] = [];
  const armed: ArmedFailure[] = [];
  const listeners: ((update: FakeUpdate) => Promise<void>)[] = [];
  const sentByChat = new Map<string, { id: string; idempotencyKey: string }[]>();
  const memberList = new Map<string, readonly FakeSender[]>();
  const sendable = new Map<string, boolean>();
  const admin = new Map<string, boolean>();
  let nextId = options.seed;
  let connectedUntil: number | null = null;
  let authorised = true;

  const now = (): number => clock.now().epochMilliseconds - startedAt;
  const isConnected = (): boolean =>
    connectedUntil === null || clock.now().epochMilliseconds >= connectedUntil;

  /**
   * Accept a send, **idempotently**.
   *
   * A resend under the same key returns the first message rather than creating a second, which is
   * what `deliveryVerification: 'native-idempotent'` claims and what C14 checks an adapter relies
   * on instead of guessing. Extracted from `call` because that function was over the cognitive
   * complexity ceiling, and this is the half with a rule in it.
   */
  const send = (detail: { chat: string; idempotencyKey: string }): unknown => {
    const list = sentByChat.get(detail.chat) ?? [];
    const already = list.find((sent) => sent.idempotencyKey === detail.idempotencyKey);
    if (already !== undefined) return { message_id: already.id, at: clock.now().toString() };
    nextId += 1;
    const id = `m${String(nextId)}`;
    list.push({ id, idempotencyKey: detail.idempotencyKey });
    sentByChat.set(detail.chat, list);
    return { message_id: id, at: clock.now().toString() };
  };

  /**
   * Throw if this call cannot succeed.
   *
   * The four refusals in the order a real platform applies them: revoked credentials before
   * anything, then a dead connection, then whatever a case armed, then the chat's own permissions.
   * Extracted from `call` because that function was over the cognitive-complexity ceiling, and this
   * is the half with the rules in it.
   */
  const refuse = (entry: RecordedCall): void => {
    if (!authorised) throw new FakePlatformError('auth_revoked', 'the credentials were revoked');
    if (!isConnected()) throw new FakePlatformError('transient', 'the connection is down');
    const at = armed.findIndex((failure) => matches(failure.match, entry));
    const failure = at === -1 ? undefined : armed[at];
    if (failure !== undefined) {
      failure.remaining -= 1;
      if (failure.remaining <= 0) armed.splice(at, 1);
      throw asPlatformError(failure.response);
    }
    if (entry.method === 'sendMessage' || entry.method === 'editMessage') {
      const detail = entry.args as { chat: string };
      if (sendable.get(detail.chat) === false) {
        throw new FakePlatformError('permission_missing', 'the bot cannot post in that chat');
      }
    }
  };

  const platform: FakePlatform = {
    selfId,
    get connected() {
      return isConnected();
    },
    get authorised() {
      return authorised;
    },

    onUpdate(listener) {
      listeners.push(listener);
    },

    async deliver(fixtureOrRaw) {
      // A string is a fixture path the kit has already loaded into `raw`; the harness resolves it
      // before calling, so by here it is always a payload. Kept in the signature because `06`
      // §3.25 types it that way and an adapter's own fake may resolve paths itself.
      if (typeof fixtureOrRaw === 'string') {
        throw new TypeError(
          `the reference fake takes a payload, not a path (${fixtureOrRaw}); the kit resolves ` +
            'fixtures before delivering them',
        );
      }
      if (!isConnected()) return;
      const update = fixtureOrRaw as FakeUpdate;
      for (const listener of listeners) await listener(update);
    },

    outbound: () => [...calls],

    failNext(match, response, times = 1) {
      armed.push({ match, response, remaining: times });
    },

    // Not `async`: nothing here awaits, and `require-await` is right that an `async` wrapper around
    // synchronous work is a promise nobody needed. The signature stays `Promise<unknown>` because
    // the adapter's call site is `await`ing a platform, and a real one is asynchronous.
    call(method, args) {
      const entry: RecordedCall = { method, args, atMs: now() };
      calls.push(entry);
      options.onCall?.(entry);
      try {
        refuse(entry);
      } catch (error) {
        // Rejected rather than thrown: `call` hands back a promise, and a synchronous throw would
        // escape an adapter that only wrote `.catch()`.
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      if (method === 'sendMessage') {
        return Promise.resolve(send(args as { chat: string; idempotencyKey: string }));
      }
      nextId += 1;
      return Promise.resolve({ ok: true, id: `r${String(nextId)}` });
    },

    async kickBot(chat) {
      nextId += 1;
      await platform.deliver({
        type: 'membership',
        update_id: nextId,
        chat: { id: chat, kind: 'group' },
        status: 'removed',
        at: clock.now().toString(),
      });
    },

    migrate(chat, to) {
      // Delivered as a call failure rather than an update, which is how the platforms that do this
      // actually behave: the first send to the old id fails and carries the new one.
      armed.push({
        match: (call) => (call.args as { chat?: string }).chat === chat,
        response: new FakePlatformError('chat_migrated', 'the chat was upgraded', { to }),
        remaining: Number.POSITIVE_INFINITY,
      });
      return Promise.resolve();
    },

    revokeAuth() {
      authorised = false;
    },

    disconnect(ms) {
      connectedUntil = clock.now().epochMilliseconds + ms;
    },

    sent: (chat) => [...(sentByChat.get(chat) ?? [])],
    delivered: (chat) => (sentByChat.get(chat) ?? []).map((entry) => entry.id),
    setChatState(chat, state) {
      if (state.canSend !== undefined) sendable.set(chat, state.canSend);
      if (state.isAdmin !== undefined) admin.set(chat, state.isAdmin);
    },

    fileBytes(fileId) {
      // Deterministic from the id, so C19 can assert the *bytes* rather than only the length — a
      // stream that returned the right number of wrong bytes is a bug a length check misses.
      const out = new Uint8Array(sizeOf(fileId));
      for (let at = 0; at < out.length; at += 1) {
        out[at] = (fileId.charCodeAt(at % fileId.length) + at) % 256;
      }
      return out;
    },

    members: (chat) => memberList.get(chat) ?? [],
    setMembers(chat, members) {
      memberList.set(chat, members);
    },
    setCanSend(chat, canSend) {
      sendable.set(chat, canSend);
    },
    canSend: (chat) => sendable.get(chat) ?? true,
    setAdmin(chat, value) {
      admin.set(chat, value);
    },
    isAdmin: (chat) => admin.get(chat) ?? false,
  };
  return platform;
}

/** A file's size, encoded in its id so a case can ask for one over the cap without a registry. */
function sizeOf(fileId: string): number {
  const match = /-(\d+)b$/.exec(fileId);
  return match === null ? 32 : Math.min(Number(match[1]), 8 * 1024 * 1024);
}

/**
 * Turn an error fixture into something the adapter's mapping can read.
 *
 * `06` §3.25 types `failNext(match, response)`'s second argument as "a fixture or raw payload", and
 * an `errors/*.json` fixture's `response` is the platform's own error body — `{kind, retryAfterMs}`
 * for this fake. The first version threw every non-`Error` response as `bad_request` with the body
 * stringified into the message, which made **every** error fixture map to `bad_request`: C11 looked
 * like a failing adapter and was a failing fake.
 */
function asPlatformError(response: unknown): Error {
  if (response instanceof Error) return response;
  if (typeof response === 'object' && response !== null && 'kind' in response) {
    const { kind, message, ...detail } = response as {
      kind: unknown;
      message?: unknown;
      [key: string]: unknown;
    };
    return new FakePlatformError(
      String(kind),
      typeof message === 'string' ? message : String(kind),
      detail,
    );
  }
  return new FakePlatformError('bad_request', JSON.stringify(response));
}

/**
 * What the fake throws.
 *
 * Carries a `kind` from `06` §3.15's taxonomy, so the adapter's error mapping has something to map
 * *from*. A real platform returns a code and a string and the adapter decides; the fake skips the
 * platform half, because C11 is about the adapter's table and not about parsing one platform's
 * error envelope — that part belongs to each adapter's own fixtures.
 */
export class FakePlatformError extends Error {
  override readonly name = 'FakePlatformError';
  constructor(
    readonly kind: string,
    message: string,
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}
