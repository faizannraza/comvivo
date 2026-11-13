/**
 * `@comvivo/models/testing` — the model doubles (`11` §3.2.4).
 *
 * | Module | What |
 * |---|---|
 * | `provider-wire` | The Anthropic Messages and OpenAI-compatible wire formats, as pure functions |
 * | `fake-provider-server` | A loopback HTTP server that speaks them, with `11` §3.6 S10's fault plans and request capture |
 *
 * `M2-T7` adds `FakeModelGateway`, `ScriptedModel` and `CassetteModel` beside them.
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
  FAKE_THINKING_SIGNATURE,
  type FakeRefusal,
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
