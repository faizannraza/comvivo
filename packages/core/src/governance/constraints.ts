/**
 * Private constraints: the declassifier's output (`03` §3.5).
 *
 * A constraint is how a private fact changes group-facing behaviour **without being disclosed**.
 * "I can't do Tuesdays" becomes an `availability.busy` the scheduler obeys, while the reason stays
 * sealed under the owner's label. That split is what `constraint_records` stores twice over: a
 * public `label_id` covering the constraint, and a `sealed_label_id` covering the source
 * references it was derived from.
 */
import { idSchema, timeZoneIdSchema, z } from '@comvivo/shared';
import { jsonObjectShape, storageContract } from '../domain/storage-contract.js';

/**
 * `03` §3.5.4's catalog keys (`CONSTRAINT_KINDS_V1`).
 *
 * A closed catalog, versioned by `constraint_records.catalog_version`, because `03` DC2 requires
 * the value schemas to be closed — no free text anywhere in a constraint. A kind the running build
 * does not know is a row it must refuse to act on rather than guess about.
 */
export const CONSTRAINT_KINDS_V1 = [
  'availability.busy',
  'schedule.do_not_schedule',
  'tasks.do_not_assign',
  'capacity.reduced',
  'needs.dietary',
  'needs.accessibility',
  'preference.flag',
  'budget.cap',
  'location.granularity',
  'awareness',
  'secrecy.surprise',
  'content.age_appropriate',
  'topic.avoid',
] as const;

export const ConstraintKindSchema = z.enum(CONSTRAINT_KINDS_V1);

export type ConstraintKind = (typeof CONSTRAINT_KINDS_V1)[number];

/**
 * `03` §3.5.3's `PrivateConstraintPolicy`: what a member allows to be derived from their data.
 *
 * `paused` is the whole-feature off switch — "don't use my private info at all" — and it is a
 * separate field rather than setting every kind to `never`, so that pausing and resuming does not
 * destroy the per-kind choices a member made.
 *
 * `allowStandingForSensitive` defaults to **false**: a standing approval means future constraints
 * of that kind need no per-item consent, and `03` will not let that cover sensitive sources unless
 * the member says so explicitly.
 */
export const PrivateConstraintPolicySchema = z.object({
  memberId: idSchema('mbr'),
  version: z.int().min(0),
  /**
   * `z.partialRecord`, as `03` §3.5.3 writes it — **not** `z.record`.
   *
   * Measured on zod 4.6: `z.record` over an enum key is **exhaustive**, so it demands an entry for
   * all thirteen kinds and rejects a member who has configured one. `partialRecord` keeps the
   * key-set closed (an unknown kind is still refused) while letting the record be sparse, which is
   * what a per-kind opt-in has to be. Found by a test asserting the realistic case.
   */
  kinds: z.partialRecord(
    ConstraintKindSchema,
    z.object({
      mode: z.enum(['ask', 'always', 'never']),
      maxSourceSensitivity: z.enum(['normal', 'personal', 'sensitive']),
      defaultAttribution: z.enum(['named', 'unattributed', 'aggregate_only']),
      defaultReason: z.enum(['none', 'personal', 'work', 'travel', 'family', 'medical']),
    }),
  ),
  allowStandingForSensitive: z.boolean(),
  approvalTtlHours: z.int().min(1).max(336),
  /** "Don't use my private info at all." Distinct from every kind being `never`. */
  paused: z.boolean(),
});

export type PrivateConstraintPolicy = z.infer<typeof PrivateConstraintPolicySchema>;

/**
 * `constraint_records.scope`: when and where a constraint applies.
 *
 * Bounded in time because a constraint that never expires is one nobody remembers agreeing to —
 * `03` §3.5.4 gives most kinds an `until`, and the record's own `valid_from`/`valid_to` columns
 * carry the resolved window. This narrows it further: a constraint may apply only to some
 * conversations or some task categories.
 */
export const ConstraintScopeSchema = z.object({
  /** Empty means the whole group. */
  conversationIds: z.array(idSchema('cnv')).max(50),
  /** For `tasks.do_not_assign` and friends. Empty means all. */
  categories: z.array(z.string().max(80)).max(50),
  /** The zone the window was expressed in, for rendering it back. */
  zone: timeZoneIdSchema.nullable(),
});

export type ConstraintScope = z.infer<typeof ConstraintScopeSchema>;

/**
 * `constraint_records.value` — a **storage contract** (see `domain/storage-contract.ts`).
 *
 * `03` §3.5.4 tabulates a distinct value schema for each of the thirteen kinds, and `M5-T7` builds
 * that catalog: "one file per kind, envelope, `CONSTRAINT_KINDS_V1`, `render.ts`, `validate.ts`",
 * proven by `declassify.prop.closed_schema`. Transcribing thirteen schemas here would duplicate
 * that task and would do it without the property test that gives it meaning.
 *
 * What is pinned and enforced now: a JSON object, capped at 16 KiB. `kind` lives in its own
 * column, so the value carries no discriminator of its own and `M5-T7` will dispatch on the
 * column — which is also why a union here could not be validated usefully today.
 */
export const ConstraintValueSchema = storageContract(
  'ConstraintValueSchema',
  jsonObjectShape,
  'constraint value',
);
