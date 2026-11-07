/**
 * TypeIDs: the prefix registry, the branded types, and parsing (`02` §3.1, ADR-019).
 *
 * An id here is `<prefix>_<26 characters of Crockford base32>` — a UUIDv7 in a readable,
 * time-sortable encoding with its entity type written on the front. Three properties follow, and
 * all three are load-bearing rather than pleasant:
 *
 *  - **The type is in the value.** `grp_01jd8…` in a log, an audit row or a URL says what it is
 *    without a join. Polymorphic references (`target_ref`, `source_ref`, `entity_refs`) have no
 *    foreign key at all; the prefix *is* the type, enforced by a CHECK (`02` §3.1).
 *  - **The type is in the static type.** `Id<'grp'>` is not assignable to `Id<'mbr'>`. The single
 *    worst bug this codebase can have is operating on the wrong group or the wrong member, because
 *    that is invariant **I4 (group isolation)** or **I3 (requester authority)** failing silently
 *    and plausibly. This turns that class of leak into a compile error.
 *  - **Ids sort by creation order.** The turn journal and the outbox read id order *as* sequence
 *    (`01` §6.2, invariants I6 and I7), so the generator is monotonic within a millisecond.
 *
 * Generation is a port (`ports/ids.ts`), injected, so `core` stays pure and tests get reproducible
 * ids. This module is the pure half: the registry, the brand, and the parser.
 */
import { err, ok, type Result } from './result.js';
import { z } from './zod.js';

/**
 * Every id prefix in the product, from `02` §3.1.
 *
 * One registry rather than a prefix string at each call site: `02` §3.3.13 makes "every entity has
 * a table" a CI check, and this is the matching promise for ids. A prefix invented inline would
 * typecheck, produce a plausible id, and be invisible until something tried to parse it back.
 *
 * TypeID's own rule is `[a-z]([a-z_]{0,61}[a-z])?`, asserted over the whole registry in the tests.
 */
export const ID_PREFIX = {
  // --- Core (02) -------------------------------------------------------------------------------
  instance: 'inst',
  person: 'prs',
  channelIdentity: 'chid',
  group: 'grp',
  member: 'mbr',
  conversation: 'cnv',
  message: 'msg',
  attachment: 'att',
  memory: 'mem',
  embeddingSpace: 'emb',
  event: 'evt',
  reminder: 'rem',
  task: 'tsk',
  rotation: 'rot',
  ledgerEntry: 'lde',
  list: 'lst',
  listItem: 'lsti',
  poll: 'pol',
  plan: 'pln',
  planStep: 'plns',
  decision: 'dec',
  constitutionVersion: 'cnst',
  proposal: 'prp',
  declassification: 'dcl',
  consentEvent: 'cev',
  turn: 'trn',
  turnEffect: 'tfx',
  turnTrace: 'trc',
  audit: 'aud',
  outbox: 'obx',
  job: 'job',
  jobSchedule: 'jsch',
  usage: 'use',
  deletion: 'del',
  linkCode: 'lnk',
  // --- Group intelligence (03) -----------------------------------------------------------------
  constraint: 'cst',
  standingApproval: 'sap',
  confirmation: 'cnf',
  // --- Memory (04) -----------------------------------------------------------------------------
  entity: 'ent',
  // --- Channels (06) ---------------------------------------------------------------------------
  chatBinding: 'chb',
  interactionToken: 'itk',
  claimCode: 'clm',
  // --- Coordination (07) -----------------------------------------------------------------------
  reminderFiring: 'rfr',
  calendarSubscription: 'csub',
  icsFeedToken: 'ift',
  taskSwap: 'swp',
  proactiveCandidate: 'pcd',
  // --- Dashboard, API, CLI (09) ----------------------------------------------------------------
  session: 'sess',
  loginToken: 'ltk',
  pairing: 'pair',
  inviteCode: 'inv',
  stepUp: 'stu',
  export: 'exp',
  // --- Extensibility (10) ----------------------------------------------------------------------
  plugin: 'plg',
  pluginVersion: 'plv',
  groupExtension: 'gex',
  delegation: 'dlg',
  mcpToken: 'mtk',
  mcpServer: 'mcs',
  skill: 'skl',
  // --- Quality (11) ----------------------------------------------------------------------------
  feedback: 'fbk',
} as const satisfies Record<string, string>;

