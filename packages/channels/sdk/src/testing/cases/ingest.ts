/**
 * C01–C05, C16, C17, C20, C22, C24 — the inbound half (`06` §3.25; `M3-T9`).
 *
 * Every case here is about the same seam: a payload the platform wrote becoming an envelope this
 * repository defines. It is the part of an adapter that cannot be argued from the source, because
 * the input is written by somebody else and changes without notice — which is why `06` §3.25's
 * answer is a recorded corpus and nine cases over it.
 */
import { BRAND } from '@comvivo/shared';
import { ChannelEventSchema, InboundEnvelopeSchema } from '../../schemas.js';
import { check, checkEqual } from '../assert.js';
import { loadFixtures } from '../fixtures.js';
import type { CaseContext, ConformanceCase } from '../harness.js';

/** Nothing gates these: a platform that cannot receive a message is not a channel. */
const always = (): null => null;

/**
 * The envelope as a fixture can describe it.
 *
 * `raw` is dropped before comparing, because the envelope's own contract says it is "retained
 * **only** in debug mode" — so a fixture carrying it would be asserting a debug-mode behaviour, and
 * every fixture would have to repeat the whole payload twice.
 */
function comparable(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const { raw: _raw, ...rest } = value as Record<string, unknown>;
  return rest;
}

async function deliverRaw(ctx: CaseContext, raw: unknown): Promise<void> {
  await ctx.fake.deliver(raw);
}

export const C01: ConformanceCase = {
  id: 'C01',
  name: 'Every inbound fixture normalises to its expected envelope, and the output validates',
  gate: always,
  async run(ctx) {
    const fixtures = await loadFixtures(ctx.store, 'inbound');
    check(
      'C01',
      fixtures.length > 0,
      'no `inbound/*.json` fixtures were found. An adapter with no recorded payloads has nothing ' +
        'to be conformant about (06 §3.25), and an empty directory is the one failure a corpus ' +
        'test must not pass silently.',
    );
    for (const entry of fixtures) {
      const before = ctx.ingested().length;
      await deliverRaw(ctx, entry.fixture.raw);
      const produced = ctx.ingested().slice(before);
      check(
        'C01',
        produced.length === 1,
        `${entry.path} produced ${String(produced.length)} items, expected 1`,
      );
      const item = produced[0];
      if (item === undefined) continue;
      checkEqual(
        'C01',
        comparable(item.value),
        comparable(entry.fixture.expect),
        `${entry.path} normalised wrongly`,
      );
      // The schemas, not a second copy of the type: `01` §2 validates every boundary, and an
      // envelope that type-checks and fails its schema is one the engine would reject at runtime.
      const parsed =
        item.kind === 'envelope'
          ? InboundEnvelopeSchema.safeParse(item.value)
          : ChannelEventSchema.safeParse(item.value);
      check(
        'C01',
        parsed.success,
        `${entry.path} produced something the ${item.kind} schema rejects: ${
          parsed.success ? '' : parsed.error.issues.map((issue) => issue.message).join('; ')
        }`,
      );
    }
  },
};

export const C02: ConformanceCase = {
  id: 'C02',
  name: 'Redelivering the same payload yields identical dedupe identity',
  gate: always,
  async run(ctx) {
    // Every platform redelivers. Telegram resends an un-acked update, Discord replays a session,
    // Slack retries a failed webhook three times — so "the same message twice" is the normal case,
    // not the edge one, and the only thing standing between it and two replies is this identity.
    const fixtures = await loadFixtures(ctx.store, 'inbound');
    for (const entry of fixtures) {
      const first = ctx.ingested().length;
      await deliverRaw(ctx, entry.fixture.raw);
      await deliverRaw(ctx, entry.fixture.raw);
      const [a, b] = ctx.ingested().slice(first);
      if (a === undefined || b === undefined) continue;
      const keyOf = (value: unknown): unknown => (value as { dedupeKey?: unknown }).dedupeKey;
      if (a.kind !== 'envelope') continue;
      check(
        'C02',
        keyOf(a.value) !== undefined,
        `${entry.path} produced an envelope with no dedupeKey`,
      );
      checkEqual(
        'C02',
        keyOf(b.value),
        keyOf(a.value),
        `${entry.path} gave two dedupe identities for one payload`,
      );
    }
  },
};

/** The fixture classes `06` §3.25 C03 names. A corpus missing one is a corpus that proves less. */
const SENDER_CLASSES = ['mention', 'reply', 'command', 'anonymous', 'forwarded'] as const;

