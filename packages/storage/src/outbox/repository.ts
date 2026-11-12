/**
 * The transactional outbox (`02` §3.7.1, §3.9; `06` §4.3).
 *
 * ## The state machine is the design
 *
 * `02` §3.9 draws it, and every transition here is one of its arrows. Three of them carry the
 * weight:
 *
 *  - **`pending → sending`** is a single `UPDATE … RETURNING` that selects the **FIFO head per
 *    conversation**. A long reply is several rows and they have to leave in `seq` order, so the
 *    claim takes the lowest in-flight `seq` per conversation rather than simply the oldest due row.
 *    One statement, so two dispatchers cannot claim the same send.
 *  - **`sending → sent`** writes the assistant message in the **same transaction** as the receipt.
 *    Q-ING-5 is why: the router recognises "a reply to a Village message" by finding it in
 *    `messages`, so a receipt without the message leaves the bot unable to recognise its own words.
 *  - **`sending → pending` with `maybe_sent = 1`** is what a lost lease produces. The platform may
 *    or may not have delivered it, and `06` §3.13 decides what to do about that per platform —
 *    Discord and Matrix can verify, Telegram and Signal cannot. Storage's job is to **record the
 *    ambiguity** rather than resolve it in either direction, because both resolutions are wrong on
 *    some platform.
 *
 * ## Why every settling write is fenced on `attempts`
 *
 * `WHERE id = ? AND status = 'sending' AND attempts = ?`. A dispatcher whose lease expired mid-send
 * can come back minutes later and report success for a row another worker has since retried — and
 * without the fence, that late report would overwrite a live send's state with a stale receipt.
 * `attempts` is the fencing token because the claim increments it, so it changes exactly when
 * ownership does.
 */
import type {
  ErrorInfo,
  Label,
  Message,
  NewMessage,
  NewOutboxMessage,
  OutboxMessage,
  OutboxReader,
  OutboxRepository,
  SendFailure,
  SendReceipt,
  TxToken,
  WriteResult,
} from '@comvivo/core';
import {
  attemptsExhausted,
  backoffMs,
  notFound,
  OUTBOX_BACKOFF,
  writeConflict,
  writeOk,
} from '@comvivo/core';
import {
  type ConversationId,
  type GroupId,
  type OutboxId,
  type Rng,
  StorageError,
} from '@comvivo/shared';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Temporal } from 'temporal-polyfill';
import type { Db } from '../db/drizzle.js';
import { maybeOne, type Patch } from '../db/drizzle.js';
import type { LabelStore } from '../ifc/label-store.js';
import type { SqliteMessageRepository } from '../repos/messages.js';
import { toOutboxMessage } from '../repos/rows.js';
import { outboxMessages, turnEffects } from '../schema/runtime.js';
import { enqueueOutbox } from './enqueue.js';

/** `02` §3.9: the claim's lease, in milliseconds. */
export const DEFAULT_LEASE_MS = 30_000;

/** `02` §3.9(b): `outbox.dedupeWindowMs`, the recent-sent window. */
export const DEFAULT_DEDUPE_WINDOW_MS = 600_000;

/**
 * `06` §4.3's expiry deadlines, in milliseconds from `created_at`.
 *
 * `must_deliver` is absent rather than set to infinity, and the absence is the point: a reply
 * carrying an I7 acknowledgement has to arrive or be **visibly dead**, so there is no number that
 * would be correct here. `06` §4.3 says it is "retried until `chat_access_lost` or
 * `auth_revoked`", which are cancellations rather than expiries.
 */
const EXPIRY_MS: Readonly<Record<OutboxMessage['expiryClass'], number | undefined>> = {
  must_deliver: undefined,
  timely: 30 * 60_000,
  best_effort: 6 * 3_600_000,
};

export interface OutboxOptions {
  readonly db: Db;
  readonly labels: LabelStore;
  /** For the receipt's assistant message, which `02` §3.9 writes in the same transaction. */
  readonly messages: SqliteMessageRepository;
  /** `02` §3.10.3's injected `rng`, so a backoff is deterministic in a test. */
  readonly rng: Rng;
}

export class SqliteOutboxRepository implements OutboxReader, OutboxRepository {
  readonly #db: Db;
  readonly #labels: LabelStore;
  readonly #messages: SqliteMessageRepository;
  readonly #rng: Rng;

  constructor(options: OutboxOptions) {
    this.#db = options.db;
    this.#labels = options.labels;
    this.#messages = options.messages;
    this.#rng = options.rng;
  }

