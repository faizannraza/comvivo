/**
 * `ExportRecordSchemas` — the published contract for `02` §3.15's JSONL container.
 *
 * `02` §3.15: "The zod schemas `ExportRecordSchemas` in `src/export/schemas.ts` are the published
 * contract (docs in `13`)." A consumer reads a line, picks the schema by `$type`, and parses. The
 * schemas are therefore part of the format and not an internal check, which drives three
 * decisions:
 *
 *  - **Loose, not strict.** Records are domain objects (`02` §3.15), and a domain object gains an
 *    optional field whenever a feature does. Within `$v: 1` the format is **additive**: unknown
 *    keys pass through rather than failing, so a consumer built against today's schema keeps
 *    working against tomorrow's archive. A strict schema would turn every new nullable column into
 *    a format break.
 *  - **Required means guaranteed.** A field is required here when the column it comes from is
 *    `NOT NULL` — measured against the tables, one record per source, by
 *    `format.contract.int.test.ts`. Everything else is `.optional()`. So "required" is a promise a
 *    consumer may rely on, not a description of one example row.
 *  - **Enums stay strings.** The value sets live in `@comvivo/core` and are versioned there;
 *    restating them here would be a second source of truth that drifts silently. Where a field's
 *    shape is a *structure* rather than a value set — a poll's options, a memory's provenance — the
 *    domain schema itself is imported, so the contract is derived rather than copied.
 *
 * The label is the exception to "loose": `renderLabel` produces it in this package, so a strict
 * schema there catches drift in code we own rather than in a domain object we don't.
 */
import {
  AdoptedBySchema,
  AuditActorSchema,
  AuditDecisionSchema,
  AuditDetailsSchema,
  CompiledPolicySchema,
  DecidedBySchema,
  DecisionAlternativesSchema,
  DecisionSourceRefsSchema,
  EventSourceSchema,
  MemoryContentSchema,
  MemoryProvenanceSchema,
  PlanBudgetNotesSchema,
  PlanStepLinksSchema,
  PollOptionsSchema,
  PollQuorumSchema,
  PrivateConstraintPolicySchema,
  ProposalPayloadSchema,
  ProposalRuleSchema,
  ReminderRecipientsSchema,
  ReminderScheduleSchema,
  TaskDueSchema,
} from '@comvivo/core';
import { idSchema, z } from '@comvivo/shared';
import { Temporal } from 'temporal-polyfill';
import { EXPORT_FORMAT_VERSION, EXPORT_RECORD_VERSION } from './export.js';

/**
 * An ISO-8601 instant, parsed rather than pattern-matched.
 *
 * `Temporal.Instant.from` is the check because the promise `02` §3.15 makes is "ISO-8601
 * instants", and the thing that would break it is a number — epoch milliseconds reaching the file
 * because a mapper was missed. A regex would accept `"1762603200000"` as a string.
 */
const instant = z.string().refine(
  (value) => {
    try {
      Temporal.Instant.from(value);
      return true;
    } catch {
      return false;
    }
  },
  { error: 'an ISO-8601 instant' },
);

/** A wall-clock date-time with no zone, as `startLocal` and the task/plan date fields carry. */
const plainDateTime = z.string();

/** The rendered label (`02` §3.15), strict because `renderLabel` is ours. */
export const ExportLabelSchema = z.strictObject({
  readers: z.union([
    z.strictObject({ kind: z.literal('group') }),
    z.strictObject({ kind: z.literal('members'), memberIds: z.array(idSchema('mbr')) }),
  ]),
  owner: z.string(),
  sensitivity: z.string(),
  influence: z.string(),
  untrusted: z.boolean(),
});

/** Every record's envelope. */
const envelope = <T extends string>(type: T) => ({
  $type: z.literal(type),
  $v: z.literal(EXPORT_RECORD_VERSION),
});

const record = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.looseObject({ ...envelope(type), ...shape });

/** The row counters every labeled table carries. */
const rid = z.int().positive();
const version = z.int().nonnegative();

export const MemberRecordSchema = record('member', {
  id: idSchema('mbr'),
  groupId: idSchema('grp'),
  personId: idSchema('prs'),
  role: z.string(),
  ageBand: z.string(),
  handle: z.string(),
  status: z.string(),
  consent: z.string(),
  joinedAt: instant,
  createdAt: instant,
  updatedAt: instant,
  version,
  /**
   * Required, as `02` §3.15's record list has it — and it comes from a `LEFT JOIN` on `persons`.
   *
   * The two together are the contract: in any sound database the join finds the row, and if it
   * does not, the record carries `null` and fails this schema. That is the intended outcome. A
   * nameless member in an archive is worse than an export that says the database is broken.
   */
  displayName: z.string(),
  leftAt: instant.optional(),
});

