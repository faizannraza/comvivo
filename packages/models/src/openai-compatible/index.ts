/**
 * The OpenAI-compatible local adapter (`05` §3.5.6; `M2-T12`).
 *
 * | Module | What |
 * |---|---|
 * | `identify` | Which of the four servers answered, through `safeFetch` on a host-supplied URL |
 * | `hints` | The server's own metadata — hints, never answers — plus the named-knob advice |
 * | `probe` | The authoritative capability probes, including the 16K needle |
 * | `ladder` | L1–L4 and what each level permits |
 * | `envelope` | The text tool protocol for the levels with no native tool calling |
 * | `request` | Chat Completions, shaped to what the weakest of four servers accepts |
 * | `response` | Native and envelope readers, and the defensive usage mapping |
 * | `adapter` | The client, `runChat`, `runStructured` and the gateway |
 */
export {
  createLocalClient,
  createLocalGateway,
  LOCAL_CLIENT_DEFAULTS,
  type LocalAdapterDeps,
  runChat,
  runStructured,
} from './adapter.js';
export {
  ENVELOPE_SCHEMA_NAME,
  type EnvelopeCall,
  type EnvelopeOutcome,
  envelopeCallId,
  envelopeInstruction,
  envelopeSchema,
  MAX_RENDERED_DESCRIPTION_CHARS,
  type ParsedEnvelope,
  parseEnvelope,
  renderCatalogue,
  type ValidatedCall,
  validateCalls,
} from './envelope.js';
export {
  contextAdviceFor,
  contextLengthFromModelInfo,
  type HintsDeps,
  type StaticHints,
  staticHintsFor,
  toolFlagAdviceFor,
} from './hints.js';
export {
  hostPortOf,
  type IdentifyDeps,
  identifyServer,
  LOCAL_SERVER_KINDS,
  type LocalServerKind,
  rootOf,
  type ServerIdentity,
  spanFlavourOf,
} from './identify.js';
export {
  LADDER_LEVELS,
  type LadderLevel,
  LEVEL_BEHAVIOUR,
  type LevelBehaviour,
  levelFor,
  levelSummary,
  type ProbedCapabilities,
} from './ladder.js';
export {
  isProbeFresh,
  type LocalProbeDeps,
  type LocalProbeOptions,
  type LocalProbeResult,
  type LocalProbeTransport,
  NEEDLE_TOKENS,
  needlePrompt,
  PROBE_TIMEOUT_MS,
  PROBE_TOOL_NAME,
  PROBE_TTL_HOURS,
  PROBE_VALUE,
  probeCacheKey,
  probeContext,
  probeReasoningEffort,
  probeStructured,
  probeTools,
  runProbes,
} from './probe.js';
export {
  assertWireInvariants,
  type BuildLocalOptions,
  type BuiltLocalRequest,
  buildLocalRequest,
  FORBIDDEN_REQUEST_KEYS,
  messagesOf,
  operatorBlock,
  WireInvariantError,
} from './request.js';
export {
  assistantMessageOf,
  type EnvelopeRead,
  envelopeCallsOf,
  LOCAL_PROVIDER,
  nativeToolCalls,
  type ParsedToolCall,
  readEnvelope,
  readStop,
  rejectionResults,
  usageIterationOf,
  visibleText,
} from './response.js';
export {
  type BuildLocalStructuredOptions,
  type BuiltLocalStructuredRequest,
  buildLocalStructuredRequest,
  readLocalStructured,
  unfence,
} from './structured.js';
