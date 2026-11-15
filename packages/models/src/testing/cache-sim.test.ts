/**
 * The prompt-cache simulation (`05` §3.5.7; `M2-T7`).
 *
 * The M2 gate's clause — `cache_read_input_tokens > 0` on the second identical request — is only
 * worth asserting if the simulation reproduces the *hierarchy*, so each rule in the table in
 * `cache-sim.ts` gets a test: a prefix match, a TTL expiry, the minimum, the lookback, a model
 * switch, and an effort change under each strategy. A simulation that always said "hit" would pass
 * the gate's clause and teach us nothing about the real cache.
 */
import { VirtualClock } from '@comvivo/shared/testing';
import { describe, expect, it } from 'vitest';
import { buildChatRequest } from '../anthropic/request.js';
import { bindingFor, turnRequest } from '../anthropic/testing/fixtures.js';
import { CacheSimulator, renderBlocks } from './cache-sim.js';

/** A system prompt long enough to clear a realistic minimum. */
function longSystem(marker: string): { id: string; text: string; cache: { ttl: '1h' } } {
  return { id: 'charter', text: `${marker} `.repeat(600), cache: { ttl: '1h' } };
}

function paramsFor(options: { marker?: string; effort?: 'low' | 'medium'; model?: string } = {}) {
  const binding = options.model === undefined ? bindingFor() : bindingFor({ model: options.model });
  return buildChatRequest(
    turnRequest({
      system: [longSystem(options.marker ?? 'charter')],
      ...(options.effort === undefined ? {} : { effort: options.effort }),
    }),
    { binding, availableBetas: [] },
  ).params;
}

function simulator(
  clock: VirtualClock,
  overrides: {
    minCacheableTokens?: number;
    effortStrategy?: 'top_level' | 'per_message';
    lookbackBlocks?: number;
  } = {},
): CacheSimulator {
  return new CacheSimulator({ clock, ...overrides });
}

describe('renderBlocks', () => {
  it('walks tools, then system, then messages — the API’s render order', () => {
    const params = buildChatRequest(
      turnRequest({
        system: [{ id: 'a', text: 'aaa', cache: { ttl: '1h' } }],
        tools: [
          {
            name: 't',
            description: 'd',
            inputSchema: {
              type: 'object',
              properties: {},
              required: [],
              additionalProperties: false,
            },
          },
        ],
      }),
      { binding: bindingFor(), availableBetas: [] },
    ).params;
    const blocks = renderBlocks(params);
    // One tool, one system block, one user text block.
    expect(blocks).toHaveLength(3);
    // The marker sits on the system block, which is the second position.
    expect(blocks.map((block) => block.ttl)).toEqual([undefined, '1h', undefined]);
  });
});

describe('the prefix match', () => {
  it('writes on the first request and reads on the second', () => {
    const clock = new VirtualClock('2026-11-12T12:00:00Z');
    const cache = simulator(clock);
    const params = paramsFor();

    const first = cache.account(params);
    expect(first.cacheRead).toBe(0);
    expect(first.cacheWrite1h).toBeGreaterThan(0);
    expect(first.input + first.cacheWrite1h).toBe(first.promptTokens);

    const second = cache.account(params);
    expect(second.cacheRead).toBe(first.cacheWrite1h);
    expect(second.cacheWrite1h).toBe(0);
    expect(second.cacheRead + second.input).toBe(second.promptTokens);
  });

  it('misses when a byte in the prefix changes', () => {
    const clock = new VirtualClock('2026-11-12T12:00:00Z');
    const cache = simulator(clock);
    cache.account(paramsFor({ marker: 'charter' }));
    // Any byte change anywhere in the prefix invalidates everything after it.
    expect(cache.account(paramsFor({ marker: 'charte' })).cacheRead).toBe(0);
  });

  it('does not cache a prefix below the model’s minimum', () => {
    const clock = new VirtualClock('2026-11-12T12:00:00Z');
    const cache = simulator(clock, { minCacheableTokens: 1_000_000 });
    const params = paramsFor();
    expect(cache.account(params).cacheWrite1h).toBe(0);
    // Silently, which is what the real API does — no error, just a bill.
    expect(cache.account(params).cacheRead).toBe(0);
    expect(cache.size()).toBe(0);
  });
});

