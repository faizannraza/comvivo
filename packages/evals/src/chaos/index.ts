/**
 * `@comvivo/evals` chaos apparatus (`11` §3.6 S10).
 *
 * | Module | What |
 * |---|---|
 * | `provider-wire` | The Anthropic Messages and OpenAI-compatible wire formats, as pure functions |
 * | `fake-provider-server` | A loopback HTTP server that speaks them, with S10's fault plans and request capture |
 *
 * `SimPlatformServer` (the out-of-process platform with a delivery ledger) and the `Crashpoints`
 * port join them in M3 and M11; S10's oracles need all three.
 */
export {
  CAPTURED_SECRET,
  type CapturedRequest,
  DEFAULT_SERVER_ERROR_STATUS,
  FAKE_CREATED_EPOCH_SECONDS,
  type FakeProviderServer,
  type FakeProviderServerOptions,
  type FakeTurn,
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
  type FakeReply,
  type FakeStopReason,
  type FakeToolCall,
  type FakeUsage,
  frameSse,
  type OpenaiStreamOptions,
  openaiCompletion,
  openaiError,
  openaiFinishReason,
  openaiStream,
  type SseEvent,
  type WireIds,
} from './provider-wire.js';
