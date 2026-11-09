/**
 * A memory item as a domain object (`02` §3.3.4; semantics in `04`).
 *
 * ## `rid` and `id`, again
 *
 * Same split as `messages` and for the same reasons: `rid` is the ordering and the key every
 * search index joins on (`memory_fts.rowid`, the vec0 `rid`), and `id` is the identity every other
 * table and every API response carries.
 *
 * ## Content is immutable
 *
 * `01` §5: a memory is "never hard-updated in place", enforced by
 * `trg_memory_items_immutable` over `content`, `statement`, `search_terms`, `kind`, `group_id` and
 * `provenance`. A correction is a **new item that supersedes the old one**, which is what makes the
 * supersede chain an honest record of what the group believed and when. So `NewMemoryItem` below
 * carries every immutable field and no repository method can change one.
 *
 * ## Retrieval state is derived, not chosen
 *
 * `04` R5 defines four codes and `02` §3.3.4 says the column "is maintained by the memory
 * repository on every lifecycle transition". `retrievalStateFor` is that derivation, written once
 * here as a pure function so the repository and `04`'s nightly maintenance cannot disagree — and a
 * disagreement would be invisible, because the state is a *filter*: too high and an item stops
 * being retrievable, too low and a superseded item answers as current.
 */
import type { GroupId, LabelId, MemoryId, MessageId } from '@comvivo/shared';
import { Temporal } from 'temporal-polyfill';
import type { EntityRef } from '../domain/entity-ref.js';
import type { MemoryContent } from './kinds.js';
import type { MemoryProvenance, SourceSpan } from './provenance.js';

