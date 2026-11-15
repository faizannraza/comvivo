/**
 * `FakeModelGateway`'s DSL and its synthetic usage (`05` §3.5.7; `M2-T7`).
 *
 * Two properties carry the weight. **An unmatched call throws**: a fake that invented a reply would
 * turn every test that depends on it into a test that the fake exists. And **the usage is
 * accounted, not asserted**: the M2 gate asks for `cache_read_input_tokens > 0` on the second
 * identical request, and that clause is only worth anything if the simulation actually reproduces
 * a prefix match.
 */
import { isRefusal, ModelCallError } from '@comvivo/core';
import { VirtualClock } from '@comvivo/shared/testing';
import { describe, expect, it } from 'vitest';
import { bindingFor, OPUS, toolSpec, turnRequest } from '../anthropic/testing/fixtures.js';
import { CacheSimulator } from './cache-sim.js';
import { FakeModelGateway, FakeScriptExhausted, fakeToolCallId } from './fake-gateway.js';

const SIGNAL = (): AbortSignal => AbortSignal.timeout(5_000);

function gateway(options: { cache?: CacheSimulator; clock?: VirtualClock } = {}): {
  readonly fake: FakeModelGateway;
  readonly clock: VirtualClock;
} {
  const clock = options.clock ?? new VirtualClock('2026-11-12T12:00:00Z');
  const fake = new FakeModelGateway({
    clock,
    bindingFor: () => bindingFor(),
    advance: (ms) => clock.advance(`PT${String(ms / 1000)}S`),
    ...(options.cache === undefined ? {} : { cache: options.cache }),
  });
  return { fake, clock };
}

describe('failing loudly', () => {
  it('throws FakeScriptExhausted when no rule matches', async () => {
    const { fake } = gateway();
    await expect(fake.run(turnRequest(), SIGNAL())).rejects.toBeInstanceOf(FakeScriptExhausted);
  });

  it('names the route and the purpose, so the fix is obvious', async () => {
    const { fake } = gateway();
    await expect(fake.run(turnRequest({ purpose: 'turn.reply' }), SIGNAL())).rejects.toThrow(
      /route "chat" purpose "turn.reply"/,
    );
  });

  it('throws when a rule has run out of outcomes', async () => {
    const { fake } = gateway();
    fake.when({ route: 'chat' }).respond((r) => r.text('once'));
    await fake.run(turnRequest(), SIGNAL());
    await expect(fake.run(turnRequest(), SIGNAL())).rejects.toBeInstanceOf(FakeScriptExhausted);
  });

  it('reports outcomes that were scripted and never used', async () => {
    const { fake } = gateway();
    fake
      .when({ route: 'chat' })
      .respond((r) => r.text('a'))
      .andThen((r) => r.text('b'));
    expect(fake.unconsumed()).toBe(2);
    await fake.run(turnRequest(), SIGNAL());
    expect(fake.unconsumed()).toBe(1);
  });
});

