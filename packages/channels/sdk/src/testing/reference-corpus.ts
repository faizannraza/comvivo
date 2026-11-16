/**
 * The reference fixture corpus (`06` §3.25; `M3-T9`).
 *
 * The corpus the kit's own suite runs against, and the worked example an adapter author copies. It
 * is a TypeScript module rather than a directory of JSON, for one reason: a published test kit must
 * not assume a filesystem (see `fixtures.ts`), so the kit's own proof must not either. Real
 * adapters point `nodeFixtureStore` at `fixtures/channels/<id>/` and get `06` §3.25's layout, which
 * is where a **recorded** corpus belongs — these are all synthetic, because the reference platform
 * is not a platform and has nothing to record from.
 *
 * Every entry is marked `synthetic`, which is the honest label and also the one the redaction
 * marker rule depends on: `fixtures:lint` requires a marker on a `recorded` file precisely because
 * a recorded one carries a real member's chat.
 *
 * ## The five classes
 *
 * `06` §3.25's C03 names mention, reply, command, anonymous and forwarded, and the corpus covers
 * all five because C03 asserts the **coverage** rather than only the correctness. A corpus of plain
 * group messages passes every other case and proves nothing about an anonymous admin — which is
 * exactly the payload whose `senderKind` decides whether `08` PSC-9's S4 bot gate fires.
 */
import { BRAND } from '@comvivo/shared';
import type { Fixture } from './fixtures.js';

const SYNTHETIC = {
  platformVersion: 'fake-1',
  recordedAt: '2026-11-15T12:00:00Z',
  source: 'synthetic',
} as const;

const AT = '2026-11-15T12:00:00Z';

/** A fixture, with the boilerplate filled in. */
function synthetic(note: string, parts: Omit<Fixture, 'meta'>): Fixture {
  return { meta: { ...SYNTHETIC, note }, ...parts };
}

