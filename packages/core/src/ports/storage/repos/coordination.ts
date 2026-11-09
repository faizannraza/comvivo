/**
 * Ports for the coordination aggregates (`02` §3.7.1, §3.3.5; semantics in `07`).
 *
 * Seven aggregates in one module, because they share one shape and the differences are what matter:
 * each has a `…Reader` on `ReadScope` and a `…Repository` on `UnitOfWork`, every labeled read takes
 * an `EligibleLabelSet`, and every write returns a `WriteResult`. Splitting them into seven files
 * would hide that uniformity behind seven headers saying the same thing.
 *
 * ## The reads here are the ones `02` §3.3.10 names
 *
 * Every method below maps to a catalogued query, and the mapping is in its docstring — because
 * `M1-T19`'s acceptance criterion is that the read model's queries **use those indexes**, proven
 * with `EXPLAIN QUERY PLAN`. A read with no catalogued query behind it is a read whose plan nobody
 * has checked, so there are none.
 *
 * ## Why so few setters
 *
 * `07` owns the state machines — a task goes `proposed → open → done`, a poll `open → closed` —
 * and a repository that exposed a generic `update` would let a caller skip a transition. So each
 * write here is a named transition with the fields that move together: `complete` takes who and
 * when, because a completion without a completer is a row `03`'s fairness ledger cannot charge.
 */
import type {
  CalendarSubscriptionId,
  ConversationId,
  DecisionId,
  EventId,
  GroupId,
  ListId,
  ListItemId,
  MemberId,
  PlanId,
  PlanStepId,
  PollId,
  ReminderFiringId,
  ReminderId,
  RotationId,
  TaskId,
} from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';
import type {
  Event,
  EventAttendee,
  NewEvent,
  RsvpResponse,
} from '../../../coordination/calendar.js';
import type { Decision, NewDecision } from '../../../coordination/decisions.js';
import type { List, ListItem, NewList, NewListItem } from '../../../coordination/lists.js';
import type {
  NewPlan,
  NewPlanStep,
  Plan,
  PlanStatus,
  PlanStep,
  PlanStepStatus,
} from '../../../coordination/plans.js';
import type { NewPoll, Poll, PollOutcome } from '../../../coordination/polls.js';
import type {
  NewReminder,
  Reminder,
  ReminderFiring,
  ReminderStatus,
} from '../../../coordination/reminders.js';
import type { NewTask, Task, TaskStatus } from '../../../coordination/tasks.js';
import type { EligibleLabelSet, Label } from '../../../ifc/eligible.js';
import type { TxToken, WriteResult } from '../uow.js';

/* ───────────────────────────── Calendar (Q-CTX-6, Q-COO-6) ───────────────────────────── */

