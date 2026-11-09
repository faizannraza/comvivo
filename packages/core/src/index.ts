/**
 * `@comvivo/core`
 *
 * The pure domain. Entities, value objects, ports, the policy engine, information-flow control (labels, join, flow checks), the constitution schema and compiler, fairness algorithms and proactivity scoring. No I/O, no Date, no Math.random, no process, no node:* imports.
 *
 * Scaffolded by M0-T1. The implementation lands in this package's own milestone; see
 * `docs/plan/14-milestones.md`.
 */

// --- Coordination domain (`07` §3; the schemas `02` §3.3.5's columns hold) ----------------------
export {
  type EventPatch,
  EventPatchSchema,
  type EventSource,
  EventSourceSchema,
  type Location,
  LocationSchema,
} from './coordination/calendar.js';
export {
  type DecidedBy,
  DecidedBySchema,
  type DecisionAlternatives,
  DecisionAlternativesSchema,
  type DecisionSourceRefs,
  DecisionSourceRefsSchema,
} from './coordination/decisions.js';
export {
  type PlanBudgetNotes,
  PlanBudgetNotesSchema,
  type PlanSecrecy,
  PlanSecrecySchema,
  type PlanStepLinks,
  PlanStepLinksSchema,
  type StepDue,
  StepDueSchema,
} from './coordination/plans.js';
export {
  type PlatformPollRef,
  PlatformPollRefSchema,
  type PollOptions,
  PollOptionsSchema,
  type PollOutcome,
  PollOutcomeSchema,
  type PollQuorum,
  PollQuorumSchema,
} from './coordination/polls.js';
export {
  type CandidatePayload,
  CandidatePayloadSchema,
  type CandidateTarget,
  CandidateTargetSchema,
  type ScoreBreakdown,
  ScoreBreakdownSchema,
  type UrgencyInputs,
  UrgencyInputsSchema,
} from './coordination/proactivity.js';
export {
  type ReminderRecipients,
  ReminderRecipientsSchema,
  type ReminderSchedule,
  ReminderScheduleSchema,
} from './coordination/reminders.js';
export {
  type RotationCursor,
  RotationCursorSchema,
  type TaskDue,
  TaskDueSchema,
  type TaskTemplate,
  TaskTemplateSchema,
} from './coordination/tasks.js';
export {
  DurationSchema,
  type Recurrence,
  RecurrenceSchema,
  type RecurringSchedule,
  RecurringScheduleSchema,
  WeekdaySchema,
} from './coordination/when.js';
// --- Domain: value objects and the JSON-column schemas `02` §3.3.9 names (M1-T11) --------------
//
// `02` §3.3.9 cites these as `@comvivo/core/domain/<name>`. They are exported from the package
// root instead of as deep subpaths, the same way `ports/storage/store.ts` is: a subpath export per
// schema would be twenty entries in `exports` that every consumer has to spell out, and `core` has
// no code-splitting story that would make the narrower entry points pay for themselves. The module
// layout under `src/domain/` is the one `02` §3.3.9 and `12` §P1 describe.
export { AUDIT_ACTOR_MAX_BYTES, type AuditActor, AuditActorSchema } from './domain/audit.js';
export {
  CHANNEL_IDS,
  type ChannelId,
  channelIdSchema,
  isKnownChannelId,
  type KnownChannelId,
} from './domain/channel.js';
export {
  DECLASS_APPROVER_MAX_BYTES,
  DECLASS_APPROVERS_MAX,
  type DeclassApprover,
  DeclassApproverSchema,
  POLICY_GROUP_STANDARD,
} from './domain/declassify.js';
export {
  DELETION_COUNTS_MAX_KEYS,
  DELETION_STEP_PATTERN,
  type DeletionProgress,
  DeletionProgressSchema,
} from './domain/deletion.js';
export {
  ENTITY_REF_KINDS,
  ENTITY_REF_MAX_PER_LIST,
  type EntityRef,
  type EntityRefKind,
  EntityRefListSchema,
  EntityRefSchema,
} from './domain/entity-ref.js';
export {
  ERROR_INFO_MESSAGE_MAX,
  type ErrorInfo,
  ErrorInfoSchema,
} from './domain/error-info.js';
export {
  ARCHETYPES,
  type GroupArchetype,
  groupArchetypeSchema,
} from './domain/group.js';
// --- Governance and runtime domain (`03`, `05`; the schemas `02` §3.3.6–§3.3.8's columns hold) --
// --- Domain: membership and messages (`02` §3.3.1, §3.3.3; M1-T17) ------------------------------
export {
  AGE_BANDS,
  type AgeBand,
  ageBandMatchesRole,
  type ChannelIdentity,
  CONSENTS,
  CONVERSATION_KINDS,
  type Consent,
  type Conversation,
  type ConversationKind,
  conversationShapeError,
  DISPLAY_NAME_SOURCES,
  type DisplayNameSource,
  defaultAgeBand,
  FORMER_MEMBER_NAME,
  GROUP_STATUSES,
  type Group,
  type GroupStatus,
  HISTORY_VISIBILITIES,
  type HistoryVisibility,
  MEMBER_ROLES,
  MEMBER_STATUSES,
  type Member,
  type MemberRole,
  type MemberStatus,
  type NewChannelIdentity,
  type NewConversation,
  type NewGroup,
  type NewMember,
  type NewPerson,
  newChannelIdentitySchema,
  newGroupSchema,
  newPersonSchema,
  type Person,
  resolveLocale,
  resolveTimeZone,
} from './domain/membership.js';
export {
  isTombstoned,
  MESSAGE_KINDS,
  type Message,
  type MessageKind,
  type MessageRid,
  type NewMessage,
} from './domain/message.js';
export {
  ATTACHMENT_REF_MAX_BYTES,
  type AttachmentRef,
  AttachmentRefSchema,
  FORWARD_INFO_MAX_BYTES,
  type ForwardInfo,
  ForwardInfoSchema,
} from './domain/message-content.js';
export {
  type Block,
  type Inline,
  type Mark,
  type MentionTarget,
  RICH_TEXT_LANG_PATTERN,
  RICH_TEXT_LINK_SCHEMES,
  RICH_TEXT_MAX_BYTES,
  RICH_TEXT_MAX_LIST_DEPTH,
  RICH_TEXT_MAX_NODES,
  RICH_TEXT_MAX_QUOTE_DEPTH,
  type RichText,
  RichTextSchema,
  type TextInline,
} from './domain/rich-text.js';
export {
  jsonObjectShape,
  type StorageContract,
  storageContracts,
} from './domain/storage-contract.js';
export {
  ActionRequestSnapshotSchema,
  type ConfirmationResponse,
  ConfirmationResponseSchema,
  type CopyRef,
  CopyRefSchema,
} from './governance/confirmations.js';
export {
  CONSTRAINT_KINDS_V1,
  type ConstraintKind,
  ConstraintKindSchema,
  type ConstraintScope,
  ConstraintScopeSchema,
  ConstraintValueSchema,
  type PrivateConstraintPolicy,
  PrivateConstraintPolicySchema,
} from './governance/constraints.js';
export {
  CompiledPolicySchema,
  type PolicyReason,
  PolicyReasonSchema,
} from './governance/policy.js';
export {
  type AdoptedBy,
  AdoptedBySchema,
  type BallotRef,
  BallotRefSchema,
  type ProposalOutcome,
  ProposalOutcomeSchema,
  ProposalPayloadSchema,
  type ProposalRule,
  ProposalRuleSchema,
} from './governance/proposals.js';
export {
  type Audience,
  audienceKey,
  computeEligible,
  type EligibleLabelSet,
  type GroupSnapshot,
  type Influence,
  type Label,
  type ReadEligibility,
  type Sensitivity,
  StubInformationFlow,
} from './ifc/eligible.js';
// --- Memory domain (`04` §3.2.2–§3.2.4; M1-T12 needs the schemas `02` §3.3.4's columns hold) ----
export {
  CommitmentContentSchema,
  DecisionContentSchema,
  FactContentSchema,
  MEMORY_CONTENT_MAX_BYTES,
  type MemoryContent,
  MemoryContentSchema,
  MULTI_VALUED_PROFILE_FIELDS,
  NoteContentSchema,
  PreferenceContentSchema,
  ProfileContentSchema,
  type ProfileField,
  ProfileFieldSchema,
} from './memory/kinds.js';
export {
  MEMORY_PROVENANCE_MAX_BYTES,
  type MemoryProvenance,
  MemoryProvenanceSchema,
  type SourceSpan,
  SourceSpanSchema,
} from './memory/provenance.js';
export {
  type EntityRelation,
  EntityRelationSchema,
  type RelationKind,
  RelationKindSchema,
  type SubjectRef,
  SubjectRefSchema,
} from './memory/subjects.js';
export { ianaTzSchema, type TimeSpec, TimeSpecSchema } from './memory/time-spec.js';
// --- Ports: repositories (M1-T17) ---------------------------------------------------------------
export type {
  ChannelIdentityReader,
  ChannelIdentityRepository,
  ConversationReader,
  ConversationRepository,
  GroupPatch,
  GroupReader,
  GroupRepository,
  MemberReader,
  MemberRepository,
  PersonReader,
  PersonRepository,
} from './ports/storage/repos/membership.js';
export type {
  MessageReader,
  MessageRepository,
  MessageWindow,
} from './ports/storage/repos/messages.js';
export {
  INSTANCE_SCOPE,
  isPersistableSettingKey,
  type Setting,
  type SettingScope,
  type SettingsReader,
  type SettingsRepository,
  settingScope,
  unpersistableSettingReason,
} from './ports/storage/repos/settings.js';
// --- Ports: storage (M1-T9) ---------------------------------------------------------------------
export type {
  LabelInterner,
  ReadScope,
  Store,
  UnitOfWork,
} from './ports/storage/store.js';
export type {
  NotPromise,
  TxClock,
  TxMeta,
  TxToken,
  WriteResult,
} from './ports/storage/uow.js';
export {
  duplicate,
  expectWritten,
  notFound,
  writeConflict,
  writeOk,
} from './ports/storage/write-result.js';
export {
  type AuditDecision,
  AuditDecisionSchema,
  type AuditDetails,
  AuditDetailsSchema,
} from './runtime/audit.js';
export { OutboundPayloadSchema } from './runtime/outbox.js';
export {
  CRON_PATTERN,
  CronExprSchema,
  HHMM_PATTERN,
  type ScheduleSpec,
  ScheduleSpecSchema,
  type TzRef,
  TzRefSchema,
} from './runtime/schedule.js';
export {
  type ContextManifest,
  ContextManifestSchema,
  GuardResultTraceSchema,
  type LatencyTrace,
  LatencyTraceSchema,
  ModelCallTraceSchema,
  PolicyDecisionTraceSchema,
  ToolCallTraceSchema,
  TRACE_JSON_COLUMNS,
  TRACE_TOTAL_BUDGET_BYTES,
  type TraceJsonColumn,
  type TraceReplayMeta,
  TraceReplayMetaSchema,
  TraceTriggerSchema,
  traceBudgetOverage,
  traceRowBytes,
} from './runtime/traces.js';
export {
  type EffectSummaryParams,
  EffectSummaryParamsSchema,
  type OutboxParts,
  OutboxPartsSchema,
  TriggerMessageIdsSchema,
  type TurnFailure,
  TurnFailureSchema,
} from './runtime/turns.js';
