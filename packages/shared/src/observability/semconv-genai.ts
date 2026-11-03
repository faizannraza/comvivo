/**
 * GenAI semantic-convention names, pinned.
 *
 * ## Why this file exists
 *
 * The GenAI semantic conventions are **Development** status: they live in their own repository,
 * `open-telemetry/semantic-conventions-genai`, which publishes **no tagged releases** and no
 * versioned artefact to depend on. The opentelemetry.io pages for them are still stubs. There is
 * therefore nothing to `pnpm add`, and nothing that would tell us when a name changed underneath
 * us (`11` §3.10.2).
 *
 * So every name is written out here once, pinned to a commit, and an upgrade is a deliberate pull
 * request whose diff shows the span shape changing. Instrumentation elsewhere imports from here and
 * never spells a `gen_ai.*` string inline.
 *
 * ## Pin
 *
 *   repo:     https://github.com/open-telemetry/semantic-conventions-genai
 *   commit:   95aff9cdf605bbc7d7e8f7c4745a693bd0c4eea8
 *   dated:    2026-11-03 ("docs(gen-ai): clarify remote client vs local internal agent
 *             invocations (#493) (#524)")
 *   status:   Development; 0 tags at the time of pinning
 *   verified: 2026-11-03 (M0-T9) — re-read `docs/gen-ai/{client-inference,anthropic,
 *             gen-ai-agent-spans,gen-ai-spans,gen-ai-token-metrics,client-embeddings}.md` at that
 *             commit and confirmed every name below appears there.
 *
 * ## To upgrade
 *
 * 1. Diff `docs/gen-ai/` between the pinned commit and the new one.
 * 2. Update the pin block above, the names below, and `GENAI_OPT_IN_CONTENT_ATTRIBUTES`.
 * 3. Run `pnpm test packages/shared/src/observability` — `semconv-genai.test.ts` fails if the
 *    opt-in snapshot is no longer covered by `FORBIDDEN_ATTRIBUTE_FAMILIES`, which is the check
 *    that keeps a newly added content attribute from becoming emittable.
 * 4. Model span shapes are asserted against an in-memory exporter in `M2-T15`; that diff is the
 *    review artefact.
 *
 * ## Why we do not auto-instrument
 *
 * No HTTP, undici or provider-SDK auto-instrumentation is installed. Two reasons, both concrete:
 * a Telegram request URL *is* the bot token, and third-party GenAI instrumentations capture prompt
 * and completion content by default. Hand-instrumenting is more work and the only way to know what
 * leaves the process. It also makes `OTEL_SEMCONV_STABILITY_OPT_IN` irrelevant to us.
 */
import { BRAND } from '../brand.js';

/** The pinned commit, exported so `doctor` and the span-shape tests can report what we built against. */
export const GENAI_SEMCONV = {
  repo: 'open-telemetry/semantic-conventions-genai',
  commit: '95aff9cdf605bbc7d7e8f7c4745a693bd0c4eea8',
  committed: '2026-11-03',
  verified: '2026-11-03',
  status: 'development',
} as const;

/**
 * Attributes we **do** emit.
 *
 * Every one is `Recommended` or `Required` at the pinned commit, and none carries message, memory
 * or instruction content. The grouping mirrors the docs so a reviewer can check them side by side.
 */
export const GENAI = {
  // --- Operation and provider -------------------------------------------------------------------
  OPERATION_NAME: 'gen_ai.operation.name',
  PROVIDER_NAME: 'gen_ai.provider.name',

  // --- Agent (gen-ai-agent-spans.md) ------------------------------------------------------------
  AGENT_NAME: 'gen_ai.agent.name',
  AGENT_ID: 'gen_ai.agent.id',
  CONVERSATION_ID: 'gen_ai.conversation.id',

  // --- Request (client-inference.md) ------------------------------------------------------------
  REQUEST_MODEL: 'gen_ai.request.model',
  REQUEST_MAX_TOKENS: 'gen_ai.request.max_tokens',
  REQUEST_STREAM: 'gen_ai.request.stream',
  /**
   * Added to the registry after the plan was written. It is the standard home for what `11`
   * §3.10.2 carried as the custom `comvivo.model.effort`, so both are emitted: the standard one for
   * portable tooling, ours because `effort` is a product-level routing decision we query by.
   */
  REQUEST_REASONING_LEVEL: 'gen_ai.request.reasoning.level',

  // --- Response ---------------------------------------------------------------------------------
  RESPONSE_MODEL: 'gen_ai.response.model',
  RESPONSE_ID: 'gen_ai.response.id',
  RESPONSE_FINISH_REASONS: 'gen_ai.response.finish_reasons',
  OUTPUT_TYPE: 'gen_ai.output.type',

  // --- Usage (anthropic.md, gen-ai-token-metrics.md) --------------------------------------------
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  USAGE_CACHE_READ_INPUT_TOKENS: 'gen_ai.usage.cache_read.input_tokens',
  USAGE_CACHE_WRITE_INPUT_TOKENS: 'gen_ai.usage.cache_write.input_tokens',
  USAGE_REASONING_OUTPUT_TOKENS: 'gen_ai.usage.reasoning.output_tokens',

  // --- Tools (gen-ai-spans.md) ------------------------------------------------------------------
  TOOL_NAME: 'gen_ai.tool.name',
  TOOL_CALL_ID: 'gen_ai.tool.call.id',
  TOOL_TYPE: 'gen_ai.tool.type',
  TOOL_DESCRIPTION: 'gen_ai.tool.description',

  // --- Embeddings (client-embeddings.md) --------------------------------------------------------
  EMBEDDINGS_DIMENSION_COUNT: 'gen_ai.embeddings.dimension.count',
} as const satisfies Record<string, `gen_ai.${string}`>;

