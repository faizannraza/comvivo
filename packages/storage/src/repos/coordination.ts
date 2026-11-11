/**
 * The poll, plan, decision and reminder repositories (`02` §3.7.1, §3.3.5; semantics in `07`).
 *
 * Four aggregates in one module because each is small and the interesting parts are specific:
 *
 *  - **Polls** keep `poll_counts` in step with `poll_votes` inside one transaction. That is what
 *    makes an *anonymous* poll possible at all: the counts are readable and the ballots are not, so
 *    a tally that disagreed with its ballots could not be reconciled by anyone.
 *  - **Plans** have steps that inherit the plan's label (`02` §3.3.5 gives `plan_steps` no
 *    `label_id`), which is what makes a surprise party coherent.
 *  - **Decisions** are superseded rather than edited, like memory items.
 *  - **Reminders** fire exactly once per occurrence, enforced by
 *    `reminder_firings_occurrence_uq` rather than by the scheduler remembering — which is `I6`
 *    for reminders.
 */
import type {
  Decision,
  DecisionReader,
  DecisionRepository,
  EligibleLabelSet,
  Label,
  NewDecision,
  NewPlan,
  NewPlanStep,
  NewPoll,
  NewReminder,
  Plan,
  PlanReader,
  PlanRepository,
  PlanStatus,
  PlanStep,
  PlanStepStatus,
  Poll,
  PollOutcome,
  PollReader,
  PollRepository,
  Reminder,
  ReminderFiring,
  ReminderReader,
  ReminderRepository,
  ReminderStatus,
  TxToken,
  WriteResult,
} from '@comvivo/core';
import { duplicate, notFound, writeConflict, writeOk } from '@comvivo/core';
import {
  type DecisionId,
  type GroupId,
  type MemberId,
  type OutboxId,
  type PlanId,
  type PlanStepId,
  type PollId,
  type ReminderFiringId,
  type ReminderId,
  StorageError,
} from '@comvivo/shared';
import { and, asc, desc, eq, inArray, isNotNull, lte, type SQL, sql } from 'drizzle-orm';
import type { Temporal } from 'temporal-polyfill';
import { type Db, exactlyOne, maybeOne, type Patch } from '../db/drizzle.js';
import { isUniqueViolation } from '../db/errors.js';
import type { LabelStore } from '../ifc/label-store.js';
import {
  decisions,
  planSteps,
  plans,
  pollCounts,
  polls,
  pollVotes,
  reminderFirings,
  reminders,
} from '../schema/index.js';
import { after } from './lists.js';
import { toDecision, toPlan, toPlanStep, toPoll, toReminder, toReminderFiring } from './rows.js';

/* ───────────────────────────────── Polls ───────────────────────────────── */

export class SqlitePollRepository implements PollReader, PollRepository {
  readonly #db: Db;
  readonly #labels: LabelStore;

  constructor(db: Db, labels: LabelStore) {
    this.#db = db;
    this.#labels = labels;
  }

