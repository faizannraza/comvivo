/**
 * The price tables' bare model names must stay unambiguous (`05` §3.9.2).
 *
 * `lookupPrice` resolves a provider's **own** model id — `gpt-6-astra`, with no `<provider>/`
 * prefix — by matching the one table key that ends in it. That is a function rather than a guess
 * only while no two providers publish the same bare name, so this file is what makes it one.
 *
 * It is a real risk, not a hypothetical: the same weights are sold under the same name by more than
 * one host (`gpt-6-astra` on OpenAI and on a reseller), and a dated snapshot shortens to the same
 * string as its base model often enough. The day a table carries two, this fails and the fix is to
 * give `UsageIteration` an explicit price id rather than to loosen the match.
 */
import { describe, expect, it } from 'vitest';
import { ALL_PRICE_TABLES, lookupPrice } from './prices.js';

describe('every shipped price table', () => {
  it('is non-empty, so the checks below are checking something', () => {
    expect(ALL_PRICE_TABLES.length).toBeGreaterThan(0);
    for (const table of ALL_PRICE_TABLES) {
      expect(Object.keys(table.models).length, table.version).toBeGreaterThan(5);
    }
  });

  it('gives every model a provider-qualified key', () => {
    // The prefix is what makes a bare name resolvable to exactly one row. A key without one would
    // be reachable by both paths in `lookupPrice` and belong to no provider.
    for (const table of ALL_PRICE_TABLES) {
      for (const key of Object.keys(table.models)) {
        expect(key, `${table.version} ${key}`).toMatch(/^[a-z0-9-]+\/.+$/);
      }
    }
  });

  it('never gives two providers the same bare model name', () => {
    for (const table of ALL_PRICE_TABLES) {
      const byBare = new Map<string, string[]>();
      for (const key of Object.keys(table.models)) {
        const bare = key.slice(key.indexOf('/') + 1);
        if (bare === '*') continue; // A family row has no bare name to collide on.
        byBare.set(bare, [...(byBare.get(bare) ?? []), key]);
      }
      const ambiguous = [...byBare.entries()]
        .filter(([, keys]) => keys.length > 1)
        .map(([bare, keys]) => `${bare} ← ${keys.join(' + ')}`);
      expect(ambiguous, `${table.version}: lookupPrice could not choose between these`).toEqual([]);
    }
  });

  it('returns nothing rather than guessing when a bare name is ambiguous', () => {
    // The behaviour the guard above protects, asserted directly against a synthetic table so the
    // refusal is proven rather than assumed. Costing against the wrong provider's rates silently
    // is worse than the fallback, which at least sets `estimated`.
    const first = ALL_PRICE_TABLES[0];
    if (first === undefined) throw new Error('no price tables');
    const row = first.models['anthropic/claude-opus-5-5'];
    expect(row).toBeDefined();
    const collided = {
      ...first,
      models: { 'openai/shared-name': row, 'google/shared-name': row },
    } as typeof first;
    expect(lookupPriceFrom(collided, 'shared-name')).toBeUndefined();
    // And it still resolves a name only one provider claims.
    const single = { ...first, models: { 'openai/shared-name': row } } as typeof first;
    expect(lookupPriceFrom(single, 'shared-name')).toBe(row);
  });
});

/** `lookupPrice` with the arguments the other way round, for readability above. */
function lookupPriceFrom(table: Parameters<typeof lookupPrice>[1], modelId: string) {
  return lookupPrice(modelId, table);
}
