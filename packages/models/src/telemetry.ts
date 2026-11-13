/**
 * Model spans and metrics (`11` §3.10.2–§3.10.3; `M2-T15`).
 *
 * This is the only place in `@comvivo/models` that touches telemetry, and it is deliberately a
 * **wrapper rather than a sprinkling of calls**: a span whose attributes are set from four
 * different files is a span nobody can audit, and the one thing this span has to be is auditable.
 * `01` §11.7 promises that no message or memory content leaves the process through telemetry, and
 * the GenAI conventions make that promise easy to break by accident — they *define* attributes for
 * prompts and completions, so emitting one looks like compliance.
 *
 * Three things keep it shut:
 *
 *  1. Every name comes from `@comvivo/shared/observability`'s pinned `GENAI`/`OTEL`/`ATTR` tables.
 *     No `gen_ai.*` string is spelled here.
 *  2. `Attributes` makes a content family a **compile error**, and `sanitizeAttributes` drops one
 *     at runtime for a bag assembled from `unknown`.
 *  3. `telemetry.test.ts` walks every attribute of every span this module can emit and fails if any
 *     key is in an opt-in content family — including families added to the registry after this was
 *     written, because the check is by prefix.
 *
 * ## Both vocabularies, on purpose
 *
 * A span's `gen_ai.provider.name` is the **convention's** value (`gcp.gen_ai` for Google), because
 * a span is read by portable tooling that knows those names. A metric's `provider` label is **our**
 * `ProviderId` (`google`), because a scrape is read beside `comvivo doctor`, the costs screen and
 * the config file, all of which say `google`. Picking one vocabulary for both would make one of
 * those two audiences read a name it does not use. The mapping is one function, right here.
 *
 * ## Telemetry never breaks a call
 *
 * Every failure path in this file swallows. A price table missing a row, a metrics backend that
 * throws, a tracer that was shut down mid-call: none of those is a reason a family's question goes
 * unanswered. `11` §3.10.2 says the same of `sanitizeAttributes`, and for the same reason.
 */
import type {
  Effort,
  ModelRoute,
  ModelTurnResult,
  ProviderId,
  StructuredResult,
  UsageIteration,
} from '@comvivo/core';
import type { Attributes, Metrics, Tracer } from '@comvivo/shared/observability';
import {
  ATTR,
  embeddingsSpanName,
  GENAI,
  GENAI_OPERATION,
  GENAI_PROVIDER,
  getMetrics,
  getTracer,
  inferenceSpanName,
  mergeAttributes,
  noopMetrics,
  OTEL,
  SPAN_NS,
} from '@comvivo/shared/observability';
import { costIteration, type PriceTable } from './pricing/index.js';

/**
 * The instrumentation scope name, so a trace view can tell our model spans from the engine's.
 *
 * Derived from `SPAN_NS` rather than written out: the brand guard (`13` §3.A.6) forbids a brand
 * literal under `packages/**`, which is what keeps a rename to one command.
 */
export const MODEL_TRACER_NAME = `${SPAN_NS}models`;

/**
 * Our provider ids, as the conventions spell them.
 *
 * `openai-compatible` and `fake` have no well-known value and get a custom one, which the
 * conventions explicitly permit. For a local server the *flavour* is the better answer
 * (`ollama`, `lmstudio`, …) and `providerSpanName` prefers it when the caller knows it — a span
 * that said `openai` for a llama.cpp server would route a reader to the wrong dashboard.
 */
const SPAN_PROVIDER: Readonly<Record<ProviderId, string>> = {
  anthropic: GENAI_PROVIDER.ANTHROPIC,
  openai: GENAI_PROVIDER.OPENAI,
  google: GENAI_PROVIDER.GOOGLE,
  // Its own name as the custom value, rather than defaulting to one of the four local flavours.
  // Guessing `ollama` for a vLLM server would be a wrong answer dressed as a known one, and
  // "an OpenAI-compatible server whose flavour we were not told" is exactly what this means.
  'openai-compatible': 'openai-compatible',
  // A fake gateway gets its own name too. A span claiming `anthropic` for a scripted reply would
  // make an eval run indistinguishable from a live one in a trace view.
  fake: 'fake',
};

/**
 * A widened read-only view of the map above.
 *
 * `RouteInfo.provider` is typed `string`, not `ProviderId` — a host can configure a provider the
 * registry does not know — so the lookup has to accept one. The view keeps the *declaration* total
 * over `ProviderId`, which is what makes adding a provider a compile error, while letting an
 * unknown id fall through to itself.
 */
