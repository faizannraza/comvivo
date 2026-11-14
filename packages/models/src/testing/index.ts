/**
 * `@comvivo/models/testing` — the model doubles (`11` §3.2.4).
 *
 * | Module | What |
 * |---|---|
 * | `provider-wire` | The Anthropic Messages and OpenAI-compatible wire formats, as pure functions |
 * | `fake-provider-server` | A loopback HTTP server that speaks them, with `11` §3.6 S10's fault plans and request capture |
 *
 * | `cache-sim` | The prompt cache, rendered through the real `buildChatRequest` |
 * | `fake-gateway` | `FakeModelGateway` and the script DSL |
 * | `assertions` | Prompt assertions over the captured calls, including I1's `expectNoReadUp` |
 * | `scripted-model` | Responses keyed by position, for golden journeys |
 * | `cassette-model` | Recorded responses keyed by the request hash, strict by default |
 * | `recorder` | `RecordingGateway`, which writes scrubbed fixtures |
 * | `anthropic/testing/fixtures` | A real `RouteBinding` and a minimal valid `ModelTurnRequest` |
 *
 * ## Why this is not in `@comvivo/evals`
 *
 * `11` §1568 and `14`'s `M2-T10` row both placed `FakeProviderServer` at
 * `packages/evals/src/chaos/fake-provider-server.ts`, and it was built there. It moved here at
 * `M2-T6`, when the Anthropic adapter's contract test needed it: `@comvivo/evals` depends on
 * `@comvivo/models`, so a fake in `evals` cannot serve `models`' own adapter tests without a
 * package cycle — which Turborepo refuses outright, and which `CLAUDE.md` §2 says to fix in the
 * design rather than work around.
 *
 * `11` §3.2.4's own table already says where it belongs: every model double lives in
 * `@comvivo/models/testing`, and only the worst-case *behavioural* models (`LeakyModel`,
 * `GreedyToolModel`, `GullibleModel`) live in `evals`. `FakeProviderServer` is the lowest-level
 * model double there is. `11` Q21 lists it beside `SimPlatformServer` because chaos *uses* both,
 * not because they share a home — `SimPlatformServer` is a channel double and lives with channels.
 *
 * The consumers are all test-shaped (`*.contract.test.ts`, `*.scenario.ts`), which is what
 * `testing-subpath-only-from-tests` requires, and `apps/server/src/test-mode/` is the one
 * exception `11` §1332 already carves out.
 */

/**
 * The adapter fixtures, re-exported (`M2-T17`).
 *
 * `bindingFor` builds a `RouteBinding` from the **registry's own row** rather than a hand-written
 * object, which is why it is worth sharing: a test outside this package that invented its own
 * capabilities would be asserting against a model that does not exist. `M2-T17`'s catalogue cache
 * accounting is the first consumer; `M3`'s turn tests are the next.
 */
export {
  bindingFor,
  OPUS,
  opusCapabilities,
  toolSpec,
  turnRequest,
} from '../anthropic/testing/fixtures.js';
// --- The shared adapter contract suite (11 §3.1.9, 01 §2.1; M2-T14) --------------------------
export {
  type ContractFault,
  type ContractReply,
  type ContractSubject,
  FORBIDDEN_SAMPLING_KEYS,
  runAdapterContract,
  type ToolResultRun,
  usageTotals as contractUsageTotals,
  type WireLens,
  type WireTool,
} from './adapter-contract.js';
export {
  effortsRequested,
  expectNoReadUp,
  expectNoSamplingParams,
  expectSystemBytesStable,
  expectToolResultsInSingleMessage,
  expectTurnNotesContain,
  type ReadUpCheck,
} from './assertions.js';
export {
  CACHE_SIM_DEFAULTS,
  type CacheSimOptions,
  type CacheSimUsage,
  CacheSimulator,
  type EffortStrategy,
  renderBlocks,
} from './cache-sim.js';
export {
  type CassetteEntry,
  CassetteMiss,
  CassetteModel,
  type CassetteModelOptions,
  replyText,
} from './cassette-model.js';
export {
  FAKE_EFFORTS,
  FakeModelGateway,
  type FakeModelGatewayOptions,
  FakeRule,
  FakeScriptExhausted,
  fakeToolCallId,
  ReplyBuilder,
  type ReplyScript,
  type RuleMatcher,
} from './fake-gateway.js';
export {
  type AnthropicEndpoint,
  anthropicEndpointFor,
  CAPTURED_SECRET,
  type CapturedRequest,
  DEFAULT_SERVER_ERROR_STATUS,
  FAKE_CREATED_EPOCH_SECONDS,
  type FakeProviderServer,
  type FakeProviderServerOptions,
  type FakeTurn,
  type LocalServerFacade,
  OVERLOADED_STATUS,
  PROVIDER_KINDS,
  type ProviderKind,
  startFakeProviderServer,
} from './fake-provider-server.js';
export {
  anthropicError,
  anthropicErrorType,
  anthropicMessage,
  anthropicStream,
  FAKE_THINKING_SIGNATURE,
  type FakeRefusal,
  type FakeReply,
  type FakeStopReason,
  type FakeToolCall,
  type FakeUsage,
  frameSse,
  googleError,
  googleFinishReason,
  googleGenerateContent,
  type OpenaiStreamOptions,
  openaiCompletion,
  openaiError,
  openaiFinishReason,
  openaiResponse,
  openaiResponsesError,
  openaiResponsesUsage,
  openaiStream,
  type SseEvent,
  type WireIds,
} from './provider-wire.js';
export {
  type FixtureWriter,
  type RecordedExchange,
  RecordingGateway,
  type RecordingGatewayOptions,
  scrubDeep,
  scrubText,
} from './recorder.js';
export {
  type ScriptedEntry,
  ScriptedModel,
  type ScriptedModelOptions,
  type ScriptPosition,
} from './scripted-model.js';
