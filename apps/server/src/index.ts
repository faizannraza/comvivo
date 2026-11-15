/**
 * `@comvivo/server`
 *
 * The composition root: dependency wiring, the Hono HTTP API, worker loops and process lifecycle.
 *
 * What is exported is what the **boot sequence** (`12` §3.8) and the CLI's `serve` command need to
 * assemble a running instance, plus the two things other packages legitimately reach for: the
 * problem types (`09` §3.2.1), so a route or an adapter can fail with a code rather than a string,
 * and `HealthState`, because the things that change readiness — migrations, the backup job, a
 * channel adapter losing its socket — do not live in this directory.
 *
 * Deliberately not re-exported: the middleware factories. They are composed by `createHttpApp` in
 * `09` §3.1's fixed order, and a caller that could mount one itself could mount them in a different
 * order — which is how `request-id` ends up after the middleware whose problems need an id.
 * `REQUEST_ID_HEADER` is here because a client, a test or a log reader needs the name.
 */

export {
  createHttpApp,
  type HttpAppDeps,
  LOOPBACK_ADDRESSES,
  MIDDLEWARE_ORDER,
  normaliseBasePath,
} from './http/app.js';
export {
  CHANNEL_STATES,
  type ChannelState,
  EVENT_LOOP_FAIL_MS,
  type EventLoopProbe,
  HEALTH_PHASES,
  HEALTH_STATUSES,
  type HealthPhase,
  type HealthSnapshot,
  HealthState,
  type HealthStatus,
  isLive,
  nodeEventLoopProbe,
  type ReadinessCheck,
  type ReadinessResult,
  runReadiness,
  STALE_BACKUP_MS,
} from './http/health.js';
export {
  ExposureRefused,
  isLoopback,
  type Listener,
  type ListenOptions,
  listen,
} from './http/listeners.js';
export {
  type Classified,
  classify,
  INTERNAL_DETAIL,
  PROBLEM_CODES,
  PROBLEM_MEDIA_TYPE,
  type Problem,
  type ProblemCode,
  ProblemError,
  type ProblemFieldError,
  problemResponse,
  problemStatus,
  problemTitle,
  problemType,
  requestIdOf,
  toProblem,
} from './http/middleware/problem.js';
export { REQUEST_ID_HEADER, REQUEST_ID_PREFIX } from './http/middleware/request-id.js';
export {
  DRAINING_RETRY_AFTER_S,
  HEALTH_PATH,
  METRICS_TOKEN_VAR,
  READY_PATH,
} from './http/routes/health.js';
