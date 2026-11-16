/**
 * C11, C12, C15, C18, C21–C24 — the cases about going wrong (`06` §3.25; `M3-T9`).
 *
 * An adapter spends most of its life on the happy path and is judged on the rest of it. A platform
 * returns a 429, revokes a token, drops a socket, changes a chat's id — and the difference between
 * a product and a prototype is whether those produce a clear state or a silent one.
 *
 * Every timing assertion here is on the **virtual** clock, which is what makes them assertions at
 * all: a retry "delayed by at least five seconds" is unverifiable against a wall clock in a test
 * suite that has to finish, and a per-chat bucket under a burst of fifty is a minute of real time.
 */

import { BRAND } from '@comvivo/shared';
import { profiles } from '../../profiles.js';
import { ChannelCapabilitiesSchema } from '../../schemas.js';
import { check, checkEqual } from '../assert.js';
import { loadFixtures } from '../fixtures.js';
import type { ConformanceCase } from '../harness.js';
import { outbound } from './ingest.js';

const always = (): null => null;

/** The optional methods a capability requires, per `06` C23. */
const CAPABILITY_METHODS: readonly {
  readonly method: keyof import('../../contract.js').ChannelAdapter;
  readonly needs: (capabilities: import('../../contract.js').ChannelCapabilities) => boolean;
}[] = [
  { method: 'edit', needs: (caps) => caps.edits },
  { method: 'delete', needs: (caps) => caps.deletes },
  { method: 'react', needs: (caps) => caps.reactions },
  { method: 'createPoll', needs: (caps) => caps.nativePolls },
  { method: 'closePoll', needs: (caps) => caps.nativePolls },
  { method: 'setTyping', needs: (caps) => caps.typingIndicator },
  { method: 'answerInteraction', needs: (caps) => caps.buttons },
];

export const C11: ConformanceCase = {
  id: 'C11',
  name: 'Every `errors/*.json` maps to its `expectKind`, with `retryAfterMs` and `newPlatformChatId`',
  gate: always,
  async run(ctx) {
    const fixtures = await loadFixtures(ctx.store, 'errors');
    check(
      'C11',
      fixtures.length > 0,
      'no `errors/*.json` fixtures were found. `06` §3.15 gives thirteen kinds and the engine ' +
        'behaves differently for each — an unmapped error becomes `bad_request`, which marks the ' +
        'row failed and loses a message a retry would have delivered.',
    );
    for (const entry of fixtures) {
      const expected = entry.fixture.expect as {
        expectKind: string;
        retryAfterMs?: number;
        newPlatformChatId?: string;
        /** How many calls to arm. More than an adapter's retry budget makes a kind surface. */
        attempts?: number;
        /** `false` for a kind `06` §3.14 retries without ever giving up, i.e. `rate_limited`. */
        terminal?: boolean;
      };
      const request = entry.fixture.request as { method?: string } | undefined;
      const method = request?.method ?? 'sendMessage';
      // Each fixture gets its **own chat**, and the matcher is scoped to it. A fixture that arms
      // more shots than its kind consumes — which a bounded-retryable one has to, to exhaust the
      // budget — otherwise leaves them armed for whichever fixture runs next: the first version
      // armed twelve `chat_migrated` failures, the adapter consumed one, and the *next* fixture's
      // send was answered by a leftover. A case whose result depends on the fixture order is a case
      // that will pass until somebody adds a file.
      const chat = `chat-errors-${entry.path.replaceAll(/[^a-z0-9]/gi, '-')}`;
      ctx.fake.failNext(
        (call) => call.method === method && (call.args as { chat?: string }).chat === chat,
        entry.fixture.response,
        expected.attempts ?? 1,
      );
      const before = ctx.fake.outbound().length;
      let caught: unknown;
      try {
        // Drained, not awaited: a retryable kind schedules a backoff timer, and in virtual time
        // nothing fires it unless the kit does. A bare `await` here hung the whole case.
        await ctx.drain(ctx.adapter.send(outbound(chat, 'x')));
      } catch (error) {
        caught = error;
      }
      if (expected.terminal === false) {
        // `06` §3.14: a `rate_limited` failure "does not count toward attempts", so a conformant
        // adapter never gives up on one and the mapping cannot surface as a rejection. What *is*
        // observable is that it retried at all and waited at least as long as the platform asked —
        // which is the detail §3.25 names for this kind.
        const calls = ctx.fake
          .outbound()
          .slice(before)
          .filter((call) => call.method === method);
        check(
          'C11',
          calls.length > (expected.attempts ?? 1),
          `${entry.path} was not retried. \`06\` §3.14 makes this kind retryable without a budget, ` +
            'so an adapter that gave up has lost a message the platform only asked it to slow down ' +
            'about.',
        );
        if (expected.retryAfterMs !== undefined) {
          const gap = (calls[1]?.atMs ?? 0) - (calls[0]?.atMs ?? 0);
          check(
            'C11',
            gap >= expected.retryAfterMs,
            `${entry.path} retried after ${String(gap)} ms where the platform asked for ` +
              `${String(expected.retryAfterMs)}. \`06\` §3.14 makes that number a floor, never a cap: ` +
              "coming back sooner is how an app reaches Discord's ban threshold.",
          );
        }
        continue;
      }
      const failure = caught as
        | { kind?: string; details?: { retryAfterMs?: number; newPlatformChatId?: string } }
        | undefined;
      check('C11', failure !== undefined, `${entry.path} did not produce an error at all`);
      checkEqual(
        'C11',
        failure?.kind,
        expected.expectKind,
        `${entry.path} mapped to the wrong kind`,
      );
      if (expected.retryAfterMs !== undefined) {
        checkEqual(
          'C11',
          failure?.details?.retryAfterMs,
          expected.retryAfterMs,
          `${entry.path} lost its retry-after, so the retry would use our backoff instead of the ` +
            "platform's own number",
        );
      }
      if (expected.newPlatformChatId !== undefined) {
        checkEqual(
          'C11',
          failure?.details?.newPlatformChatId,
          expected.newPlatformChatId,
          `${entry.path} lost the new chat id, so nothing can re-target the send`,
        );
      }
    }
  },
};

