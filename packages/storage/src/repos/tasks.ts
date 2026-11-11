/**
 * The task repository (`02` §3.7.1, §3.3.5; semantics in `07`, fairness in `03` §3.9.3).
 *
 * ## The ledger is posted here, atomically
 *
 * `complete` writes the `ledger_entries` row in the **same transaction** as the completion, and
 * only when `core`'s `chargesLedger` says so. The decision stays in `core` so one rule serves
 * every caller; the write is here so the two cannot disagree. A ledger posted separately could
 * record work for a completion that rolled back, or miss one that committed — and `03` §3.9.3
 * reads the ledger as *the* record of who carried what, so a drift there is a fairness claim
 * nobody can check.
 *
 * The ledger is **append-only**: no method here updates or deletes an entry. A correction is a
 * `reversal` entry pointing at the one it undoes.
 *
 * ## Assignment state travels with the assignee
 *
 * `03`'s fairness rules read `assignment_state`: a `requested` assignment the member has not
 * answered is not yet work they owe, and a `declined` one has to be re-offered rather than
 * silently sitting unassigned. So `assign` takes both, and there is no way to move one without
 * the other.
 */
import type {
  EligibleLabelSet,
  Label,
  LedgerEntry,
  NewLedgerEntry,
  NewTask,
  Task,
  TaskReader,
  TaskRepository,
  TaskStatus,
  TxToken,
  WriteResult,
} from '@comvivo/core';
import { chargesLedger, duplicate, notFound, writeConflict, writeOk } from '@comvivo/core';
import {
  type GroupId,
  type LedgerEntryId,
  type MemberId,
  type RotationId,
  StorageError,
  type TaskId,
} from '@comvivo/shared';
import { and, asc, between, eq, inArray, isNotNull, lte, type SQL, sql } from 'drizzle-orm';
import type { Temporal } from 'temporal-polyfill';
import { type Db, exactlyOne, maybeOne, type Patch } from '../db/drizzle.js';
import { isUniqueViolation } from '../db/errors.js';
import type { LabelStore } from '../ifc/label-store.js';
import { ledgerEntries, tasks } from '../schema/index.js';
import { toLedgerEntry, toTask } from './rows.js';

/** The statuses `isOpenTask` admits, as a SQL predicate (`07`, Q-CTX-7). */
const OPEN_LIKE = ['proposed', 'open'] as const;

export class SqliteTaskRepository implements TaskReader, TaskRepository {
  readonly #db: Db;
  readonly #labels: LabelStore;

  constructor(db: Db, labels: LabelStore) {
    this.#db = db;
    this.#labels = labels;
  }

