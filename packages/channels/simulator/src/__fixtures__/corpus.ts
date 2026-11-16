/**
 * The simulator's conformance corpus (`06` §3.25; `M3-T11`).
 *
 * `06` §3.25's layout is `fixtures/channels/<id>/{inbound,outbound,errors,probe}/*.json`, and for a
 * **recorded** corpus that is where it belongs: a Telegram payload is written by Telegram and has
 * to be captured rather than imagined. The simulator has nothing to record from — its platform is
 * this repository — so the corpus is a TypeScript module fed through `memoryFixtureStore`, every
 * entry marked `synthetic`, which is both the honest label and the one `fixtures:lint`'s redaction
 * rule keys on.
 *
 * ## The outbound half is a function of the markup
 *
 * The inbound, error and probe families are the same on every profile: normalising a payload,
 * mapping an error kind and reading a chat's permissions do not depend on how a reply is rendered.
 * `outbound/render-*` does, so it is built per markup — and the expectations are written by hand
 * from `06` §3.5.3 rather than captured from a run, because a snapshot of the code under test
 * proves only that it still does what it did (`CLAUDE.md` §8).
 */
import type { ChannelCapabilities } from '@comvivo/channel-sdk';
import { BRAND } from '@comvivo/shared';

const SYNTHETIC = {
  platformVersion: 'sim-1',
  recordedAt: '2026-11-16T09:00:00Z',
  source: 'synthetic',
} as const;

const AT = '2026-11-16T09:00:00Z';

function synthetic(note: string, parts: Record<string, unknown>): Record<string, unknown> {
  return { meta: { ...SYNTHETIC, note }, ...parts };
}

