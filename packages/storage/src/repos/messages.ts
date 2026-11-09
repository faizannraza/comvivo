/**
 * The message repository: the ingestion fast path (`02` §3.7.1, §3.3.3).
 *
 * `M1-T17`'s acceptance criterion puts a **p95 of 3 ms on the ingestion transaction**, which is
 * what shapes this module. Three decisions follow from it:
 *
 *  - **Statements are prepared once per instance** (`02` §3.7.2). Drizzle caches the compiled
 *    statement, so the per-message cost is binding and stepping rather than parsing SQL.
 *  - **The dedupe key is computed here, not passed in.** Q-ING-1's `messages_dedupe_uq` only works
 *    if every writer derives the key identically, and `02` §3.3.3 fixes the derivation. A
 *    caller-supplied key would be one place for the two halves of a dedupe to disagree, and the
 *    symptom is a duplicated message in a group chat.
 *  - **The label is interned here.** `02` §3.2 makes `LabelStore` the only way a `label_id` comes
 *    into being; a caller holding a raw integer could point a message at another group's label.
 *
 * ## Eligibility filtering
 *
 * `02` §3.7.1: "Labeled reads require an `EligibleLabelSet`". Every read in this module that
 * returns message **content** takes one and filters `label_id IN (...)`. The `...Unfiltered`
 * variant lives in `unfiltered/messages.ts`, under the path
 * `unfiltered-reads-restricted-callers` guards — a method on this class would have been outside
 * that guard's door, since dependency-cruiser restricts imports and not calls.
 */
import type {
  EligibleLabelSet,
  Label,
  Message,
  MessageReader,
  MessageRepository,
  MessageWindow,
  NewMessage,
  TxToken,
  WriteResult,
} from '@comvivo/core';
import { duplicate, notFound, writeOk } from '@comvivo/core';
import { type ConversationId, type GroupId, type MessageId, StorageError } from '@comvivo/shared';
import { sha256 } from '@comvivo/shared/crypto';
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, lte, type SQL, sql } from 'drizzle-orm';
import type { Temporal } from 'temporal-polyfill';
import { type Db, exactlyOne, maybeOne } from '../db/drizzle.js';
import { isUniqueViolation } from '../db/errors.js';
import type { LabelStore } from '../ifc/label-store.js';
import { conversations, messages } from '../schema/index.js';
import { toMessage } from './rows.js';

/** `02` §3.3.3: the dedupe key is the first 16 bytes of the digest, not the whole of it. */
const DEDUPE_KEY_BYTES = 16;

/** The separator `02` §3.3.3 puts between the three parts: a NUL byte. */
const SEPARATOR = String.fromCharCode(0);

/**
 * `02` §3.3.3's dedupe key: `sha256(channel || 0 || chatId || 0 || platformMessageId)[0..16]`.
 *
 * A NUL separator, so `('tg', 'a', 'bc')` and `('tg', 'ab', 'c')` cannot produce the same digest —
 * a platform id may legitimately contain any printable character, so a printable separator would
 * be forgeable by a sender who controls part of one. Exported because the ingestion test asserts
 * the derivation rather than restating it.
 */
export function dedupeKey(
  channel: string,
  platformChatId: string,
  platformMessageId: string,
): Buffer {
  const parts = [channel, platformChatId, platformMessageId].join(SEPARATOR);
  return sha256(parts).subarray(0, DEDUPE_KEY_BYTES);
}

export class SqliteMessageRepository implements MessageReader, MessageRepository {
  readonly #db: Db;
  readonly #labels: LabelStore;

  constructor(db: Db, labels: LabelStore) {
    this.#db = db;
    this.#labels = labels;
  }

