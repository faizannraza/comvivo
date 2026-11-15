/**
 * Chat bindings, aliases and DM contexts (`02` §3.3.1; `06` §3.20, §3.21.1, `01` §14 **A27**).
 *
 * ## The lookup on every inbound message
 *
 * `byPlatformChat` is `02` §3.3.9's **Q-ING-2**, and it runs before anything else knows what a
 * message is: one index hit on `chat_bindings_platform_uq`, returning the whole row so the caller
 * does not need a second query for the group. `M3-T1`'s AC budgets ingestion at p95 ≤ 3 ms and
 * this is the first of its queries.
 *
 * ## A27 in one sentence
 *
 * An unclaimed chat persists **this row and nothing else** — no conversation, no messages, no
 * persons. So `seen()` is the only write that happens for a chat nobody has claimed, and the
 * `chat_bindings_unclaimed_ck` constraint makes a `group_id` on such a row impossible rather than
 * merely discouraged: a group id there would say which group somebody tried to add the bot for,
 * which is exactly the fact an accidental add must not leave behind.
 */
import type {
  ChannelId,
  ChatBinding,
  ChatBindingReader,
  ChatBindingRepository,
  ChatProbe,
  NewChatBinding,
  TxToken,
  WriteResult,
} from '@comvivo/core';
import { notFound, writeOk } from '@comvivo/core';
import type {
  ChatBindingId,
  ConversationId,
  GroupId,
  IdGenerator,
  PersonId,
} from '@comvivo/shared';
import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import type { Temporal } from 'temporal-polyfill';
import { type Db, maybeOne } from '../db/drizzle.js';
import { isUniqueViolation } from '../db/errors.js';
import {
  channelChatAliases,
  chatBindings,
  conversations,
  dmContexts,
  outboxMessages,
} from '../schema/index.js';

type Instant = Temporal.Instant;

/** The row, as the port's shape. */
function toBinding(row: typeof chatBindings.$inferSelect): ChatBinding {
  return {
    id: row.id,
    channel: row.channel,
    platformChatId: row.platformChatId,
    status: row.status,
    ...(row.groupId === null ? {} : { groupId: row.groupId }),
    ...(row.conversationId === null ? {} : { conversationId: row.conversationId }),
    firstSeenAt: row.firstSeenAt,
    ...(row.unclaimedNoticeAt === null ? {} : { unclaimedNoticeAt: row.unclaimedNoticeAt }),
    ...(row.leaveAt === null ? {} : { leaveAt: row.leaveAt }),
    ...(row.detachedAt === null ? {} : { detachedAt: row.detachedAt }),
    ...(row.lastProbe === null ? {} : { lastProbe: row.lastProbe }),
  };
}

export class SqliteChatBindingRepository implements ChatBindingReader, ChatBindingRepository {
  readonly #db: Db;
  readonly #ids: IdGenerator;

  constructor(db: Db, ids: IdGenerator) {
    this.#db = db;
    this.#ids = ids;
  }

