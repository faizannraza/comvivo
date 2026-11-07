/**
 * `MemoryContent` — the typed body of a memory item (`04` §3.2.2).
 *
 * `00` §6.1 promises *typed* memories rather than a pile of sentences, and this union is where
 * that promise is kept. Each arm carries the fields its kind needs to be acted on: a commitment
 * has a `who` and a `byWhen` so it can age and be chased, a decision has a `rationale` and a
 * `decidedBy` so "why did we settle on this?" has an answer, a profile field has a *typed* value so
 * a timezone is a validated zone rather than a string someone typed.
 *
 * `02` §3.3.4 stores this in `memory_items.content`, capped at 8 KiB by `02` §3.3.9, alongside a
 * flattened `statement` column for full-text search. Both exist on purpose: the statement is what
 * a human and the FTS index read, the content is what code acts on, and `04` §3.2.6 R4 indexes
 * only the former.
 *
 * ## One deliberate difference from `04` §3.2.2
 *
 * `04` §3.2.2's listing is tuned for being handed to a model as a structured-output schema — its
 * own test (`kinds.schemas.roundtrip`) requires `z.toJSONSchema` to contain no `minimum` and no
 * `maxLength`. That is a constraint on the *extraction* schema, not on the column: a value read
 * back from `memory_items.content` has already been through extraction, and `02` §3.1 makes the
 * column mapper the last place a bad value can be caught. So the bounds `04` writes as prose are
 * enforced here. `M6` derives the model-facing variant from this by stripping the bounds, which is
 * the direction that cannot lose a constraint.
 */
import { capped, idSchema, z } from '@comvivo/shared';
import { RelationKindSchema, SubjectRefSchema } from './subjects.js';
import { ianaTzSchema, TimeSpecSchema } from './time-spec.js';

/** `02` §3.3.9: `memory_items.content` is capped at 8 KiB. */
export const MEMORY_CONTENT_MAX_BYTES = 8 * 1024;

export const FactContentSchema = z.object({
  kind: z.literal('fact'),
  /** A normalised key, e.g. `school`, `car.model`, `wifi.network`. */
  attribute: z.string().max(60).nullable(),
  value: z.string().max(200).nullable(),
  /** `negate` is a fact about what is *not* so, which is not the same as having no fact. */
  polarity: z.enum(['affirm', 'negate']),
});

export const PreferenceContentSchema = z.object({
  kind: z.literal('preference'),
  holder: SubjectRefSchema,
  stance: z.enum(['likes', 'dislikes', 'prefers', 'avoids', 'needs']),
  object: z.string().max(120),
  strength: z.enum(['weak', 'normal', 'strong']),
  context: z.string().max(120).nullable(),
});

export const DecisionContentSchema = z.object({
  kind: z.literal('decision'),
  summary: z.string().max(240),
  rationale: z.string().max(400).nullable(),
  alternativesRejected: z
    .array(z.object({ option: z.string().max(120), reason: z.string().max(200).nullable() }))
    .max(8),
  decidedBy: z.object({
    rule: z.enum([
      'explicit_agreement',
      'vote',
      'owner',
      'role_precedence',
      'consensus',
      'individual',
      'unknown',
    ]),
    memberIds: z.array(idSchema('mbr')).max(64),
  }),
  decidedAt: z.iso.datetime({ offset: true }),
  /** "spring trip", "chore rules". */
  scope: z.string().max(120).nullable(),
  revisitAt: TimeSpecSchema.nullable(),
  /** Set once `07` mirrors this into a `Decision` entity. */
  decisionId: idSchema('dec').nullable(),
});

export const CommitmentContentSchema = z.object({
  kind: z.literal('commitment'),
  who: z.array(idSchema('mbr')).min(1).max(16),
  what: z.string().max(240),
  byWhen: TimeSpecSchema.nullable(),
  toWhom: z.array(SubjectRefSchema).max(16),
  /** "if it doesn't rain". */
  conditional: z.string().max(160).nullable(),
  /** The one lifecycle-mutable field of a commitment. */
  fulfillment: z.enum(['open', 'done', 'cancelled', 'missed']),
  /** Set when `07` materialises a task or reminder. */
  taskId: idSchema('tsk').nullable(),
});