/** The entity names the registry is keyed by, e.g. `group`, `member`. */
export type IdEntity = keyof typeof ID_PREFIX;

/** A closed union of every prefix. A typo is a compile error, not a runtime surprise. */
export type IdPrefix = (typeof ID_PREFIX)[IdEntity];

declare const idBrand: unique symbol;

/**
 * A TypeID for prefix `P`.
 *
 * Branded on the **prefix itself**, not on a separately supplied name. An earlier shape took the
 * brand as a second argument, which meant `generate('grp', 'member')` typechecked and produced a
 * group id branded as a member — the exact confusion the branding exists to prevent.
 */
export type Id<P extends IdPrefix> = `${P}_${string}` & { readonly [idBrand]: P };

// One alias per entity, so call sites read as domain language rather than as string generics.
export type InstanceId = Id<'inst'>;
export type PersonId = Id<'prs'>;
export type ChannelIdentityId = Id<'chid'>;
export type GroupId = Id<'grp'>;
export type MemberId = Id<'mbr'>;
export type ConversationId = Id<'cnv'>;
export type MessageId = Id<'msg'>;
export type AttachmentId = Id<'att'>;
export type MemoryId = Id<'mem'>;
export type EmbeddingSpaceId = Id<'emb'>;
export type EventId = Id<'evt'>;
export type ReminderId = Id<'rem'>;
export type TaskId = Id<'tsk'>;
export type RotationId = Id<'rot'>;
export type LedgerEntryId = Id<'lde'>;
export type ListId = Id<'lst'>;
export type ListItemId = Id<'lsti'>;
export type PollId = Id<'pol'>;
export type PlanId = Id<'pln'>;
export type PlanStepId = Id<'plns'>;
export type DecisionId = Id<'dec'>;
export type ConstitutionVersionId = Id<'cnst'>;
export type ProposalId = Id<'prp'>;
export type DeclassificationId = Id<'dcl'>;
export type ConsentEventId = Id<'cev'>;
export type TurnId = Id<'trn'>;
export type TurnEffectId = Id<'tfx'>;
export type TurnTraceId = Id<'trc'>;
export type AuditId = Id<'aud'>;
export type OutboxId = Id<'obx'>;
export type JobId = Id<'job'>;
export type JobScheduleId = Id<'jsch'>;
export type UsageId = Id<'use'>;
export type DeletionId = Id<'del'>;
export type LinkCodeId = Id<'lnk'>;
export type ConstraintId = Id<'cst'>;
export type StandingApprovalId = Id<'sap'>;
export type ConfirmationId = Id<'cnf'>;
export type EntityId = Id<'ent'>;
export type ChatBindingId = Id<'chb'>;
export type InteractionTokenId = Id<'itk'>;
export type ClaimCodeId = Id<'clm'>;
export type ReminderFiringId = Id<'rfr'>;
export type CalendarSubscriptionId = Id<'csub'>;
export type IcsFeedTokenId = Id<'ift'>;
export type TaskSwapId = Id<'swp'>;
export type ProactiveCandidateId = Id<'pcd'>;
export type SessionId = Id<'sess'>;
export type LoginTokenId = Id<'ltk'>;
export type PairingId = Id<'pair'>;
export type InviteCodeId = Id<'inv'>;
export type StepUpId = Id<'stu'>;
export type ExportId = Id<'exp'>;
export type PluginId = Id<'plg'>;
export type PluginVersionId = Id<'plv'>;
export type GroupExtensionId = Id<'gex'>;
export type DelegationId = Id<'dlg'>;
export type McpTokenId = Id<'mtk'>;
export type McpServerId = Id<'mcs'>;
export type SkillId = Id<'skl'>;
export type FeedbackId = Id<'fbk'>;

