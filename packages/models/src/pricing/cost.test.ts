/**
 * The cost table `05` §9.1 asks for: "a table of iterations, tiers (Haiku > 100K), batch, unknown
 * price and 5m/1h writes → exact `costMicros`" (`M2-T3`).
 *
 * Exact, not approximate. Every expectation below is computed by hand from the published prices, so
 * the test fails if the arithmetic changes *or* if a price does — and a price change should fail a
 * test, because it is a new price table and a new version, not a silent re-rate.
 */
import type { UsageIteration } from '@comvivo/core';
import { describe, expect, it } from 'vitest';
import {
  costIteration,
  costTurn,
  formatMicros,
  promptTokensOf,
  UNKNOWN_MODEL_FALLBACK,
} from './cost.js';
import {
  ALL_PRICE_TABLES,
  lookupPrice,
  PRICES,
  PriceTableSchema,
  pickTable,
  ratesFor,
} from './prices.js';

const OPUS = 'anthropic/claude-opus-5-5';
const SONNET = 'anthropic/claude-sonnet-5-5';
const HAIKU = 'anthropic/claude-haiku-5-5';

/** An iteration with everything at zero, so each test sets only what it is about. */
function iteration(overrides: Partial<UsageIteration> & { model: string }): UsageIteration {
  return {
    kind: 'message',
    input: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 0,
    batch: false,
    ...overrides,
  };
}

describe('the unit is micro-USD, exactly', () => {
  it('prices a million input tokens at the dollar figure, in micros', () => {
    // The whole reason prices are per-MTok: `tokens × dollarsPerMTok` *is* micro-USD, so a million
    // tokens at $4/MTok is 4,000,000 micros and there is no rounding step in the middle.
    const cost = costIteration(iteration({ model: OPUS, input: 1_000_000 }));
    expect(cost.micros).toBe(4_000_000);
    expect(formatMicros(cost.micros)).toBe('$4.0000');
  });

  it('prices a single token without losing it to rounding', () => {
    // $4/MTok is 4 micros per token. A calculator that divided first would land on 0.
    expect(costIteration(iteration({ model: OPUS, input: 1 })).micros).toBe(4);
    // And a sub-micro rate rounds rather than truncating: Haiku's $0.10/MTok is 0.1 micros per
    // token, so ten tokens is 1 micro and five is 1 (round-half-up), not 0.
    expect(costIteration(iteration({ model: HAIKU, input: 10 })).micros).toBe(1);
    expect(costIteration(iteration({ model: HAIKU, input: 5 })).micros).toBe(1);
    expect(costIteration(iteration({ model: HAIKU, input: 4 })).micros).toBe(0);
  });
});

describe('the five categories are priced separately', () => {
  it('bills input, output and all three cache categories at their own rates', () => {
    // Opus 5.5, read off the published table on 2026-11-12: in 4, out 20, 5m 5, 1h 8, read 0.20.
    const cost = costIteration(
      iteration({
        model: OPUS,
        input: 1_000_000,
        output: 1_000_000,
        cacheWrite5m: 1_000_000,
        cacheWrite1h: 1_000_000,
        cacheRead: 1_000_000,
      }),
    );
    expect(cost.breakdown).toEqual({
      input: 4_000_000,
      output: 20_000_000,
      cacheWrite5m: 5_000_000,
      cacheWrite1h: 8_000_000,
      cacheRead: 200_000,
    });
    expect(cost.micros).toBe(37_200_000);
  });

  it('prices a Sonnet cache read at $0.10, not $0.20', () => {
    // The correction this task found: cache hits on Opus 5.5 and Sonnet 5.5 are 0.05× base input,
    // and 0.05 × $2 is $0.10. The plan's table said $0.20 — double. It matters in the quiet
    // direction: cache reads are most of a warm conversation, so a doubled rate inflates the
    // cheapest part of the traffic a family actually generates, and the budget guard would degrade
    // a group that had not spent its budget.
    expect(costIteration(iteration({ model: SONNET, cacheRead: 1_000_000 })).micros).toBe(100_000);
    // Opus really is $0.20, so the two are not the same number by accident.
    expect(costIteration(iteration({ model: OPUS, cacheRead: 1_000_000 })).micros).toBe(200_000);
  });

  it('does not double-bill reasoning tokens', () => {
    // `UsageIteration.reasoning` is reported *within* `output` for observability (`11` §3.10.2).
    // Adding it again would bill thinking twice, which on an adaptive-thinking model is most of
    // the output on a hard turn.
    const withReasoning = costIteration(iteration({ model: OPUS, output: 1_000, reasoning: 800 }));
    const without = costIteration(iteration({ model: OPUS, output: 1_000 }));
    expect(withReasoning.micros).toBe(without.micros);
  });
});

