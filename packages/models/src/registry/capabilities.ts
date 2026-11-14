/**
 * The capability registry (`05` §3.5.2, `M2-T2`).
 *
 * `capabilities.json` is data: what each model can do, versioned, zod-validated here, and
 * overridable per model through `models.registryOverrides`. Every consumer asks this module rather
 * than testing a model name, because a string comparison against `'claude-opus-5-5'` is a branch
 * that silently stops matching the day a route is pointed somewhere else.
 *
 * ## Why a registry and not per-adapter knowledge
 *
 * Two reasons, and the second is the one that pays. An adapter that knew its own limits would have
 * to be asked *before* a route could be validated, which inverts boot order: `05` §3.5.2 wants an
 * unmet route requirement to fail at boot with a `doctor` hint, not at the first turn. And the same
 * facts are needed by code that never touches an adapter — the cost guard picking `chatEconomy`,
 * the context builder deciding whether a cache breakpoint is worth a write, `doctor` printing what
 * a host's configuration actually resolves to.
 *
 * ## Every Anthropic row was verified, not recalled (2026-11-12)
 *
 * `CLAUDE.md` §6 asks for third-party facts to be re-checked at implementation time, and this is
 * the file where being wrong is most expensive: a wrong `maxOutput` truncates a reply, a wrong
 * `minCacheableTokens` silently stops caching, a wrong `effort` list is a 400 on every call. What
 * the live documentation said that a recollection would not have:
 *
 *  - **Haiku 5.5 has a 1M context window and 128K max output**, not the 200K/64K that Haiku 4.5
 *    had. A registry carrying 200K would have made the context builder leave most of the window
 *    unused on the cheapest route, which is the one that runs most often.
 *  - **Effort is five levels on all three models**, and the default differs: `medium` on Opus 5.5
 *    and Haiku 5.5, `high` on Sonnet 5.5. `05` §3.5.2 had Opus at `medium` and Sonnet at `high`
 *    already — the registry was right where §4.1's three-level `Effort` type was wrong.
 *  - **Thinking differs in a way that matters per model.** Opus 5.5 is adaptive-always and rejects
 *    `{type:'disabled'}` at *every* effort level; Sonnet 5.5 reports `disabled` as unsupported and
 *    offers `between_tools` as its lowest setting (400 at `xhigh`/`max`); Haiku 5.5 accepts
 *    `disabled` at `high` or below. Three different answers, so `thinking` is an enum rather than a
 *    boolean.
 *  - **Mid-conversation system messages are supported on all three.** The `claude-api` skill's
 *    list — which excluded Sonnet — predates the 5.5 generation; the live prompt-caching page names
 *    Opus 5.5, Sonnet 5.5 and Haiku 5.5 explicitly. Had the stale list been trusted, the operator
 *    channel would have been disabled on the Sonnet route and every mid-turn notice would have
 *    reset its prompt cache.
 *  - **512 cacheable tokens and 4 breakpoints** on all three.
 *
 * The non-Anthropic rows are families (`openai/*`, `google/*`, `local/*`) with deliberately
 * conservative numbers: their adapters land at `M2-T11`–`M2-T13`, and `local/*` is replaced at run
 * time by `M2-T12`'s probe ladder. A conservative row that under-promises costs a host some window;
 * an optimistic one costs them a failed turn.
 */
import { EFFORT_LEVELS, type Effort, type ModelFeatureSet } from '@comvivo/core';
import { parseOrThrow, z } from '@comvivo/shared';
import registryJson from './capabilities.json' with { type: 'json' };

/**
 * How a model handles thinking.
 *
 * Not a boolean, because the three current Anthropic models give three different answers and an
 * adapter that guessed would send a request the API rejects:
 *
 *  - `adaptive_always` — always on, `{type:'disabled'}` is a 400 at every effort level (Opus 5.5).
 *  - `adaptive_no_disable` — on, and `disabled` is unsupported; `between_tools` is the lowest
 *    setting and is itself a 400 above `high` effort (Sonnet 5.5).
 *  - `adaptive` — on by default, and `disabled` is accepted at `high` or below (Haiku 5.5).
 *  - `reasoning_items` / `thought_signatures` — the other providers' round-trippable forms.
 *  - `none` — a local server with no thinking channel.
 */