/**
 * The 26-character suffix: Crockford base32, lowercase, first character `0`–`7`.
 *
 * The leading-character bound is not decoration. 26 base32 characters carry 130 bits, and a UUID
 * is 128, so the top three bits must be zero — a suffix starting at `8` or above decodes to a
 * value larger than any UUID. TypeID's own validator rejects it, and so must ours, or
 * `parseId` would accept ids that `typeid-js` then refuses.
 *
 * Crockford base32 excludes `i`, `l`, `o` and `u`, which is why the class is written out.
 */
const SUFFIX = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;

/** TypeID's prefix rule, from the specification. */
const PREFIX_RULE = /^[a-z]([a-z_]{0,61}[a-z])?$/;

/** Why a string is not the id it was supposed to be. */
export type IdErrorKind =
  | 'empty'
  | 'missing_separator'
  | 'wrong_prefix'
  | 'suffix_length'
  | 'suffix_charset'
  | 'suffix_overflow';

export interface IdError {
  readonly kind: IdErrorKind;
  /** The prefix that was expected. */
  readonly expected: IdPrefix;
  /** What a developer should do about it. Never includes the whole input (`08` §3.10). */
  readonly message: string;
}

/**
 * Parse `s` as an id with prefix `prefix`. Pure, total, and never throws.
 *
 * Deliberately returns a `Result` rather than throwing: this runs at every storage boundary
 * (`02` §3.1's `tid` column type) and on every API and tool input, and a throw at that depth is a
 * 500 where a typed failure is a fix-it message.
 *
 * The error never carries the whole input. A malformed id is usually a copy-paste of something
 * else, and "something else" at a security boundary is often a token (`08` §3.10 S2).
 */
export function parseId<P extends IdPrefix>(prefix: P, s: string): Result<Id<P>, IdError> {
  const fail = (kind: IdErrorKind, message: string): Result<Id<P>, IdError> =>
    err({ kind, expected: prefix, message });

  if (s === '') return fail('empty', `expected a "${prefix}_…" id, got an empty string`);

  const separator = s.indexOf('_');
  if (separator === -1) {
    return fail('missing_separator', `expected a "${prefix}_…" id, which has no "_" in it`);
  }
  if (s.slice(0, separator) !== prefix) {
    // The prefix is safe to echo: it is one of ~60 known constants, not user data.
    return fail(
      'wrong_prefix',
      `expected a "${prefix}_…" id but the prefix was "${s.slice(0, separator)}"`,
    );
  }

  const suffix = s.slice(separator + 1);
  if (suffix.length !== 26) {
    return fail(
      'suffix_length',
      `expected 26 characters after "${prefix}_", got ${String(suffix.length)}`,
    );
  }
  if (!SUFFIX.test(suffix)) {
    // Distinguish the two reasons, because they mean different mistakes: a bad character is
    // usually a transcription error (`l` for `1`, `O` for `0`), while a leading `8`–`z` is usually
    // a 26-character string that was never a TypeID at all.
    const kind: IdErrorKind = /^[0-9a-hjkmnp-tv-z]{26}$/.test(suffix)
      ? 'suffix_overflow'
      : 'suffix_charset';
    return fail(
      kind,
      kind === 'suffix_overflow'
        ? `the suffix must start with 0–7: 26 base32 characters hold 130 bits and a UUID is 128`
        : 'the suffix must be 26 lowercase Crockford base32 characters (no i, l, o or u)',
    );
  }

  return ok(s as Id<P>);
}

/** `true` when `s` is an id with this prefix. */
export function isId<P extends IdPrefix>(prefix: P, s: string): s is Id<P> {
  return parseId(prefix, s).ok;
}

/**
 * The prefix of a well-formed id, or `undefined`.
 *
 * For the polymorphic references in `02` §3.1 (`target_ref`, `source_ref`, `entity_refs`), where
 * the prefix is the only thing that says what the row points at.
 */
export function prefixOf(s: string): IdPrefix | undefined {
  const separator = s.indexOf('_');
  if (separator === -1) return undefined;
  const candidate = s.slice(0, separator);
  return (KNOWN_PREFIXES as readonly string[]).includes(candidate)
    ? (candidate as IdPrefix)
    : undefined;
}