const SPAN_PROVIDER_VIEW: Readonly<Record<string, string | undefined>> = SPAN_PROVIDER;

/** Local-server flavours that are legitimate `gen_ai.provider.name` values. */
const LOCAL_FLAVOURS: ReadonlySet<string> = new Set<string>([
  GENAI_PROVIDER.OLLAMA,
  GENAI_PROVIDER.LMSTUDIO,
  GENAI_PROVIDER.LLAMA_CPP,
  GENAI_PROVIDER.VLLM,
]);

/**
 * `gen_ai.provider.name` for one of our providers.
 *
 * `flavour` wins when it names a known local server, which is how `openai-compatible` becomes
 * `ollama` rather than a value that misattributes a local model to OpenAI.
 *
 * Returns `string` rather than `GenAiProvider | string`, which collapses to `string` anyway: the
 * value is a well-known `GenAiProvider` wherever one applies, and a permitted custom value — the
 * local flavours, `openai-compatible`, `fake`, or a host's own provider id — otherwise.
 */
export function providerSpanName(provider: string, flavour?: string): string {
  if (flavour !== undefined && LOCAL_FLAVOURS.has(flavour)) return flavour;
  return SPAN_PROVIDER_VIEW[provider] ?? provider;
}

/** `server.address` and `server.port` from a base URL, or nothing when the host is unknown. */
export function endpointAttributes(baseUrl: string | undefined): Attributes {
  if (baseUrl === undefined || baseUrl === '') return {};
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    // A malformed base URL is a config bug the adapter will report far more clearly than a span
    // would. Emitting a truncated hostname here would just make it harder to find.
    return {};
  }
  // `URL.port` is '' for a default port, so the scheme supplies it. A span that omitted the port
  // for https and carried it for a proxy would make the two look like different services.
  const port = url.port === '' ? (url.protocol === 'http:' ? 80 : 443) : Number(url.port);
  return { [OTEL.SERVER_ADDRESS]: url.hostname, [OTEL.SERVER_PORT]: port };
}

/** Token totals across every billed iteration of one call. */
export interface UsageTotals {
  /** The **convention's** input: uncached input plus both cache categories. */
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning: number;
}

/**
 * Sum one call's iterations.
 *
 * `input` follows the Anthropic convention (`11` §3.10.2): `gen_ai.usage.input_tokens` **includes**
 * cached tokens, while `UsageIteration.input` excludes them. On a warm conversation most of a long
 * prompt is a cache read, so reporting `UsageIteration.input` as the convention's input would
 * under-report by the hit rate — about 60% after warm-up per `11` §8 — and every dashboard built on
 * it would be wrong in the reassuring direction.
 */
export function usageTotals(iterations: readonly UsageIteration[]): UsageTotals {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reasoning = 0;
  for (const iteration of iterations) {
    cacheRead += iteration.cacheRead;
    cacheWrite += iteration.cacheWrite5m + iteration.cacheWrite1h;
    input +=
      iteration.input + iteration.cacheRead + iteration.cacheWrite5m + iteration.cacheWrite1h;
    output += iteration.output;
    reasoning += iteration.reasoning ?? 0;
  }
  return { input, output, cacheRead, cacheWrite, reasoning };
}

/** What the caller knows before the request goes out. */
export interface ModelSpanContext {
  readonly route: ModelRoute;
  /** As `RouteInfo` reports it: one of our `ProviderId`s, or whatever a host configured. */
  readonly provider: string;
  /** The local-server flavour, when the provider is `openai-compatible`. */
  readonly providerFlavour?: string;
  readonly requestedModel: string;
  readonly effort: Effort;
  readonly maxOutputTokens: number;
  readonly stream: boolean;
  /** `undefined` for a provider's own endpoint, which only the registry knows. */
  readonly baseUrl?: string;
  /** `json` for a structured route, `text` for a chat turn. */
  readonly outputType: 'text' | 'json';
}

/**
 * The request-side attributes, set when the span starts.
 *
 * Set at start rather than at end so a call that never returns — a hang, a cancelled turn — still
 * produces a span saying which model and which route it was. A span that only gains its attributes
 * on success describes exactly the calls nobody needs to debug.
 */