  byId(groupId: GroupId, id: PollId, eligible: EligibleLabelSet): Poll | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(polls)
        .where(and(eq(polls.groupId, groupId), eq(polls.id, id), pollEligible(eligible))),
    );
    return row === undefined ? undefined : toPoll(row);
  }

  /** Q-COO-4, through `polls_open_deadline_idx` — partial on `status = 'open'`. */
  open(query: {
    readonly groupId: GroupId;
    readonly deadlineBefore?: Temporal.Instant | undefined;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly Poll[] {
    if (query.eligible.ids.length === 0) return [];
    const rows = this.#db
      .select()
      .from(polls)
      .where(
        and(
          eq(polls.groupId, query.groupId),
          eq(polls.status, 'open'),
          ...(query.deadlineBefore === undefined
            ? []
            : [and(isNotNull(polls.deadlineAt), lte(polls.deadlineAt, query.deadlineBefore))]),
          pollEligible(query.eligible),
        ),
      )
      // Undeadlined polls last, for the same reason undated tasks sort last: `NULL` sorts first in
      // SQLite, and "what closes soonest" with every open-ended poll at the top is useless.
      .orderBy(sql`${polls.deadlineAt} IS NULL`, asc(polls.deadlineAt), asc(polls.rid))
      .limit(query.limit)
      .all();
    return rows.map(toPoll);
  }

  /**
   * The tallies, from `poll_counts` rather than counted over `poll_votes`.
   *
   * That separation is what makes an **anonymous** poll possible: the counts are readable and the
   * ballots are not, so `07` can show a result without exposing who voted which way. Counting over
   * the votes instead would mean every reader of a tally had read the ballots.
   */
  countsOf(groupId: GroupId, id: PollId): ReadonlyMap<string, number> {
    const row = maybeOne(
      this.#db
        .select({ counts: pollCounts.counts })
        .from(pollCounts)
        .innerJoin(polls, eq(polls.id, pollCounts.pollId))
        .where(and(eq(polls.groupId, groupId), eq(pollCounts.pollId, id))),
    );
    if (row === undefined) return new Map();
    return new Map(Object.entries(row.counts));
  }

  /**
   * Whether this member has voted, without revealing what they chose.
   *
   * A boolean, deliberately: `07` needs it to nudge the people who have not voted, and returning
   * the ballot would make that nudge a disclosure. The row is read through the poll's group so a
   * caller cannot probe another group's turnout.
   */
  hasVoted(groupId: GroupId, id: PollId, memberId: MemberId): boolean {
    const row = maybeOne(
      this.#db
        .select({ pollId: pollVotes.pollId })
        .from(pollVotes)
        .innerJoin(polls, eq(polls.id, pollVotes.pollId))
        .where(
          and(
            eq(polls.groupId, groupId),
            eq(pollVotes.pollId, id),
            eq(pollVotes.memberId, memberId),
          ),
        ),
    );
    return row !== undefined;
  }

  create(uow: TxToken, poll: NewPoll, label: Label): WriteResult<Poll> {
    if (label.groupId !== poll.groupId) throw crossGroup('poll');
    const labelId = this.#labels.intern(uow, label);
    try {
      const row = exactlyOne(
        this.#db
          .insert(polls)
          .values({
            id: poll.id,
            groupId: poll.groupId,
            conversationId: poll.conversationId,
            purpose: poll.purpose,
            proposalId: poll.proposalId,
            question: poll.question,
            options: poll.options,
            allowMultiple: poll.allowMultiple ?? false,
            rule: poll.rule,
            quorum: poll.quorum,
            eligibleMemberIds: [...(poll.eligibleMemberIds ?? [])],
            anonymous: poll.anonymous ?? false,
            resultsVisibility: poll.resultsVisibility ?? 'live',
            mode: poll.mode,
            deadlineAt: poll.deadlineAt,
            planStepId: poll.planStepId,
            labelId,
            createdByMemberId: poll.createdByMemberId,
            createdAt: uow.now,
          })
          .returning(),
        'the poll',
      );
      // An empty tally from the start, so `countsOf` never has to distinguish "no votes" from "no
      // row" — and `07` can render a fresh poll without a special case.
      this.#db
        .insert(pollCounts)
        .values({ pollId: poll.id, counts: {}, voterCount: 0, observedAt: uow.now })
        .onConflictDoNothing()
        .run();
      return writeOk(toPoll(row));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return duplicate(poll.id);
    }
  }

  /**
   * Record a vote, replacing this member's previous one and moving the tally with it.
   *
   * The counts are recomputed from the ballots inside this transaction rather than incremented:
   * an increment has to know what the member voted *before*, and a replaced multi-option ballot
   * makes that two sets to diff. Recomputing is O(voters) on a poll with at most a group's worth
   * of them, and it cannot drift.
   */
  vote(
    uow: TxToken,
    groupId: GroupId,
    id: PollId,
    memberId: MemberId,
    optionIds: readonly string[],
    at: Temporal.Instant,
  ): WriteResult<void> {
    const poll = this.#pollRow(groupId, id);
    if (poll === undefined) return notFound();
    if (poll.status !== 'open') return writeConflict();
    if (!poll.allowMultiple && optionIds.length > 1) {
      throw new StorageError('STORAGE_CONSTRAINT', 'this poll takes a single choice', {
        hint: 'This is a bug in the caller: check `allowMultiple` before offering several options.',
        category: 'bug',
      });
    }
    const known = new Set(poll.options.map((option) => option.id));
    for (const optionId of optionIds) {
      if (!known.has(optionId)) {
        throw new StorageError('STORAGE_CONSTRAINT', `no such option: ${optionId}`, {
          hint: "This is a bug in the caller: the option ids come from the poll's own options.",
          category: 'bug',
        });
      }
    }

    this.#db
      .insert(pollVotes)
      .values({
        pollId: id,
        memberId,
        optionIds: [...optionIds],
        source: 'native',
        labelId: poll.labelId,
        castAt: at,
      })
      // One row per `(poll, member)`: `07` lets a member change their mind, and two rows for one
      // member would double-count in the tally.
      .onConflictDoUpdate({
        target: [pollVotes.pollId, pollVotes.memberId],
        set: { optionIds: [...optionIds], castAt: at },
      })
      .run();
    this.#recount(uow, id);
    return writeOk(undefined);
  }

  close(
    uow: TxToken,
    groupId: GroupId,
    id: PollId,
    expectVersion: number,
    outcome: PollOutcome,
    at: Temporal.Instant,
  ): WriteResult<Poll> {
    return this.#versionedUpdate(uow, groupId, id, expectVersion, {
      status: 'closed',
      outcome,
      closedAt: at,
    });
  }

  cancel(
    uow: TxToken,
    groupId: GroupId,
    id: PollId,
    expectVersion: number,
    at: Temporal.Instant,
  ): WriteResult<Poll> {
    return this.#versionedUpdate(uow, groupId, id, expectVersion, {
      status: 'cancelled',
      closedAt: at,
    });
  }

  /** Recompute the tally from the ballots, in the caller's transaction. */
  #recount(uow: TxToken, id: PollId): void {
    const ballots = this.#db
      .select({ optionIds: pollVotes.optionIds })
      .from(pollVotes)
      .where(eq(pollVotes.pollId, id))
      .all();
    const counts: Record<string, number> = {};
    for (const ballot of ballots) {
      for (const optionId of ballot.optionIds) {
        counts[optionId] = (counts[optionId] ?? 0) + 1;
      }
    }
    this.#db
      .insert(pollCounts)
      // `voter_count` is the number of **members** who voted, which differs from the sum of the
      // counts whenever `allowMultiple` is on — and it is what a quorum is measured against.
      .values({ pollId: id, counts, voterCount: ballots.length, observedAt: uow.now })
      .onConflictDoUpdate({
        target: [pollCounts.pollId],
        set: { counts, voterCount: ballots.length, observedAt: uow.now },
      })
      .run();
  }

  #pollRow(groupId: GroupId, id: PollId): typeof polls.$inferSelect | undefined {
    return maybeOne(
      this.#db
        .select()
        .from(polls)
        .where(and(eq(polls.groupId, groupId), eq(polls.id, id))),
    );
  }

  #versionedUpdate(
    _uow: TxToken,
    groupId: GroupId,
    id: PollId,
    expectVersion: number,
    patch: Patch<typeof polls.$inferInsert>,
  ): WriteResult<Poll> {
    const row = maybeOne(
      this.#db
        .update(polls)
        .set({ ...patch, version: expectVersion + 1 })
        .where(and(eq(polls.groupId, groupId), eq(polls.id, id), eq(polls.version, expectVersion)))
        .returning(),
    );
    if (row !== undefined) return writeOk(toPoll(row));
    return this.#pollRow(groupId, id) === undefined ? notFound() : writeConflict();
  }
}

