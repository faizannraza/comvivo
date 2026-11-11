/**
 * The governance repository (`02` §3.7.1, §3.3.6; semantics in `03`).
 *
 * ## The confirmation decision is compare-and-swap, and that is the whole point
 *
 * `02` §3.3.6 writes the predicate at the column: `WHERE status='pending' AND version=?`. The
 * `status` half is what the `version` alone cannot do — two guardians who both read version 1 and
 * both tap "approve" would both pass a version check written as `version = 1`, because the losing
 * write would see the row at version 2 and conflict only by luck of ordering. With `status =
 * 'pending'` in the predicate, the second `UPDATE` matches **no row**: the status is no longer
 * pending. Exactly one winner, deterministically.
 *
 * Why that matters more here than anywhere else in this subsystem: a confirmation authorises an
 * **action**. A second approval that "succeeded" would let the caller run the action again, and
 * `03`'s whole confirmation flow exists to stop an action happening without permission — not to
 * stop it happening twice with it.
 *
 * ## A constitution version is immutable
 *
 * `trg_constitution_versions_immutable` enforces it, so there is no update. `adoptConstitution`
 * writes a new version **and** moves `groups.constitution_version_id` in one transaction, and
 * assigns the version number itself — `constitution_versions_group_version_uq` makes it dense per
 * group, so a caller computing it would race.
 */
import type {
  ConfirmationRequest,
  ConsentEvent,
  ConstitutionVersion,
  ConstraintRecord,
  EligibleLabelSet,
  GovernanceReader,
  GovernanceRepository,
  Label,
  NewConfirmationRequest,
  NewConsentEvent,
  NewConstitutionVersion,
  NewConstraintRecord,
  NewProposal,
  NewStandingApproval,
  Proposal,
  ProposalOutcome,
  ProposalStatus,
  ProposalVote,
  StandingApproval,
  TxToken,
  VoteChoice,
  VoteVia,
  WriteResult,
} from '@comvivo/core';
import { duplicate, notFound, writeConflict, writeOk } from '@comvivo/core';
import {
  type ConfirmationId,
  type ConstitutionVersionId,
  type ConstraintId,
  type GroupId,
  type MemberId,
  type ProposalId,
  type StandingApprovalId,
  StorageError,
} from '@comvivo/shared';
import { sha256Hex } from '@comvivo/shared/crypto';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, type SQL, sql } from 'drizzle-orm';
import type { Temporal } from 'temporal-polyfill';
import { type Db, exactlyOne, maybeOne, type Patch } from '../db/drizzle.js';
import { isUniqueViolation } from '../db/errors.js';
import type { LabelStore } from '../ifc/label-store.js';
import {
  confirmationRequests,
  consentEvents,
  constitutionVersions,
  constraintRecords,
  groups,
  proposals,
  proposalVotes,
  standingApprovals,
} from '../schema/index.js';
import {
  toConfirmationRequest,
  toConsentEvent,
  toConstitutionVersion,
  toConstraintRecord,
  toProposal,
  toProposalVote,
  toStandingApproval,
} from './rows.js';

export class SqliteGovernanceRepository implements GovernanceReader, GovernanceRepository {
  readonly #db: Db;
  readonly #labels: LabelStore;

  constructor(db: Db, labels: LabelStore) {
    this.#db = db;
    this.#labels = labels;
  }

  /* ───────────────────────── Constitution ───────────────────────── */

  /**
   * The version in force, through the group's own pointer.
   *
   * Through `groups.constitution_version_id` rather than "the highest version number", because
   * those can differ: `02` §3.3.1 notes the pointer has **no foreign key** (a module cycle), and
   * the pointer is what `03` evaluates against. Reading the maximum instead would quietly use a
   * version the group has not adopted — which is exactly what an interrupted adoption leaves.
   */
  currentConstitution(groupId: GroupId): ConstitutionVersion | undefined {
    const group = maybeOne(
      this.#db
        .select({ versionId: groups.constitutionVersionId })
        .from(groups)
        .where(eq(groups.id, groupId)),
    );
    if (group?.versionId === undefined || group.versionId === null) return undefined;
    return this.constitutionVersion(groupId, group.versionId);
  }