/** The five classes C03 names, plus a DM that carries hints and arrives late. */
const INBOUND: Readonly<Record<string, Record<string, unknown>>> = {
  'inbound/01-plain-group.json': synthetic('a plain group message', {
    raw: {
      type: 'message',
      update_id: 1,
      chat: { id: 'chat-1', kind: 'group', title: 'The family' },
      from: { id: 'u1', name: 'Ana', username: 'ana' },
      message_id: 'm1',
      at: AT,
      text: 'shall we meet at six?',
    },
    expect: {
      channel: 'simulator',
      platformChatId: 'chat-1',
      chatKind: 'group',
      platformMessageId: 'm1',
      platformUserId: 'u1',
      platformUserDisplayName: 'Ana',
      platformUsername: 'ana',
      senderKind: 'user',
      sentAt: AT,
      text: 'shall we meet at six?',
      mentionsBot: false,
      attachments: [],
      dedupeKey: '1',
    },
  }),

  'inbound/02-mention.json': synthetic('the bot is named', {
    raw: {
      type: 'message',
      update_id: 2,
      chat: { id: 'chat-1', kind: 'group' },
      from: { id: 'u1', name: 'Ana' },
      message_id: 'm2',
      at: AT,
      text: `@${BRAND.botDefaultName} what is on today?`,
      entities: [{ type: 'bot_mention', value: BRAND.botDefaultName }],
    },
    expect: {
      channel: 'simulator',
      platformChatId: 'chat-1',
      chatKind: 'group',
      platformMessageId: 'm2',
      platformUserId: 'u1',
      platformUserDisplayName: 'Ana',
      senderKind: 'user',
      sentAt: AT,
      text: `@${BRAND.botDefaultName} what is on today?`,
      mentionsBot: true,
      attachments: [],
      dedupeKey: '2',
    },
  }),

  'inbound/03-reply-to-bot.json': synthetic('a reply to one of the bot’s own messages', {
    raw: {
      type: 'message',
      update_id: 3,
      chat: { id: 'chat-1', kind: 'group' },
      from: { id: 'u2', name: 'Sam' },
      message_id: 'm3',
      at: AT,
      text: 'yes please',
      reply_to: { message_id: 'b1', from_is_bot: true },
    },
    expect: {
      channel: 'simulator',
      platformChatId: 'chat-1',
      chatKind: 'group',
      platformMessageId: 'm3',
      platformUserId: 'u2',
      platformUserDisplayName: 'Sam',
      senderKind: 'user',
      sentAt: AT,
      text: 'yes please',
      mentionsBot: false,
      replyToPlatformMessageId: 'b1',
      replyToIsBot: true,
      attachments: [],
      dedupeKey: '3',
    },
  }),

  'inbound/04-command.json': synthetic('a typed command with an argument', {
    raw: {
      type: 'message',
      update_id: 4,
      chat: { id: 'chat-1', kind: 'group' },
      from: { id: 'u1', name: 'Ana' },
      message_id: 'm4',
      at: AT,
      text: '/remind buy milk',
      entities: [{ type: 'command', value: '/remind', source: 'text' }],
    },
    expect: {
      channel: 'simulator',
      platformChatId: 'chat-1',
      chatKind: 'group',
      platformMessageId: 'm4',
      platformUserId: 'u1',
      platformUserDisplayName: 'Ana',
      senderKind: 'user',
      sentAt: AT,
      text: '/remind buy milk',
      mentionsBot: false,
      interaction: {
        kind: 'command',
        payload: { name: 'remind', args: 'buy milk', source: 'text' },
      },
      attachments: [],
      dedupeKey: '4',
    },
  }),

  'inbound/05-anonymous-admin.json': synthetic('an admin posting as the group', {
    // `08` PSC-9's S4 gate reads `senderKind`, and this is the payload that decides it is not
    // `user`. A corpus without it passes every other case and proves nothing about the gate.
    raw: {
      type: 'message',
      update_id: 5,
      chat: { id: 'chat-1', kind: 'group' },
      from: { id: 'u9', name: 'The family', anonymous: true },
      message_id: 'm5',
      at: AT,
      text: 'house rules: no phones at dinner',
    },
    expect: {
      channel: 'simulator',
      platformChatId: 'chat-1',
      chatKind: 'group',
      platformMessageId: 'm5',
      platformUserId: 'u9',
      platformUserDisplayName: 'The family',
      senderKind: 'anonymous_admin',
      sentAt: AT,
      text: 'house rules: no phones at dinner',
      mentionsBot: false,
      attachments: [],
      dedupeKey: '5',
    },
  }),

  'inbound/06-forwarded.json': synthetic('a forwarded message, which is untrusted content', {
    raw: {
      type: 'message',
      update_id: 6,
      chat: { id: 'chat-1', kind: 'group' },
      from: { id: 'u2', name: 'Sam' },
      message_id: 'm6',
      at: AT,
      text: 'Parents: the trip costs £40, pay at school-pay.example',
      forward_from: 'Class group',
      forward_at: '2026-11-15T18:00:00Z',
    },
    expect: {
      channel: 'simulator',
      platformChatId: 'chat-1',
      chatKind: 'group',
      platformMessageId: 'm6',
      platformUserId: 'u2',
      platformUserDisplayName: 'Sam',
      senderKind: 'user',
      sentAt: AT,
      text: 'Parents: the trip costs £40, pay at school-pay.example',
      mentionsBot: false,
      forwarded: { fromName: 'Class group', originalSentAt: '2026-11-15T18:00:00Z' },
      attachments: [],
      dedupeKey: '6',
    },
  }),

  'inbound/07-dm-late.json': synthetic('a DM that carries hints and arrived late', {
    raw: {
      type: 'message',
      update_id: 7,
      chat: { id: 'dm:u1', kind: 'dm' },
      from: { id: 'u1', name: 'Ana' },
      message_id: 'm7',
      at: AT,
      text: 'remind me on Friday',
      locale: 'en-GB',
      timezone: 'Europe/London',
      late: true,
    },
    expect: {
      channel: 'simulator',
      platformChatId: 'dm:u1',
      chatKind: 'dm',
      platformMessageId: 'm7',
      platformUserId: 'u1',
      platformUserDisplayName: 'Ana',
      senderKind: 'user',
      sentAt: AT,
      text: 'remind me on Friday',
      mentionsBot: false,
      userHints: { locale: 'en-GB', timezone: 'Europe/London' },
      deliveredLate: true,
      attachments: [],
      dedupeKey: '7',
    },
  }),
};