export function requestAttributes(context: ModelSpanContext): Attributes {
  return mergeAttributes(
    {
      [GENAI.OPERATION_NAME]: GENAI_OPERATION.CHAT,
      [GENAI.PROVIDER_NAME]: providerSpanName(context.provider, context.providerFlavour),
      [GENAI.REQUEST_MODEL]: context.requestedModel,
      [GENAI.REQUEST_MAX_TOKENS]: context.maxOutputTokens,
      [GENAI.REQUEST_STREAM]: context.stream,
      // Both names, per `semconv-genai.ts`: the standard one for portable tooling, ours because
      // effort is a routing decision the costs screen groups by.
      [GENAI.REQUEST_REASONING_LEVEL]: context.effort,
      [GENAI.OUTPUT_TYPE]: context.outputType,
      [ATTR.MODEL_ROUTE]: context.route,
      [ATTR.MODEL_EFFORT]: context.effort,
    },
    endpointAttributes(context.baseUrl),
  );
}

/** The response-side attributes of a successful turn. */
export function resultAttributes(result: ModelTurnResult): Attributes {
  const totals = usageTotals(result.usage);
  return {
    [GENAI.RESPONSE_MODEL]: result.model.served,
    [GENAI.RESPONSE_FINISH_REASONS]: [result.stop.reason],
    [GENAI.USAGE_INPUT_TOKENS]: totals.input,
    [GENAI.USAGE_OUTPUT_TOKENS]: totals.output,
    [GENAI.USAGE_CACHE_READ_INPUT_TOKENS]: totals.cacheRead,
    [GENAI.USAGE_CACHE_WRITE_INPUT_TOKENS]: totals.cacheWrite,
    // Omitted when zero, per `11` §3.10.2. A `reasoning.output_tokens=0` on every Haiku span is
    // noise on a series that is only interesting when it is large.
    ...(totals.reasoning === 0 ? {} : { [GENAI.USAGE_REASONING_OUTPUT_TOKENS]: totals.reasoning }),
    // The provider's request id, which is what a support ticket quotes. Not content: it is an
    // opaque id the provider assigned, and it is already in `diagnostics`.
    ...(result.diagnostics.requestId === undefined
      ? {}
      : { [GENAI.RESPONSE_ID]: result.diagnostics.requestId }),
  };
}

/** The response-side attributes of a structured call. */
export function structuredAttributes(result: StructuredResult<unknown>): Attributes {
  const totals = usageTotals(result.usage);
  return {
    [GENAI.RESPONSE_MODEL]: result.model,
    [GENAI.RESPONSE_FINISH_REASONS]: [result.kind],
    [GENAI.USAGE_INPUT_TOKENS]: totals.input,
    [GENAI.USAGE_OUTPUT_TOKENS]: totals.output,
    [GENAI.USAGE_CACHE_READ_INPUT_TOKENS]: totals.cacheRead,
    [GENAI.USAGE_CACHE_WRITE_INPUT_TOKENS]: totals.cacheWrite,
    ...(totals.reasoning === 0 ? {} : { [GENAI.USAGE_REASONING_OUTPUT_TOKENS]: totals.reasoning }),
  };
}

/**
 * `error.type` for a failed call.
 *
 * The **kind**, never the message. A provider's error text has carried prompt fragments before,
 * which is why `ModelCallError` does not interpolate it either (`01` §11.7), and a span attribute
 * is read by more people than a log line.
 */
export function errorAttributes(error: unknown): Attributes {
  return { [OTEL.ERROR_TYPE]: errorTypeOf(error) };
}

function errorTypeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'kind' in error) {
    const kind: unknown = (error as { readonly kind: unknown }).kind;
    if (typeof kind === 'string') return kind;
  }
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * The `model_requests_total` outcome.
 *
 * Bounded by construction: one of `ok`, the two incomplete stop reasons, `refused`, or a
 * `ModelCallErrorKind`. That is about twenty values, which keeps the series count inside `11` §8's
 * 5,000-series budget even multiplied by route and model.
 */
export function outcomeOf(result: ModelTurnResult): string {
  switch (result.stop.reason) {
    case 'refusal':
      return 'refused';
    case 'max_tokens':
      return 'truncated';
    case 'context_overflow':
      return 'context_overflow';
    case 'end_turn':
    case 'tool_use':
    case 'pause_turn':
    case 'other':
      return 'ok';
  }
}

