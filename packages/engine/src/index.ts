/**
 * `@comvivo/engine`
 *
 * Application services: ingestion, per-group actors, the router, the turn orchestrator, the IFC-filtered context builder, the declassifier, the disclosure guard, memory services, the proactivity engine, the scheduler, digests and the consent flows.
 *
 * Scaffolded by M0-T1. The implementation lands in this package's own milestone; see
 * `docs/plan/14-milestones.md`.
 */

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
