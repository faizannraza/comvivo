/**
 * The middleware chain (`05` §3.5.1; `M2-T9`).
 *
 * | Module | What |
 * |---|---|
 * | `limiter` | A priority queue over four slots, two reserved for interactive routes |
 * | `breaker` | One circuit per provider, counting only the failures where waiting helps |
 * | `trace-hook` | Timings, token counts and a request hash — nothing a provider could not see |
 * | `usage-hook` | One `UsageRecord` per iteration, written immediately in its own transaction |
 * | `chain` | `withMiddleware`, which composes them in `05` §3.5.1's order |
 */
export {
  BREAKER_DEFAULTS,
  type BreakerOptions,
  BreakerRegistry,
  type BreakerState,
  CircuitBreaker,
  CircuitOpenError,
  COUNTS_TOWARD_BREAKER,
} from './breaker.js';
export { type ChainDeps, type ModelTelemetryOptions, withMiddleware } from './chain.js';
export {
  INTERACTIVE_ROUTES,
  LIMITER_DEFAULTS,
  type LimiterOptions,
  PriorityLimiter,
  priorityOf,
  ROUTE_PRIORITY,
} from './limiter.js';
export {
  type ModelCallTrace,
  type TraceContext,
  type TraceHookDeps,
  traceOf,
  traceOfError,
  withTrace,
} from './trace-hook.js';
export {
  recordUsage,
  type UsageContext,
  type UsageHookDeps,
  usageRecordFor,
} from './usage-hook.js';