const plainMessage = synthetic('a plain group message', {
  raw: {
    type: 'message',
    update_id: 1,
    chat: { id: 'chat-1', kind: 'group', title: 'The group' },
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
});

const mentionMessage = synthetic('the bot is named', {
  raw: {
    type: 'message',
    update_id: 2,
    chat: { id: 'chat-1', kind: 'group' },
    from: { id: 'u1', name: 'Ana' },
    message_id: 'm2',
    at: AT,
    text: `@${BRAND.slug} what is on today?`,
    entities: [{ type: 'bot_mention', value: BRAND.slug }],
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
    text: `@${BRAND.slug} what is on today?`,
    mentionsBot: true,
    attachments: [],
    dedupeKey: '2',
  },
});

const replyToBot = synthetic('a reply to one of the bot’s own messages', {
  raw: {
    type: 'message',
    update_id: 3,
    chat: { id: 'chat-1', kind: 'group' },
    from: { id: 'u2', name: 'Sam' },
    message_id: 'm3',
    at: AT,
    text: 'yes please',
    reply_to: { message_id: 'bot-1', from_is_bot: true },
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
    replyToPlatformMessageId: 'bot-1',
    replyToIsBot: true,
    attachments: [],
    dedupeKey: '3',
  },
});

const command = synthetic('a slash command in a DM, which addresses the bot by itself', {
  raw: {
    type: 'message',
    update_id: 4,
    chat: { id: 'dm-1', kind: 'dm' },
    from: { id: 'u1', name: 'Ana' },
    message_id: 'm4',
    at: AT,
    text: '/privacy',
    entities: [{ type: 'command', value: 'privacy' }],
  },
  expect: {
    channel: 'simulator',
    platformChatId: 'dm-1',
    chatKind: 'dm',
    platformMessageId: 'm4',
    platformUserId: 'u1',
    platformUserDisplayName: 'Ana',
    senderKind: 'user',
    sentAt: AT,
    text: '/privacy',
    mentionsBot: true,
    attachments: [],
    interaction: { kind: 'command', payload: { name: 'privacy', args: '', source: 'slash' } },
    dedupeKey: '4',
  },
});

const anonymousAdmin = synthetic('an admin posting as the group', {
  raw: {
    type: 'message',
    update_id: 5,
    chat: { id: 'chat-1', kind: 'group' },
    from: { id: 'chat-1', name: 'The group', anonymous: true },
    message_id: 'm5',
    at: AT,
    text: 'house rules: no phones at dinner',
  },
  expect: {
    channel: 'simulator',
    platformChatId: 'chat-1',
    chatKind: 'group',
    platformMessageId: 'm5',
    platformUserId: 'chat-1',
    platformUserDisplayName: 'The group',
    senderKind: 'anonymous_admin',
    sentAt: AT,
    text: 'house rules: no phones at dinner',
    mentionsBot: false,
    attachments: [],
    dedupeKey: '5',
  },
});

const forwarded = synthetic('a forwarded message, whose author is not in this group', {
  raw: {
    type: 'message',
    update_id: 6,
    chat: { id: 'chat-1', kind: 'group' },
    from: { id: 'u1', name: 'Ana' },
    message_id: 'm6',
    at: AT,
    text: 'look at this',
    forward_from: 'A newsletter',
  },
  expect: {
    channel: 'simulator',
    platformChatId: 'chat-1',
    chatKind: 'group',
    platformMessageId: 'm6',
    platformUserId: 'u1',
    platformUserDisplayName: 'Ana',
    senderKind: 'user',
    sentAt: AT,
    text: 'look at this',
    mentionsBot: false,
    forwarded: { fromName: 'A newsletter' },
    attachments: [],
    dedupeKey: '6',
  },
});

/**
 * The render corpus.
 *
 * Kept to the two shapes that pin a markup: an inline mark, and a fenced block. Everything else the
 * renderer does is covered by `M3-T4`'s own 280 tests — what C06 adds is that the **adapter** sends
 * what the renderer produced, rather than a string it assembled itself.
 */
const renderMarks = synthetic('inline marks become the platform’s markup', {
  ast: {
    v: 1,
    blocks: [
      {
        t: 'p',
        c: [
          { t: 'text', text: 'be ' },
          { t: 'text', text: 'there', marks: ['b'] },
          { t: 'text', text: ' at six' },
        ],
      },
    ],
  },
  expect: ['be <b>there</b> at six'],
});

const renderCode = synthetic('a fenced block keeps its language', {
  ast: {
    v: 1,
    blocks: [{ t: 'code', lang: 'sh', text: 'pnpm verify' }],
  },
  expect: ['<pre><code class="language-sh">pnpm verify</code></pre>'],
});

/** `06` §3.15's kinds, one fixture each for the four whose details the engine reads. */
const errorRateLimited = synthetic('a 429 carries the platform’s own retry-after', {
  request: { method: 'sendMessage' },
  response: { kind: 'rate_limited', retryAfterMs: 7_000 },
  // `terminal: false` because `06` §3.14 says a 429 "does not count toward attempts": a conformant
  // adapter never gives up on one, so the mapping cannot surface as a rejection. What the case
  // checks instead is that it retried and waited at least as long as the platform asked.
  expect: { expectKind: 'rate_limited', retryAfterMs: 7_000, attempts: 1, terminal: false },
});

const errorTransient = synthetic('a 5xx before the request was sent', {
  request: { method: 'sendMessage' },
  response: { kind: 'transient' },
  // Armed past the eight-attempt budget, so the kind surfaces instead of being retried away.
  expect: { expectKind: 'transient', attempts: 12, terminal: true },
});

const errorMigrated = synthetic('a group upgraded in place carries its new id', {
  request: { method: 'sendMessage' },
  response: { kind: 'chat_migrated', to: 'chat-upgraded' },
  expect: { expectKind: 'chat_migrated', newPlatformChatId: 'chat-upgraded', terminal: true },
});

const errorPermission = synthetic('a missing right is permanent and gets a diagnostic', {
  request: { method: 'sendMessage' },
  response: { kind: 'permission_missing' },
  expect: { expectKind: 'permission_missing', terminal: true },
});

/** `06` §3.20.3's probe scenarios: what a host is told when a chat is set up wrongly. */
const probeHealthy = synthetic('an admin in a chat it can post to', {
  request: { chat: 'chat-ok', canSend: true, isAdmin: true },
  expect: { codes: [], canSend: true },
});

const probeCannotPost = synthetic('a chat the bot has been muted in', {
  request: { chat: 'chat-muted', canSend: false, isAdmin: true },
  expect: { codes: ['channels.cannot_post'], canSend: false },
});

const probeNotAdmin = synthetic('privacy mode: the bot reads only what names it', {
  request: { chat: 'chat-private', canSend: true, isAdmin: false },
  expect: { codes: ['channels.privacy_mode'], canSend: true },
});

/** The corpus, keyed the way a {@link FixtureStore} addresses it. */
export const REFERENCE_CORPUS: Readonly<Record<string, Fixture>> = Object.freeze({
  'inbound/01-plain.json': plainMessage,
  'inbound/02-mention.json': mentionMessage,
  'inbound/03-reply-to-bot.json': replyToBot,
  'inbound/04-command.json': command,
  'inbound/05-anonymous-admin.json': anonymousAdmin,
  'inbound/06-forwarded.json': forwarded,
  'outbound/render-marks.json': renderMarks,
  'outbound/render-code.json': renderCode,
  'errors/rate-limited.json': errorRateLimited,
  'errors/transient.json': errorTransient,
  'errors/migrated.json': errorMigrated,
  'errors/permission-missing.json': errorPermission,
  'probe/healthy.json': probeHealthy,
  'probe/cannot-post.json': probeCannotPost,
  'probe/not-admin.json': probeNotAdmin,
});
