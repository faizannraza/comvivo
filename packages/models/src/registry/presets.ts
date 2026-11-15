/**
 * The presets and the slots they fill (`05` §3.5.2, `01` §14 A3; `M2-T2`).
 *
 * A preset is the answer to "I do not want to choose seven models". `01` §14 A3 keeps **Best**
 * pre-selected with its estimated monthly cost shown and a one-key switch, which is a product
 * decision about defaults rather than a technical one: a host who never opens the config should get
 * the version of this product that works best, and should be told what it costs before they say
 * yes.
 *
 * ## Why `chatEconomy` is a slot and not a preset
 *
 * The cost guard (`05` §3.9) steps `chat` down to `chatEconomy` when a group passes budget step 1,
 * and steps it back up the next day. That is a *route variant*, not a different configuration — so
 * it lives in the same preset row, resolves at the same time, and is validated against the same
 * route requirements. Making it a second preset would mean the step-down could land on a model
 * whose capabilities were never checked.
 *
 * ## The `local` preset's placeholders
 *
 * `local/${models.local.model}` is substituted from config at resolve time, because the model a
 * local server serves is the host's choice and is not knowable here. `smallModel` falls back to
 * `model` when unset, which is `05` §3.5.2's "same, or `models.local.smallModel` if set". A preset
 * that hard-coded a local model name would be wrong on every machine.
 */
import { parseOrThrow, z } from '@comvivo/shared';
import presetsJson from './presets.json' with { type: 'json' };

/** The seven slots a preset fills. `chatEconomy` is `chat`'s `economy` variant (`05` §3.9). */
export const ROUTE_SLOTS = [
  'chat',
  'chatEconomy',
  'route',
  'extract',
  'declassify',
  'guard',
  'consolidate',
] as const;
export type RouteSlot = (typeof ROUTE_SLOTS)[number];

/** The presets with a built-in row. `custom` is deliberately absent — see the header. */
export const BUILT_IN_PRESETS = ['best', 'balanced', 'economy', 'local'] as const;
export type BuiltInPreset = (typeof BUILT_IN_PRESETS)[number];

/** Every value `models.preset` may take, including the one with no row. */
export const PRESET_NAMES = [...BUILT_IN_PRESETS, 'custom'] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

const presetRowSchema = z
  .strictObject(
    Object.fromEntries(ROUTE_SLOTS.map((slot) => [slot, z.string().min(1)])) as Record<
      RouteSlot,
      z.ZodString
    >,
  )
  .readonly();

/**
 * One Local-preset default, by host memory (`05` §3.5.6's recommended-model table).
 *
 * **Interim.** `M8-T15`'s eval picks the final defaults by measuring tool success, extraction F1,
 * the discretion red-team subset and latency. These exist so the wizard can pre-fill something a
 * host could not otherwise choose between — "type a model name" is not a question anybody can
 * answer on first install — and so `doctor` can say which tier a machine falls in.
 */
export const LocalDefaultTierSchema = z
  .strictObject({
    /** Inclusive floor, in GB of host memory. Tiers are matched highest-first. */
    minHostMemoryGb: z.number().int().positive(),
    model: z.string().min(1),
    smallModel: z.string().min(1),
    /** Roughly what the host will download, so the wizard can warn before a 18 GB pull. */
    approxDownloadGb: z.number().positive(),
    note: z.string().min(1),
  })
  .readonly();
export type LocalDefaultTier = z.infer<typeof LocalDefaultTierSchema>;

export const PresetTableSchema = z
  .strictObject({
    $comment: z.string().optional(),
    version: z.string().min(1),
    /** `05` §3.5.6's interim Local defaults. Absent is valid: a table may ship without them. */
    localDefaults: z
      .strictObject({
        $comment: z.string().optional(),
        tiers: z.array(LocalDefaultTierSchema).min(1),
      })
      .readonly()
      .optional(),
    presets: z.strictObject(
      Object.fromEntries(BUILT_IN_PRESETS.map((name) => [name, presetRowSchema])) as Record<
        BuiltInPreset,
        typeof presetRowSchema
      >,
    ),
  })
  .readonly();

export type PresetTable = z.infer<typeof PresetTableSchema>;

export type PresetRow = PresetTable['presets'][BuiltInPreset];

/** Validated at module load, for the reason `capabilities.ts` gives. */
export const PRESETS: PresetTable = parseOrThrow(
  PresetTableSchema,
  presetsJson,
  'models/registry/presets.json',
);

/**
 * The two placeholder spellings `presets.json`'s `local` row uses.
 *
 * Named constants rather than inline literals, so the strings the data file spells are written once
 * and the suppression sits on one declaration instead of on every use.
 * `noTemplateCurlyInString` exists to catch a `${…}` written in a plain string **by accident**,
 * which is a good rule and the opposite of what these are: they are config paths a host reads in
 * the preset file, so they have to match that file's text exactly. `presets.test.ts` asserts they
 * do, which is what makes the suppression safe rather than merely quiet.
 */
const PLACEHOLDER = {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder in presets.json
  model: '${models.local.model}',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder in presets.json
  smallModel: '${models.local.smallModel}',
} as const;

/** The placeholders the `local` preset carries, and what fills them. */
export interface LocalModels {
  readonly model: string | null;
  readonly smallModel?: string | null;
}

/**
 * Substitute the `local` preset's placeholders.
 *
 * Returns `undefined` for a slot whose placeholder has no value, rather than a string containing
 * `${…}`: a route that resolved to the literal text `local/${models.local.model}` would fail at the
 * provider with a model-not-found, three layers away from the missing setting. `05` §3.5.2's boot
 * validation wants the absence, so it can say *the local preset needs `models.local.model`*.
 */
export function substituteLocal(value: string, local: LocalModels): string | undefined {
  const small = local.smallModel ?? local.model;
  const replaced = value
    .replace(PLACEHOLDER.model, local.model ?? '')
    .replace(PLACEHOLDER.smallModel, small ?? '');
  // An empty segment after `local/` means the placeholder had nothing to put there.
  // `endsWith('/')` catches a substituted-but-empty value; the `PLACEHOLDER` check catches a row
  // that used a placeholder this function does not know, which would otherwise reach a provider as
  // literal text.
  const unsubstituted = Object.values(PLACEHOLDER).some((token) => replaced.includes(token));
  return replaced.endsWith('/') || unsubstituted ? undefined : replaced;
}

/** The slot a route and variant read (`chat` + `economy` is the one that is not the route's name). */
export function slotFor(route: string, variant: 'default' | 'economy' = 'default'): RouteSlot {
  if (route === 'chat' && variant === 'economy') return 'chatEconomy';
  return route as RouteSlot;
}

/**
 * The Local defaults for a host with this much memory.
 *
 * Highest matching tier wins, and a machine below every floor gets the **smallest** tier rather
 * than `undefined`: a 4 GB host cannot run any of these well, and the wizard's job there is to say
 * so with a concrete model name and a size — `05` §3.5.6's own advice is to recommend a cloud
 * preset or a separate GPU host, which needs the comparison to be visible.
 */
export function localDefaultsFor(
  memoryGb: number,
  table: PresetTable = PRESETS,
): LocalDefaultTier | undefined {
  const tiers = table.localDefaults?.tiers;
  if (tiers === undefined || tiers.length === 0) return undefined;
  const sorted = [...tiers].toSorted((a, b) => b.minHostMemoryGb - a.minHostMemoryGb);
  return sorted.find((tier) => memoryGb >= tier.minHostMemoryGb) ?? sorted.at(-1);
}
