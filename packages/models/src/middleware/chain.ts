/**
 * The middleware chain (`05` §3.5.1; `M2-T9`).
 *
 * `limiter` → `breaker` → `trace-hook` → `usage-hook` → adapter, in that order, and the order is
 * the specification rather than a preference:
 *
 *  - **`limiter` first**, because a call that is going to wait should wait *before* it consumes
 *    anything else. Queueing behind the breaker would mean a queued call held a breaker decision
 *    made thirty seconds earlier.
 *  - **`breaker` second**, so a provider that is down is refused without taking a limiter slot for
 *    the length of a timeout. That is the difference between an outage that degrades one provider
 *    and one that stalls the host.
 *  - **`trace-hook` inside both**, so the recorded duration is the provider's and not the queue's.
 *    A trace that included queue time would make every slow minute look like a slow provider.
 *  - **`usage-hook` innermost**, because it needs the result.
 *  - **`telemetry` innermost of all** (`M2-T15`), wrapping only the adapter call, so the OTel span's
 *    duration and `model_request_duration_seconds` are the provider's latency and not ours. A span
 *    outside the usage hook would include a SQLite transaction in every model-latency graph.
 *
 * ## What the chain does not do
 *
 * It does not retry. `05` §3.5.3.10: interactive routes rely on the SDK's own bounded retries
 * inside the turn's deadline, and background routes rely on the job queue's backoff (ADR-012).
 * A retry here would be a third, invisible layer, and the wall-clock worst case is already
 * `timeout × (maxRetries + 1)`.
 */
import type {
  Effort,
  ModelGateway,
  ModelRoute,
  ModelTurnRequest,
  ModelTurnResult,
  RouteInfo,
  RouteVariant,
  StructuredRequest,
  StructuredResult,
} from '@comvivo/core';
import type { Logger } from '@comvivo/shared';
import { hashStructuredRequest, hashTurnRequest } from '../request-hash.js';
import {
  type ModelSpanContext,
  type ModelTelemetryDeps,
  withModelSpan,
  withStructuredSpan,
} from '../telemetry.js';
import type { BreakerRegistry } from './breaker.js';
import type { PriorityLimiter } from './limiter.js';
import { type ModelCallTrace, withTrace } from './trace-hook.js';
import { recordUsage, type UsageContext, type UsageHookDeps } from './usage-hook.js';

export interface ChainDeps {
  readonly inner: ModelGateway;
  readonly limiter: PriorityLimiter;
  readonly breakers: BreakerRegistry;
  readonly logger: Logger;
  /** Where a trace row goes. Omit to record nothing. */
  readonly emitTrace?: (trace: ModelCallTrace) => void;
  /** Omit to record no usage — for a test, or a host running entirely on a local model. */
  readonly usage?: UsageHookDeps;
  /**
   * The group's local date and correlation for a call, which only the caller knows.
   *
   * Returns `undefined` when there is nothing to attribute the spend to, in which case no usage
   * record is written: a row with no group and no day cannot be rolled up or budgeted against.
   */
  readonly usageContextFor?: (
    req: ModelTurnRequest | StructuredRequest<unknown>,
  ) => UsageContext | undefined;
  /** Omit to emit no spans and no model metrics (`M2-T15`). */
  readonly telemetry?: ModelTelemetryOptions;
}

/**
 * What the chain needs to describe a call to OTel, beyond what `ModelTelemetryDeps` carries.
 *
 * `endpointFor` and `flavourFor` are lookups rather than values because the chain wraps a gateway
 * that may serve several providers: the registry knows each one's base URL and, for a local server,
 * its flavour, and neither belongs in `RouteInfo` (which is a *route*'s answer, read by `doctor`).
 */
export interface ModelTelemetryOptions extends ModelTelemetryDeps {
  /** The provider's base URL, for `server.address`/`server.port`. Omit for a provider's default. */
  readonly endpointFor?: (provider: string) => string | undefined;
  /** `ollama`, `lmstudio`, `llama_cpp` or `vllm` for an `openai-compatible` provider. */
  readonly flavourFor?: (provider: string) => string | undefined;
  /**
   * Whether the adapter streams.
   *
   * The Anthropic adapter streams every turn-path call (`05` §3.5.3.1: these models allow 128K
   * output tokens, so a non-streaming request risks a request timeout) and streams no structured
   * call (one bounded JSON value). Both default to that; an adapter that differs says so.
   */
  readonly streamsTurns?: boolean;
  readonly streamsStructured?: boolean;
}

/**
 * Wrap a gateway in the chain.
 *
 * `routeInfo` and `embed` pass straight through: the first is a pure lookup and the second is a
 * local model, so neither belongs in a queue sized for provider calls.
 */
