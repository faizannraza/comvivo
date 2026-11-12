/**
 * Governance: the constitution, proposals, consent and private constraints (`02` §3.3.6; `03`).
 *
 * `00`'s central claim is that the agent belongs to a group, and a group needs rules it can change.
 * These tables are those rules and the process for changing them.
 *
 * ## Why `constitution_versions` is immutable and append-only
 *
 * Every version is a new row with a `parent_version_id`, and a trigger refuses `UPDATE` outright
 * (`02` §3.5, `M1-T13`). Two reasons, and the second is the one that matters: every `audit_events`
 * row and every `turn_traces.replay` records the `constitution_version_id` it acted under, so
 * editing a version in place would silently rewrite the rules that past decisions were made by —
 * making the audit log claim things that never happened.
 *
 * `yaml` plus `compiled` are both stored because `03` D8 makes the YAML the source of truth and the
 * compiled form the thing `authorize()` evaluates. Keeping only the YAML would mean recompiling on
 * every boot and risking a compiler change altering an in-force constitution; keeping only the
 * compiled form would lose the text a group can read and amend.
 *
 * ## Why the electorate is frozen
 *
 * `proposals.electorate` is a snapshot taken when the proposal opens, for the same reason as
 * `polls.eligible_member_ids`: an amendment must be decided by the group that was asked. A live
 * membership query would let a join or a departure change a threshold retroactively — and for a
 * proposal that amends the voting rules themselves, it would let the outcome change its own basis.
 */
import {
  ActionRequestSnapshotSchema,
  AdoptedBySchema,
  BallotRefSchema,
  CompiledPolicySchema,
  ConfirmationResponseSchema,
  ConstraintScopeSchema,
  ConstraintValueSchema,
  CopyRefSchema,
  EntityRefSchema,
  PolicyReasonSchema,
  PrivateConstraintPolicySchema,
  ProposalOutcomeSchema,
  ProposalPayloadSchema,
  ProposalRuleSchema,
} from '@comvivo/core';
import { idSchema, z } from '@comvivo/shared';
import { sql } from 'drizzle-orm';
import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { createdAt, instantMs, jsonOf, labelRef, tid, updatedAt, version } from './_columns.js';
import { groups, members } from './groups.js';

export const constitutionVersions = sqliteTable(
  'constitution_versions',
  {
    id: tid('cnst')('id').primaryKey(),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    parentVersionId: tid('cnst')('parent_version_id'),
    /** Canonical YAML — `03` D8's source of truth. */
    yaml: text('yaml').notNull(),
    /** `03`'s `yamlHash`: detects a hand-edited row. */
    yamlSha256: text('yaml_sha256').notNull(),
    /** Generated from the YAML, plus the group's editable norms section. */
    charterText: text('charter_text').notNull(),
    compiled: jsonOf(CompiledPolicySchema, 'constitution_versions.compiled')('compiled').notNull(),
    /** Which compiler produced `compiled`, so a compiler change is detectable. */
    compilerVersion: text('compiler_version').notNull(),
    /** `placeholder` is the `M3` claim path (`01` §14 A27): a chat bound before setup finished. */
    adoptedVia: text('adopted_via', {
      enum: ['template', 'setup', 'amendment', 'migration', 'placeholder'],
    }).notNull(),
    adoptedBy: jsonOf(AdoptedBySchema, 'constitution_versions.adopted_by')('adopted_by').notNull(),
    proposalId: tid('prp')('proposal_id'),
    adoptedAt: instantMs('adopted_at').notNull(),
  },
  (t) => [uniqueIndex('constitution_versions_group_version_uq').on(t.groupId, t.version)],
);