export interface ModelTelemetryDeps {
  /** Defaults to the installed tracer, which is a frozen no-op when tracing is off. */
  readonly tracer?: Tracer;
  /** Defaults to the installed metrics backend, which is a no-op when `/metrics` is off. */
  readonly metrics?: Metrics;
  /** Omit to use the built-in price table. */
  readonly prices?: PriceTable;
  /** The group to attribute spend to, when `metrics.perGroupLabels` is on (`11` §3.10.3). */
  readonly group?: string;
}

function tracerOf(deps: ModelTelemetryDeps): Tracer {
  return deps.tracer ?? getTracer(MODEL_TRACER_NAME);
}

function metricsOf(deps: ModelTelemetryDeps): Metrics {
  return deps.metrics ?? getMetrics();
}

/** The label bag every model metric shares. */
interface ModelLabels {
  readonly route: string;
  readonly provider: string;
  readonly model: string;
}

/**
 * Record one call's metrics.
 *
 * Exported so a test can assert the catalog's label sets without going through a span, and so an
 * adapter that is not behind the chain — `doctor --models`, say — can still report.
 *
 * Wrapped in a single `try`: a metrics backend is a third-party library holding a registry, and a
 * duplicate-registration error from it must not become a failed reply.
 */
export function recordModelMetrics(
  deps: ModelTelemetryDeps,
  labels: ModelLabels,
  observation: {
    readonly outcome: string;
    readonly durationSeconds: number;
    readonly usage: readonly UsageIteration[];
  },
): void {
  const metrics = metricsOf(deps);
  if (metrics === noopMetrics()) return;
  try {
    metrics.counter('model_requests_total').inc({ ...labels, outcome: observation.outcome });
    metrics
      .histogram('model_request_duration_seconds')
      .observe(labels, observation.durationSeconds);

    const totals = usageTotals(observation.usage);
    const tokens = metrics.counter('model_tokens_total');
    // `input` here is the **uncached** remainder, not the convention's sum: the four series are
    // meant to add up to the bill, and a dashboard that summed them after folding cache reads into
    // `input` would double-count every warm prompt.
    tokens.inc({ ...labels, type: 'input' }, totals.input - totals.cacheRead - totals.cacheWrite);
    tokens.inc({ ...labels, type: 'output' }, totals.output);
    tokens.inc({ ...labels, type: 'cache_read' }, totals.cacheRead);
    tokens.inc({ ...labels, type: 'cache_write' }, totals.cacheWrite);

    const usd = costUsd(observation.usage, deps.prices);
    if (usd !== undefined) {
      metrics
        .counter('model_cost_usd_total')
        .inc({ ...labels, ...(deps.group === undefined ? {} : { group: deps.group }) }, usd);
    }
  } catch {
    // Swallowed deliberately. See the header: telemetry never breaks a call.
  }
}

/**
 * One call's cost in US dollars, or `undefined` when it cannot be priced.
 *
 * `costIteration` **throws** when the price table has no row for the model and none for the
 * fallback either, which is the right behaviour there — a budget guard that reports nothing spent
 * is worse than a loud failure — and the wrong behaviour here. A metric that is missing is a gap in
 * a graph; an exception is a dropped reply.
 */
export function costUsd(
  iterations: readonly UsageIteration[],
  prices?: PriceTable,
): number | undefined {
  let micros = 0;
  for (const iteration of iterations) {
    try {
      micros += costIteration(iteration, prices).micros;
    } catch {
      return undefined;
    }
  }
  return micros / 1_000_000;
}

/**
 * Wrap a model call in a CLIENT span and record its metrics.
 *
 * CLIENT and not INTERNAL: the call leaves the process. The span measures **only** the provider
 * call — it is the innermost stage of the chain (`05` §3.5.1), inside the limiter so queue time is
 * not counted as provider latency, and inside the trace and usage hooks so neither a journal write
 * nor a SQLite transaction inflates `model_request_duration_seconds`.
 */