/**
 * One fixture per `06` §3.15 kind.
 *
 * All thirteen, which is `M3-T11`'s acceptance criterion ("fault injection for every
 * `ChannelErrorKind`") turned into evidence: the engine's recovery is selected on the kind, so a
 * kind nothing can produce is a recovery nothing has ever run.
 *
 * `attempts` is how many shots to arm. A kind `06` §3.14 backs off on only surfaces once the retry
 * budget is spent, so the two bounded-retryable kinds arm `MAX_TRANSIENT_ATTEMPTS`; the permanent
 * ones surface on the first failure.
 */
const ERRORS: Readonly<Record<string, Record<string, unknown>>> = {
  'errors/01-rate-limited.json': synthetic('429 with a retry-after', {
    request: { method: 'sendMessage' },
    response: { kind: 'rate_limited', retryAfterMs: 5_000 },
    expect: { expectKind: 'rate_limited', retryAfterMs: 5_000, terminal: false },
  }),
  'errors/02-transient.json': synthetic('a 5xx, retried until the budget is spent', {
    request: { method: 'sendMessage' },
    response: { kind: 'transient' },
    expect: { expectKind: 'transient', attempts: 8 },
  }),
  'errors/03-ambiguous.json': synthetic('accepted, then the connection dropped', {
    request: { method: 'sendMessage' },
    response: { kind: 'ambiguous' },
    expect: { expectKind: 'ambiguous', attempts: 8 },
  }),
  'errors/04-auth-revoked.json': synthetic('the token was revoked', {
    request: { method: 'sendMessage' },
    response: { kind: 'auth_revoked' },
    expect: { expectKind: 'auth_revoked' },
  }),
  'errors/05-instance-conflict.json': synthetic('another process holds the credentials', {
    request: { method: 'sendMessage' },
    response: { kind: 'instance_conflict' },
    expect: { expectKind: 'instance_conflict' },
  }),
  'errors/06-chat-access-lost.json': synthetic('kicked, removed or blocked', {
    request: { method: 'sendMessage' },
    response: { kind: 'chat_access_lost' },
    expect: { expectKind: 'chat_access_lost' },
  }),
  'errors/07-user-unreachable.json': synthetic('the DM was never started', {
    request: { method: 'sendMessage' },
    response: { kind: 'user_unreachable' },
    expect: { expectKind: 'user_unreachable' },
  }),
  'errors/08-chat-migrated.json': synthetic('the group became a supergroup', {
    request: { method: 'sendMessage' },
    response: { kind: 'chat_migrated', newPlatformChatId: 'chat-moved' },
    expect: { expectKind: 'chat_migrated', newPlatformChatId: 'chat-moved' },
  }),
  'errors/09-permission-missing.json': synthetic('a specific right is missing', {
    request: { method: 'sendMessage' },
    response: { kind: 'permission_missing', permission: 'can_send_messages' },
    expect: { expectKind: 'permission_missing' },
  }),
  'errors/10-message-too-long.json': synthetic('over the platform’s own limit', {
    request: { method: 'sendMessage' },
    response: { kind: 'message_too_long' },
    expect: { expectKind: 'message_too_long' },
  }),
  'errors/11-markup-rejected.json': synthetic('the platform could not parse the entities', {
    request: { method: 'sendMessage' },
    response: { kind: 'markup_rejected' },
    expect: { expectKind: 'markup_rejected' },
  }),
  'errors/12-not-found.json': synthetic('the target message is gone', {
    request: { method: 'sendMessage' },
    response: { kind: 'not_found' },
    expect: { expectKind: 'not_found' },
  }),
  'errors/13-bad-request.json': synthetic('a permanent bug in the request', {
    request: { method: 'sendMessage' },
    response: { kind: 'bad_request' },
    expect: { expectKind: 'bad_request' },
  }),
};

