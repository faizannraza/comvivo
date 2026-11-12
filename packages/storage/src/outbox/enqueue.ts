/**
 * The outbox **enqueue** primitive (`02` §3.9).
 *
 * One function, because there is exactly one way an outbox row comes into being and three things
 * have to be true of every one of them:
 *
 *  - **`seq` is assigned here**, as `coalesce(max(seq), 0) + 1` per conversation, inside the
 *    caller's write transaction. `02` §3.9 makes `seq` the FIFO order a multi-part reply is sent
 *    in, so two turns computing it outside the transaction would claim the same position and the
 *    dispatcher would pick one of them arbitrarily.
 *  - **A repeated `idempotency_key` is not an error.** `02` §3.9(a) gives the shape:
 *    `INSERT … ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`, and "a missing row means it
 *    was already enqueued". That is invariant **I6** for sends — a retried turn must not say the
 *    same thing twice.
 *  - **`guard_ref` is non-empty**, which the column's own `CHECK` enforces. Invariant **I5**: a
 *    send that was never guarded cannot be represented.
 *
 * Why this lives here in `M1-T21` rather than waiting for `M1-T22`: `02` §3.8 makes
 * `TurnJournal.recover` insert the recovery summary, ack the effects and mark the turn `recovered`
 * in **one** transaction, and splitting that would let recovery acknowledge effects nobody will
 * ever be told about. `M1-T22` owns the state machine around this — claim, markSent, markFailed,
 * recoverSending and the dedupe window — and builds on this function rather than repeating it.
 */
import type { NewOutboxMessage, OutboxMessage } from '@comvivo/core';
import { duplicate, type WriteResult, writeOk } from '@comvivo/core';
import type { ConversationId, OutboxId } from '@comvivo/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Temporal } from 'temporal-polyfill';
import type { Db } from '../db/drizzle.js';
import { exactlyOne, maybeOne } from '../db/drizzle.js';
import { toOutboxMessage } from '../repos/rows.js';
import { outboxMessages } from '../schema/runtime.js';

/**
 * Insert one outbox row, or report that it was already enqueued.
 *
 * `labelId` and `manifestLabelIds` are passed as interned ids rather than `Label`s: by the time a
 * send is enqueued, `05` has already interned the audience and run the guard over the rendered
 * text, so interning again here would be a second chance to intern a *different* label than the
 * one the guard checked.
 */
export function enqueueOutbox(
  db: Db,
  message: NewOutboxMessage,
  /** The transaction's clock reading, so every row written in one transaction shares a `created_at`. */
  now: Temporal.Instant,
): WriteResult<OutboxMessage> {
  // The key is checked **first**, and that ordering is what keeps both branches reachable: an
  // `INSERT … ON CONFLICT DO NOTHING RETURNING` that returned no row would need a follow-up query
  // whose "the row must be there" case nothing can ever exercise. Safe to look before leaping
  // because `02` §3.7.2 gives the store one write connection and better-sqlite3 serialises
  // writes — there is no window between the check and the insert for another writer to use.
  const existing = maybeOne(
    db
      .select({ id: outboxMessages.id })
      .from(outboxMessages)
      .where(eq(outboxMessages.idempotencyKey, message.idempotencyKey)),
  );
  // `02` §3.9(a): a re-sent enqueue is answered, not refused — and the answer is the id that is
  // **in the table**, because that is what the caller will ack with. Its own id points at nothing.
  if (existing !== undefined) return duplicate(existing.id);

  const row = exactlyOne(
    db
      .insert(outboxMessages)
      .values({
        id: message.id,
        groupId: message.groupId,
        conversationId: message.conversationId,
        turnId: message.turnId,
        // Computed in SQL rather than read-then-written, so two enqueues in the same transaction
        // cannot both read the same maximum.
        seq: sql`coalesce((SELECT max(${outboxMessages.seq}) FROM ${outboxMessages}
                           WHERE ${outboxMessages.conversationId} = ${message.conversationId}), 0) + 1`,
        idempotencyKey: message.idempotencyKey,
        messageClass: message.messageClass,
        priority: message.priority,
        expiryClass: message.expiryClass,
        payload: message.payload,
        parts: [],
        contentHash: Buffer.from(message.contentHash),
        audienceReaderSetId: message.audienceReaderSetId,
        labelId: message.labelId,
        guardRef: message.guardRef,
        manifestLabelIds: [...message.manifestLabelIds],
        status: 'pending',
        nextAttemptAt: message.nextAttemptAt,
        createdAt: now,
      })
      .returning(),
    'the enqueued send',
  );
  return writeOk(toOutboxMessage(row));
}

/** One outbox row by id, for the journal's acks and `M1-T22`'s tests. */
export function outboxById(db: Db, id: OutboxId): OutboxMessage | undefined {
  const row = maybeOne(db.select().from(outboxMessages).where(eq(outboxMessages.id, id)));
  return row === undefined ? undefined : toOutboxMessage(row);
}

/** A conversation's queued rows in FIFO order, for the journal's recovery tests. */
export function pendingForConversation(
  db: Db,
  conversationId: ConversationId,
  limit: number,
): readonly OutboxMessage[] {
  return db
    .select()
    .from(outboxMessages)
    .where(
      and(
        eq(outboxMessages.conversationId, conversationId),
        inArray(outboxMessages.status, ['pending', 'sending']),
      ),
    )
    .orderBy(outboxMessages.seq)
    .limit(limit)
    .all()
    .map(toOutboxMessage);
}
