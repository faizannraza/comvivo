/**
 * Who or what a memory is about (`04` §3.2.3).
 *
 * A subject is a member, the group itself, or an **external entity** — someone or something that
 * is not in the group. The third case is the one with a rule attached, and `04` §3.2.3 states it
 * plainly: an external person entity stores **names only**. Attributes about them live in memory
 * items under those items' labels, so there is no profile of a non-consenting third party sitting
 * outside the information-flow system.
 *
 * `EntityAlias` carries a `labelId` for the same reason: an alias is visible to an audience only
 * if that audience can read the label of the item that introduced it. A therapist's name learned
 * in a DM never surfaces in a group context, even if the same entity is mentioned there later.
 */
import { idSchema, z } from '@comvivo/shared';

/** How an external entity relates to a member — "my mom" becomes `{ to: m1, kind: 'parent' }`. */
export const RelationKindSchema = z.enum([
  'parent',
  'child',
  'sibling',
  'partner',
  'grandparent',
  'grandchild',
  'guardian',
  'relative',
  'friend',
  'roommate',
  'colleague',
  'teacher',
  'coach',
  'doctor',
  'neighbor',
  'pet_of',
  'other',
]);

export type RelationKind = z.infer<typeof RelationKindSchema>;

/** What a memory can be about. */
export const SubjectRefSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('member'), memberId: idSchema('mbr') }),
  z.object({ type: z.literal('group') }),
  z.object({ type: z.literal('entity'), entityId: idSchema('ent') }),
]);

export type SubjectRef = z.infer<typeof SubjectRefSchema>;

/**
 * `memory_entities.relation` (`02` §3.3.4): an external entity's relation to one member.
 *
 * The column is nullable and the null case means "no known relation", so nullability belongs to
 * the column rather than to this schema — a `jsonOf` column stores no row for a null value at all.
 */
export const EntityRelationSchema = z.object({
  toMemberId: idSchema('mbr'),
  kind: RelationKindSchema,
});

export type EntityRelation = z.infer<typeof EntityRelationSchema>;