describe('Haiku 5.5 is tiered at 100,000 prompt tokens', () => {
  it('uses the short tier at and below the threshold', () => {
    const short = ratesFor(HAIKU, 100_000);
    expect(short?.in).toBe(0.1);
    expect(short?.out).toBe(0.5);
    expect(short?.cacheRead).toBe(0.01);
  });

  it('uses the long tier one token past it', () => {
    const long = ratesFor(HAIKU, 100_001);
    expect(long?.in).toBe(0.5);
    expect(long?.out).toBe(2.5);
    expect(long?.cacheRead).toBe(0.05);
    // Five times the short tier, which is the whole point of getting the boundary right.
    expect((long?.in ?? 0) / (short() ?? 1)).toBe(5);
    function short(): number | undefined {
      return ratesFor(HAIKU, 100_000)?.in;
    }
  });

  it('chooses the tier by total prompt tokens, not by input alone', () => {
    // The reading that matters on a warm conversation: most of a long prompt is cache reads. An
    // iteration with 10k input and 95k cache reads is a 105k prompt and bills at the long tier.
    const warm = iteration({ model: HAIKU, input: 10_000, cacheRead: 95_000 });
    expect(promptTokensOf(warm)).toBe(105_000);
    const cost = costIteration(warm);
    // 10,000 × 0.5 = 5,000 micros of input; 95,000 × 0.05 = 4,750 of cache read.
    expect(cost.breakdown.input).toBe(5_000);
    expect(cost.breakdown.cacheRead).toBe(4_750);
    expect(cost.micros).toBe(9_750);

    // The same tokens counted as input only would have been the short tier and five times cheaper,
    // which is the error this assertion exists to catch.
    const naive = costIteration(iteration({ model: HAIKU, input: 10_000 }));
    expect(naive.breakdown.input).toBe(1_000);
  });

  it('counts cache writes toward the prompt size too', () => {
    const cold = iteration({ model: HAIKU, input: 1_000, cacheWrite1h: 120_000 });
    expect(promptTokensOf(cold)).toBe(121_000);
    // Long tier: 1,000 × 0.5 = 500, plus 120,000 × 1.00 = 120,000.
    expect(costIteration(cold).micros).toBe(120_500);
  });
});

describe('the Batch discount', () => {
  it('halves input and output on a batched iteration', () => {
    const sync = costIteration(iteration({ model: SONNET, input: 1_000_000, output: 100_000 }));
    const batched = costIteration(
      iteration({ model: SONNET, input: 1_000_000, output: 100_000, batch: true }),
    );
    expect(sync.micros).toBe(3_000_000);
    expect(batched.micros).toBe(1_500_000);
  });

  it('halves the cache categories as well', () => {
    // The published discount is "50 percent on both input and output tokens", and the multipliers
    // stack with the cache rates — a batch of a cached prompt is discounted on the whole bill.
    const batched = costIteration(
      iteration({ model: OPUS, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, batch: true }),
    );
    expect(batched.micros).toBe((200_000 + 5_000_000) / 2);
  });

  it('does not discount a local model, whose multiplier is 1', () => {
    const cost = costIteration(
      iteration({ model: 'local/qwen3-32b', input: 1_000_000, batch: true }),
    );
    expect(cost.micros).toBe(0);
    expect(cost.estimated).toBe(false);
  });
});

