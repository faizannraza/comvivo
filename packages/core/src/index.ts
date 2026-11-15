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
  ATTENDEES_MODES,
  type AttendeesMode,
  EVENT_STATUSES,
  type Event,
  type EventAttendee,
  type EventPatch,
  EventPatchSchema,
  type EventSource,
  EventSourceSchema,
  type EventStatus,
  type Location,
  LocationSchema,
  type NewEvent,
  occupiesTime,
  RSVP_RESPONSES,
  type RsvpResponse,
} from './coordination/calendar.js';
export {
  DECISION_ORIGINS,
  DECISION_STATUSES,
  type DecidedBy,
  DecidedBySchema,
  type Decision,
  type DecisionAlternatives,
  DecisionAlternativesSchema,
  type DecisionOrigin,
  type DecisionSourceRefs,
  DecisionSourceRefsSchema,
  type DecisionStatus,
  type NewDecision,
} from './coordination/decisions.js';
export {
  ADDED_VIA,
  type AddedVia,
  LIST_KINDS,
  type List,
  type ListItem,
  type ListKind,
  type NewList,
  type NewListItem,
} from './coordination/lists.js';
export {
  CONFIRM_STATES,
  type ConfirmState,
  isActivePlan,
  type NewPlan,
  type NewPlanStep,
  PLAN_KINDS,
  PLAN_STATUSES,
  PLAN_STEP_STATUSES,
  type Plan,
  type PlanBudgetNotes,
  PlanBudgetNotesSchema,
  type PlanKind,
  type PlanSecrecy,
  PlanSecrecySchema,
  type PlanStatus,
  type PlanStep,
  type PlanStepLinks,
  PlanStepLinksSchema,
  type PlanStepStatus,
  type StepDue,
  StepDueSchema,
} from './coordination/plans.js';
export {
  type NewPoll,
  type PlatformPollRef,
  PlatformPollRefSchema,
  POLL_MODES,
  POLL_PURPOSES,
  POLL_RULES,
  POLL_STATUSES,
  type Poll,
  type PollMode,
  type PollOptions,
  PollOptionsSchema,
  type PollOutcome,
  PollOutcomeSchema,
  type PollPurpose,
  type PollQuorum,
  PollQuorumSchema,
  type PollRule,
  type PollStatus,
  RESULTS_VISIBILITIES,
  type ResultsVisibility,
  resultsVisibleNow,
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
  FIRING_OUTCOMES,
  type FiringOutcome,
  isDue,
  type NewReminder,
  REMINDER_ANCHORS,
  REMINDER_DELIVERIES,
  REMINDER_KINDS,
  REMINDER_STATUSES,
  type Reminder,
  type ReminderAnchor,
  type ReminderDelivery,
  type ReminderFiring,
  type ReminderKind,
  type ReminderRecipients,
  ReminderRecipientsSchema,
  type ReminderSchedule,
  ReminderScheduleSchema,
  type ReminderStatus,
} from './coordination/reminders.js';
export {
  ASSIGNMENT_STATES,
  type AssignmentState,
  chargesLedger,
  isOpenTask,
  LEDGER_KINDS,
  type LedgerEntry,
  type LedgerKind,
  type NewLedgerEntry,
  type NewTask,
  PROOF_POLICIES,
  type ProofPolicy,
  type RotationCursor,
  RotationCursorSchema,
  TASK_KINDS,
  TASK_STATUSES,
  type Task,
  type TaskDue,
  TaskDueSchema,
  type TaskKind,
  type TaskStatus,
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
  ADOPTED_VIA,
  type AdoptedVia,
  APPROVAL_MODES,
  type ApprovalMode,
  ATTRIBUTIONS,
  type Attribution,
  CONFIRMATION_CAPACITIES,
  CONFIRMATION_DELIVERIES,
  CONFIRMATION_OPTIONS,
  CONFIRMATION_QUORUMS,
  CONFIRMATION_STATUSES,
  CONSENT_VIA,
  CONSTRAINT_STATUSES,
  type ConfirmationCapacity,
  type ConfirmationDelivery,
  type ConfirmationOption,
  type ConfirmationQuorum,
  type ConfirmationRequest,
  type ConfirmationStatus,
  type ConsentEvent,
  type ConsentVia,
  type ConstitutionVersion,
  type ConstraintRecord,
  type ConstraintStatus,
  constraintInForce,
  type NewConfirmationRequest,
  type NewConsentEvent,
  type NewConstitutionVersion,
  type NewConstraintRecord,
  type NewProposal,
  type NewStandingApproval,
  ON_EXPIRE,
  type OnExpire,
  PROPOSAL_KINDS,
  PROPOSAL_STATUSES,
  type Proposal,
  type ProposalKind,
  type ProposalStatus,
  type ProposalVote,
  quorumSatisfied,
  REASON_DISCLOSURES,
  type ReasonDisclosure,
  type StandingApproval,
  VOTE_CHOICES,
  VOTE_VIA,
  type VoteChoice,
  type VoteVia,
} from './governance/aggregates.js';
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
export {
  EMBEDDING_STATES,
  type EmbeddingState,
  MEMORY_KINDS,
  MEMORY_STATUSES,
  type MemoryItem,
  type MemoryKind,
  type MemorySource,
  type MemoryStatus,
  type MemorySubject,
  type NewMemoryItem,
  RETRACT_REASONS,
  RETRIEVAL_STATES,
  type RetractReason,
  type RetrievalState,
  retrievalStateFor,
  SUBJECT_ROLES,
  type SubjectRole,
  subjectRefToColumn,
} from './memory/item.js';
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
// --- Policy: the capability and risk vocabulary (M2-T5; the catalog lands at M4-T1) -----------
export {
  type Capability,
  capabilitySchema,
  DOMAIN_CAPABILITIES,
  type DomainCapability,
  isCapability,
  isDomainCapability,
  isPluginCapability,
  isProviderId,
  isToolLocalName,
  type ParsedPluginCapability,
  type PluginCapability,
  PROVIDER_ID_PATTERN,
  parsePluginCapability,
  pluginCapability,
  pluginWildcardCapability,
  TOOL_LOCAL_NAME_PATTERN,
} from './policy/capability.js';
export {
  atLeastRisk,
  maxRisk,
  RISK_LEVELS,
  type Risk,
  riskRank,
  riskSchema,
} from './policy/risk.js';
// --- Ports: the model gateway (M2-T1) -----------------------------------------------------------
//
// From the root, like the storage ports: `05` §4.1 cites it as `@comvivo/core/ports/model.ts` and a
// subpath export would make every consumer spell out a second entry point for one file. The
// restricted ports — `unfiltered` and `memory-search` — are subpaths because dependency-cruiser
// limits *who may import them*, which is not true here: everything that talks to a model talks to
// this interface.
export {
  type AssistantMessage,
  type AssistantPart,
  type BatchHandle,
  type BatchItemFailure,
  type BatchResultItem,
  type BatchStatus,
  type CacheHint,
  continuesToolLoop,
  EFFORT_LEVELS,
  type Effort,
  isIncomplete,
  isRefusal,
  isStructuredOk,
  isStructuredRetryable,
  ModelCallError,
  type ModelCallErrorKind,
  type ModelFeatureSet,
  type ModelGateway,
  type ModelMessage,
  type ModelRoute,
  type ModelTurnRequest,
  type ModelTurnResult,
  type ProviderId,
  type RouteInfo,
  type RouteVariant,
  type SchemaLike,
  type StopInfo,
  type StopReason,
  type StructuredKind,
  type StructuredRequest,
  type StructuredResult,
  type SystemBlock,
  type ToolSpec,
  type UsageIteration,
  type UsageIterationKind,
  type UserPart,
  usageOf,
} from './ports/model.js';
export type {
  BlobInfo,
  BlobPutArgs,
  BlobPutResult,
  BlobStorePort,
} from './ports/storage/blobs.js';
export type {
  ClaimedJob,
  ClaimRequest,
  DebounceArgs,
  EnqueueArgs,
  EnqueueResult,
  FailResult,
  Job,
  JobKindDef,
  JobPool,
  JobQueue,
  JobQueueTx,
  JobStatus,
  LeaseResult,
  PartitionKey,
} from './ports/storage/jobs.js';
export {
  INSTANCE_PARTITION,
  JOB_PAYLOAD_INVALID,
  JOB_POOLS,
  JOB_STATUSES,
  POOL_LIMITS,
} from './ports/storage/jobs.js';
export type { AuditLog, AuditReader } from './ports/storage/repos/audit.js';
export { AUDIT_REANCHOR_ACTION } from './ports/storage/repos/audit.js';
export type {
  CalendarReader,
  CalendarRepository,
  DecisionReader,
  DecisionRepository,
  ListReader,
  ListRepository,
  PlanReader,
  PlanRepository,
  PollReader,
  PollRepository,
  ReminderReader,
  ReminderRepository,
  TaskReader,
  TaskRepository,
} from './ports/storage/repos/coordination.js';
export {
  type DeletionPrimitives,
  type DeletionRecord,
  type LabelOwnerScope,
  PURGE_CHUNK_ROWS,
  type RetentionWindows,
  SWEEP_CHUNK_ROWS,
  SWEEPABLE_TABLES,
  type SweepableTable,
  type SweepChunkResult,
} from './ports/storage/repos/deletions.js';
export type {
  ConsentEventRef,
  GovernanceReader,
  GovernanceRepository,
} from './ports/storage/repos/governance.js';
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
  MemoryReader,
  MemoryRepository,
} from './ports/storage/repos/memory.js';
export type {
  MessageReader,
  MessageRepository,
  MessageWindow,
} from './ports/storage/repos/messages.js';
export type {
  OutboxReader,
  OutboxRef,
  OutboxRepository,
  SendFailure,
  SendReceipt,
} from './ports/storage/repos/outbox.js';
export {
  TERMINAL_OUTBOX_STATUSES,
  UNDELIVERED_OUTBOX_STATUSES,
} from './ports/storage/repos/outbox.js';
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
export type {
  TraceReader,
  TraceRepository,
  TraceTruncation,
  TurnJournal,
  TurnJournalReader,
} from './ports/storage/repos/turns.js';
export type { Spend, UsageReader, UsageRepository } from './ports/storage/repos/usage.js';
// --- Ports: storage (M1-T9) ---------------------------------------------------------------------
export type {
  LabelInterner,
  ReadScope,
  Store,
  UnitOfWork,
} from './ports/storage/store.js';
export type {
  NotPromise,
  SyncTxRunner,
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
  type AuditEvent,
  type ChainVerification,
  chainKeyFor,
  EFFECT_STATUSES,
  type EffectStatus,
  INSTANCE_CHAIN_KEY,
  isOrphaned,
  type NewAuditEvent,
  type NewTurn,
  type NewTurnEffect,
  type NewTurnTrace,
  type NewUsageRecord,
  TURN_EFFORTS,
  TURN_KINDS,
  TURN_PHASES,
  TURN_STATUSES,
  type Turn,
  type TurnEffect,
  type TurnEffort,
  type TurnKind,
  type TurnPhase,
  type TurnStatus,
  type TurnTrace,
  USAGE_KINDS,
  USAGE_VIA,
  type UsageDailyRow,
  type UsageKind,
  type UsageRecord,
  type UsageVia,
  usageGroupKey,
} from './runtime/aggregates.js';
export {
  type AuditDecision,
  AuditDecisionSchema,
  type AuditDetails,
  AuditDetailsSchema,
} from './runtime/audit.js';
export {
  attemptsExhausted,
  type BackoffPolicy,
  backoffMs,
  JOB_BACKOFF,
  OUTBOX_BACKOFF,
} from './runtime/backoff.js';
export {
  EXPIRY_CLASSES,
  type ExpiryClass,
  MESSAGE_CLASSES,
  type MessageClass,
  type NewOutboxMessage,
  OUTBOX_STATUSES,
  OutboundPayloadSchema,
  type OutboxMessage,
  type OutboxStatus,
  SEND_PRIORITIES,
  type SendPriority,
} from './runtime/outbox.js';
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
