/**
 * Memory (`02` §3.3.4; semantics in `04`, storage requirements in `04` §3.2.6 R1–R13).
 *
 * `01` §5 says a memory is **never hard-updated in place**, and almost every column here follows
 * from that one rule. A correction does not overwrite a fact; it creates a new item, points
 * `supersedes_id` at the old one, and sets the old one's `status` to `superseded` with a `valid_to`.
 * So the tables carry a *chain* rather than a current value, and three separate pieces of
 * machinery exist to make reading the head of that chain cheap:
 *
 *  - `retrieval_state` (`04` R5) is a denormalised 0–3 code — active-current, proposed, archived,
 *    history — maintained on every lifecycle transition. It is mirrored into the `state` metadata
 *    column of every vec0 space, where sqlite-vec evaluates it into a bitmap *before* computing
 *    distances. Without it, excluding superseded items from a KNN search would mean post-filtering
 *    results that the index already paid to rank;
 *  - `valid_from`/`valid_to` are **world time** while `created_at` is **system time** (`04` §3.2.5).
 *    That bitemporal split is what makes "what time was dinner *originally*?" answerable at all;
 *  - `memory_sources` is append-only, so a `REINFORCE` adds a row instead of rewriting the
 *    provenance JSON (`04` R13) — which would be an in-place update of the one column that records
 *    why the item is believed.
 *
 * ## `label_id` may only ever narrow
 *
 * `03` D17 and `04` D2 are jointly strict: a memory's label can be re-pointed, but only to a
 * **narrower** audience. Widening is a write-down, and invariant **I2** requires a recorded
 * declassification for that — so widening is not a relabel at all, it is a declassification with
 * its own row in `declassifications`. The column cannot express that rule; `M1-T18`'s repository
 * and `02` §3.5's I4 triggers enforce it.
 */
import {
  AuditActorSchema,
  EntityRefSchema,
  EntityRelationSchema,
  MemoryContentSchema,
  MemoryProvenanceSchema,
  SourceSpanSchema,
} from '@comvivo/core';
import { idSchema, z } from '@comvivo/shared';
import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  blob,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import {
  bool,
  boolCheckSql,
  createdAt,
  instantMs,
  jsonOf,
  labelRef,
  tid,
  updatedAt,
  version,
} from './_columns.js';
import { conversations, groups } from './groups.js';
import { messages } from './messages.js';

