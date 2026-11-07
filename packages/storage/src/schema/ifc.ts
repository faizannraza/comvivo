/**
 * Information-flow control: reader sets, labels and recorded declassifications (`02` §3.3.2).
 *
 * These four tables are the physical form of invariants **I1** (no read-up) and **I2** (no
 * write-down). Every datum in the product carries a `label_id`, a label names the set of readers
 * who may see it, and a declassification is the only recorded way a value moves to a wider label.
 *
 * ## Why labels and reader sets are interned integers
 *
 * `02` §3.2 interns both, with `INTEGER PRIMARY KEY AUTOINCREMENT` rather than a TypeID. A label
 * reference appears on *every* row of `messages`, `memory_items` and a dozen coordination tables,
 * and eligibility filtering works by `label_id IN (…)` over a set computed once per turn. A
 * 26-character TypeID in that position would multiply the size of the hottest index in the
 * database and turn an integer set membership test into a string one.
 *
 * `AUTOINCREMENT` and not plain `INTEGER PRIMARY KEY`: SQLite reuses the highest rowid after a
 * delete unless `AUTOINCREMENT` is present, and a reused label id would silently re-point every
 * row that still referenced the old one. Labels are append-only (`02` §3.13.5 step 8 keeps them
 * through an erasure for exactly this reason), so the monotonic counter is the guarantee.
 *
 * ## Why `label_id` columns carry no foreign key
 *
 * `labelRef()` deliberately produces a plain `INTEGER` with no `REFERENCES`, here and in
 * `messages.ts`. That is not an oversight:
 *
 *  - labels are interned and **never deleted** — `02` §3.2 makes interning append-only and
 *    §3.13.5 step 8 keeps label rows even when the member they reference is erased — so a dangling
 *    `label_id` cannot arise from a delete;
 *  - a foreign key on `messages.label_id` would add a parent lookup to every insert on the
 *    ingestion fast path, which `M1-T17` holds to a 3 ms p95;
 *  - and the integrity question that actually matters is not "does this label exist" but "does it
 *    belong to this row's group", which a single-column foreign key cannot express anyway.
 *
 * `02` §3.5's I4 label triggers (`M1-T13`) are what enforce the group-agreement rule.
 */
import { DeclassApproverSchema, EntityRefSchema } from '@comvivo/core';
import { idSchema, type LabelId, z } from '@comvivo/shared';
import { sql } from 'drizzle-orm';
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { bool, boolCheckSql, createdAt, instantMs, jsonOf, labelRef, tid } from './_columns.js';
import { groups, members } from './groups.js';

/**
 * A set of readers (`02` §3.3.2).
 *
 * `kind='group'` means "everyone in the group, as of now" and stores no members at all —
 * `member_count` is 0 — because membership is resolved through `groups.membership_epoch` at read
 * time. That is what makes a departure take effect everywhere at once (`02` §3.13.6) instead of
 * requiring every reader set in the group to be rewritten.
 *
 * `canonical_key` is the interning key: a deterministic encoding of the set, so the same audience
 * computed twice yields the same row. `reader_sets_group_key_uq` is both the uniqueness guarantee
 * and the lookup the interning path uses.
 */
export const readerSets = sqliteTable(
  'reader_sets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['group', 'members'] }).notNull(),
    canonicalKey: text('canonical_key').notNull(),
    /** 0 when `kind = 'group'`: the set is resolved through the membership epoch instead. */
    memberCount: integer('member_count').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('reader_sets_group_key_uq').on(t.groupId, t.canonicalKey),
    // One direction only. `02` §3.3.2 says `member_count` is 0 when `kind = 'group'`, but the
    // converse is false: an explicit set may name no members and still have an outsider seat
    // (`03` §3.4.1, `01` §14 A5), which is a legitimate audience of exactly one conversation.
    check('reader_sets_group_kind_ck', sql`${t.kind} <> 'group' OR ${t.memberCount} = 0`),
    check('reader_sets_member_count_ck', sql`${t.memberCount} >= 0`),
  ],
);

/**
 * One member of an explicit reader set (`02` §3.3.2).
 *
 * `reader_set_members_member_idx` is `(member_id, reader_set_id)` — the member first — because
 * Q-PRV-2 asks "which reader sets contain this member", which an erasure needs and which the
 * primary key's `(reader_set_id, member_id)` order cannot answer without a scan.
 */
export const readerSetMembers = sqliteTable(
  'reader_set_members',
  {
    readerSetId: integer('reader_set_id')
      .notNull()
      .references(() => readerSets.id, { onDelete: 'cascade' }),
    memberId: tid('mbr')('member_id')
      .notNull()
      .references(() => members.id),
  },
  (t) => [
    primaryKey({ columns: [t.readerSetId, t.memberId] }),
    // Q-PRV-2: the reader sets containing a member.
    index('reader_set_members_member_idx').on(t.memberId, t.readerSetId),
  ],
);

/**
 * An outsider seat in a reader set (`02` §3.3.1 of `03`, §3.4.1; `01` §14 A5).
 *
 * A seat is a conversation that may read a datum without any member of it being named — the case
 * `03` §3.4.1 calls an outsider: a relay into a chat whose participants are not group members.
 *
 * `conversation_id` carries **no foreign key**, and the comment in `02` §3.3.2 gives the reason: a
 * seat outlives its conversation row. If the chat is unbound or deleted, the recorded fact that a
 * datum was once readable there must survive, because that is what an audit of **I2** reads.
 */
