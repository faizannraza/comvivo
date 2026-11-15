/**
 * Ports for messages (`02` §3.7.1, §3.3.3).
 *
 * This is the **ingestion fast path**, and `M1-T17`'s acceptance criterion puts a p95 of 3 ms on
 * the whole transaction. Two consequences visible in the signatures below:
 *
 *  - **`insert` returns `duplicate` rather than throwing.** Q-ING-1's `messages_dedupe_uq` is how
 *    a redelivered platform message is recognised, and redelivery is routine — a platform retries
 *    on any ack it did not see. An exception on the common path would cost a stack trace per
 *    duplicate and, worse, would tempt a caller into a `try`/`catch` that cannot tell a duplicate
 *    from a disk error.
 *  - **Reads that build a context window take an `EligibleLabelSet`**, per `02` §3.7.1: "Labeled
 *    reads require an `EligibleLabelSet`, or are explicitly named `…Unfiltered`". The unfiltered
 *    variants are **not here**: they live in `../unfiltered.ts`, behind the
 *    `@comvivo/core/unfiltered` entry point, because `02` §3.7.1 restricts them with a
 *    dependency-cruiser rule and that rule restricts module imports rather than method calls. A
 *    `…Unfiltered` method on this interface would be a restriction the guard cannot express.
 */
import type { AttachmentId, ConversationId, GroupId, MemberId, MessageId } from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';
import type { Message, MessageRid, NewMessage } from '../../../domain/message.js';
import type {
  Attachment,
  AttachmentStatus,
  NewAttachment,
} from '../../../domain/message-content.js';
import type { EligibleLabelSet, Label } from '../../../ifc/eligible.js';
import type { TxToken, WriteResult } from '../uow.js';

/** Where a context window starts, for Q-CTX-1's backward range scan. */
export interface MessageWindow {
  readonly conversationId: ConversationId;
  readonly limit: number;
  /**
   * Exclusive upper bound on `rid`, for paging further back.
   *
   * A `rid` rather than an instant, because `sent_at` is the *platform's* clock and is neither
   * unique nor monotonic — two messages can share a millisecond, and a backfilled message
   * (`deliveredLate`) carries a `sent_at` from before messages already stored. Paging on a
   * non-unique, non-monotonic key either skips rows or repeats them.
   */
  readonly beforeRid?: MessageRid | undefined;
}

export interface MessageReader {
  byId(groupId: GroupId, id: MessageId): Message | undefined;
  /** Q-ING-5: the reply/edit lookup, by the id the platform gave the message. */
  byPlatformId(conversationId: ConversationId, platformMessageId: string): Message | undefined;
  /**
   * Q-CTX-1: the last N messages of a conversation this audience may read.
   *
   * Returned **oldest first**, which is the order a prompt needs, even though the index is walked
   * backwards to find them. Doing the reversal here rather than at each call site means the
   * `limit` always means "the most recent N" — a caller that reversed a forward scan itself would
   * get the *oldest* N, which is the kind of bug that produces a plausible-looking wrong answer.
   */
  window(window: MessageWindow, eligible: EligibleLabelSet): readonly Message[];
  /** Q-CAT-1: what one member said, for catch-up and "what did X say" (`07`). */
  bySender(
    groupId: GroupId,
    senderMemberId: MemberId,
    options: { readonly limit: number; readonly since?: Temporal.Instant | undefined },
    eligible: EligibleLabelSet,
  ): readonly Message[];
  /** Hydrate ids a search or a trace produced, dropping any this audience may not read. */
  hydrate(ids: readonly MessageId[], eligible: EligibleLabelSet): readonly Message[];
  /**
   * A message's attachments, oldest first (`02` §3.3.3; `01` §14 **A25**).
   *
   * Not folded into `Message`, and the reason is the hot path: `window` is Q-CTX-1 and runs on
   * every turn over up to 200 messages, almost none of which have an attachment. A join or an
   * N+1 there would make the common case pay for the rare one. The context builder asks for the
   * handful it is going to describe.
   *
   * No `EligibleLabelSet` parameter, because an attachment's `label_id` **equals its message's**
   * (`02` §3.3.3) — so the caller has already been filtered by the read that gave it the message
   * id, and a second filter here would be a second place the rule is stated.
   */
  attachments(groupId: GroupId, messageId: MessageId): readonly Attachment[];
}