/** `06` §3.20.3's two states a host can actually be in. */
const PROBE: Readonly<Record<string, Record<string, unknown>>> = {
  'probe/01-healthy.json': synthetic('an admin bot in a chat it can post in', {
    request: { chat: 'chat-probe-ok', canSend: true, isAdmin: true },
    expect: { codes: [], canSend: true },
  }),
  'probe/02-cannot-post.json': synthetic('the bot is present and muted', {
    // The state a host reaches by restricting the bot rather than removing it, and the one that
    // looks from inside the group exactly like Village ignoring everybody.
    request: { chat: 'chat-probe-mute', canSend: false, isAdmin: true },
    expect: { codes: ['channel.cannot_post'], canSend: false },
  }),
};

/**
 * The render expectations, by markup.
 *
 * Short on purpose. `M3-T4`'s own corpus is 184 injection cases and 61 render cases over the same
 * three renderers, so what this family adds is not more markup coverage but the claim that *this
 * adapter* hands the renderer the right capabilities and sends every part it produced — which a
 * long fixture would state no better and would make unreadable when it failed.
 */
const RENDERED: Readonly<Record<ChannelCapabilities['markup'], readonly string[]>> = {
  'telegram-html': ['<b>Dinner</b> is at <a href="https://e.co/x">the usual place</a>'],
  plain: [
    JSON.stringify({
      // The URL is **in the text**: Signal has no links, so a plain renderer that dropped it
      // would lose the one part of the message a member needs (`06` §3.5.3). My first expectation
      // left it out and the renderer was right.
      text: 'Dinner is at the usual place (https://e.co/x)',
      styles: [{ start: 0, length: 6, style: 'BOLD' }],
      mentions: [],
    }),
  ],
  'web-md': [
    JSON.stringify({
      v: 1,
      blocks: [
        {
          t: 'p',
          c: [
            { t: 'text', text: 'Dinner', marks: ['b'] },
            { t: 'text', text: ' is at ' },
            { t: 'link', url: 'https://e.co/x', c: [{ t: 'text', text: 'the usual place' }] },
          ],
        },
      ],
    }),
  ],
  // The three M8 markups have no renderer, and `createSimulator` refuses their profiles outright
  // (see `SIMULATOR_PROFILES`), so these are never read. Present because the record is total: a
  // fourth markup added without an entry should be a compile error here rather than a missing
  // fixture at run time.
  'discord-md': [],
  'slack-mrkdwn': [],
  'matrix-html': [],
};

/** The AST the render fixtures send. */
const RENDER_AST = {
  v: 1,
  blocks: [
    {
      t: 'p',
      c: [
        { t: 'text', text: 'Dinner', marks: ['b'] },
        { t: 'text', text: ' is at ' },
        { t: 'link', url: 'https://e.co/x', c: [{ t: 'text', text: 'the usual place' }] },
      ],
    },
  ],
} as const;

/**
 * The whole corpus for one profile.
 *
 * Keyed by `06` §3.25's paths so a failure names a file, even though no file exists — the path is
 * the identifier a reader can search for, and keeping the convention means a recorded corpus can
 * replace this one without touching a case.
 */
export function simCorpus(capabilities: ChannelCapabilities): Readonly<Record<string, unknown>> {
  return {
    ...INBOUND,
    ...ERRORS,
    ...PROBE,
    'outbound/render-paragraph.json': synthetic(`a paragraph in ${capabilities.markup}`, {
      ast: RENDER_AST,
      expect: RENDERED[capabilities.markup],
    }),
  };
}
