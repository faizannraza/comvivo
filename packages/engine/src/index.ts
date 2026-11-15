/**
 * `@comvivo/engine`
 *
 * Application services: ingestion, per-group actors, the router, the turn orchestrator, the IFC-filtered context builder, the declassifier, the disclosure guard, memory services, the proactivity engine, the scheduler, digests and the consent flows.
 *
 * Scaffolded by M0-T1. The implementation lands in this package's own milestone; see
 * `docs/plan/14-milestones.md`.
 */

// --- The cost guard and the budget windows (05 §3.9.3; 01 §8, §14 A3; M3-T30) ----------------
export {
  type BudgetLimits,
  type BudgetState,
  budgetLimits,
  CostGuard,
  type CostGuardDeps,
  LADDER_THRESHOLDS,
  type LadderStep,
  ladderStep,
  type MemberTurnDecision,
  MemberTurnLimiter,
  type ModelPreset,
  PER_TURN_CAP,
  type PerTurnCap,
  PRESET_BUDGETS,
  perTurnCapMicros,
  routeAllowedAtStep,
  type WindowSpend,
} from './budget/cost-guard.js';
export {
  type BudgetPeriod,
  type BudgetWindow,
  budgetWindows,
  dailyWindow,
  localDay,
  monthlyWindow,
} from './budget/windows.js';
// --- The runtime copy catalog (05 §3.11; 01 §11.12; M3-T12) -----------------------------------
export {
  BASE_LOCALE,
  type Catalog,
  type LocaleChain,
  type NoParams,
  RUNTIME_COPY_KEYS,
  RuntimeCopy,
  type RuntimeCopyKey,
  type RuntimeCopyOptions,
  type RuntimeCopyParams,
} from './copy.js';
// --- The group tool catalogue and its hash (10 §3.5.1; 01 §14 A13; M2-T17) --------------------
export {
  type BuildCatalogInput,
  buildCatalog,
  type CatalogEntry,
  type CatalogProvider,
  type CatalogSource,
  type CatalogTool,
  type CatalogVersion,
  catalogHash,
  type GroupCatalog,
  MAX_MODEL_TOOL_NAME_CHARS,
  MODEL_TOOL_NAME_PATTERN,
  modelToolName,
  ToolCatalogService,
  ToolNameTooLongError,
  toolSpecs,
} from './tools-executor/catalog.js';
// --- The turn-trace writer (05 §3.10.1; 11 §3.10.4; M3-T20) ------------------------------------
export {
  DEBUG_CAPTURE_TTL_MS,
  type SealDebugCapture,
  type TraceContext,
  type TraceSink,
  TraceWriter,
  type TraceWriterOptions,
  TurnTraceDraft,
} from './trace/trace-writer.js';
