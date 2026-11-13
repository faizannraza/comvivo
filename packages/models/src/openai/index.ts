/**
 * The OpenAI adapter (`05` §3.5.4; `M2-T11`).
 *
 * | Module | What |
 * |---|---|
 * | `request` | Canonical turn → Responses API params, plus `01` §2.1's invariants over the built request |
 * | `response` | Output items → stop reason, text, tool calls, usage; every item kept verbatim |
 * | `structured` | `text.format` and `05` §3.5.3.3's single repair attempt |
 * | `errors` | SDK exception → `ModelCallError`, with the three kinds this SDK has no class for |
 * | `adapter` | The client, `runChat`, `runStructured` and the gateway |
 */
export {
  CLIENT_DEFAULTS,
  createOpenAiClient,
  createOpenAiGateway,
  type OpenAiAdapterDeps,
  runChat,
  runStructured,
} from './adapter.js';
export { toModelCallError } from './errors.js';
export {
  assertWireInvariants,
  type BuildResponsesOptions,
  type BuiltResponsesRequest,
  buildResponsesRequest,
  EFFORT,
  FORBIDDEN_REQUEST_KEYS,
  inputItemsOf,
  instructionsOf,
  promptCacheKey,
  toolsOf,
  WireInvariantError,
} from './request.js';
export {
  assistantMessageOf,
  OPENAI_PROVIDER,
  type ParsedToolCall,
  readStop,
  toolCallsOf,
  usageIterationOf,
  visibleText,
} from './response.js';
export {
  type BuildStructuredOptions,
  buildStructuredRequest,
  firstOutputText,
  readStructured,
  structuredResultOf,
  withRepairTurn,
} from './structured.js';
