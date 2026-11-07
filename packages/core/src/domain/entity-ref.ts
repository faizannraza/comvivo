/**
 * `EntityRef` — a typed reference to one domain entity (`04` §3.2, `05` §3.6, `02` §3.3.9).
 *
 * Three columns store these, and together they say what the type has to be:
 *
 *  - `turn_effects.entity_refs` (`05`): what a tool call created or changed, so the dashboard can
 *    link from "added *soccer practice* to the calendar" to the event itself;
 *  - `declassifications.subject_refs` (`03`): what a recorded declassification was *about*, which
 *    is how I2 is audited after the fact;
 *  - `memory_items.links` (`04` §116): "Event/Task/List/ListItem/Plan/Decision refs owned by 07".
 *
 * So a reference has to survive being written by one subsystem and read by another, without the
 * reader knowing which table the id came from. That is exactly what a TypeID prefix already
 * encodes, which makes the `kind` field redundant *as data* and valuable *as a check*: the schema
 * requires the prefix of `id` to be the one registered for `kind` (ADR-019), so a reference that
 * says `event` and holds a task id is rejected at the boundary rather than producing a dead link.
 */
import { ID_PREFIX, type Id, type IdEntity, parseId, z } from '@comvivo/shared';

/**
 * The entities a reference may point at.
 *
 * A curated subset of `ID_PREFIX` rather than all of it, because `ID_PREFIX` also registers ids
 * for things that are not domain entities — `session`, `loginToken`, `stepUp`, `inviteCode` — and
 * a declassification subject or a turn effect is never about a login token.
 *
 * `04` §116 names the first six coordination kinds. The rest are what `05`'s `EffectResult` and
 * `03`'s declassification subjects demonstrably need: the actors (`person`, `member`, `group`),
 * the content a declassification can be about (`message`, `attachment`, `memory`, `entity`), and
 * the governance records (`constraint`, `proposal`, `declassification`). `04` and `07` may extend
 * this list in their own milestones; the test iterates the constant, so adding one is one edit.
 */
export const ENTITY_REF_KINDS = [
  'person',
  'member',
  'group',
  'conversation',
  'message',
  'attachment',
  'memory',
  'entity',
  'event',
  'reminder',
  'task',
  'rotation',
  'list',
  'listItem',
  'poll',
  'plan',
  'planStep',
  'decision',
  'constraint',
  'proposal',
  'declassification',
] as const satisfies readonly IdEntity[];

/** What an {@link EntityRef} may point at. */
export type EntityRefKind = (typeof ENTITY_REF_KINDS)[number];

/**
 * A reference to one entity, with `id` narrowed by `kind`.
 *
 * The mapped-type-over-union spelling is what gives `ref.kind === 'event'` the type `EventId` for
 * `ref.id`, so a caller that switches on `kind` cannot pass the id to the wrong repository.
 */
export type EntityRef = {
  [K in EntityRefKind]: { kind: K; id: Id<(typeof ID_PREFIX)[K]> };
}[EntityRefKind];

/** `02` §3.3.9: `turn_effects.entity_refs` and `memory_items.links` hold at most 50. */
export const ENTITY_REF_MAX_PER_LIST = 50;

/**
 * One reference, with the prefix of `id` checked against `kind`.
 *
 * `parseId` rather than a pattern: it is the same function `idSchema` uses, so a malformed id is
 * reported the same way at an HTTP boundary, in a JSON column and in the CLI (`M1-T3`).
 */
export const EntityRefSchema = z
  .object({ kind: z.enum(ENTITY_REF_KINDS), id: z.string() })
  .superRefine((ref, context) => {
    const parsed = parseId(ID_PREFIX[ref.kind], ref.id);
    if (parsed.ok) return;
    context.addIssue({
      code: 'custom',
      path: ['id'],
      message: `a ${ref.kind} reference needs a \`${ID_PREFIX[ref.kind]}_\` id: ${parsed.error.message}`,
    });
  })
  .transform((ref) => ref as EntityRef);

/** A bounded list of references, as `02` §3.3.9 specifies for both columns that hold one. */
export const EntityRefListSchema = z.array(EntityRefSchema).max(ENTITY_REF_MAX_PER_LIST);
