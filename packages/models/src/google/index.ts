/**
 * The Google adapter (`05` §3.5.5; `M2-T13`).
 *
 * | Module | What |
 * |---|---|
 * | `request` | Canonical turn → `generateContent` contents and config, with `01` §2.1's invariants |
 * | `response` | A **total** map over `FinishReason`'s twenty members, parts → text/tool calls/usage |
 * | `structured` | `responseMimeType` + `responseJsonSchema`, and the single repair attempt |
 * | `errors` | Status → kind; this SDK has exactly one error class and no headers |
 * | `adapter` | The client, `runChat`, `runStructured` and the gateway |
 */
export {
  createGoogleClient,
  createGoogleGateway,
  type GoogleAdapterDeps,
  runChat,
  runStructured,
} from './adapter.js';
export { toModelCallError } from './errors.js';
export {
  assertNoPrefill,
  assertWireInvariants,
  type BuildOptions,
  type BuiltGenerateContentRequest,
  buildGenerateContentRequest,
  contentsOf,
  FORBIDDEN_CONFIG_KEYS,
  functionDeclarationsOf,
  operatorPart,
  THINKING_LEVEL,
  WireInvariantError,
} from './request.js';
export {
  assistantMessageOf,
  FINISH_REASON_MAP,
  GOOGLE_PROVIDER,
  isRetryableToolFailure,
  type ParsedToolCall,
  partsOf,
  readStop,
  toolCallsOf,
  usageIterationOf,
  visibleText,
} from './response.js';
export {
  type BuildStructuredOptions,
  type BuiltStructuredRequest,
  buildStructuredRequest,
  readStructured,
  structuredResultOf,
  withRepairTurn,
} from './structured.js';