describe('an unknown model', () => {
  it('is costed at the Opus fallback and flagged as estimated', () => {
    // `05` §3.9.2: conservative on purpose. The failure this avoids is the quiet one — a model with
    // no price row billed at zero runs a group's budget to its limit while the guard reports
    // nothing spent.
    const cost = costIteration(iteration({ model: 'openai/gpt-x', input: 1_000_000 }));
    expect(cost.estimated).toBe(true);
    expect(cost.micros).toBe(4_000_000);
    expect(cost.micros).toBe(
      costIteration(iteration({ model: UNKNOWN_MODEL_FALLBACK, input: 1_000_000 })).micros,
    );
  });

  it('does not apply a discount it cannot verify', () => {
    // An unknown model's batch multiplier is unknown too, so it stays at 1 — conservative in the
    // same direction as the rates.
    const batched = costIteration(
      iteration({ model: 'openai/gpt-x', input: 1_000_000, batch: true }),
    );
    expect(batched.micros).toBe(4_000_000);
  });

  it('is flagged on the turn, so doctor and the dashboard can say so', () => {
    const turn = costTurn([
      iteration({ model: OPUS, input: 1_000 }),
      iteration({ model: 'google/gemini-x', input: 1_000 }),
    ]);
    expect(turn.estimated).toBe(true);
    expect(turn.iterations.map((i) => i.estimated)).toEqual([false, true]);
  });

  it('refuses to cost anything if even the fallback is missing', () => {
    // A table with no fallback row is a broken table, and a cost calculator that returned zero for
    // it would disable the budget guard silently.
    const broken = PriceTableSchema.parse({
      version: '2026-01-01',
      currency: 'USD',
      sources: { anthropic: 'https://example.com' },
      models: {},
    });
    expect(() => costIteration(iteration({ model: OPUS, input: 1 }), broken)).toThrow(
      /no row for "anthropic\/claude-opus-5-5"/,
    );
  });
});

describe('a turn is the sum of its iterations, each at its own model', () => {
  it('bills a refusal fallback at the fallback model’s rates', () => {
    // The reason `usage` is an array. An Opus request that was declined and answered by Haiku is
    // two iterations on two models; summing the tokens first and pricing once would bill Haiku's
    // output at Opus rates — wrong by 40×.
    const turn = costTurn([
      iteration({ model: OPUS, input: 1_000, output: 0 }),
      iteration({ model: HAIKU, kind: 'fallback_message', input: 1_000, output: 1_000 }),
    ]);
    expect(turn.iterations[0]?.micros).toBe(4_000);
    // Haiku short tier: 1,000 × 0.1 = 100 in, 1,000 × 0.5 = 500 out.
    expect(turn.iterations[1]?.micros).toBe(600);
    expect(turn.micros).toBe(4_600);

    // The same tokens priced once at Opus rates would be 24,000 micros — five times the truth.
    const naive = costIteration(iteration({ model: OPUS, input: 2_000, output: 1_000 }));
    expect(naive.micros).toBe(28_000);
  });

  it('is zero for an empty usage array', () => {
    // A turn that never reached a provider (a cache-only answer, a refused request before billing)
    // costs nothing, and must not throw on the way to saying so.
    expect(costTurn([])).toEqual({ micros: 0, iterations: [], estimated: false });
  });
});