export async function withModelSpan(
  deps: ModelTelemetryDeps,
  context: ModelSpanContext,
  fn: () => Promise<ModelTurnResult>,
): Promise<ModelTurnResult> {
  const startedAt = performance.now();
  const labels = {
    route: context.route,
    provider: context.provider,
    model: context.requestedModel,
  };
  return tracerOf(deps).withSpanAsync(
    inferenceSpanName(GENAI_OPERATION.CHAT, context.requestedModel),
    { kind: 'client', attributes: requestAttributes(context) },
    async (span) => {
      try {
        const result = await fn();
        span.setAttributes(resultAttributes(result));
        recordModelMetrics(deps, labels, {
          outcome: outcomeOf(result),
          // The adapter's own measurement when it has one: it starts the clock after the request is
          // built and stops it on the last byte, which is closer to the provider's latency than a
          // wrapper that also times our serialisation.
          durationSeconds: result.latency.totalMs / 1000,
          usage: result.usage,
        });
        return result;
      } catch (error) {
        span.setAttributes(errorAttributes(error));
        recordModelMetrics(deps, labels, {
          outcome: errorTypeOf(error),
          durationSeconds: (performance.now() - startedAt) / 1000,
          usage: [],
        });
        throw error;
      }
    },
  );
}

/**
 * Wrap a structured call.
 *
 * Still `gen_ai.operation.name=chat` — the conventions have no separate structured operation, and
 * `gen_ai.output.type=json` is how they say it. The outcome label is the structured result's own
 * kind, so `invalid` and `truncated` are visible as outcomes rather than hidden inside `ok`.
 */
export async function withStructuredSpan<T>(
  deps: ModelTelemetryDeps,
  context: ModelSpanContext,
  fn: () => Promise<StructuredResult<T>>,
): Promise<StructuredResult<T>> {
  const startedAt = performance.now();
  const labels = {
    route: context.route,
    provider: context.provider,
    model: context.requestedModel,
  };
  return tracerOf(deps).withSpanAsync(
    inferenceSpanName(GENAI_OPERATION.CHAT, context.requestedModel),
    { kind: 'client', attributes: requestAttributes({ ...context, outputType: 'json' }) },
    async (span) => {
      try {
        const result = await fn();
        span.setAttributes(structuredAttributes(result));
        recordModelMetrics(deps, labels, {
          outcome: result.kind === 'ok' ? 'ok' : result.kind,
          durationSeconds: (performance.now() - startedAt) / 1000,
          usage: result.usage,
        });
        return result;
      } catch (error) {
        span.setAttributes(errorAttributes(error));
        recordModelMetrics(deps, labels, {
          outcome: errorTypeOf(error),
          durationSeconds: (performance.now() - startedAt) / 1000,
          usage: [],
        });
        throw error;
      }
    },
  );
}

export interface EmbeddingsSpanContext {
  readonly provider: string;
  readonly providerFlavour?: string;
  readonly model: string;
  readonly count: number;
  /** Omit for a local model; a local embedder makes no network call. */
  readonly baseUrl?: string;
}

/**
 * Wrap an embedding batch.
 *
 * INTERNAL when the model runs in-process and CLIENT when it is an API, which `11` §3.10.2 spells
 * out and which matters to a reader: an INTERNAL span with 400 ms of latency is a slow CPU, and a
 * CLIENT span with the same latency is a slow network. The kind is derived from whether there is an
 * endpoint at all, so the two cannot disagree.
 *
 * No metric: the catalog has no embeddings series, because an embedding batch is bounded by the
 * memory subsystem's own counters and adding four series per model to a scrape budgeted at 5,000
 * would buy a number nobody asked for.
 */
export async function withEmbeddingsSpan(
  deps: ModelTelemetryDeps,
  context: EmbeddingsSpanContext,
  fn: () => Promise<readonly Float32Array[]>,
): Promise<readonly Float32Array[]> {
  const local = context.baseUrl === undefined;
  return tracerOf(deps).withSpanAsync(
    embeddingsSpanName(context.model),
    {
      kind: local ? 'internal' : 'client',
      attributes: mergeAttributes(
        {
          [GENAI.OPERATION_NAME]: GENAI_OPERATION.EMBEDDINGS,
          [GENAI.PROVIDER_NAME]: providerSpanName(context.provider, context.providerFlavour),
          [GENAI.REQUEST_MODEL]: context.model,
          [ATTR.EMBED_COUNT]: context.count,
        },
        endpointAttributes(context.baseUrl),
      ),
    },
    async (span) => {
      const vectors = await fn();
      // The dimension count comes from the result rather than the registry: a model served by a
      // local runtime that was swapped underneath us returns a different width, and a span that
      // reported the configured width would hide exactly that.
      const first = vectors[0];
      if (first !== undefined) {
        span.setAttributes({ [GENAI.EMBEDDINGS_DIMENSION_COUNT]: first.length });
      }
      return vectors;
    },
  );
}
