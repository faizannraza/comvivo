/**
 * The trace hook (`05` §3.5.1 stage 3; `M2-T9`).
 *
 * Timings and a request hash, and nothing a provider could not already see. That constraint is the
 * module: a trace is read in the dashboard by anybody with `traces.read.group`, so a hook that
 * recorded "what the model was asked" would be a disclosure channel around every IFC check the
 * context builder just made.
 *
 * So what is recorded is the **shape** of the call — which route, which model, how long, how many
 * tokens, how many cache reads, which betas, how many times the request had to be degraded — plus
 * the canonical request **hash**, which identifies the assembly without revealing it. `11` §12-1
 * asks for exactly that: a replay has to be able to assert it reproduced the same prompt, and a
 * hash settles that question without carrying the prompt.
 */
import type { ModelCallError, ModelRoute, ModelTurnResult, UsageIteration } from '@comvivo/core';

/** One model call, as a trace row sees it. Content-free by construction. */
export interface ModelCallTrace {
  readonly route: ModelRoute;
  readonly purpose: string;
  readonly provider: string;
  readonly requestedModel: string;
  readonly servedModel: string;
  readonly effort: string;
  /** `canonical-hash.ts`'s hash of the request. Identifies the assembly, never reveals it. */
  readonly requestHash: string;
  readonly stopReason: string;
  readonly inputTokens: number;
  readonly cachedReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly iterations: number;
  readonly ttftMs?: number;
  readonly totalMs: number;
  /** How many times the adapter had to render something the degraded way (`M2-T6`). */
  readonly inputTransformations: number;
  readonly betas: readonly string[];
  /** Present only when the call failed. The error's **kind**, never its message. */
  readonly errorKind?: string;
}

function sumTokens(iterations: readonly UsageIteration[]): {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
} {
  let input = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let output = 0;
  for (const iteration of iterations) {
    input += iteration.input;
    cacheRead += iteration.cacheRead;
    cacheWrite += iteration.cacheWrite5m + iteration.cacheWrite1h;
    output += iteration.output;
  }
  return { input, cacheRead, cacheWrite, output };
}

export interface TraceContext {
  readonly route: ModelRoute;
  readonly purpose: string;
  readonly effort: string;
  readonly requestedModel: string;
  readonly requestHash: string;
}

/** The trace row for a successful call. */
export function traceOf(context: TraceContext, result: ModelTurnResult): ModelCallTrace {
  const tokens = sumTokens(result.usage);
  return {
    route: context.route,
    purpose: context.purpose,
    provider: result.model.provider,
    requestedModel: context.requestedModel,
    servedModel: result.model.served,
    effort: context.effort,
    requestHash: context.requestHash,
    stopReason: result.stop.reason,
    inputTokens: tokens.input,
    cachedReadTokens: tokens.cacheRead,
    cacheWriteTokens: tokens.cacheWrite,
    outputTokens: tokens.output,
    // The count, which is how a reader sees that a fallback answered without being told the text.
    iterations: result.usage.length,
    ...(result.latency.ttftMs === undefined ? {} : { ttftMs: result.latency.ttftMs }),
    totalMs: result.latency.totalMs,
    inputTransformations: result.diagnostics.inputTransformations,
    betas: result.diagnostics.betas,
  };
}

/**
 * The trace row for a failed call.
 *
 * The **kind** and not the message. A provider's error text has carried prompt fragments before,
 * which is why `ModelCallError` does not interpolate it either (`01` §11.7).
 */
export function traceOfError(
  context: TraceContext,
  error: ModelCallError,
  totalMs: number,
): ModelCallTrace {
  return {
    route: context.route,
    purpose: context.purpose,
    provider: error.provider,
    requestedModel: context.requestedModel,
    servedModel: context.requestedModel,
    effort: context.effort,
    requestHash: context.requestHash,
    stopReason: 'error',
    inputTokens: 0,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    iterations: 0,
    totalMs,
    inputTransformations: 0,
    betas: [],
    errorKind: error.kind,
  };
}

export interface TraceHookDeps {
  /** Where a finished trace goes. `M3`'s turn journal supplies the real one. */
  readonly emit: (trace: ModelCallTrace) => void;
}

/**
 * Wrap a call and emit one trace row, whether it succeeded or failed.
 *
 * `performance.now()` for the duration, not a wall clock: a wall clock can step backwards under
 * NTP, and a negative `totalMs` in a trace is worse than an imprecise one. There is deliberately
 * **no** `Clock` in these deps — the row's timestamp belongs to whatever persists it, and a clock
 * here would be a field nothing reads.
 */
export async function withTrace(
  deps: TraceHookDeps,
  context: TraceContext,
  fn: () => Promise<ModelTurnResult>,
): Promise<ModelTurnResult> {
  const startedAt = performance.now();
  try {
    const result = await fn();
    deps.emit(traceOf(context, result));
    return result;
  } catch (error) {
    // A trace is emitted for a failure too: a turn that failed is the one somebody will ask about.
    if (isModelCallError(error)) {
      deps.emit(traceOfError(context, error, performance.now() - startedAt));
    }
    throw error;
  }
}

function isModelCallError(error: unknown): error is ModelCallError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'kind' in error &&
    'provider' in error &&
    error instanceof Error
  );
}
