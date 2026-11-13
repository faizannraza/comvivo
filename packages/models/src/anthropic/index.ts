/**
 * The Anthropic adapter (`05` §3.5.3), the reference provider implementation.
 *
 * | Module | What |
 * |---|---|
 * | `request` | Canonical request → wire params, and `assertWireInvariants` (`01` §2.1) |
 * | `response` | Stop reasons, the fallback boundary, echo normalization, usage iterations |
 * | `errors` | SDK exception → `ModelCallError`, most specific class first |
 * | `adapter` | The client, `runChat()`, and the `ModelGateway` it fills in |
 *
 * `M2-T8` adds `structured()`, `countTokens()`, Batches and the beta probe; `M2-T9` wraps this in
 * the limiter, breaker and the usage and trace hooks.
 */
export {
  type AnthropicAdapterDeps,
  CLIENT_DEFAULTS,
  createAnthropicClient,
  createAnthropicGateway,
  type RunOptions,
  runChat,
} from './adapter.js';
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
