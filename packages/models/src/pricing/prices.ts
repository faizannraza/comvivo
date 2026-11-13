/**
 * The price table and its loader (`05` §3.9.2, `M2-T3`).
 *
 * Prices are **USD per million tokens**, which is how every provider publishes them, and that unit
 * choice is what makes the arithmetic exact: `tokens × dollarsPerMTok` is micro-USD, because a
 * million micro-dollars is a dollar. So `costMicros` is an integer with no rounding step in the
 * middle, and a ledger that sums a year of turns has not accumulated a float error. `02` §3.3.7
 * stores micro-USD for the same reason.
 *
 * ## Versioned files, newest-not-in-the-future wins
 *
 * `prices.<date>.json` ships with releases. A host upgrading mid-month gets the new file and the
 * old one, and `pickTable` takes the newest `version ≤ today` — so a file dated next week (a
 * release built ahead of a price change) does not start billing early, and an old instance keeps
 * the prices it was running on. `05` §3.9.2's rule, and the reason the date is in the filename
 * rather than only inside it.
 *
 * ## What was verified on 2026-11-12, and the one correction
 *
 * `CLAUDE.md` §6. Read off `platform.claude.com/docs/en/about-claude/pricing`:
 *
 *  - Opus 5.5 `$4 / $20`, 5m write `$5`, 1h write `$8`, cache read **`$0.20`**.
 *  - Sonnet 5.5 `$2 / $10`, 5m `$2.50`, 1h `$4`, cache read **`$0.10`** — the plan's table said
 *    `$0.20`, which is double. Cache hits on Opus 5.5 and Sonnet 5.5 are 0.05× base input, and
 *    0.05 × $2 is $0.10. The error mattered in the expensive direction for the wrong reason: an
 *    overstated cache-read price inflates the cheapest part of a warm conversation, which is most
 *    of a family's traffic, and would have had the budget guard degrade groups that had not spent
 *    their budget.
 *  - Haiku 5.5 is tiered at **100,000 prompt tokens**: `$0.10 / $0.50` below, `$0.50 / $2.50`
 *    above, with cache reads `$0.01` and `$0.05`.
 *  - The Batch discount is **50%** on input and output.
 *
 * `inference_geo: 'us'` carries a 1.1× multiplier on every category. We do not send it (`05`
 * §3.5.3's client has no `inference_geo`), so there is no multiplier field here; if that ever
 * changes it is a price-table field and a new version, not a code change.
 */
import { parseOrThrow, z } from '@comvivo/shared';
import novemberTable from './prices.2026-11-12.json' with { type: 'json' };
import decemberTable from './prices.2026-12-01.json' with { type: 'json' };
import januaryTable from './prices.2027-01-01.json' with { type: 'json' };

/** The five rates every tier carries. */
const ratesShape = {
  in: z.number().nonnegative(),
  out: z.number().nonnegative(),
  cacheWrite5m: z.number().nonnegative(),
  cacheWrite1h: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
} as const;

/**
 * One tier of a tiered model.
 *
 * `maxPromptTokens` is **inclusive** and absent on the last tier, which is the catch-all. Absent
 * rather than `Infinity`, because JSON has no infinity and a sentinel number is a number somebody
 * eventually compares wrongly.
 */
export const PriceTierSchema = z
  .strictObject({ ...ratesShape, maxPromptTokens: z.number().int().positive().optional() })
  .readonly();
export type PriceTier = z.infer<typeof PriceTierSchema>;

/** A flat price, or tiers chosen by prompt size. `batchMultiplier` applies to either. */
export const ModelPriceSchema = z.union([
  z.strictObject({ ...ratesShape, batchMultiplier: z.number().positive() }).readonly(),
  z
    .strictObject({
      tiers: z.array(PriceTierSchema).min(1),
      batchMultiplier: z.number().positive(),
    })
    .readonly(),
]);
export type ModelPrice = z.infer<typeof ModelPriceSchema>;

export const PriceTableSchema = z
  .strictObject({
    $comment: z.string().optional(),
    version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a price table version is an ISO date'),
    currency: z.literal('USD'),
    sources: z.record(z.string().min(1), z.url()),
    /** `null` means "we do not know this model's prices" — see `unknownModelFallback`. */
    models: z.record(z.string().min(1), ModelPriceSchema.nullable()),
  })
  .readonly();
