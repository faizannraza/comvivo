/**
 * Messages as domain objects (`02` §3.3.3).
 *
 * **`rid` is the ordering and `id` is the identity**, which the schema's own header states and
 * which shapes this type: both are present, because dropping either costs something real. `rid` is
 * what Q-CTX-1 walks backwards over `messages_conv_rid_idx` to build a context window, and `id` is
 * what every other table references and what a trace or an API response carries.
 *
 * **No `richText` field is parsed here.** `02` §3.3.3 stores it as a `jsonOf(RichTextSchema)`
 * column and `03` owns the AST; this type carries it as the already-validated `RichText` the column
 * mapper produced, so a repository never re-parses JSON it just read out of a column it wrote.
 *
 * **`text` is content.** `CLAUDE.md` §2 bans message content from logs above `debug`, so nothing
 * here may be spread into a log line — the repositories log ids and counts and never the row.
 */
import type {
  ChannelIdentityId,
  ConversationId,
  GroupId,
  LabelId,
  MemberId,
  MessageId,
  TurnId,
} from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';
import type { ForwardInfo } from './message-content.js';
import type { RichText } from './rich-text.js';

/**
 * `02` §3.3.3's `messages.kind` (`06` `senderKind`).
 *
 * `assistant` is the agent's own messages and is deliberately **not** the product's name: a column
 * value named after the brand turns a rename into a data migration, which is what ADR-024's `BRAND`
 * indirection exists to prevent. See the note in `02` §3.3.3, which demonstrated its own point.
 */
export const MESSAGE_KINDS = ['member', 'assistant', 'system', 'derived', 'external'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/**
 * The ordering key of a message within its conversation.
 *
 * A plain `number`, not a branded id: it is an `AUTOINCREMENT` rowid whose only use is comparison
 * and range-scanning, and `02`'s `InternedId` brand exists for values that could be confused with
 * *another table's* integer id. Nothing else in the schema holds a message rid except
 * `message_reactions`, which names the column `message_rid`.
 */
export type MessageRid = number;

/** A stored message (`02` §3.3.3). */
export interface Message {
  readonly rid: MessageRid;
  readonly id: MessageId;
  readonly groupId: GroupId;
  readonly conversationId: ConversationId;
  readonly kind: MessageKind;
  /** The member who sent it; absent for `assistant`, `system` and some `external` messages. */
  readonly senderMemberId: MemberId | undefined;
  readonly senderIdentityId: ChannelIdentityId | undefined;
  readonly platformMessageId: string | undefined;
  readonly platformThreadId: string | undefined;
  readonly text: string;
  readonly richText: RichText | undefined;
  /** A soft reference: `02` §3.3.3 notes the target may have been swept by retention. */
  readonly replyToMessageId: MessageId | undefined;
  readonly derivedFromMessageId: MessageId | undefined;
  readonly forwarded: ForwardInfo | undefined;
  readonly untrusted: boolean;
  readonly labelId: LabelId;
  readonly sentAt: Temporal.Instant;
  readonly receivedAt: Temporal.Instant;
  /** `06`: backfilled after an outage, so it arrived long after it was sent. */
  readonly deliveredLate: boolean;
  readonly truncated: boolean;
  readonly editedAt: Temporal.Instant | undefined;
  readonly editCount: number;
  readonly deletedAt: Temporal.Instant | undefined;
  readonly redactedAt: Temporal.Instant | undefined;
  readonly turnId: TurnId | undefined;
  readonly clientMessageId: string | undefined;
  /** `NULL` means exempt — a constitution pin (`03`), not "expire immediately". */
  readonly retentionUntil: Temporal.Instant | undefined;
}

/**
 * What ingestion supplies for a new message (`02` §3.3.3, `06`).
 *
 * `rid` is absent because SQLite assigns it, and `labelId` is absent because the repository interns
 * the label: `02` §3.2 makes `LabelStore` the only way a `label_id` comes into being, and letting a
 * caller pass one would make it possible to write a message labeled with a value that was never
 * interned — a dangling `label_id` whose eligibility filter silently matches nothing.
 *
 * `dedupeKey` is likewise absent: it is `02` §3.3.3's
 * `sha256(channel ‖ 0 ‖ chatId ‖ 0 ‖ platformMessageId)[0..16]`, derived from fields already here,
 * and a caller that computed it differently would defeat Q-ING-1's unique index.
 */
export interface NewMessage {
  readonly id: MessageId;
  readonly groupId: GroupId;
  readonly conversationId: ConversationId;
  readonly kind: MessageKind;
  readonly senderMemberId?: MemberId | undefined;
  readonly senderIdentityId?: ChannelIdentityId | undefined;
  readonly platformMessageId?: string | undefined;
  readonly platformThreadId?: string | undefined;
  readonly text: string;
  readonly richText?: RichText | undefined;
  readonly replyToMessageId?: MessageId | undefined;
  readonly derivedFromMessageId?: MessageId | undefined;
  readonly forwarded?: ForwardInfo | undefined;
  readonly untrusted?: boolean | undefined;
  readonly sentAt: Temporal.Instant;
  readonly receivedAt: Temporal.Instant;
  readonly deliveredLate?: boolean | undefined;
  readonly truncated?: boolean | undefined;
  readonly turnId?: TurnId | undefined;
  readonly clientMessageId?: string | undefined;
  readonly retentionUntil?: Temporal.Instant | undefined;
}

/**
 * Whether a message is a tombstone — deleted on the platform, or redacted by erasure.
 *
 * `02` §3.3.3 keeps the row and empties the text, so "is it gone" cannot be answered by absence.
 * A single predicate because the two columns mean different things to an operator and the same
 * thing to a reader: there is no content here.
 */
export function isTombstoned(message: Pick<Message, 'deletedAt' | 'redactedAt'>): boolean {
  return message.deletedAt !== undefined || message.redactedAt !== undefined;
}