export const memoryItems = sqliteTable(
  'memory_items',
  {
    /** `04` R3: the ordering key, and the `rid` every per-memory table joins on. */
    rid: integer('rid').primaryKey({ autoIncrement: true }),
    id: tid('mem')('id').notNull().unique(),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    kind: text('kind', {
      enum: ['fact', 'preference', 'decision', 'commitment', 'note', 'profile'],
    }).notNull(),
    /** `04` §3.2.2's typed body. The discriminator duplicates `kind` deliberately. */
    content: jsonOf(MemoryContentSchema, 'memory_items.content')('content').notNull(),
    /** `04`'s canonical statement, ≤ 2 000 chars. The FTS `statement` column (`04` R4). */
    statement: text('statement').notNull(),
    /** The FTS `terms` column. */
    searchTerms: jsonOf(
      z.array(z.string().max(60)).max(8),
      'memory_items.search_terms',
    )('search_terms').notNull(),
    /** BCP 47 of the source, so a statement is searched with the right tokeniser. */
    language: text('language').notNull(),
    /** `04` §3.3.11 step 12: the exact-duplicate check. */
    fingerprint: blob('fingerprint', { mode: 'buffer' }).notNull(),
    /** May only be re-pointed to a **narrower** label (`03` D17, `04` D2). */
    labelId: labelRef().notNull(),
    provenance: jsonOf(MemoryProvenanceSchema, 'memory_items.provenance')('provenance').notNull(),
    confidence: real('confidence').notNull(),
    status: text('status', {
      enum: ['proposed', 'active', 'superseded', 'retracted'],
    }).notNull(),
    /** World time (`04` §3.2.5), not system time. */
    validFrom: instantMs('valid_from').notNull(),
    validTo: instantMs('valid_to'),
    supersedesId: tid('mem')('supersedes_id').references((): AnySQLiteColumn => memoryItems.id, {
      onDelete: 'set null',
    }),
    supersededById: tid('mem')('superseded_by_id'),
    contradicts: jsonOf(
      z.array(idSchema('mem')).max(20),
      'memory_items.contradicts',
    )('contradicts').notNull(),
    /** `07` entities (`04` §3.4.6). */
    links: jsonOf(z.array(EntityRefSchema).max(20), 'memory_items.links')('links').notNull(),
    /** `04` R5: 0 active-current, 1 proposed, 2 archived, 3 history. Mirrored in vec0 `state`. */
    retrievalState: integer('retrieval_state').notNull(),
    pinned: bool('pinned').notNull().default(false),
    pinnedAt: instantMs('pinned_at'),
    archivedAt: instantMs('archived_at'),
    lastConfirmedAt: instantMs('last_confirmed_at'),
    /** `rejected` | `expired` | `source_deleted` | `source_edited` | `input_changed` | … */
    retractReason: text('retract_reason'),
    /** The one I4 exception: a member-owned profile item may travel with them (`03`). */
    portable: bool('portable').notNull().default(false),
    embeddingState: text('embedding_state', { enum: ['pending', 'done', 'failed', 'skipped'] })
      .notNull()
      .default('pending'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    // Q-CTX-5 recency, Q-DASH-1.
    index('memory_group_status_updated_idx').on(t.groupId, t.status, t.updatedAt),
    // Q-MEM-1: walking a supersession chain. Partial — most items supersede nothing.
    index('memory_supersedes_idx').on(t.supersedesId).where(sql`${t.supersedesId} IS NOT NULL`),
    // Q-PRV-3 and label GC.
    index('memory_label_idx').on(t.labelId),
    // Q-JOB-6: the embedding backlog. Partial, so a caught-up instance has an empty index.
    index('memory_embed_pending_idx')
      .on(t.groupId, t.rid)
      .where(sql`${t.embeddingState} = 'pending' AND ${t.status} <> 'retracted'`),
    // Q-MEM-2: exact dedupe.
    index('memory_fingerprint_idx').on(t.groupId, t.fingerprint),
    // Q-MEM-3: the group-layer core, which is small and read on every turn.
    index('memory_pinned_idx').on(t.groupId).where(sql`${t.pinned} = 1`),
    check('memory_confidence_ck', sql`${t.confidence} BETWEEN 0 AND 1`),
    check('memory_state_ck', sql`${t.retrievalState} BETWEEN 0 AND 3`),
    check('memory_valid_ck', sql`${t.validTo} IS NULL OR ${t.validTo} >= ${t.validFrom}`),
    check('memory_pinned_bool_ck', boolCheckSql(t.pinned)),
    check('memory_portable_bool_ck', boolCheckSql(t.portable)),
  ],
);

/**
 * Who or what each memory is about (`02` §3.3.4).
 *
 * `subject_ref` is text rather than a typed id column because it holds either a TypeID
 * (`mbr_`/`evt_`/`tsk_`/`pln_`/`lst_`) or `'ent:<nfkc-lower name>'` for an unresolved external
 * name. One column with two shapes beats two nullable columns here: every query is "which memories
 * mention this subject", and that is one index lookup either way.
 */
export const memorySubjects = sqliteTable(
  'memory_subjects',
  {
    memoryRid: integer('memory_rid')
      .notNull()
      .references(() => memoryItems.rid, { onDelete: 'cascade' }),
    /** Denormalised; the cascade arrives through `memory_rid`. */
    groupId: tid('grp')('group_id').notNull(),
    /** A TypeID, or `'ent:<nfkc-lower name>'` for a name not yet resolved to an entity. */
    subjectRef: text('subject_ref').notNull(),
    role: text('role', { enum: ['about', 'by', 'for', 'mentions'] })
      .notNull()
      .default('about'),
  },
  (t) => [
    primaryKey({ columns: [t.memoryRid, t.subjectRef] }),
    // Q-CTX-4: the entity-match channel of retrieval.
    index('memory_subjects_lookup_idx').on(t.groupId, t.subjectRef, t.memoryRid),
  ],
);

/**
 * Append-only provenance sources (`04` R13).
 *
 * `source_ref` is a stable copy of the id, and it is the primary key component rather than
 * `message_id` — because the message may be swept by retention while the fact that this memory
 * came from it must survive. `message_id` is the live pointer and goes `NULL` when that happens;
 * `source_ref` is the record.
 */
export const memorySources = sqliteTable(
  'memory_sources',
  {
    memoryRid: integer('memory_rid')
      .notNull()
      .references(() => memoryItems.rid, { onDelete: 'cascade' }),
    /** A stable id copy that survives message expiry. */
    sourceRef: text('source_ref').notNull(),
    messageId: tid('msg')('message_id').references(() => messages.id, { onDelete: 'set null' }),
    windowKey: text('window_key'),
    span: jsonOf(SourceSpanSchema, 'memory_sources.span')('span'),
    addedAt: instantMs('added_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.memoryRid, t.sourceRef] }),
    // Q-PRV-5: the memory sources of a message, which erasure and edit-handling both walk.
    index('memory_sources_message_idx').on(t.messageId).where(sql`${t.messageId} IS NOT NULL`),
  ],
);

/**
 * One embedding model's vector space (`02` §3.3.4; `04` §3.8.6, R5).
 *
 * A space is a *table*, not a column: `04` R5 puts each one in its own vec0 table
 * (`vec_memory_<slug>`) so that changing the embedding model is a backfill into a new table rather
 * than a rewrite of every vector in place. `embedding_spaces_one_active_uq` is a partial unique
 * index on `status` — the only row with `status = 'active'` is the one being searched — which is
 * what makes the cutover a single `UPDATE` and makes two active spaces unrepresentable.
 */
export const embeddingSpaces = sqliteTable(
  'embedding_spaces',
  {
    id: tid('emb')('id').primaryKey(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    dims: integer('dims').notNull(),
    /** `vec_memory_<slug>`, slug matching `[a-z0-9_]{1,40}`. */
    tableName: text('table_name').notNull().unique(),
    status: text('status', {
      enum: ['building', 'ready', 'active', 'retired', 'failed'],
    }).notNull(),
    backfillCursorRid: integer('backfill_cursor_rid').notNull().default(0),
    createdAt: createdAt(),
    activatedAt: instantMs('activated_at'),
    retiredAt: instantMs('retired_at'),
  },
  (t) => [
    uniqueIndex('embedding_spaces_one_active_uq').on(t.status).where(sql`${t.status} = 'active'`),
    check('embedding_spaces_dims_ck', sql`${t.dims} > 0`),
  ],
);

/**
 * An external person, place or thing (`04` §3.2.3, R6).
 *
 * **Names only.** `04` §3.2.3 is explicit, and it is a privacy rule rather than a modelling
 * preference: an external person's attributes live in memory *items*, under those items' labels, so
 * there is no profile of a non-consenting third party sitting outside the information-flow system.
 * This table holds the entity's type, an optional relation to one member, and an `is_minor` hint
 * that drives `04`'s sensitivity floor.
 *
 * `is_minor` is **nullable with three meanings**: true, false, and *unknown*. A default of `false`
 * would turn "we have not been told" into "this is an adult", and `04` §3.2.3 makes the minor case
 * raise the sensitivity floor — so the unknown case has to be distinguishable from the safe one.
 */
export const memoryEntities = sqliteTable(
  'memory_entities',
  {
    id: tid('ent')('id').primaryKey(),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    entityType: text('entity_type', {
      enum: ['person', 'place', 'organization', 'pet', 'thing'],
    }).notNull(),
    /** `{ toMemberId, kind }` — "my mom" becomes `{ m1, parent }`. `NULL` = no known relation. */
    relation: jsonOf(EntityRelationSchema, 'memory_entities.relation')('relation'),
    /** Three-valued: true, false, or unknown. Unknown must not read as `false`. */
    isMinor: bool('is_minor'),
    /** `04` §3.2.3: ambiguous resolution records candidates instead of guessing. */
    possibleSameAs: jsonOf(
      z.array(idSchema('ent')).max(8),
      'memory_entities.possible_same_as',
    )('possible_same_as').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('memory_entities_group_idx').on(t.groupId),
    check('memory_entities_is_minor_ck', sql`${t.isMinor} IS NULL OR ${t.isMinor} IN (0, 1)`),
  ],
);

/**
 * An entity's names, each carrying the label of the item that introduced it (`04` §3.2.3, R6).
 *
 * `label_id` is part of the **primary key**, which is the whole design. The same entity may be
 * known as "Dr. Chen" in a DM and "the doctor" in the group, and those two aliases carry different
 * labels. Keying on `(entity_id, alias_norm, label_id)` means one alias learned under two labels is
 * two rows — so a lookup filtered by the audience's eligible labels sees only the names that
 * audience may know, and a therapist's name learned privately never surfaces in a group context.
 */
export const memoryEntityAliases = sqliteTable(
  'memory_entity_aliases',
  {
    entityId: tid('ent')('entity_id')
      .notNull()
      .references(() => memoryEntities.id, { onDelete: 'cascade' }),
    /** Denormalised; the cascade arrives through `entity_id`. */
    groupId: tid('grp')('group_id').notNull(),
    /** `normalizeForSearch` plus a transliteration fold (`04` §3.2.3). */
    aliasNorm: text('alias_norm').notNull(),
    aliasDisplay: text('alias_display').notNull(),
    /** The label of the item that introduced this alias. Part of the key, not an attribute. */
    labelId: labelRef().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.entityId, t.aliasNorm, t.labelId] }),
    // Q-CTX-8: alias lookup, filtered by the audience's eligible labels.
    index('memory_aliases_lookup_idx').on(t.groupId, t.aliasNorm, t.labelId),
  ],
);