/** Every prefix, frozen, for validation and for the CHECK constraints `02` §3.1 generates. */
export const KNOWN_PREFIXES: readonly IdPrefix[] = Object.freeze(Object.values(ID_PREFIX));

/** TypeID's prefix rule, exported so the registry test and `02`'s CHECK generator share it. */
export function isValidPrefix(candidate: string): boolean {
  return PREFIX_RULE.test(candidate);
}

/**
 * A zod schema for an id with this prefix.
 *
 * Every boundary validates with zod (`01` §11.2), and an id is the most common field at every one
 * of them. The schema reports the same distinctions `parseId` does, so an API error and a storage
 * error say the same thing about the same string.
 */
export const idSchema = <P extends IdPrefix>(prefix: P): z.ZodType<Id<P>> =>
  z
    .string()
    .superRefine((value, context) => {
      const parsed = parseId(prefix, value);
      if (!parsed.ok) {
        context.addIssue({ code: 'custom', message: parsed.error.message });
      }
    })
    .transform((value) => value as Id<P>);

/**
 * Narrow a parse result or throw.
 *
 * For the places where a malformed id means the **database** is corrupt rather than the input
 * being wrong — `02` §3.1's `tid` column mapper, which reads a value this process wrote. There,
 * continuing with a bad value is worse than crashing.
 */
export function unwrapId<P extends IdPrefix>(result: Result<Id<P>, IdError>, code: string): Id<P> {
  if (result.ok) return result.value;
  throw new Error(`${code}: ${result.error.message}`);
}

/* ─────────────────────── Interned integer ids (`02` §3.2) ─────────────────────── */

declare const internedBrand: unique symbol;

/**
 * An interned row id: a branded `AUTOINCREMENT` integer, not a TypeID.
 *
 * `02` §3.2's `labels` and `reader_sets` are **interned** — one row per distinct value per group,
 * found by `canonical_key` and created on first use. Three reasons they are integers where every
 * aggregate above is a TypeID, and the first is the one that decides it:
 *
 *  - **Every labeled row carries one.** A `label_id` is a foreign key on messages, memories,
 *    events, tasks, lists, polls and more, so it is one of the most repeated values in the
 *    database. A 30-character TypeID per row against a 4-byte integer is a real difference in
 *    file size, in index size, and therefore in how much of the index fits in the page cache —
 *    which `02` §3.6.2 measured as a 100× difference on vector search.
 *  - **They are never exposed.** A TypeID's value is that it is safe to put in a URL or a log and
 *    says what it refers to. A label id appears in neither: `01` §7.2's `Label` is what crosses a
 *    boundary, and the id is an implementation detail of one instance's database.
 *  - **Interning needs a cheap identity.** `LabelStore.intern` is a get-or-create on every write,
 *    and comparing integers is what makes the in-memory `Map<LabelId, Label>` cache worth having.
 *
 * Branded so a `LabelId` cannot be passed where a `ReaderSetId` belongs. They are both integers
 * from the same generator-shaped source, which is exactly when a brand earns its place: the
 * mistake typechecks otherwise and the symptom is a row labeled with somebody else's audience.
 */
export type InternedId<Table extends string> = number & {
  readonly [internedBrand]: Table;
};

/** `02` §3.2: an interned `Label`, including its reader set, owner, sensitivity and influence. */
export type LabelId = InternedId<'labels'>;

/** `02` §3.2: an interned `Audience` — a group, or a member set, plus any outsider seats. */
export type ReaderSetId = InternedId<'reader_sets'>;

/**
 * Narrow a database integer to an interned id.
 *
 * Checked rather than cast, because the value comes from a column and a non-integer or negative
 * one means the row is corrupt — the same reasoning as `unwrapId`. `AUTOINCREMENT` starts at 1, so
 * zero is as wrong as a negative.
 */
export function internedId<Table extends string>(value: number, table: Table): InternedId<Table> {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`STORAGE_ID_INVALID: ${table}.id is ${String(value)}, not a positive integer`);
  }
  return value as InternedId<Table>;
}
