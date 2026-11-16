/**
 * Every verb on `06` §3.21.7's control surface, and every optional method a profile promises.
 *
 * `M3-T11`'s acceptance criterion opens with "`06` §3.21.7 API with all profiles", and that is a
 * claim about **completeness** rather than about behaviour: a control object missing `.reacts` is a
 * scenario somebody cannot write, and an adapter that declares `reactions: true` and throws on
 * `react` is one the engine will call. The conformance kit covers the methods its 24 cases happen
 * to use; this file walks the rest.
 *
 * It is deliberately broad and shallow. The depth is in `simulator.test.ts` (the idempotency
 * classes, ambiguous success, privacy mode) and in `conformance.test.ts` (the contract). What this
 * adds is that nothing in the published surface is a stub.
 */
import {
  type ChannelAdapter,
  ChannelError,
  type OutboundMessage,
  profiles,
} from '@comvivo/channel-sdk';
import { createTestContext, type TestContext } from '@comvivo/channel-sdk/testing';
import { BRAND } from '@comvivo/shared';
import { VirtualClock } from '@comvivo/shared/testing';
import { describe, expect, it } from 'vitest';
import {
  arrayRecordSink,
  createSimulator,
  replay,
  SIMULATOR_PROFILES,
  SimPlatform,
  SimPlatformError,
  type Simulator,
} from './index.js';

const START = '2026-11-16T09:00:00Z';
const NOTICE = '… (truncated)';

function build(profile: (typeof SIMULATOR_PROFILES)[number] = 'ideal'): {
  clock: VirtualClock;
  sim: Simulator;
  context: TestContext;
} {
  const clock = new VirtualClock(START);
  const context = createTestContext({ channel: 'simulator', clock });
  const sim = createSimulator({
    profile,
    clock,
    timers: clock,
    seed: 7,
    truncationNotice: NOTICE,
    selfName: BRAND.botDefaultName,
    // Platform calls and ingest acks land in one sequence, which is what an ordering assertion
    // needs: in virtual time both happen in the same millisecond and only the order differs.
    onCall: (call) => {
      context.notePlatformAck(call.method);
    },
  });
  return { clock, sim, context };
}

function message(chat: string, text: string, key = `turn:${chat}`): OutboundMessage {
  return {
    idempotencyKey: key,
    target: { channel: 'simulator', platformChatId: chat, chatKind: 'group' },
    body: { v: 1, blocks: [{ t: 'p', c: [{ t: 'text', text }] }] },
    messageClass: 'reply',
    priority: 'interactive',
    mentions: {},
  };
}

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

