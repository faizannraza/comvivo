/**
 * Messages, their attachments and their reactions (`02` §3.3.3).
 *
 * `messages` is the highest-volume table in the product and the one the ingestion fast path writes
 * on every inbound event, under a 3 ms p95 budget (`M1-T17`). Most of its shape follows from that
 * and from three facts about chat platforms.
 *
 * **`rid` is the ordering, `id` is the identity.** The primary key is an autoincrementing integer
 * and the TypeID is a unique secondary key. Context assembly walks a conversation window in order
 * (Q-CTX-1, `messages_conv_rid_idx`), and an integer rowid makes that walk a range scan over the
 * index rather than a sort. The TypeID exists because an id that leaves the database — in a URL,
 * an API response, a reply reference — must not be a guessable sequential number.
 *
 * **Deduplication is a partial unique index, not application logic.** A platform may deliver the
 * same message twice, and a crash between receiving and acknowledging makes a redelivery certain
 * rather than unlikely. `dedupe_key` is the first 16 bytes of
 * `sha256(channel ‖ 0 ‖ chatId ‖ 0 ‖ platformMessageId)`, and `messages_dedupe_uq` is unique only
 * over rows that have one (Q-ING-1) — so a web-chat message with no platform id does not collide
 * with every other one. Invariant **I6** (exactly-once intent) rests on this index.
 *
 * **Platform deletes and edits are destructive, so the schema has to be too.** `02` §3.3.3 and
 * `06` §3.24 are explicit that prior text is not kept: an edit bumps `edit_count` and replaces
 * `text`, and a platform delete sets `text=''` with `redacted_at`. Keeping history would mean the
 * product remembers what a person asked their platform to erase.
 *
 * `kind='assistant'` is the value for a message the agent sent. `02` §3.3.3's note explains the
 * choice: the enum value was once named after the product, and a column *value* named after the
 * brand turns a rename into a data migration — which is exactly what ADR-024's `BRAND` indirection
 * exists to prevent, for a product that has already been renamed once.
 */
