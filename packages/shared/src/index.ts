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
 * Scaffolded in `M0-T1`; filled in by `M0-T6` (primitives and config), `M0-T7` (test doubles),
 * `M0-T8` (logger, redaction, `SecretString`) and `M0-T9` (observability facades).
 *
 * Two subpaths are deliberately **not** re-exported here:
 *
 *  - `@comvivo/shared/testing` — virtual clock, seeded RNG, deterministic ids. Keeping them off
 *    the main barrel is what stops a test double reaching a production path.
 *  - `@comvivo/shared/observability` — the tracing and metrics facades. A package that emits
 *    telemetry should say so in its imports, and the span and metric catalogs are large enough
 *    that folding them in would make this barrel the biggest module in the graph.
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
  STORAGE_ERROR_CODES,
  StorageError,
  type StorageErrorCode,
  TimeoutError,
  toAppError,
  ValidationError,
} from './errors.js';
// --- Ids, time and canonical JSON (M1-T3) ------------------------------------------------------
export {
  EXIT_CODES,
  type ExitCode,
  exitCodeFor,
  exitCodeForStorageCode,
} from './exit-codes.js';
export { SystemRng, TypeIdGenerator } from './id-generator.js';
export {
  type AttachmentId,
  type AuditId,
  type CalendarSubscriptionId,
  type ChannelIdentityId,
  type ChatBindingId,
  type ClaimCodeId,
  type ConfirmationId,
  type ConsentEventId,
  type ConstitutionVersionId,
  type ConstraintId,
  type ConversationId,
  type DecisionId,
  type DeclassificationId,
  type DelegationId,
  type DeletionId,
  type EmbeddingSpaceId,
  type EntityId,
  type EventId,
  type ExportId,
  type FeedbackId,
  type GroupExtensionId,
  type GroupId,
  type IcsFeedTokenId,
  ID_PREFIX,
  type Id,
  type IdEntity,
  type IdError,
  type IdErrorKind,
  type IdPrefix,
  type InstanceId,
  type InteractionTokenId,
  type InternedId,
  type InviteCodeId,
  idSchema,
  internedId,
  isId,
  isValidPrefix,
  type JobId,
  type JobScheduleId,
  KNOWN_PREFIXES,
  type LabelId,
  type LedgerEntryId,
  type LinkCodeId,
  type ListId,
  type ListItemId,
  type LoginTokenId,
  type McpServerId,
  type McpTokenId,
  type MemberId,
  type MemoryId,
  type MessageId,
  type OutboxId,
  type PairingId,
  type PersonId,
  type PlanId,
  type PlanStepId,
  type PluginId,
  type PluginVersionId,
  type PollId,
  type ProactiveCandidateId,
  type ProposalId,
  parseId,
  prefixOf,
  type ReaderSetId,
  type ReminderFiringId,
  type ReminderId,
  type RotationId,
  type SessionId,
  type SkillId,
  type StandingApprovalId,
  type StepUpId,
  type TaskId,
  type TaskSwapId,
  type TurnEffectId,
  type TurnId,
  type TurnTraceId,
  type UsageId,
  unwrapId,
} from './ids.js';
export {
  type CanonicalValue,
  canonicalJson,
  canonicalJsonBytes,
} from './json/canonical.js';
// --- Logging (M0-T8) ---------------------------------------------------------------------------
// Four layers protect `01` §11.7's "logs never contain message or memory content above debug":
// the closed `LogFields` type, the content gate, depth-unlimited field stripping, and scrubbing.
export {
  type BufferedLine,
  contentWarningBanner,
  createLogger,
  type FieldValue,
  FORBIDDEN_FIELD_NAMES,
  isKnownEvent,
  LOG_EVENTS,
  type LogEvent,
  type LogFields,
  type LoggedError,
  type Logger,
  type LoggerOptions,
  type LogLevel,
  LogRingBuffer,
  MAX_MESSAGE_LENGTH,
  messageFor,
  REDACT_PATHS,
  redactOptions,
  SCRUBBED,
  SECRET_PATTERNS,
  scrubDeep,
  scrubErrorMessage,
  scrubSecretShapes,
  toLoggedError,
} from './logger/index.js';
export type { Clock, TimerHandle, Timers } from './ports/clock.js';
export type { IdGenerator } from './ports/ids.js';
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
// --- Secrets (M0-T8) ---------------------------------------------------------------------------
export { isSecretString, REDACTED, SecretString, secret } from './secrets/index.js';
export { SystemClock, SystemTimers, systemClock } from './time/clock.js';
export {
  isCanonicalTimeZoneId,
  isTimeZoneId,
  parseTimeZoneId,
  type TimeZoneId,
  timeZoneIdSchema,
  UTC,
} from './time/timezone.js';
export {
  COUNTER_BITS,
  COUNTER_MAX,
  isUuidV7,
  MAX_MS,
  type RandomBytes,
  timestampOf,
  UuidV7Source,
} from './uuidv7.js';
export {
  type Branded,
  capped,
  describeIssues,
  type FormattedIssue,
  formatIssues,
  parse,
  parseOrThrow,
  z,
} from './zod.js';