export const C03: ConformanceCase = {
  id: 'C03',
  name: '`mentionsBot`, `replyToIsBot` and `senderKind` are correct for each fixture class',
  gate: always,
  async run(ctx) {
    // C01 already compares every field of every fixture, so this case earns its place by checking
    // **coverage**: that the corpus contains each of the five classes at all. A corpus of six plain
    // group messages passes C01 and proves nothing about an anonymous admin, and that is exactly
    // the payload whose `senderKind` decides whether `08` PSC-9's S4 gate fires.
    const fixtures = await loadFixtures(ctx.store, 'inbound');
    const covered = new Set<string>();
    for (const entry of fixtures) {
      const expected = entry.fixture.expect as Record<string, unknown>;
      if (expected['mentionsBot'] === true) covered.add('mention');
      if (expected['replyToPlatformMessageId'] !== undefined) covered.add('reply');
      if ((expected['interaction'] as { kind?: string } | undefined)?.kind === 'command') {
        covered.add('command');
      }
      if (expected['senderKind'] === 'anonymous_admin') covered.add('anonymous');
      if (expected['forwarded'] !== undefined) covered.add('forwarded');
    }
    for (const sort of SENDER_CLASSES) {
      check(
        'C03',
        covered.has(sort),
        `no inbound fixture covers the \`${sort}\` class (06 §3.25 C03). The three fields it ` +
          'decides — mentionsBot, replyToIsBot, senderKind — are what the router and the bot gate ' +
          'read, so an uncovered class is an untested routing decision.',
      );
    }
  },
};

export const C04: ConformanceCase = {
  id: 'C04',
  name: 'Echo filter: the bot’s own messages are never ingested',
  gate: always,
  async run(ctx) {
    // `08` PSC-9's S4 gate turns on this. Two bots in one group otherwise talk to each other at a
    // provider's prices until somebody notices the bill — and the bot's own message is the first
    // one it will ever see after sending.
    const before = ctx.ingested().length;
    await deliverRaw(ctx, {
      type: 'message',
      update_id: 90_001,
      chat: { id: 'chat-echo', kind: 'group' },
      from: { id: 'bot-self', name: BRAND.botDefaultName, is_bot: true },
      message_id: 'echo-1',
      at: ctx.clock.now().toString(),
      text: 'a reply the bot just sent',
    });
    check(
      'C04',
      ctx.ingested().length === before,
      'the adapter ingested a message from its own identity. The fake delivers it with the same ' +
        'id `describeSelf` reports, which is the only signal a platform gives.',
    );
  },
};

export const C05: ConformanceCase = {
  id: 'C05',
  name: 'N messages in one chat are ingested in platform order, and the ingest is acked first',
  gate: always,
  async run(ctx) {
    const ackMethod = ctx.harness.ackMethod ?? 'ackUpdate';
    const ids = ['o1', 'o2', 'o3', 'o4', 'o5'];
    const produced: string[] = [];
    for (const [at, id] of ids.entries()) {
      const before = ctx.trace().length;
      await deliverRaw(ctx, {
        type: 'message',
        update_id: 91_000 + at,
        chat: { id: 'chat-order', kind: 'group' },
        from: { id: 'u1', name: 'Ana' },
        message_id: id,
        at: ctx.clock.now().toString(),
        text: `message ${String(at)}`,
      });
      // Scoped to **this** delivery, which is what the first version got wrong: it looked for an
      // ack *somewhere after* the ingest and found one, while a planted break that acked **first**
      // and again afterwards passed. The rule is that none precedes it, so the window has to be one
      // update wide.
      const window = ctx.trace().slice(before);
      const ingestAt = window.indexOf(`ingest:${id}`);
      const ackAt = window.indexOf(`call:${ackMethod}`);
      check('C05', ingestAt !== -1, `no ingest was recorded for ${id}`);
      check(
        'C05',
        ackAt === -1 || ackAt > ingestAt,
        `${id} was acked to the platform before the ingest was acked, so a crash between the two ` +
          'loses the message: the platform will not redeliver it and nothing stored it.',
      );
      produced.push(
        ...ctx
          .ingested()
          .slice(-1)
          .map((item) => (item.value as { platformMessageId: string }).platformMessageId),
      );
    }
    checkEqual('C05', produced, ids, 'messages were ingested out of platform order');
  },
};