describe('expiry', () => {
  it('reads inside the 1h TTL and misses after it', async () => {
    const clock = new VirtualClock('2026-11-12T12:00:00Z');
    const cache = simulator(clock);
    const params = paramsFor();
    cache.account(params);

    await clock.advance('PT59M');
    expect(cache.account(params).cacheRead).toBeGreaterThan(0);

    await clock.advance('PT2H');
    expect(cache.account(params).cacheRead).toBe(0);
  });

  it('expires a 5m entry after five minutes', async () => {
    const clock = new VirtualClock('2026-11-12T12:00:00Z');
    const cache = simulator(clock);
    const params = buildChatRequest(
      // Long enough to clear the 512-token default minimum: the point of this test is the TTL,
      // not the minimum, and a prompt that is too short fails for the wrong reason.
      turnRequest({
        system: [{ id: 'charter', text: 'charter '.repeat(600), cache: { ttl: '5m' } }],
      }),
      { binding: bindingFor(), availableBetas: [] },
    ).params;
    cache.account(params);
    await clock.advance('PT4M');
    expect(cache.account(params).cacheRead).toBeGreaterThan(0);
    await clock.advance('PT6M');
    expect(cache.account(params).cacheRead).toBe(0);
  });

  it('sweeps expired entries rather than leaving them to grow', async () => {
    const clock = new VirtualClock('2026-11-12T12:00:00Z');
    const cache = simulator(clock);
    cache.account(paramsFor());
    expect(cache.size()).toBe(1);
    await clock.advance('PT2H');
    expect(cache.size()).toBe(0);
  });
});

describe('the invalidation hierarchy', () => {
  it('misses on a model switch', () => {
    const clock = new VirtualClock('2026-11-12T12:00:00Z');
    const cache = simulator(clock);
    cache.account(paramsFor({ model: 'claude-opus-5-5' }));
    // The cache is model-scoped, which is why a cost cascade forfeits reuse across its models.
    expect(cache.account(paramsFor({ model: 'claude-sonnet-5-5' })).cacheRead).toBe(0);
  });

  it('misses on an effort change under top_level, and hits under per_message', () => {
    const clock = new VirtualClock('2026-11-12T12:00:00Z');
    const topLevel = simulator(clock, { effortStrategy: 'top_level' });
    topLevel.account(paramsFor({ effort: 'medium' }));
    expect(topLevel.account(paramsFor({ effort: 'low' })).cacheRead).toBe(0);

    const perMessage = simulator(clock, { effortStrategy: 'per_message' });
    perMessage.account(paramsFor({ effort: 'medium' }));
    // The per-message effort system message exists precisely to avoid this reset. `M2-T20`
    // measures which strategy wins; both are implemented so the spike has something to compare.
    expect(perMessage.account(paramsFor({ effort: 'low' })).cacheRead).toBeGreaterThan(0);
  });

  it('cannot read an entry pushed out of the lookback window', () => {
    const clock = new VirtualClock('2026-11-12T12:00:00Z');
    const cache = simulator(clock, { lookbackBlocks: 2 });
    const base = turnRequest({ system: [longSystem('charter')] });
    cache.account(buildChatRequest(base, { binding: bindingFor(), availableBetas: [] }).params);

    // Append more positions than the window allows: the marker is now too far from the end.
    const grown = turnRequest({
      system: [longSystem('charter')],
      messages: Array.from({ length: 6 }, (_, index) => ({
        role: 'user' as const,
        content: [{ type: 'text' as const, text: `turn ${String(index)}` }],
      })),
    });
    const usage = cache.account(
      buildChatRequest(grown, { binding: bindingFor(), availableBetas: [] }).params,
    );
    expect(usage.cacheRead).toBe(0);
  });
});

describe('clear', () => {
  it('empties the store', () => {
    const clock = new VirtualClock('2026-11-12T12:00:00Z');
    const cache = simulator(clock);
    cache.account(paramsFor());
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});