import { AttachmentRefSchema, ForwardInfoSchema, RichTextSchema } from '@comvivo/core';
import { sql } from 'drizzle-orm';
import {
  blob,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { bool, boolCheckSql, createdAt, instantMs, jsonOf, labelRef, tid } from './_columns.js';
import { blobs } from './blobs.js';
import { conversations, groups, members } from './groups.js';
import { channelIdentities } from './identity.js';

export const messages = sqliteTable(
  'messages',
  {
    /** The ordering key. Context windows are range scans over this (Q-CTX-1). */
    rid: integer('rid').primaryKey({ autoIncrement: true }),
    /** The identity that leaves the database, so an external id is never a sequence number. */
    id: tid('msg')('id').notNull().unique(),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    conversationId: tid('cnv')('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** `06` `senderKind`. `assistant` is the agent's own messages (`02` §3.3.3's note). */
    kind: text('kind', {
      enum: ['member', 'assistant', 'system', 'derived', 'external'],
    }).notNull(),
    senderMemberId: tid('mbr')('sender_member_id').references(() => members.id),
    senderIdentityId: tid('chid')('sender_identity_id').references(() => channelIdentities.id, {
      onDelete: 'set null',
    }),
    platformMessageId: text('platform_message_id'),
    platformThreadId: text('platform_thread_id'),
    /** First 16 bytes of `sha256(channel ‖ 0 ‖ chatId ‖ 0 ‖ platformMessageId)`. I6. */
    dedupeKey: blob('dedupe_key', { mode: 'buffer' }),
    text: text('text').notNull().default(''),
    richText: jsonOf(RichTextSchema, 'messages.rich_text')('rich_text'),
    /** A soft reference: the target may have been swept by retention. */
    replyToMessageId: tid('msg')('reply_to_message_id'),
    /** A transcript, OCR text or extracted PDF text derives from its source message. */
    derivedFromMessageId: tid('msg')('derived_from_message_id'),
    forwarded: jsonOf(ForwardInfoSchema, 'messages.forwarded')('forwarded'),
    /** I3: forwarded text, external quotes and link previews are never read as instructions. */
    untrusted: bool('untrusted').notNull().default(false),
    labelId: labelRef().notNull(),
    sentAt: instantMs('sent_at').notNull(),
    receivedAt: instantMs('received_at').notNull(),
    /** `06`: backfilled after an outage, so the agent can decline to react to stale news. */
    deliveredLate: bool('delivered_late').notNull().default(false),
    truncated: bool('truncated').notNull().default(false),
    editedAt: instantMs('edited_at'),
    /** `06` §3.24: the count, not the history. Prior text is not kept. */
    editCount: integer('edit_count').notNull().default(0),
    /** A platform delete becomes a tombstone: `text = ''` plus `redacted_at`. */
    deletedAt: instantMs('deleted_at'),
    /** Platform delete or erasure; `text` is set to `''`. */
    redactedAt: instantMs('redacted_at'),
    /** For `kind='assistant'`: the turn that produced it (`09`). */
    turnId: tid('trn')('turn_id'),
    /** The web chat's own client id (`09`), unique per conversation so a retry is not a duplicate. */
    clientMessageId: text('client_message_id'),
    /** `NULL` means exempt from retention — a constitution pin (`03`). */
    retentionUntil: instantMs('retention_until'),
  },
  (t) => [
    // Q-ING-1: platform redelivery. Partial, so rows without a platform id never collide. I6.
    uniqueIndex('messages_dedupe_uq').on(t.dedupeKey).where(sql`${t.dedupeKey} IS NOT NULL`),
    // Q-ING-5: resolving a reply or an edit back to the row it refers to.
    uniqueIndex('messages_conv_platform_uq')
      .on(t.conversationId, t.platformMessageId)
      .where(sql`${t.platformMessageId} IS NOT NULL`),
    // Q-CTX-1: the conversation window context assembly reads on every turn.
    index('messages_conv_rid_idx').on(t.conversationId, t.rid),
    // Q-CAT-1 and Q-PRV-4: a member's messages, for catch-up and for erasure.
    index('messages_group_sender_idx').on(t.groupId, t.senderMemberId, t.rid),
    // Q-RET-1: the retention sweep. Partial, so exempt rows are not in the index at all.
    index('messages_retention_idx')
      .on(t.retentionUntil)
      .where(sql`${t.retentionUntil} IS NOT NULL`),
    uniqueIndex('messages_client_id_uq')
      .on(t.conversationId, t.clientMessageId)
      .where(sql`${t.clientMessageId} IS NOT NULL`),
    check('messages_untrusted_ck', boolCheckSql(t.untrusted)),
    check('messages_delivered_late_ck', boolCheckSql(t.deliveredLate)),
    check('messages_truncated_ck', boolCheckSql(t.truncated)),
    check('messages_edit_count_ck', sql`${t.editCount} >= 0`),
  ],
);

/**
 * An attachment on a message (`02` §3.3.3; `01` §14 A25).
 *
 * **Ingestion never downloads bytes.** A25 is explicit: ingestion inserts the row with
 * `status='pending'` and the platform's opaque ref, and enqueues one `attachment.fetch` job per
 * attachment *in the same transaction*. The job streams the file into the blob store and sets
 * `status` and `blob_sha256`. Downloading inline would blow the 20 ms ingestion budget, and some
 * platforms' URLs expire, which is why the job runs with `runAt = now` rather than on a sweep.
 *
 * The composite foreign key `(group_id, blob_sha256) → blobs(group_id, sha256)` is what makes blob
 * reference counting correct: the parent key includes the group, so an attachment can only ever
 * point at a blob in its own group (**I4**), and `blobs.unreferenced_since` can be set by counting
 * referrers rather than by trusting that nothing else points there.
 *
 * `status` carries seven failure modes rather than a boolean, because each one needs a different
 * message to the user: `too_large` and `quota_exceeded` are about limits they can change,
 * `forbidden` and `unsupported` are about the file, and `expired` means the platform withdrew the
 * URL before the job ran.
 */
export const messageAttachments = sqliteTable(
  'message_attachments',
  {
    id: tid('att')('id').primaryKey(),
    messageId: tid('msg')('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    kind: text('kind', {
      enum: ['image', 'voice', 'audio', 'video', 'document', 'file', 'sticker'],
    }).notNull(),
    fileName: text('file_name'),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes'),
    /** Hex sha256 of the plaintext; `NULL` until the fetch job has stored it. */
    blobSha256: text('blob_sha256'),
    status: text('status', {
      enum: [
        'pending',
        'stored',
        'too_large',
        'quota_exceeded',
        'forbidden',
        'unsupported',
        'failed',
        'expired',
      ],
    }).notNull(),
    /** Adapter-specific and opaque. Matrix's variant holds a key, so this is encrypted at rest. */
    platformRef: jsonOf(
      AttachmentRefSchema,
      'message_attachments.platform_ref',
    )('platform_ref').notNull(),
    /** The `attachment.fetch` job that will store this (`01` §14 A25). */
    fetchJobId: tid('job')('fetch_job_id'),
    /** The transcript, OCR or PDF-text message derived from this attachment. */
    derivedMessageId: tid('msg')('derived_message_id'),
    /** Equal to the message's label. */
    labelId: labelRef(),
    createdAt: createdAt(),
  },
  (t) => [
    index('attachments_message_idx').on(t.messageId),
    // Q-BLOB-1: blob GC. Partial, so rows still pending a fetch are not in the index.
    index('attachments_blob_idx')
      .on(t.groupId, t.blobSha256)
      .where(sql`${t.blobSha256} IS NOT NULL`),
    // The group is part of the parent key, so an attachment can only reference its own group's blob.
    foreignKey({
      columns: [t.groupId, t.blobSha256],
      foreignColumns: [blobs.groupId, blobs.sha256],
      name: 'attachments_blob_fk',
    }),
    check('attachments_size_ck', sql`${t.sizeBytes} IS NULL OR ${t.sizeBytes} >= 0`),
  ],
);

/**
 * A reaction on a message (`02` §3.3.3; `04` §3.3.3).
 *
 * Written by ingestion from `06`'s reaction events, and read by `04`'s extraction windows: a
 * thumbs-up on "I'll pick up the kids" is how a commitment gets confirmed without anyone typing a
 * second message.
 *
 * The primary key is `(message_rid, member_id, emoji)`, so re-delivering the same reaction is a
 * no-op rather than a duplicate — platforms resend these freely. It references `messages.rid`
 * rather than `messages.id` because the whole row is three integers and a short string, and
 * putting a 26-character TypeID in the primary key of the most redundant table in the database
 * would cost more than the join it saves.
 *
 * `group_id` is denormalised with **no** foreign key: the cascade already arrives through
 * `message_rid`, and a second cascade path from `groups` would make the purge order in
 * `02` §3.13.4 ambiguous. It is here so that `04`'s extraction windows and the erasure sweep can
 * filter by group without joining `messages`.
 *
 * `02` §3.3.3 is explicit that reactions from members whose consent forbids extraction are still
 * stored — they are needed to confirm an action the member themselves took — but are never
 * rendered into an extraction window (`04` §3.3.5). That is a read-path rule, not a schema one.
 */
export const messageReactions = sqliteTable(
  'message_reactions',
  {
    messageRid: integer('message_rid')
      .notNull()
      .references(() => messages.rid, { onDelete: 'cascade' }),
    memberId: tid('mbr')('member_id')
      .notNull()
      .references(() => members.id),
    /** Normalised by `06`, so one reaction has one spelling across platforms. */
    emoji: text('emoji').notNull(),
    /** Denormalised for group-scoped sweeps; no foreign key, the cascade arrives via the message. */
    groupId: tid('grp')('group_id').notNull(),
    at: instantMs('at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.messageRid, t.memberId, t.emoji] })],
);