  byPlatformChat(channel: ChannelId, platformChatId: string): ChatBinding | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(chatBindings)
        .where(
          and(eq(chatBindings.channel, channel), eq(chatBindings.platformChatId, platformChatId)),
        ),
    );
    return row === undefined ? undefined : toBinding(row);
  }

  conversationByAlias(channel: ChannelId, oldPlatformChatId: string): ConversationId | undefined {
    const row = maybeOne(
      this.#db
        .select({ conversationId: channelChatAliases.conversationId })
        .from(channelChatAliases)
        .where(
          and(
            eq(channelChatAliases.channel, channel),
            eq(channelChatAliases.oldPlatformChatId, oldPlatformChatId),
          ),
        ),
    );
    return row?.conversationId;
  }

  dueToLeave(now: Instant, limit: number): readonly ChatBinding[] {
    return (
      this.#db
        .select()
        .from(chatBindings)
        .where(
          and(
            eq(chatBindings.status, 'unclaimed'),
            isNotNull(chatBindings.leaveAt),
            lte(chatBindings.leaveAt, now),
          ),
        )
        // Oldest first, so a backlog is cleared in the order the chats were joined rather than in
        // whatever order the index happens to return.
        .orderBy(asc(chatBindings.leaveAt))
        .limit(limit)
        .all()
        .map(toBinding)
    );
  }

  activeDmGroup(channel: ChannelId, platformChatId: string): GroupId | undefined {
    const row = maybeOne(
      this.#db
        .select({ activeGroupId: dmContexts.activeGroupId })
        .from(dmContexts)
        .where(and(eq(dmContexts.channel, channel), eq(dmContexts.platformChatId, platformChatId))),
    );
    // `null` is "not chosen yet" (`03` E20), which is a real state and not a missing value — the
    // caller persists nothing until a group is picked.
    return row?.activeGroupId ?? undefined;
  }

  seen(uow: TxToken, binding: NewChatBinding): WriteResult<ChatBinding> {
    const existing = this.byPlatformChat(binding.channel, binding.platformChatId);
    if (existing !== undefined) return writeOk(existing);
    const row = {
      id: this.#ids.next('chb'),
      channel: binding.channel,
      platformChatId: binding.platformChatId,
      status: 'unclaimed' as const,
      groupId: null,
      conversationId: null,
      firstSeenAt: binding.firstSeenAt,
      unclaimedNoticeAt: null,
      leaveAt: binding.leaveAt ?? null,
      detachedAt: null,
      lastProbe: null,
      updatedAt: uow.now,
    };
    try {
      this.#db.insert(chatBindings).values(row).run();
    } catch (error) {
      // Two messages arriving at once in a brand-new chat is the common case, not an edge: a
      // member adds the bot and three people say hello. The loser of that insert reads the
      // winner's row rather than failing the turn that triggered it.
      if (!isUniqueViolation(error)) throw error;
      const won = this.byPlatformChat(binding.channel, binding.platformChatId);
      if (won === undefined) throw error;
      return writeOk(won);
    }
    return writeOk(toBinding(row));
  }

  noticePosted(_uow: TxToken, id: ChatBindingId, at: Instant): WriteResult<void> {
    // `unclaimed_notice_at IS NULL` in the `WHERE` is what makes this once-per-chat, and the row
    // count is deliberately **not** read: the notice is posted once (`06` §3.20.1), so a second
    // call matching nothing is the guarantee working rather than a failure to report.
    this.#db
      .update(chatBindings)
      .set({ unclaimedNoticeAt: at, updatedAt: at })
      .where(and(eq(chatBindings.id, id), sql`${chatBindings.unclaimedNoticeAt} IS NULL`))
      .run();
    return writeOk(undefined);
  }

  bind(
    uow: TxToken,
    id: ChatBindingId,
    to: { readonly groupId: GroupId; readonly conversationId: ConversationId },
  ): WriteResult<ChatBinding> {
    this.#db
      .update(chatBindings)
      .set({
        status: 'bound',
        groupId: to.groupId,
        conversationId: to.conversationId,
        updatedAt: uow.now,
      })
      .where(eq(chatBindings.id, id))
      .run();
    const row = this.byPlatformChatById(id);
    return row === undefined ? notFound() : writeOk(row);
  }

  detach(_uow: TxToken, id: ChatBindingId, at: Instant): WriteResult<ChatBinding> {
    this.#db
      .update(chatBindings)
      .set({ status: 'detached', detachedAt: at, updatedAt: at })
      .where(eq(chatBindings.id, id))
      .run();
    const row = this.byPlatformChatById(id);
    return row === undefined ? notFound() : writeOk(row);
  }

  recordProbe(uow: TxToken, id: ChatBindingId, probe: ChatProbe): WriteResult<void> {
    this.#db
      .update(chatBindings)
      .set({ lastProbe: probe, updatedAt: uow.now })
      .where(eq(chatBindings.id, id))
      .run();
    return writeOk(undefined);
  }

  migrateChat(
    uow: TxToken,
    move: {
      readonly channel: ChannelId;
      readonly fromPlatformChatId: string;
      readonly toPlatformChatId: string;
    },
  ): WriteResult<{ readonly conversationId: ConversationId; readonly outboxRetargeted: number }> {
    const binding = this.byPlatformChat(move.channel, move.fromPlatformChatId);
    if (binding?.conversationId === undefined) return notFound();
    const conversationId = binding.conversationId;

    // **One transaction** (`M3-T1`'s AC), in an order chosen so nothing reads a half-moved chat:
    //
    //  1. the alias, so the old id still resolves for events already in flight toward us;
    //  2. the conversation's `platform_chat_id`;
    //  3. the binding's;
    //  4. the pending outbox rows.
    this.#db
      .insert(channelChatAliases)
      .values({
        channel: move.channel,
        oldPlatformChatId: move.fromPlatformChatId,
        conversationId,
        createdAt: uow.now,
      })
      .onConflictDoNothing()
      .run();
    this.#db
      .update(conversations)
      .set({ platformChatId: move.toPlatformChatId, updatedAt: uow.now })
      .where(eq(conversations.id, conversationId))
      .run();
    this.#db
      .update(chatBindings)
      .set({ platformChatId: move.toPlatformChatId, updatedAt: uow.now })
      .where(eq(chatBindings.id, binding.id))
      .run();

    // Step 4, and the one that needs explaining: an `outbox_messages` row addresses its
    // destination through `conversation_id` and carries no platform chat id of its own, so step 2
    // is what re-points it. What is left is *when* it goes out — a row sitting on a backoff from a
    // failure against the old id would wait minutes for an address that is now correct. So the
    // re-target is a wake: `next_attempt_at = now`, and `06` §3.21.1's "the dispatcher re-targets
    // and retries immediately" becomes true for queued rows as well as for the one that got the
    // `400`. The count is this statement's, which is what makes the AC's claim checkable.
    //
    // `sending` rows are deliberately untouched. One is leased by a dispatcher that is mid-send;
    // reclaiming it here would let two workers send the same message, which breaks **I6**. Its
    // own send fails with `chat_migrated`, and that error path — not this transaction — retries it
    // on the new id. Rows that are `sent`, `dead`, `cancelled` or `expired` are finished.
    const outboxRetargeted = this.#db
      .update(outboxMessages)
      .set({ nextAttemptAt: uow.now })
      .where(
        and(
          eq(outboxMessages.conversationId, conversationId),
          eq(outboxMessages.status, 'pending'),
        ),
      )
      .returning({ id: outboxMessages.id })
      .all().length;

    return writeOk({ conversationId, outboxRetargeted });
  }

  setDmContext(
    _uow: TxToken,
    context: {
      readonly channel: ChannelId;
      readonly platformChatId: string;
      readonly personId: PersonId;
      readonly activeGroupId?: GroupId;
      readonly setAt: Instant;
    },
  ): WriteResult<void> {
    this.#db
      .insert(dmContexts)
      .values({
        channel: context.channel,
        platformChatId: context.platformChatId,
        personId: context.personId,
        activeGroupId: context.activeGroupId ?? null,
        setAt: context.setAt,
      })
      .onConflictDoUpdate({
        target: [dmContexts.channel, dmContexts.platformChatId],
        set: {
          personId: context.personId,
          activeGroupId: context.activeGroupId ?? null,
          setAt: context.setAt,
        },
      })
      .run();
    return writeOk(undefined);
  }

  /** By primary key, for the read-back after an update. */
  private byPlatformChatById(id: ChatBindingId): ChatBinding | undefined {
    const row = maybeOne(this.#db.select().from(chatBindings).where(eq(chatBindings.id, id)));
    return row === undefined ? undefined : toBinding(row);
  }
}
