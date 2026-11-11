/**
 * Task, rotation and chore JSON columns (`02` §3.3.5; `07` §3.3–§3.4, `03` §3.9.3).
 */
import {
  type GroupId,
  idSchema,
  type LabelId,
  type LedgerEntryId,
  type MemberId,
  type PlanId,
  type PlanStepId,
  type RotationId,
  type TaskId,
  type TimeZoneId,
  timeZoneIdSchema,
  z,
} from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';
import type { RecurringSchedule } from './when.js';

/**
 * `rotations.task_template` (`07` §680): the task a rotation stamps out each turn.
 *
 * A template rather than a prototype row, because the generated tasks differ in assignee and due
 * date and in nothing else — and `03`'s fairness ledger charges `effortPoints` per occurrence, so
 * the points have to live with the rule rather than be re-entered each week.
 */
export const TaskTemplateSchema = z.object({
  title: z.string().min(1).max(200),
  /** `03` §3.9.3 charges these to the assignee's load ledger. */
  effortPoints: z.int().min(0).max(100),
  notes: z.string().max(2000).nullable(),
  proofPolicy: z.enum(['off', 'optional', 'required']),
  /** `07`'s chore catalog id; read by `03` fairness and by `tasks.do_not_assign`. */
  category: z.string().max(80).nullable(),
});

export type TaskTemplate = z.infer<typeof TaskTemplateSchema>;

/**
 * `tasks.due` (`02` §3.3.5).
 *
 * `by_day` is not `at` with a time of midnight, and that is the whole reason for three arms. "Bins
 * out by Tuesday" is done any time on Tuesday; storing it as Tuesday 00:00 makes it overdue all
 * day, which turns `07`'s nudges into a source of false urgency. The derived `due_at` column holds
 * the instant either arm resolves to, and `due_local`/`due_tz` keep the wall-clock original.
 */
export const TaskDueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('at'), zdt: z.string().max(80) }),
  z.object({ kind: z.literal('by_day'), date: z.iso.date(), zone: timeZoneIdSchema }),
]);

export type TaskDue = z.infer<typeof TaskDueSchema>;

/**
 * `rotations.cursor`: where a rotation got to.
 *
 * **Partly inferred.** `07` §680 lists `cursor` among a `Rotation`'s fields without giving its
 * shape, so this is the minimum the three strategies of `02` §3.3.5 provably need:
 * `round_robin` needs the last position it handed out, every strategy needs the last occurrence it
 * generated so `tasks_rotation_occurrence_uq` can stay idempotent, and `least_loaded` needs
 * nothing stored because it reads the ledger. `M7` owns the final shape; the fields here are the
 * ones `02`'s own uniqueness constraint and strategy list imply.
 */
export const RotationCursorSchema = z.object({
  /** Index into the ordered participant list; `-1` before the first assignment. */
  lastPosition: z.int().min(-1).max(10_000),
  /** The last `tasks.occurrence_key` generated, e.g. `2026-W45`. Keeps generation idempotent. */
  lastOccurrenceKey: z.string().max(80).nullable(),
  lastAssignedMemberId: idSchema('mbr').nullable(),
});

export type RotationCursor = z.infer<typeof RotationCursorSchema>;

/* ──────────────────────────── The task aggregate (`02` §3.3.5) ──────────────────────────── */

