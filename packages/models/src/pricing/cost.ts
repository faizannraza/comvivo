/**
 * The cost calculator (`05` §3.9.2, `M2-T3`).
 *
 * One function turns a turn's `UsageIteration[]` into integer micro-USD. Everything interesting
 * about it is in the three decisions below; the arithmetic itself is a sum.
 *
 * ## Per iteration, never per turn
 *
 * `05` §3.9.2 bills each provider round trip separately, and `ModelTurnResult.usage` is an array
 * for exactly that reason: a request that was refused and answered by the server-side fallback
 * produced two iterations, on two models, at two prices. Summing the tokens first and pricing once
 * would bill the fallback's output at the original model's rate — which, for an Opus request that
 * fell back to Haiku, is wrong by 40×.
 *
 * ## Rounding once, at the end of each category
 *
 * `costMicros = Σ round(tokens × pricePerMTok)` per category per iteration. Dollars-per-MTok times
 * tokens *is* micro-USD, so the multiplication is exact in the only place it matters; the `round`
 * is there because a price like `$0.125 / MTok` times an odd token count is a fraction of a
 * micro-dollar. Rounding per category rather than per turn keeps the ledger's rows addable: a
 * month's total is the sum of its turns, and not the sum plus a drift nobody can account for.
 *
 * ## An unknown model is costed at the most expensive rates we know
 *
 * `05` §3.9.2: the guard uses `pricing.unknownModelFallback` — Opus rates — "so it is
 * conservative". The failure that choice avoids is the quiet one: a model with no price row billed
 * at zero runs a group's budget to its limit while the guard reports nothing spent. Costing it too
 * high degrades a group early, which is visible and reversible; costing it at zero is neither.
 *
 * **"Conservative" is relative, not absolute**, and the M2 review found the plan and this package
 * both stating it as absolute. Opus is the dearest model *in the table*; it is not the dearest
 * model that can exist. `openai/gpt-6-astra` costs 15 000 micro-USD on the same tokens Opus costs
 * 6 000 — so an `openai/gpt-6-astra` that fell through to the fallback would be under-reported by
 * 60 %, which is the dangerous direction for a budget. The fallback is a floor on *visibility*,
 * never a ceiling on spend, so what keeps a group safe is that models do not fall through: see
 * `lookupPrice`, which resolves a provider's bare model id (the bug that made every iteration fall
 * through), and `models.registry` / `models.prices` in `doctor`, which say so out loud when one
 * still does.
 */
import type { UsageIteration } from '@comvivo/core';
import { batchMultiplierFor, PRICES, type PriceTable, type PriceTier, ratesFor } from './prices.js';

/** `05` §3.9.2's fallback for a model with no price row. */
export const UNKNOWN_MODEL_FALLBACK = 'anthropic/claude-opus-5-5';

/** What one iteration cost, and whether we actually knew its prices. */
export interface IterationCost {
  readonly model: string;
  readonly micros: number;
  /** `true` when the model had no row and the Opus fallback was used (`doctor` warns on this). */
  readonly estimated: boolean;
  /** The per-category breakdown, for a trace that has to explain a surprising bill. */
  readonly breakdown: {
    readonly input: number;
    readonly cacheRead: number;
    readonly cacheWrite5m: number;
    readonly cacheWrite1h: number;
    readonly output: number;
  };
}

export interface TurnCost {
  readonly micros: number;
  readonly iterations: readonly IterationCost[];
  /** True when any iteration used the fallback: one flag for the dashboard and for `doctor`. */
  readonly estimated: boolean;
}

/** Dollars per MTok × tokens = micro-USD. Rounded once, per category. */
function micros(tokens: number, dollarsPerMTok: number): number {
  return Math.round(tokens * dollarsPerMTok);
}

/**
 * The prompt size that chooses a Haiku tier.
 *
 * Input **plus both cache categories**, which is the API's rule: on a warm conversation most of a
 * long prompt is cache reads, and counting only `input` would price a 120k-token prompt at the
 * short tier and understate it fivefold.
 */