export const C16: ConformanceCase = {
  id: 'C16',
  name: 'Membership events: added, removed, kicked, DM blocked',
  gate: always,
  async run(ctx) {
    const before = ctx.ingested().length;
    const at = ctx.clock.now().toString();
    await deliverRaw(ctx, {
      type: 'membership',
      update_id: 92_001,
      chat: { id: 'chat-m', kind: 'group' },
      status: 'added',
      by: 'u9',
      start_payload: 'clm_abc',
      at,
    });
    await deliverRaw(ctx, {
      type: 'member',
      update_id: 92_002,
      chat: { id: 'chat-m', kind: 'group' },
      platform_user_id: 'u3',
      name: 'Sam',
      joined: true,
      at,
    });
    await ctx.fake.kickBot('chat-m');
    await deliverRaw(ctx, {
      type: 'dm_blocked',
      update_id: 92_004,
      platform_user_id: 'u3',
      blocked: true,
      at,
    });
    const types = ctx
      .ingested()
      .slice(before)
      .map((item) => (item.value as { type?: string }).type);
    checkEqual(
      'C16',
      types,
      ['bot_membership', 'member_joined', 'bot_membership', 'dm_blocked'],
      'membership changes were not emitted as the events `06` §3.3 names',
    );
    // The claim code arrives on the join (`06` §3.20.1), and an adapter that dropped it would make
    // deep-link binding impossible with nothing failing.
    const added = ctx.ingested().slice(before)[0]?.value as { startPayload?: string };
    checkEqual('C16', added.startPayload, 'clm_abc', 'the join event lost its deep-link payload');
  },
};

export const C17: ConformanceCase = {
  id: 'C17',
  name: 'Migration: `chat_migrated` is surfaced and outbound is re-targeted',
  gate: (capabilities) =>
    capabilities.markup === 'telegram-html'
      ? null
      : 'only the platforms that upgrade a group in place report a migration',
  async run(ctx) {
    // Telegram upgrades a group to a supergroup and changes its id. The first send to the old id
    // fails and carries the new one, which is why this is an *error* case rather than an event one.
    await ctx.fake.migrate('chat-old', 'chat-new');
    let caught: unknown;
    try {
      await ctx.adapter.send(outbound('chat-old', 'hello'));
    } catch (error) {
      caught = error;
    }
    const failure = caught as { kind?: string; details?: { newPlatformChatId?: string } };
    checkEqual(
      'C17',
      failure.kind,
      'chat_migrated',
      'a migrated chat did not produce `chat_migrated`',
    );
    checkEqual(
      'C17',
      failure.details?.newPlatformChatId,
      'chat-new',
      'the error did not carry the new chat id, so nothing can re-target the send (06 §3.15)',
    );
  },
};

export const C20: ConformanceCase = {
  id: 'C20',
  name: 'Edits and deletes are emitted as events',
  gate: (capabilities) =>
    capabilities.inboundEdits || capabilities.inboundDeletes
      ? null
      : 'the platform reports neither edits nor deletes',
  async run(ctx) {
    const before = ctx.ingested().length;
    const at = ctx.clock.now().toString();
    if (ctx.harness.capabilities.inboundEdits) {
      await deliverRaw(ctx, {
        type: 'edit',
        update_id: 93_001,
        chat: { id: 'chat-e', kind: 'group' },
        message_id: 'e1',
        text: 'corrected',
        at,
      });
    }
    if (ctx.harness.capabilities.inboundDeletes) {
      await deliverRaw(ctx, {
        type: 'delete',
        update_id: 93_002,
        chat: { id: 'chat-e', kind: 'group' },
        message_ids: ['e1'],
        at,
      });
    }
    const produced = ctx.ingested().slice(before);
    for (const item of produced) {
      check(
        'C20',
        item.kind === 'event',
        'an edit or delete was ingested as a message, not an event',
      );
      const parsed = ChannelEventSchema.safeParse(item.value);
      check('C20', parsed.success, 'the event does not validate against `ChannelEventSchema`');
    }
    check('C20', produced.length > 0, 'the platform declares edits or deletes and emitted neither');
  },
};

/** A minimal outbound message, for the cases that need to send one. */
export function outbound(
  chat: string,
  text: string,
): Parameters<CaseContext['adapter']['send']>[0] {
  return {
    idempotencyKey: `conformance:${chat}:${text.slice(0, 8)}`,
    target: { channel: 'simulator', platformChatId: chat, chatKind: 'group' },
    body: { v: 1, blocks: [{ t: 'p', c: [{ t: 'text', text }] }] },
    messageClass: 'reply',
    priority: 'interactive',
    mentions: {},
  };
}
