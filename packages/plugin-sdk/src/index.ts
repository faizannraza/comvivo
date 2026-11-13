/**
 * `@comvivo/plugin-sdk` — the public, semver-stable API third parties build against.
 *
 * `M2-T5` lands the tool contract: `defineTool`, `ToolDefinition` with `01` §14 A23's additive
 * fields, `ToolOutcome`, `ToolContext` and the repository facade. `definePlugin`, the manifest
 * schema, the RPC protocol, the child runtime, the test kit and the `comvivo-plugin` CLI land in
 * M12 (`M12-T3`, `M12-T4`, `M12-T8`, `M12-T24`).
 *
 * ## Two rules about this file
 *
 * **Everything exported here is a compatibility promise.** `etc/plugin-sdk.api.md` is the record of
 * it, checked in CI: a change to this surface shows up as a diff in a reviewed file rather than as
 * a broken plugin six months later. Adding an export is cheap; removing one is a major version.
 *
 * **No `node:*` anywhere in this entry point** (`01` §14 A11). `@comvivo/tools` imports it, and
 * `tools` must stay runnable in a browser; only `./runtime` and `src/cli/` may touch the platform.
 * dependency-cruiser's `no-node-builtins-in-pure-packages` rule enforces it for the whole package.
 */

// --- The invocation context (10 §3.2.4) --------------------------------------------------------
export {
  type EgressHttp,
  type EgressRequestInit,
  type GroupInfo,
  type LabelsHelper,
  PLUGIN_STORE_MAX_SCOPE_BYTES,
  PLUGIN_STORE_MAX_VALUE_BYTES,
  type PluginClock,
  type PluginLogFields,
  type PluginLogger,
  type PluginSettings,
  type PluginSettingsShape,
  type PluginStore,
  type Requester,
  type SecretRef,
  type SecretsAccess,
  type SecretTemplate,
  type ToolAudience,
  type ToolContext,
  type ToolContextBase,
} from './context.js';
// --- Outcomes (10 §3.2.3) ----------------------------------------------------------------------
export {
  isToolError,
  isToolNeedsInput,
  isToolOk,
  RETRYABLE_BY_DEFAULT,
  TOOL_ERROR_CODES,
  type ToolErrorCode,
  type ToolErrorOptions,
  type ToolFailure,
  type ToolNeedsInput,
  type ToolOk,
  type ToolOutcome,
  toolError,
  toolNeedsInput,
  toolOk,
} from './outcome.js';
// --- Permissions, and the type-level narrowing they drive (10 §3.3.1, §3.2.2) ------------------
export {
  type Grants,
  type GrantsSecrets,
  HTTP_METHODS,
  type HttpMethod,
  type NetworkPermission,
  type PluginPermissions,
  READ_ONLY_REPO_ENTITIES,
  REPO_ENTITIES,
  type ReadOnlyRepoEntity,
  type RepoAccess,
  type RepoAccessFor,
  type RepoEntity,
  type RepoGrant,
  type RepoPermissions,
  type RevealableSecretKeyOf,
  type SecretKeyOf,
  type SecretPermission,
} from './permissions.js';
// --- The domain facade (10 §3.2.4) -------------------------------------------------------------
export {
  type CalendarQuery,
  type CalendarReader,
  type CalendarWriter,
  type EventDraft,
  type EventView,
  isWriteOk,
  type ListItemView,
  type ListReader,
  type ListView,
  type ListWriter,
  type MemberReader,
  type MemberSummary,
  type MemoryQuery,
  type MemoryReader,
  type MemoryView,
  type ReminderDraft,
  type ReminderView,
  type ReminderWriter,
  type RepoFacade,
  type ScopedRepositories,
  type SourceRef,
  type TaskDraft,
  type TaskQuery,
  type TaskReader,
  type TaskView,
  type TaskWriter,
  type ViewProvenance,
  type WriteResult,
} from './repos.js';
// --- The tool contract (10 §3.2.3; 01 §7.4, §14 A23) ------------------------------------------
export {
  type ActionRequestDraft,
  DEFAULT_TOOL_TIMEOUT_MS,
  type DelegationGrant,
  defaultActionKind,
  defineTool,
  effectiveCapability,
  effectiveRisk,
  MAX_TOOL_DESCRIPTION_CHARS,
  MAX_TOOL_TIMEOUT_MS,
  TOOL_NAME_PATTERN,
  type ToolDefinition,
  type ToolEffect,
  type ToolExample,
  type ToolMeta,
  type ToolProvider,
  type ToolSchemas,
  toolDefinitionProblems,
  toolSchemas,
} from './tool.js';

/*
 * ──────────────────── Re-exports, so a plugin needs one import ────────────────────
 *
 * A plugin author should not have to learn which of four `@comvivo/*` packages a type lives in.
 * These are the ones that appear in the signatures above, and nothing else: the surface this
 * package promises is already large, and every extra name is a name we can never take back.
 */

// Labels, sensitivity and the entity reference a tool's `action()` targets.
export type {
  Audience,
  EntityRef,
  EventPatch,
  EventStatus,
  GroupArchetype,
  Label,
  ListKind,
  Location,
  MemberRole,
  MemoryKind,
  ReminderAnchor,
  ReminderDelivery,
  ReminderKind,
  ReminderSchedule,
  ReminderStatus,
  RichText,
  Sensitivity,
  SubjectRef,
  TaskKind,
  TaskStatus,
} from '@comvivo/core';
// The capability and risk vocabulary (`03` §3.1.2; `M4-T1` adds the catalog metadata).
export {
  type Capability,
  DOMAIN_CAPABILITIES,
  type DomainCapability,
  isCapability,
  isDomainCapability,
  isPluginCapability,
  isProviderId,
  isToolLocalName,
  maxRisk,
  type ParsedPluginCapability,
  type PluginCapability,
  parsePluginCapability,
  pluginCapability,
  RISK_LEVELS,
  type Risk,
} from '@comvivo/core';
// The ids that appear in the facade's signatures.
export type {
  CanonicalValue,
  EventId,
  GroupId,
  ListId,
  ListItemId,
  MemberId,
  MemoryId,
  ProposalId,
  ReminderId,
  TaskId,
} from '@comvivo/shared';
// The strict JSON-schema converter and linter (`M2-T4`, in `@comvivo/shared` so the host and the
// SDK cannot disagree about what "strict" means — `10` §3.5.2, logged as a plan change).
// Time zones are branded, so `ctx.group.timeZone` needs no parsing and a string literal does.
export {
  denull,
  explainStrictViolations,
  isStrictCompatible,
  KEPT_FORMATS,
  lintStrictSchema,
  MAX_REF_DEPTH,
  MAX_STRICT_SCHEMA_BYTES,
  parseTimeZoneId,
  STRIPPED_KEYWORDS,
  type StrictConversion,
  type StrictJsonSchema,
  type StrictViolation,
  type TimeZoneId,
  type ToStrictOptions,
  timeZoneIdSchema,
  toStrictJsonSchema,
} from '@comvivo/shared';