  constitutionVersion(
    groupId: GroupId,
    id: ConstitutionVersionId,
  ): ConstitutionVersion | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(constitutionVersions)
        .where(and(eq(constitutionVersions.groupId, groupId), eq(constitutionVersions.id, id))),
    );
    return row === undefined ? undefined : toConstitutionVersion(row);
  }

  constitutionHistory(groupId: GroupId, limit: number): readonly ConstitutionVersion[] {
    const rows = this.#db
      .select()
      .from(constitutionVersions)
      .where(eq(constitutionVersions.groupId, groupId))
      .orderBy(desc(constitutionVersions.version))
      .limit(limit)
      .all();
    return rows.map(toConstitutionVersion);
  }

  /**
   * Adopt a version and move the group's pointer, in one transaction.
   *
   * `expectCurrentVersionId` is the optimistic check, and it is the group's **pointer** rather than
   * a version number: two amendments adopted at the same moment would both compute version N+1,
   * and the unique index would refuse the second with a constraint error rather than a
   * `conflict` the caller can act on. Comparing the pointer turns that race into an answer.
   */
  adoptConstitution(
    uow: TxToken,
    version: NewConstitutionVersion,
    expectCurrentVersionId: ConstitutionVersionId | null,
  ): WriteResult<ConstitutionVersion> {
    const group = maybeOne(
      this.#db
        .select({ versionId: groups.constitutionVersionId })
        .from(groups)
        .where(eq(groups.id, version.groupId)),
    );
    if (group === undefined) return notFound();
    const current = group.versionId ?? null;
    if (current !== expectCurrentVersionId) return writeConflict();

    // Assigned here, not supplied: the index makes it dense per group, so a caller computing it
    // would race with another adopting at the same moment.
    const highest = maybeOne(
      this.#db
        .select({ version: constitutionVersions.version })
        .from(constitutionVersions)
        .where(eq(constitutionVersions.groupId, version.groupId))
        .orderBy(desc(constitutionVersions.version)),
    );
    const next = (highest?.version ?? 0) + 1;

    const row = exactlyOne(
      this.#db
        .insert(constitutionVersions)
        .values({
          id: version.id,
          groupId: version.groupId,
          version: next,
          parentVersionId: version.parentVersionId ?? current ?? undefined,
          yaml: version.yaml,
          // Computed here, never supplied. `03`'s `yamlHash` exists to "detect a hand-edited
          // row", and a caller-supplied hash would be computed from whatever that caller had —
          // so a hand-edited row with a matching hand-edited hash would pass. The same reasoning
          // as the message dedupe key: a checksum is only evidence if one place derives it.
          yamlSha256: sha256Hex(version.yaml),
          charterText: version.charterText,
          compiled: version.compiled,
          compilerVersion: version.compilerVersion,
          adoptedVia: version.adoptedVia,
          adoptedBy: version.adoptedBy,
          proposalId: version.proposalId,
          adoptedAt: version.adoptedAt,
        })
        .returning(),
      'the constitution version',
    );
    // The pointer moves in the same transaction. A version adopted without the move would be a
    // row nothing evaluates; a move without the version would point at nothing.
    this.#db
      .update(groups)
      .set({
        constitutionVersionId: version.id,
        updatedAt: uow.now,
        version: sql`${groups.version} + 1`,
      })
      .where(eq(groups.id, version.groupId))
      .run();
    return writeOk(toConstitutionVersion(row));
  }

  /* ───────────────────────── Proposals ───────────────────────── */

  proposal(groupId: GroupId, id: ProposalId, eligible: EligibleLabelSet): Proposal | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(proposals)
        .where(
          and(eq(proposals.groupId, groupId), eq(proposals.id, id), proposalEligible(eligible)),
        ),
    );
    return row === undefined ? undefined : toProposal(row);
  }

  /** Through `proposals_open_idx` — partial on `status = 'open'`. */
  openProposals(query: {
    readonly groupId: GroupId;
    readonly deadlineBefore?: Temporal.Instant | undefined;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly Proposal[] {
    if (query.eligible.ids.length === 0) return [];
    const rows = this.#db
      .select()
      .from(proposals)
      .where(
        and(
          eq(proposals.groupId, query.groupId),
          eq(proposals.status, 'open'),
          ...(query.deadlineBefore === undefined
            ? []
            : [lte(proposals.deadlineAt, query.deadlineBefore)]),
          proposalEligible(query.eligible),
        ),
      )
      // Undeadlined last, as everywhere: `NULL` sorts first in SQLite and "what closes soonest"
      // with every open-ended proposal at the top is useless.
      .orderBy(sql`${proposals.deadlineAt} IS NULL`, asc(proposals.deadlineAt), asc(proposals.id))
      .limit(query.limit)
      .all();
    return rows.map(toProposal);
  }

  /** Through `proposals_diff_idx`. Unfiltered — see the port for why. */
  openProposalForDiff(groupId: GroupId, canonicalDiffHash: string): Proposal | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(proposals)
        .where(
          and(
            eq(proposals.groupId, groupId),
            eq(proposals.canonicalDiffHash, canonicalDiffHash),
            eq(proposals.status, 'open'),
          ),
        ),
    );
    return row === undefined ? undefined : toProposal(row);
  }

  votesOf(groupId: GroupId, id: ProposalId): readonly ProposalVote[] {
    // Through the proposal, because `proposal_votes` has no `group_id` — its isolation is the
    // foreign key, and an unjoined read would cross groups.
    const rows = this.#db
      .select({ vote: proposalVotes })
      .from(proposalVotes)
      .innerJoin(proposals, eq(proposals.id, proposalVotes.proposalId))
      .where(and(eq(proposals.groupId, groupId), eq(proposalVotes.proposalId, id)))
      .orderBy(asc(proposalVotes.memberId))
      .all();
    return rows.map((row) => toProposalVote(row.vote));
  }

  openProposal(uow: TxToken, proposal: NewProposal, label: Label): WriteResult<Proposal> {
    if (label.groupId !== proposal.groupId) throw crossGroup('proposal');
    const labelId = this.#labels.intern(uow, label);
    try {
      const row = exactlyOne(
        this.#db
          .insert(proposals)
          .values({
            id: proposal.id,
            groupId: proposal.groupId,
            kind: proposal.kind,
            payload: proposal.payload,
            actionDigest: proposal.actionDigest,
            rule: proposal.rule,
            electorate: [...proposal.electorate],
            status: 'open',
            proposerMemberId: proposal.proposerMemberId,
            ballotRefs: [],
            canonicalDiffHash: proposal.canonicalDiffHash,
            deadlineAt: proposal.deadlineAt,
            minOpenUntil: proposal.minOpenUntil,
            openedAt: proposal.openedAt,
            labelId,
          })
          .returning(),
        'the proposal',
      );
      return writeOk(toProposal(row));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return duplicate(proposal.id);
    }
  }

  castVote(
    _uow: TxToken,
    groupId: GroupId,
    id: ProposalId,
    memberId: MemberId,
    vote: { readonly choice: VoteChoice; readonly via: VoteVia; readonly at: Temporal.Instant },
  ): WriteResult<ProposalVote> {
    const proposal = this.#proposalRow(groupId, id);
    if (proposal === undefined) return notFound();
    // A vote arriving just after a close is a race, not a bug — so `conflict` rather than an
    // error, and the caller's answer to the member is "that closed".
    if (proposal.status !== 'open') return writeConflict();
    if (proposal.electorate.length > 0 && !proposal.electorate.includes(memberId)) {
      throw new StorageError('STORAGE_CONSTRAINT', 'that member is not in the electorate', {
        hint: "This is a bug in the caller: check the proposal's electorate before offering a vote.",
        category: 'bug',
      });
    }
    const row = exactlyOne(
      this.#db
        .insert(proposalVotes)
        .values({
          proposalId: id,
          memberId,
          choice: vote.choice,
          via: vote.via,
          labelId: proposal.labelId,
          castAt: vote.at,
        })
        // Replaced, like a poll ballot: `03` lets a member change their mind while a proposal is
        // open, and two rows for one member would double-count.
        .onConflictDoUpdate({
          target: [proposalVotes.proposalId, proposalVotes.memberId],
          set: { choice: vote.choice, via: vote.via, castAt: vote.at },
        })
        .returning(),
      'the vote',
    );
    return writeOk(toProposalVote(row));
  }

  closeProposal(
    _uow: TxToken,
    groupId: GroupId,
    id: ProposalId,
    expectVersion: number,
    result: {
      readonly status: ProposalStatus;
      readonly outcome: ProposalOutcome;
      readonly at: Temporal.Instant;
    },
  ): WriteResult<Proposal> {
    if (result.status === 'open') {
      throw new StorageError('STORAGE_CONSTRAINT', 'closing a proposal needs a closed status', {
        hint: 'This is a bug in the caller: `open` is not an outcome.',
        category: 'bug',
      });
    }
    const row = maybeOne(
      this.#db
        .update(proposals)
        .set({
          status: result.status,
          outcome: result.outcome,
          closedAt: result.at,
          version: expectVersion + 1,
        })
        // `status = 'open'` as well as the version, for the same reason the confirmation decision
        // carries it: two closers racing must produce one winner, and the version alone leaves
        // that to ordering.
        .where(
          and(
            eq(proposals.groupId, groupId),
            eq(proposals.id, id),
            eq(proposals.status, 'open'),
            eq(proposals.version, expectVersion),
          ),
        )
        .returning(),
    );
    if (row !== undefined) return writeOk(toProposal(row));
    return this.#proposalRow(groupId, id) === undefined ? notFound() : writeConflict();
  }

  /* ───────────────────────── Constraints ───────────────────────── */

  /** Q-GOV-1, through `constraints_active_idx`. */
  activeConstraints(query: {
    readonly groupId: GroupId;
    readonly at: Temporal.Instant;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly ConstraintRecord[] {
    if (query.eligible.ids.length === 0) return [];
    const rows = this.#db
      .select()
      .from(constraintRecords)
      .where(
        and(
          eq(constraintRecords.groupId, query.groupId),
          eq(constraintRecords.status, 'active'),
          lte(constraintRecords.validFrom, query.at),
          // Open-ended **or** not yet expired. The `IS NULL` arm is most constraints: "cannot do
          // Tuesdays" has no end date, and a plain `valid_to >= :at` would drop every one of them.
          or(isNull(constraintRecords.validTo), gte(constraintRecords.validTo, query.at)),
          constraintEligible(query.eligible),
        ),
      )
      .orderBy(asc(constraintRecords.validFrom), asc(constraintRecords.id))
      .limit(query.limit)
      .all();
    return rows.map(toConstraintRecord);
  }

  constraintsAbout(
    groupId: GroupId,
    subjectMemberId: MemberId,
    eligible: EligibleLabelSet,
  ): readonly ConstraintRecord[] {
    if (eligible.ids.length === 0) return [];
    const rows = this.#db
      .select()
      .from(constraintRecords)
      .where(
        and(
          eq(constraintRecords.groupId, groupId),
          eq(constraintRecords.subjectMemberId, subjectMemberId),
          constraintEligible(eligible),
        ),
      )
      .orderBy(desc(constraintRecords.validFrom), asc(constraintRecords.id))
      .all();
    return rows.map(toConstraintRecord);
  }

  /**
   * Record a constraint with **two** labels.
   *
   * `labelId` is who may read the constraint; `sealedLabelId` is who may read the source material
   * it came from. Two, because a constraint can be narrower than its reason: "cannot do Tuesdays"
   * may be readable by the group while the message explaining why is not — and one label would
   * force the constraint to be as private as its reason, after which it could not shape a group
   * decision at all, which is the only thing it is for.
   */
  recordConstraint(
    uow: TxToken,
    constraint: NewConstraintRecord,
    label: Label,
    sealedLabel: Label,
  ): WriteResult<ConstraintRecord> {
    if (label.groupId !== constraint.groupId) throw crossGroup('constraint');
    if (sealedLabel.groupId !== constraint.groupId) throw crossGroup('sealed source');
    const labelId = this.#labels.intern(uow, label);
    const sealedLabelId = this.#labels.intern(uow, sealedLabel);
    try {
      const row = exactlyOne(
        this.#db
          .insert(constraintRecords)
          .values({
            id: constraint.id,
            groupId: constraint.groupId,
            kind: constraint.kind,
            catalogVersion: constraint.catalogVersion,
            value: constraint.value,
            subjectMemberId: constraint.subjectMemberId,
            ownerMemberIds: [...constraint.ownerMemberIds],
            attribution: constraint.attribution ?? 'named',
            reasonDisclosure: constraint.reasonDisclosure ?? 'none',
            scope: constraint.scope,
            validFrom: constraint.validFrom,
            validTo: constraint.validTo,
            status: constraint.status ?? 'pending_owner',
            approvedBy: [...(constraint.approvedBy ?? [])],
            approvalMode: constraint.approvalMode,
            labelId,
            sealedSourceRefs: [...(constraint.sealedSourceRefs ?? [])],
            sealedLabelId,
            supersedesId: constraint.supersedesId,
            createdAt: uow.now,
            updatedAt: uow.now,
          })
          .returning(),
        'the constraint',
      );
      return writeOk(toConstraintRecord(row));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return duplicate(constraint.id);
    }
  }

  setConstraintStatus(
    uow: TxToken,
    groupId: GroupId,
    id: ConstraintId,
    expectVersion: number,
    status: ConstraintRecord['status'],
    at: Temporal.Instant,
  ): WriteResult<ConstraintRecord> {
    const patch: Patch<typeof constraintRecords.$inferInsert> = { status };
    // Revoking and expiring both end the constraint's validity, so the window closes with the
    // status — otherwise `activeConstraints` would exclude it by status while
    // `constraintInForce` disagreed about the window, and the two are supposed to be the same rule.
    if (status === 'revoked' || status === 'expired') patch.validTo = at;
    const row = maybeOne(
      this.#db
        .update(constraintRecords)
        .set({ ...patch, updatedAt: uow.now, version: expectVersion + 1 })
        .where(
          and(
            eq(constraintRecords.groupId, groupId),
            eq(constraintRecords.id, id),
            eq(constraintRecords.version, expectVersion),
          ),
        )
        .returning(),
    );
    if (row !== undefined) return writeOk(toConstraintRecord(row));
    const exists = maybeOne(
      this.#db
        .select({ id: constraintRecords.id })
        .from(constraintRecords)
        .where(and(eq(constraintRecords.groupId, groupId), eq(constraintRecords.id, id))),
    );
    return exists === undefined ? notFound() : writeConflict();
  }

  /* ───────────────────── Confirmation requests ───────────────────── */

  /** Q-GOV-2, through `confirmations_pending_idx`. */
  pendingConfirmations(query: {
    readonly groupId: GroupId;
    readonly expiringBefore?: Temporal.Instant | undefined;
    readonly limit: number;
  }): readonly ConfirmationRequest[] {
    const rows = this.#db
      .select()
      .from(confirmationRequests)
      .where(
        and(
          eq(confirmationRequests.groupId, query.groupId),
          eq(confirmationRequests.status, 'pending'),
          ...(query.expiringBefore === undefined
            ? []
            : [lte(confirmationRequests.expiresAt, query.expiringBefore)]),
        ),
      )
      .orderBy(asc(confirmationRequests.expiresAt), asc(confirmationRequests.id))
      .limit(query.limit)
      .all();
    return rows.map(toConfirmationRequest);
  }

  /**
   * One request, **unfiltered by label**.
   *
   * The expiry sweep and the decision path both need it, and neither is an audience: the sweep is
   * a job, and the decider has already been named in `eligibleMemberIds`. What the *label* governs
   * is who may read the **summary** — which is why `summary_label_id` is a separate column, and
   * why `03`'s rendering reads that rather than this.
   */
  confirmation(groupId: GroupId, id: ConfirmationId): ConfirmationRequest | undefined {
    const row = this.#confirmationRow(groupId, id);
    return row === undefined ? undefined : toConfirmationRequest(row);
  }

  /** Through `confirmations_pair_idx`: `03`'s rate limit reads this. */
  outstandingConfirmations(groupId: GroupId, requesterMemberId: MemberId): number {
    const row = maybeOne(
      this.#db
        .select({ n: sql<number>`count(*)` })
        .from(confirmationRequests)
        .where(
          and(
            eq(confirmationRequests.groupId, groupId),
            eq(confirmationRequests.requesterMemberId, requesterMemberId),
            eq(confirmationRequests.status, 'pending'),
          ),
        ),
    );
    return row?.n ?? 0;
  }

  requestConfirmation(
    uow: TxToken,
    request: NewConfirmationRequest,
    label: Label,
    summaryLabel: Label,
  ): WriteResult<ConfirmationRequest> {
    if (label.groupId !== request.groupId) throw crossGroup('confirmation request');
    if (summaryLabel.groupId !== request.groupId) throw crossGroup('confirmation summary');
    const labelId = this.#labels.intern(uow, label);
    const summaryLabelId = this.#labels.intern(uow, summaryLabel);
    try {
      const row = exactlyOne(
        this.#db
          .insert(confirmationRequests)
          .values({
            id: request.id,
            groupId: request.groupId,
            turnId: request.turnId,
            conversationId: request.conversationId,
            proposalId: request.proposalId,
            capacity: request.capacity,
            requesterMemberId: request.requesterMemberId,
            eligibleMemberIds: [...request.eligibleMemberIds],
            quorum: request.quorum,
            reasons: [...(request.reasons ?? [])],
            actionDigest: request.actionDigest,
            toolName: request.toolName,
            input: request.input === undefined ? undefined : Buffer.from(request.input),
            actionRequest: request.actionRequest,
            targetVersion: request.targetVersion,
            summary: request.summary,
            summaryLabelId,
            delivery: request.delivery,
            options: [...(request.options ?? ['approve', 'reject'])],
            nonce: request.nonce,
            promptOutboxIds: [...(request.promptOutboxIds ?? [])],
            responses: [],
            status: 'pending',
            expiresAt: request.expiresAt,
            onExpire: request.onExpire,
            labelId,
            createdAt: uow.now,
          })
          .returning(),
        'the confirmation request',
      );
      return writeOk(toConfirmationRequest(row));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return duplicate(request.id);
    }
  }

  /**
   * Decide a pending request — **compare-and-swap** (`02` §3.3.6).
   *
   * `WHERE status='pending' AND version=?`. See the module header for why the `status` half is the
   * part that matters: with the version alone, two guardians who both read version 1 would both
   * satisfy the predicate and the loser would be decided by ordering rather than by the database.
   */
  decideConfirmation(
    _uow: TxToken,
    groupId: GroupId,
    id: ConfirmationId,
    expectVersion: number,
    decision: {
      readonly status: 'approved' | 'rejected';
      readonly byMemberId: MemberId;
      readonly at: Temporal.Instant;
    },
  ): WriteResult<ConfirmationRequest> {
    const row = maybeOne(
      this.#db
        .update(confirmationRequests)
        .set({
          status: decision.status,
          decidedByMemberId: decision.byMemberId,
          decidedAt: decision.at,
          version: expectVersion + 1,
        })
        .where(
          and(
            eq(confirmationRequests.groupId, groupId),
            eq(confirmationRequests.id, id),
            eq(confirmationRequests.status, 'pending'),
            eq(confirmationRequests.version, expectVersion),
          ),
        )
        .returning(),
    );
    if (row !== undefined) return writeOk(toConfirmationRequest(row));
    // Not found, or already decided, or at another version — all `conflict` except absence, and
    // the caller's response to a conflict is the important one: **do not run the action**.
    return this.#confirmationRow(groupId, id) === undefined ? notFound() : writeConflict();
  }

  /**
   * Expire a pending request.
   *
   * The same compare-and-swap, because the sweep races the decider: a guardian approving at the
   * moment the request expires must not have their approval overwritten by the sweep, and the
   * sweep must not expire something just approved. One winner either way.
   */
  expireConfirmation(
    _uow: TxToken,
    groupId: GroupId,
    id: ConfirmationId,
    expectVersion: number,
    at: Temporal.Instant,
  ): WriteResult<ConfirmationRequest> {
    const row = maybeOne(
      this.#db
        .update(confirmationRequests)
        .set({ status: 'expired', decidedAt: at, version: expectVersion + 1 })
        .where(
          and(
            eq(confirmationRequests.groupId, groupId),
            eq(confirmationRequests.id, id),
            eq(confirmationRequests.status, 'pending'),
            eq(confirmationRequests.version, expectVersion),
          ),
        )
        .returning(),
    );
    if (row !== undefined) return writeOk(toConfirmationRequest(row));
    return this.#confirmationRow(groupId, id) === undefined ? notFound() : writeConflict();
  }

  /* ───────────────────── Standing approvals & consent ───────────────────── */

  /** Through `standing_approvals_ward_idx`: live approvals only. */
  standingApprovalsFor(
    groupId: GroupId,
    wardMemberId: MemberId,
    at: Temporal.Instant,
  ): readonly StandingApproval[] {
    const rows = this.#db
      .select()
      .from(standingApprovals)
      .where(
        and(
          eq(standingApprovals.groupId, groupId),
          eq(standingApprovals.wardMemberId, wardMemberId),
          isNull(standingApprovals.revokedAt),
          gte(standingApprovals.expiresAt, at),
        ),
      )
      .orderBy(asc(standingApprovals.expiresAt))
      .all();
    return rows.map(toStandingApproval);
  }

  grantStandingApproval(
    uow: TxToken,
    approval: NewStandingApproval,
  ): WriteResult<StandingApproval> {
    try {
      const row = exactlyOne(
        this.#db
          .insert(standingApprovals)
          .values({
            id: approval.id,
            groupId: approval.groupId,
            guardianMemberId: approval.guardianMemberId,
            wardMemberId: approval.wardMemberId,
            actionPatterns: [...approval.actionPatterns],
            expiresAt: approval.expiresAt,
            createdAt: uow.now,
          })
          .returning(),
        'the standing approval',
      );
      return writeOk(toStandingApproval(row));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return duplicate(approval.id);
    }
  }

  /**
   * Revoke a standing approval.
   *
   * Stamped rather than deleted, and unversioned: a revocation is a fact about when the guardian
   * changed their mind, and `03` has to be able to say that an action taken before it was covered.
   * Deleting the row would make every past use look unauthorised.
   */
  revokeStandingApproval(
    _uow: TxToken,
    groupId: GroupId,
    id: StandingApprovalId,
    at: Temporal.Instant,
  ): WriteResult<StandingApproval> {
    const row = maybeOne(
      this.#db
        .update(standingApprovals)
        .set({ revokedAt: at })
        .where(
          and(
            eq(standingApprovals.groupId, groupId),
            eq(standingApprovals.id, id),
            isNull(standingApprovals.revokedAt),
          ),
        )
        .returning(),
    );
    if (row !== undefined) return writeOk(toStandingApproval(row));
    const exists = maybeOne(
      this.#db
        .select()
        .from(standingApprovals)
        .where(and(eq(standingApprovals.groupId, groupId), eq(standingApprovals.id, id))),
    );
    // Already revoked is `ok` with the existing row: revocation is idempotent, and a guardian
    // tapping twice should not see an error.
    return exists === undefined ? notFound() : writeOk(toStandingApproval(exists));
  }

  consentHistory(groupId: GroupId, memberId: MemberId, limit: number): readonly ConsentEvent[] {
    const rows = this.#db
      .select()
      .from(consentEvents)
      .where(and(eq(consentEvents.groupId, groupId), eq(consentEvents.memberId, memberId)))
      .orderBy(desc(consentEvents.at), desc(consentEvents.id))
      .limit(limit)
      .all();
    return rows.map(toConsentEvent);
  }

  /** Append-only: the history **is** the record (`03`). No update, no delete. */
  recordConsent(_uow: TxToken, event: NewConsentEvent): WriteResult<ConsentEvent> {
    try {
      const row = exactlyOne(
        this.#db
          .insert(consentEvents)
          .values({
            id: event.id,
            memberId: event.memberId,
            groupId: event.groupId,
            fromState: event.fromState,
            toState: event.toState,
            via: event.via,
            at: event.at,
          })
          .returning(),
        'the consent event',
      );
      return writeOk(toConsentEvent(row));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return duplicate(event.id);
    }
  }

  /* ──────────────────────────── Internals ──────────────────────────── */

  #proposalRow(groupId: GroupId, id: ProposalId): typeof proposals.$inferSelect | undefined {
    return maybeOne(
      this.#db
        .select()
        .from(proposals)
        .where(and(eq(proposals.groupId, groupId), eq(proposals.id, id))),
    );
  }

  #confirmationRow(
    groupId: GroupId,
    id: ConfirmationId,
  ): typeof confirmationRequests.$inferSelect | undefined {
    return maybeOne(
      this.#db
        .select()
        .from(confirmationRequests)
        .where(and(eq(confirmationRequests.groupId, groupId), eq(confirmationRequests.id, id))),
    );
  }
}

function proposalEligible(eligible: EligibleLabelSet): SQL {
  if (eligible.ids.length === 0) return sql`1 = 0`;
  return inArray(proposals.labelId, [...eligible.ids]);
}

function constraintEligible(eligible: EligibleLabelSet): SQL {
  if (eligible.ids.length === 0) return sql`1 = 0`;
  return inArray(constraintRecords.labelId, [...eligible.ids]);
}

function crossGroup(what: string): StorageError {
  return new StorageError('STORAGE_CONSTRAINT', `the ${what} names a label of another group`, {
    hint: `This is a bug and an I4 violation: intern the label against the ${what}'s own group.`,
    category: 'bug',
  });
}
