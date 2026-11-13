/**
 * `@comvivo/shared/testing` — deterministic test doubles.
 *
 * `11` §3.1.7. Importing these from production code is a dependency-cruiser error
 * (`testing-subpath-only-from-tests`): a `VirtualClock` reaching production would freeze every
 * reminder in the product, which is exactly the kind of failure that is invisible until a family
 * notices nothing happened.
 *
 * The real implementations — `SystemClock`, `SystemRng`, `TypeIdGenerator` — arrive in `M1-T3`.
 */

export { DeterministicIdGenerator } from './deterministic-ids.js';
export {
  DEFAULT_NUM_RUNS,
  type FcConfigOptions,
  fcConfig,
  fcNumRuns,
  fcTimeoutMs,
} from './fc-config.js';
export {
  SECRETSTREAM_VECTOR,
  type SecretStreamVector,
  type SecretStreamVectorChunk,
  vectorChunk,
  vectorHeader,
  vectorKey,
} from './secretstream-vector.js';
export { childSeed, fnv1a32, SeededRng, seedForScenario } from './seeded-rng.js';
export {
  type RecordedLine,
  type RecordingLogger,
  recordingLogger,
  silentLogger,
} from './silent-logger.js';
export { VirtualClock } from './virtual-clock.js';