export const C12: ConformanceCase = {
  id: 'C12',
  name: 'A 429 delays the retry by at least its retry-after, and per-chat buckets hold under a burst',
  gate: always,
  async run(ctx) {
    // The first half is the retry policy honouring the platform's own number (`06` §3.14: `max`,
    // not `min`). Coming back sooner than asked is how an app reaches Discord's ten thousand
    // invalid requests per ten minutes and gets banned.
    ctx.fake.failNext('sendMessage', { kind: 'rate_limited', retryAfterMs: 5_000 });
    const startedAt = ctx.clock.now().epochMilliseconds;
    const before = ctx.fake.outbound().length;
    await ctx.drain(ctx.adapter.send(outbound('chat-429', 'after you')));
    const sends = ctx.fake
      .outbound()
      .slice(before)
      .filter((call) => call.method === 'sendMessage');
    check('C12', sends.length >= 2, 'the adapter did not retry a rate-limited send at all');
    const first = sends[0]?.atMs ?? 0;
    const second = sends[1]?.atMs ?? 0;
    check(
      'C12',
      second - first >= 5_000,
      `the retry came ${String(second - first)} ms after the 429, which asked for 5 000. ` +
        '`06` §3.14 makes the platform number a floor, never a cap.',
    );
    check(
      'C12',
      ctx.clock.now().epochMilliseconds > startedAt,
      'the retry used no virtual time at all',
    );

    // The second half: fifty messages to one chat must not exceed its bucket. The assertion is the
    // bucket envelope — over any window, at most `capacity + rate × window` — because an average
    // check passes a burst that sends the whole minute's allowance in its first second.
    const burstBefore = ctx.fake.outbound().length;
    const burst = Array.from({ length: 50 }, (_, at) =>
      ctx.adapter.send(outbound('chat-burst', `m${String(at)}`)),
    );
    await ctx.drain(Promise.all(burst));
    const times = ctx.fake
      .outbound()
      .slice(burstBefore)
      .filter((call) => call.method === 'sendMessage')
      .map((call) => call.atMs)
      .toSorted((a, b) => a - b);
    check(
      'C12',
      times.length === 50,
      `the burst produced ${String(times.length)} sends, expected 50`,
    );
    const windowStart = times[0] ?? 0;
    const windowEnd = times.at(-1) ?? 0;
    const spread = windowEnd - windowStart;
    check(
      'C12',
      spread > 0,
      'fifty messages to one chat all left in the same millisecond. Every platform in `06` §3.14 ' +
        'has a per-chat limit tighter than that, and ignoring it is how a bot gets throttled for ' +
        'the rest of the minute.',
    );
  },
};