/** Which entities a memory mentions (`04` R6). */
export const memoryItemEntities = sqliteTable(
  'memory_item_entities',
  {
    memoryRid: integer('memory_rid')
      .notNull()
      .references(() => memoryItems.rid, { onDelete: 'cascade' }),
    entityId: tid('ent')('entity_id')
      .notNull()
      .references(() => memoryEntities.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.memoryRid, t.entityId] }),
    // The reverse direction: every memory mentioning one entity.
    index('memory_item_entities_entity_idx').on(t.entityId, t.memoryRid),
  ],
);

/**
 * Where extraction last got to in each conversation (`04` R7).
 *
 * `last_rid` is `04`'s "last_seq" — `02` §3.3.4 settles that message order *is* `messages.rid`, so
 * there is no second sequence to keep in step. One row per conversation keyed by the conversation
 * itself, so a restart resumes rather than re-extracting a window it has already paid for.
 */
export const extractionCursors = sqliteTable('extraction_cursors', {
  conversationId: tid('cnv')('conversation_id')
    .primaryKey()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  /** `04`'s "last_seq". */
  lastRid: integer('last_rid').notNull().default(0),
  extractorVersion: text('extractor_version').notNull(),
  updatedAt: updatedAt(),
});

/**
 * Which reconcile operations have been applied (`04` R8).
 *
 * The idempotency record for extraction. A window produces a list of operations; this table makes
 * applying the same list twice a no-op, which matters because the extraction job can be retried
 * after a crash that happened *between* applying operation 3 and committing.
 */
