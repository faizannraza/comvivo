/**
 * The transactional outbox port (`02` §3.7.1, §3.9; `06` §4.3).
 *
 * `02` §4.1 names it `OutboxRepository` with `enqueue`, `claim`, `markSent`, `markFailed` and
 * `recoverSending`. Four shapes here are required by §3.9 rather than chosen:
 *
 *  - **`claim` selects the FIFO head per conversation.** A long reply is several rows, and they
 *    have to leave in `seq` order — so the claim takes the lowest in-flight `seq` per conversation,
 *    not simply the oldest due row. Without that, a three-part reply can arrive 2, 1, 3.
 *  - **`markSent` writes the assistant message in the same transaction.** `02` §3.9's receipt row
 *    does both, and the reason is Q-ING-5: the router detects "a reply to a Village message" by
 *    finding it in `messages`, so a receipt recorded without the message leaves the bot unable to
 *    recognise its own words.
 *  - **Every settling write is fenced on `attempts`.** `WHERE id=? AND status='sending' AND
 *    attempts=?`. A dispatcher whose lease expired mid-send may come back and report success for a
 *    send another worker has already retried; the fence is what makes that report land on no row.
 *  - **A lease that expires sets `maybe_sent`.** `02` §3.9: the row goes back to `pending` with
 *    `maybe_sent = 1`, because the platform may or may not have delivered it. `06` §3.13 decides
 *    what to do about that per platform; storage's job is to record the ambiguity rather than
 *    resolve it in either direction.
 */
import type { ConversationId, GroupId, OutboxId, TurnId } from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';
import type { ErrorInfo } from '../../../domain/error-info.js';
import type { Message, NewMessage } from '../../../domain/message.js';
import type { Label } from '../../../ifc/eligible.js';
import type { NewOutboxMessage, OutboxMessage, OutboxStatus } from '../../../runtime/outbox.js';
import type { TxToken, WriteResult } from '../uow.js';

export interface OutboxReader {
  byId(id: OutboxId): OutboxMessage | undefined;
  /** Q-OBX-2: a conversation's queue, in the order it will be sent. */
  queued(conversationId: ConversationId, limit: number): readonly OutboxMessage[];
  /**
   * Q-OBX-3: a row with the same `(conversation, contentHash)` sent inside the window.
   *
   * `02` §3.9(b)'s duplicate defence, read **before** sending. Not a label-filtered read, because
   * the question is "did we just say this" — a property of the conversation's recent output, not of
   * an audience. The caller's response is to cancel its own row, so nothing is rendered from this.
   */
  recentlySent(
    conversationId: ConversationId,
    contentHash: Uint8Array,
    since: Temporal.Instant,
  ): OutboxMessage | undefined;
  /** Q-OBX-4: sends whose lease has expired, for boot recovery. */
  staleSending(before: Temporal.Instant, limit: number): readonly OutboxMessage[];
  /** Q-OBX-5: `07`'s attention budget counts `proactive` rows rather than keeping a ledger. */
  sentCount(query: {
    readonly groupId: GroupId;
    readonly messageClass: OutboxMessage['messageClass'];
    readonly since: Temporal.Instant;
  }): number;
  /** Rows in a terminal failure state, for the dashboard and `village doctor`. */
  dead(limit: number): readonly OutboxMessage[];
}

/** What `markSent` needs from the platform's receipt (`06` §3.13). */
export interface SendReceipt {
  readonly platformMessageId: string;
  readonly at: Temporal.Instant;
  /** The parts actually delivered, for `06` CH-10's split resume. */
  readonly parts?: OutboxMessage['parts'] | undefined;
}

/** How a failed send should be treated (`02` §3.9). */
export interface SendFailure {
  readonly error: ErrorInfo;
  /** A platform `Retry-After`, which overrides the computed backoff when it is longer. */
  readonly retryAfterMs?: number | undefined;
  /** The send may have landed: `06`'s ambiguous failure. Sets `maybe_sent`. */
  readonly maybeSent?: boolean | undefined;
}