describe('the script DSL', () => {
  it('matches on route, purpose and a predicate, first match winning', async () => {
    const { fake } = gateway();
    fake
      .when({ route: 'chat', match: (req) => JSON.stringify(req).includes('recital') })
      .respond((r) => r.text('specific'));
    fake.when({ route: 'chat' }).respond((r) => r.text('general'));

    const recital = await fake.run(
      turnRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: 'recital' }] }] }),
      SIGNAL(),
    );
    expect(recital.text).toBe('specific');
    expect((await fake.run(turnRequest(), SIGNAL())).text).toBe('general');
  });

  it('consumes a rule’s outcomes in order, which is how a tool loop reads', async () => {
    const { fake } = gateway();
    fake
      .when({ route: 'chat' })
      .respond((r) => r.thinking().toolCall('calendar_search_events', { query: 'recital' }))
      .andThen((r) => r.text('Fri 14 Nov, 6 pm at Teatro Real.'));

    const first = await fake.run(turnRequest({ tools: [toolSpec()] }), SIGNAL());
    expect(first.stop.reason).toBe('tool_use');
    expect(first.toolCalls).toEqual([
      { id: fakeToolCallId(1), name: 'calendar_search_events', input: { query: 'recital' } },
    ]);
    // Thinking is opaque in the view: the engine must know a block is there and never read it.
    expect(first.assistant.view[0]).toEqual({ type: 'opaque', kind: 'thinking' });

    const second = await fake.run(turnRequest({ tools: [toolSpec()] }), SIGNAL());
    expect(second.stop.reason).toBe('end_turn');
    expect(second.text).toBe('Fri 14 Nov, 6 pm at Teatro Real.');
  });

  it('numbers tool-call ids deterministically', async () => {
    const { fake } = gateway();
    fake.when({ route: 'chat' }).respond((r) => r.toolCall('a', {}).toolCall('b', {}));
    const result = await fake.run(turnRequest({ tools: [toolSpec()] }), SIGNAL());
    expect(result.toolCalls.map((call) => call.id)).toEqual([fakeToolCallId(1), fakeToolCallId(2)]);
  });

  it('scripts a refusal, with the category and no text', async () => {
    const { fake } = gateway();
    fake.when({ route: 'chat' }).refuse('cyber');
    const result = await fake.run(turnRequest(), SIGNAL());
    expect(isRefusal(result.stop) ? result.stop.category : undefined).toBe('cyber');
    expect(result.text).toBe('');
  });

  it('scripts max_tokens, whose output must never be used', async () => {
    const { fake } = gateway();
    fake.when({ route: 'chat' }).maxTokens((r) => r.text('half a sent').toolCall('t', {}));
    const result = await fake.run(turnRequest({ tools: [toolSpec()] }), SIGNAL());
    expect(result.stop.reason).toBe('max_tokens');
    expect(result.text).toBe('');
    expect(result.toolCalls).toEqual([]);
  });

  it('scripts pause_turn, whose output is usable', async () => {
    const { fake } = gateway();
    fake
      .when({ route: 'chat' })
      .pauseTurn((r) => r.text('still working'))
      .andThen((r) => r.text('done'));
    const paused = await fake.run(turnRequest(), SIGNAL());
    expect(paused.stop.reason).toBe('pause_turn');
    expect(paused.text).toBe('still working');
    expect((await fake.run(turnRequest(), SIGNAL())).text).toBe('done');
  });

  it('scripts a typed error, repeated by times()', async () => {
    const { fake } = gateway();
    fake.when({ route: 'chat' }).error('overloaded').times(2);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(fake.run(turnRequest(), SIGNAL())).rejects.toMatchObject({
        kind: 'overloaded',
        retryable: true,
      });
    }
    await expect(fake.run(turnRequest(), SIGNAL())).rejects.toBeInstanceOf(FakeScriptExhausted);
  });

  it('carries a retry-after on a scripted rate limit', async () => {
    const { fake } = gateway();
    fake.when({ route: 'chat' }).error('rate_limited', { retryAfterMs: 4000 });
    const error = await fake.run(turnRequest(), SIGNAL()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelCallError);
    expect((error as ModelCallError).detail.retryAfterMs).toBe(4000);
  });

  it('scripts a fallback turn, billed at two models', async () => {
    const { fake } = gateway();
    fake.when({ route: 'chat' }).fallbackMidStream('claude-opus-4-8', (r) => r.text('rescued'));
    const result = await fake.run(turnRequest(), SIGNAL());
    expect(result.model.served).toBe('claude-opus-4-8');
    expect(result.model.requested).toBe(OPUS);
    // Two iterations, which is the only shape that can carry two prices.
    expect(result.usage.map((u) => [u.kind, u.model])).toEqual([
      ['message', OPUS],
      ['fallback_message', 'claude-opus-4-8'],
    ]);
  });

  it('advances an injected clock with delay(), so a deadline test is instant', async () => {
    const { fake, clock } = gateway();
    fake
      .when({ route: 'chat' })
      .delay(70_000)
      .respond((r) => r.text('slow'));
    const before = clock.now().epochMilliseconds;
    const result = await fake.run(turnRequest(), SIGNAL());
    expect(clock.now().epochMilliseconds - before).toBe(70_000);
    expect(result.latency.totalMs).toBe(70_000);
  });

  it('honours an already-aborted signal after the delay', async () => {
    const { fake } = gateway();
    fake
      .when({ route: 'chat' })
      .delay(1000)
      .respond((r) => r.text('never seen'));
    const controller = new AbortController();
    controller.abort();
    await expect(fake.run(turnRequest(), controller.signal)).rejects.toThrow();
  });
});