export const ConversationRecordSchema = record('conversation', {
  id: idSchema('cnv'),
  groupId: idSchema('grp'),
  channel: z.string(),
  platformChatId: z.string(),
  kind: z.string(),
  primary: z.boolean(),
  boundAt: instant,
  createdAt: instant,
  updatedAt: instant,
});

export const MessageRecordSchema = record('message', {
  rid,
  id: idSchema('msg'),
  groupId: idSchema('grp'),
  conversationId: idSchema('cnv'),
  kind: z.string(),
  text: z.string(),
  untrusted: z.boolean(),
  label: ExportLabelSchema,
  sentAt: instant,
  receivedAt: instant,
  deliveredLate: z.boolean(),
  truncated: z.boolean(),
  editCount: z.int().nonnegative(),
  senderMemberId: idSchema('mbr').optional(),
});

/**
 * The storage-level memory record.
 *
 * **Not** `04` §3.9.5's `MemoryExportRecordV1`, which is a different shape — a `visibility` block
 * instead of a label, subject *displays* instead of ids — and belongs to `M6-T20`'s memory control
 * (`14`: `engine/src/memory/controls/export.ts`). `02` §3.15 names that record for
 * `memories.jsonl`, so `M6` replaces this one there. Until then the file carries the domain object
 * like every other source, which is the honest thing for the container to write on its own.
 */
export const MemoryRecordSchema = record('memory', {
  rid,
  id: idSchema('mem'),
  groupId: idSchema('grp'),
  kind: z.string(),
  content: MemoryContentSchema,
  statement: z.string(),
  searchTerms: z.array(z.string()),
  language: z.string(),
  /** base64url of the 16-byte dedupe fingerprint (`02` §3.5.1). */
  fingerprint: z.string(),
  label: ExportLabelSchema,
  provenance: MemoryProvenanceSchema,
  confidence: z.number(),
  status: z.string(),
  validFrom: instant,
  contradicts: z.array(z.string()),
  links: z.array(z.unknown()),
  retrievalState: z.number(),
  pinned: z.boolean(),
  portable: z.boolean(),
  embeddingState: z.string(),
  createdAt: instant,
  updatedAt: instant,
  version,
});

export const EventRecordSchema = record('event', {
  rid,
  id: idSchema('evt'),
  groupId: idSchema('grp'),
  seriesId: idSchema('evt'),
  title: z.string(),
  allDay: z.boolean(),
  tz: z.string(),
  startLocal: plainDateTime,
  startAt: instant,
  rruleInvalid: z.boolean(),
  rdates: z.array(z.string()),
  exdates: z.array(z.string()),
  status: z.string(),
  busy: z.boolean(),
  attendeesMode: z.string(),
  source: EventSourceSchema,
  label: ExportLabelSchema,
  icsUid: z.string(),
  icsSequence: z.int().nonnegative(),
  tzdataVersion: z.string(),
  createdAt: instant,
  updatedAt: instant,
  version,
});

export const ReminderRecordSchema = record('reminder', {
  id: idSchema('rem'),
  groupId: idSchema('grp'),
  kind: z.string(),
  recipients: ReminderRecipientsSchema,
  delivery: z.string(),
  schedule: ReminderScheduleSchema,
  anchor: z.string(),
  /** The frozen reader set the audience was resolved to (`02` §3.2). */
  audienceReaderSetId: z.int().positive(),
  label: ExportLabelSchema,
  status: z.string(),
  tzdataVersion: z.string(),
  createdAt: instant,
  updatedAt: instant,
  version,
  text: z.string().optional(),
  nextFireAt: instant.optional(),
});

export const TaskRecordSchema = record('task', {
  rid,
  id: idSchema('tsk'),
  groupId: idSchema('grp'),
  kind: z.string(),
  title: z.string(),
  assignmentState: z.string(),
  effortPoints: z.number(),
  due: TaskDueSchema,
  proofPolicy: z.string(),
  status: z.string(),
  nudgeCount: z.int().nonnegative(),
  label: ExportLabelSchema,
  createdAt: instant,
  updatedAt: instant,
  version,
});

export const ListRecordSchema = record('list', {
  id: idSchema('lst'),
  groupId: idSchema('grp'),
  name: z.string(),
  kind: z.string(),
  isDefault: z.boolean(),
  categoriesEnabled: z.boolean(),
  label: ExportLabelSchema,
  createdAt: instant,
  updatedAt: instant,
  version,
});