export function promptTokensOf(iteration: UsageIteration): number {
  return (
    tokens(iteration.input) +
    tokens(iteration.cacheRead) +
    tokens(iteration.cacheWrite5m) +
    tokens(iteration.cacheWrite1h)
  );
}

/**
 * A token count the arithmetic below can rely on.
 *
 * `UsageIteration`'s numbers come off a provider's JSON, and the adapters read them through the
 * SDKs' *compile-time* types. A field that arrived as a string, an object or `NaN` would make every
 * sum here `NaN`, and that is the one wrong answer with no symptom: `NaN > limit` is `false`, so a
 * budget guard fed one `NaN` stops enforcing the budget and reports nothing unusual. Every other
 * wrong number at least shows up as a wrong number.
 *
 * So a value that is not a finite, non-negative number is read as `0` and the iteration is costed
 * on what remains. Zero is the honest reading of "the provider did not tell us", and the loud
 * half is already covered: `doctor`'s `models.prices` reports an unpriced model, and a turn whose
 * usage object is unparseable produces `estimated` cost against the fallback.
 */
function tokens(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Cost one iteration. */
export function costIteration(
  iteration: UsageIteration,
  table: PriceTable = PRICES,
): IterationCost {
  const promptTokens = promptTokensOf(iteration);
  const own = ratesFor(iteration.model, promptTokens, table);
  const estimated = own === undefined;
  const rates: PriceTier | undefined = own ?? ratesFor(UNKNOWN_MODEL_FALLBACK, promptTokens, table);
  if (rates === undefined) {
    // The fallback model has no row either, which means the table itself is broken. Throwing beats
    // returning zero: a budget guard that reports nothing spent is worse than a loud failure.
    throw new Error(
      `the price table has no row for "${iteration.model}" and none for the ` +
        `${UNKNOWN_MODEL_FALLBACK} fallback either (table ${table.version})`,
    );
  }

  // The batch discount is the *model's own*, not the fallback's: a batch of an unknown model is
  // still a batch. Where the model is unknown the multiplier defaults to 1, which is conservative
  // in the same direction as the rates.
  const multiplier = iteration.batch
    ? estimated
      ? 1
      : batchMultiplierFor(iteration.model, table)
    : 1;

  // Every count goes through `tokens` for the reason its comment gives: one `NaN` from a provider
  // would make the total `NaN`, and a `NaN` total is the only wrong cost a budget guard cannot see.
  const breakdown = {
    input: micros(tokens(iteration.input), rates.in * multiplier),
    cacheRead: micros(tokens(iteration.cacheRead), rates.cacheRead * multiplier),
    cacheWrite5m: micros(tokens(iteration.cacheWrite5m), rates.cacheWrite5m * multiplier),
    cacheWrite1h: micros(tokens(iteration.cacheWrite1h), rates.cacheWrite1h * multiplier),
    // Reasoning tokens are output tokens and are billed as such — they are not a separate
    // category on the wire, and `UsageIteration.reasoning` is reported *within* `output` for
    // observability. Adding it again here would double-bill thinking.
    output: micros(tokens(iteration.output), rates.out * multiplier),
  };

  return {
    model: iteration.model,
    micros:
      breakdown.input +
      breakdown.cacheRead +
      breakdown.cacheWrite5m +
      breakdown.cacheWrite1h +
      breakdown.output,
    estimated,
    breakdown,
  };
}

/** Cost a whole turn: every iteration, at its own model's prices. */
export function costTurn(usage: readonly UsageIteration[], table: PriceTable = PRICES): TurnCost {
  const iterations = usage.map((iteration) => costIteration(iteration, table));
  return {
    micros: iterations.reduce((total, iteration) => total + iteration.micros, 0),
    iterations,
    estimated: iterations.some((iteration) => iteration.estimated),
  };
}

/** Micro-USD as a human-readable amount, for `doctor` and the dashboard. */
export function formatMicros(value: number): string {
  // Four decimal places: a single cheap turn is a few hundred micro-dollars, and `$0.00` would
  // make a budget page look broken. The guard compares integers, never this string.
  return `$${(value / 1_000_000).toFixed(4)}`;
}