export interface OutboxRepository {
  /**
   * Enqueue a send, in the caller's transaction (`02` §3.9).
   *
   * `seq` is assigned here, per conversation. Returns `duplicate` with the id already under this
   * `idempotency_key` — invariant **I6** for sends, and the caller needs *that* id because it is
   * what the turn journal will acknowledge its effects with.
   */
  enqueue(uow: TxToken, message: NewOutboxMessage): WriteResult<OutboxMessage>;
  /**
   * Claim up to `limit` sends for this dispatcher (`02` §3.9).
   *
   * One statement, so two dispatchers cannot claim the same row. Takes the lowest in-flight `seq`
   * per conversation, which is what keeps a multi-part reply in order.
   */
  claim(
    uow: TxToken,
    query: { readonly now: Temporal.Instant; readonly leaseMs: number; readonly limit: number },
  ): readonly OutboxMessage[];
  /**
   * Record a receipt and write the assistant message, in one transaction (`02` §3.9).
   *
   * `label` is the reply's own label — the one `05`'s guard passed the rendered text under. The
   * repository **checks it against the row's** `label_id` and refuses a mismatch, because a message
   * written under a different label than the send it records would be an I1 hole that no later read
   * could detect.
   */
  markSent(
    uow: TxToken,
    id: OutboxId,
    expectAttempts: number,
    receipt: SendReceipt,
    message: { readonly message: NewMessage; readonly label: Label },
  ): WriteResult<{ readonly sent: OutboxMessage; readonly message: Message }>;
  /**
   * Record a failure: back to `pending` with a backoff, or `dead` (`02` §3.9).
   *
   * `dead` when the error is not retryable or the attempts are spent. Fenced on `attempts`, so a
   * dispatcher reporting a failure for a send another worker has already retried changes nothing.
   */
  markFailed(
    uow: TxToken,
    id: OutboxId,
    expectAttempts: number,
    failure: SendFailure,
    at: Temporal.Instant,
  ): WriteResult<OutboxMessage>;
  /**
   * `02` §3.9(b): cancel a row we are about to duplicate, or one whose chat is gone.
   *
   * Not fenced on `attempts`: the cancel happens *before* a claim in the duplicate case and from
   * outside the dispatcher in the detach case (`06` F1), so there is no attempt to fence against.
   * Only a row that has not been sent can be cancelled, which is the fence that matters.
   */
  cancel(uow: TxToken, id: OutboxId, error: ErrorInfo): WriteResult<OutboxMessage>;
  /**
   * `02` §3.9: a lease expired **or the process restarted**, so the send is back in the queue.
   *
   * Those are two different triggers and only one of them is a time comparison, which is why
   * `before` is optional:
   *
   *  - **With `before`** — the periodic sweep inside a running process. Only rows whose lease has
   *    actually expired, because another dispatcher slot in this same process may be mid-send on
   *    the others and recovering those would hand the same message to two workers.
   *  - **Without it** — boot. Every `sending` row belongs to the incarnation that just died, so
   *    every one of them is recovered immediately. `outbox_messages` has no `lease_owner` column
   *    (`02` §3.3.7) — unlike `jobs`, which filters on `lease_owner NOT LIKE :bootId` — so a
   *    time comparison cannot express "this lease belongs to a process that no longer exists", and
   *    a boot that waited for the leases to expire would sit on a queue of replies for 30 seconds
   *    after every restart.
   *
   * Every recovered row gets `maybe_sent = 1` either way, because the platform may or may not have
   * taken it. Returns how many moved.
   */
  recoverSending(
    uow: TxToken,
    query: { readonly now: Temporal.Instant; readonly before?: Temporal.Instant | undefined },
  ): number;
  /**
   * `06` §4.3: rows past their expiry class's deadline become `expired`.
   *
   * `must_deliver` never expires — a reply carrying an I7 acknowledgement has to arrive or be
   * visibly dead, and dropping it quietly is the one outcome the invariant forbids.
   */
  expire(uow: TxToken, now: Temporal.Instant): number;
  /** Re-queue a dead row from the dashboard (`09`). `02` §3.10.3's `retryDead`, for sends. */
  retryDead(uow: TxToken, id: OutboxId, now: Temporal.Instant): WriteResult<OutboxMessage>;
}

/** The statuses a send can be in when it is no longer the dispatcher's problem (`02` §3.9). */
export const TERMINAL_OUTBOX_STATUSES: readonly OutboxStatus[] = [
  'sent',
  'dead',
  'cancelled',
  'expired',
];

/** The id a send is minted with, for a caller threading it through a turn. */
export type OutboxRef = { readonly id: OutboxId; readonly turnId: TurnId | undefined };