export const THINKING_MODES = [
  'adaptive_always',
  'adaptive_no_disable',
  'adaptive',
  'reasoning_items',
  'thought_signatures',
  'none',
] as const;
export type ThinkingMode = (typeof THINKING_MODES)[number];

/** How a model exposes tools (`05` §3.5.2's route requirements read this). */
export const TOOL_MODES = ['native_strict', 'native', 'envelope', 'probe', 'none'] as const;
export type ToolMode = (typeof TOOL_MODES)[number];

/** How a model answers a schema-constrained request. */
export const STRUCTURED_MODES = ['native', 'envelope', 'probe', 'none'] as const;
export type StructuredMode = (typeof STRUCTURED_MODES)[number];

/** How caching is reached: an explicit breakpoint, the server's own prefix, or not at all. */
export const CACHING_MODES = [
  'explicit',
  'automatic',
  'implicit',
  'server_prefix',
  'none',
] as const;
export type CachingMode = (typeof CACHING_MODES)[number];

const effortSchema = z.enum(EFFORT_LEVELS as unknown as [Effort, ...Effort[]]);

/**
 * One model's capabilities.
 *
 * `strictObject`, so a key the schema does not know is a validation error rather than a silently
 * ignored line in somebody's `registryOverrides`. A typo in an override is exactly the failure this
 * catches — `"maxOutputs": 4096` would otherwise leave the real `maxOutput` at its registry value
 * while the host believed they had changed it.
 */
export const ModelCapabilitiesSchema = z
  .strictObject({
    contextWindow: z.number().int().positive(),
    maxOutput: z.number().int().positive(),
    effort: z.array(effortSchema).min(1),
    defaultEffort: effortSchema,
    thinking: z.enum(THINKING_MODES),
    tools: z.enum(TOOL_MODES),
    structured: z.enum(STRUCTURED_MODES),
    parallelTools: z.boolean(),
    /**
     * Whether the model accepts `tool_choice: 'any'`/`{type:'tool'}` at all.
     *
     * Recorded and **never used to send one**: `01` §2.1 forbids forced tool choice regardless, and
     * `ModelTurnRequest.toolChoice` cannot express it. The field exists so `doctor` can explain why
     * a model that *does* support it still will not be asked, and so a future amendment has the
     * fact to hand rather than having to re-derive it.
     */
    forcedToolChoice: z.boolean(),
    /** `true`, `false`, or OpenAI's `developer` role, which is the same idea with another name. */
    midConversationSystem: z.union([z.boolean(), z.literal('developer_role')]),
    /** Whether effort can change mid-conversation without discarding the cached prefix. */
    perMessageEffort: z.boolean(),
    /** Whether a system message can carry `clear_at: 'next_user_message'`. */
    turnScopedSystem: z.boolean(),
    /** The server-side refusal fallback: `default` routes by category, `none` means unavailable. */
    serverFallback: z.enum(['default', 'none']),
    promptCaching: z.enum(CACHING_MODES),
    minCacheableTokens: z.number().int().nonnegative(),
    maxBreakpoints: z.number().int().nonnegative(),
    vision: z.boolean(),
    pdf: z.boolean(),
    batches: z.boolean(),
    countTokens: z.boolean(),
    prefill: z.boolean(),
    /** Whether earlier-turn edits invalidate thinking blocks (append-only history required). */
    preservedThinking: z.boolean(),
    /**
     * The price-table row to charge this model against, or `null` to use its own id.
     *
     * Read through `RouteBinding.priceId`. It exists for the case `05` §3.5.2's wildcard rows
     * create: a host pins a dated snapshot (`openai/gpt-6-astra-2027-03-01`), the registry answers
     * through `openai/*`, and the price table — which carries exact ids and no `openai/*` family
     * row — has nothing for it, so spend would be estimated at the fallback's rates. Setting
     * `priceKey: "openai/gpt-6-astra"` in `models.registryOverrides` prices it correctly.
     *
     * The M2 review found this field written by every row and read by nothing, which meant the
     * override above silently did nothing.
     */
    priceKey: z.string().min(1).nullable(),
  })
  .readonly();

export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

