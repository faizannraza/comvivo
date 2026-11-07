/**
 * Plans and their steps (`02` §3.3.5; `07` §3.7).
 *
 * A plan is the one place the product holds a *secret from a member of the group* on purpose. The
 * surprise party is the motivating case, and `plans.secrecy` is how it works: `excluded` names who
 * must not learn of it, and `sealedTerms` are the strings `03`'s disclosure guard watches for in
 * outgoing messages to them. That is why the column exists at all rather than relying on the
 * label — a label controls who can read the *plan*, while the guard has to stop the cake being
 * mentioned in a reply about something else entirely.
 *
 * `plan_steps` are rows rather than a JSON array on the plan, because each step has its own owner,
 * status and due date, and `07` §3.7 lets a step materialise into an event, task, list or poll. A
 * JSON array would make "every step assigned to me across all plans" a full scan.
 */
import {
  PlanBudgetNotesSchema,
  PlanSecrecySchema,
  PlanStepLinksSchema,
  StepDueSchema,
} from '@comvivo/core';
import { idSchema, z } from '@comvivo/shared';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import {
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

export const plans = sqliteTable(
  'plans',
  {
    rid: integer('rid').primaryKey({ autoIncrement: true }),
    id: tid('pln')('id').notNull().unique(),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['trip', 'party', 'move', 'project', 'generic'] })
      .notNull()
      .default('generic'),
    title: text('title').notNull(),
    description: text('description'),
    ownerMemberIds: jsonOf(
      z.array(idSchema('mbr')).max(20),
      'plans.owner_member_ids',
    )('owner_member_ids').notNull(),
    status: text('status', { enum: ['draft', 'active', 'done', 'cancelled', 'archived'] })
      .notNull()
      .default('draft'),
    /** The surprise case: `{excluded, sealedTerms}`, read by `03`'s guard and never rendered. */
    secrecy: jsonOf(PlanSecrecySchema, 'plans.secrecy')('secrecy'),
    /** The destination's zone, which may not be the group's. */
    tz: tzText('tz'),
    startsOn: text('starts_on'),
    endsOn: text('ends_on'),
    budgetNotes: jsonOf(PlanBudgetNotesSchema, 'plans.budget_notes')('budget_notes').notNull(),
    /** Shown to the group prefixed "assumed", so a guess is never presented as a fact. */
    assumptions: jsonOf(
      z.array(z.string().max(200)).max(50),
      'plans.assumptions',
    )('assumptions').notNull(),
    labelId: labelRef().notNull(),
    createdByMemberId: tid('mbr')('created_by_member_id').references(() => members.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [index('plans_group_status_idx').on(t.groupId, t.status)],
);

export const planSteps = sqliteTable(
  'plan_steps',
  {
    id: tid('plns')('id').primaryKey(),
    planId: tid('pln')('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    /** Denormalised; the cascade arrives through `plan_id`. */
    groupId: tid('grp')('group_id').notNull(),
    /** A fractional index, like `list_items.position`, so reordering writes one row. */
    position: text('position').notNull(),
    title: text('title').notNull(),
    ownerMemberIds: jsonOf(
      z.array(idSchema('mbr')).max(10),
      'plan_steps.owner_member_ids',
    )('owner_member_ids').notNull(),
    status: text('status', { enum: ['todo', 'doing', 'done', 'blocked', 'skipped'] })
      .notNull()
      .default('todo'),
    /** `proposed` is a step the agent suggested and nobody has agreed to yet. */
    confirmState: text('confirm_state', { enum: ['proposed', 'confirmed'] })
      .notNull()
      .default('confirmed'),
    due: jsonOf(StepDueSchema, 'plan_steps.due')('due'),
    dueAt: instantMs('due_at'),
    dependsOn: jsonOf(
      z.array(idSchema('plns')).max(20),
      'plan_steps.depends_on',
    )('depends_on').notNull(),
    /** What the step became: `{eventId?, taskId?, listId?, pollId?}`. */
    links: jsonOf(PlanStepLinksSchema, 'plan_steps.links')('links').notNull(),
    /** Drives `07`'s stalled-plan nudges, which need "nothing has moved" to be cheap to ask. */
    lastActivityAt: instantMs('last_activity_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [index('plan_steps_plan_idx').on(t.planId, t.position)],
);
