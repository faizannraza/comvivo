/**
 * The governance aggregates (`02` §3.3.6; semantics in `03`).
 *
 * Six aggregates, and three of them carry a rule that is unusual enough to state at the type:
 *
 *  - **A constitution version is immutable.** `trg_constitution_versions_immutable` enforces it,
 *    and `constitution_versions_group_version_uq` makes the version number per group dense. An
 *    amendment is a *new* version with a `parentVersionId`, so the chain is the record of how the
 *    group's rules changed — which is the whole point of having a constitution rather than
 *    settings.
 *  - **A confirmation decision is compare-and-swap.** `02` §3.3.6 spells it:
 *    `WHERE status='pending' AND version=?`. Two guardians approving the same request at the same
 *    moment must yield exactly one winner, because the request authorises an **action** and
 *    applying it twice is the failure.
 *  - **A constraint can be unattributed.** `03` lets a member add a constraint the group can see
 *    without seeing *whose* it is, which is why `attribution` and `reasonDisclosure` are separate
 *    columns from the label: the label decides who may read the record, and these decide how much
 *    of it is said out loud.
 */
import type {
  ConfirmationId,
  ConsentEventId,
  ConstitutionVersionId,
  ConstraintId,
  ConversationId,
  GroupId,
  LabelId,
  MemberId,
  OutboxId,
  ProposalId,
  StandingApprovalId,
  TurnId,
  z,
} from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';
import type { EntityRef } from '../domain/entity-ref.js';
import type {
  ActionRequestSnapshotSchema,
  ConfirmationResponse,
  CopyRef,
} from './confirmations.js';
import type { ConstraintScope, ConstraintValueSchema } from './constraints.js';
import type { CompiledPolicySchema, PolicyReason } from './policy.js';
import type {
  AdoptedBy,
  BallotRef,
  ProposalOutcome,
  ProposalPayloadSchema,
  ProposalRule,
} from './proposals.js';

/**
 * The four interiors a later milestone owns.
 *
 * `02` §3.3.9 pins these as **storage contracts**: the column's JSON shape is fixed here and the
 * meaning of what is inside it belongs to the milestone that produces it — the compiled policy to
 * `M4`, the constraint value and the action snapshot to `M4`/`M5`, the proposal payload to `M4`.
 * Taking the inferred type rather than inventing an interface is what keeps this layer from
 * guessing at a shape it does not own.
 */
type CompiledPolicy = z.infer<typeof CompiledPolicySchema>;
type ConstraintValue = z.infer<typeof ConstraintValueSchema>;
type ActionRequestSnapshot = z.infer<typeof ActionRequestSnapshotSchema>;
type ProposalPayload = z.infer<typeof ProposalPayloadSchema>;

/* ──────────────────────── Constitution versions ──────────────────────── */

/** `02` §3.3.6: how a version came to be in force. */
export const ADOPTED_VIA = ['template', 'setup', 'amendment', 'migration', 'placeholder'] as const;
export type AdoptedVia = (typeof ADOPTED_VIA)[number];

/**
 * One version of a group's constitution (`02` §3.3.6; `03`).
 *
 * **Immutable.** There is no update: an amendment writes a new row whose `parentVersionId` is this
 * one, and `groups.constitution_version_id` moves to point at it. So the table is the history of
 * what the group agreed and when, and a version that could be edited would let the rules change
 * without a record — which is the one thing a constitution exists to prevent.
 */
export interface ConstitutionVersion {
  readonly id: ConstitutionVersionId;
  readonly groupId: GroupId;
  /** Dense per group (`constitution_versions_group_version_uq`), so "v3" is unambiguous. */
  readonly version: number;
  readonly parentVersionId: ConstitutionVersionId | undefined;
  /** The source of truth a human edits. */
  readonly yaml: string;
  /**
   * `03`'s `yamlHash`: detects a hand-edited row.
   *
   * Computed by the repository from `yaml`, never supplied — a caller-supplied hash would be
   * derived from whatever that caller had, so a hand-edited row with a matching hand-edited hash
   * would pass the check the column exists for. Absent from `NewConstitutionVersion` for that
   * reason.
   */
  readonly yamlSha256: string;
  /** The rendered charter members actually read (`03`). */
  readonly charterText: string;
  /** What the policy engine evaluates, compiled from the YAML. */
  readonly compiled: CompiledPolicy;
  readonly compilerVersion: string;
  readonly adoptedVia: AdoptedVia;
  readonly adoptedBy: AdoptedBy;
  readonly proposalId: ProposalId | undefined;
  readonly adoptedAt: Temporal.Instant;
}