export const NoteContentSchema = z.object({
  kind: z.literal('note'),
  noteType: z.enum(['general', 'howto', 'reference', 'group_story', 'member_digest']),
  title: z.string().max(120).nullable(),
  body: z.string().max(8000),
  /** Non-empty for `group_story` and `member_digest`, which are consolidations of other items. */
  derivedFrom: z.array(idSchema('mem')).max(500),
  sections: z
    .array(
      z.object({
        heading: z.string().max(80),
        bullets: z
          .array(
            z.object({
              text: z.string().max(400),
              /** Every bullet cites at least one item, so a digest is never unattributed. */
              refs: z.array(idSchema('mem')).min(1).max(20),
            }),
          )
          .max(30),
      }),
    )
    .max(12)
    .nullable(),
});

/** `04` §3.2.2's profile fields. */
export const ProfileFieldSchema = z.enum([
  'timezone',
  'locale',
  'languages',
  'preferred_name',
  'pronouns',
  'birthday',
  'dietary',
  'allergy',
  'schedule',
  'contact_preference',
  'home_city',
  'school',
  'work',
  'relationship',
]);

export type ProfileField = z.infer<typeof ProfileFieldSchema>;

/**
 * `04` §3.2.2: the fields a member may hold more than one value of at a time.
 *
 * Someone has one timezone and possibly three allergies, so for every other field a new value
 * supersedes the old one while these accumulate. `M6`'s reconcile step reads this.
 */
export const MULTI_VALUED_PROFILE_FIELDS: ReadonlySet<ProfileField> = new Set<ProfileField>([
  'allergy',
  'languages',
  'relationship',
  'schedule',
]);

export const ProfileContentSchema = z.object({
  kind: z.literal('profile'),
  memberId: idSchema('mbr'),
  field: ProfileFieldSchema,
  value: z.discriminatedUnion('field', [
    // `timezone` is a validated, canonicalised zone rather than a string, which is the whole point
    // of storing a profile field typed: `07`'s scheduling reads this directly.
    z.object({ field: z.literal('timezone'), tz: ianaTzSchema }),
    z.object({ field: z.literal('locale'), locale: z.string().max(35) }),
    z.object({ field: z.literal('languages'), languages: z.array(z.string().max(35)).max(8) }),
    z.object({ field: z.literal('preferred_name'), name: z.string().max(60) }),
    z.object({ field: z.literal('pronouns'), pronouns: z.string().max(30) }),
    z.object({
      field: z.literal('birthday'),
      month: z.int().min(1).max(12),
      day: z.int().min(1).max(31),
      /** Nullable: a birthday is often shared without a year, and guessing one is worse. */
      year: z.int().nullable(),
    }),
    z.object({
      field: z.literal('dietary'),
      diet: z.enum([
        'none',
        'vegetarian',
        'vegan',
        'pescatarian',
        'halal',
        'kosher',
        'jain',
        'gluten_free',
        'lactose_free',
        'other',
      ]),
      notes: z.string().max(120).nullable(),
    }),
    z.object({
      field: z.literal('allergy'),
      allergen: z.string().max(60),
      severity: z.enum(['mild', 'severe', 'unknown']),
    }),
    z.object({
      field: z.literal('schedule'),
      text: z.string().max(200),
      rrule: z.string().max(200).nullable(),
    }),
    z.object({ field: z.literal('contact_preference'), text: z.string().max(200) }),
    z.object({ field: z.literal('home_city'), city: z.string().max(80) }),
    z.object({
      field: z.literal('school'),
      name: z.string().max(120),
      grade: z.string().max(20).nullable(),
    }),
    z.object({ field: z.literal('work'), text: z.string().max(160) }),
    z.object({
      field: z.literal('relationship'),
      to: SubjectRefSchema,
      relation: RelationKindSchema,
    }),
  ]),
});

/**
 * `memory_items.content` (`02` §3.3.4), discriminated by `kind`.
 *
 * The discriminator is the same string as `memory_items.kind`, which is deliberate redundancy:
 * the column is indexed and queryable, the JSON is not, and a row whose two disagree is a
 * corruption the repository checks for (`M1-T18`).
 */
export const MemoryContentSchema = capped(
  z.discriminatedUnion('kind', [
    FactContentSchema,
    PreferenceContentSchema,
    DecisionContentSchema,
    CommitmentContentSchema,
    NoteContentSchema,
    ProfileContentSchema,
  ]),
  MEMORY_CONTENT_MAX_BYTES,
  'memory content',
);

export type MemoryContent = z.infer<typeof MemoryContentSchema>;
