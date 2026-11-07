/**
 * Task, rotation and chore JSON columns (`02` §3.3.5; `07` §3.3–§3.4, `03` §3.9.3).
 */
import { idSchema, timeZoneIdSchema, z } from '@comvivo/shared';

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
