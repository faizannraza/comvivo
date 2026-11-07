/**
 * Plan JSON columns (`02` §3.3.5; `07` §3.7).
 */
import { idSchema, timeZoneIdSchema, z } from '@comvivo/shared';

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