export const proposals = sqliteTable(
  'proposals',
  {
    id: tid('prp')('id').primaryKey(),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['amendment', 'contested_action'] }).notNull(),
    payload: jsonOf(ProposalPayloadSchema, 'proposals.payload')('payload').notNull(),
    /** For a contested action: binds execution to exactly what was voted on (`03` §3.3.3). */
    actionDigest: text('action_digest'),
    rule: jsonOf(ProposalRuleSchema, 'proposals.rule')('rule').notNull(),
    /** Frozen when the proposal opens. */
    electorate: jsonOf(
      z.array(idSchema('mbr')).max(1000),
      'proposals.electorate',
    )('electorate').notNull(),
    status: text('status', {
      enum: [
        'open',
        'passed',
        'rejected',
        'expired',
        'withdrawn',
        'cancelled',
        'superseded',
        'executed',
        'execution_failed',
      ],
    }).notNull(),
    proposerMemberId: tid('mbr')('proposer_member_id')
      .notNull()
      .references(() => members.id),
    ballotRefs: jsonOf(
      z.array(BallotRefSchema).max(1000),
      'proposals.ballot_refs',
    )('ballot_refs').notNull(),
    supersededById: tid('prp')('superseded_by_id'),
    /** `03` §3.3.8's cooldown: the same diff cannot be re-proposed immediately. */
    canonicalDiffHash: text('canonical_diff_hash'),
    deadlineAt: instantMs('deadline_at'),
    minOpenUntil: instantMs('min_open_until'),
    openedAt: instantMs('opened_at').notNull(),
    closedAt: instantMs('closed_at'),
    outcome: jsonOf(ProposalOutcomeSchema, 'proposals.outcome')('outcome'),
    labelId: labelRef().notNull(),
    version: version(),
  },
  (t) => [
    index('proposals_open_idx').on(t.groupId, t.deadlineAt).where(sql`${t.status} = 'open'`),
    // `03` §3.3.8's cooldown lookup: has this exact change been proposed lately?
    index('proposals_diff_idx')
      .on(t.groupId, t.canonicalDiffHash)
      .where(sql`${t.canonicalDiffHash} IS NOT NULL`),
  ],
);

/**
 * One member's vote (`02` §3.3.6).
 *
 * Keyed by `(proposal, member)` so last vote wins until close — people change their minds while a
 * proposal is open, and recording every change would make the tally a reduction over history
 * rather than a read.
 *
 * A **secret ballot** is expressed through the label, whose readers are `{voter}`: the row exists,
 * so the voter can see and change their own vote and the tally can count it, but nobody else can
 * attribute it.
 */