  byId(groupId: GroupId, id: MessageId): Message | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(messages)
        .where(and(eq(messages.groupId, groupId), eq(messages.id, id))),
    );
    return row === undefined ? undefined : toMessage(row);
  }

  /** Q-ING-5, through `messages_conv_platform_uq`: the reply and edit lookup. */
  byPlatformId(conversationId: ConversationId, platformMessageId: string): Message | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            eq(messages.platformMessageId, platformMessageId),
          ),
        ),
    );
    return row === undefined ? undefined : toMessage(row);
  }

  /**
   * Q-CTX-1: the last N messages of a conversation this audience may read.
   *
   * Walked **backwards** over `messages_conv_rid_idx` to find them and returned **oldest first**,
   * which is the order a prompt needs. Doing the reversal here is what makes `limit` mean "the most
   * recent N" everywhere: a caller that reversed a forward scan itself would get the oldest N, and
   * the result would look plausible and be wrong.
   */
  window(window: MessageWindow, eligible: EligibleLabelSet): readonly Message[] {
    const rows = this.#db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, window.conversationId),
          eligibleFilter(eligible),
          ...(window.beforeRid === undefined ? [] : [lt(messages.rid, window.beforeRid)]),
        ),
      )
      .orderBy(desc(messages.rid))
      .limit(window.limit)
      .all();
    return rows.reverse().map(toMessage);
  }

  /** Q-CAT-1, through `messages_group_sender_idx`. */
  bySender(
    groupId: GroupId,
    senderMemberId: NonNullable<Message['senderMemberId']>,
    options: { readonly limit: number; readonly since?: Temporal.Instant | undefined },
    eligible: EligibleLabelSet,
  ): readonly Message[] {
    const rows = this.#db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.groupId, groupId),
          eq(messages.senderMemberId, senderMemberId),
          eligibleFilter(eligible),
          ...(options.since === undefined ? [] : [gte(messages.sentAt, options.since)]),
        ),
      )
      .orderBy(desc(messages.rid))
      .limit(options.limit)
      .all();
    return rows.reverse().map(toMessage);
  }

  /**
   * Hydrate ids a search or a trace produced, dropping any this audience may not read.
   *
   * The drop is **silent and deliberate**: `02` §3.3.9 makes a trace's context manifest hold ids
   * only, precisely so the dashboard re-checks eligibility at render time and shows one member a
   * row it hides from another. Raising on an ineligible id would make a trace unreadable to anyone
   * whose eligible set has since narrowed, which is every member after a label change.
   */
  hydrate(ids: readonly MessageId[], eligible: EligibleLabelSet): readonly Message[] {
    if (ids.length === 0) return [];
    const rows = this.#db
      .select()
      .from(messages)
      .where(
        and(
          inArray(messages.id, [...ids]),
          eq(messages.groupId, eligible.groupId),
          eligibleFilter(eligible),
        ),
      )
      .orderBy(asc(messages.rid))
      .all();
    return rows.map(toMessage);
  }

  /**
   * Insert one message, interning its label.
   *
   * Reads the conversation to derive the dedupe key, which is one primary-key lookup — the cost of
   * making Q-ING-1's derivation impossible to get wrong at a call site. It also checks that the
   * conversation belongs to the group the message claims, which the foreign keys alone do not:
   * `messages` references `groups` and `conversations` separately, so a row naming group A and a
   * conversation in group B satisfies both keys and violates `I4`.
   */
  insert(uow: TxToken, message: NewMessage, label: Label): WriteResult<Message> {
    const conversation = maybeOne(
      this.#db
        .select({
          groupId: conversations.groupId,
          channel: conversations.channel,
          platformChatId: conversations.platformChatId,
        })
        .from(conversations)
        .where(eq(conversations.id, message.conversationId)),
    );
    if (conversation === undefined) return notFound();
    if (conversation.groupId !== message.groupId) {
      throw crossGroup('the message names a conversation in another group', 'conversation');
    }
    if (label.groupId !== message.groupId) {
      throw crossGroup('the message names a label of another group', 'label');
    }

    const labelId = this.#labels.intern(uow, label);
    const key =
      message.platformMessageId === undefined
        ? undefined
        : dedupeKey(conversation.channel, conversation.platformChatId, message.platformMessageId);

    try {
      const row = exactlyOne(
        this.#db
          .insert(messages)
          .values({
            id: message.id,
            groupId: message.groupId,
            conversationId: message.conversationId,
            kind: message.kind,
            senderMemberId: message.senderMemberId,
            senderIdentityId: message.senderIdentityId,
            platformMessageId: message.platformMessageId,
            platformThreadId: message.platformThreadId,
            dedupeKey: key,
            text: message.text,
            richText: message.richText,
            replyToMessageId: message.replyToMessageId,
            derivedFromMessageId: message.derivedFromMessageId,
            forwarded: message.forwarded,
            untrusted: message.untrusted ?? false,
            labelId,
            sentAt: message.sentAt,
            receivedAt: message.receivedAt,
            deliveredLate: message.deliveredLate ?? false,
            truncated: message.truncated ?? false,
            turnId: message.turnId,
            clientMessageId: message.clientMessageId,
            retentionUntil: message.retentionUntil,
          })
          .returning(),
        'the message',
      );
      return writeOk(toMessage(row));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Redelivery is routine — a platform retries any ack it did not see — so the useful answer
      // names the message already stored. Three unique indexes can fire: the dedupe key, the
      // `(conversation, platformMessageId)` pair, and `messages.id`.
      const existing =
        message.platformMessageId === undefined
          ? undefined
          : this.byPlatformId(message.conversationId, message.platformMessageId);
      return duplicate(existing?.id ?? message.id);
    }
  }

  /**
   * Apply a platform edit (`06` §3.24).
   *
   * `02` §3.3.3 is explicit that prior text is **not kept**: an edit history is a record of what
   * someone decided not to say. This overwrites and increments `edit_count`, so the fact of the
   * edit survives and its content does not.
   */
  applyEdit(
    _uow: TxToken,
    groupId: GroupId,
    id: MessageId,
    edit: {
      readonly text: string;
      readonly richText?: Message['richText'];
      readonly editedAt: Temporal.Instant;
    },
  ): WriteResult<Message> {
    const row = maybeOne(
      this.#db
        .update(messages)
        .set({
          text: edit.text,
          richText: edit.richText ?? null,
          editedAt: edit.editedAt,
          editCount: sql`${messages.editCount} + 1`,
        })
        .where(and(eq(messages.groupId, groupId), eq(messages.id, id)))
        .returning(),
    );
    return row === undefined ? notFound() : writeOk(toMessage(row));
  }

  /**
   * Tombstone a message, keeping the row and emptying the text (`02` §3.3.3).
   *
   * `reason` picks which column is stamped so an operator can tell "the sender deleted this" from
   * "we erased a person" — the first is the member's act and the second is ours, and a single flag
   * would make an erasure audit unable to distinguish them.
   */
  tombstone(
    _uow: TxToken,
    groupId: GroupId,
    id: MessageId,
    reason: 'platform_delete' | 'redaction',
    at: Temporal.Instant,
  ): WriteResult<Message> {
    const row = maybeOne(
      this.#db
        .update(messages)
        .set({
          text: '',
          richText: null,
          // Both columns are stamped for a platform delete, because `02` §3.3.3 describes it as
          // "tombstone (text '' + redacted_at)": the text is gone, which is a redaction whoever
          // caused it. `redactedAt` alone means an erasure.
          ...(reason === 'platform_delete' ? { deletedAt: at } : {}),
          redactedAt: at,
        })
        .where(and(eq(messages.groupId, groupId), eq(messages.id, id)))
        .returning(),
    );
    return row === undefined ? notFound() : writeOk(toMessage(row));
  }

  /**
   * Q-RET-1, through `messages_retention_idx`: drop messages whose retention has expired.
   *
   * `limit` is mandatory: retention runs as a job against a database a host is also using, and an
   * unbounded `DELETE` would hold the write lock for as long as it takes. The caller loops.
   */
  deleteExpired(_uow: TxToken, groupId: GroupId, now: Temporal.Instant, limit: number): number {
    // A subquery, because SQLite's `DELETE` has no `LIMIT` unless it was compiled with
    // `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`, which this build is not. Selecting the rids first also
    // means the partial index does the selecting.
    const doomed = this.#db
      .select({ rid: messages.rid })
      .from(messages)
      .where(
        and(
          eq(messages.groupId, groupId),
          isNotNull(messages.retentionUntil),
          lte(messages.retentionUntil, now),
        ),
      )
      .orderBy(asc(messages.retentionUntil))
      .limit(limit)
      .all();
    if (doomed.length === 0) return 0;
    const removed = this.#db
      .delete(messages)
      .where(
        inArray(
          messages.rid,
          doomed.map((row) => row.rid),
        ),
      )
      .returning({ rid: messages.rid })
      .all();
    return removed.length;
  }

  /** `03`'s declassification: change who may read a message without changing the message. */
  relabel(uow: TxToken, groupId: GroupId, id: MessageId, label: Label): WriteResult<Message> {
    if (label.groupId !== groupId) {
      throw crossGroup('the new label belongs to another group', 'label');
    }
    const labelId = this.#labels.intern(uow, label);
    const row = maybeOne(
      this.#db
        .update(messages)
        .set({ labelId })
        .where(and(eq(messages.groupId, groupId), eq(messages.id, id)))
        .returning(),
    );
    return row === undefined ? notFound() : writeOk(toMessage(row));
  }
}

