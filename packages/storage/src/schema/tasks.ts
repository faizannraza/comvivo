/**
 * Tasks, rotations, swaps and the load ledger (`02` §3.3.5; `07` §3.3–§3.4, `03` §3.9.3).
 *
 * This is where fairness lives, and the design choice that carries it is that **the ledger is
 * append-only and separate from the tasks**. `ledger_entries` records what each member was
 * assigned and did, one row per event, including a `reversal` kind rather than deletions — so
 * "who has been doing more" is a sum over an immutable history rather than a mutable counter that
 * a bug or a reassignment could silently corrupt.
 *
 * `rotations` generates tasks on a schedule, and `tasks_rotation_occurrence_uq` is what makes that
 * generation idempotent: `(rotation_id, occurrence_key)` unique means the weekly job can run twice
 * — after a crash, say — without producing two "take the bins out" for the same week.
 */
import {
  RecurringScheduleSchema,
  RotationCursorSchema,
  TaskDueSchema,
  TaskTemplateSchema,
} from '@comvivo/core';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import {
  bool,
  boolCheckSql,
  createdAt,
  instantMs,
  jsonOf,
  labelRef,
  tid,
  tzText,
  updatedAt,
  version,
} from './_columns.js';
import { groups, members } from './groups.js';

export const rotations = sqliteTable('rotations', {
  id: tid('rot')('id').primaryKey(),
  groupId: tid('grp')('group_id')
    .notNull()
    .references(() => groups.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  taskTemplate: jsonOf(TaskTemplateSchema, 'rotations.task_template')('task_template').notNull(),
  /** `03` §3.9.3's names, used verbatim by `07`. */
  strategy: text('strategy', { enum: ['round_robin', 'least_loaded', 'fixed'] }).notNull(),
  /** `request` asks before assigning, which is what makes a chore rota feel consensual. */
  assignmentMode: text('assignment_mode', { enum: ['direct', 'request'] })
    .notNull()
    .default('direct'),
  announce: text('announce', { enum: ['dm', 'group', 'none'] })
    .notNull()
    .default('dm'),
  cursor: jsonOf(RotationCursorSchema, 'rotations.cursor')('cursor').notNull(),
  schedule: jsonOf(RecurringScheduleSchema, 'rotations.schedule')('schedule'),
  /** How far ahead to generate. Default: the next occurrence; daily chores: the next day. */
  horizon: text('horizon'),
  pausedUntil: instantMs('paused_until'),
  status: text('status', { enum: ['active', 'paused', 'archived'] })
    .notNull()
    .default('active'),
  labelId: labelRef().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
});

/**
 * Who is in a rotation, and what they are owed (`03` §3.9.3).
 *
 * `owed_slots` is capped at 1 by `03` §3.9.3 and exists because skipping has to be forgiving
 * without being exploitable: someone genuinely unavailable this week goes to the front next week,
 * once. Letting it accumulate would let a long absence turn into an unpayable debt that the
 * rotation then spends weeks settling.
 *
 * `weight` lets a household divide chores unequally on purpose — a teenager's share need not equal
 * an adult's — which `03`'s fairness computation reads instead of assuming parity.
 */
export const rotationParticipants = sqliteTable(
  'rotation_participants',
  {
    rotationId: tid('rot')('rotation_id')
      .notNull()
      .references(() => rotations.id, { onDelete: 'cascade' }),
    memberId: tid('mbr')('member_id')
      .notNull()
      .references(() => members.id),
    position: integer('position').notNull(),
    weight: real('weight').notNull().default(1),
    active: bool('active').notNull().default(true),
    /** `03` §3.9.3 caps this at 1, so a skip is forgiven once rather than compounding. */
    owedSlots: integer('owed_slots').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.rotationId, t.memberId] }),
    index('rotation_participants_member_idx').on(t.memberId),
    check('rotation_participants_active_bool_ck', boolCheckSql(t.active)),
    check('rotation_participants_owed_ck', sql`${t.owedSlots} BETWEEN 0 AND 1`),
    check('rotation_participants_weight_ck', sql`${t.weight} > 0`),
  ],
);