describe('every control verb reaches the platform', () => {
  it('drives a whole conversation: join, say, reply, react, edit, delete, read, leave', async () => {
    const { sim, context } = build();
    await sim.adapter.start(context.ctx);
    const ana = sim.control.user('u1', 'Ana');
    const sam = sim.control.user('u2', 'Sam');

    await ana.joins('family');
    await sam.joins('family');
    const asked = await ana.says('family', 'is dinner at six?');
    await sam.says('family', 'yes', { replyTo: asked });
    await sam.reacts('family', asked, '👍');
    expect(sim.platform.reactions('family', asked)['👍']).toEqual(['u2']);
    await sam.unreacts('family', asked, '👍');
    expect(sim.platform.reactions('family', asked)['👍']).toBeUndefined();
    await ana.edits('family', asked, 'is dinner at seven?');
    expect(sim.platform.message('family', asked)?.text).toBe('is dinner at seven?');
    await ana.deletes('family', asked);
    expect(sim.platform.message('family', asked)?.deleted).toBe(true);
    await sam.reads('family', asked);
    await sam.leaves('family');
    expect(sim.platform.members('family').map((member) => member.id)).toEqual(['u1']);

    // Every one of those produced an event or an envelope the engine can act on. The count is the
    // assertion that nothing was swallowed: a verb that delivered no update would be a scenario
    // step with no effect, which is the failure mode this file exists for.
    const kinds = context.ingested().map((item) => item.kind);
    expect(kinds.filter((kind) => kind === 'envelope').length).toBeGreaterThanOrEqual(4);
    expect(kinds.filter((kind) => kind === 'event').length).toBeGreaterThanOrEqual(5);
  });

  it('carries a command, an anonymous admin, an attachment and a forward', async () => {
    const { sim, context } = build();
    await sim.adapter.start(context.ctx);
    const ana = sim.control.user('u1', 'Ana');
    await ana.says('family', '/remind buy milk', { command: '/remind' });
    await ana.says('family', 'house rules', { as: 'anonymous_admin' });
    await ana.says('family', 'look', {
      attachments: [{ file_id: 'photo-64b', kind: 'image', bytes: 64, mime: 'image/jpeg' }],
    });
    await ana.says('family', 'from the class group', { forwardedFrom: 'Class group' });
    await ana.says('family', 'a link', { linkPreviews: [{ url: 'https://e.co/x' }] });

    const envelopes = context
      .ingested()
      .filter((item) => item.kind === 'envelope')
      .map((item) => item.value as Record<string, unknown>);
    expect((envelopes[0]?.['interaction'] as { kind: string } | undefined)?.kind).toBe('command');
    expect(envelopes[1]?.['senderKind']).toBe('anonymous_admin');
    expect((envelopes[2]?.['attachments'] as unknown[] | undefined)?.length).toBe(1);
    expect(envelopes[3]?.['forwarded']).toEqual({ fromName: 'Class group' });
    expect(envelopes[4]?.['linkPreviews']).toEqual([{ url: 'https://e.co/x' }]);
  });

  it('opens a DM, blocks it and unblocks it', async () => {
    const { sim, context } = build();
    await sim.adapter.start(context.ctx);
    const ana = sim.control.user('u1', 'Ana');
    const dm = await ana.opensDm();
    expect(dm).toBe('dm:u1');
    await ana.blocksDm();
    await ana.unblocksDm();
    await ana.renames('Ana R.');
    const events = context
      .ingested()
      .filter((item) => item.kind === 'event')
      .map((item) => (item.value as { type: string }).type);
    expect(events).toEqual(['bot_membership', 'dm_blocked', 'dm_unblocked', 'user_updated']);
  });

  it('presses a button with the token the message carried', async () => {
    const { clock, sim, context } = build();
    await sim.adapter.start(context.ctx);
    await drain(clock, sim.adapter.send(message('family', 'pick one')));
    await sim.control.user('u1', 'Ana').clicks('v1.AAAAAAAAAAAAAAAAAAAAAA');
    const pressed = context
      .ingested()
      .map((item) => item.value as { interaction?: { kind: string; payload: { token?: string } } })
      .find((value) => value.interaction?.kind === 'button');
    expect(pressed?.interaction?.payload.token).toBe('v1.AAAAAAAAAAAAAAAAAAAAAA');
  });

  it('adds and kicks the bot, and reports the chat as unsendable afterwards', async () => {
    const { clock, sim, context } = build();
    await sim.adapter.start(context.ctx);
    await sim.control.addBot('family', { by: 'u1', startPayload: 'clm_abc' });
    await sim.control.kickBot('family');
    await expect(drain(clock, sim.adapter.send(message('family', 'hello')))).rejects.toThrow(
      ChannelError,
    );
    const added = context.ingested()[0]?.value as { startPayload?: string };
    expect(added.startPayload).toBe('clm_abc');
  });

  it('revokes and restores the token', async () => {
    const { clock, sim, context } = build();
    await sim.adapter.start(context.ctx);
    sim.control.revokeToken();
    await expect(drain(clock, sim.adapter.send(message('family', 'x')))).rejects.toThrow(
      /auth_revoked/,
    );
    expect(context.health().some((entry) => entry.status === 'auth_failed')).toBe(true);
    sim.control.restoreToken();
    // The adapter stopped its loops when the token died (`06` §3.15), so a restore needs a restart
    // — which is what a host does after fixing the token, and what `M3-T17`'s supervisor will do.
    await sim.adapter.start(context.ctx);
    await expect(drain(clock, sim.adapter.send(message('family', 'x')))).resolves.toBeDefined();
  });

  it('clears armed faults and applies latency from the injected timers', async () => {
    const { clock, sim, context } = build();
    await sim.adapter.start(context.ctx);
    sim.control.failNext('bad_request', { times: 5 });
    sim.control.clearFaults();
    sim.control.setLatency(250);
    const at = clock.now().epochMilliseconds;
    await drain(clock, sim.adapter.send(message('family', 'hello')));
    expect(clock.now().epochMilliseconds - at).toBeGreaterThanOrEqual(250);
  });

  it('drops everything while the connection is down, and resumes after it', async () => {
    const { clock, sim, context } = build();
    await sim.adapter.start(context.ctx);
    sim.control.disconnect(60_000);
    await sim.control.user('u1', 'Ana').says('family', 'anyone there?');
    expect(context.ingested()).toHaveLength(0);
    await clock.advance({ seconds: 61 });
    await sim.control.user('u1', 'Ana').says('family', 'still there?');
    expect(context.ingested()).toHaveLength(1);
  });

  it('sets a chat’s title, forum and encryption state', async () => {
    const { sim, context } = build();
    await sim.adapter.start(context.ctx);
    sim.control.setChatState('family', {
      title: 'The family',
      isForum: true,
      encrypted: true,
      extShared: true,
    });
    const probe = await sim.adapter.probe?.({ channel: 'simulator', platformChatId: 'family' });
    expect(probe?.canSend).toBe(true);
    expect(probe?.diagnostics).toEqual([]);
  });
});