export const CapabilityRegistrySchema = z
  .strictObject({
    $comment: z.string().optional(),
    version: z.string().min(1),
    models: z.record(z.string().min(1), ModelCapabilitiesSchema),
  })
  .readonly();

export type CapabilityRegistry = z.infer<typeof CapabilityRegistrySchema>;

/**
 * The shipped registry, validated at module load.
 *
 * At load rather than on first use: a malformed registry is a build-time mistake in our own data
 * file, and the only useful time to find out is immediately. `parseOrThrow` renders the zod issues
 * with their paths, so a bad row says which model and which key.
 */
export const REGISTRY: CapabilityRegistry = parseOrThrow(
  CapabilityRegistrySchema,
  registryJson,
  'models/registry/capabilities.json',
);

/** An override map as a host writes it: a partial patch per model id. */
export const RegistryOverridesSchema = z.record(
  z.string().min(1),
  // `.partial()` before `.readonly()`: a `ZodReadonly` has no `.partial()`, so the patch schema is
  // built from the object and frozen afterwards. The order is load-bearing and `tsc` says so.
  ModelCapabilitiesSchema.unwrap().partial().readonly(),
);
export type RegistryOverrides = z.infer<typeof RegistryOverridesSchema>;

/**
 * Find a model's capabilities, falling back to its provider family.
 *
 * Exact id first, then `<provider>/*`. The wildcard is what lets a host point the local route at
 * any model name their server happens to serve without editing this file — and what makes an
 * unknown *Anthropic* model an error rather than a guess, because there is no `anthropic/*` row.
 * That asymmetry is deliberate: we know Anthropic's models exactly and must not invent numbers for
 * one we have not checked, while a local server's model is unknowable until probed.
 */
export function lookupCapabilities(
  modelId: string,
  registry: CapabilityRegistry = REGISTRY,
): ModelCapabilities | undefined {
  const exact = registry.models[modelId];
  if (exact !== undefined) return exact;
  const slash = modelId.indexOf('/');
  if (slash <= 0) return undefined;
  return registry.models[`${modelId.slice(0, slash)}/*`];
}

/**
 * The registry with a host's overrides applied.
 *
 * A patch per model, merged shallowly: `{"local/my-model": {"contextWindow": 32768}}` keeps every
 * other field. Overriding an entry the registry does not have **adds** it, which is how a host
 * teaches the product about a model we have never seen — `05` §3.5.2's stated purpose for the
 * mechanism. A partial patch for a brand-new id would leave required fields missing, so that case
 * is rejected with a message naming the keys.
 */
export function withOverrides(
  overrides: RegistryOverrides,
  registry: CapabilityRegistry = REGISTRY,
): CapabilityRegistry {
  const models: Record<string, ModelCapabilities> = { ...registry.models };
  for (const [id, patch] of Object.entries(overrides)) {
    const base = models[id] ?? lookupCapabilities(id, registry);
    const merged = { ...(base ?? {}), ...patch };
    models[id] = parseOrThrow(ModelCapabilitiesSchema, merged, `models.registryOverrides["${id}"]`);
  }
  return { ...registry, models };
}

/**
 * The capability subset `core`'s `routeInfo` publishes.
 *
 * Narrower than `ModelCapabilities` on purpose: `ModelFeatureSet` is what a *caller* branches on,
 * and the rest (pricing keys, prefill, the thinking mode) is the adapter's business. A
 * port that exposed everything would invite the engine to make provider-shaped decisions.
 */
export function toFeatureSet(capabilities: ModelCapabilities): ModelFeatureSet {
  return {
    contextWindow: capabilities.contextWindow,
    maxOutput: capabilities.maxOutput,
    effort: capabilities.effort,
    defaultEffort: capabilities.defaultEffort,
    tools: capabilities.tools,
    structured: capabilities.structured,
    parallelTools: capabilities.parallelTools,
    midConversationSystem: capabilities.midConversationSystem !== false,
    perMessageEffort: capabilities.perMessageEffort,
    promptCaching: capabilities.promptCaching,
    minCacheableTokens: capabilities.minCacheableTokens,
    maxBreakpoints: capabilities.maxBreakpoints,
    vision: capabilities.vision,
    pdf: capabilities.pdf,
    batches: capabilities.batches,
    countTokens: capabilities.countTokens,
  };
}