describe('structured calls', () => {
  const schema = {
    safeParse: (input: unknown) =>
      typeof input === 'object' && input !== null && 'dominantLanguage' in input
        ? ({ success: true, data: input } as const)
        : ({ success: false } as const),
  };

  const structuredRequest = {
    route: 'route' as const,
    purpose: 'route.classify',
    system: [{ id: 'router', text: 'classify' }],
    input: [{ type: 'text' as const, text: 'hola' }],
    schema,
    jsonSchema: {
      type: 'object' as const,
      properties: { dominantLanguage: { type: 'string' as const } },
      required: ['dominantLanguage'],
      additionalProperties: false as const,
    },
    schemaName: 'route_v1',
    effort: 'low' as const,
    maxOutputTokens: 512,
    correlation: {},
  };

  it('returns a scripted value, validated against the request schema', async () => {
    const { fake } = gateway();
    fake.when({ route: 'route' }).structured({ candidates: [], dominantLanguage: 'es' });
    const result = await fake.structured(structuredRequest, SIGNAL());
    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' ? result.value : undefined).toEqual({
      candidates: [],
      dominantLanguage: 'es',
    });
  });

  it('refuses to return a value its own schema rejects, which is a broken test', async () => {
    const { fake } = gateway();
    fake.when({ route: 'route' }).structured({ wrong: true });
    await expect(fake.structured(structuredRequest, SIGNAL())).rejects.toThrow(
      /does not match its own schema "route_v1"/,
    );
  });

  it('scripts a structured refusal and a truncation', async () => {
    const { fake } = gateway();
    fake.when({ route: 'route' }).refuse('bio');
    fake.when({ route: 'route' }).maxTokens();
    expect((await fake.structured(structuredRequest, SIGNAL())).kind).toBe('refused');
    expect((await fake.structured(structuredRequest, SIGNAL())).kind).toBe('truncated');
  });

  it('refuses a turn reply for a structured call, and the reverse', async () => {
    const { fake } = gateway();
    fake.when({ route: 'route' }).respond((r) => r.text('not structured'));
    await expect(fake.structured(structuredRequest, SIGNAL())).rejects.toThrow(
      /scripts a turn reply/,
    );
    fake.when({ route: 'chat' }).structured({ a: 1 });
    await expect(fake.run(turnRequest(), SIGNAL())).rejects.toThrow(/scripts a structured result/);
  });
});

describe('synthetic usage', () => {
  it('reports prompt tokens with no cache simulator', async () => {
    const { fake } = gateway();
    fake.when({ route: 'chat' }).respond((r) => r.text('hello there'));
    const [usage] = (await fake.run(turnRequest(), SIGNAL())).usage;
    expect(usage?.input).toBeGreaterThan(0);
    expect(usage?.cacheRead).toBe(0);
    expect(usage?.output).toBeGreaterThan(0);
  });

  it('reads from the cache on the second identical request — the M2 gate’s clause', async () => {
    const clock = new VirtualClock('2026-11-12T12:00:00Z');
    const cache = new CacheSimulator({ clock, minCacheableTokens: 1 });
    const { fake } = gateway({ cache, clock });
    fake
      .when({ route: 'chat' })
      .respond((r) => r.text('a'))
      .andThen((r) => r.text('b'));

    const first = (await fake.run(turnRequest(), SIGNAL())).usage[0];
    const second = (await fake.run(turnRequest(), SIGNAL())).usage[0];
    // The first writes, the second reads. This is the assertion the exit gate names, and the live
    // smoke has to agree with it.
    expect(first?.cacheWrite1h).toBeGreaterThan(0);
    expect(first?.cacheRead).toBe(0);
    expect(second?.cacheRead).toBeGreaterThan(0);
  });

  it('embeds deterministically, so a KNN test is reproducible', async () => {
    const { fake } = gateway();
    const [a] = await fake.embed(['soccer practice'], 'document');
    const [b] = await fake.embed(['soccer practice'], 'document');
    const [c] = await fake.embed(['dentist appointment'], 'document');
    expect([...(a ?? [])]).toEqual([...(b ?? [])]);
    expect([...(a ?? [])]).not.toEqual([...(c ?? [])]);
  });
});

describe('captured calls', () => {
  it('keeps every request, meta included', async () => {
    const { fake } = gateway();
    fake.when({ route: 'chat' }).respond((r) => r.text('ok'));
    const manifest = {
      messageIds: [],
      memoryIds: [],
      labelIds: [7],
      entityRefs: [],
      tokenEstimate: 10,
      contextHash: 'abc',
    };
    await fake.run(turnRequest({ meta: { manifest } }), SIGNAL());
    expect(fake.turnCalls).toHaveLength(1);
    // `meta` is ours and never sent to a provider — keeping it is the whole reason I1 can be
    // audited from the captured call.
    expect(fake.turnCalls[0]?.meta?.manifest).toEqual(manifest);
  });

  it('answers routeInfo from the binding', () => {
    const { fake } = gateway();
    expect(fake.routeInfo('chat')).toMatchObject({ provider: 'anthropic', model: OPUS });
  });

  it('resets', async () => {
    const { fake } = gateway();
    fake.when({ route: 'chat' }).respond((r) => r.text('ok'));
    await fake.run(turnRequest(), SIGNAL());
    fake.reset();
    expect(fake.calls).toEqual([]);
    expect(fake.unconsumed()).toBe(0);
  });
});