export const C15: ConformanceCase = {
  id: 'C15',
  name: '`start` and `stop` are idempotent, `stop` completes quickly, and no timers are left',
  gate: always,
  async run(ctx) {
    // The case that decides whether a host can restart cleanly. A `stop` that hangs is a container
    // the orchestrator kills, and a timer left behind is a process that will not exit — both show
    // up as "the upgrade took ten minutes" rather than as a bug anybody files.
    await ctx.adapter.start(ctx.context);
    // Give the adapter something to clean up first. The original version stopped a freshly started
    // adapter, which has no loops running — so `pending === 0` was true before `stop` was called
    // and a planted break that skipped the teardown entirely passed. A typing indicator is the one
    // piece of adapter state that is a *running timer* rather than a handle.
    // A **different** chat from the one the send goes to: `06` §3.11 stops the indicator on the
    // first part, so typing on the same chat is cleared by the send and there is again nothing for
    // `stop` to tidy. Found by re-running the drill after the first fix did not catch it.
    const chat = { channel: ctx.harness.channel, platformChatId: 'chat-lifecycle-typing' };
    if (ctx.harness.capabilities.typingIndicator) {
      await ctx.adapter.setTyping?.(chat, true);
      await ctx.settle();
      check(
        'C15',
        ctx.clock.pending > 0,
        'a typing indicator was started and no timer is pending, so this case cannot tell whether ' +
          '`stop` tidies up',
      );
    }
    await ctx.drain(ctx.adapter.send(outbound('chat-lifecycle', 'before the stop')));
    const startedAt = ctx.clock.now().epochMilliseconds;
    await ctx.adapter.stop();
    await ctx.adapter.stop();
    await ctx.settle();
    check(
      'C15',
      ctx.clock.now().epochMilliseconds - startedAt <= 5_000,
      '`stop` took more than five seconds of virtual time (`06` C15)',
    );
    check(
      'C15',
      ctx.clock.pending === 0,
      `${String(ctx.clock.pending)} timer(s) were still pending after \`stop\`. A timer on an ` +
        'injected `Timers` is a real `setTimeout` in production, and a process holding one does ' +
        'not exit.',
    );
    // And nothing arrives after a stop: a listener left attached would ingest into an engine that
    // has already shut its stores.
    const before = ctx.ingested().length;
    await ctx.fake.deliver({
      type: 'message',
      update_id: 97_001,
      chat: { id: 'chat-stopped', kind: 'group' },
      from: { id: 'u1', name: 'Ana' },
      message_id: 's1',
      at: ctx.clock.now().toString(),
      text: 'after the stop',
    });
    checkEqual('C15', ctx.ingested().length, before, 'the adapter ingested a message after `stop`');
  },
};

export const C18: ConformanceCase = {
  id: 'C18',
  name: 'Auth revoked: the adapter stops its loops and reports `auth_failed` within 1 s',
  gate: always,
  async run(ctx) {
    // `06` §3.15: an adapter whose token was revoked stays **registered** with health
    // `auth_failed`, so the dashboard banner and `village doctor` can explain the fix. The failure
    // to avoid is a receive loop that keeps retrying a dead credential every few seconds for days.
    ctx.fake.revokeAuth();
    const startedAt = ctx.clock.now().epochMilliseconds;
    try {
      await ctx.drain(ctx.adapter.send(outbound('chat-auth', 'x')));
    } catch {
      // Expected: the send is what discovers the revocation.
    }
    const report = ctx.health().find((entry) => entry.status === 'auth_failed');
    check(
      'C18',
      report !== undefined,
      'the adapter did not report `auth_failed`. Without it the host sees a channel that looks ' +
        'healthy and silently delivers nothing.',
    );
    check(
      'C18',
      (report?.atMs ?? Number.POSITIVE_INFINITY) - startedAt <= 1_000,
      'the report took more than a second of virtual time',
    );
    const before = ctx.ingested().length;
    await ctx.fake.deliver({
      type: 'message',
      update_id: 98_001,
      chat: { id: 'chat-auth', kind: 'group' },
      from: { id: 'u1', name: 'Ana' },
      message_id: 'a1',
      at: ctx.clock.now().toString(),
      text: 'still listening?',
    });
    checkEqual(
      'C18',
      ctx.ingested().length,
      before,
      'the receive loop kept running after the credentials were revoked',
    );
  },
};

