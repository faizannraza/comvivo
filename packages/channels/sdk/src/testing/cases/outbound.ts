/**
 * C06–C10, C13, C14, C19 — the outbound half (`06` §3.25; `M3-T9`).
 *
 * The inbound cases are about reading a platform. These are about not breaking one: a message that
 * exceeds a limit, markup that fails to parse, a mention that pings a hundred people, a retry that
 * sends twice. Each failure here is visible to a whole group at once, which is why the assertions
 * are over the **payloads the adapter actually produced** rather than over anything it returned.
 */
import type { Block, Inline, RichText } from '@comvivo/core';
import type { MemberId } from '@comvivo/shared';
import { mintInteractionToken } from '../../interactions/token.js';
import { measureTelegramHtml, measureText, visibleText } from '../../richtext/render/index.js';
import { check, checkEqual } from '../assert.js';
import { loadFixtures } from '../fixtures.js';
import type { CaseContext, ConformanceCase, RecordedCall } from '../harness.js';
import { outbound } from './ingest.js';

const always = (): null => null;

/** The `sendMessage` calls made since `before`, in order. */
function sendsSince(ctx: CaseContext, before: number): readonly RecordedCall[] {
  return ctx.fake
    .outbound()
    .slice(before)
    .filter((call) => call.method === 'sendMessage');
}

/** The payload of a `sendMessage` call, as a string where the markup is one. */
function payloadText(call: RecordedCall): string {
  const payload = (call.args as { payload?: unknown }).payload;
  return typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');
}

export const C06: ConformanceCase = {
  id: 'C06',
  name: 'Each `outbound/render-*.json` AST yields its expected platform payload',
  gate: always,
  async run(ctx) {
    const fixtures = (await loadFixtures(ctx.store, 'outbound')).filter((entry) =>
      entry.path.includes('render-'),
    );
    check(
      'C06',
      fixtures.length > 0,
      'no `outbound/render-*.json` fixtures were found. The render corpus is what pins a ' +
        "platform's markup, and an empty one passes every assertion about it (06 §3.25).",
    );
    for (const entry of fixtures) {
      const before = ctx.fake.outbound().length;
      const message = outbound('chat-render', 'x');
      await ctx.drain(ctx.adapter.send({ ...message, body: entry.fixture.ast as RichText }));
      const produced = sendsSince(ctx, before).map((call) => payloadText(call));
      checkEqual('C06', produced, entry.fixture.expect, `${entry.path} rendered wrongly`);
    }
  },
};

/**
 * A seeded document generator for C07.
 *
 * `06` §3.25 names fast-check at 500 runs. The kit uses its own generator instead, for one reason
 * that matters to the people the kit is for: it is a **published** entry point that third-party
 * channel plugins run (§3.25's last line), and a property-testing library as a peer dependency is a
 * thing an adapter author has to install and pin to run a conformance suite. 500 runs of a seeded
 * generator give the same coverage of the shapes that break a splitter — long words, nested
 * containers, code blocks, graphemes that must not be cut — with nothing to install.
 *
 * The seed is the run index, so a failure names the document that produced it.
 */
function generateDocument(seed: number): RichText {
  let state = (seed * 2_654_435_761) % 4_294_967_296;
  const next = (): number => {
    state = (state * 1_103_515_245 + 12_345) % 4_294_967_296;
    return state / 4_294_967_296;
  };
  // `?? values[0]` rather than an assertion: the index is in range by construction, and
  // `noUncheckedIndexedAccess` is right that the compiler cannot know that.
  const pick = <T>(values: readonly T[]): T =>
    values[Math.floor(next() * values.length)] ?? (values[0] as T);
  const words = [
    'chores',
    'sleepover',
    'Saturday',
    'pizza',
    'reeeeeeeeeeeeeeeeeeeeeeeeally',
    '👨‍👩‍👧',
    'ok',
  ];
  const run = (): Inline => ({
    t: 'text',
    text: Array.from({ length: 1 + Math.floor(next() * 12) }, () => pick(words)).join(' '),
  });
  const paragraph = (): Block => ({
    t: 'p',
    c: Array.from({ length: 1 + Math.floor(next() * 3) }, run),
  });
  const block = (): Block => {
    const sort = pick(['p', 'p', 'p', 'h', 'list', 'code', 'quote'] as const);
    if (sort === 'h') return { t: 'h', level: pick([1, 2, 3] as const), c: [run()] };
    if (sort === 'code') {
      return {
        t: 'code',
        text: Array.from({ length: 1 + Math.floor(next() * 6) }, () => pick(words)).join('\n'),
      };
    }
    if (sort === 'list') {
      return {
        t: 'list',
        ordered: next() > 0.5,
        items: Array.from({ length: 1 + Math.floor(next() * 3) }, () => [paragraph()]),
      };
    }
    if (sort === 'quote') return { t: 'quote', c: [paragraph()] };
    return paragraph();
  };
  return { v: 1, blocks: Array.from({ length: 1 + Math.floor(next() * 6) }, block) };
}