/* ───────────────────────────────── Plans ───────────────────────────────── */

export class SqlitePlanRepository implements PlanReader, PlanRepository {
  readonly #db: Db;
  readonly #labels: LabelStore;

  constructor(db: Db, labels: LabelStore) {
    this.#db = db;
    this.#labels = labels;
  }

  byId(groupId: GroupId, id: PlanId, eligible: EligibleLabelSet): Plan | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(plans)
        .where(and(eq(plans.groupId, groupId), eq(plans.id, id), planEligible(eligible))),
    );
    return row === undefined ? undefined : toPlan(row);
  }

  /** Through `plans_group_status_idx`. */
  byStatus(query: {
    readonly groupId: GroupId;
    readonly status?: PlanStatus | 'active_like' | undefined;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly Plan[] {
    if (query.eligible.ids.length === 0) return [];
    const status = query.status ?? 'active_like';
    const rows = this.#db
      .select()
      .from(plans)
      .where(
        and(
          eq(plans.groupId, query.groupId),
          status === 'active_like'
            ? inArray(plans.status, ['draft', 'active'])
            : eq(plans.status, status),
          planEligible(query.eligible),
        ),
      )
      .orderBy(desc(plans.updatedAt), asc(plans.rid))
      .limit(query.limit)
      .all();
    return rows.map(toPlan);
  }

  /**
   * A plan's steps in order, through `plan_steps_plan_idx`.
   *
   * The **plan's** eligibility decides, not the step's: `02` §3.3.5 gives `plan_steps` no
   * `label_id` at all, and that is what makes a surprise party coherent — the plan's `secrecy`
   * decides who may read it, and a step with an independent label could be readable by someone the
   * plan is hidden from. So this reads the plan first and returns nothing if it is not eligible.
   */
  stepsOf(groupId: GroupId, planId: PlanId, eligible: EligibleLabelSet): readonly PlanStep[] {
    if (this.byId(groupId, planId, eligible) === undefined) return [];
    const rows = this.#db
      .select()
      .from(planSteps)
      .where(and(eq(planSteps.groupId, groupId), eq(planSteps.planId, planId)))
      .orderBy(asc(planSteps.position))
      .all();
    return rows.map(toPlanStep);
  }

  create(uow: TxToken, plan: NewPlan, label: Label): WriteResult<Plan> {
    if (label.groupId !== plan.groupId) throw crossGroup('plan');
    const labelId = this.#labels.intern(uow, label);
    try {
      const row = exactlyOne(
        this.#db
          .insert(plans)
          .values({
            id: plan.id,
            groupId: plan.groupId,
            kind: plan.kind ?? 'generic',
            title: plan.title,
            description: plan.description,
            ownerMemberIds: [...(plan.ownerMemberIds ?? [])],
            status: plan.status ?? 'draft',
            secrecy: plan.secrecy,
            tz: plan.tz,
            startsOn: plan.startsOn,
            endsOn: plan.endsOn,
            budgetNotes: plan.budgetNotes ?? [],
            assumptions: [...(plan.assumptions ?? [])],
            labelId,
            createdByMemberId: plan.createdByMemberId,
            createdAt: uow.now,
            updatedAt: uow.now,
          })
          .returning(),
        'the plan',
      );
      return writeOk(toPlan(row));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return duplicate(plan.id);
    }
  }

  addStep(uow: TxToken, step: NewPlanStep, _label: Label): WriteResult<PlanStep> {
    // The plan has to be in this group, and the step takes the plan's label by having none of its
    // own — so the `label` argument is accepted for signature symmetry and deliberately unused.
    const plan = maybeOne(
      this.#db
        .select({ id: plans.id })
        .from(plans)
        .where(and(eq(plans.groupId, step.groupId), eq(plans.id, step.planId))),
    );
    if (plan === undefined) return notFound();
    const position = step.position ?? this.#appendPosition(step.planId);
    try {
      const row = exactlyOne(
        this.#db
          .insert(planSteps)
          .values({
            id: step.id,
            planId: step.planId,
            groupId: step.groupId,
            position,
            title: step.title,
            ownerMemberIds: [...(step.ownerMemberIds ?? [])],
            status: step.status ?? 'todo',
            confirmState: step.confirmState ?? 'proposed',
            due: step.due,
            dueAt: step.dueAt,
            dependsOn: [...(step.dependsOn ?? [])],
            links: step.links ?? {},
            lastActivityAt: uow.now,
            createdAt: uow.now,
            updatedAt: uow.now,
          })
          .returning(),
        'the plan step',
      );
      return writeOk(toPlanStep(row));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return duplicate(step.id);
    }
  }

  setStepStatus(
    uow: TxToken,
    groupId: GroupId,
    id: PlanStepId,
    expectVersion: number,
    status: PlanStepStatus,
  ): WriteResult<PlanStep> {
    return this.#versionedStepUpdate(uow, groupId, id, expectVersion, { status });
  }

  confirmStep(
    uow: TxToken,
    groupId: GroupId,
    id: PlanStepId,
    expectVersion: number,
  ): WriteResult<PlanStep> {
    return this.#versionedStepUpdate(uow, groupId, id, expectVersion, {
      confirmState: 'confirmed',
    });
  }

  setStatus(
    uow: TxToken,
    groupId: GroupId,
    id: PlanId,
    expectVersion: number,
    status: PlanStatus,
  ): WriteResult<Plan> {
    const row = maybeOne(
      this.#db
        .update(plans)
        .set({ status, updatedAt: uow.now, version: expectVersion + 1 })
        .where(and(eq(plans.groupId, groupId), eq(plans.id, id), eq(plans.version, expectVersion)))
        .returning(),
    );
    if (row !== undefined) return writeOk(toPlan(row));
    const exists = maybeOne(
      this.#db
        .select({ id: plans.id })
        .from(plans)
        .where(and(eq(plans.groupId, groupId), eq(plans.id, id))),
    );
    return exists === undefined ? notFound() : writeConflict();
  }

  #appendPosition(planId: PlanId): string {
    const last = maybeOne(
      this.#db
        .select({ position: planSteps.position })
        .from(planSteps)
        .where(eq(planSteps.planId, planId))
        .orderBy(desc(planSteps.position)),
    );
    // The same fractional-index arithmetic as a list, and the same reason for `after` rather than
    // a midpoint against an open end: appending must not grow the string.
    return last === undefined ? 'V' : after(last.position);
  }

  #versionedStepUpdate(
    uow: TxToken,
    groupId: GroupId,
    id: PlanStepId,
    expectVersion: number,
    patch: Patch<typeof planSteps.$inferInsert>,
  ): WriteResult<PlanStep> {
    const row = maybeOne(
      this.#db
        .update(planSteps)
        // `last_activity_at` moves on every change, because `07` nudges a stalled step from it —
        // a step that had never moved would otherwise look the same as one that moved long ago.
        .set({ ...patch, lastActivityAt: uow.now, updatedAt: uow.now, version: expectVersion + 1 })
        .where(
          and(
            eq(planSteps.groupId, groupId),
            eq(planSteps.id, id),
            eq(planSteps.version, expectVersion),
          ),
        )
        .returning(),
    );
    if (row !== undefined) return writeOk(toPlanStep(row));
    const exists = maybeOne(
      this.#db
        .select({ id: planSteps.id })
        .from(planSteps)
        .where(and(eq(planSteps.groupId, groupId), eq(planSteps.id, id))),
    );
    return exists === undefined ? notFound() : writeConflict();
  }
}