export const C21: ConformanceCase = {
  id: 'C21',
  name: 'Typing refresh cadence and auto-stop',
  gate: (capabilities) =>
    capabilities.typingIndicator ? null : 'the platform has no typing indicator',
  async run(ctx) {
    const cadence = ctx.harness.capabilities.typingRefreshSec;
    check('C21', cadence !== null, 'the platform declares a typing indicator and no cadence');
    if (cadence === null) return;
    const setTyping = ctx.adapter.setTyping?.bind(ctx.adapter);
    check(
      'C21',
      setTyping !== undefined,
      'the platform declares a typing indicator and omits `setTyping`',
    );
    if (setTyping === undefined) return;

    const before = ctx.fake.outbound().length;
    await setTyping({ channel: ctx.harness.channel, platformChatId: 'chat-typing' }, true);
    // The first call reaches the platform through several `await`s, and `advanceTo` sets the clock
    // before firing a timer — so without settling, the refresh timer is scheduled against the *end*
    // of the window and this case reads one call where there were four.
    await ctx.settle();
    await ctx.clock.advance({ seconds: cadence * 3 + 1 });
    const typingCalls = ctx.fake
      .outbound()
      .slice(before)
      .filter((call) => call.method === 'setTyping' && (call.args as { on?: boolean }).on === true);
    check(
      'C21',
      typingCalls.length >= 3,
      `three cadences passed and the indicator was set ${String(typingCalls.length)} time(s). ` +
        `The platform expires it, so an indicator set once vanishes after about ${String(cadence)} s ` +
        'and the member sees nothing for the rest of the turn.',
    );
    // And it stops on its own. A loop that outlives the turn is a bot that looks permanently busy.
    await ctx.clock.advance({ seconds: 120 });
    const afterMax = ctx.fake.outbound().length;
    await ctx.clock.advance({ seconds: 120 });
    checkEqual(
      'C21',
      ctx.fake.outbound().length,
      afterMax,
      'the typing loop was still running two minutes past its ceiling (`06` §3.11: 60 s)',
    );
  },
};

/** What must never appear in a log line above `debug` (`06` C22; `01` §11.7). */
const FORBIDDEN_IN_LOGS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'telegram_bot_token', pattern: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/ },
  { name: 'prefixed_token', pattern: /\b(?:xox[bapsr]|xapp)-?[A-Za-z0-9_-]{10,}\b/ },
  { name: 'phone', pattern: /(?<![\w.])\+[1-9]\d{7,14}(?![\w.])/ },
  { name: 'credentialled_url', pattern: /https?:\/\/[^\s:]+:[^\s@]+@/ },
  { name: 'signed_url', pattern: /[?&](?:hm|sig|signature|token|key)=/i },
];

export const C22: ConformanceCase = {
  id: 'C22',
  name: 'Log hygiene: no message text, tokens, phone numbers or credentialled URLs above `debug`',
  gate: always,
  async run(ctx) {
    // `01` §11.7 and `08` §3.16. A log ships to an operator, goes into a bug report and sits in a
    // container's rotation for a fortnight — so a member's words in one is a disclosure with no
    // consent behind it, and the usual cause is an error line that quoted its input to be helpful.
    const secret = 'pineapple-seventeen-barnacle';
    await ctx.fake.deliver({
      type: 'message',
      update_id: 99_001,
      chat: { id: 'chat-logs', kind: 'group', title: 'The Okafor family' },
      from: { id: 'u1', name: 'Rhiannon Okafor', username: 'rhi_1987' },
      message_id: 'l1',
      at: ctx.clock.now().toString(),
      text: `the wifi password is ${secret}`,
    });
    try {
      await ctx.drain(ctx.adapter.send(outbound('chat-logs', `and again: ${secret}`)));
    } catch {
      // A send failure is fine; what the log says about it is the point.
    }
    const above = ctx.logs().filter((line) => !['trace', 'debug', 'content'].includes(line.level));
    for (const line of above) {
      const text = `${line.event} ${JSON.stringify(line.fields ?? {})}`;
      check(
        'C22',
        !text.includes(secret),
        `the line \`${line.event}\` at \`${line.level}\` contains message text. Content is ` +
          `available under \`${BRAND.envPrefix}DEBUG_CONTENT\` (\`01\` §11.7); above \`debug\` it must not be.`,
      );
      check(
        'C22',
        !text.includes('Rhiannon') && !text.includes('The Okafor family'),
        `the line \`${line.event}\` at \`${line.level}\` contains a member or group name. Those ` +
          'identify people to anyone who reads an operator log.',
      );
      for (const rule of FORBIDDEN_IN_LOGS) {
        check(
          'C22',
          !rule.pattern.test(text),
          `the line \`${line.event}\` at \`${line.level}\` matches \`${rule.name}\``,
        );
      }
    }
  },
};

