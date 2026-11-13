/**
 * `@comvivo/models`
 *
 * The `ModelGateway` implementations: provider adapters (Anthropic, OpenAI, Google and
 * OpenAI-compatible local servers), the capability registry and route resolver, pricing, the
 * middleware chain, and the deterministic fakes.
 *
 * `@comvivo/core` owns the port (`ports/model.ts`); this package owns every answer to it. Nothing
 * here is importable from `core`, and `01` §4's dependency rules prove it.
 */

export {
  batchMultiplierFor,
  costIteration,
  costTurn,
  formatMicros,
  type IterationCost,
  lookupPrice,
  type ModelPrice,
  ModelPriceSchema,
  PRICES,
  type PriceTable,
  PriceTableSchema,
  type PriceTier,
  PriceTierSchema,
  pickTable,
  promptTokensOf,
  ratesFor,
  type TurnCost,
  UNKNOWN_MODEL_FALLBACK,
} from './pricing/index.js';
export {
  BUILT_IN_PRESETS,
  type BuiltInPreset,
  bindingKey,
  CACHING_MODES,
  type CachingMode,
  type CapabilityRegistry,
  CapabilityRegistrySchema,
  type LocalModels,
  lookupCapabilities,
  MODEL_ROUTES,
  type ModelCapabilities,
  ModelCapabilitiesSchema,
  PREFERS_BATCHES,
  PRESET_NAMES,
  PRESETS,
  type PresetName,
  type PresetRow,
  type PresetTable,
  PresetTableSchema,
  prefersBatches,
  REGISTRY,
  type RegistryOverrides,
  RegistryOverridesSchema,
  type Resolution,
  type ResolveInput,
  ROUTE_SLOTS,
  type RouteBinding,
  type RouteProblem,
  type RouteSlot,
  resolveRoutes,
  resolveRoutesOrThrow,
  STRUCTURED_MODES,
  type StructuredMode,
  slotFor,
  substituteLocal,
  THINKING_MODES,
  type ThinkingMode,
  TOOL_MODES,
  type ToolMode,
  toFeatureSet,
  withOverrides,
} from './registry/index.js';
