/**
 * The conversation repository (`02` §3.7.1, §3.3.1).
 *
 * A `conversations` row exists only when a chat has been **bound** to a group (`01` §14 A27, `06`
 * §3.20): an unclaimed chat persists a `chat_bindings` row and nothing else. So the existence of a
 * row here is itself the evidence that a group claimed the chat, and `create` is the bind.
 *
 * Two constraints in `02` §3.3.1 shape the methods rather than just the validation:
 *
 *  - `conversations_one_primary_uq` is a **partial** unique index on `group_id WHERE primary = 1`,
 *    so a group cannot have two primaries — which means promoting one requires demoting the other
 *    first, in the same transaction. `setPrimary` is that pair of statements; there is no way to
 *    express it as one `UPDATE`.
 *  - `conversations_dm_ck` ties `kind = 'dm'` to `member_id IS NOT NULL` in both directions, and
 *    `conversations_primary_ck` forbids a primary DM. `conversationShapeError` in `core` answers
 *    both before the write, so the caller gets a sentence instead of a constraint name.
 */
import type {
  ChannelId,
  Conversation,
  ConversationReader,
  ConversationRepository,
  NewConversation,
  TxToken,
  WriteResult,
} from '@comvivo/core';
import { conversationShapeError, duplicate, notFound, writeOk } from '@comvivo/core';
import { type ConversationId, type GroupId, StorageError } from '@comvivo/shared';
import { and, asc, eq } from 'drizzle-orm';
import { type Db, exactlyOne, maybeOne } from '../db/drizzle.js';
import { isUniqueViolation } from '../db/errors.js';
import { conversations } from '../schema/index.js';
import { toConversation } from './rows.js';

/** What `conversationShapeError` returns, as sentences a developer can act on. */
const SHAPE_MESSAGES = {
  dm_needs_member: 'a DM conversation must name the member whose DM it is',
  group_has_no_member: 'a group conversation must not name a member',
  primary_must_be_group: 'the primary conversation must be a group conversation, not a DM',
} as const satisfies Readonly<Record<string, string>>;

export class SqliteConversationRepository implements ConversationReader, ConversationRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  byId(groupId: GroupId, id: ConversationId): Conversation | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(conversations)
        .where(and(eq(conversations.groupId, groupId), eq(conversations.id, id))),
    );
    return row === undefined ? undefined : toConversation(row);
  }

  /** Q-ING-2's second step, through `conversations_platform_uq`. */
  byPlatform(
    groupId: GroupId,
    channel: ChannelId,
    platformChatId: string,
  ): Conversation | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.channel, channel),
            eq(conversations.platformChatId, platformChatId),
            eq(conversations.groupId, groupId),
          ),
        ),
    );
    return row === undefined ? undefined : toConversation(row);
  }

  /** `07` SC-2: the conversation whose membership is the whole group. */
  primary(groupId: GroupId): Conversation | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(conversations)
        .where(and(eq(conversations.groupId, groupId), eq(conversations.primary, true))),
    );
    return row === undefined ? undefined : toConversation(row);
  }

  list(
    groupId: GroupId,
    filter?: { readonly kind?: Conversation['kind'] | undefined },
  ): readonly Conversation[] {
    const where =
      filter?.kind === undefined
        ? eq(conversations.groupId, groupId)
        : and(eq(conversations.groupId, groupId), eq(conversations.kind, filter.kind));
    const rows = this.#db
      .select()
      .from(conversations)
      .where(where)
      .orderBy(asc(conversations.boundAt), asc(conversations.id))
      .all();
    return rows.map(toConversation);
  }

  create(uow: TxToken, conversation: NewConversation): WriteResult<Conversation> {
    const shape = conversationShapeError(conversation);
    if (shape !== undefined) {
      throw new StorageError('STORAGE_CONSTRAINT', SHAPE_MESSAGES[shape], {
        hint: 'This is a bug in the caller: the shape is decided before the write.',
        category: 'bug',
      });
    }
    try {
      const row = exactlyOne(
        this.#db
          .insert(conversations)
          .values({
            id: conversation.id,
            groupId: conversation.groupId,
            channel: conversation.channel,
            platformChatId: conversation.platformChatId,
            kind: conversation.kind,
            memberId: conversation.memberId,
            primary: conversation.primary ?? false,
            title: conversation.title,
            boundAt: conversation.boundAt,
            createdAt: uow.now,
            updatedAt: uow.now,
          })
          .returning(),
        'the conversation',
      );
      return writeOk(toConversation(row));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = this.byPlatform(
        conversation.groupId,
        conversation.channel,
        conversation.platformChatId,
      );
      return duplicate(existing?.id ?? conversation.id);
    }
  }

  setTitle(
    uow: TxToken,
    groupId: GroupId,
    id: ConversationId,
    title: string | null,
  ): WriteResult<Conversation> {
    const row = maybeOne(
      this.#db
        .update(conversations)
        .set({ title, updatedAt: uow.now })
        .where(and(eq(conversations.groupId, groupId), eq(conversations.id, id)))
        .returning(),
    );
    return row === undefined ? notFound() : writeOk(toConversation(row));
  }

  /**
   * Promote a conversation to primary, demoting whatever held it.
   *
   * Demote first, then promote: `conversations_one_primary_uq` is enforced per statement, so the
   * other order fails on the second row. Both statements are in the caller's transaction, so a
   * crash between them leaves the group with its original primary rather than with none — which is
   * the safer of the two intermediate states, because `07` SC-2's scheduling needs one to exist.
   *
   * Also sets `groups.primary_conversation_id`? No — that is `GroupRepository.link`'s job. Two
   * repositories writing the same pointer is how the two copies drift; the caller does both in one
   * transaction, and `03`'s group-creation path is the only caller.
   */
  setPrimary(uow: TxToken, groupId: GroupId, id: ConversationId): WriteResult<Conversation> {
    const target = this.byId(groupId, id);
    if (target === undefined) return notFound();
    if (target.kind !== 'group') {
      throw new StorageError('STORAGE_CONSTRAINT', SHAPE_MESSAGES.primary_must_be_group, {
        hint: 'This is a bug in the caller: a DM cannot be the primary conversation.',
        category: 'bug',
      });
    }
    this.#db
      .update(conversations)
      .set({ primary: false, updatedAt: uow.now })
      .where(and(eq(conversations.groupId, groupId), eq(conversations.primary, true)))
      .run();
    const row = maybeOne(
      this.#db
        .update(conversations)
        .set({ primary: true, updatedAt: uow.now })
        .where(and(eq(conversations.groupId, groupId), eq(conversations.id, id)))
        .returning(),
    );
    return row === undefined ? notFound() : writeOk(toConversation(row));
  }
}