/** General OTel attributes used on the same spans. */
export const OTEL = {
  ERROR_TYPE: 'error.type',
  SERVER_ADDRESS: 'server.address',
  SERVER_PORT: 'server.port',
  SERVICE_NAME: 'service.name',
  SERVICE_VERSION: 'service.version',
  SERVICE_INSTANCE_ID: 'service.instance.id',
} as const;

/** `gen_ai.operation.name` values. */
export const GENAI_OPERATION = {
  CHAT: 'chat',
  INVOKE_AGENT: 'invoke_agent',
  EXECUTE_TOOL: 'execute_tool',
  EMBEDDINGS: 'embeddings',
} as const;

export type GenAiOperation = (typeof GENAI_OPERATION)[keyof typeof GENAI_OPERATION];

/**
 * `gen_ai.provider.name` values.
 *
 * The first three are well-known. The local-server names are custom values, which the conventions
 * explicitly permit when no well-known value applies — and none does, because a llama.cpp server
 * is not a vendor.
 */
export const GENAI_PROVIDER = {
  ANTHROPIC: 'anthropic',
  OPENAI: 'openai',
  /** `@google/genai`. Spelled with a dot, unlike the others. */
  GOOGLE: 'gcp.gen_ai',
  OLLAMA: 'ollama',
  LMSTUDIO: 'lmstudio',
  LLAMA_CPP: 'llama_cpp',
  VLLM: 'vllm',
} as const;

export type GenAiProvider = (typeof GENAI_PROVIDER)[keyof typeof GENAI_PROVIDER];

/**
 * Opt-In content attributes at the pinned commit, as a snapshot.
 *
 * **None of these is ever set.** No configuration key enables them, and
 * `OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT` is ignored — `01` §11.7 is a product promise to
 * people whose family chat this is, not a default we tune.
 *
 * The list grew from 6 to 15 between the plan being written (2026-11-01) and this task
 * (2026-11-03), which is the argument for `FORBIDDEN_ATTRIBUTE_FAMILIES` below: an exact-match
 * denylist against a Development-status registry falls behind, silently, in days. The snapshot's
 * only job is to prove in a test that the families still cover every known one.
 */
export const GENAI_OPT_IN_CONTENT_ATTRIBUTES: readonly string[] = [
  'gen_ai.input.messages',
  'gen_ai.input.messages_ref',
  'gen_ai.output.messages',
  'gen_ai.output.messages_ref',
  'gen_ai.system_instructions',
  'gen_ai.system_instructions_ref',
  'gen_ai.tool.definitions',
  'gen_ai.tool.definitions_ref',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
  'gen_ai.memory.query.text',
  'gen_ai.memory.records',
  'gen_ai.retrieval.query.text',
  'gen_ai.retrieval.documents',
  'gen_ai.prompt.variable',
];

/**
 * Compute `gen_ai.usage.input_tokens` from an Anthropic usage block.
 *
 * Anthropic's `input_tokens` **excludes** cached tokens; the convention's `input_tokens` includes
 * them. So the sum rule is normative, not a nicety:
 *
 *     gen_ai.usage.input_tokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
 *
 * Getting this wrong under-reports input by the cache hit rate, which on a warm conversation is
 * most of the prompt — `11` §8 assumes roughly 60% cache reads after warm-up, so a naive reading
 * would report about 40% of the true input and make every cost dashboard wrong in the safe-looking
 * direction. `UsageRecord` keeps the raw split (`05`), so this conversion happens only at the
 * telemetry boundary.
 */
