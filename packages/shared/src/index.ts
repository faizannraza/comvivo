/**
 * `@comvivo/shared`
 *
 * Cross-cutting primitives every other package may use: the `BRAND` constant, `Result`, typed
 * errors, zod boundary helpers, exhaustiveness checking, the Clock/IdGenerator/Rng ports, and the
 * configuration loader.
 *
 * This package is the bottom of the dependency graph (`01` §4): it imports nothing internal, and
 * `.dependency-cruiser.cjs` enforces that.
 *
 * Scaffolded in `M0-T1`; filled in by `M0-T6` (these modules), `M0-T7` (test doubles),
 * `M0-T8` (logger, redaction, `SecretString`) and `M0-T9` (observability facades).
 */

export { assertNever } from './assert-never.js';
export { BRAND, type Brand, envVar, legacyEnvVars } from './brand.js';
export { type DotenvEntry, type DotenvResult, parseDotenv } from './config/dotenv.js';
export { HOST_ONLY_PATHS, hostOnlyPathsIn, isHostOnly } from './config/host-only.js';
export {
  type ConfigIo,
  type ConfigWarning,
  coerceEnvValue,
  type LoadedConfig,
  type LoadOptions,
  loadConfig,
} from './config/loader.js';
export {
  type ConfigLeaf,
  collisions as envNameCollisions,
  configLeaves,
  envNameForPath,
  envNameIndex,
  type LeafType,
} from './config/paths.js';
export {
  flatten,
  type MergeInput,
  type MergeOutcome,
  mergeByPrecedence,
  type Settings,
  type Source,
  unflatten,
} from './config/precedence.js';
export { type Config, configSchema, defaultConfig } from './config/schema.js';
export {
  isSecretName,
  type ResolvedSecret,
  resolveSecret,
  resolveSecrets,
  SECRET_NAMES,
  type SecretIo,
  type SecretName,
  type SecretSource,
} from './config/secrets.js';
export {
  AppError,
  BugError,
  ConfigError,
  type ErrorCode,
  type ErrorContext,
  IoError,
  isAppError,
  TimeoutError,
  toAppError,
  ValidationError,
} from './errors.js';
export type { Clock, TimerHandle, Timers } from './ports/clock.js';
export type { IdGenerator, IdPrefix, TypedId } from './ports/ids.js';
export type { Rng } from './ports/rng.js';
export {
  all,
  andThen,
  type Err,
  err,
  isErr,
  isOk,
  map,
  mapErr,
  type Ok,
  ok,
  type Result,
  unwrapOr,
} from './result.js';
export {
  type Branded,
  brandedId,
  describeIssues,
  type FormattedIssue,
  formatIssues,
  parse,
  parseOrThrow,
} from './zod.js';