describe('every optional method a profile promises exists and works', () => {
  /** The methods `06` §4.1 makes optional, with the capability that decides each one. */
  const OPTIONAL: readonly {
    readonly method: keyof ChannelAdapter;
    readonly needs: (capabilities: typeof profiles.ideal) => boolean;
  }[] = [
    { method: 'edit', needs: (caps) => caps.edits },
    { method: 'delete', needs: (caps) => caps.deletes },
    { method: 'react', needs: (caps) => caps.reactions },
    { method: 'unreact', needs: (caps) => caps.reactions },
    { method: 'createPoll', needs: (caps) => caps.nativePolls },
    { method: 'closePoll', needs: (caps) => caps.nativePolls },
    { method: 'setTyping', needs: (caps) => caps.typingIndicator },
    { method: 'answerInteraction', needs: (caps) => caps.buttons },
    { method: 'listMembers', needs: (caps) => caps.memberListing !== 'none' },
    { method: 'openDm', needs: (caps) => caps.dmInitiation !== 'none' },
    { method: 'verifyDelivery', needs: (caps) => caps.deliveryVerification !== 'none' },
  ];

  it.each([...SIMULATOR_PROFILES])('matches presence to capability on %s', (profile) => {
    const { sim } = build(profile);
    for (const entry of OPTIONAL) {
      expect(
        sim.adapter[entry.method] !== undefined,
        `${profile}: ${entry.method} is ${sim.adapter[entry.method] === undefined ? 'absent' : 'present'}`,
      ).toBe(entry.needs(profiles[profile]));
    }
  });

  it('edits, deletes, reacts, unreacts and answers an interaction', async () => {
    const { clock, sim, context } = build();
    await sim.adapter.start(context.ctx);
    const receipt = await drain(clock, sim.adapter.send(message('family', 'Yes, six.')));
    const ref = {
      channel: 'simulator' as const,
      platformChatId: 'family',
      platformMessageId: receipt.parts[0]?.platformMessageId ?? 'm1',
    };
    await drain(
      clock,
      sim.adapter.edit?.(ref, message('family', 'Yes, seven.')) ?? Promise.resolve(),
    );
    expect(sim.platform.message('family', ref.platformMessageId)?.text).toBe('Yes, seven.');
    await drain(clock, sim.adapter.react?.(ref, '👍') ?? Promise.resolve());
    expect(sim.platform.reactions('family', ref.platformMessageId)['👍']).toEqual(['sim-bot']);
    await drain(clock, sim.adapter.unreact?.(ref, '👍') ?? Promise.resolve());
    await drain(
      clock,
      sim.adapter.answerInteraction?.('cb-1', { text: 'done' }) ?? Promise.resolve(),
    );
    await drain(clock, sim.adapter.delete?.(ref) ?? Promise.resolve());
    expect(sim.platform.message('family', ref.platformMessageId)?.deleted).toBe(true);
    // And a second delete is `not_found` rather than silence, because the dispatcher decides what
    // to do about a message that is already gone (`06` §3.15).
    // The *kind* rather than the message: the dispatcher selects its recovery on the kind, and a
    // platform's wording is not something a test should pin.
    await expect(
      drain(clock, sim.adapter.delete?.(ref) ?? Promise.resolve()),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('lists members, describes a user and itself, opens a DM, leaves and verifies delivery', async () => {
    const { clock, sim, context } = build();
    await sim.adapter.start(context.ctx);
    await sim.control.user('u1', 'Ana').joins('family');
    const listing = await drain(
      clock,
      sim.adapter.listMembers?.({ channel: 'simulator', platformChatId: 'family' }) ??
        Promise.reject(new Error('no listMembers')),
    );
    expect(listing.members.map((member) => member.displayName)).toEqual(['Ana']);
    expect(listing.completeness).toBe('exact');

    const user = await drain(
      clock,
      sim.adapter.describeUser?.('u1') ?? Promise.reject(new Error('no describeUser')),
    );
    expect(user.displayName).toBe('Ana');
    await expect(
      drain(clock, sim.adapter.describeUser?.('nobody') ?? Promise.resolve(undefined)),
    ).rejects.toMatchObject({ kind: 'not_found' });

    const self = await sim.adapter.describeSelf();
    expect(self.platformUserId).toBe('sim-bot');
    expect(self.displayName).toBe(BRAND.botDefaultName);

    const dm = await drain(
      clock,
      sim.adapter.openDm?.('u1') ?? Promise.reject(new Error('no openDm')),
    );
    expect(dm.platformChatId).toBe('dm:u1');

    const sent = await drain(clock, sim.adapter.send(message('family', 'hello', 'turn-v')));
    expect(sent.parts).toHaveLength(1);
    const verdict = await drain(
      clock,
      sim.adapter.verifyDelivery?.(
        { channel: 'simulator', platformChatId: 'family' },
        'turn-v',
        0,
        START,
      ) ?? Promise.reject(new Error('no verifyDelivery')),
    );
    expect(verdict).toBe('delivered');

    await drain(
      clock,
      sim.adapter.leave?.({ channel: 'simulator', platformChatId: 'family' }) ?? Promise.resolve(),
    );
    expect(sim.platform.canSend('family')).toBe(false);
  });

  it('answers `unknown` for a verification a platform cannot make', () => {
    // Telegram's class. `06` §3.13 branches on it, so a simulator that always answered
    // `delivered` would make the branch that matters untestable.
    const { sim } = build('telegram');
    expect(sim.adapter.verifyDelivery).toBeUndefined();
  });

  it('streams an attachment, and refuses one over the cap', async () => {
    const { clock, sim, context } = build();
    await sim.adapter.start(context.ctx);
    const ref = { channel: 'simulator' as const, data: { file_id: 'photo-64b' } };
    const stream = await drain(
      clock,
      sim.adapter.fetchAttachment(ref, { maxBytes: 1024, signal: AbortSignal.timeout(60_000) }),
    );
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
    expect(chunks[0]?.length).toBe(64);
    await expect(
      drain(
        clock,
        sim.adapter.fetchAttachment(ref, { maxBytes: 8, signal: AbortSignal.timeout(60_000) }),
      ),
    ).rejects.toThrow(/against a 8 cap/);
  });

  it('builds a permalink and the two deep links, synchronously', () => {
    const { sim } = build();
    expect(
      sim.adapter.permalink?.({
        channel: 'simulator',
        platformChatId: 'family',
        platformMessageId: 'm1',
      }),
    ).toBe('sim://family/m1');
    expect(sim.adapter.dmLink?.('lnk_abc')).toBe('sim://dm?start=lnk_abc');
    expect(sim.adapter.addToGroupLink?.('onb_family')).toBe('sim://addgroup?start=onb_family');
  });

  it('refuses a call before `start`, rather than reaching for an absent context', async () => {
    const { clock, sim } = build();
    await expect(drain(clock, sim.adapter.send(message('family', 'x')))).rejects.toThrow(
      /not started/,
    );
  });
});

describe('the order and the identity of what reaches the platform', () => {
  it('acks an update to the platform only after the ingest has resolved', async () => {
    // `06` §3.25's C05 asserts this for a platform that *has* an ack, and treats a platform with
    // none as vacuously correct — which is right for the kit and wrong as a test of this adapter,
    // because this one has an ack. A drill that deleted the call entirely passed the kit. The
    // order is the whole point: a crash between the two makes the platform redeliver, which the
    // dedupe key absorbs, while a crash the other way round loses the message for good.
    const { sim, context } = build();
    await sim.adapter.start(context.ctx);
    await sim.control.user('u1', 'Ana').says('family', 'hello');
    const trace = context.trace();
    const ingestAt = trace.findIndex((entry) => entry.startsWith('ingest:'));
    const ackAt = trace.findIndex((entry) => entry === 'call:ackUpdate');
    expect(ingestAt, 'the message was never ingested').toBeGreaterThanOrEqual(0);
    expect(ackAt, 'the update was never acked to the platform').toBeGreaterThan(ingestAt);
  });

  it('refuses a send to a chat the bot is muted in, with the right kind', async () => {
    // Distinct from being removed: the bot is still present, still sees everything, and cannot
    // post — `06` §3.20.3's `channel.cannot_post`, which a host fixes by changing a permission
    // rather than by re-adding the bot. A drill that let the send through passed, because the only
    // test of a refused send went through `kickBot`, which is the other branch.
    const { clock, sim, context } = build();
    await sim.adapter.start(context.ctx);
    sim.control.setChatState('family', { canSend: false });
    await expect(drain(clock, sim.adapter.send(message('family', 'hello')))).rejects.toMatchObject({
      kind: 'permission_missing',
    });
    sim.control.setChatState('family', { canSend: true });
    await expect(drain(clock, sim.adapter.send(message('family', 'hello')))).resolves.toBeDefined();
  });

  it('numbers the bot’s own messages per chat, like a member’s', async () => {
    // `06` §3.21.7: "message ids are sequential per chat". The member half had a test and the bot
    // half did not, and the two counters were briefly separate code — so a drill that numbered bot
    // messages globally passed. A collision between the two is the real risk: an id a member's
    // message already holds would make a reply target the wrong message.
    const { clock, sim, context } = build();
    await sim.adapter.start(context.ctx);
    const first = await drain(clock, sim.adapter.send(message('a', 'one', 'k1')));
    const other = await drain(clock, sim.adapter.send(message('b', 'one', 'k2')));
    const second = await drain(clock, sim.adapter.send(message('a', 'two', 'k3')));
    expect(first.parts[0]?.platformMessageId).toBe('m1');
    expect(other.parts[0]?.platformMessageId).toBe('m1');
    expect(second.parts[0]?.platformMessageId).toBe('m2');
    // And a member's message shares the sequence, because it shares the chat.
    expect(await sim.control.user('u1', 'Ana').says('a', 'three')).toBe('m3');
  });

  it('keeps a replayed id from colliding with the next send', async () => {
    // A recording carries ids this process never issued. Without the counter catching up, the next
    // bot send in that chat reuses one — and a reply in a replayed scenario would target a
    // different message than it did in the recording.
    const { clock, sim, context } = build();
    await sim.adapter.start(context.ctx);
    await sim.control.replay([
      JSON.stringify({
        dir: 'in',
        seq: 0,
        atMs: 0,
        update: {
          type: 'message',
          update_id: 1,
          chat: { id: 'family', kind: 'group' },
          from: { id: 'u1', name: 'Ana' },
          message_id: 'm7',
          at: START,
          text: 'recorded',
        },
      }),
    ]);
    const sent = await drain(clock, sim.adapter.send(message('family', 'after')));
    expect(sent.parts[0]?.platformMessageId).toBe('m8');
  });

  it('records one option from a two-option vote on a single-select poll', async () => {
    // The platform's rule rather than the client's: a single-select poll that stored both would
    // make `07`'s tally disagree with what every member saw, and a drill that ignored
    // `multiSelect` passed because the only vote in the suite chose one option anyway.
    const { clock, sim, context } = build();
    await sim.adapter.start(context.ctx);
    const ref = await drain(
      clock,
      sim.adapter.createPoll?.({
        target: { channel: 'simulator', platformChatId: 'family' },
        question: 'Which day?',
        options: ['Sat', 'Sun'],
        multiSelect: false,
        anonymous: false,
        idempotencyKey: 'poll-single',
      }) ?? Promise.reject(new Error('no createPoll')),
    );
    await sim.control.user('u1', 'Ana').votes(ref, [0, 1]);
    expect(sim.platform.pollTally(ref.platformPollId)).toEqual({
      counts: [1, 0],
      total_voters: 1,
    });
  });
});

describe('the platform’s own limits', () => {
  it('honours the bot’s reaction cap, which is one on Telegram', async () => {
    const { clock, sim, context } = build('telegram');
    await sim.adapter.start(context.ctx);
    const receipt = await drain(clock, sim.adapter.send(message('family', 'hello')));
    const ref = {
      channel: 'simulator' as const,
      platformChatId: 'family',
      platformMessageId: receipt.parts[0]?.platformMessageId ?? 'm1',
    };
    expect(profiles.telegram.maxReactionsPerMessage).toBe(1);
    await drain(clock, sim.adapter.react?.(ref, '👍') ?? Promise.resolve());
    // The second one is refused by the platform, which is the behaviour `06` §3.9 warns about and
    // the reason `M3-T6` made `maxReactionsPerMessage` a condition on the reaction fallback.
    await expect(drain(clock, sim.adapter.react?.(ref, '❤️') ?? Promise.resolve())).rejects.toThrow(
      /one|1 reaction/,
    );
  });

  it('refuses a delete past the platform’s window', async () => {
    const { clock, sim, context } = build('telegram');
    await sim.adapter.start(context.ctx);
    const receipt = await drain(clock, sim.adapter.send(message('family', 'hello')));
    const ref = {
      channel: 'simulator' as const,
      platformChatId: 'family',
      platformMessageId: receipt.parts[0]?.platformMessageId ?? 'm1',
    };
    await clock.advance({ hours: 49 });
    await expect(drain(clock, sim.adapter.delete?.(ref) ?? Promise.resolve())).rejects.toThrow(
      /window/,
    );
  });

  it('shows the typing indicator and clears it', async () => {
    const { clock, sim, context } = build();
    await sim.adapter.start(context.ctx);
    const chat = { channel: 'simulator' as const, platformChatId: 'family' };
    await drain(clock, sim.adapter.setTyping?.(chat, true) ?? Promise.resolve());
    expect(sim.platform.typingSince('family')).not.toBeNull();
    await drain(clock, sim.adapter.setTyping?.(chat, false) ?? Promise.resolve());
    expect(sim.platform.typingSince('family')).toBeNull();
  });

  it('lists its chats and refuses a vote on a closed poll', async () => {
    const clock = new VirtualClock(START);
    const platform = new SimPlatform({
      clock,
      timers: clock,
      capabilities: profiles.ideal,
      seed: 1,
    });
    const poll = (await platform.call('createPoll', {
      chat: 'family',
      question: 'Which day?',
      options: ['Sat', 'Sun'],
      multiSelect: true,
      idempotencyKey: 'p1',
    })) as { poll_id: string };
    platform.vote(poll.poll_id, 'u1', [0, 1]);
    expect(platform.pollTally(poll.poll_id)).toEqual({ counts: [1, 1], total_voters: 1 });
    await platform.call('closePoll', { chat: 'family', poll_id: poll.poll_id });
    expect(() => platform.vote(poll.poll_id, 'u2', [0])).toThrow(SimPlatformError);
    expect(() => platform.vote('no-such-poll', 'u2', [0])).toThrow(/no such poll/);
    expect(platform.chats()).toEqual(['family']);
    expect(platform.pollTally('no-such-poll')).toBeNull();
    expect(platform.migratedTo('family')).toBeUndefined();
  });
});

describe('record and replay', () => {
  it('moves the clock when the caller supplies a way to, and skips bad lines when asked', async () => {
    const { clock, sim, context } = build();
    await sim.adapter.start(context.ctx);
    const { sink, lines } = arrayRecordSink();
    sim.control.recordTo(sink);
    await sim.control.user('u1', 'Ana').says('family', 'first');
    await clock.advance({ minutes: 2 });
    await sim.control.user('u1', 'Ana').says('family', 'second');

    const replayed = build();
    await replayed.sim.adapter.start(replayed.context.ctx);
    const steps: number[] = [];
    const result = await replay(lines, replayed.sim.platform, {
      advanceTo: async (atMs) => {
        steps.push(atMs);
        await replayed.clock.advance({
          milliseconds: Math.max(0, atMs - replayed.sim.platform.nowMs()),
        });
      },
    });
    expect(result.delivered).toBe(2);
    // The gap is the point: two messages two minutes apart test coalescing, and the same two back
    // to back test cancellation. A replay that lost the timing would be a different scenario.
    expect(steps).toEqual([0, 120_000]);

    const skipped = await replay(
      ['{"dir":"in","seq":0,"atMs":0,"update":{"type":"nope"}}'],
      sim.platform,
      {
        strict: false,
      },
    );
    expect(skipped).toEqual({ delivered: 0, skipped: 1 });
    expect(await replay(['', '  '], sim.platform)).toEqual({ delivered: 0, skipped: 0 });
  });
});