export interface CalendarReader {
  byId(groupId: GroupId, id: EventId, eligible: EligibleLabelSet): Event | undefined;
  /**
   * Q-CTX-6: one-off events starting in a window, through `events_group_start_idx`.
   *
   * **One-off only.** A recurring event is one row whose `start_at` is its *first* occurrence, so
   * a range scan would miss a weekly dinner that started last year — which is why `02` §3.3.10
   * splits this into 6 and 6b. `07` expands the series from `activeSeries` and merges.
   */
  upcomingOneOff(query: {
    readonly groupId: GroupId;
    readonly from: Temporal.Instant;
    readonly to: Temporal.Instant;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly Event[];
  /** Q-CTX-6b: recurring series still live at an instant, through `events_group_recurring_idx`. */
  activeSeries(query: {
    readonly groupId: GroupId;
    readonly at: Temporal.Instant;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly Event[];
  /** Every row of a series, including splits, through `events_series_idx`. */
  bySeries(groupId: GroupId, seriesId: EventId, eligible: EligibleLabelSet): readonly Event[];
  /** Q-COO-6: a subscription feed's row for a UID, for diffing an ICS import. */
  bySourceUid(query: {
    readonly subscriptionId: CalendarSubscriptionId;
    readonly sourceUid: string;
    readonly sourceRecurrenceId?: string | undefined;
  }): Event | undefined;
  attendeesOf(groupId: GroupId, id: EventId): readonly EventAttendee[];
}

export interface CalendarRepository {
  create(uow: TxToken, event: NewEvent, label: Label): WriteResult<Event>;
  /**
   * Edit one occurrence by **splitting** it out of its series.
   *
   * A new row that keeps the `seriesId` and records `splitFromEventId`, so "move this week's
   * dinner" does not rewrite the series and the series can still be found. Returns the new row.
   */
  splitOccurrence(
    uow: TxToken,
    groupId: GroupId,
    seriesId: EventId,
    expectVersion: number,
    occurrence: NewEvent,
    label: Label,
  ): WriteResult<Event>;
  setStatus(
    uow: TxToken,
    groupId: GroupId,
    id: EventId,
    expectVersion: number,
    status: Event['status'],
  ): WriteResult<Event>;
  /**
   * Mark a stored `rrule` unparseable.
   *
   * Unversioned and separate, because it is something *we* discovered rather than something a
   * member changed: `07` meets the bad rule while expanding, and the right response is to record
   * it and degrade rather than to fail the expansion. Versioning it would make the recording
   * conflict with whatever edit produced the bad rule.
   */
  markRruleInvalid(uow: TxToken, groupId: GroupId, id: EventId): WriteResult<Event>;
  setRsvp(
    uow: TxToken,
    groupId: GroupId,
    id: EventId,
    memberId: MemberId,
    response: RsvpResponse,
    at: Temporal.Instant,
  ): WriteResult<EventAttendee>;
}

/* ───────────────────────────── Tasks (Q-CTX-7, Q-FAIR-1) ───────────────────────────── */

export interface TaskReader {
  byId(groupId: GroupId, id: TaskId, eligible: EligibleLabelSet): Task | undefined;
  /** Q-CTX-7: open tasks by due date, through `tasks_open_due_idx`. */
  openByDue(query: {
    readonly groupId: GroupId;
    readonly dueBefore?: Temporal.Instant | undefined;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly Task[];
  /** Q-CTX-7b / Q-FAIR-1: a member's tasks, through `tasks_assignee_idx`. */
  byAssignee(query: {
    readonly groupId: GroupId;
    readonly assigneeMemberId: MemberId;
    readonly status?: TaskStatus | 'open_like' | undefined;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly Task[];
  /** The rotation's task for one turn, through `tasks_rotation_occurrence_uq`. */
  byOccurrence(groupId: GroupId, rotationId: RotationId, occurrenceKey: string): Task | undefined;
}

export interface TaskRepository {
  create(uow: TxToken, task: NewTask, label: Label): WriteResult<Task>;
  /**
   * Assign, claim or unassign.
   *
   * `assignmentState` travels with the assignee because `03`'s fairness rules read it: a rotation
   * assignment is owed back if it is swapped away and a volunteered one is not, so a write that
   * moved the assignee without the state would make the ledger wrong in a way nothing detects.
   */
  assign(
    uow: TxToken,
    groupId: GroupId,
    id: TaskId,
    expectVersion: number,
    assignment: {
      readonly assigneeMemberId: MemberId | null;
      readonly assignmentState: Task['assignmentState'];
    },
  ): WriteResult<Task>;
  /**
   * Complete a task.
   *
   * `completedByMemberId` is required, not optional: `03`'s ledger charges the completer, and a
   * completion with nobody named is a row the ledger cannot post — so it would silently not count.
   */
  complete(
    uow: TxToken,
    groupId: GroupId,
    id: TaskId,
    expectVersion: number,
    completion: {
      readonly completedByMemberId: MemberId;
      readonly at: Temporal.Instant;
      readonly verifiedByMemberId?: MemberId | undefined;
    },
  ): WriteResult<Task>;
  setStatus(
    uow: TxToken,
    groupId: GroupId,
    id: TaskId,
    expectVersion: number,
    status: TaskStatus,
  ): WriteResult<Task>;
  /** `07`'s nudge count, which decides when to stop nudging. */
  recordNudge(uow: TxToken, groupId: GroupId, id: TaskId): WriteResult<Task>;
}

/* ───────────────────────────── Lists (Q-COO-3) ───────────────────────────── */

export interface ListReader {
  byId(groupId: GroupId, id: ListId, eligible: EligibleLabelSet): List | undefined;
  /** The list `07` adds to when nobody named one, through `lists_default_kind_uq`. */
  defaultFor(groupId: GroupId, kind: List['kind'], eligible: EligibleLabelSet): List | undefined;
  active(groupId: GroupId, eligible: EligibleLabelSet): readonly List[];
  /** Q-COO-3: a list's items, unchecked first, through `list_items_list_idx`. */
  itemsOf(query: {
    readonly groupId: GroupId;
    readonly listId: ListId;
    readonly includeChecked?: boolean | undefined;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly ListItem[];
  /** An existing item with the same normalised key, through `list_items_key_idx`. */
  itemByKey(groupId: GroupId, listId: ListId, normalizedKey: string): ListItem | undefined;
}

export interface ListRepository {
  create(uow: TxToken, list: NewList, label: Label): WriteResult<List>;
  addItem(uow: TxToken, item: NewListItem, label: Label): WriteResult<ListItem>;
  /**
   * Check or uncheck an item.
   *
   * Takes `at` and the member, because `07` renders "checked by Ana, ten minutes ago" and because
   * unchecking has to clear both — a stale `checkedBy` on an unchecked item would attribute a
   * check that was undone.
   */
  setChecked(
    uow: TxToken,
    groupId: GroupId,
    id: ListItemId,
    expectVersion: number,
    checked: {
      readonly checked: boolean;
      readonly memberId: MemberId;
      readonly at: Temporal.Instant;
    },
  ): WriteResult<ListItem>;
  /** Move an item between neighbours. `position` is a fractional index, so this is one update. */
  moveItem(
    uow: TxToken,
    groupId: GroupId,
    id: ListItemId,
    expectVersion: number,
    position: string,
  ): WriteResult<ListItem>;
  removeItem(uow: TxToken, groupId: GroupId, id: ListItemId): WriteResult<void>;
  archive(
    uow: TxToken,
    groupId: GroupId,
    id: ListId,
    expectVersion: number,
    at: Temporal.Instant,
  ): WriteResult<List>;
}

/* ───────────────────────────── Polls (Q-COO-4) ───────────────────────────── */

export interface PollReader {
  byId(groupId: GroupId, id: PollId, eligible: EligibleLabelSet): Poll | undefined;
  /** Q-COO-4: open polls by deadline, through `polls_open_deadline_idx`. */
  open(query: {
    readonly groupId: GroupId;
    readonly deadlineBefore?: Temporal.Instant | undefined;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly Poll[];
  /**
   * The tallies, which are a table rather than a count over votes.
   *
   * `poll_counts` exists so a result can be shown without reading the votes — which is what makes
   * an **anonymous** poll possible: the counts are readable and the ballots are not.
   */
  countsOf(groupId: GroupId, id: PollId): ReadonlyMap<string, number>;
  /** Whether this member has voted, without revealing what they chose. */
  hasVoted(groupId: GroupId, id: PollId, memberId: MemberId): boolean;
}

export interface PollRepository {
  create(uow: TxToken, poll: NewPoll, label: Label): WriteResult<Poll>;
  /**
   * Record a vote, replacing this member's previous one.
   *
   * Replacing rather than appending: `07` lets a member change their mind, and two rows for one
   * member would double-count in `poll_counts`. The counts move in the same transaction, so a
   * tally can never disagree with the ballots it came from.
   */
  vote(
    uow: TxToken,
    groupId: GroupId,
    id: PollId,
    memberId: MemberId,
    optionIds: readonly string[],
    at: Temporal.Instant,
  ): WriteResult<void>;
  close(
    uow: TxToken,
    groupId: GroupId,
    id: PollId,
    expectVersion: number,
    outcome: PollOutcome,
    at: Temporal.Instant,
  ): WriteResult<Poll>;
  cancel(
    uow: TxToken,
    groupId: GroupId,
    id: PollId,
    expectVersion: number,
    at: Temporal.Instant,
  ): WriteResult<Poll>;
}

/* ───────────────────────────── Plans ───────────────────────────── */

export interface PlanReader {
  byId(groupId: GroupId, id: PlanId, eligible: EligibleLabelSet): Plan | undefined;
  /** Through `plans_group_status_idx`. */
  byStatus(query: {
    readonly groupId: GroupId;
    readonly status?: PlanStatus | 'active_like' | undefined;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly Plan[];
  /** A plan's steps in order, through `plan_steps_plan_idx`. */
  stepsOf(groupId: GroupId, planId: PlanId, eligible: EligibleLabelSet): readonly PlanStep[];
}

export interface PlanRepository {
  create(uow: TxToken, plan: NewPlan, label: Label): WriteResult<Plan>;
  addStep(uow: TxToken, step: NewPlanStep, label: Label): WriteResult<PlanStep>;
  setStepStatus(
    uow: TxToken,
    groupId: GroupId,
    id: PlanStepId,
    expectVersion: number,
    status: PlanStepStatus,
  ): WriteResult<PlanStep>;
  /** `07`: a step the agent proposed becomes one the group agreed to. */
  confirmStep(
    uow: TxToken,
    groupId: GroupId,
    id: PlanStepId,
    expectVersion: number,
  ): WriteResult<PlanStep>;
  setStatus(
    uow: TxToken,
    groupId: GroupId,
    id: PlanId,
    expectVersion: number,
    status: PlanStatus,
  ): WriteResult<Plan>;
}

/* ───────────────────────────── Decisions (Q-COO-5) ───────────────────────────── */

export interface DecisionReader {
  byId(groupId: GroupId, id: DecisionId, eligible: EligibleLabelSet): Decision | undefined;
  /** Q-COO-5: the decision log, newest first, through `decisions_group_decided_idx`. */
  log(query: {
    readonly groupId: GroupId;
    readonly since?: Temporal.Instant | undefined;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly Decision[];
}

export interface DecisionRepository {
  record(uow: TxToken, decision: NewDecision, label: Label): WriteResult<Decision>;
  /** Like a memory item: superseded rather than edited, so the chain records the change. */
  supersede(
    uow: TxToken,
    groupId: GroupId,
    oldId: DecisionId,
    expectVersion: number,
    next: NewDecision,
    label: Label,
  ): WriteResult<Decision>;
  retract(
    uow: TxToken,
    groupId: GroupId,
    id: DecisionId,
    expectVersion: number,
  ): WriteResult<Decision>;
}

/* ───────────────────────────── Reminders (Q-COO-1) ───────────────────────────── */

export interface ReminderReader {
  byId(groupId: GroupId, id: ReminderId, eligible: EligibleLabelSet): Reminder | undefined;
  /**
   * Q-COO-1: reminders due to fire, through `reminders_due_idx`.
   *
   * **Instance-wide, not group-scoped**, and that is deliberate: the scheduler sweeps every group
   * on one tick, and a per-group sweep would mean one query per group per minute. Not an `I4` hole
   * — the scheduler is not an audience, and it hands each firing to `07` within the firing's own
   * group. Named `dueUnscoped` so the exception is visible at the call site.
   */
  dueUnscoped(at: Temporal.Instant, limit: number): readonly Reminder[];
  /** Q-COO-2: reminders about an event or task, through `reminders_about_idx`. */
  about(groupId: GroupId, aboutRef: string, eligible: EligibleLabelSet): readonly Reminder[];
  firingsOf(groupId: GroupId, id: ReminderId, limit: number): readonly ReminderFiring[];
}

export interface ReminderRepository {
  create(uow: TxToken, reminder: NewReminder, label: Label): WriteResult<Reminder>;
  /**
   * Record a firing and advance the schedule, in one transaction.
   *
   * Returns `duplicate` when `(reminder, occurrenceKey)` already fired — which is **`I6` for
   * reminders**, enforced by `reminder_firings_occurrence_uq` rather than by the scheduler
   * remembering. The scheduler can run twice for one occurrence, after a crash or on two workers,
   * and the second insert loses.
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
      readonly outboxIds?: readonly string[] | undefined;
    },
    nextFireAt: Temporal.Instant | null,
  ): WriteResult<ReminderFiring>;
  snooze(
    uow: TxToken,
    groupId: GroupId,
    id: ReminderId,
    expectVersion: number,
    until: Temporal.Instant,
  ): WriteResult<Reminder>;
  acknowledge(
    uow: TxToken,
    groupId: GroupId,
    firingId: ReminderFiringId,
    memberId: MemberId,
    at: Temporal.Instant,
  ): WriteResult<ReminderFiring>;
  setStatus(
    uow: TxToken,
    groupId: GroupId,
    id: ReminderId,
    expectVersion: number,
    status: ReminderStatus,
  ): WriteResult<Reminder>;
}

/** Narrowing a conversation id is the one thing polls need from outside their own aggregate. */
export type PollConversation = ConversationId;