describe('the versioned table', () => {
  it('takes the newest version not in the future', () => {
    const tables = (['2026-01-01', '2026-06-01', '2026-12-01'] as const).map((version) =>
      PriceTableSchema.parse({
        version,
        currency: 'USD',
        sources: { anthropic: 'https://example.com' },
        models: {},
      }),
    );
    expect(pickTable(tables, '2026-11-12').version).toBe('2026-06-01');
    // A release built ahead of a price change must not start billing early.
    expect(pickTable(tables, '2026-12-31').version).toBe('2026-12-01');
    expect(pickTable(tables, '2026-01-01').version).toBe('2026-01-01');
  });

  it('refuses rather than billing at zero when every table is in the future', () => {
    const future = PriceTableSchema.parse({
      version: '2099-01-01',
      currency: 'USD',
      sources: { anthropic: 'https://example.com' },
      models: {},
    });
    expect(() => pickTable([future], '2026-11-12')).toThrow(/no price table is in force/);
  });

  it('falls back to a provider family for a model it does not name', () => {
    expect(lookupPrice('local/anything')).not.toBeUndefined();
    expect(lookupPrice('openai/gpt-x')).toBeUndefined();
  });

  it('keeps the shipped prices at what the live table published', () => {
    // Pinned, because a price is a fact about somebody else's product and the only honest way to
    // change one is a new dated file. Verified 2026-11-12.
    expect(PRICES.version).toBe('2026-11-12');
    const opus = lookupPrice(OPUS);
    expect(opus).toMatchObject({
      in: 4,
      out: 20,
      cacheWrite5m: 5,
      cacheWrite1h: 8,
      cacheRead: 0.2,
    });
    const sonnet = lookupPrice(SONNET);
    expect(sonnet).toMatchObject({ in: 2, out: 10, cacheRead: 0.1 });
    expect(PRICES.sources['anthropic']).toContain('platform.claude.com');
  });
});

describe('the dated tables (M2-T13)', () => {
  it('ships three tables and picks the one in force', () => {
    // `05` §3.9.2's "newest `version ≤ today` wins" only does anything if more than one ships.
    expect(ALL_PRICE_TABLES.map((table) => table.version)).toEqual([
      '2026-11-12',
      '2026-12-01',
      '2027-01-01',
    ]);
    expect(pickTable(ALL_PRICE_TABLES, '2026-11-13').version).toBe('2026-11-12');
    expect(pickTable(ALL_PRICE_TABLES, '2026-11-30').version).toBe('2026-11-12');
    expect(pickTable(ALL_PRICE_TABLES, '2026-12-01').version).toBe('2026-12-01');
    expect(pickTable(ALL_PRICE_TABLES, '2027-06-01').version).toBe('2027-01-01');
  });

  it('agrees with PRICES while the first table is in force', () => {
    expect(pickTable(ALL_PRICE_TABLES, '2026-11-13')).toBe(PRICES);
  });

  it('raises each Google rate on the day its promotion lapses', () => {
    // The reason the tables exist. A lapsed promotional rate left in place under-reports spend,
    // which is the direction that lets a group run past its budget without the guard noticing.
    const argon = (version: string): number => {
      const row = lookupPrice('google/gemini-4-argon', pickTable(ALL_PRICE_TABLES, version));
      return row !== null && row !== undefined && 'in' in row ? row.in : Number.NaN;
    };
    expect(argon('2026-11-30')).toBe(2.0);
    expect(argon('2026-12-01')).toBe(4.0);

    const flash = (version: string): number => {
      const row = lookupPrice('google/gemini-3.8-flash', pickTable(ALL_PRICE_TABLES, version));
      return row !== null && row !== undefined && 'in' in row ? row.in : Number.NaN;
    };
    expect(flash('2026-12-31')).toBe(0.75);
    expect(flash('2027-01-01')).toBe(1.5);
  });

  it('carries every other model forward unchanged', () => {
    // A dated table replaces the whole table, so a model whose price did not change must still be
    // there — a dropped row falls back to Opus rates and silently overstates a Haiku turn.
    const first = Object.keys(PRICES.models).toSorted();
    for (const table of ALL_PRICE_TABLES) {
      expect(Object.keys(table.models).toSorted(), table.version).toEqual(first);
    }
  });

  it('prices no Google model with a cache write, because Gemini bills none', () => {
    for (const [id, row] of Object.entries(PRICES.models)) {
      if (!id.startsWith('google/') || row === null || !('in' in row)) continue;
      expect([row.cacheWrite5m, row.cacheWrite1h], id).toEqual([0, 0]);
    }
  });
});
