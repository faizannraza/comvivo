/**
 * The simulator's own suite (`06` §3.21.7; `M3-T11`).
 *
 * `conformance.test.ts` runs `06` §3.25's 24 cases on four profiles and covers the contract an
 * adapter shares with every other adapter. This file covers what is the **simulator's** and
 * nothing else's: the three send-idempotency classes, ambiguous success, privacy mode, the thirteen
 * fault kinds, the ledger, and the two refusals that exist to stop a scenario quietly measuring
 * something other than what it says.
 */
import {
  CHANNEL_ERROR_KINDS,
  ChannelError,
  type OutboundMessage,
  profiles,
} from '@comvivo/channel-sdk';
import { createTestContext, type TestContext } from '@comvivo/channel-sdk/testing';
import { BRAND } from '@comvivo/shared';
import { VirtualClock } from '@comvivo/shared/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createSimulator,
  DEDUPE_WINDOW_MS,
  idempotencyClassOf,
  SimPlatform,
  type Simulator,
} from './index.js';
import { arrayRecordSink } from './record.js';

const START = '2026-11-16T09:00:00Z';
const NOTICE = '… (truncated)';

function build(profile: 'telegram' | 'signal' | 'web' | 'ideal' = 'telegram'): {
  clock: VirtualClock;
  sim: Simulator;
  context: TestContext;
} {
  const clock = new VirtualClock(START);
  const sim = createSimulator({
    profile,
    clock,
    timers: clock,
    seed: 100,
    truncationNotice: NOTICE,
    selfId: 'sim-bot',
    selfName: BRAND.botDefaultName,
  });
  const context = createTestContext({ channel: 'simulator', clock });
  return { clock, sim, context };
}

function message(chat: string, text: string, key = `turn-1:${chat}`): OutboundMessage {
  return {
    idempotencyKey: key,
    target: { channel: 'simulator', platformChatId: chat, chatKind: 'group' },
    body: { v: 1, blocks: [{ t: 'p', c: [{ t: 'text', text }] }] },
    messageClass: 'reply',
    priority: 'interactive',
    mentions: {},
  };
}

/**
 * The `ChannelError` `work` failed with.
 *
 * A helper rather than a `.catch(error => error as ChannelError)`, which types the result as the
 * union of the receipt and the error and then reads a field off whichever it is — so a send that
 * *succeeded* when the case expected a refusal would read `undefined` and the assertion would
 * compare `undefined` to a string. That is a passing test for the wrong reason, and the whole-tree
 * typecheck named it.
 */
async function failureOf(work: Promise<unknown>): Promise<ChannelError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ChannelError) return error;
    throw error;
  }
  throw new Error('expected the operation to fail with a ChannelError, and it succeeded');
}

/**
 * Run `work` to completion, firing virtual timers as it waits on them.
 *
 * The same shape as the conformance kit's own `drain`, and for the same reason: a conformant
 * adapter waits on timers — a rate-limit bucket, a retry backoff — and in virtual time nothing
 * fires them unless a test does. `state` is an object rather than a `let` because TypeScript keeps
 * a local's narrowing across an `await` and would call the loop condition always-true.
 */
async function drain<T>(clock: VirtualClock, work: Promise<T>): Promise<T> {
  const state = { done: false };
  const isDone = (): boolean => state.done;
  const tracked = work.then(
    (value) => {
      state.done = true;
      return { ok: true as const, value };
    },
    (error: unknown) => {
      state.done = true;
      return { ok: false as const, error };
    },
  );
  for (let hop = 0; hop < 400; hop += 1) {
    for (let flush = 0; flush < 64; flush += 1) await Promise.resolve();
    if (isDone()) break;
    const due = clock.nextDueAt();
    if (due === null) continue;
    await clock.advanceTo(due);
  }
  const outcome = await tracked;
  if (outcome.ok) return outcome.value;
  throw outcome.error;
}

describe('the simulator refuses what it cannot honestly emulate', () => {
  it('refuses a profile whose renderer arrives in M8', () => {
    const clock = new VirtualClock(START);
    expect(() =>
      createSimulator({
        profile: 'discord',
        clock,
        timers: clock,
        seed: 1,
        truncationNotice: NOTICE,
      }),
    ).toThrow(/discord-md/);
  });

  it('refuses a context whose clock is not its own', async () => {
    // Two clocks in a deterministic run drift, and the symptom is a scenario that fails once in
    // forty runs rather than an error anybody can read.
    const { sim } = build();
    const other = new VirtualClock(START);
    const foreign = createTestContext({ channel: 'simulator', clock: other });
    await expect(sim.adapter.start(foreign.ctx)).rejects.toThrow(/different clock/);
  });
});