export const tasks = sqliteTable(
  'tasks',
  {
    rid: integer('rid').primaryKey({ autoIncrement: true }),
    id: tid('tsk')('id').notNull().unique(),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['task', 'chore'] })
      .notNull()
      .default('task'),
    title: text('title').notNull(),
    notes: text('notes'),
    /** `07`'s chore catalog id; read by `03` fairness and by `tasks.do_not_assign`. */
    category: text('category'),
    assigneeMemberId: tid('mbr')('assignee_member_id').references(() => members.id),
    /**
     * `requested` and `accepted` are distinct from `direct` because being *asked* to do something
     * and being *given* it are different social acts, and `03` §3.9.3's `request` mode depends on
     * the difference.
     */
    assignmentState: text('assignment_state', {
      enum: ['unassigned', 'requested', 'accepted', 'declined', 'direct'],
    })
      .notNull()
      .default('unassigned'),
    requestedByMemberId: tid('mbr')('requested_by_member_id').references(() => members.id),
    effortPoints: integer('effort_points').notNull().default(1),
    due: jsonOf(TaskDueSchema, 'tasks.due')('due').notNull(),
    /** Derived from `due`. `due_local`/`due_tz` keep the wall-clock original (`07` §56). */
    dueAt: instantMs('due_at'),
    dueTz: tzText('due_tz'),
    dueLocal: text('due_local'),
    /** For recurring tasks that are not rotations. */
    recurrence: jsonOf(RecurringScheduleSchema, 'tasks.recurrence')('recurrence'),
    rotationId: tid('rot')('rotation_id').references(() => rotations.id, {
      onDelete: 'set null',
    }),
    /** e.g. `2026-W45`. Makes rotation generation idempotent. */
    occurrenceKey: text('occurrence_key'),
    proofPolicy: text('proof_policy', { enum: ['off', 'optional', 'required'] })
      .notNull()
      .default('off'),
    /** Deleted after `tasks.proofRetentionDays` (`07`): a photo of a done chore is not archive. */
    proofBlobSha256: text('proof_blob_sha256'),
    /** `proposed` carries turn taint (`03` §3.10.2). */
    status: text('status', { enum: ['proposed', 'open', 'done', 'skipped', 'cancelled'] })
      .notNull()
      .default('open'),
    completedAt: instantMs('completed_at'),
    completedByMemberId: tid('mbr')('completed_by_member_id').references(() => members.id),
    verifiedByMemberId: tid('mbr')('verified_by_member_id').references(() => members.id),
    nudgeCount: integer('nudge_count').notNull().default(0),
    planId: tid('pln')('plan_id'),
    planStepId: tid('plns')('plan_step_id'),
    labelId: labelRef().notNull(),
    sourceRef: text('source_ref'),
    createdByMemberId: tid('mbr')('created_by_member_id').references(() => members.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    // Q-CTX-7: what is open and due, read on every turn.
    index('tasks_open_due_idx').on(t.groupId, t.dueAt).where(sql`${t.status} = 'open'`),
    // Q-CTX-7b and Q-FAIR-1: one member's workload.
    index('tasks_assignee_idx').on(t.groupId, t.assigneeMemberId, t.status),
    // Idempotent rotation generation: one task per rotation per occurrence.
    uniqueIndex('tasks_rotation_occurrence_uq')
      .on(t.rotationId, t.occurrenceKey)
      .where(sql`${t.rotationId} IS NOT NULL AND ${t.occurrenceKey} IS NOT NULL`),
    check('tasks_effort_ck', sql`${t.effortPoints} BETWEEN 0 AND 100`),
    check('tasks_nudge_ck', sql`${t.nudgeCount} >= 0`),
  ],
);

/**
 * An offer to swap, give away or trade a task (`07` TaskSwap).
 *
 * `expires_at` is mandatory and the open index is partial on it, because an offer nobody answered
 * must stop being an offer: a stale "can anyone take Tuesday?" sitting open for a month is worse
 * than no feature at all.
 */
export const taskSwaps = sqliteTable(
  'task_swaps',
  {
    id: tid('swp')('id').primaryKey(),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['swap', 'give_away', 'trade'] }).notNull(),
    fromMemberId: tid('mbr')('from_member_id')
      .notNull()
      .references(() => members.id),
    /** `NULL` for an open offer to the whole group. */
    toMemberId: tid('mbr')('to_member_id').references(() => members.id),
    offeredTaskId: tid('tsk')('offered_task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** Set for a `trade`: what is wanted in return. */
    requestedTaskId: tid('tsk')('requested_task_id').references(() => tasks.id, {
      onDelete: 'cascade',
    }),
    status: text('status', { enum: ['open', 'accepted', 'declined', 'expired', 'cancelled'] })
      .notNull()
      .default('open'),
    expiresAt: instantMs('expires_at').notNull(),
    resolvedByMemberId: tid('mbr')('resolved_by_member_id'),
    labelId: labelRef().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('task_swaps_open_idx').on(t.groupId, t.expiresAt).where(sql`${t.status} = 'open'`)],
);

/**
 * The load ledger (`03` LedgerEntry ≡ `07` LoadLedgerEntry) — **append-only**.
 *
 * Fairness is the most contestable thing this product computes, so the history it is computed from
 * must be immutable. A correction is a `reversal` row pointing at the entry it undoes
 * (`reverses_id`), never an update or a delete: a member who disagrees with their share can be
 * shown every entry that produced it, and a mutable counter could not support that conversation.
 *
 * `points` is `real` rather than an integer because `reassigned_out` splits an entry, and halving
 * a one-point chore has to be representable.
 *
 * The label follows `ledgerVisibility` (`03` §3.4.4): a group may keep its load ledger private to
 * each member, visible to admins, or open — so the rows carry a label like any other datum.
 */
export const ledgerEntries = sqliteTable(
  'ledger_entries',
  {
    id: tid('lde')('id').primaryKey(),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    memberId: tid('mbr')('member_id')
      .notNull()
      .references(() => members.id),
    kind: text('kind', {
      enum: [
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
      ],
    }).notNull(),
    category: text('category'),
    points: real('points').notNull(),
    taskId: tid('tsk')('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    rotationId: tid('rot')('rotation_id').references(() => rotations.id, {
      onDelete: 'set null',
    }),
    sourceRef: text('source_ref'),
    /** A `reversal` names the entry it undoes, instead of that entry being deleted. */
    reversesId: tid('lde')('reverses_id'),
    /** Per `ledgerVisibility` (`03` §3.4.4). */
    labelId: labelRef().notNull(),
    at: instantMs('at').notNull(),
  },
  // Q-FAIR-2: one member's history, which every fairness computation sums.
  (t) => [index('ledger_group_member_at_idx').on(t.groupId, t.memberId, t.at)],
);