  byId(groupId: GroupId, id: TaskId, eligible: EligibleLabelSet): Task | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(tasks)
        .where(and(eq(tasks.groupId, groupId), eq(tasks.id, id), eligibleFilter(eligible))),
    );
    return row === undefined ? undefined : toTask(row);
  }

  /**
   * Q-CTX-7, through `tasks_open_due_idx` — a *partial* index on `status = 'open'`.
   *
   * The partial index covers `open` only, so a query that also wanted `proposed` could not use it.
   * `02` §3.3.10 names Q-CTX-7 as "open tasks by due date" and the index follows that exactly, so
   * this method does too: it asks for `open`. `07`'s "what is outstanding" view, which includes
   * proposals, is `byAssignee` with `open_like` — a different question with a different index.
   *
   * Tasks with no due date sort **last**, not first: `NULL` sorts before everything in SQLite, and
   * a plain `ORDER BY due_at` would put every undated task at the top of "what is due soonest",
   * which is the opposite of useful.
   */
  openByDue(query: {
    readonly groupId: GroupId;
    readonly dueBefore?: Temporal.Instant | undefined;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly Task[] {
    if (query.eligible.ids.length === 0) return [];
    const rows = this.#db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.groupId, query.groupId),
          eq(tasks.status, 'open'),
          ...(query.dueBefore === undefined
            ? []
            : // An undated task is not "due before" anything, so the bound excludes it — which is
              // different from the unbounded form, where it sorts last but is still listed.
              [and(isNotNull(tasks.dueAt), lte(tasks.dueAt, query.dueBefore))]),
          eligibleFilter(query.eligible),
        ),
      )
      .orderBy(sql`${tasks.dueAt} IS NULL`, asc(tasks.dueAt), asc(tasks.rid))
      .limit(query.limit)
      .all();
    return rows.map(toTask);
  }

  /** Q-CTX-7b / Q-FAIR-1, through `tasks_assignee_idx` on `(group, assignee, status)`. */
  byAssignee(query: {
    readonly groupId: GroupId;
    readonly assigneeMemberId: MemberId;
    readonly status?: TaskStatus | 'open_like' | undefined;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly Task[] {
    if (query.eligible.ids.length === 0) return [];
    const status = query.status ?? 'open_like';
    const rows = this.#db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.groupId, query.groupId),
          eq(tasks.assigneeMemberId, query.assigneeMemberId),
          status === 'open_like' ? inArray(tasks.status, [...OPEN_LIKE]) : eq(tasks.status, status),
          eligibleFilter(query.eligible),
        ),
      )
      .orderBy(sql`${tasks.dueAt} IS NULL`, asc(tasks.dueAt), asc(tasks.rid))
      .limit(query.limit)
      .all();
    return rows.map(toTask);
  }

  /**
   * The rotation's task for one turn, through `tasks_rotation_occurrence_uq`.
   *
   * **Not label-filtered**, like the memory fingerprint and the calendar feed lookups: this asks
   * "has this rotation turn already been stamped out", which is a question about the store. The
   * rotation scheduler is a job, not an audience, and filtering it would make a re-run create a
   * second task for the same turn — which is what the unique index exists to prevent.
   */
  byOccurrence(groupId: GroupId, rotationId: RotationId, occurrenceKey: string): Task | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.groupId, groupId),
            eq(tasks.rotationId, rotationId),
            eq(tasks.occurrenceKey, occurrenceKey),
          ),
        ),
    );
    return row === undefined ? undefined : toTask(row);
  }

  /** Q-FAIR-2, through `ledger_group_member_at_idx`. See the port for why it is unfiltered. */
  ledgerFor(query: {
    readonly groupId: GroupId;
    readonly memberId: MemberId;
    readonly from: Temporal.Instant;
    readonly to: Temporal.Instant;
  }): readonly LedgerEntry[] {
    const rows = this.#db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.groupId, query.groupId),
          eq(ledgerEntries.memberId, query.memberId),
          between(ledgerEntries.at, query.from, query.to),
        ),
      )
      .orderBy(asc(ledgerEntries.at), asc(ledgerEntries.id))
      .all();
    return rows.map(toLedgerEntry);
  }

  create(uow: TxToken, task: NewTask, label: Label): WriteResult<Task> {
    if (label.groupId !== task.groupId) throw crossGroup('task');
    const labelId = this.#labels.intern(uow, label);
    try {
      const row = exactlyOne(
        this.#db
          .insert(tasks)
          .values({
            id: task.id,
            groupId: task.groupId,
            kind: task.kind ?? 'task',
            title: task.title,
            notes: task.notes,
            category: task.category,
            assigneeMemberId: task.assigneeMemberId,
            assignmentState: task.assignmentState ?? 'unassigned',
            requestedByMemberId: task.requestedByMemberId,
            effortPoints: task.effortPoints ?? 1,
            due: task.due,
            dueAt: task.dueAt,
            dueTz: task.dueTz,
            dueLocal: task.dueLocal,
            recurrence: task.recurrence,
            rotationId: task.rotationId,
            occurrenceKey: task.occurrenceKey,
            proofPolicy: task.proofPolicy ?? 'off',
            status: task.status ?? 'open',
            planId: task.planId,
            planStepId: task.planStepId,
            labelId,
            sourceRef: task.sourceRef,
            createdByMemberId: task.createdByMemberId,
            createdAt: uow.now,
            updatedAt: uow.now,
          })
          .returning(),
        'the task',
      );
      return writeOk(toTask(row));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // The routine case is a rotation re-run: `tasks_rotation_occurrence_uq` already has this
      // turn, and the scheduler wants the task that exists rather than an error.
      const existing =
        task.rotationId === undefined || task.occurrenceKey === undefined
          ? undefined
          : this.byOccurrence(task.groupId, task.rotationId, task.occurrenceKey);
      return duplicate(existing?.id ?? task.id);
    }
  }

  assign(
    uow: TxToken,
    groupId: GroupId,
    id: TaskId,
    expectVersion: number,
    assignment: {
      readonly assigneeMemberId: MemberId | null;
      readonly assignmentState: Task['assignmentState'];
    },
  ): WriteResult<Task> {
    // Both together, always. `03`'s fairness rules read the state, so a write that moved the
    // assignee without it would make the ledger wrong in a way nothing detects.
    if (assignment.assigneeMemberId === null && assignment.assignmentState !== 'unassigned') {
      throw new StorageError(
        'STORAGE_CONSTRAINT',
        `clearing the assignee needs assignmentState 'unassigned', not '${assignment.assignmentState}'`,
        {
          hint: 'This is a bug in the caller: an unassigned task cannot be in an assigned state.',
          category: 'bug',
        },
      );
    }
    return this.#versionedUpdate(uow, groupId, id, expectVersion, {
      assigneeMemberId: assignment.assigneeMemberId,
      assignmentState: assignment.assignmentState,
    });
  }

  /**
   * Complete a task and post the fairness ledger, atomically.
   *
   * `core`'s `chargesLedger` decides whether an entry is written: only a **chore**, and only when
   * it was actually done. A one-off task is somebody doing a favour; a chore is a share of
   * recurring work, and the ledger exists to make that share visible (`03` §3.9.3).
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
      readonly ledgerEntryId: LedgerEntryId;
    },
  ): WriteResult<Task> {
    const done = this.#versionedUpdate(uow, groupId, id, expectVersion, {
      status: 'done',
      completedAt: completion.at,
      completedByMemberId: completion.completedByMemberId,
      verifiedByMemberId: completion.verifiedByMemberId,
    });
    if (done.kind !== 'ok') return done;

    if (chargesLedger(done.value)) {
      this.#db
        .insert(ledgerEntries)
        .values({
          id: completion.ledgerEntryId,
          groupId,
          // The **completer**, not the assignee: `03` §3.9.3 credits who did the work, and
          // somebody covering for an absent member is exactly the case fairness has to see.
          memberId: completion.completedByMemberId,
          kind: 'task_done',
          category: done.value.category,
          points: done.value.effortPoints,
          taskId: done.value.id,
          rotationId: done.value.rotationId,
          // The task's own label, so the entry is never readable by a wider audience than the
          // chore it came from.
          labelId: done.value.labelId,
          at: completion.at,
        })
        // Idempotent on the id, so a retried completion posts one entry. The task write is already
        // version-guarded, but a caller that retried after a partial failure would otherwise
        // double-charge — and a double-charged ledger is a fairness claim that is simply wrong.
        .onConflictDoNothing()
        .run();
    }
    return done;
  }

  setStatus(
    uow: TxToken,
    groupId: GroupId,
    id: TaskId,
    expectVersion: number,
    status: TaskStatus,
  ): WriteResult<Task> {
    return this.#versionedUpdate(uow, groupId, id, expectVersion, { status });
  }

  /**
   * Increment the nudge count.
   *
   * Unversioned, like the calendar's `markRruleInvalid`: a nudge is something *we* did, not
   * something a member changed, and versioning it would make the record of the nudge conflict with
   * whatever the member was doing at the time.
   */
  recordNudge(uow: TxToken, groupId: GroupId, id: TaskId): WriteResult<Task> {
    const row = maybeOne(
      this.#db
        .update(tasks)
        .set({ nudgeCount: sql`${tasks.nudgeCount} + 1`, updatedAt: uow.now })
        .where(and(eq(tasks.groupId, groupId), eq(tasks.id, id)))
        .returning(),
    );
    return row === undefined ? notFound() : writeOk(toTask(row));
  }

  /** `03` §3.9.3's append-only ledger, for the kinds a completion does not cause. */
  postLedger(uow: TxToken, entry: NewLedgerEntry, label: Label): WriteResult<LedgerEntry> {
    if (label.groupId !== entry.groupId) throw crossGroup('ledger entry');
    const labelId = this.#labels.intern(uow, label);
    try {
      const row = exactlyOne(
        this.#db
          .insert(ledgerEntries)
          .values({
            id: entry.id,
            groupId: entry.groupId,
            memberId: entry.memberId,
            kind: entry.kind,
            category: entry.category,
            points: entry.points,
            taskId: entry.taskId,
            rotationId: entry.rotationId,
            sourceRef: entry.sourceRef,
            reversesId: entry.reversesId,
            labelId,
            at: entry.at,
          })
          .returning(),
        'the ledger entry',
      );
      return writeOk(toLedgerEntry(row));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return duplicate(entry.id);
    }
  }

  #rowOf(groupId: GroupId, id: TaskId): typeof tasks.$inferSelect | undefined {
    return maybeOne(
      this.#db
        .select()
        .from(tasks)
        .where(and(eq(tasks.groupId, groupId), eq(tasks.id, id))),
    );
  }

  #versionedUpdate(
    uow: TxToken,
    groupId: GroupId,
    id: TaskId,
    expectVersion: number,
    patch: Patch<typeof tasks.$inferInsert>,
  ): WriteResult<Task> {
    const row = maybeOne(
      this.#db
        .update(tasks)
        .set({ ...patch, updatedAt: uow.now, version: expectVersion + 1 })
        .where(and(eq(tasks.groupId, groupId), eq(tasks.id, id), eq(tasks.version, expectVersion)))
        .returning(),
    );
    if (row !== undefined) return writeOk(toTask(row));
    return this.#rowOf(groupId, id) === undefined ? notFound() : writeConflict();
  }
}

/** `label_id IN (eligible)`, with the empty set matching nothing (`I1`). */
function eligibleFilter(eligible: EligibleLabelSet): SQL {
  if (eligible.ids.length === 0) return sql`1 = 0`;
  return inArray(tasks.labelId, [...eligible.ids]);
}

function crossGroup(what: string): StorageError {
  return new StorageError('STORAGE_CONSTRAINT', `the ${what} names a label of another group`, {
    hint: `This is a bug and an I4 violation: intern the label against the ${what}'s own group.`,
    category: 'bug',
  });
}
