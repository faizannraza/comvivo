/**
 * The Anthropic adapter (`05` §3.5.3), the reference provider implementation.
 *
 * | Module | What |
 * |---|---|
 * | `request` | Canonical request → wire params, and `assertWireInvariants` (`01` §2.1) |
 * | `response` | Stop reasons, the fallback boundary, echo normalization, usage iterations |
 * | `errors` | SDK exception → `ModelCallError`, most specific class first |
 * | `structured` | `output_config.format`, the one repair attempt, and the four outcomes |
 * | `count` | `countTokens()` and the local estimator's calibration |
 * | `batches` | Submit, poll, stream, cancel and delete, keyed by `custom_id` |
 * | `betas` | The boot probe, with a bisect to name the beta an organisation lacks |
 * | `adapter` | The client, `runChat()`, `runStructured()`, and the `ModelGateway` |
 *
 * `M2-T9` wraps this in the limiter, the breaker and the usage and trace hooks.
 */
export {
  type AnthropicAdapterDeps,
  BATCH_CALL_TIMEOUT_MS,
  BATCH_RESULTS_TIMEOUT_MS,
  CLIENT_DEFAULTS,
  COUNT_TOKENS_TIMEOUT_MS,
  cancelAnthropicBatch,
  createAnthropicClient,
  createAnthropicGateway,
  deleteAnthropicBatch,
  type RunOptions,
  runChat,
  runStructured,
} from './adapter.js';
export {
  BATCH_MAX_HOURS,
  BATCH_RESULTS_RETENTION_DAYS,
  BATCH_TIMEOUT_HOURS,
  type BatchDeps,
  type BatchRequest,
  batchResults,
  CUSTOM_ID_PATTERN,
  cancelBatch,
  customIdFor,
  deleteBatch,
  pollBatch,
  submitBatch,
} from './batches.js';
export { PROBE_REQUEST, type ProbeDeps, type ProbeResult, probeBetas } from './betas.js';
export {
  type CountTokensDeps,
  calibrateEstimator,
  countTokens,
  type EstimatorCalibration,
} from './count.js';
export { retryAfterMs, toModelCallError } from './errors.js';
export {
  type AnthropicChatParams,
  assertWireInvariants,
  type BuildChatOptions,
  type BuiltChatRequest,
  buildChatRequest,
  FORBIDDEN_REQUEST_KEYS,
  type InvariantContext,
  MAX_CACHE_BREAKPOINTS,
  OPTIONAL_BETAS,
  WireInvariantError,
} from './request.js';
export {
  ANTHROPIC_PROVIDER,
  assistantMessageOf,
  assistantPartsOf,
  lastFallbackIndex,
  normalizeForEcho,
  readStop,
  servedByFallback,
  toolCallsAfterLastFallback,
  usageIterations,
  visibleTextAfterLastFallback,
} from './response.js';
export {
  type BuiltStructuredRequest,
  buildStructuredRequest,
  firstTextBlock,
  invalidOutputEvent,
  MAX_ISSUE_SUMMARY_CHARS,
  readStructured,
  type StructuredAttempt,
  structuredResultOf,
  structuredServedByFallback,
  summariseIssues,
  withRepairTurn,
} from './structured.js';