/**
 * An `I4` violation the foreign keys cannot catch.
 *
 * Thrown rather than returned: `02` §3.7.1's `WriteResult` arms are conditions a caller can act on,
 * and "you passed a label from another group" is a bug in the calling code. A `not_found` here
 * would let ingestion treat a group-isolation error as a missing row and carry on.
 */
function crossGroup(message: string, what: 'conversation' | 'label'): StorageError {
  return new StorageError('STORAGE_CONSTRAINT', message, {
    hint: `This is a bug and an I4 violation: resolve the ${what} within the message's own group.`,
    category: 'bug',
  });
}

/**
 * `label_id IN (eligible)` — the one filter `I1` rests on (`02` §3.2, `01` §7.2).
 *
 * An empty eligible set must match **nothing**, and that is the case worth being explicit about:
 * `inArray(column, [])` has emitted different SQL across ORM versions, and a version that emitted
 * a tautology would turn "this audience may read nothing" into "this audience may read everything"
 * — the worst possible direction for an `I1` failure. A literal false cannot be misread, and
 * `labels.eligibility-equivalence.property` (`M1-T18`) tests the case directly.
 *
 * Above `LABEL_COUNT_TEMP_TABLE` labels in a group, `02` §3.2 switches to a `TEMP` table instead of
 * a long `IN` list. That path arrives with `M1-T18`'s labeled reads, where the count is actually
 * known; until then the `IN` list is correct at every size and slower only at the top end.
 */
function eligibleFilter(eligible: EligibleLabelSet): SQL {
  if (eligible.ids.length === 0) return sql`1 = 0`;
  return inArray(messages.labelId, [...eligible.ids]);
}