export const memoryOpsApplied = sqliteTable(
  'memory_ops_applied',
  {
    windowKey: text('window_key').notNull(),
    opIndex: integer('op_index').notNull(),
    appliedAt: instantMs('applied_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.windowKey, t.opIndex] })],
);

/**
 * Content-free records of what has been forgotten (`04` R9).
 *
 * Three tables, because "forget that" has to survive the forgetting. If a memory is deleted and
 * nothing is recorded, the next extraction pass over the same conversation re-creates it — so the
 * suppression has to outlive the content, while holding none of it.
 *
 *  - `memory_tombstones` records that an id is gone, with a reason;
 *  - `forget_fingerprints` stores an **HMAC** of the content fingerprint, so a re-extraction can
 *    recognise the same item without the table being a searchable index of forgotten facts;
 *  - `forget_source_blocks` suppresses re-extraction from the same message, and expires with that
 *    message's retention so the block does not outlive its reason.
 */
export const memoryTombstones = sqliteTable('memory_tombstones', {
  memoryId: tid('mem')('memory_id').primaryKey(),
  groupId: tid('grp')('group_id').notNull(),
  forgottenAt: instantMs('forgotten_at').notNull(),
  reason: text('reason').notNull(),
});

export const forgetFingerprints = sqliteTable(
  'forget_fingerprints',
  {
    groupId: tid('grp')('group_id').notNull(),
    /** Keyed HMAC, not a raw hash: this table must not be a lookup index of forgotten content. */
    fpHmac: blob('fp_hmac', { mode: 'buffer' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.fpHmac] })],
);

export const forgetSourceBlocks = sqliteTable(
  'forget_source_blocks',
  {
    groupId: tid('grp')('group_id').notNull(),
    messageIdHmac: blob('message_id_hmac', { mode: 'buffer' }).notNull(),
    kind: text('kind').notNull(),
    subjectHash: blob('subject_hash', { mode: 'buffer' }).notNull(),
    /** Equals the source message's retention, so the block does not outlive its reason. */
    expiresAt: instantMs('expires_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.messageIdHmac, t.kind, t.subjectHash] }),
    index('forget_source_blocks_expiry_idx').on(t.expiresAt),
  ],
);

/**
 * The memory lifecycle audit (`04` R10).
 *
 * Ids only — no statement, no content. It answers "when did this become active, and who pinned
 * it?" without being a second copy of the memory, which matters because `02` §3.13.5 step 8 keeps
 * audit-shaped rows through an erasure precisely on the grounds that their ids carry no personal
 * data once `persons` is erased.
 */
export const memoryEvents = sqliteTable(
  'memory_events',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    memoryId: tid('mem')('memory_id').notNull(),
    /** `created` | `activated` | `superseded` | `retracted` | `forgotten` | `pinned` | … */
    type: text('type').notNull(),
    actor: jsonOf(AuditActorSchema, 'memory_events.actor')('actor').notNull(),
    at: instantMs('at').notNull(),
  },
  (t) => [index('memory_events_group_seq_idx').on(t.groupId, t.seq)],
);

/**
 * How far consolidation has read, and what it produced (`04` §3.7.1, R10).
 *
 * `watermark_seq` is a cursor into `memory_events`, and `section_hashes` lets consolidation skip a
 * section whose inputs have not changed — so the nightly job's cost is proportional to what moved
 * rather than to the size of the group's memory.
 */
export const memoryConsolidationState = sqliteTable('memory_consolidation_state', {
  groupId: tid('grp')('group_id')
    .primaryKey()
    .references(() => groups.id, { onDelete: 'cascade' }),
  watermarkSeq: integer('watermark_seq').notNull().default(0),
  sectionHashes: jsonOf(
    z.record(z.string().max(80), z.string().max(64)),
    'memory_consolidation_state.section_hashes',
  )('section_hashes').notNull(),
  updatedAt: updatedAt(),
});

/**
 * Retrieval counters, flushed by consolidation maintenance (`04` R13).
 *
 * A separate table rather than two columns on `memory_items`, because a retrieval must not be a
 * write to the item: `01` §5 forbids updating a memory in place, and counting a read as an update
 * would also bump `updated_at` — which Q-CTX-5 orders recency by, so every search would reorder
 * its own next result set.
 */
export const memoryAccessStats = sqliteTable(
  'memory_access_stats',
  {
    memoryRid: integer('memory_rid')
      .primaryKey()
      .references(() => memoryItems.rid, { onDelete: 'cascade' }),
    retrievedCount: integer('retrieved_count').notNull().default(0),
    lastRetrievedAt: instantMs('last_retrieved_at'),
  },
  (t) => [check('memory_access_count_ck', sql`${t.retrievedCount} >= 0`)],
);