export function anthropicInputTokens(usage: {
  readonly input_tokens: number;
  readonly cache_read_input_tokens?: number | null | undefined;
  readonly cache_creation_input_tokens?: number | null | undefined;
}): number {
  return (
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

// --- Span names ---------------------------------------------------------------------------------
//
// The conventions give a shape (`{operation} {model}`) rather than a literal, so these are builders.
// Our own spans are namespaced with the brand slug so a trace view shows at a glance which spans
// are ours and which came from a library.

/** Our span namespace, e.g. `comvivo.`. Derived from `BRAND` so the rename codemod reaches it. */
export const SPAN_NS = `${BRAND.slug}.` as const;

/** `chat claude-opus-5-5`. */
export function inferenceSpanName(operation: GenAiOperation, model: string): string {
  return `${operation} ${model}`;
}

/** `invoke_agent comvivo`. Span kind INTERNAL: the agent runs in this process, not over the wire. */
export function agentSpanName(agentName: string = BRAND.slug): string {
  return `${GENAI_OPERATION.INVOKE_AGENT} ${agentName}`;
}

/** `execute_tool remind`. */
export function toolSpanName(toolName: string): string {
  return `${GENAI_OPERATION.EXECUTE_TOOL} ${toolName}`;
}

/** `embeddings bge-small-en-v1.5`. */
export function embeddingsSpanName(model: string): string {
  return `${GENAI_OPERATION.EMBEDDINGS} ${model}`;
}

/**
 * Our own span names (`11` §3.10.2).
 *
 * Keyed by a stable symbolic name; the emitted string carries the brand namespace. `job` is a
 * builder because the kind is part of the name.
 */
export const SPAN = {
  INGEST: `${SPAN_NS}ingest`,
  CONTEXT_BUILD: `${SPAN_NS}context.build`,
  DECLASSIFY: `${SPAN_NS}declassify`,
  GUARD_CHECK: `${SPAN_NS}guard.check`,
  OUTBOX_SEND: `${SPAN_NS}outbox.send`,
} as const;

/** `comvivo.job digest.morning`. */
export function jobSpanName(kind: string): string {
  return `${SPAN_NS}job ${kind}`;
}

/**
 * Our own span attributes (`11` §3.10.2), namespaced by brand.
 *
 * Built at module load rather than written as literals so the rename codemod (`13` §3.A.6) has one
 * place to change, and so a stale prefix cannot survive in a string nobody greps for.
 */
export const ATTR = {
  CHANNEL: `${SPAN_NS}channel`,
  GROUP_ID: `${SPAN_NS}group.id`,
  INGEST_OUTCOME: `${SPAN_NS}ingest.outcome`,
  TURN_ID: `${SPAN_NS}turn.id`,
  TURN_TRIGGER: `${SPAN_NS}turn.trigger`,
  TURN_DISPOSITION: `${SPAN_NS}turn.disposition`,
  TURN_STATUS: `${SPAN_NS}turn.status`,
  AUDIENCE_SIZE: `${SPAN_NS}audience.size`,
  COST_MICROS: `${SPAN_NS}cost.micros`,
  CONTEXT_ITEMS: `${SPAN_NS}context.items`,
  CONTEXT_FILTERED_OUT: `${SPAN_NS}context.filtered_out`,
  CONTEXT_CONSTRAINTS: `${SPAN_NS}context.constraints`,
  CONSTRAINTS_COUNT: `${SPAN_NS}constraints.count`,
  CONSTRAINTS_REJECTED: `${SPAN_NS}constraints.rejected`,
  MODEL_ROUTE: `${SPAN_NS}model.route`,
  MODEL_EFFORT: `${SPAN_NS}model.effort`,
  EMBED_COUNT: `${SPAN_NS}embed.count`,
  POLICY_DECISION: `${SPAN_NS}policy.decision`,
  TOOL_EFFECT: `${SPAN_NS}tool.effect`,
  GUARD_RESULT: `${SPAN_NS}guard.result`,
  GUARD_STAGE: `${SPAN_NS}guard.stage`,
  OUTBOX_ATTEMPT: `${SPAN_NS}outbox.attempt`,
  OUTBOX_OUTCOME: `${SPAN_NS}outbox.outcome`,
  JOB_KIND: `${SPAN_NS}job.kind`,
  JOB_ATTEMPT: `${SPAN_NS}job.attempt`,
  JOB_LAG_MS: `${SPAN_NS}job.lag_ms`,
  JOB_OUTCOME: `${SPAN_NS}job.outcome`,
} as const;
