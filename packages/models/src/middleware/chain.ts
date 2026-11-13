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
 *
 * ## What the chain does not do
 *
 * It does not retry. `05` §3.5.3.10: interactive routes rely on the SDK's own bounded retries
 * inside the turn's deadline, and background routes rely on the job queue's backoff (ADR-012).
 * A retry here would be a third, invisible layer, and the wall-clock worst case is already
 * `timeout × (maxRetries + 1)`.
 */
import type {
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
    const breaker = deps.breakers.for(info.provider as never);
    const requestHash = await hashTurnRequest(req);
    const context = {
      route: req.route,
      purpose: req.purpose,
      effort: req.effort,
      requestedModel: info.model,
      requestHash,
    };

    return deps.limiter.run(req.route, () =>
      breaker.run(async () => {
        const emit = deps.emitTrace;
        const call = (): Promise<ModelTurnResult> => deps.inner.run(req, signal);
        const result = emit === undefined ? await call() : await withTrace({ emit }, context, call);
        recordIf(deps, req, result.usage);
        return result;
      }),
    );
  };

  const structured = async <T>(
    req: StructuredRequest<T>,
    signal: AbortSignal,
  ): Promise<StructuredResult<T>> => {
    const info = deps.inner.routeInfo(req.route, req.variant);
    const breaker = deps.breakers.for(info.provider as never);
    // The hash is computed even when no trace is emitted, because it is cheap and a structured
    // call's identity is what a cassette replay keys on.
    await hashStructuredRequest(req);

    return deps.limiter.run(req.route, () =>
      breaker.run(async () => {
        const result = await deps.inner.structured(req, signal);
        recordIf(deps, req, result.usage);
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
 * Record usage when there is somewhere to attribute it.
 *
 * `05` §3.5.1 puts this innermost and immediate. The guard is that a record with no group and no
 * local day cannot be rolled up or budgeted against, so writing one would add a row nothing reads.
 */
function recordIf(
  deps: ChainDeps,
  req: ModelTurnRequest | StructuredRequest<unknown>,
  iterations: Parameters<typeof recordUsage>[2],
): void {
  const usage = deps.usage;
  const context = deps.usageContextFor?.(req);
  if (usage === undefined || context === undefined) return;
  recordUsage(usage, context, iterations);
}