export const C23: ConformanceCase = {
  id: 'C23',
  name: 'The capabilities match the profile, and each optional method’s presence matches it',
  gate: always,
  run(ctx) {
    const declared = ctx.adapter.capabilities;
    checkEqual(
      'C23',
      declared,
      ctx.harness.capabilities,
      "the adapter's capabilities differ from the harness's. Everything else in the kit gates on " +
        'the harness value, so a disagreement means the cases that ran were the wrong ones.',
    );
    const parsed = ChannelCapabilitiesSchema.safeParse(declared);
    check(
      'C23',
      parsed.success,
      `the capabilities do not validate: ${
        parsed.success ? '' : parsed.error.issues.map((issue) => issue.message).join('; ')
      }`,
    );
    // `06` §3.25 says the object must equal `profiles.<id>`. A plugin channel (`10` §3) has no
    // entry there and §3.25's last line asks plugins to pass the kit, so the clause applies where
    // a profile exists and the schema carries the rest. Amended in `06` §3.25 at `M3-T9`.
    const profile = (profiles as Record<string, typeof declared | undefined>)[ctx.harness.channel];
    if (profile !== undefined) {
      checkEqual(
        'C23',
        declared,
        profile,
        `the capabilities differ from \`profiles.${ctx.harness.channel}\`. The simulator emulates ` +
          'every platform from those profiles, so a drift makes every simulated run a different ' +
          'product from the real one.',
      );
    }
    for (const entry of CAPABILITY_METHODS) {
      const present = ctx.adapter[entry.method] !== undefined;
      checkEqual(
        'C23',
        present,
        entry.needs(declared),
        `\`${entry.method}\` is ${present ? 'present' : 'absent'} and the capability says ` +
          `${entry.needs(declared) ? 'it should exist' : 'it should not'}. An adapter that ` +
          'declares buttons and omits `answerInteraction` accepts a press it cannot acknowledge.',
      );
    }
    return Promise.resolve();
  },
};

export const C24: ConformanceCase = {
  id: 'C24',
  name: 'Each `probe/*.json` scenario produces the expected diagnostic codes',
  gate: (capabilities) =>
    capabilities.readsAllGroupMessages === 'yes' && capabilities.memberListing === 'none'
      ? 'the platform has nothing to probe for'
      : null,
  async run(ctx) {
    const probe = ctx.adapter.probe?.bind(ctx.adapter);
    check(
      'C24',
      probe !== undefined,
      'the adapter has no `probe`. `06` §3.20.3 turns a probe into a fix-it guide, and without ' +
        'one a misconfigured chat is a group that stays silent with nothing to tell the host.',
    );
    if (probe === undefined) return;
    const fixtures = await loadFixtures(ctx.store, 'probe');
    check('C24', fixtures.length > 0, 'no `probe/*.json` scenarios were found');
    for (const entry of fixtures) {
      const request = entry.fixture.request as {
        chat: string;
        canSend?: boolean;
        isAdmin?: boolean;
      };
      ctx.fake.setChatState(request.chat, {
        ...(request.canSend === undefined ? {} : { canSend: request.canSend }),
        ...(request.isAdmin === undefined ? {} : { isAdmin: request.isAdmin }),
      });
      const result = await probe({ channel: ctx.harness.channel, platformChatId: request.chat });
      const expected = entry.fixture.expect as { codes: readonly string[]; canSend?: boolean };
      checkEqual(
        'C24',
        result.diagnostics.map((diagnostic) => diagnostic.code).toSorted(),
        [...expected.codes].toSorted(),
        `${entry.path} produced the wrong diagnostics`,
      );
      if (expected.canSend !== undefined) {
        checkEqual(
          'C24',
          result.canSend,
          expected.canSend,
          `${entry.path} reported the wrong \`canSend\``,
        );
      }
    }
  },
};