/* ─────────────────────────────── Decisions ─────────────────────────────── */

export class SqliteDecisionRepository implements DecisionReader, DecisionRepository {
  readonly #db: Db;
  readonly #labels: LabelStore;

  constructor(db: Db, labels: LabelStore) {
    this.#db = db;
    this.#labels = labels;
  }

  byId(groupId: GroupId, id: DecisionId, eligible: EligibleLabelSet): Decision | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(decisions)
        .where(
          and(eq(decisions.groupId, groupId), eq(decisions.id, id), decisionEligible(eligible)),
        ),
    );
    return row === undefined ? undefined : toDecision(row);
  }

  /** Q-COO-5, through `decisions_group_decided_idx`: the log, newest first. */
  log(query: {
    readonly groupId: GroupId;
    readonly since?: Temporal.Instant | undefined;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly Decision[] {
    if (query.eligible.ids.length === 0) return [];
    const rows = this.#db
      .select()
      .from(decisions)
      .where(
        and(
          eq(decisions.groupId, query.groupId),
          // Retracted decisions leave the log: a decision the group took back is not part of the
          // record of what they decided. Superseded ones stay, because "what did we decide then"
          // is a question the log exists to answer.
          sql`${decisions.status} <> 'retracted'`,
          ...(query.since === undefined
            ? []
            : [sql`${decisions.decidedAt} >= ${query.since.epochMilliseconds}`]),
          decisionEligible(query.eligible),
        ),
      )
      .orderBy(desc(decisions.decidedAt), desc(decisions.rid))
      .limit(query.limit)
      .all();
    return rows.map(toDecision);
  }

  record(uow: TxToken, decision: NewDecision, label: Label): WriteResult<Decision> {
    if (label.groupId !== decision.groupId) throw crossGroup('decision');
    const labelId = this.#labels.intern(uow, label);
    try {
      const row = exactlyOne(
        this.#db
          .insert(decisions)
          .values({
            id: decision.id,
            groupId: decision.groupId,
            summary: decision.summary,
            rationale: decision.rationale,
            topicTags: [...(decision.topicTags ?? [])],
            decidedBy: decision.decidedBy,
            alternativesRejected: decision.alternativesRejected ?? [],
            sourceRefs: decision.sourceRefs ?? [],
            origin: decision.origin,
            supersedesId: decision.supersedesId,
            labelId,
            memoryItemId: decision.memoryItemId,
            proposalId: decision.proposalId,
            decidedAt: decision.decidedAt,
            decidedTz: decision.decidedTz,
            createdAt: uow.now,
          })
          .returning(),
        'the decision',
      );
      return writeOk(toDecision(row));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // `decisions_memory_uq` is the `04` §3.4.6 mirror's idempotency: a re-run finds the decision
      // it already made rather than mirroring twice.
      const existing =
        decision.memoryItemId === undefined
          ? undefined
          : maybeOne(
              this.#db
                .select({ id: decisions.id })
                .from(decisions)
                .where(eq(decisions.memoryItemId, decision.memoryItemId)),
            );
      return duplicate(existing?.id ?? decision.id);
    }
  }

  supersede(
    uow: TxToken,
    groupId: GroupId,
    oldId: DecisionId,
    expectVersion: number,
    next: NewDecision,
    label: Label,
  ): WriteResult<Decision> {
    const old = maybeOne(
      this.#db
        .select()
        .from(decisions)
        .where(and(eq(decisions.groupId, groupId), eq(decisions.id, oldId))),
    );
    if (old === undefined) return notFound();
    if (old.version !== expectVersion) return writeConflict();

    const recorded = this.record(uow, { ...next, supersedesId: oldId }, label);
    if (recorded.kind !== 'ok') return recorded;
    this.#db
      .update(decisions)
      .set({ status: 'superseded', supersededById: recorded.value.id, version: expectVersion + 1 })
      .where(and(eq(decisions.groupId, groupId), eq(decisions.id, oldId)))
      .run();
    return recorded;
  }

  retract(
    _uow: TxToken,
    groupId: GroupId,
    id: DecisionId,
    expectVersion: number,
  ): WriteResult<Decision> {
    const row = maybeOne(
      this.#db
        .update(decisions)
        .set({ status: 'retracted', version: expectVersion + 1 })
        .where(
          and(
            eq(decisions.groupId, groupId),
            eq(decisions.id, id),
            eq(decisions.version, expectVersion),
          ),
        )
        .returning(),
    );
    if (row !== undefined) return writeOk(toDecision(row));
    const exists = maybeOne(
      this.#db
        .select({ id: decisions.id })
        .from(decisions)
        .where(and(eq(decisions.groupId, groupId), eq(decisions.id, id))),
    );
    return exists === undefined ? notFound() : writeConflict();
  }
}

/* ─────────────────────────────── Reminders ─────────────────────────────── */

export class SqliteReminderRepository implements ReminderReader, ReminderRepository {
  readonly #db: Db;
  readonly #labels: LabelStore;

  constructor(db: Db, labels: LabelStore) {
    this.#db = db;
    this.#labels = labels;
  }

  byId(groupId: GroupId, id: ReminderId, eligible: EligibleLabelSet): Reminder | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(reminders)
        .where(
          and(eq(reminders.groupId, groupId), eq(reminders.id, id), reminderEligible(eligible)),
        ),
    );
    return row === undefined ? undefined : toReminder(row);
  }

  /**
   * Q-COO-1, through `reminders_due_idx` — `(group_id, next_fire_at)` partial on the live statuses.
   *
   * Group-scoped because the index leads with the group: see the port's note. **Not
   * label-filtered**, and that is the deliberate part — the scheduler is not an audience. It
   * decides *when* to fire; `07` decides what the firing says and to whom, using the reminder's
   * own `recipients` and `audience_reader_set_id`. Filtering here would mean a reminder stopped
   * firing because the scheduler could not read it.
   *
   * A **snoozed** reminder is due at `snoozed_until`, not at `next_fire_at`, which is why the
   * predicate takes the later of the two.
   */
  due(groupId: GroupId, at: Temporal.Instant, limit: number): readonly Reminder[] {
    const rows = this.#db
      .select()
      .from(reminders)
      .where(
        and(
          eq(reminders.groupId, groupId),
          inArray(reminders.status, ['scheduled', 'snoozed']),
          isNotNull(reminders.nextFireAt),
          lte(reminders.nextFireAt, at),
          // Snooze wins: a snoozed reminder must not fire on its original time.
          sql`(${reminders.snoozedUntil} IS NULL OR ${reminders.snoozedUntil} <= ${at.epochMilliseconds})`,
        ),
      )
      .orderBy(asc(reminders.nextFireAt), asc(reminders.id))
      .limit(limit)
      .all();
    return rows.map(toReminder);
  }

  /** Q-COO-2, through `reminders_about_idx`: what reminds about this event or task. */
  about(groupId: GroupId, aboutRef: string, eligible: EligibleLabelSet): readonly Reminder[] {
    if (eligible.ids.length === 0) return [];
    const rows = this.#db
      .select()
      .from(reminders)
      .where(
        and(
          eq(reminders.groupId, groupId),
          eq(reminders.aboutRef, aboutRef),
          reminderEligible(eligible),
        ),
      )
      .orderBy(asc(reminders.id))
      .all();
    return rows.map(toReminder);
  }

  firingsOf(groupId: GroupId, id: ReminderId, limit: number): readonly ReminderFiring[] {
    const rows = this.#db
      .select()
      .from(reminderFirings)
      .where(and(eq(reminderFirings.groupId, groupId), eq(reminderFirings.reminderId, id)))
      .orderBy(desc(reminderFirings.firedAt), desc(reminderFirings.id))
      .limit(limit)
      .all();
    return rows.map(toReminderFiring);
  }

  create(uow: TxToken, reminder: NewReminder, label: Label): WriteResult<Reminder> {
    if (label.groupId !== reminder.groupId) throw crossGroup('reminder');
    const labelId = this.#labels.intern(uow, label);
    try {
      const row = exactlyOne(
        this.#db
          .insert(reminders)
          .values({
            id: reminder.id,
            groupId: reminder.groupId,
            kind: reminder.kind,
            text: reminder.text,
            recipients: reminder.recipients,
            delivery: reminder.delivery,
            schedule: reminder.schedule,
            anchor: reminder.anchor,
            aboutRef: reminder.aboutRef,
            audienceReaderSetId: reminder.audienceReaderSetId,
            labelId,
            createdByMemberId: reminder.createdByMemberId,
            nextFireAt: reminder.nextFireAt,
            staleAfter: reminder.staleAfter,
            tzdataVersion: reminder.tzdataVersion,
            createdAt: uow.now,
            updatedAt: uow.now,
          })
          .returning(),
        'the reminder',
      );
      return writeOk(toReminder(row));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return duplicate(reminder.id);
    }
  }

  /**
   * Record a firing and advance the schedule, in one transaction.
   *
   * **`I6` for reminders.** `reminder_firings_occurrence_uq` on `(reminder, occurrence_key)` is
   * what makes a firing exactly-once: the scheduler can run twice for one occurrence — after a
   * crash, or on two workers — and the second insert loses. The guarantee is the index's, not the
   * scheduler's, which is the point: a scheduler that remembered would forget on restart.
   *
   * `nextFireAt` of `null` means the series is finished, and the status moves with it — a
   * reminder with no next time and a `scheduled` status would sit in the due index forever,
   * matching nothing and costing a row on every sweep.
   */
  recordFiring(
    uow: TxToken,
    firing: {
      readonly id: ReminderFiringId;
      readonly reminderId: ReminderId;
      readonly groupId: GroupId;
      readonly occurrenceKey: string;
      readonly scheduledFor: Temporal.Instant;
      readonly firedAt: Temporal.Instant;
      readonly outcome: ReminderFiring['outcome'];
      readonly outboxIds?: readonly OutboxId[] | undefined;
    },
    nextFireAt: Temporal.Instant | null,
  ): WriteResult<ReminderFiring> {
    const reminder = maybeOne(
      this.#db
        .select({ id: reminders.id, version: reminders.version })
        .from(reminders)
        .where(and(eq(reminders.groupId, firing.groupId), eq(reminders.id, firing.reminderId))),
    );
    if (reminder === undefined) return notFound();

    let row: typeof reminderFirings.$inferSelect | undefined;
    try {
      row = exactlyOne(
        this.#db
          .insert(reminderFirings)
          .values({
            id: firing.id,
            reminderId: firing.reminderId,
            groupId: firing.groupId,
            occurrenceKey: firing.occurrenceKey,
            scheduledFor: firing.scheduledFor,
            firedAt: firing.firedAt,
            outcome: firing.outcome,
            outboxIds: [...(firing.outboxIds ?? [])],
          })
          .returning(),
        'the reminder firing',
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = maybeOne(
        this.#db
          .select({ id: reminderFirings.id })
          .from(reminderFirings)
          .where(
            and(
              eq(reminderFirings.reminderId, firing.reminderId),
              eq(reminderFirings.occurrenceKey, firing.occurrenceKey),
            ),
          ),
      );
      return duplicate(existing?.id ?? firing.id);
    }

    this.#db
      .update(reminders)
      .set({
        nextFireAt,
        // A fired occurrence clears the snooze: it was a deferral of *this* occurrence, and
        // leaving it set would suppress the next one too.
        snoozedUntil: null,
        status: nextFireAt === null ? 'completed_series' : 'scheduled',
        updatedAt: uow.now,
      })
      .where(and(eq(reminders.groupId, firing.groupId), eq(reminders.id, firing.reminderId)))
      .run();
    return writeOk(toReminderFiring(row));
  }

  snooze(
    uow: TxToken,
    groupId: GroupId,
    id: ReminderId,
    expectVersion: number,
    until: Temporal.Instant,
  ): WriteResult<Reminder> {
    return this.#versionedUpdate(uow, groupId, id, expectVersion, {
      snoozedUntil: until,
      status: 'snoozed',
    });
  }

  acknowledge(
    _uow: TxToken,
    groupId: GroupId,
    firingId: ReminderFiringId,
    memberId: MemberId,
    at: Temporal.Instant,
  ): WriteResult<ReminderFiring> {
    const row = maybeOne(
      this.#db
        .update(reminderFirings)
        .set({ ackedByMemberId: memberId, ackAt: at })
        .where(and(eq(reminderFirings.groupId, groupId), eq(reminderFirings.id, firingId)))
        .returning(),
    );
    return row === undefined ? notFound() : writeOk(toReminderFiring(row));
  }

  setStatus(
    uow: TxToken,
    groupId: GroupId,
    id: ReminderId,
    expectVersion: number,
    status: ReminderStatus,
  ): WriteResult<Reminder> {
    // Leaving the live statuses clears the next fire time, so a finished reminder does not sit in
    // the due index matching nothing.
    const leaving = status !== 'scheduled' && status !== 'snoozed';
    return this.#versionedUpdate(uow, groupId, id, expectVersion, {
      status,
      ...(leaving ? { nextFireAt: null, snoozedUntil: null } : {}),
    });
  }

  #versionedUpdate(
    uow: TxToken,
    groupId: GroupId,
    id: ReminderId,
    expectVersion: number,
    patch: Patch<typeof reminders.$inferInsert>,
  ): WriteResult<Reminder> {
    const row = maybeOne(
      this.#db
        .update(reminders)
        .set({ ...patch, updatedAt: uow.now, version: expectVersion + 1 })
        .where(
          and(
            eq(reminders.groupId, groupId),
            eq(reminders.id, id),
            eq(reminders.version, expectVersion),
          ),
        )
        .returning(),
    );
    if (row !== undefined) return writeOk(toReminder(row));
    const exists = maybeOne(
      this.#db
        .select({ id: reminders.id })
        .from(reminders)
        .where(and(eq(reminders.groupId, groupId), eq(reminders.id, id))),
    );
    return exists === undefined ? notFound() : writeConflict();
  }
}

/* ───────────────────────────────── Shared ───────────────────────────────── */

function pollEligible(eligible: EligibleLabelSet): SQL {
  if (eligible.ids.length === 0) return sql`1 = 0`;
  return inArray(polls.labelId, [...eligible.ids]);
}

function planEligible(eligible: EligibleLabelSet): SQL {
  if (eligible.ids.length === 0) return sql`1 = 0`;
  return inArray(plans.labelId, [...eligible.ids]);
}

function decisionEligible(eligible: EligibleLabelSet): SQL {
  if (eligible.ids.length === 0) return sql`1 = 0`;
  return inArray(decisions.labelId, [...eligible.ids]);
}

function reminderEligible(eligible: EligibleLabelSet): SQL {
  if (eligible.ids.length === 0) return sql`1 = 0`;
  return inArray(reminders.labelId, [...eligible.ids]);
}

function crossGroup(what: string): StorageError {
  return new StorageError('STORAGE_CONSTRAINT', `the ${what} names a label of another group`, {
    hint: `This is a bug and an I4 violation: intern the label against the ${what}'s own group.`,
    category: 'bug',
  });
}