/** `02` §3.3.5: a `chore` recurs and is charged to `03`'s fairness ledger; a `task` is one-off. */
export const TASK_KINDS = ['task', 'chore'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** `02` §3.3.5's `tasks.status`. */
export const TASK_STATUSES = ['proposed', 'open', 'done', 'skipped', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * `02` §3.3.5's `tasks.assignment_state` (`07` §3.4).
 *
 * How the assignee got there, which `03`'s fairness rules read: a `requested` assignment the
 * member has not answered is not yet work they owe, and a `declined` one has to be re-offered to
 * somebody else rather than silently sitting unassigned.
 *
 * The values are the **column's** (`unassigned`, `requested`, `accepted`, `declined`, `direct`).
 * A first version of this type invented `proposed`/`claimed`/`assigned`/`rotation`, which read
 * plausibly and matched nothing — caught by the compiler at the row mapper, where the column's
 * union and this one met.
 */
export const ASSIGNMENT_STATES = [
  'unassigned',
  'requested',
  'accepted',
  'declined',
  'direct',
] as const;
export type AssignmentState = (typeof ASSIGNMENT_STATES)[number];

/** `02` §3.3.5's `tasks.proof_policy` (`07`: a photo or a confirmation on completion). */
export const PROOF_POLICIES = ['off', 'optional', 'required'] as const;
export type ProofPolicy = (typeof PROOF_POLICIES)[number];

/** A task or chore (`02` §3.3.5; semantics in `07`). */
export interface Task {
  readonly rid: number;
  readonly id: TaskId;
  readonly groupId: GroupId;
  readonly kind: TaskKind;
  readonly title: string;
  readonly notes: string | undefined;
  readonly category: string | undefined;
  readonly assigneeMemberId: MemberId | undefined;
  readonly assignmentState: AssignmentState;
  readonly requestedByMemberId: MemberId | undefined;
  /** `03`'s fairness ledger charges this per completion. */
  readonly effortPoints: number;
  readonly due: TaskDue;
  /** `02` D3's derived instant, for Q-CTX-7's range scan. */
  readonly dueAt: Temporal.Instant | undefined;
  readonly dueTz: TimeZoneId | undefined;
  readonly dueLocal: string | undefined;
  readonly recurrence: RecurringSchedule | undefined;
  readonly rotationId: RotationId | undefined;
  /** One task per rotation turn, keyed so a re-run cannot double-stamp (`tasks_rotation_occurrence_uq`). */
  readonly occurrenceKey: string | undefined;
  readonly proofPolicy: ProofPolicy;
  readonly status: TaskStatus;
  readonly completedAt: Temporal.Instant | undefined;
  readonly completedByMemberId: MemberId | undefined;
  readonly verifiedByMemberId: MemberId | undefined;
  readonly nudgeCount: number;
  readonly planId: PlanId | undefined;
  readonly planStepId: PlanStepId | undefined;
  readonly labelId: LabelId;
  readonly sourceRef: string | undefined;
  readonly createdByMemberId: MemberId | undefined;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
  readonly version: number;
}

/**
 * What a caller supplies to create a task.
 *
 * `dueAt` is supplied alongside `due` for the same reason an event's `startAt` is: `02` D3 derives
 * it, `07` owns the conversion, and the repository stores both. `nudgeCount` and the completion
 * fields are absent because they are outcomes, not inputs.
 */
export interface NewTask {
  readonly id: TaskId;
  readonly groupId: GroupId;
  readonly kind?: TaskKind | undefined;
  readonly title: string;
  readonly notes?: string | undefined;
  readonly category?: string | undefined;
  readonly assigneeMemberId?: MemberId | undefined;
  readonly assignmentState?: AssignmentState | undefined;
  readonly requestedByMemberId?: MemberId | undefined;
  readonly effortPoints?: number | undefined;
  readonly due: TaskDue;
  readonly dueAt?: Temporal.Instant | undefined;
  readonly dueTz?: TimeZoneId | undefined;
  readonly dueLocal?: string | undefined;
  readonly recurrence?: RecurringSchedule | undefined;
  readonly rotationId?: RotationId | undefined;
  readonly occurrenceKey?: string | undefined;
  readonly proofPolicy?: ProofPolicy | undefined;
  readonly status?: TaskStatus | undefined;
  readonly planId?: PlanId | undefined;
  readonly planStepId?: PlanStepId | undefined;
  readonly sourceRef?: string | undefined;
  readonly createdByMemberId?: MemberId | undefined;
}

/**
 * Whether a task is still waiting on someone (`07`, Q-CTX-7).
 *
 * `proposed` counts as open: `07` treats a proposed chore as something the group has not settled,
 * and leaving it out of "what is open" would make a proposal invisible until somebody accepted it
 * — which is exactly when it needs to be visible.
 */
export function isOpenTask(task: Pick<Task, 'status'>): boolean {
  return task.status === 'open' || task.status === 'proposed';
}

/**
 * Whether completing this task should charge `03`'s fairness ledger.
 *
 * Only a **chore**, and only when it was actually done rather than skipped or cancelled. A
 * one-off task is somebody doing a favour; a chore is a share of recurring work, and the ledger
 * exists to make that share visible (`03` §3.9.3).
 */
export function chargesLedger(task: Pick<Task, 'kind' | 'status'>): boolean {
  return task.kind === 'chore' && task.status === 'done';
}

/* ──────────────────────── The fairness ledger (`02` §3.3.5; `03` §3.9.3) ──────────────────────── */

/**
 * `02` §3.3.5's `ledger_entries.kind`.
 *
 * `03` §3.9.3 makes the ledger an **append-only** record of who carried what, so a correction is a
 * `reversal` that points at the entry it undoes rather than a deletion — which is why
 * `reverses_id` exists and why no repository here deletes an entry. A ledger you can edit is a
 * ledger nobody trusts.
 */
export const LEDGER_KINDS = [
  'task_assigned',
  'task_done',
  'coordination',
  'baseline_adjust',
  'self_logged',
  'skipped_unavailable',
  'declined',
  'reassigned_in',
  'reassigned_out',
  'reversal',
] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

/** One entry in the fairness ledger (`02` §3.3.5). */
export interface LedgerEntry {
  readonly id: LedgerEntryId;
  readonly groupId: GroupId;
  readonly memberId: MemberId;
  readonly kind: LedgerKind;
  readonly category: string | undefined;
  readonly points: number;
  readonly taskId: TaskId | undefined;
  readonly rotationId: RotationId | undefined;
  readonly sourceRef: string | undefined;
  /** The entry this one undoes (`03` §3.9.3): a correction is an entry, never a deletion. */
  readonly reversesId: LedgerEntryId | undefined;
  readonly labelId: LabelId;
  readonly at: Temporal.Instant;
}

export interface NewLedgerEntry {
  readonly id: LedgerEntryId;
  readonly groupId: GroupId;
  readonly memberId: MemberId;
  readonly kind: LedgerKind;
  readonly points: number;
  readonly category?: string | undefined;
  readonly taskId?: TaskId | undefined;
  readonly rotationId?: RotationId | undefined;
  readonly sourceRef?: string | undefined;
  readonly reversesId?: LedgerEntryId | undefined;
  readonly at: Temporal.Instant;
}
