/**
 * Plan JSON columns (`02` §3.3.5; `07` §3.7).
 */
import type { GroupId, LabelId, MemberId, PlanId, PlanStepId, TimeZoneId } from '@comvivo/shared';
import { idSchema, timeZoneIdSchema, z } from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';

/**
 * `plans.secrecy` (`07` §1202): the surprise-party case.
 *
 * `excluded` names members the plan must never reach, and `sealedTerms` are strings `03`'s
 * disclosure guard watches for in **outgoing** messages to them — so the agent cannot mention the
 * cake to the person it is for, even when summarising something else entirely.
 *
 * `02` §3.3.5 marks the column "sealed for the guard". The terms are group content about a
 * specific person, so they live under the plan's label and the guard reads them without ever
 * rendering them: a leak here is the feature failing in the one way users would not forgive.
 */
export const PlanSecrecySchema = z.object({
  excluded: z.array(idSchema('mbr')).min(1).max(64),
  sealedTerms: z.array(z.string().min(1).max(120)).max(50),
});

export type PlanSecrecy = z.infer<typeof PlanSecrecySchema>;

/**
 * `plans.budget_notes` (`07` §1202).
 *
 * `estimate` is deliberately **free text** — `07`'s own example is `"~€400"`. A numeric amount
 * with a currency would be a false precision: people plan in approximations, and a product that
 * forced "400.00 EUR" would either reject what they said or silently sharpen it. Nothing sums
 * these; they are notes.
 */
export const PlanBudgetNotesSchema = z
  .array(
    z.object({
      item: z.string().min(1).max(120),
      /** Free text, e.g. `~€400`. Never parsed, never summed. */
      estimate: z.string().max(60),
      note: z.string().max(200).nullable(),
    }),
  )
  .max(50);

export type PlanBudgetNotes = z.infer<typeof PlanBudgetNotesSchema>;

/** `plan_steps.due` (`07` §1203): a step is due at a time or on a day, or not at all. */
export const StepDueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('at'), zdt: z.string().max(80) }),
  z.object({ kind: z.literal('by_day'), date: z.iso.date(), zone: timeZoneIdSchema }),
]);

export type StepDue = z.infer<typeof StepDueSchema>;

/**
 * `plan_steps.links` (`02` §3.3.5): the entities a step materialised into.
 *
 * A step is a *plan* of work; these are what it became. All optional, because a step may be
 * planned long before anything exists for it — and the links are what let "book the van" show its
 * task's status rather than restating it.
 */
export const PlanStepLinksSchema = z.object({
  eventId: idSchema('evt').optional(),
  taskId: idSchema('tsk').optional(),
  listId: idSchema('lst').optional(),
  pollId: idSchema('pol').optional(),
});

export type PlanStepLinks = z.infer<typeof PlanStepLinksSchema>;

/* ──────────────────────────── The plan aggregate (`02` §3.3.5) ──────────────────────────── */

export const PLAN_KINDS = ['trip', 'party', 'move', 'project', 'generic'] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];

export const PLAN_STATUSES = ['draft', 'active', 'done', 'cancelled', 'archived'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_STEP_STATUSES = ['todo', 'doing', 'done', 'blocked', 'skipped'] as const;
export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];

/** `02` §3.3.5: a step proposed by the agent, versus one the group agreed to. */
export const CONFIRM_STATES = ['proposed', 'confirmed'] as const;
export type ConfirmState = (typeof CONFIRM_STATES)[number];

/**
 * A plan (`02` §3.3.5; semantics in `07`).
 *
 * `secrecy` is the field that makes a surprise party possible: a plan can be readable by everyone
 * except its subject, which is an `I1` arrangement rather than a flag — so `03` owns what it means
 * and this type only carries it.
 *
 * `startsOn`/`endsOn` are **dates**, not instants: a trip starts on a day, not at a moment, and
 * storing an instant would force a time nobody chose and shift the day across a zone boundary.
 */
export interface Plan {
  readonly rid: number;
  readonly id: PlanId;
  readonly groupId: GroupId;
  readonly kind: PlanKind;
  readonly title: string;
  readonly description: string | undefined;
  readonly ownerMemberIds: readonly MemberId[];
  readonly status: PlanStatus;
  readonly secrecy: PlanSecrecy | undefined;
  readonly tz: TimeZoneId | undefined;
  /** ISO dates (`YYYY-MM-DD`), because a plan spans days rather than moments. */
  readonly startsOn: string | undefined;
  readonly endsOn: string | undefined;
  readonly budgetNotes: PlanBudgetNotes;
  readonly assumptions: readonly string[];
  readonly labelId: LabelId;
  readonly createdByMemberId: MemberId | undefined;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
  readonly version: number;
}

export interface NewPlan {
  readonly id: PlanId;
  readonly groupId: GroupId;
  readonly kind?: PlanKind | undefined;
  readonly title: string;
  readonly description?: string | undefined;
  readonly ownerMemberIds?: readonly MemberId[] | undefined;
  readonly status?: PlanStatus | undefined;
  readonly secrecy?: PlanSecrecy | undefined;
  readonly tz?: TimeZoneId | undefined;
  readonly startsOn?: string | undefined;
  readonly endsOn?: string | undefined;
  readonly budgetNotes?: PlanBudgetNotes | undefined;
  readonly assumptions?: readonly string[] | undefined;
  readonly createdByMemberId?: MemberId | undefined;
}

/**
 * One step of a plan (`02` §3.3.5).
 *
 * `position` is text for the same reason a list item's is: reordering is an insert between
 * neighbours rather than a renumbering of everything after it.
 */
export interface PlanStep {
  readonly id: PlanStepId;
  readonly planId: PlanId;
  readonly groupId: GroupId;
  readonly position: string;
  readonly title: string;
  readonly ownerMemberIds: readonly MemberId[];
  readonly status: PlanStepStatus;
  readonly confirmState: ConfirmState;
  readonly due: StepDue | undefined;
  readonly dueAt: Temporal.Instant | undefined;
  readonly dependsOn: readonly PlanStepId[];
  readonly links: PlanStepLinks;
  /**
   * The last time anything moved on this step (`02` §3.3.5).
   *
   * `07` uses it to nudge a stalled step, which is why it is `NOT NULL` and set on creation: a
   * step that had never moved would otherwise be indistinguishable from one that moved long ago.
   */
  readonly lastActivityAt: Temporal.Instant;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
  readonly version: number;
}

export interface NewPlanStep {
  readonly id: PlanStepId;
  readonly planId: PlanId;
  readonly groupId: GroupId;
  readonly title: string;
  readonly position?: string | undefined;
  readonly ownerMemberIds?: readonly MemberId[] | undefined;
  readonly status?: PlanStepStatus | undefined;
  readonly confirmState?: ConfirmState | undefined;
  readonly due?: StepDue | undefined;
  readonly dueAt?: Temporal.Instant | undefined;
  readonly dependsOn?: readonly PlanStepId[] | undefined;
  readonly links?: PlanStepLinks | undefined;
}

/**
 * A plan step has **no label of its own** (`02` §3.3.5).
 *
 * It inherits the plan's, which is what makes a surprise party coherent: the plan's `secrecy`
 * decides who may read it, and a step with an independent label could be readable by someone the
 * plan is hidden from. Recorded here because the absence looks like an omission beside every other
 * aggregate in this file.
 */
export const PLAN_STEPS_INHERIT_PLAN_LABEL = true;

/** Whether a plan is still being worked on, for `07`'s context block. */
export function isActivePlan(plan: Pick<Plan, 'status'>): boolean {
  return plan.status === 'draft' || plan.status === 'active';
}
