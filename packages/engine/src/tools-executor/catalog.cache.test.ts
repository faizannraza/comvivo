/**
 * The catalogue hash **is** the breakpoint-1 cache key (`01` §14 A13; `05` §3.4.8; `M2-T17`).
 *
 * The other suites assert that the hash is stable and that it changes for the right reasons. This
 * one closes the loop that makes any of that matter: that two groups whose catalogues hash the same
 * really do render the **same bytes** to the provider, and therefore share a cache entry.
 *
 * Asserted through the real `buildChatRequest` and the prompt-cache simulation, not through a
 * re-implementation of either. A simulation with its own idea of the wire form would agree with
 * itself and disagree with the provider, and the disagreement would surface as a bill rather than
 * as a test failure.
 *
 * `@comvivo/models` is a **devDependency** of `@comvivo/engine` and is imported only here. `01`
 * §14 A11 keeps the engine off the model implementations in production — `apps/server` wires the
 * adapter in — and `engine-allowed-imports` enforces exactly that for non-test files.
 */
import { buildChatRequest } from '@comvivo/models';
import { bindingFor, CacheSimulator, turnRequest } from '@comvivo/models/testing';
import { VirtualClock } from '@comvivo/shared/testing';
import { describe, expect, it } from 'vitest';
import { buildCatalog, type CatalogTool, toolSpecs } from './catalog.js';

function tool(localName: string, provider: CatalogTool['provider']): CatalogTool {
  return {
    localName,
    provider,
    description: `Return the ${localName} for one city.`,
    inputSchema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
    strict: true,
  };
}

const BUILTINS: readonly CatalogTool[] = [
  tool('memory_recall', { kind: 'builtin' }),
  tool('calendar_search_events', { kind: 'builtin' }),
];

/** A charter long enough to clear the 512-token minimum, so the layer actually caches. */
const CHARTER = {
  id: 'charter',
  text: `Be useful to the group. `.repeat(400),
  cache: { ttl: '1h' as const },
};

/** What the adapter would send for one group's catalogue. */
function paramsFor(
  extensions: readonly CatalogTool[],
): ReturnType<typeof buildChatRequest>['params'] {
  const catalog = buildCatalog({ builtins: BUILTINS, extensions });
  return buildChatRequest(turnRequest({ system: [CHARTER], tools: toolSpecs(catalog) }), {
    binding: bindingFor(),
    availableBetas: [],
  }).params;
}

function prefixBytes(params: ReturnType<typeof paramsFor>): string {
  // Tools render before system, which renders before messages (`05` §3.4.8's cache plan), so this
  // is the byte prefix a cache lookup walks.
  return JSON.stringify([params.tools, params.system]);
}

describe('identical hashes share a cached prefix', () => {
  const ONE: readonly CatalogTool[] = [
    tool('forecast', { kind: 'plugin', id: 'weather' }),
    tool('issues', { kind: 'mcp', id: 'github' }),
  ];
  // The same set, registered in the opposite order — which is all a host's install history is.
  const TWO: readonly CatalogTool[] = [...ONE].reverse();

  it('hashes the same, which is the precondition', () => {
    expect(buildCatalog({ builtins: BUILTINS, extensions: TWO }).hash).toBe(
      buildCatalog({ builtins: BUILTINS, extensions: ONE }).hash,
    );
  });

  it('renders byte-identical prefixes', () => {
    expect(prefixBytes(paramsFor(TWO))).toBe(prefixBytes(paramsFor(ONE)));
  });

  it('reads the second group’s prompt out of the cache the first group wrote', () => {
    const clock = new VirtualClock('2026-11-13T10:00:00Z');
    const cache = new CacheSimulator({ clock });

    const first = cache.account(paramsFor(ONE));
    // Nothing to read on a cold cache; the layer is written instead.
    expect(first.cacheRead).toBe(0);
    expect(first.cacheWrite1h).toBeGreaterThan(0);

    const second = cache.account(paramsFor(TWO));
    // The gate's clause, and the reason A13 keys this layer by hash rather than by group.
    expect(second.cacheRead).toBeGreaterThan(0);
    expect(second.cacheWrite1h).toBe(0);
  });

  it('misses when the catalogue differs, so the hit above is not unconditional', () => {
    const clock = new VirtualClock('2026-11-13T10:00:00Z');
    const cache = new CacheSimulator({ clock });
    cache.account(paramsFor(ONE));

    const different = cache.account(
      paramsFor([...ONE, tool('alerts', { kind: 'plugin', id: 'weather' })]),
    );
    // A group that enabled one more tool has a different hash and a different prefix, so the
    // tools block itself cannot be read back. Only a later breakpoint could hit.
    expect(different.cacheRead).toBe(0);
  });

  it('misses when a description changes, which is the invalidation audit’s first row', () => {
    const clock = new VirtualClock('2026-11-13T10:00:00Z');
    const cache = new CacheSimulator({ clock });
    cache.account(paramsFor(ONE));

    const reworded = ONE.map((t) =>
      t.localName === 'forecast' ? { ...t, description: `${t.description} Now with wind.` } : t,
    );
    expect(cache.account(paramsFor(reworded)).cacheRead).toBe(0);
  });
});
