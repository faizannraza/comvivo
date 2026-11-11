/**
 * The governance repository port (`02` §3.7.1, §3.3.6; semantics in `03`).
 *
 * Three shapes here are unlike the rest of the repositories, and each is required by `02` §3.3.6
 * rather than chosen:
 *
 *  - **`adoptConstitution` has no update.** A version is immutable
 *    (`trg_constitution_versions_immutable`), so an amendment is a new version plus a move of
 *    `groups.constitution_version_id` — one transaction, both halves.
 *  - **`decideConfirmation` is compare-and-swap on `(status, version)`**, not on `version` alone.
 *    `02` §3.3.6 writes the predicate out: `WHERE status='pending' AND version=?`. The `status`
 *    half is what makes two simultaneous approvals yield exactly one winner even if both read the
 *    same version — and the request authorises an **action**, so applying it twice is the failure.
 *  - **`recordConsent` is append-only** and takes the transition, not the new state. `03` needs to
 *    answer "did they agree, or did an admin set it for them", and only the `via` plus the
 *    from/to pair can.
 */
import type {
  ConfirmationId,
  ConsentEventId,
  ConstitutionVersionId,
  ConstraintId,
  GroupId,
  MemberId,
  ProposalId,
  StandingApprovalId,
} from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';
import type {
  ConfirmationRequest,
  ConsentEvent,
  ConstitutionVersion,
  ConstraintRecord,
  NewConfirmationRequest,
  NewConsentEvent,
  NewConstitutionVersion,
  NewConstraintRecord,
  NewProposal,
  NewStandingApproval,
  Proposal,
  ProposalStatus,
  ProposalVote,
  StandingApproval,
  VoteChoice,
  VoteVia,
} from '../../../governance/aggregates.js';
import type { ProposalOutcome } from '../../../governance/proposals.js';
import type { EligibleLabelSet, Label } from '../../../ifc/eligible.js';
import type { TxToken, WriteResult } from '../uow.js';