describe('send idempotency by class (11 §3.6 S10)', () => {
  it('answers a repeat with the first message on a `native` platform', async () => {
    const { clock, sim, context } = build('web');
    await sim.adapter.start(context.ctx);
    const first = await drain(clock, sim.adapter.send(message('chat-1', 'hello')));
    const again = await drain(clock, sim.adapter.send(message('chat-1', 'hello')));
    expect(again.parts[0]?.platformMessageId).toBe(first.parts[0]?.platformMessageId);
    expect(sim.control.delivered('chat-1')).toHaveLength(1);
  });

  it('creates a second message on a platform with no idempotency', async () => {
    // Telegram's class. Nothing can prevent it, which is why `11` §3.6 gates duplicates at zero
    // only for `native` — and why the ledger has to record the key, so an oracle can count them.
    const { clock, sim, context } = build('telegram');
    await sim.adapter.start(context.ctx);
    await drain(clock, sim.adapter.send(message('chat-1', 'hello')));
    await drain(clock, sim.adapter.send(message('chat-1', 'hello')));
    expect(sim.control.delivered('chat-1')).toHaveLength(2);
    const repeats = sim.control.ledger().filter((entry) => entry.duplicateOf !== undefined);
    expect(repeats).toHaveLength(1);
  });

  it('forgets a key once its window has passed on a `dedupe-window` platform', async () => {
    // Slack's class: verifiable, not idempotent. A resend inside the window is absorbed and one an
    // hour later is a new message, which is what makes the class worth modelling rather than
    // rounding to one of the other two.
    //
    // Driven through the **platform** rather than the adapter, because Slack's markup has no
    // renderer until M8 and `createSimulator` refuses that profile. The platform has no renderer in
    // it, so the class is testable today and the profile is not.
    const clock = new VirtualClock(START);
    const platform = new SimPlatform({
      clock,
      timers: clock,
      capabilities: profiles.slack,
      seed: 1,
    });
    expect(platform.idempotencyClass).toBe('dedupe-window');
    const send = (): Promise<unknown> =>
      platform.call('sendMessage', {
        chat: 'chat-1',
        idempotencyKey: 'turn-1:0',
        payload: 'hello',
        plainText: 'hello',
      });
    const first = (await send()) as { message_id: string };
    const inside = (await send()) as { message_id: string; deduped: boolean };
    expect(inside.deduped).toBe(true);
    expect(inside.message_id).toBe(first.message_id);

    await clock.advance({ seconds: DEDUPE_WINDOW_MS / 1000 + 1 });
    const outside = (await send()) as { message_id: string; deduped: boolean };
    expect(outside.deduped).toBe(false);
    expect(outside.message_id).not.toBe(first.message_id);
  });

  it('maps every `deliveryVerification` value to a class', () => {
    // A total mapping, so a fourth value added to `06` §4.1 is a compile error in
    // `idempotencyClassOf` rather than a profile that silently behaves like `none`.
    expect(idempotencyClassOf(profiles.web)).toBe('native');
    expect(idempotencyClassOf(profiles.slack)).toBe('dedupe-window');
    expect(idempotencyClassOf(profiles.telegram)).toBe('none');
  });
});

describe('ambiguous success (11 §3.6 S10)', () => {
  it('lands the message and fails the call, and the retry is marked a possible duplicate', async () => {
    const { clock, sim, context } = build('telegram');
    await sim.adapter.start(context.ctx);
    sim.control.failNext('ambiguous', { ambiguous: true });
    const receipt = await drain(clock, sim.adapter.send(message('chat-1', 'did that land?')));
    // Two messages exist on the platform: the one the fault let through and the retry. On a
    // platform with no idempotency that is unavoidable, and the receipt has to say so — `06` §3.13
    // allows at most one such part.
    expect(sim.control.delivered('chat-1')).toHaveLength(2);
    expect(receipt.parts[0]?.possibleDuplicate).toBe(true);
    expect(sim.control.ledger().some((entry) => entry.faultApplied === 'ambiguous')).toBe(true);
  });

  it('refuses a fault that claims a kind which cannot have been delivered', () => {
    // My own first version of the case above armed `transient` with `ambiguous: true` and read
    // the adapter's correct behaviour as a missing `possibleDuplicate`. The scenario was wrong,
    // so the platform refuses it now rather than quietly meaning something else.
    const { sim } = build('telegram');
    expect(() => sim.control.failNext('transient', { ambiguous: true })).toThrow(
      /cannot be .*transient.* and ambiguous at once/,
    );
  });

  it('does not mark a duplicate when the platform deduplicates', async () => {
    const { clock, sim, context } = build('web');
    await sim.adapter.start(context.ctx);
    sim.control.failNext('ambiguous', { ambiguous: true });
    const receipt = await drain(clock, sim.adapter.send(message('chat-1', 'hello')));
    expect(sim.control.delivered('chat-1')).toHaveLength(1);
    expect(receipt.parts[0]?.possibleDuplicate).toBeUndefined();
  });
});