  /* ───────────────────────────── Reads ───────────────────────────── */

  byId(id: OutboxId): OutboxMessage | undefined {
    const row = this.#row(id);
    return row === undefined ? undefined : toOutboxMessage(row);
  }

  /** Q-OBX-2: the queue in send order. */
  queued(conversationId: ConversationId, limit: number): readonly OutboxMessage[] {
    return this.#db
      .select()
      .from(outboxMessages)
      .where(
        and(
          eq(outboxMessages.conversationId, conversationId),
          inArray(outboxMessages.status, ['pending', 'sending']),
        ),
      )
      .orderBy(asc(outboxMessages.seq))
      .limit(limit)
      .all()
      .map(toOutboxMessage);
  }

  /** Q-OBX-3, through `outbox_recent_sent_idx`. */
  recentlySent(
    conversationId: ConversationId,
    contentHash: Uint8Array,
    since: Temporal.Instant,
  ): OutboxMessage | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(outboxMessages)
        .where(
          and(
            eq(outboxMessages.conversationId, conversationId),
            eq(outboxMessages.contentHash, Buffer.from(contentHash)),
            eq(outboxMessages.status, 'sent'),
            gte(outboxMessages.sentAt, since),
          ),
        )
        .orderBy(desc(outboxMessages.sentAt)),
    );
    return row === undefined ? undefined : toOutboxMessage(row);
  }

  /** Q-OBX-4, through `outbox_sending_idx`. */
  staleSending(before: Temporal.Instant, limit: number): readonly OutboxMessage[] {
    return this.#db
      .select()
      .from(outboxMessages)
      .where(and(eq(outboxMessages.status, 'sending'), lte(outboxMessages.leaseUntil, before)))
      .orderBy(asc(outboxMessages.leaseUntil))
      .limit(limit)
      .all()
      .map(toOutboxMessage);
  }

  /** Q-OBX-5, through `outbox_class_idx`: `07`'s attention budget. */
  sentCount(query: {
    readonly groupId: GroupId;
    readonly messageClass: OutboxMessage['messageClass'];
    readonly since: Temporal.Instant;
  }): number {
    const row = maybeOne(
      this.#db
        .select({ n: sql<number>`count(*)` })
        .from(outboxMessages)
        .where(
          and(
            eq(outboxMessages.groupId, query.groupId),
            eq(outboxMessages.messageClass, query.messageClass),
            eq(outboxMessages.status, 'sent'),
            gte(outboxMessages.sentAt, query.since),
          ),
        ),
    );
    return row?.n ?? 0;
  }

  dead(limit: number): readonly OutboxMessage[] {
    return this.#db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.status, 'dead'))
      .orderBy(asc(outboxMessages.createdAt))
      .limit(limit)
      .all()
      .map(toOutboxMessage);
  }

  /* ───────────────────────────── Writes ───────────────────────────── */

  enqueue(uow: TxToken, message: NewOutboxMessage): WriteResult<OutboxMessage> {
    return enqueueOutbox(this.#db, message, uow.now);
  }

  /**
   * `02` §3.9's claim, as one statement.
   *
   * The inner `seq = (SELECT min(seq) …)` is what makes it FIFO **per conversation**: a reply split
   * into three rows leaves in order, and a conversation with a stuck head does not let its second
   * message overtake. `attempts + 1` is the fencing token every settling write checks.
   */
  claim(
    _uow: TxToken,
    query: { readonly now: Temporal.Instant; readonly leaseMs: number; readonly limit: number },
  ): readonly OutboxMessage[] {
    const now = query.now.epochMilliseconds;
    const rows = this.#db
      .update(outboxMessages)
      .set({
        status: 'sending',
        attempts: sql`${outboxMessages.attempts} + 1`,
        leaseUntil: sql`${now} + ${query.leaseMs}`,
        inFlightSince: query.now,
      })
      .where(
        sql`${outboxMessages.id} IN (
          SELECT o.id FROM ${outboxMessages} o
          WHERE o.status = 'pending' AND o.next_attempt_at <= ${now}
            AND o.seq = (SELECT min(h.seq) FROM ${outboxMessages} h
                         WHERE h.conversation_id = o.conversation_id
                           AND h.status IN ('pending', 'sending'))
          ORDER BY o.next_attempt_at, o.seq
          LIMIT ${query.limit})`,
      )
      .returning()
      .all();
    // Ordered here rather than by the `UPDATE`: SQLite's `RETURNING` makes no ordering promise, and
    // a dispatcher that sent a conversation's parts in the order it received them would undo the
    // FIFO the inner query just established.
    return rows.map(toOutboxMessage).toSorted((left, right) => left.seq - right.seq);
  }

  markSent(
    uow: TxToken,
    id: OutboxId,
    expectAttempts: number,
    receipt: SendReceipt,
    message: { readonly message: NewMessage; readonly label: Label },
  ): WriteResult<{ readonly sent: OutboxMessage; readonly message: Message }> {
    const row = this.#row(id);
    if (row === undefined) return notFound();
    this.#assertSameLabel(uow, row, message.label);

    // **The fence runs first, and it is the only check.** An earlier version pre-checked the
    // status and attempts here and *then* fenced the `UPDATE` with the same predicate — which made
    // the `WHERE` clause `02` §3.9 specifies unreachable, and a mutation deleting it left every
    // test green. One place, so the clause is load-bearing.
    const sent = this.#settle(id, expectAttempts, {
      status: 'sent',
      sentAt: receipt.at,
      platformMessageId: receipt.platformMessageId,
      // `undefined` is "leave the column alone" in drizzle (measured; `maybe-one.int.test.ts`
      // pins it), so a receipt without parts keeps whatever `06`'s split progress recorded.
      parts: receipt.parts === undefined ? undefined : [...receipt.parts],
      leaseUntil: null,
      inFlightSince: null,
      // The ambiguity is resolved: the platform confirmed. A row that stayed `maybe_sent` after a
      // receipt would send `06`'s duplicate probe looking for a message we already have the id of.
      maybeSent: false,
    });
    if (sent === undefined) return writeConflict();

    // The message **after** the fence, so a conflict writes nothing at all. A refusal from the
    // message repository here is a bug rather than a state — a receipt naming a conversation in
    // another group cannot be recovered from — so it throws and takes the whole transaction with
    // it, instead of returning a result the caller might treat as "try again".
    const written = this.#messages.insert(
      uow,
      { ...message.message, platformMessageId: receipt.platformMessageId },
      message.label,
    );
    if (written.kind !== 'ok' && written.kind !== 'duplicate') {
      throw new StorageError('STORAGE_CONSTRAINT', 'the receipt could not write its message', {
        hint: `The message repository answered ${written.kind}. This is a bug in the caller: a receipt must name a real conversation in the send’s own group.`,
        category: 'bug',
      });
    }
    const stored =
      written.kind === 'ok'
        ? written.value
        : // `duplicate` means the dedupe key is already there: a retried receipt for a send the
          // platform had taken the first time. The existing row is the right answer.
          (this.#messages.byId(message.message.groupId, message.message.id) ??
          (() => {
            throw new StorageError('STORAGE_IO', 'the assistant message vanished', {
              hint: 'This is a bug: `insert` answered `duplicate`, so a row with that dedupe key exists.',
              category: 'bug',
            });
          })());
    return writeOk({ sent: toOutboxMessage(sent), message: stored });
  }

  markFailed(
    _uow: TxToken,
    id: OutboxId,
    expectAttempts: number,
    failure: SendFailure,
    at: Temporal.Instant,
  ): WriteResult<OutboxMessage> {
    // `02` §3.9: "permanent error or attempts ≥ max" is the dead letter. Both halves matter — a
    // retryable error that has used its attempts is still dead, and a permanent one is dead on the
    // first try, because retrying a `410 Gone` is a loop with no exit.
    //
    // `expectAttempts` rather than the row's own count, because the fence is what establishes that
    // they are the same — reading the row first and deciding on *that* would reintroduce the
    // duplicate check that made the fence unreachable.
    const spent = attemptsExhausted(expectAttempts, OUTBOX_BACKOFF.maxAttempts);
    const dead = !failure.error.retryable || spent;
    const settled = this.#settle(id, expectAttempts, {
      status: dead ? 'dead' : 'pending',
      lastError: failure.error,
      leaseUntil: null,
      inFlightSince: null,
      maybeSent: failure.maybeSent,
      // A dead row keeps the `next_attempt_at` it had: nothing will read it, and moving it would
      // make the dashboard's "would have retried at" column a fiction.
      nextAttemptAt: dead
        ? undefined
        : addMs(
            at,
            // A bound arrow, not `this.#rng.next` — an unbound method reference would lose `this`
            // and any seeded generator's state with it, which is the one thing an injected `rng`
            // exists to keep.
            backoffMs(expectAttempts, OUTBOX_BACKOFF, () => this.#rng.next(), failure.retryAfterMs),
          ),
    });
    if (settled !== undefined) return writeOk(toOutboxMessage(settled));
    // The fence matched nothing: either the row is gone or somebody else owns the attempt now.
    return this.#row(id) === undefined ? notFound() : writeConflict();
  }

  /**
   * Cancel every undelivered row of one group (`02` §3.13.4 step 1).
   *
   * **Unbounded**, which every other deletion step here is not, and the reason is what it is for:
   * this runs in the transaction that marks the group `deleting`, and its job is that no further
   * message leaves for a group that is being erased. A chunked version would leave rows behind for
   * the next chunk to find, and a sender claiming one in between would deliver a message *after*
   * the group was deleted — which is the single most visible way this feature can fail.
   *
   * The bound is the table's own shape rather than a `LIMIT`: `02` §3.9 holds only messages not yet
   * delivered plus the terminal rows retention has not yet taken, and a group with thousands of
   * undelivered sends has a delivery outage, not a retention problem. There is deliberately **no**
   * index on `(group_id, status)` — `02` §4 catalogs none, every outbox query in the hot path is by
   * conversation or by status, and an index exists to be maintained on every send rather than to
   * make one statement per group deletion faster. This is a scan, once, per deleted group.
   *
   * `sending` rows are included and `maybe_sent` is left alone: `02` §3.9's at-least-once promise
   * means a row in flight may already have been delivered, and cancelling the row does not unsend
   * it. What it does is stop a *retry*.
   */
  cancelGroup(uow: TxToken, groupId: GroupId, error: ErrorInfo): number {
    return this.#db
      .update(outboxMessages)
      .set({ status: 'cancelled', lastError: error, leaseUntil: null, nextAttemptAt: uow.now })
      .where(
        and(
          eq(outboxMessages.groupId, groupId),
          inArray(outboxMessages.status, ['pending', 'sending']),
        ),
      )
      .returning({ id: outboxMessages.id })
      .all().length;
  }

  cancel(_uow: TxToken, id: OutboxId, error: ErrorInfo): WriteResult<OutboxMessage> {
    const row = maybeOne(
      this.#db
        .update(outboxMessages)
        .set({ status: 'cancelled', lastError: error, leaseUntil: null, inFlightSince: null })
        // Anything not yet delivered. `02` §3.9's arrow is from `pending`, and `06` F1's detach
        // cancels in-flight rows too — but a **sent** row cannot be cancelled, because the message
        // is already in the chat and pretending otherwise would make `messages` and the outbox
        // disagree about what the group was told.
        .where(
          and(eq(outboxMessages.id, id), inArray(outboxMessages.status, ['pending', 'sending'])),
        )
        .returning(),
    );
    if (row !== undefined) return writeOk(toOutboxMessage(row));
    return this.#row(id) === undefined ? notFound() : writeConflict();
  }

  /**
   * `02` §3.9: a lease expired **or** the process restarted. See the port for why those differ.
   *
   * Every recovered row gets `maybe_sent = 1`. Not conditionally: the whole point of the flag is
   * that we do not know, and a heuristic ("it was only two seconds, probably not sent") would be a
   * guess recorded as a fact.
   *
   * `next_attempt_at` is **now**, not a backoff: the send never got an answer, so there is nothing
   * to back off from — the platform may be perfectly healthy and the process may simply have been
   * restarted by a deploy.
   */
  recoverSending(
    _uow: TxToken,
    query: { readonly now: Temporal.Instant; readonly before?: Temporal.Instant | undefined },
  ): number {
    const rows = this.#db
      .update(outboxMessages)
      .set({
        status: 'pending',
        maybeSent: true,
        nextAttemptAt: query.now,
        leaseUntil: null,
        inFlightSince: null,
      })
      .where(
        and(
          eq(outboxMessages.status, 'sending'),
          // No `before` is the boot case: every in-flight row belonged to the incarnation that
          // died, and there is no `lease_owner` to distinguish them by.
          ...(query.before === undefined ? [] : [lte(outboxMessages.leaseUntil, query.before)]),
        ),
      )
      .returning({ id: outboxMessages.id })
      .all();
    return rows.length;
  }

  /**
   * `06` §4.3: past the deadline for its class. `must_deliver` has none.
   *
   * **And neither does a send that acknowledges a turn effect.** `expiry_class` is chosen when the
   * send is enqueued; the acknowledgement is attached later, by `TurnJournal.complete`, so the
   * class cannot know. Nothing in the product sets `must_deliver` today, which left the invariant
   * resting on a flag nobody raises: a reply carrying an `I7` acknowledgement simply aged out
   * after thirty minutes, and the journal went on saying the group had been told. The port's own
   * comment already states the rule — "a reply carrying an I7 acknowledgement has to arrive or be
   * visibly dead" — so this is the rule enforced where it can be. Found at the M1 exit gate.
   *
   * Deliberate cancellation is left alone: a human cancelling a send is an instruction, not a
   * timeout, and `effectsAckedByDeadSends` is what surfaces the consequence.
   */
  expire(_uow: TxToken, now: Temporal.Instant): number {
    let expired = 0;
    for (const [expiryClass, windowMs] of Object.entries(EXPIRY_MS)) {
      if (windowMs === undefined) continue;
      const rows = this.#db
        .update(outboxMessages)
        .set({ status: 'expired', leaseUntil: null, inFlightSince: null })
        .where(
          and(
            eq(outboxMessages.expiryClass, expiryClass as OutboxMessage['expiryClass']),
            // Only rows still waiting. A `sending` row is somebody's live attempt, and expiring it
            // under them would race the receipt.
            eq(outboxMessages.status, 'pending'),
            lte(outboxMessages.createdAt, addMs(now, -windowMs)),
            // Never a send an effect's acknowledgement points at (see the doc comment).
            sql`NOT EXISTS (SELECT 1 FROM ${turnEffects} WHERE ${turnEffects.ackOutboxId} = ${outboxMessages.id})`,
            // Never a send an effect's acknowledgement points at (see the doc comment).
          ),
        )
        .returning({ id: outboxMessages.id })
        .all();
      expired += rows.length;
    }
    return expired;
  }

  retryDead(_uow: TxToken, id: OutboxId, now: Temporal.Instant): WriteResult<OutboxMessage> {
    const row = maybeOne(
      this.#db
        .update(outboxMessages)
        // `02` §3.10.3's `retryDead` for sends: `attempts = 0` so the row gets its full budget
        // again, which is what a host asking for a retry means — they fixed the cause.
        .set({ status: 'pending', attempts: 0, nextAttemptAt: now, leaseUntil: null })
        .where(and(eq(outboxMessages.id, id), eq(outboxMessages.status, 'dead')))
        .returning(),
    );
    if (row !== undefined) return writeOk(toOutboxMessage(row));
    return this.#row(id) === undefined ? notFound() : writeConflict();
  }

  /* ───────────────────────────── Internals ───────────────────────────── */

  /**
   * The fenced settling write, shared by every `sending → …` transition.
   *
   * One place, because the fence is the correctness argument and four copies of it would be four
   * chances to drop a clause. `undefined` means it matched no row, which the caller turns into a
   * `conflict`.
   */
  #settle(
    id: OutboxId,
    expectAttempts: number,
    patch: Patch<typeof outboxMessages.$inferInsert>,
  ): typeof outboxMessages.$inferSelect | undefined {
    return maybeOne(
      this.#db
        .update(outboxMessages)
        .set(patch)
        .where(
          and(
            eq(outboxMessages.id, id),
            eq(outboxMessages.status, 'sending'),
            eq(outboxMessages.attempts, expectAttempts),
          ),
        )
        .returning(),
    );
  }

  /**
   * The receipt's message must carry the send's own label.
   *
   * Checked rather than trusted, because the two are written together and a mismatch would be
   * invisible afterwards: the message would sit in `messages` under a label the guard never
   * approved it for, and every later read would honour that label as if it had.
   */
  #assertSameLabel(uow: TxToken, row: typeof outboxMessages.$inferSelect, label: Label): void {
    if (label.groupId !== row.groupId) {
      throw new StorageError('STORAGE_CONSTRAINT', 'the receipt names a label of another group', {
        hint: 'This is a bug and an I4 violation: intern the label against the send’s own group.',
        category: 'bug',
      });
    }
    if (row.labelId === null) return;
    if (this.#labels.intern(uow, label) !== row.labelId) {
      throw new StorageError(
        'STORAGE_CONSTRAINT',
        'the receipt names a different label than the send',
        {
          hint: 'This is a bug and an I1 risk: pass the label the DisclosureGuard passed the rendered text under.',
          category: 'bug',
        },
      );
    }
  }

  #row(id: OutboxId): typeof outboxMessages.$inferSelect | undefined {
    return maybeOne(this.#db.select().from(outboxMessages).where(eq(outboxMessages.id, id)));
  }
}

/** `Temporal.Instant` arithmetic in milliseconds, which is what the columns store. */
function addMs(at: Temporal.Instant, ms: number): Temporal.Instant {
  return at.add({ milliseconds: Math.round(ms) });
}