export interface GovernanceReader {
  /** The version in force, through `groups.constitution_version_id`. */
  currentConstitution(groupId: GroupId): ConstitutionVersion | undefined;
  constitutionVersion(groupId: GroupId, id: ConstitutionVersionId): ConstitutionVersion | undefined;
  /** Every version, newest first — the record of how the group's rules changed. */
  constitutionHistory(groupId: GroupId, limit: number): readonly ConstitutionVersion[];
  proposal(groupId: GroupId, id: ProposalId, eligible: EligibleLabelSet): Proposal | undefined;
  /** Q-GOV-1's sibling: open proposals by deadline, through `proposals_open_idx`. */
  openProposals(query: {
    readonly groupId: GroupId;
    readonly deadlineBefore?: Temporal.Instant | undefined;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly Proposal[];
  /**
   * An open proposal for the same canonical diff, through `proposals_diff_idx`.
   *
   * **Not label-filtered**: this asks "is the group already deciding this", which is a question
   * about the group's agenda rather than about an audience. Two proposals for the identical
   * amendment would split the vote and neither would reach quorum, which is the failure the index
   * exists to prevent — and the caller never renders the result, it only declines to open a second.
   */
  openProposalForDiff(groupId: GroupId, canonicalDiffHash: string): Proposal | undefined;
  votesOf(groupId: GroupId, id: ProposalId): readonly ProposalVote[];
  /** Q-GOV-1: constraints in force for a turn, through `constraints_active_idx`. */
  activeConstraints(query: {
    readonly groupId: GroupId;
    readonly at: Temporal.Instant;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly ConstraintRecord[];
  /** Through `constraints_subject_idx`: what is on record about one member. */
  constraintsAbout(
    groupId: GroupId,
    subjectMemberId: MemberId,
    eligible: EligibleLabelSet,
  ): readonly ConstraintRecord[];
  /** Q-GOV-2: pending confirmations by expiry, through `confirmations_pending_idx`. */
  pendingConfirmations(query: {
    readonly groupId: GroupId;
    readonly expiringBefore?: Temporal.Instant | undefined;
    readonly limit: number;
  }): readonly ConfirmationRequest[];
  confirmation(groupId: GroupId, id: ConfirmationId): ConfirmationRequest | undefined;
  /**
   * How many requests this requester has outstanding, through `confirmations_pair_idx`.
   *
   * `03`'s rate limit reads this: a member whose every action needs confirming is a member being
   * asked too much, and the limit is what turns that into a policy change rather than a flood.
   */
  outstandingConfirmations(groupId: GroupId, requesterMemberId: MemberId): number;
  /** Live standing approvals for a ward, through `standing_approvals_ward_idx`. */
  standingApprovalsFor(
    groupId: GroupId,
    wardMemberId: MemberId,
    at: Temporal.Instant,
  ): readonly StandingApproval[];
  /** A member's consent history, newest first, through `consent_events_member_idx`. */
  consentHistory(groupId: GroupId, memberId: MemberId, limit: number): readonly ConsentEvent[];
}

export interface GovernanceRepository {
  /**
   * Adopt a constitution version and point the group at it, in one transaction.
   *
   * The version number is **assigned here**, not supplied: `constitution_versions_group_version_uq`
   * makes it dense per group, and a caller computing it would race with another adopting at the
   * same moment. Returns `conflict` when the group's pointer moved under the caller, which is that
   * race arriving as an answer rather than as a constraint violation.
   */
  adoptConstitution(
    uow: TxToken,
    version: NewConstitutionVersion,
    expectCurrentVersionId: ConstitutionVersionId | null,
  ): WriteResult<ConstitutionVersion>;
  openProposal(uow: TxToken, proposal: NewProposal, label: Label): WriteResult<Proposal>;
  /**
   * Cast or change a vote.
   *
   * Replaced rather than appended, like a poll ballot: `(proposal, member)` is the key, and `03`
   * lets a member change their mind while a proposal is open. Returns `conflict` when the proposal
   * is no longer open, which is a vote arriving just after a close — a race, not a bug.
   */
  castVote(
    uow: TxToken,
    groupId: GroupId,
    id: ProposalId,
    memberId: MemberId,
    vote: { readonly choice: VoteChoice; readonly via: VoteVia; readonly at: Temporal.Instant },
  ): WriteResult<ProposalVote>;
  closeProposal(
    uow: TxToken,
    groupId: GroupId,
    id: ProposalId,
    expectVersion: number,
    result: {
      readonly status: ProposalStatus;
      readonly outcome: ProposalOutcome;
      readonly at: Temporal.Instant;
    },
  ): WriteResult<Proposal>;
  recordConstraint(
    uow: TxToken,
    constraint: NewConstraintRecord,
    label: Label,
    sealedLabel: Label,
  ): WriteResult<ConstraintRecord>;
  setConstraintStatus(
    uow: TxToken,
    groupId: GroupId,
    id: ConstraintId,
    expectVersion: number,
    status: ConstraintRecord['status'],
    at: Temporal.Instant,
  ): WriteResult<ConstraintRecord>;
  requestConfirmation(
    uow: TxToken,
    request: NewConfirmationRequest,
    label: Label,
    summaryLabel: Label,
  ): WriteResult<ConfirmationRequest>;
  /**
   * Decide a pending confirmation, **compare-and-swap** (`02` §3.3.6).
   *
   * `WHERE status='pending' AND version=?`. Returns `conflict` when somebody else decided first —
   * which two guardians tapping "approve" at the same moment will reach, and exactly one of them
   * will win. The caller that loses must **not** run the action.
   */
  decideConfirmation(
    uow: TxToken,
    groupId: GroupId,
    id: ConfirmationId,
    expectVersion: number,
    decision: {
      readonly status: Extract<ConfirmationRequest['status'], 'approved' | 'rejected'>;
      readonly byMemberId: MemberId;
      readonly at: Temporal.Instant;
    },
  ): WriteResult<ConfirmationRequest>;
  /** Expire a pending request, applying `on_expire`'s recorded meaning. */
  expireConfirmation(
    uow: TxToken,
    groupId: GroupId,
    id: ConfirmationId,
    expectVersion: number,
    at: Temporal.Instant,
  ): WriteResult<ConfirmationRequest>;
  grantStandingApproval(uow: TxToken, approval: NewStandingApproval): WriteResult<StandingApproval>;
  revokeStandingApproval(
    uow: TxToken,
    groupId: GroupId,
    id: StandingApprovalId,
    at: Temporal.Instant,
  ): WriteResult<StandingApproval>;
  /** Append a consent transition (`03`). There is no update: the history is the record. */
  recordConsent(uow: TxToken, event: NewConsentEvent): WriteResult<ConsentEvent>;
}

/** The id a consent event is minted with, for a caller threading it through a trace. */
export type ConsentEventRef = ConsentEventId;