describe('fault injection covers every `ChannelErrorKind` (06 §3.15)', () => {
  it('produces all thirteen kinds, each mapped to a `ChannelError`', async () => {
    // The acceptance criterion, as a test rather than a claim. The engine selects its recovery on
    // the kind, so a kind the simulator cannot produce is a recovery nothing has ever run.
    const seen = new Set<string>();
    for (const kind of CHANNEL_ERROR_KINDS) {
      const { clock, sim, context } = build('telegram');
      await sim.adapter.start(context.ctx);
      // Enough shots to outlast the retry budget for the kinds `06` §3.14 backs off on.
      sim.control.failNext(kind, { times: 12, retryAfterMs: kind === 'rate_limited' ? 10 : 0 });
      try {
        await drain(clock, sim.adapter.send(message(`chat-${kind}`, 'x')));
        // `rate_limited` is retried without a budget, so it resolves rather than surfacing — which
        // is `06` §3.14 working, and what `CHANNEL_ERROR_KINDS` coverage means for it is that the
        // platform answered it at all.
        if (sim.control.outbound().filter((call) => call.method === 'sendMessage').length > 1) {
          seen.add(kind);
        }
      } catch (error) {
        expect(error).toBeInstanceOf(ChannelError);
        expect((error as ChannelError).kind).toBe(kind);
        seen.add(kind);
      }
    }
    expect([...seen].toSorted()).toEqual([...CHANNEL_ERROR_KINDS].toSorted());
  });

  it('carries `retryAfterMs` and `newPlatformChatId` through to the error', async () => {
    const { clock, sim, context } = build('telegram');
    await sim.adapter.start(context.ctx);
    sim.control.failNext('chat_migrated', { newPlatformChatId: 'chat-new' });
    const failure = await failureOf(drain(clock, sim.adapter.send(message('chat-old', 'x'))));
    expect(failure.details.newPlatformChatId).toBe('chat-new');
  });
});

describe('privacy mode (06 §3.23.1)', () => {
  let built: ReturnType<typeof build>;
  beforeEach(async () => {
    built = build('telegram');
    await built.sim.adapter.start(built.context.ctx);
  });

  it('hides a message that does not name the bot from a non-admin bot', async () => {
    built.sim.control.setPrivacyMode(true);
    await built.sim.control.user('u1', 'Ana').says('chat-1', 'just chatting');
    expect(built.context.ingested()).toHaveLength(0);
    await built.sim.control
      .user('u1', 'Ana')
      .says('chat-1', `hey @${BRAND.botDefaultName}`, { mentionsBot: true });
    expect(built.context.ingested()).toHaveLength(1);
  });

  it('shows everything once the bot is an admin, which is what `requires-setup` means', async () => {
    built.sim.control.setPrivacyMode(true);
    built.sim.control.setChatState('chat-1', { isAdmin: true });
    await built.sim.control.user('u1', 'Ana').says('chat-1', 'just chatting');
    expect(built.context.ingested()).toHaveLength(1);
  });

  it('shows a reply to one of the bot’s own messages, which names it without naming it', async () => {
    // Telegram's privacy mode passes a reply to the bot through, and it has to: "yes please" as a
    // reply to a confirmation is the most common answer a member gives, and a simulator that
    // dropped it would make every `buttons: false` confirmation flow untestable on the one profile
    // whose renderer exists. Earned by a drill that removed the clause and passed.
    built.sim.control.setPrivacyMode(true);
    await built.sim.control
      .user('u1', 'Ana')
      .says('chat-1', 'yes please', { replyTo: 'b1', replyToIsBot: true });
    expect(built.context.ingested()).toHaveLength(1);
    // And a reply to **another member** is still hidden, or the clause would be "any reply".
    await built.sim.control
      .user('u1', 'Ana')
      .says('chat-1', 'sure', { replyTo: 'm1', replyToIsBot: false });
    expect(built.context.ingested()).toHaveLength(1);
  });

  it('never hides a DM, which has no privacy mode to apply', async () => {
    built.sim.control.setPrivacyMode(true);
    const dm = await built.sim.control.user('u1', 'Ana').opensDm();
    await built.sim.control.user('u1', 'Ana').says(dm, 'remind me on Friday');
    const texts = built.context
      .ingested()
      .filter((item) => item.kind === 'envelope')
      .map((item) => (item.value as { text: string }).text);
    expect(texts).toContain('remind me on Friday');
  });
});