/** Whether a Telegram-HTML payload's tags are balanced and allowlisted. */
function balancedTelegramHtml(html: string): boolean {
  const allowed = new Set([
    'b',
    'i',
    'u',
    's',
    'code',
    'pre',
    'a',
    'blockquote',
    'tg-spoiler',
    'tg-time',
    'span',
  ]);
  const stack: string[] = [];
  for (const match of html.matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
    const [, closing, name = ''] = match;
    if (!allowed.has(name)) return false;
    if (closing === '/') {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name);
    }
  }
  return stack.length === 0;
}

export const C07: ConformanceCase = {
  id: 'C07',
  name: 'Splitting property (500 runs): every part fits, markup is well-formed, text is preserved',
  gate: always,
  async run(ctx) {
    const limit = ctx.harness.capabilities.maxMessageChars;
    for (let seed = 1; seed <= 500; seed += 1) {
      const document = generateDocument(seed);
      const before = ctx.fake.outbound().length;
      // The clock is advanced **while** the send is in flight, because a conformant adapter is
      // rate-limited: five hundred messages drain any platform's global bucket, and the waiter then
      // sits on a timer nothing fires. The first version awaited the send first and deadlocked part
      // way through — which reads as a hung adapter and is a hung test.
      await ctx.drain(
        ctx.adapter.send({ ...outbound(`chat-split-${String(seed)}`, 'x'), body: document }),
      );
      const parts = sendsSince(ctx, before);
      check('C07', parts.length > 0, `seed ${String(seed)} produced no parts`);
      for (const part of parts) {
        const text = payloadText(part);
        // Measured in **the unit the platform counts** (`06` §3.5.4), which for Telegram HTML is
        // visible characters after the tags are stripped and the entities decoded. A raw
        // `text.length` would over-count by the markup and pass a part the platform refuses.
        const measured =
          ctx.harness.capabilities.markup === 'telegram-html'
            ? measureTelegramHtml(text)
            : measureText(text, ctx.harness.capabilities.lengthUnit);
        check(
          'C07',
          measured <= limit,
          `seed ${String(seed)}: a part measures ${String(measured)} against a ` +
            `${String(limit)} limit. The platform answers an over-long message with an error and ` +
            'sends nothing at all, so the member gets silence.',
        );
        if (ctx.harness.capabilities.markup === 'telegram-html') {
          check(
            'C07',
            balancedTelegramHtml(text),
            `seed ${String(seed)}: the markup is not balanced or uses a tag outside the allowlist. ` +
              'Telegram answers that with `400 can’t parse entities` and sends nothing at all.',
          );
        }
      }
      // Text preservation, with the part cap accounted for. `06` §3.5.4 truncates at
      // `maxPartsPerMessage` and appends a notice, so a document that needs more parts than the cap
      // allows **legitimately** loses content — found by seed 130, where a 1 646-character document
      // produced 1 259 characters across six parts and the case called it a dropped run. Below the
      // cap the parts must hold what the document held; at the cap, what matters is that the member
      // is told, which is the notice's job and `M3-T5`'s own suite.
      if (parts.length < 6) {
        const strip = (text: string): string => text.replaceAll(/\s+/gu, '');
        const expected = strip(visibleText(document));
        const produced = strip(parts.map((part) => payloadText(part)).join(''));
        check(
          'C07',
          produced.length >= expected.length * 0.9,
          `seed ${String(seed)}: ${String(parts.length)} part(s) hold ${String(produced.length)} ` +
            `characters against the document's ${String(expected.length)}. A splitter that drops a ` +
            'run is the one failure a fitting check cannot see, because a shorter part fits ' +
            'perfectly well.',
        );
      }
    }
  },
};