export function withMiddleware(deps: ChainDeps): ModelGateway {
  const run = async (req: ModelTurnRequest, signal: AbortSignal): Promise<ModelTurnResult> => {
    const info = deps.inner.routeInfo(req.route, req.variant);
    const breaker = deps.breakers.for(info.providerId);
    const requestHash = await hashTurnRequest(req);
    const context = {
      route: req.route,
      purpose: req.purpose,
      effort: req.effort,
      requestedModel: info.model,
      requestHash,
    };

    // Telemetry wraps the adapter call and nothing else; the trace hook wraps telemetry.
    const call = (): Promise<ModelTurnResult> => {
      const inner = (): Promise<ModelTurnResult> => deps.inner.run(req, signal);
      const telemetry = deps.telemetry;
      if (telemetry === undefined) return inner();
      return withModelSpan(
        telemetry,
        spanContextFor(telemetry, info, req.route, req.effort, req.maxOutputTokens, {
          outputType: 'text',
          stream: telemetry.streamsTurns ?? true,
        }),
        inner,
      );
    };

    return deps.limiter.run(req.route, () =>
      breaker.run(async () => {
        const emit = deps.emitTrace;
        const result = emit === undefined ? await call() : await withTrace({ emit }, context, call);
        recordIf(deps, req, info, result.usage);
        return result;
      }),
    );
  };

  const structured = async <T>(
    req: StructuredRequest<T>,
    signal: AbortSignal,
  ): Promise<StructuredResult<T>> => {
    const info = deps.inner.routeInfo(req.route, req.variant);
    const breaker = deps.breakers.for(info.providerId);
    // The hash is computed even when no trace is emitted, because it is cheap and a structured
    // call's identity is what a cassette replay keys on.
    await hashStructuredRequest(req);

    const call = (): Promise<StructuredResult<T>> => {
      const inner = (): Promise<StructuredResult<T>> => deps.inner.structured(req, signal);
      const telemetry = deps.telemetry;
      if (telemetry === undefined) return inner();
      return withStructuredSpan(
        telemetry,
        spanContextFor(telemetry, info, req.route, req.effort, req.maxOutputTokens, {
          outputType: 'json',
          stream: telemetry.streamsStructured ?? false,
        }),
        inner,
      );
    };

    return deps.limiter.run(req.route, () =>
      breaker.run(async () => {
        const result = await call();
        recordIf(deps, req, info, result.usage);
        return result;
      }),
    );
  };

  return {
    run,
    structured,
    embed: (texts, purpose) => deps.inner.embed(texts, purpose),
    routeInfo: (route: ModelRoute, variant?: RouteVariant): RouteInfo =>
      deps.inner.routeInfo(route, variant),
    // The optional members pass straight through, bound to the inner gateway. None of them is a
    // model call: `countTokens` is a `doctor` and nightly-CI path, and the Batches trio is control
    // plane plus a download. Putting any of them in a queue sized for turn-path concurrency would
    // make a nightly job able to stall a member's question.
    ...(deps.inner.countTokens === undefined
      ? {}
      : { countTokens: deps.inner.countTokens.bind(deps.inner) }),
    ...(deps.inner.submitBatch === undefined
      ? {}
      : { submitBatch: deps.inner.submitBatch.bind(deps.inner) }),
    ...(deps.inner.pollBatch === undefined
      ? {}
      : { pollBatch: deps.inner.pollBatch.bind(deps.inner) }),
    ...(deps.inner.batchResults === undefined
      ? {}
      : { batchResults: deps.inner.batchResults.bind(deps.inner) }),
  };
}

/**
 * Assemble the span context from what the chain knows.
 *
 * The route's provider and model come from `RouteInfo`; the endpoint and the local flavour come
 * from the registry through the two lookups. `embed` is deliberately **not** wrapped here —
 * `withEmbeddingsSpan` is exported for the memory subsystem, which is the only caller that knows
 * which embedding model is loaded (`ModelRoute` has no embeddings route, and a span naming the
 * wrong model is worse than no span).
 */
function spanContextFor(
  telemetry: ModelTelemetryOptions,
  info: RouteInfo,
  route: ModelRoute,
  effort: Effort,
  maxOutputTokens: number,
  shape: { readonly outputType: 'text' | 'json'; readonly stream: boolean },
): ModelSpanContext {
  // These two are keyed by the **host's** provider name, because what they look up is
  // configuration: `models.baseUrls.local` and the local server's flavour.
  const baseUrl = telemetry.endpointFor?.(info.provider);
  const flavour = telemetry.flavourFor?.(info.provider);
  return {
    route,
    // The span's provider is the **adapter's** id, so the chain's spans and the adapter's own
    // carry one name for one provider. `11` §3.10.2's attribute is about which API was called.
    provider: info.providerId,
    requestedModel: info.model,
    effort,
    maxOutputTokens,
    stream: shape.stream,
    outputType: shape.outputType,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(flavour === undefined ? {} : { providerFlavour: flavour }),
  };
}

/**
 * Record usage when there is somewhere to attribute it.
 *
 * `05` §3.5.1 puts this innermost and immediate. The guard is that a record with no group and no
 * local day cannot be rolled up or budgeted against, so writing one would add a row nothing reads.
 */
function recordIf(
  deps: ChainDeps,
  req: ModelTurnRequest | StructuredRequest<unknown>,
  info: RouteInfo,
  iterations: Parameters<typeof recordUsage>[2],
): void {
  const usage = deps.usage;
  const context = deps.usageContextFor?.(req);
  if (usage === undefined || context === undefined) return;
  // `priceId` is filled in **here**, from the route lookup, rather than left to the caller that
  // builds the rest of the context. The caller is a composition root assembling eight fields; a
  // ninth it has to remember, whose only symptom when forgotten is a wrong number on the Costs
  // page, is a field that will be forgotten. The layer that knows the route fills it, and a
  // caller that set one deliberately still wins.
  recordUsage(usage, { priceId: info.priceId, ...context }, iterations);
}