describe('the control surface', () => {
  it('gives a chat its own message sequence', async () => {
    const { sim, context } = build();
    await sim.adapter.start(context.ctx);
    const ana = sim.control.user('u1', 'Ana');
    expect(await ana.says('chat-a', 'one')).toBe('m1');
    expect(await ana.says('chat-b', 'one')).toBe('m1');
    expect(await ana.says('chat-a', 'two')).toBe('m2');
  });

  it('reads a transcript back with the renderer’s own payload', async () => {
    const { clock, sim, context } = build('telegram');
    await sim.adapter.start(context.ctx);
    await sim.control.user('u1', 'Ana').says('chat-1', 'is dinner at six?');
    await drain(clock, sim.adapter.send(message('chat-1', 'Yes, six.')));
    const lines = sim.control.transcript('chat-1');
    expect(lines.map((line) => line.fromBot)).toEqual([false, true]);
    // The *rendered* payload, not the AST: a scenario asserting what a member saw has to read the
    // string the platform was handed.
    expect(lines[1]?.rich).toBe('Yes, six.');
    expect(lines[1]?.idempotencyKey).toBe('turn-1:chat-1:0');
  });

  it('migrates a chat permanently, so a retry against the old id cannot succeed', async () => {
    const { clock, sim, context } = build('telegram');
    await sim.adapter.start(context.ctx);
    sim.control.migrate('chat-old', 'chat-new');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failure = await failureOf(
        drain(clock, sim.adapter.send(message('chat-old', 'x', `turn-${String(attempt)}`))),
      );
      expect(failure.kind).toBe('chat_migrated');
    }
  });

  it('awaits the platform’s quiescence rather than the system’s', async () => {
    // `flush` is deliberately narrow (see `control.ts`): every delivered update handed over and
    // every `ingest` resolved. A scenario needing Village to be quiescent calls `World.settle`.
    const { sim, context } = build();
    await sim.adapter.start(context.ctx);
    const pending = sim.control.user('u1', 'Ana').says('chat-1', 'hello');
    await sim.control.flush();
    await pending;
    expect(context.ingested()).toHaveLength(1);
  });
});

describe('polls (06 §3.8)', () => {
  it('tallies votes delivered as updates and answers `null` when the tally is hidden', async () => {
    const { clock, sim, context } = build('telegram');
    await sim.adapter.start(context.ctx);
    const createPoll = sim.adapter.createPoll?.bind(sim.adapter);
    const closePoll = sim.adapter.closePoll?.bind(sim.adapter);
    expect(createPoll).toBeDefined();
    if (createPoll === undefined || closePoll === undefined) return;
    const ref = await drain(
      clock,
      createPoll({
        target: { channel: 'simulator', platformChatId: 'chat-1' },
        question: 'Which day?',
        options: ['Saturday', 'Sunday'],
        multiSelect: false,
        anonymous: false,
        idempotencyKey: 'poll-1',
      }),
    );
    await sim.control.user('u1', 'Ana').votes(ref, [1]);
    await sim.control.user('u2', 'Sam').votes(ref, [1]);
    const tally = await drain(clock, closePoll(ref));
    expect(tally).toEqual({ counts: [0, 2], totalVoters: 2 });

    sim.control.setPollTallyHidden(true);
    expect(await drain(clock, closePoll(ref))).toBeNull();
  });
});

describe('the recorder', () => {
  it('records both directions and replays the inbound half', async () => {
    const { clock, sim, context } = build('telegram');
    await sim.adapter.start(context.ctx);
    const { sink, lines } = arrayRecordSink();
    const stop = sim.control.recordTo(sink);
    await sim.control.user('u1', 'Ana').says('chat-1', 'is dinner at six?');
    await drain(clock, sim.adapter.send(message('chat-1', 'Yes, six.')));
    stop();
    const directions = lines.map((line) => (JSON.parse(line) as { dir: string }).dir);
    expect(directions).toContain('in');
    expect(directions).toContain('out');

    // A second simulator, fed the recording: the inbound stimulus reappears and the outbound lines
    // are left alone, because they are the expectation rather than the input.
    const replayed = build('telegram');
    await replayed.sim.adapter.start(replayed.context.ctx);
    const result = await replayed.sim.control.replay(lines);
    expect(result.delivered).toBe(1);
    expect(replayed.context.ingested()).toHaveLength(1);
  });

  it('refuses a line the current schema rejects', async () => {
    const { sim, context } = build();
    await sim.adapter.start(context.ctx);
    await expect(
      sim.control.replay([
        JSON.stringify({ dir: 'in', seq: 0, atMs: 0, update: { type: 'nope' } }),
      ]),
    ).rejects.toThrow(/does not match the current schema/);
  });
});