export const readerSetSeats = sqliteTable(
  'reader_set_seats',
  {
    readerSetId: integer('reader_set_id')
      .notNull()
      .references(() => readerSets.id, { onDelete: 'cascade' }),
    /** No foreign key: a seat outlives its conversation row (`02` §3.3.2). */
    conversationId: tid('cnv')('conversation_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.readerSetId, t.conversationId] })],
);

/**
 * A label: a reader set plus the handling rules that travel with the datum (`02` §3.3.2).
 *
 * The four non-audience columns are what make a label more than an ACL, and each one answers a
 * question `canRead` alone cannot:
 *
 *  - `sensitivity` — how carefully the value must be handled even by someone allowed to see it,
 *    which `03`'s disclosure guard reads before putting it in an outgoing message;
 *  - `influence` — whether the value may shape the agent's behaviour (`constraints`) or only be
 *    repeated (`none`). This is the knob that lets a private preference change what the agent does
 *    without the agent ever being able to say why;
 *  - `untrusted` — whether the content may be read as instructions. Forwarded text, link previews
 *    and documents are labelled untrusted so that prompt injection cannot borrow the requester's
 *    authority (invariant **I3**);
 *  - `owner_member_id` plus `co_owner_member_ids` — who may authorise a declassification. `NULL`
 *    owner means the group owns it. `01` §14 A5 adds co-owners for data that is jointly personal,
 *    such as a message between two members; the array is sorted and excludes the owner, so one
 *    ownership set has one encoding and the canonical key is stable.
 */
export const labels = sqliteTable(
  'labels',
  {
    id: integer('id').primaryKey({ autoIncrement: true }).$type<LabelId>(),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    readerSetId: integer('reader_set_id')
      .notNull()
      .references(() => readerSets.id),
    /** `NULL` means the group owns this datum. */
    ownerMemberId: tid('mbr')('owner_member_id').references(() => members.id),
    /** Sorted, and excludes the owner (`01` §14 A5), so one ownership set has one encoding. */
    coOwnerMemberIds: jsonOf(
      z.array(idSchema('mbr')).max(64),
      'labels.co_owners',
    )('co_owner_member_ids').notNull(),
    sensitivity: text('sensitivity', { enum: ['normal', 'personal', 'sensitive'] }).notNull(),
    /** `constraints` lets the value shape behaviour without being quotable. */
    influence: text('influence', { enum: ['none', 'constraints'] }).notNull(),
    /** I3: content that must never be read as instructions. */
    untrusted: bool('untrusted').notNull(),
    canonicalKey: text('canonical_key').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // Q-IFC-1: the interning lookup.
    uniqueIndex('labels_group_key_uq').on(t.groupId, t.canonicalKey),
    // Q-IFC-2: load every label of a group, which eligibility computation does once per turn.
    index('labels_group_idx').on(t.groupId, t.id),
    // Q-PRV-3: everything owned by a member, which `deleteByLabelOwner` walks.
    index('labels_owner_idx').on(t.ownerMemberId),
    check('labels_untrusted_ck', boolCheckSql(t.untrusted)),
  ],
);

/**
 * A recorded declassification (`02` §3.3.2; semantics in `03` §3.4.2).
 *
 * Invariant **I2** is "no write-down *without a recorded declassification*", and this table is the
 * record. A row here is the evidence that a value which was readable by one audience became
 * readable by a wider one, and who authorised it.
 *
 * `content_digest` is a sha256 of the declassified value rather than the value itself, which is
 * what lets this table be an audit log without being a second copy of every private thing the
 * product has ever relayed. An auditor can confirm that a specific disclosure was approved; they
 * cannot read the disclosures from the log.
 *
 * `declassifications_action_idx` is **partial** — indexed only where `action_digest IS NOT NULL` —
 * because the lookup it serves ("was this specific write covered by a declassification?") only
 * applies to rows that cover a write, and `03` §3.3.3's guard runs it on every outgoing effect.
 */
export const declassifications = sqliteTable(
  'declassifications',
  {
    id: tid('dcl')('id').primaryKey(),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    kind: text('kind', {
      enum: [
        'constraint',
        'relay_text',
        'readers_widen',
        'implicit_instruction',
        'policy_promotion',
        'confirmation_disclosure',
        'portable_profile',
      ],
    }).notNull(),
    sourceLabelId: labelRef('source_label_id').notNull(),
    targetLabelId: labelRef('target_label_id').notNull(),
    /** Member ids ⊇ the source label's owners, or the literal `'policy:GS'` (`03` §3.4.2). */
    approvedBy: jsonOf(
      DeclassApproverSchema,
      'declassifications.approved_by',
    )('approved_by').notNull(),
    /** sha256 of the declassified value, so the log is evidence and not a second copy. */
    contentDigest: blob('content_digest', { mode: 'buffer' }).notNull(),
    /** `ActionDigest` of the write this covers (`03` §3.3.3). */
    actionDigest: text('action_digest'),
    /** Set when `kind = 'constraint'`. */
    constraintId: tid('cst')('constraint_id'),
    subjectRefs: jsonOf(
      z.array(EntityRefSchema),
      'declassifications.subject_refs',
    )('subject_refs').notNull(),
    turnId: tid('trn')('turn_id'),
    at: instantMs('at').notNull(),
  },
  (t) => [
    index('declassifications_group_idx').on(t.groupId, t.at),
    index('declassifications_action_idx')
      .on(t.groupId, t.actionDigest)
      .where(sql`${t.actionDigest} IS NOT NULL`),
  ],
);