export interface MessageRepository {
  /**
   * Insert one message, interning its label (`02` §3.2, §3.3.3).
   *
   * `label` rather than a `labelId`: `02` §3.2 makes interning the only way a `label_id` comes
   * into being, and a caller holding a raw integer could write a message pointing at a label from
   * another group — an `I4` violation the schema's trigger would catch but which should not be
   * expressible. The repository interns, then inserts, in the caller's transaction.
   *
   * Returns `duplicate` with the existing message id when Q-ING-1's dedupe key collides.
   */
  insert(
    uow: TxToken,
    message: NewMessage,
    label: Label,
    attachments?: readonly NewAttachment[],
  ): WriteResult<Message>;
  /**
   * Record what the `attachment.fetch` job found (`01` §14 **A25**).
   *
   * One method for every outcome rather than a `markStored` and a `markFailed`, because `02`
   * §3.3.3's seven statuses are not two groups: `too_large` and `quota_exceeded` are the host's
   * settings working, `forbidden` and `expired` are the platform's answer, and only `failed` is a
   * failure. A pair of methods would make the caller decide which group each belongs to, and
   * `07`'s digest reads the status to decide what it may say about a file it never saw.
   *
   * `stored` is the only status that carries a blob, and the signature says so: `02` §3.3.3's
   * `attachments_blob_fk` is a composite key on `(group_id, blob_sha256)`, so a digest on a row
   * whose group does not own that blob is refused by the database rather than by a check here.
   */
  recordAttachmentOutcome(
    uow: TxToken,
    groupId: GroupId,
    id: AttachmentId,
    outcome:
      | {
          readonly status: 'stored';
          readonly blobSha256: string;
          readonly sizeBytes: number;
          readonly mime?: string | undefined;
        }
      | { readonly status: Exclude<AttachmentStatus, 'pending' | 'stored'> },
  ): WriteResult<void>;
  /**
   * Apply a platform edit (`06` §3.24).
   *
   * `02` §3.3.3 is explicit that prior text is **not** kept, so this overwrites and increments
   * `edit_count`. That is a product decision with a privacy reason — an edit history is a record
   * of what someone decided not to say — and it is recorded here because an "improvement" that
   * kept the old text would be a quiet reversal of it.
   */
  applyEdit(
    uow: TxToken,
    groupId: GroupId,
    id: MessageId,
    edit: {
      readonly text: string;
      readonly richText?: Message['richText'];
      readonly editedAt: Temporal.Instant;
    },
  ): WriteResult<Message>;
  /**
   * Tombstone a message: a platform delete, or an erasure.
   *
   * The row stays and the text becomes `''` (`02` §3.3.3). `reason` picks which column is stamped,
   * because an operator needs to tell "the sender deleted this" from "we erased a person".
   */
  tombstone(
    uow: TxToken,
    groupId: GroupId,
    id: MessageId,
    reason: 'platform_delete' | 'redaction',
    at: Temporal.Instant,
  ): WriteResult<Message>;
  /** Q-RET-1's half that writes: drop messages whose retention has expired. */
  /**
   * Q-RET-1: drop messages whose `retention_until` has passed.
   *
   * `groupId` is **optional**, and `undefined` means every group — which is the shape the retention
   * sweep needs (`02` §3.13.2 iterates tables, not groups) and the shape `messages_retention_idx`
   * is built for: the index is on `retention_until` alone, so an instance-wide pass is the one that
   * uses it. The per-group form exists for `03`'s "shorten this group's retention" recompute, where
   * the caller has a group and wants to bound the work to it.
   */
  deleteExpired(
    uow: TxToken,
    groupId: GroupId | undefined,
    now: Temporal.Instant,
    limit: number,
  ): number;
  /**
   * Set the label of an existing message.
   *
   * For `03`'s declassification, which changes who may read a message without changing the
   * message. Takes a `Label` for the same reason `insert` does.
   */
  relabel(uow: TxToken, groupId: GroupId, id: MessageId, label: Label): WriteResult<Message>;
}