/** `02` §3.3.4's `memory_items.kind` (`04` §3.2.2). */
export const MEMORY_KINDS = [
  'fact',
  'preference',
  'decision',
  'commitment',
  'note',
  'profile',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/**
 * `02` §3.3.4's `memory_items.status`.
 *
 * `retracted` is the terminal one and is the only status that removes an item from **both** search
 * indexes (`04` R5). `superseded` keeps the row retrievable as history, because "what did we think
 * last month" is a question the product answers.
 */
export const MEMORY_STATUSES = ['proposed', 'active', 'superseded', 'retracted'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/**
 * `04` R5's retrieval-state codes, as a named union rather than bare integers.
 *
 * Stored as an integer because it is compared with `<=` in both the FTS and the vec0 queries, and
 * mirrored in the vec0 `state` metadata column. The names exist so a call site reads as a decision
 * about retrievability rather than as a magic number.
 */
export const RETRIEVAL_STATES = {
  /** Current and readable: the default answer to a question. */
  activeCurrent: 0,
  /** Awaiting confirmation (`04`): retrievable at `maxState >= 1`, which is the default. */
  proposed: 1,
  /** Aged out or demoted, still available when a caller asks for more. */
  archived: 2,
  /** Superseded, or archived past its validity: "what did we think then". */
  history: 3,
} as const;

export type RetrievalState = (typeof RETRIEVAL_STATES)[keyof typeof RETRIEVAL_STATES];

/** `02` §3.3.4's `memory_items.embedding_state`. */
export const EMBEDDING_STATES = ['pending', 'done', 'failed', 'skipped'] as const;
export type EmbeddingState = (typeof EMBEDDING_STATES)[number];

/**
 * `02` §3.3.4's `memory_items.retract_reason`.
 *
 * A closed set here where the column is free text, because every value the product produces is
 * one of these and an unconstrained column is how a dashboard ends up with six spellings of
 * "expired". `04` owns when each applies.
 */
export const RETRACT_REASONS = [
  'rejected',
  'expired',
  'source_deleted',
  'source_edited',
  'input_changed',
  'forgotten',
  'superseded',
] as const;
export type RetractReason = (typeof RETRACT_REASONS)[number];

/** `02` §3.3.4's `memory_subjects.role`. */
export const SUBJECT_ROLES = ['about', 'by', 'for', 'mentions'] as const;
export type SubjectRole = (typeof SUBJECT_ROLES)[number];

/**
 * One row of `memory_subjects` (`02` §3.3.4).
 *
 * `ref` is the column's own spelling — a TypeID, or `ent:<nfkc-lower name>` for an external entity
 * named before it has an id. It is deliberately **not** `core`'s `SubjectRef` union: the column
 * stores a single text value and is part of a primary key, so one encoding is the point.
 * `subjectRefToColumn` is the only place the two meet.
 */
export interface MemorySubject {
  readonly ref: string;
  readonly role: SubjectRole;
}

/**
 * One row of `memory_sources` (`02` §3.3.4; `04` R13 "append-only provenance sources").
 *
 * `ref` is a **stable copy** of the source id and survives the message expiring — which is the
 * whole reason the column exists beside `messageId`, whose foreign key is `ON DELETE SET NULL`.
 * So a memory can still say "this came from a message on the 3rd" after the message is gone.
 */
export interface MemorySource {
  readonly ref: string;
  readonly messageId: MessageId | undefined;
  readonly windowKey: string | undefined;
  readonly span: SourceSpan | undefined;
  readonly addedAt: Temporal.Instant;
}

/** A stored memory item (`02` §3.3.4). */
export interface MemoryItem {
  readonly rid: number;
  readonly id: MemoryId;
  readonly groupId: GroupId;
  readonly kind: MemoryKind;
  readonly content: MemoryContent;
  /** `04`'s canonical statement, and the `statement` column of `memory_fts`. */
  readonly statement: string;
  readonly searchTerms: readonly string[];
  /** BCP-47 of the source. */
  readonly language: string;
  readonly fingerprint: Uint8Array;
  /** `03` D17 / `04` D2: may only ever be re-pointed to a **narrower** label. */
  readonly labelId: LabelId;
  readonly provenance: MemoryProvenance;
  readonly confidence: number;
  readonly status: MemoryStatus;
  readonly validFrom: Temporal.Instant;
  readonly validTo: Temporal.Instant | undefined;
  readonly supersedesId: MemoryId | undefined;
  readonly supersededById: MemoryId | undefined;
  readonly contradicts: readonly MemoryId[];
  readonly links: readonly EntityRef[];
  readonly retrievalState: RetrievalState;
  readonly pinned: boolean;
  readonly pinnedAt: Temporal.Instant | undefined;
  readonly archivedAt: Temporal.Instant | undefined;
  readonly lastConfirmedAt: Temporal.Instant | undefined;
  readonly retractReason: string | undefined;
  /** `I4` exception: a member-owned profile item may travel with them (`03`). */
  readonly portable: boolean;
  readonly embeddingState: EmbeddingState;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
  readonly version: number;
}

/**
 * What a caller supplies to create a memory item.
 *
 * Absent by design: `rid` (SQLite assigns it), `labelId` (the repository interns from a `Label`,
 * per `02` §3.2), `retrievalState` (derived — see `retrievalStateFor`), `supersededById` (set by
 * the *superseding* write), `fingerprint` (`04` §3.3.11 derives it, and two callers deriving it
 * differently would defeat Q-MEM-2's exact-duplicate index), and `embeddingState` (always
 * `pending` on insert; the `embed.items` job moves it).
 */
export interface NewMemoryItem {
  readonly id: MemoryId;
  readonly groupId: GroupId;
  readonly kind: MemoryKind;
  readonly content: MemoryContent;
  readonly statement: string;
  readonly searchTerms: readonly string[];
  readonly language: string;
  readonly provenance: MemoryProvenance;
  readonly confidence: number;
  readonly status: MemoryStatus;
  readonly validFrom: Temporal.Instant;
  readonly validTo?: Temporal.Instant | undefined;
  readonly supersedesId?: MemoryId | undefined;
  readonly contradicts?: readonly MemoryId[] | undefined;
  readonly links?: readonly EntityRef[] | undefined;
  readonly pinned?: boolean | undefined;
  readonly portable?: boolean | undefined;
  /** `02` §3.3.4's `memory_subjects` rows, written in the same transaction. */
  readonly subjects?: readonly MemorySubject[] | undefined;
  /** `02` §3.3.4's `memory_sources` rows, written in the same transaction (`04` R13). */
  readonly sources?: readonly Omit<MemorySource, 'addedAt'>[] | undefined;
}

/**
 * `04` R5's retrieval state for an item, from its lifecycle fields.
 *
 * The order of the tests is the rule, so it is worth reading as one:
 *
 *  1. **`superseded`** → `history`. Something newer answers the question now.
 *  2. **`archived`** → `history` if its validity has passed, else `archived`. `04` §3.7's
 *     maintenance table distinguishes these: an item archived *because* `validTo` passed is
 *     history, and one archived for disuse is merely archived and can come back.
 *  3. **`proposed`** → `proposed`.
 *  4. Otherwise **`activeCurrent`**.
 *
 * `retracted` is not a state here at all, because a retracted item is **removed** from both
 * indexes (`04` R5) rather than filtered within them — so asking for its retrieval state is a
 * question with no useful answer, and the repository never writes one.
 */
export function retrievalStateFor(item: {
  readonly status: MemoryStatus;
  readonly archivedAt: Temporal.Instant | undefined;
  readonly validTo: Temporal.Instant | undefined;
  readonly now: Temporal.Instant;
}): RetrievalState {
  if (item.status === 'superseded') return RETRIEVAL_STATES.history;
  if (item.archivedAt !== undefined) {
    const expired = item.validTo !== undefined && Temporal.Instant.compare(item.validTo, item.now) < 0;
    return expired ? RETRIEVAL_STATES.history : RETRIEVAL_STATES.archived;
  }
  if (item.status === 'proposed') return RETRIEVAL_STATES.proposed;
  return RETRIEVAL_STATES.activeCurrent;
}

/**
 * The `memory_subjects.subject_ref` text for a `core` `SubjectRef`.
 *
 * The one place the union and the column meet. `group` has no id of its own, so it is spelled
 * `'group'` — the same sentinel choice `Label.owner` makes, and for the same reason: a case to
 * handle reads better than a value that might be missing.
 */
export function subjectRefToColumn(
  ref:
    | { readonly type: 'member'; readonly memberId: string }
    | { readonly type: 'group' }
    | { readonly type: 'entity'; readonly entityId: string },
): string {
  switch (ref.type) {
    case 'member':
      return ref.memberId;
    case 'group':
      return 'group';
    case 'entity':
      return ref.entityId;
  }
}
