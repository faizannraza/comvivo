/**
 * The capability registry, the presets and the route resolver (`05` §3.5.2, `M2-T2`).
 *
 * One entry point, because the three are one decision: a route resolves through the presets,
 * against the registry, and is validated by the resolver. A consumer that imported only one of
 * them would be asking half a question.
 */
export {
  CACHING_MODES,
  type CachingMode,
  type CapabilityRegistry,
  CapabilityRegistrySchema,
  lookupCapabilities,
  type ModelCapabilities,
  ModelCapabilitiesSchema,
  REGISTRY,
  type RegistryOverrides,
  RegistryOverridesSchema,
  STRUCTURED_MODES,
  type StructuredMode,
  THINKING_MODES,
  type ThinkingMode,
  TOOL_MODES,
  type ToolMode,
  toFeatureSet,
  withOverrides,
} from './capabilities.js';
export {
  BUILT_IN_PRESETS,
  type BuiltInPreset,
  type LocalDefaultTier,
  LocalDefaultTierSchema,
  type LocalModels,
  localDefaultsFor,
  PRESET_NAMES,
  PRESETS,
  type PresetName,
  type PresetRow,
  type PresetTable,
  PresetTableSchema,
  ROUTE_SLOTS,
  type RouteSlot,
  slotFor,
  substituteLocal,
} from './presets.js';
export {
  bindingKey,
  MODEL_ROUTES,
  PREFERS_BATCHES,
  prefersBatches,
  type Resolution,
  type ResolveInput,
  type RouteBinding,
  type RouteProblem,
  resolveRoutes,
  resolveRoutesOrThrow,
} from './resolve.js';