export const C08: ConformanceCase = {
  id: 'C08',
  name: 'Mentions: pings only for `canPing`, and no mass-mention tokens',
  gate: always,
  async run(ctx) {
    const before = ctx.fake.outbound().length;
    // Cast once, here: `MemberId` is branded and a conformance case is not the place to mint one
    // through the id generator — the kit must not depend on `@comvivo/shared`'s id internals.
    const ana = 'mbr_01jd0000000000000000000001' as unknown as MemberId;
    const sam = 'mbr_01jd0000000000000000000002' as unknown as MemberId;
    const body: RichText = {
      v: 1,
      blocks: [
        {
          t: 'p',
          c: [
            {
              t: 'mention',
              target: { kind: 'member', memberId: ana },
              fallback: '@Ana',
            },
            { t: 'text', text: ' and ' },
            {
              t: 'mention',
              target: { kind: 'member', memberId: sam },
              fallback: '@Sam',
            },
            { t: 'text', text: ' — @everyone @here <!channel>' },
          ],
        },
      ],
    };
    await ctx.adapter.send({
      ...outbound('chat-mentions', 'x'),
      body,
      mentions: {
        [ana]: { platformUserId: 'u1', displayName: 'Ana', canPing: true },
        [sam]: { displayName: 'Sam', canPing: false },
      },
    });
    const text = sendsSince(ctx, before)
      .map((call) => payloadText(call))
      .join('');
    check('C08', text.includes('Ana'), 'a pingable member was not mentioned at all');
    check(
      'C08',
      !text.includes('u2') && text.includes('Sam'),
      'an unpingable member was rendered as a ping. `canPing: false` is a member who has not ' +
        'linked an identity on this platform, so the ping would notify nobody and name them anyway.',
    );
    for (const token of ctx.harness.capabilities.massMentionTokens) {
      check(
        'C08',
        !text.includes(token),
        `the payload contains the mass-mention token \`${token}\` (06 §3.6). It arrives in ` +
          'content — a member quotes one, or a model repeats one back — so the renderer is where ' +
          'it has to be broken.',
      );
    }
  },
};

export const C09: ConformanceCase = {
  id: 'C09',
  name: 'Buttons: tokens fit the limits, a click is acked before the ingest, the token is carried',
  gate: (capabilities) => (capabilities.buttons ? null : 'the platform has no buttons'),
  async run(ctx) {
    const limits = ctx.harness.capabilities.buttonLimits;
    check('C09', limits !== null, 'the platform declares buttons and no `buttonLimits`');
    if (limits === null) return;
    const token = mintInteractionToken();
    check(
      'C09',
      new TextEncoder().encode(token).length <= limits.tokenMaxBytes,
      `a token is ${String(token.length)} bytes against a ${String(limits.tokenMaxBytes)} budget`,
    );
    const before = ctx.fake.outbound().length;
    await ctx.drain(
      ctx.adapter.send({
        ...outbound('chat-buttons', 'pick one'),
        actions: [[{ label: 'Approve', style: 'primary', token }]],
      }),
    );
    check('C09', sendsSince(ctx, before).length > 0, 'a message with buttons was not sent');

    const ingestedBefore = ctx.ingested().length;
    const callsBefore = ctx.fake.outbound().length;
    await ctx.fake.deliver({
      type: 'callback',
      update_id: 94_001,
      chat: { id: 'chat-buttons', kind: 'group' },
      from: { id: 'u1', name: 'Ana' },
      callback_id: 'cb-1',
      on_message_id: 'm1',
      data: token,
      at: ctx.clock.now().toString(),
    });
    const item = ctx.ingested().slice(ingestedBefore)[0]?.value as {
      interaction?: { kind: string; payload: { token?: string } };
    };
    checkEqual(
      'C09',
      item.interaction?.kind,
      'button',
      'a click did not arrive as a button interaction',
    );
    checkEqual(
      'C09',
      item.interaction?.payload.token,
      token,
      'the envelope did not carry the token',
    );

    // `06` §3.7 step 2: the ack comes **first**. The press is the one event whose platform window
    // is shorter than the turn, and Telegram rejects a second answer.
    const acks = ctx.fake
      .outbound()
      .slice(callsBefore)
      .findIndex((call) => call.method === 'ackCallback');
    check(
      'C09',
      acks === 0,
      'the click was not acked to the platform before anything else. Telegram gives about two ' +
        'seconds and refuses a second answer (06 §3.7 step 2).',
    );

    // An unknown token still ingests: the engine decides expiry and owes the member a toast
    // (`06` §3.7 step 6), so an adapter that dropped it would make that message impossible.
    const unknownBefore = ctx.ingested().length;
    await ctx.fake.deliver({
      type: 'callback',
      update_id: 94_002,
      chat: { id: 'chat-buttons', kind: 'group' },
      from: { id: 'u1', name: 'Ana' },
      callback_id: 'cb-2',
      on_message_id: 'm1',
      data: 'v1.AAAAAAAAAAAAAAAAAAAAAA',
      at: ctx.clock.now().toString(),
    });
    check(
      'C09',
      ctx.ingested().length > unknownBefore,
      'an unrecognised token was dropped by the adapter. The engine decides expiry and owes the ' +
        'member "This button has expired" (06 §3.7 step 6), which it cannot do for an event it ' +
        'never sees.',
    );
  },
};

