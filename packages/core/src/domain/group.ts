/**
 * Group archetypes (`00` §5, `03` §Templates).
 *
 * An archetype is the constitution template a group was created from, and it is a **closed** set —
 * unlike `ChannelId`. `03` §Templates ships normative YAML for each one, and `groups.archetype` is
 * declared `text(..., { enum: ARCHETYPES })` in `02` §3.3.1, so a value outside the list is a
 * missing template rather than an extension point.
 *
 * The stored value is the archetype a group *started* from. Amendments (`03`) change the group's
 * constitution without changing this column, so it stays an answer to "which template" and never
 * becomes a summary of the current rules.
 */
import { z } from '@comvivo/shared';

/**
 * `00` §5's list, in its order.
 *
 * The hyphenated spellings are `00` §5's own (`parents-class`, `oss-project`) and are also the
 * template file names in `03`, so the column value, the template path and the docs heading are one
 * string rather than three that have to be kept in step.
 */
export const ARCHETYPES = [
  'family',
  'roommates',
  'friends',
  'trip',
  'team',
  'club',
  'parents-class',
  'oss-project',
] as const;

/** The constitution template a group was created from (`00` §5). */
export type GroupArchetype = (typeof ARCHETYPES)[number];

/** Boundary schema for an archetype, e.g. the group-creation API and the CLI. */
export const groupArchetypeSchema: z.ZodType<GroupArchetype> = z.enum(ARCHETYPES);