export interface NewConstitutionVersion {
  readonly id: ConstitutionVersionId;
  readonly groupId: GroupId;
  readonly parentVersionId?: ConstitutionVersionId | undefined;
  readonly yaml: string;
  readonly charterText: string;
  readonly compiled: CompiledPolicy;
  readonly compilerVersion: string;
  readonly adoptedVia: AdoptedVia;
  readonly adoptedBy: AdoptedBy;
  readonly proposalId?: ProposalId | undefined;
  readonly adoptedAt: Temporal.Instant;
}

/* ──────────────────────────── Proposals ──────────────────────────── */

/** `02` §3.3.6: an amendment changes the constitution; a contested action asks the group. */
export const PROPOSAL_KINDS = ['amendment', 'contested_action'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/**
 * `02` §3.3.6's `proposals.status`.
 *
 * `executed` and `execution_failed` are distinct from `passed`, because a contested action that
 * the group approved and that then *failed to run* is not the same as one nobody has run yet —
 * and `03` has to be able to tell a member which happened.
 */
export const PROPOSAL_STATUSES = [
  'open',
  'passed',
  'rejected',
  'expired',
  'withdrawn',
  'cancelled',
  'superseded',
  'executed',
  'execution_failed',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** `02` §3.3.6's `proposal_votes.choice`. */
export const VOTE_CHOICES = ['yes', 'no', 'abstain'] as const;
export type VoteChoice = (typeof VOTE_CHOICES)[number];

/** How the vote arrived (`06`'s channel affordances). */
export const VOTE_VIA = ['native_poll', 'button', 'reaction', 'text', 'dashboard'] as const;
export type VoteVia = (typeof VOTE_VIA)[number];

export interface Proposal {
  readonly id: ProposalId;
  readonly groupId: GroupId;
  readonly kind: ProposalKind;
  readonly payload: ProposalPayload;
  readonly actionDigest: string | undefined;
  readonly rule: ProposalRule;
  readonly electorate: readonly MemberId[];
  readonly status: ProposalStatus;
  readonly proposerMemberId: MemberId;
  /**
   * Where the ballots were rendered (`03`).
   *
   * A structured ref per conversation rather than an id list: a proposal can be balloted in
   * several conversations at once, and `06` needs the platform poll it created in each to update
   * or close it. A first version of this type had `string[]`, which the column's own schema caught.
   */
  readonly ballotRefs: readonly BallotRef[];
  readonly supersededById: ProposalId | undefined;
  readonly canonicalDiffHash: string | undefined;
  readonly deadlineAt: Temporal.Instant | undefined;
  /**
   * The earliest a proposal may close, however the votes land (`03`).
   *
   * Separate from `deadlineAt` because they guard opposite failures: a deadline stops a proposal
   * hanging open forever, and a minimum stops one passing before the people affected have had a
   * chance to see it.
   */
  readonly minOpenUntil: Temporal.Instant | undefined;
  readonly openedAt: Temporal.Instant;
  readonly closedAt: Temporal.Instant | undefined;
  readonly outcome: ProposalOutcome | undefined;
  readonly labelId: LabelId;
  readonly version: number;
}

export interface NewProposal {
  readonly id: ProposalId;
  readonly groupId: GroupId;
  readonly kind: ProposalKind;
  readonly payload: ProposalPayload;
  readonly actionDigest?: string | undefined;
  readonly rule: ProposalRule;
  readonly electorate: readonly MemberId[];
  readonly proposerMemberId: MemberId;
  readonly canonicalDiffHash?: string | undefined;
  readonly deadlineAt?: Temporal.Instant | undefined;
  readonly minOpenUntil?: Temporal.Instant | undefined;
  readonly openedAt: Temporal.Instant;
}

/** One member's vote on a proposal (`02` §3.3.6). */
export interface ProposalVote {
  readonly proposalId: ProposalId;
  readonly memberId: MemberId;
  readonly choice: VoteChoice;
  readonly via: VoteVia;
  readonly labelId: LabelId;
  readonly castAt: Temporal.Instant;
}

/* ──────────────────────────── Consent ──────────────────────────── */

/** How a consent change was made (`02` §3.3.6, `03`). */
export const CONSENT_VIA = ['chat', 'dashboard', 'admin', 'guardian', 'system'] as const;
export type ConsentVia = (typeof CONSENT_VIA)[number];

/**
 * One consent transition (`02` §3.3.6).
 *
 * **Append-only, and the from/to pair is the point.** `members.consent` holds the current state;
 * this table holds how it got there. `03` needs the transition rather than the state to answer
 * "did they agree, or did an admin set it for them" — and `guardian` and `admin` are exactly the
 * cases where the answer matters.
 */
export interface ConsentEvent {
  readonly id: ConsentEventId;
  readonly memberId: MemberId;
  readonly groupId: GroupId;
  readonly fromState: string;
  readonly toState: string;
  readonly via: ConsentVia;
  readonly at: Temporal.Instant;
}

export interface NewConsentEvent {
  readonly id: ConsentEventId;
  readonly memberId: MemberId;
  readonly groupId: GroupId;
  readonly fromState: string;
  readonly toState: string;
  readonly via: ConsentVia;
  readonly at: Temporal.Instant;
}

/* ──────────────────────────── Constraints ──────────────────────────── */

/**
 * `02` §3.3.6's `constraint_records.attribution`.
 *
 * How much the group is told about *whose* constraint it is. `unattributed` is the case `03` cares
 * most about: "somebody cannot do Tuesdays" is usable for scheduling without naming them, and
 * `aggregate_only` is weaker still — the constraint shapes a decision without appearing in it.
 */
export const ATTRIBUTIONS = ['named', 'unattributed', 'aggregate_only'] as const;
export type Attribution = (typeof ATTRIBUTIONS)[number];

/** How much of the *reason* is disclosed (`02` §3.3.6, `03`). `none` is the default. */
export const REASON_DISCLOSURES = [
  'none',
  'personal',
  'work',
  'travel',
  'family',
  'medical',
] as const;
export type ReasonDisclosure = (typeof REASON_DISCLOSURES)[number];

/**
 * `02` §3.3.6's `constraint_records.status`.
 *
 * `pending_owner` is the start for a constraint somebody proposed *about* another member: it does
 * nothing until its owner accepts. `discarded` is distinct from `revoked` because one was never
 * in force and the other was.
 */
export const CONSTRAINT_STATUSES = [
  'pending_owner',
  'active',
  'suspended',
  'expired',
  'revoked',
  'superseded',
  'discarded',
] as const;
export type ConstraintStatus = (typeof CONSTRAINT_STATUSES)[number];

/** Whether each use was approved, or a standing approval covers it (`03`). */
export const APPROVAL_MODES = ['per_item', 'standing'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export interface ConstraintRecord {
  readonly id: ConstraintId;
  readonly groupId: GroupId;
  readonly kind: string;
  readonly catalogVersion: string;
  readonly value: ConstraintValue;
  /**
   * Who the constraint is about (`02` §3.3.6). **`NOT NULL`.**
   *
   * Every constraint has a subject, even an unattributed one: `attribution` decides whether the
   * group is *told* whose it is, and the column records it either way — because `03` has to be
   * able to answer "is this still mine to revoke" after the fact. Separating the two is what makes
   * "somebody cannot do Tuesdays" usable for scheduling without naming them.
   */
  readonly subjectMemberId: MemberId;
  readonly ownerMemberIds: readonly MemberId[];
  readonly attribution: Attribution;
  readonly reasonDisclosure: ReasonDisclosure;
  readonly scope: ConstraintScope;
  readonly validFrom: Temporal.Instant;
  readonly validTo: Temporal.Instant | undefined;
  readonly status: ConstraintStatus;
  readonly approvedBy: readonly MemberId[];
  readonly approvalMode: ApprovalMode | undefined;
  readonly labelId: LabelId;
  /** The sealed source material, as `EntityRef`s (`02` §3.3.6) — not an id list. */
  readonly sealedSourceRefs: readonly EntityRef[];
  /**
   * The label of the **sealed** source material (`03`).
   *
   * Separate from `labelId` because a constraint can be *narrower* than what it came from: "cannot
   * do Tuesdays" may be readable by the group while the message explaining why is not. Two labels,
   * because one would force the constraint to be as private as its reason — and then it could not
   * shape a group decision at all.
   */
  readonly sealedLabelId: LabelId;
  readonly supersedesId: ConstraintId | undefined;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
  readonly version: number;
}

export interface NewConstraintRecord {
  readonly id: ConstraintId;
  readonly groupId: GroupId;
  readonly kind: string;
  readonly catalogVersion: string;
  readonly value: ConstraintValue;
  readonly subjectMemberId: MemberId;
  readonly ownerMemberIds: readonly MemberId[];
  readonly attribution?: Attribution | undefined;
  readonly reasonDisclosure?: ReasonDisclosure | undefined;
  readonly scope: ConstraintScope;
  readonly validFrom: Temporal.Instant;
  readonly validTo?: Temporal.Instant | undefined;
  readonly status?: ConstraintStatus | undefined;
  readonly approvedBy?: readonly MemberId[] | undefined;
  readonly approvalMode?: ApprovalMode | undefined;
  readonly sealedSourceRefs?: readonly EntityRef[] | undefined;
  readonly supersedesId?: ConstraintId | undefined;
}

/**
 * Whether a constraint is in force at an instant (`03`).
 *
 * `active` **and** inside its validity window. Written once here because the two halves are easy to
 * check separately and forget to combine: an expired-but-still-`active` row would keep shaping
 * decisions, and a `suspended` row inside its window would too.
 */
export function constraintInForce(
  constraint: Pick<ConstraintRecord, 'status' | 'validFrom' | 'validTo'>,
  at: Temporal.Instant,
  compare: (left: Temporal.Instant, right: Temporal.Instant) => number,
): boolean {
  if (constraint.status !== 'active') return false;
  if (compare(constraint.validFrom, at) > 0) return false;
  return constraint.validTo === undefined || compare(constraint.validTo, at) >= 0;
}

/* ──────────────────────── Standing approvals ──────────────────────── */

/**
 * A guardian's standing approval for a ward (`02` §3.3.6, `03`).
 *
 * `expiresAt` is **not null**: a standing approval that never expired would be a permanent grant,
 * and `03`'s whole point is that a guardian's consent is revisited. `revokedAt` is the early exit.
 */
export interface StandingApproval {
  readonly id: StandingApprovalId;
  readonly groupId: GroupId;
  readonly guardianMemberId: MemberId;
  readonly wardMemberId: MemberId;
  readonly actionPatterns: readonly string[];
  readonly expiresAt: Temporal.Instant;
  readonly revokedAt: Temporal.Instant | undefined;
  readonly createdAt: Temporal.Instant;
}

export interface NewStandingApproval {
  readonly id: StandingApprovalId;
  readonly groupId: GroupId;
  readonly guardianMemberId: MemberId;
  readonly wardMemberId: MemberId;
  readonly actionPatterns: readonly string[];
  readonly expiresAt: Temporal.Instant;
}

/* ──────────────────────── Confirmation requests ──────────────────────── */

/** In what capacity the decider is being asked (`02` §3.3.6, `03`). */
export const CONFIRMATION_CAPACITIES = ['requester', 'owner', 'admin', 'guardian'] as const;
export type ConfirmationCapacity = (typeof CONFIRMATION_CAPACITIES)[number];

/** `any` is one answer; `all` needs every eligible member (`03`). */
export const CONFIRMATION_QUORUMS = ['any', 'all'] as const;
export type ConfirmationQuorum = (typeof CONFIRMATION_QUORUMS)[number];

/** Where the prompt goes (`06`). `dm_deeplink` is a DM that links back to the conversation. */
export const CONFIRMATION_DELIVERIES = ['inline', 'dm', 'dm_deeplink'] as const;
export type ConfirmationDelivery = (typeof CONFIRMATION_DELIVERIES)[number];

export const CONFIRMATION_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'superseded',
  'cancelled',
] as const;
export type ConfirmationStatus = (typeof CONFIRMATION_STATUSES)[number];

/**
 * What an unanswered request means (`02` §3.3.6).
 *
 * `apply` is "silence is consent" and `02` §3.3.6 notes it "is only legal where `03` permits it" —
 * which is why it is a stored column rather than a policy decision at expiry time: the rule that
 * applied when the request was made is the rule that should decide it.
 */
/**
 * What the prompt offers (`02` §3.3.6, `03`).
 *
 * `approve_always` is the one that does more than answer: it grants a standing approval, which is
 * why `03` only offers it to a guardian and why `standing_approvals` exists as its own table.
 */
export const CONFIRMATION_OPTIONS = ['approve', 'reject', 'approve_always', 'edit'] as const;
export type ConfirmationOption = (typeof CONFIRMATION_OPTIONS)[number];

export const ON_EXPIRE = ['drop', 'apply', 'escalate_admin'] as const;
export type OnExpire = (typeof ON_EXPIRE)[number];

/**
 * A request for somebody to confirm an action (`02` §3.3.6; `03` §3.3).
 *
 * **Decisions are compare-and-swap**, and `02` §3.3.6 says so at the column: `WHERE
 * status='pending' AND version=?`. Two guardians approving at the same moment must produce exactly
 * one winner, because the request authorises an action and running it twice is the failure the
 * whole mechanism exists to prevent.
 *
 * `input` is a **ciphertext blob**: the tool arguments may contain anything the requester typed, and
 * a pending request can sit for hours in a table a backup copies.
 */
export interface ConfirmationRequest {
  readonly id: ConfirmationId;
  readonly groupId: GroupId;
  readonly turnId: TurnId | undefined;
  readonly conversationId: ConversationId | undefined;
  readonly proposalId: ProposalId | undefined;
  readonly capacity: ConfirmationCapacity;
  readonly requesterMemberId: MemberId;
  readonly eligibleMemberIds: readonly MemberId[];
  readonly quorum: ConfirmationQuorum;
  readonly reasons: readonly PolicyReason[];
  readonly actionDigest: string;
  readonly toolName: string | undefined;
  readonly input: Uint8Array | undefined;
  readonly actionRequest: ActionRequestSnapshot | undefined;
  readonly targetVersion: number | undefined;
  readonly summary: CopyRef;
  readonly summaryLabelId: LabelId;
  readonly delivery: ConfirmationDelivery;
  readonly options: readonly ConfirmationOption[];
  readonly nonce: string;
  readonly promptOutboxIds: readonly OutboxId[];
  readonly responses: readonly ConfirmationResponse[];
  readonly status: ConfirmationStatus;
  readonly expiresAt: Temporal.Instant;
  readonly onExpire: OnExpire;
  readonly decidedByMemberId: MemberId | undefined;
  readonly decidedAt: Temporal.Instant | undefined;
  readonly labelId: LabelId;
  readonly createdAt: Temporal.Instant;
  readonly version: number;
}

export interface NewConfirmationRequest {
  readonly id: ConfirmationId;
  readonly groupId: GroupId;
  readonly turnId?: TurnId | undefined;
  readonly conversationId?: ConversationId | undefined;
  readonly proposalId?: ProposalId | undefined;
  readonly capacity: ConfirmationCapacity;
  readonly requesterMemberId: MemberId;
  readonly eligibleMemberIds: readonly MemberId[];
  readonly quorum: ConfirmationQuorum;
  readonly reasons?: readonly PolicyReason[] | undefined;
  readonly actionDigest: string;
  readonly toolName?: string | undefined;
  readonly input?: Uint8Array | undefined;
  readonly actionRequest?: ActionRequestSnapshot | undefined;
  readonly targetVersion?: number | undefined;
  readonly summary: CopyRef;
  readonly delivery: ConfirmationDelivery;
  readonly options?: readonly ConfirmationOption[] | undefined;
  readonly nonce: string;
  readonly promptOutboxIds?: readonly OutboxId[] | undefined;
  readonly expiresAt: Temporal.Instant;
  readonly onExpire: OnExpire;
}

/**
 * Whether a confirmation has the answers its quorum needs (`03`).
 *
 * `any` is satisfied by one approval; `all` needs every eligible member to have approved. A
 * **rejection** settles either, which is the asymmetry worth stating: one person refusing is
 * enough, because the request is for permission and permission is not a majority vote.
 */
export function quorumSatisfied(
  request: Pick<ConfirmationRequest, 'quorum' | 'eligibleMemberIds'>,
  approvals: readonly MemberId[],
): boolean {
  if (request.quorum === 'any') return approvals.length > 0;
  const approved = new Set(approvals);
  return (
    request.eligibleMemberIds.length > 0 &&
    request.eligibleMemberIds.every((memberId) => approved.has(memberId))
  );
}