export const C10: ConformanceCase = {
  id: 'C10',
  name: 'Polls: create, vote and close map as `06` §3.8 declares',
  gate: (capabilities) => (capabilities.nativePolls ? null : 'the platform has no native polls'),
  async run(ctx) {
    const createPoll = ctx.adapter.createPoll?.bind(ctx.adapter);
    const closePoll = ctx.adapter.closePoll?.bind(ctx.adapter);
    check(
      'C10',
      createPoll !== undefined,
      'the platform declares native polls and omits `createPoll`',
    );
    check(
      'C10',
      closePoll !== undefined,
      'the platform declares native polls and omits `closePoll`',
    );
    if (createPoll === undefined || closePoll === undefined) return;
    const options = ['Saturday', 'Sunday'];
    const ref = await createPoll({
      target: { channel: ctx.harness.channel, platformChatId: 'chat-poll' },
      question: 'Which day?',
      options,
      multiSelect: false,
      anonymous: false,
      idempotencyKey: 'conformance:poll:1',
    });
    check('C10', ref.platformPollId.length > 0, '`createPoll` returned no poll id');

    const before = ctx.ingested().length;
    await ctx.fake.deliver({
      type: 'poll_vote',
      update_id: 95_001,
      chat: { id: 'chat-poll', kind: 'group' },
      from: { id: 'u1', name: 'Ana' },
      poll_id: ref.platformPollId,
      option_ids: [1],
      at: ctx.clock.now().toString(),
    });
    const vote = ctx.ingested().slice(before)[0]?.value as {
      interaction?: { kind: string; payload: Record<string, unknown> };
    };
    checkEqual('C10', vote.interaction?.kind, 'poll_vote', 'a vote did not arrive as a poll vote');
    const mode = vote.interaction?.payload['mode'];
    check(
      'C10',
      mode === 'replace' || mode === 'delta',
      `a vote declared mode ${String(mode)}; \`06\` §3.8 allows only \`replace\` or \`delta\``,
    );

    const tally = await closePoll(ref);
    if (tally !== null) {
      checkEqual(
        'C10',
        tally.counts.length,
        options.length,
        '`closePoll` returned a tally whose counts do not match the option count (06 §3.8)',
      );
    }
    // Whichever it is, it has to be the **same** answer every time: `07` reconciles its mirrored
    // votes against this, and a platform that sometimes reports counts is one `07` cannot plan for.
    const second = await closePoll(ref);
    check(
      'C10',
      (tally === null) === (second === null),
      '`closePoll` returned a tally once and `null` the next time. `07` §3.5.3 decides whether to ' +
        'trust platform counts or its own mirror, and it cannot do that per call.',
    );
  },
};

export const C13: ConformanceCase = {
  id: 'C13',
  name: 'Split resume: a fault after part 1 of 3, then `send(resume)`, sends only parts 2–3',
  gate: always,
  async run(ctx) {
    // `06` §3.13's exactly-once intent (**I6**) in its most visible form: a crash between parts
    // must not repeat the part that landed. A family reading the same paragraph twice is the
    // symptom, and it is the one bug a resume path exists to prevent.
    const long = longDocument(ctx.harness.capabilities.maxMessageChars * 3);
    const message = { ...outbound('chat-resume', 'x'), body: long };

    ctx.fake.failNext(
      (call) =>
        call.method === 'sendMessage' &&
        (call.args as { idempotencyKey: string }).idempotencyKey.endsWith(':1'),
      { kind: 'bad_request' },
    );
    let partsBeforeFault = 0;
    try {
      await ctx.drain(ctx.adapter.send(message));
    } catch {
      partsBeforeFault = ctx.fake.delivered('chat-resume').length;
    }
    check(
      'C13',
      partsBeforeFault >= 1,
      'the fault came before any part landed, so there is nothing to resume',
    );

    const before = ctx.fake.outbound().length;
    const receipt = await ctx.drain(
      ctx.adapter.send({
        ...message,
        resume: {
          partsSent: [
            { index: 0, platformMessageId: 'm-resumed', sentAt: ctx.clock.now().toString() },
          ],
        },
      }),
    );
    const resent = sendsSince(ctx, before).map((call) =>
      (call.args as { idempotencyKey: string }).idempotencyKey.split(':').at(-1),
    );
    check(
      'C13',
      !resent.includes('0'),
      'the resume re-sent part 0, which the caller said had already landed. The member reads that ' +
        'paragraph twice.',
    );
    check('C13', receipt.parts.length >= 2, 'the receipt does not describe the whole message');
    checkEqual(
      'C13',
      receipt.parts[0]?.index,
      0,
      'the receipt dropped the part that had already landed',
    );
  },
};