/**
 * A list item, as its own file rather than nested inside its list.
 *
 * `02` §3.15 wrote "lists.jsonl (items nested)", and the amendment there records why this is a
 * sibling file instead: the same section specifies a streaming read "in `rid`/`id` order with
 * chunks of 1,000", and nesting requires holding every child of a list in memory before its parent
 * line can be written. `listId` is on every item, so a consumer that wants them nested can group
 * them — and one that wants to stream a 10,000-item list still can.
 */
export const ListItemRecordSchema = record('list_item', {
  rid,
  id: idSchema('lsti'),
  listId: idSchema('lst'),
  groupId: idSchema('grp'),
  text: z.string(),
  normalizedKey: z.string(),
  checked: z.boolean(),
  addedVia: z.string(),
  /** A fractional index (`02` §3.6.2), so reordering writes one row. */
  position: z.string(),
  label: ExportLabelSchema,
  createdAt: instant,
  updatedAt: instant,
  version,
});

export const PollRecordSchema = record('poll', {
  rid,
  id: idSchema('pol'),
  groupId: idSchema('grp'),
  conversationId: idSchema('cnv'),
  purpose: z.string(),
  question: z.string(),
  options: PollOptionsSchema,
  allowMultiple: z.boolean(),
  rule: z.string(),
  quorum: PollQuorumSchema,
  eligibleMemberIds: z.array(idSchema('mbr')),
  anonymous: z.boolean(),
  resultsVisibility: z.string(),
  mode: z.string(),
  status: z.string(),
  label: ExportLabelSchema,
  createdAt: instant,
  version,
});

export const PlanRecordSchema = record('plan', {
  rid,
  id: idSchema('pln'),
  groupId: idSchema('grp'),
  kind: z.string(),
  title: z.string(),
  ownerMemberIds: z.array(idSchema('mbr')),
  status: z.string(),
  budgetNotes: PlanBudgetNotesSchema,
  assumptions: z.array(z.string()),
  label: ExportLabelSchema,
  createdAt: instant,
  updatedAt: instant,
  version,
});

/** A plan step, a sibling file for the same reason as `list_item` — and with no label of its own. */
export const PlanStepRecordSchema = record('plan_step', {
  id: idSchema('plns'),
  planId: idSchema('pln'),
  groupId: idSchema('grp'),
  position: z.string(),
  title: z.string(),
  ownerMemberIds: z.array(idSchema('mbr')),
  status: z.string(),
  confirmState: z.string(),
  dependsOn: z.array(idSchema('plns')),
  links: PlanStepLinksSchema,
  lastActivityAt: instant,
  createdAt: instant,
  updatedAt: instant,
  version,
});

export const DecisionRecordSchema = record('decision', {
  rid,
  id: idSchema('dec'),
  groupId: idSchema('grp'),
  summary: z.string(),
  topicTags: z.array(z.string()),
  decidedBy: DecidedBySchema,
  alternativesRejected: DecisionAlternativesSchema,
  sourceRefs: DecisionSourceRefsSchema,
  origin: z.string(),
  status: z.string(),
  label: ExportLabelSchema,
  decidedAt: instant,
  decidedTz: z.string(),
  createdAt: instant,
  version,
});

export const ConstitutionVersionRecordSchema = record('constitution_version', {
  id: idSchema('cnst'),
  groupId: idSchema('grp'),
  version: z.int().positive(),
  yaml: z.string(),
  yamlSha256: z.string().regex(/^[0-9a-f]{64}$/),
  charterText: z.string(),
  compiled: CompiledPolicySchema,
  compilerVersion: z.string(),
  adoptedVia: z.string(),
  adoptedBy: AdoptedBySchema,
  adoptedAt: instant,
  parentVersionId: idSchema('cnst').optional(),
});

export const ProposalRecordSchema = record('proposal', {
  id: idSchema('prp'),
  groupId: idSchema('grp'),
  kind: z.string(),
  payload: ProposalPayloadSchema,
  rule: ProposalRuleSchema,
  electorate: z.array(idSchema('mbr')),
  status: z.string(),
  proposerMemberId: idSchema('mbr'),
  ballotRefs: z.array(z.string()),
  openedAt: instant,
  label: ExportLabelSchema,
  version,
});

/**
 * An audit event, with its chain links.
 *
 * `prevHash` and `hash` are base64url of 32 bytes, and they are in the record because the chain is
 * what makes the log verifiable: a consumer can re-link the rows and see that nothing was removed.
 * `groupId` is optional because `02` §3.3.7 puts host actions on the `_instance` chain with no
 * group — a group-scoped export never contains those.
 */