export type PriceTable = z.infer<typeof PriceTableSchema>;

/** The shipped table, validated at load for the reason the registry gives. */
export const PRICES: PriceTable = parseOrThrow(
  PriceTableSchema,
  novemberTable,
  'models/pricing/prices.2026-11-12.json',
);

/**
 * Every shipped table, including ones dated in the future.
 *
 * `05` §3.9.2's "newest `version ≤ today` wins" only does anything if more than one table ships,
 * and until `M2-T13` only one did. Two of Google's published rates are **promotional with stated
 * end dates** — `gemini-4-argon` through 2026-11-30, the two 3.x flash models through 2026-12-31 —
 * so the increases ship as dated tables and `pickTable` moves to each on the day.
 *
 * Shipping them is the point. A table that kept a lapsed promotional rate would under-report
 * spend, which is the direction that lets a group run past its budget without the guard noticing;
 * a note in a backlog would depend on somebody remembering in seventeen days.
 *
 * Callers that want today's rates use `pickTable(ALL_PRICE_TABLES, today)`. `PRICES` remains the
 * current table for the many call sites that are not date-aware and never will be — a test asserts
 * the two agree while the first is in force.
 */
export const ALL_PRICE_TABLES: readonly PriceTable[] = [
  PRICES,
  parseOrThrow(PriceTableSchema, decemberTable, 'models/pricing/prices.2026-12-01.json'),
  parseOrThrow(PriceTableSchema, januaryTable, 'models/pricing/prices.2027-01-01.json'),
];

/**
 * Pick the table in force on a given day.
 *
 * `05` §3.9.2: "the newest `version ≤ today` wins". Ties cannot happen (the version is the date and
 * two files cannot share one), and an empty list is a programming error rather than a host's, so it
 * throws — a cost calculator with no prices would silently bill everything at zero, which is the
 * worst possible failure for a budget guard.
 */
export function pickTable(tables: readonly PriceTable[], today: string): PriceTable {
  const eligible = tables
    .filter((table) => table.version <= today)
    .toSorted((a, b) => (a.version < b.version ? 1 : -1));
  const newest = eligible[0];
  if (newest === undefined) {
    throw new Error(
      `no price table is in force on ${today}: ${String(tables.length)} table(s) are all dated later. ` +
        'Shipping a table dated in the future would bill at zero, so this is refused.',
    );
  }
  return newest;
}

/**
 * The rates for a model at a given prompt size.
 *
 * `undefined` means the table has no row, or has `null` for it — the caller decides what to do, and
 * `05` §3.9.2 says the guard falls back to Opus rates so an unknown model is costed
 * *conservatively*. Guessing cheap would let an unknown model run a budget to zero unnoticed.
 *
 * **The tier is chosen by total prompt tokens** — input + cache read + cache write — not by input
 * alone. That is the API's own rule, and it is the reading that matters on a warm conversation:
 * most of a 120k-token prompt can be cache reads, and costing it at the short-prompt tier would
 * understate it by 5×.
 */
export function ratesFor(
  modelId: string,
  promptTokens: number,
  table: PriceTable = PRICES,
): PriceTier | undefined {
  const row = lookupPrice(modelId, table);
  if (row === undefined || row === null) return undefined;
  if (!('tiers' in row)) return row;
  for (const tier of row.tiers) {
    if (tier.maxPromptTokens === undefined || promptTokens <= tier.maxPromptTokens) return tier;
  }
  // Unreachable while the last tier has no `maxPromptTokens`, which the schema does not enforce —
  // so rather than assert, fall back to the last tier, which is the most expensive and therefore
  // the safe direction for a budget.
  return row.tiers.at(-1);
}

/** A model's row, falling back to its provider family (`local/*`). */
export function lookupPrice(
  modelId: string,
  table: PriceTable = PRICES,
): ModelPrice | null | undefined {
  if (modelId in table.models) return table.models[modelId];
  const slash = modelId.indexOf('/');
  if (slash <= 0) return undefined;
  const family = `${modelId.slice(0, slash)}/*`;
  return family in table.models ? table.models[family] : undefined;
}

/** The batch multiplier for a model, defaulting to 1 (no discount) when unknown. */
export function batchMultiplierFor(modelId: string, table: PriceTable = PRICES): number {
  const row = lookupPrice(modelId, table);
  return row === undefined || row === null ? 1 : row.batchMultiplier;
}