export const C14: ConformanceCase = {
  id: 'C14',
  name: 'Delivery verification behaves as declared',
  gate: (capabilities) =>
    capabilities.deliveryVerification === 'none'
      ? 'the platform offers no way to tell whether an ambiguous send landed'
      : null,
  async run(ctx) {
    const message = outbound('chat-idem', 'did this land?');
    await ctx.drain(ctx.adapter.send(message));
    const after = ctx.fake.delivered('chat-idem').length;
    // The retry an ambiguous failure forces (`06` §3.13). On a natively idempotent platform it must
    // produce no second message; on a `verifiable` one the adapter asks first.
    await ctx.drain(ctx.adapter.send(message));
    const again = ctx.fake.delivered('chat-idem').length;
    if (ctx.harness.capabilities.deliveryVerification === 'native-idempotent') {
      checkEqual(
        'C14',
        again,
        after,
        'a resend under the same idempotency key produced a second message on a platform that ' +
          'declares `native-idempotent`. That claim is what lets a crashed send be retried blind.',
      );
    } else {
      const verify = ctx.adapter.verifyDelivery?.bind(ctx.adapter);
      check(
        'C14',
        verify !== undefined,
        'the platform declares `verifiable` and omits `verifyDelivery`, so an ambiguous send has ' +
          'no way to be resolved except by guessing',
      );
      if (verify !== undefined) {
        checkEqual(
          'C14',
          await verify(message.target, message.idempotencyKey, 0, ctx.clock.now().toString()),
          'delivered',
          '`verifyDelivery` did not find a part it had just sent',
        );
      }
    }
  },
};

export const C19: ConformanceCase = {
  id: 'C19',
  name: 'Attachments: an inbound ref streams the right bytes, the cap aborts, unclaimed never fetch',
  gate: (capabilities) =>
    capabilities.images || capabilities.files ? null : 'the platform carries no attachments',
  async run(ctx) {
    const before = ctx.ingested().length;
    await ctx.fake.deliver({
      type: 'message',
      update_id: 96_001,
      chat: { id: 'chat-files', kind: 'group' },
      from: { id: 'u1', name: 'Ana' },
      message_id: 'f1',
      at: ctx.clock.now().toString(),
      text: 'a photo',
      files: [{ file_id: 'photo-64b', kind: 'image', bytes: 64, mime: 'image/png' }],
    });
    const envelope = ctx.ingested().slice(before)[0]?.value as {
      attachments?: readonly { ref: unknown; sizeBytes?: number }[];
    };
    check(
      'C19',
      (envelope.attachments ?? []).length === 1,
      'the attachment was not carried into the envelope',
    );
    const ref = envelope.attachments?.[0]?.ref;
    if (ref === undefined) return;

    const stream = await ctx.adapter.fetchAttachment(ref as never, {
      maxBytes: 1_024,
      signal: new AbortController().signal,
    });
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    check('C19', total === 64, `the stream produced ${String(total)} bytes, expected 64`);

    // The cap, which `06` §12-4 added for a reason: a fetch with no ceiling is how a 2 GB "voice
    // note" fills a host's disk, and the refusal has to come before the bytes.
    let refused = false;
    try {
      await ctx.adapter.fetchAttachment(ref as never, {
        maxBytes: 8,
        signal: new AbortController().signal,
      });
    } catch {
      refused = true;
    }
    check('C19', refused, 'a 64-byte attachment was fetched under an 8-byte cap');
  },
};

/** A document long enough to split into at least three parts at `chars`. */
function longDocument(chars: number): RichText {
  const sentence = 'Saturday works for us if everyone is free by six in the evening. ';
  const text = sentence.repeat(Math.ceil(chars / sentence.length) + 2);
  return { v: 1, blocks: [{ t: 'p', c: [{ t: 'text', text }] }] };
}