export const AuditEventRecordSchema = record('audit_event', {
  id: idSchema('aud'),
  chainKey: z.string(),
  seq: z.int().positive(),
  actor: AuditActorSchema,
  action: z.string(),
  decision: AuditDecisionSchema,
  details: AuditDetailsSchema,
  prevHash: z.string(),
  hash: z.string(),
  at: instant,
  groupId: idSchema('grp').optional(),
  target: z.string().optional(),
});

export const PersonRecordSchema = record('person', {
  id: idSchema('prs'),
  displayName: z.string(),
  displayNameSource: z.string(),
  createdAt: instant,
  updatedAt: instant,
  locale: z.string().optional(),
  timezone: z.string().optional(),
});

export const ChannelIdentityRecordSchema = record('channel_identity', {
  id: idSchema('chid'),
  channel: z.string(),
  platformUserId: z.string(),
  personId: idSchema('prs'),
  displayNameSnapshot: z.string(),
  isBot: z.boolean(),
  dmReachable: z.boolean(),
  createdAt: instant,
  platformUsername: z.string().optional(),
  verifiedAt: instant.optional(),
  lastSeenAt: instant.optional(),
});

export const ConsentEventRecordSchema = record('consent_event', {
  id: idSchema('cev'),
  memberId: idSchema('mbr'),
  groupId: idSchema('grp'),
  fromState: z.string(),
  toState: z.string(),
  via: z.string(),
  at: instant,
});

/** `group.json`: the profile plus the constitution in force (`02` §3.15). */
export const GroupRecordSchema = record('group', {
  id: idSchema('grp'),
  name: z.string(),
  archetype: z.string(),
  historyVisibility: z.string(),
  timezone: z.string(),
  locale: z.string(),
  weekStart: z.int(),
  status: z.string(),
  membershipEpoch: z.int().positive(),
  extensionsVersion: z.int().nonnegative(),
  createdAt: instant,
  updatedAt: instant,
  version,
  constitutionVersionId: idSchema('cnst').optional(),
  /** Absent before `M3` adopts one, which is why it is not required. */
  constitution: ConstitutionVersionRecordSchema.omit({ $type: true, $v: true }).optional(),
});

/** `me/private_constraint_policy.json` (`03` §3.5.3). */
export const PrivateConstraintPolicyRecordSchema = record('private_constraint_policy', {
  memberId: idSchema('mbr'),
  groupId: idSchema('grp'),
  policy: PrivateConstraintPolicySchema,
  label: ExportLabelSchema,
  updatedAt: instant,
  version,
});

/**
 * Every record schema, by `$type`.
 *
 * The map is the contract: a consumer reads `$type`, looks it up, and parses. A line whose `$type`
 * is not in here is from a newer format version than the consumer knows, which is exactly what
 * `exportFormatVersion` in the manifest is for.
 */
export const ExportRecordSchemas = Object.freeze({
  member: MemberRecordSchema,
  conversation: ConversationRecordSchema,
  message: MessageRecordSchema,
  memory: MemoryRecordSchema,
  event: EventRecordSchema,
  reminder: ReminderRecordSchema,
  task: TaskRecordSchema,
  list: ListRecordSchema,
  list_item: ListItemRecordSchema,
  poll: PollRecordSchema,
  plan: PlanRecordSchema,
  plan_step: PlanStepRecordSchema,
  decision: DecisionRecordSchema,
  constitution_version: ConstitutionVersionRecordSchema,
  proposal: ProposalRecordSchema,
  audit_event: AuditEventRecordSchema,
  person: PersonRecordSchema,
  channel_identity: ChannelIdentityRecordSchema,
  consent_event: ConsentEventRecordSchema,
  group: GroupRecordSchema,
  private_constraint_policy: PrivateConstraintPolicyRecordSchema,
});

export type ExportRecordType = keyof typeof ExportRecordSchemas;

/** `manifest.json` (`02` §3.15). Strict: this file is written here and nowhere else. */
export const ExportManifestSchema = z.strictObject({
  exportFormatVersion: z.literal(EXPORT_FORMAT_VERSION),
  scope: z.enum(['group', 'member']),
  groupId: idSchema('grp'),
  memberId: idSchema('mbr').optional(),
  audience: z.union([
    z.strictObject({ kind: z.literal('group'), groupId: idSchema('grp') }),
    z.strictObject({
      kind: z.literal('members'),
      groupId: idSchema('grp'),
      memberIds: z.array(idSchema('mbr')),
    }),
  ]),
  generatedAt: instant,
  appVersion: z.string(),
  files: z.array(
    z.strictObject({
      name: z.string(),
      records: z.int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
  filters: z.strictObject({
    includeFiles: z.boolean(),
    includeAudit: z.boolean(),
    eligibleLabels: z.int().nonnegative(),
  }),
});