export const proposalVotes = sqliteTable(
  'proposal_votes',
  {
    proposalId: tid('prp')('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),
    memberId: tid('mbr')('member_id')
      .notNull()
      .references(() => members.id),
    choice: text('choice', { enum: ['yes', 'no', 'abstain'] }).notNull(),
    via: text('via', {
      enum: ['native_poll', 'button', 'reaction', 'text', 'dashboard'],
    }).notNull(),
    /** Secret ballot ⇒ readers `{voter}`. */
    labelId: labelRef().notNull(),
    castAt: instantMs('cast_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.proposalId, t.memberId] })],
);

/**
 * What a member allows to be derived from their private data (`03` §3.5.3).
 *
 * Keyed by `member_id` alone — one policy per membership — and labelled with readers `{member}`:
 * this is a statement about someone's own privacy, and nobody else needs to read it, including
 * admins. `03` §3.5.3's `paused` is the single switch for "don't use my private info at all".
 */
export const privateConstraintPolicies = sqliteTable('private_constraint_policies', {
  memberId: tid('mbr')('member_id')
    .primaryKey()
    .references(() => members.id, { onDelete: 'cascade' }),
  groupId: tid('grp')('group_id')
    .notNull()
    .references(() => groups.id, { onDelete: 'cascade' }),
  policy: jsonOf(
    PrivateConstraintPolicySchema,
    'private_constraint_policies.policy',
  )('policy').notNull(),
  /** Readers `{member}`. */
  labelId: labelRef().notNull(),
  updatedAt: updatedAt(),
  version: version(),
});

/**
 * The consent history (`03` lifecycle) — append-only.
 *
 * `members.consent` is the current state; this is how it got there. Append-only because consent is
 * the one field where "when did they agree, and who changed it" has to be answerable later — a
 * `via: 'admin'` transition into `memory_on` is a very different fact from the member choosing it,
 * and a mutable column could not tell them apart.
 */
export const consentEvents = sqliteTable(
  'consent_events',
  {
    id: tid('cev')('id').primaryKey(),
    memberId: tid('mbr')('member_id')
      .notNull()
      .references(() => members.id),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    fromState: text('from_state').notNull(),
    toState: text('to_state').notNull(),
    via: text('via', { enum: ['chat', 'dashboard', 'admin', 'guardian', 'system'] }).notNull(),
    at: instantMs('at').notNull(),
  },
  (t) => [index('consent_events_member_idx').on(t.memberId, t.at)],
);

/**
 * A declassified private constraint (`03` §3.5.4).
 *
 * This is the table that makes "the agent can act on what it knows without saying it" true, and it
 * carries **two labels** to do it:
 *
 *  - `label_id` is the public one. It covers the constraint itself — "X is unavailable Tuesday" —
 *    and is what the scheduler and the writer may read.
 *  - `sealed_label_id` is owner-only and covers `sealed_source_refs`, the memories and messages the
 *    constraint was derived from.
 *
 * Without the split there would be no way to obey a constraint without exposing why it exists,
 * which is the whole point of `03`'s declassifier. `attribution` decides whether the public form
 * may even name the subject: `aggregate_only` renders as "one person needs gluten-free".
 */
export const constraintRecords = sqliteTable(
  'constraint_records',
  {
    id: tid('cst')('id').primaryKey(),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    /** A `CONSTRAINT_KINDS_V1` key; `value` is dispatched on it. */
    kind: text('kind').notNull(),
    catalogVersion: text('catalog_version').notNull(),
    /** A closed schema — `03` DC2 allows no free text in a constraint. */
    value: jsonOf(ConstraintValueSchema, 'constraint_records.value')('value').notNull(),
    subjectMemberId: tid('mbr')('subject_member_id')
      .notNull()
      .references(() => members.id),
    ownerMemberIds: jsonOf(
      z.array(idSchema('mbr')).min(1).max(16),
      'constraint_records.owner_member_ids',
    )('owner_member_ids').notNull(),
    /** `aggregate_only` renders without naming anyone. */
    attribution: text('attribution', {
      enum: ['named', 'unattributed', 'aggregate_only'],
    }).notNull(),
    reasonDisclosure: text('reason_disclosure', {
      enum: ['none', 'personal', 'work', 'travel', 'family', 'medical'],
    })
      .notNull()
      .default('none'),
    scope: jsonOf(ConstraintScopeSchema, 'constraint_records.scope')('scope').notNull(),
    validFrom: instantMs('valid_from').notNull(),
    validTo: instantMs('valid_to'),
    /** `suspended` is `03` E23: temporarily not applied, without being revoked. */
    status: text('status', {
      enum: [
        'pending_owner',
        'active',
        'suspended',
        'expired',
        'revoked',
        'superseded',
        'discarded',
      ],
    }).notNull(),
    approvedBy: jsonOf(
      z.array(idSchema('mbr')).max(16),
      'constraint_records.approved_by',
    )('approved_by').notNull(),
    approvalMode: text('approval_mode', { enum: ['per_item', 'standing'] }),
    /** The public, declassified label. */
    labelId: labelRef().notNull(),
    sealedSourceRefs: jsonOf(
      z.array(EntityRefSchema).max(50),
      'constraint_records.sealed_source_refs',
    )('sealed_source_refs').notNull(),
    /** Owner-only, covering `sealed_source_refs`. */
    sealedLabelId: labelRef('sealed_label_id').notNull(),
    supersedesId: tid('cst')('supersedes_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    // Q-GOV-1: `forTurn` — the active constraints a turn must obey.
    index('constraints_active_idx')
      .on(t.groupId, t.kind, t.validFrom)
      .where(sql`${t.status} = 'active'`),
    index('constraints_subject_idx').on(t.subjectMemberId, t.status),
  ],
);

/**
 * A guardian's standing approval for a ward's actions (`03` §3.3.9).
 *
 * `expires_at` is mandatory and the index is partial on `revoked_at IS NULL`, because a standing
 * approval is a reduction in oversight: it must lapse on its own rather than persist because
 * nobody revisited it. `action_patterns` is a bounded list of patterns rather than a blanket
 * grant, so "yes, they can add calendar events" does not become "yes, to anything".
 */
export const standingApprovals = sqliteTable(
  'standing_approvals',
  {
    id: tid('sap')('id').primaryKey(),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    guardianMemberId: tid('mbr')('guardian_member_id')
      .notNull()
      .references(() => members.id),
    wardMemberId: tid('mbr')('ward_member_id')
      .notNull()
      .references(() => members.id),
    actionPatterns: jsonOf(
      z.array(z.string().max(64)).min(1).max(20),
      'standing_approvals.action_patterns',
    )('action_patterns').notNull(),
    expiresAt: instantMs('expires_at').notNull(),
    revokedAt: instantMs('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('standing_approvals_ward_idx')
      .on(t.wardMemberId, t.expiresAt)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);

/**
 * A pending authorisation (`01` §14 A7; `03` §3.3.12 + `05` §3.6.6).
 *
 * The row that makes "ask before doing something consequential" durable across a restart. Three
 * fields carry most of the weight.
 *
 * **`summary` is a `CopyRef`, never model text.** This is the message asking a human to authorise
 * an action, so it has to describe the action in the product's own words — a model-written summary
 * is precisely where an injected instruction would describe something other than what will run.
 *
 * **`input_ciphertext` is encrypted.** The tool input is held so the action can resume exactly as
 * approved, and it may contain anything the turn was working with, so it is field-encrypted per
 * `08` rather than sitting in a JSON column.
 *
 * **`version` makes the decision a compare-and-swap.** `02` §3.3.6 is explicit: decisions run as
 * `WHERE status='pending' AND version=?`, so two members tapping Approve at the same moment
 * produce exactly one winner and one "already decided" — not two executions of the same action.
 */
export const confirmationRequests = sqliteTable(
  'confirmation_requests',
  {
    id: tid('cnf')('id').primaryKey(),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    turnId: tid('trn')('turn_id'),
    conversationId: tid('cnv')('conversation_id'),
    proposalId: tid('prp')('proposal_id'),
    /** `05`'s `from`: in what capacity the approver acts. */
    capacity: text('capacity', {
      enum: ['requester', 'owner', 'admin', 'guardian'],
    }).notNull(),
    requesterMemberId: tid('mbr')('requester_member_id')
      .notNull()
      .references(() => members.id),
    eligibleMemberIds: jsonOf(
      z.array(idSchema('mbr')).min(1).max(64),
      'confirmation_requests.eligible_member_ids',
    )('eligible_member_ids').notNull(),
    quorum: text('quorum', { enum: ['any', 'all'] }).notNull(),
    reasons: jsonOf(
      z.array(PolicyReasonSchema).max(8),
      'confirmation_requests.reasons',
    )('reasons').notNull(),
    /** Binds the approval to exactly this action (`03` §3.3.3). */
    actionDigest: text('action_digest').notNull(),
    toolName: text('tool_name'),
    /** Field-encrypted per `08`: the tool input, kept so a resume replays what was approved. */
    input: blob('input_ciphertext', { mode: 'buffer' }),
    actionRequest: jsonOf(
      ActionRequestSnapshotSchema,
      'confirmation_requests.action_request',
    )('action_request'),
    targetVersion: integer('target_version'),
    /** A template key plus typed params. Never model text. */
    summary: jsonOf(CopyRefSchema, 'confirmation_requests.summary')('summary').notNull(),
    summaryLabelId: labelRef('summary_label_id').notNull(),
    delivery: text('delivery', { enum: ['inline', 'dm', 'dm_deeplink'] }).notNull(),
    options: jsonOf(
      z
        .array(z.enum(['approve', 'reject', 'approve_always', 'edit']))
        .min(1)
        .max(4),
      'confirmation_requests.options',
    )('options').notNull(),
    /** 8 base32 chars, compared in constant time (`05`). Buttons use `03`'s HMAC tokens. */
    nonce: text('nonce').notNull(),
    promptOutboxIds: jsonOf(
      z.array(idSchema('obx')).max(10),
      'confirmation_requests.prompt_outbox_ids',
    )('prompt_outbox_ids').notNull(),
    responses: jsonOf(
      z.array(ConfirmationResponseSchema).max(64),
      'confirmation_requests.responses',
    )('responses').notNull(),
    status: text('status', {
      enum: ['pending', 'approved', 'rejected', 'expired', 'superseded', 'cancelled'],
    }).notNull(),
    expiresAt: instantMs('expires_at').notNull(),
    /** What an unanswered request means. `apply` is only legal where `03` permits it. */
    onExpire: text('on_expire', { enum: ['drop', 'apply', 'escalate_admin'] }).notNull(),
    decidedByMemberId: tid('mbr')('decided_by_member_id'),
    decidedAt: instantMs('decided_at'),
    labelId: labelRef().notNull(),
    createdAt: createdAt(),
    /** Decisions are CAS: `WHERE status='pending' AND version=?`. */
    version: version(),
  },
  (t) => [
    // Q-GOV-2: requests to expire.
    index('confirmations_pending_idx')
      .on(t.groupId, t.expiresAt)
      .where(sql`${t.status} = 'pending'`),
    // `03`'s rate limits: how many requests this member already has outstanding.
    index('confirmations_pair_idx').on(t.requesterMemberId, t.status),
  ],
);
