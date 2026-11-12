/**
 * The turn journal (`02` §3.7.1, §3.3.7, §3.8; semantics in `05`).
 *
 * ## The journal is what makes a crash survivable
 *
 * `02` §3.8 is a table of transactions, and the ordering in it is the design. A turn is written as
 * `running` **before** it does anything; an external effect is written as `intent` **before** the
 * tool runs (`01` §14 A23). Both orderings cost a write on the happy path and buy the only thing
 * that matters on the unhappy one: after a crash there is a row saying *this may have happened*.
 * The reverse ordering leaves silence, and an external effect that happened silently — a message
 * sent, a calendar invite created — is precisely what invariant **I7** exists to prevent.
 *
 * ## Two invariants live in this file
 *
 * **I6, exactly-once intent**, is the unique index on `turn_effects.idempotency_key`, and the key
 * is derived *here* from `(rootTurnId, toolName, canonicalJson(input))`. A caller-supplied key
 * would make I6 a convention rather than a guarantee — the same reasoning as a message's dedupe
 * key and a constitution's yaml digest: a key is only evidence if exactly one place derives it.
 *
 * **I7, acknowledged effects**, is `ack_outbox_id IS NULL`. `complete` refuses a turn that has
 * effects and no acknowledging send, because that combination is not a state the product can be
 * in — it is the bug, and recording it would make the recovery query's answer wrong rather than
 * late.
 */
import type {
  EffectStatus,
  Label,
  NewOutboxMessage,
  NewTurn,
  NewTurnEffect,
  OutboxMessage,
  Turn,
  TurnEffect,
  TurnFailure,
  TurnJournal,
  TurnJournalReader,
  TurnPhase,
  TxToken,
  WriteResult,
} from '@comvivo/core';
import {
  duplicate,
  notFound,
  UNDELIVERED_OUTBOX_STATUSES,
  writeConflict,
  writeOk,
} from '@comvivo/core';
import {
  type CanonicalValue,
  type ConversationId,
  canonicalJson,
  type GroupId,
  isId,
  type OutboxId,
  StorageError,
  type TurnEffectId,
  type TurnId,
} from '@comvivo/shared';
import { sha256Hex } from '@comvivo/shared/crypto';
import { and, asc, desc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';
import type { Db } from '../db/drizzle.js';
import { exactlyOne, maybeOne } from '../db/drizzle.js';
import { isUniqueViolation } from '../db/errors.js';
import type { LabelStore } from '../ifc/label-store.js';
import { enqueueOutbox } from '../outbox/enqueue.js';
import { outboxMessages, turnEffects, turns } from '../schema/runtime.js';
import { toTurn, toTurnEffect } from './rows.js';

/** `02` §3.8: an orphaned turn with no effects is failed with this code and nothing is sent. */
export const ORPHANED_NO_EFFECTS = 'ORPHANED_NO_EFFECTS';

/**
 * `05` S2's effect idempotency key: `sha256(rootTurnId ‖ toolName ‖ canonicalJson(input))`.
 *
 * `canonicalJson` is RFC 8785, so `{a:1,b:2}` and `{b:2,a:1}` give the same key — which is the
 * point: a retried tool call reconstructed from a different object ordering is the *same* call, and
 * a key that disagreed would run the effect twice. The separator is `NUL` rather than `:` because
 * a tool name containing the separator would otherwise let two different calls collide.
 */
export function effectIdempotencyKey(rootTurnId: TurnId, toolName: string, input: unknown): string {
  const canonical = canonicalJson((input ?? null) as CanonicalValue);
  return sha256Hex([rootTurnId, toolName, canonical].join('\0'));
}

export class SqliteTurnJournal implements TurnJournalReader, TurnJournal {
  readonly #db: Db;
  readonly #labels: LabelStore;

  constructor(db: Db, labels: LabelStore) {
    this.#db = db;
    this.#labels = labels;
  }

  /* ───────────────────────────── Reads ───────────────────────────── */

  turn(groupId: GroupId, id: TurnId): Turn | undefined {
    const row = this.#turnRow(groupId, id);
    return row === undefined ? undefined : toTurn(row);
  }

  recentTurns(query: {
    readonly groupId: GroupId;
    readonly conversationId: ConversationId;
    readonly limit: number;
  }): readonly Turn[] {
    // Q-TRN-3, through `turns_conv_started_idx`.
    return this.#db
      .select()
      .from(turns)
      .where(and(eq(turns.groupId, query.groupId), eq(turns.conversationId, query.conversationId)))
      .orderBy(desc(turns.startedAt), desc(turns.id))
      .limit(query.limit)
      .all()
      .map(toTurn);
  }

  /**
   * Q-TRN-1, verbatim from `02` §3.8: `status = 'running' AND (boot_id <> ? OR deadline_at < ?)`.
   *
   * **Not group-scoped**, and that is deliberate rather than an omission: `turns_running_idx` is
   * partial on `status = 'running'` and keyed on `started_at` alone, and boot recovery runs before
   * there is a group list to iterate. A group-scoped version could not use the index — the same
   * reasoning that made `reminders.due` group-*scoped* in `M1-T19`, read off the index definition
   * rather than argued from cost, and it points the other way here.
   */
  orphanedTurns(query: {
    readonly bootId: string;
    readonly now: Temporal.Instant;
    readonly limit: number;
  }): readonly Turn[] {
    return this.#db
      .select()
      .from(turns)
      .where(
        and(
          eq(turns.status, 'running'),
          or(ne(turns.bootId, query.bootId), lt(turns.deadlineAt, query.now)),
        ),
      )
      .orderBy(asc(turns.startedAt))
      .limit(query.limit)
      .all()
      .map(toTurn);
  }

  /** `02` §3.8: `SELECT DISTINCT t.* … WHERE t.status='failed' AND e.ack_outbox_id IS NULL`. */
  failedWithUnackedEffects(limit: number): readonly Turn[] {
    return this.#db
      .selectDistinct({ turn: turns })
      .from(turns)
      .innerJoin(turnEffects, eq(turnEffects.turnId, turns.id))
      .where(and(eq(turns.status, 'failed'), isNull(turnEffects.ackOutboxId)))
      .orderBy(asc(turns.startedAt))
      .limit(limit)
      .all()
      .map((row) => toTurn(row.turn));
  }

  /** Q-TRN-2b, through `turn_effects_unacked_idx`. */
  unackedEffects(turnId: TurnId): readonly TurnEffect[] {
    return this.#db
      .select()
      .from(turnEffects)
      .where(and(eq(turnEffects.turnId, turnId), isNull(turnEffects.ackOutboxId)))
      .orderBy(asc(turnEffects.seq))
      .all()
      .map(toTurnEffect);
  }

  /** Q-TRN-2, through `turn_effects_turn_seq_uq`. */
  effectsOf(turnId: TurnId): readonly TurnEffect[] {
    return this.#db
      .select()
      .from(turnEffects)
      .where(eq(turnEffects.turnId, turnId))
      .orderBy(asc(turnEffects.seq))
      .all()
      .map(toTurnEffect);
  }

  effectByKey(rootTurnId: TurnId, toolName: string, input: unknown): TurnEffect | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(turnEffects)
        .where(eq(turnEffects.idempotencyKey, effectIdempotencyKey(rootTurnId, toolName, input))),
    );
    return row === undefined ? undefined : toTurnEffect(row);
  }

  /**
   * `02` §3.8's I7 audit: effects whose only acknowledgement is a send that never arrived.
   *
   * Worse than an unacked effect, because the journal says the group was told and the message
   * never arrived — so the recovery query would skip it. Read by the chaos tests and
   * `village doctor`, and expected to be empty on a healthy instance.
   *
   * **Every terminal status but `sent`**, which it was not: the predicate was `status = 'dead'`
   * alone, and `TERMINAL_OUTBOX_STATUSES` has three undelivered members. `expired` is the one that
   * matters, because it is the default path rather than an exotic one — `expiry_class` defaults to
   * `timely` (30 minutes) in the shipped schema and nothing in the product sets `must_deliver`, so
   * a reply acked by a send that aged out was **invisible to every audit query**: not in
   * `failedWithUnackedEffects` (the turn completed and the effect is acked), not here (the send is
   * not `dead`). Reproduced end to end by the M1 exit gate's reviewer. `cancelled` reaches the
   * same state through `cancel()`.
   */
  effectsAckedByDeadSends(limit: number): readonly TurnEffect[] {
    return this.#db
      .select({ effect: turnEffects })
      .from(turnEffects)
      .innerJoin(outboxMessages, eq(outboxMessages.id, turnEffects.ackOutboxId))
      .where(inArray(outboxMessages.status, UNDELIVERED_OUTBOX_STATUSES))
      .orderBy(asc(turnEffects.turnId), asc(turnEffects.seq))
      .limit(limit)
      .all()
      .map((row) => toTurnEffect(row.effect));
  }

  /* ───────────────────────────── Writes ───────────────────────────── */

  start(_uow: TxToken, turn: NewTurn): WriteResult<Turn> {
    try {
      const row = exactlyOne(
        this.#db
          .insert(turns)
          .values({
            id: turn.id,
            groupId: turn.groupId,
            conversationId: turn.conversationId,
            kind: turn.kind,
            triggerMessageIds: [...turn.triggerMessageIds],
            requesterMemberId: turn.requesterMemberId,
            audienceReaderSetId: turn.audienceReaderSetId,
            // `02` §3.8's first row. A caller able to start a turn already `completed` would make
            // the journal a record of intentions rather than of what ran.
            status: 'running',
            phase: 'building_context',
            phaseStep: 0,
            effort: turn.effort,
            bootId: turn.bootId,
            // A turn that is its own root, unless it says otherwise — so the common case cannot
            // get the self-reference wrong, and `05` S2's idempotency scope is always set.
            rootTurnId: turn.rootTurnId ?? turn.id,
            parentTurnId: turn.parentTurnId,
            retryOfTurnId: turn.retryOfTurnId,
            startedAt: turn.startedAt,
            deadlineAt: turn.deadlineAt,
          })
          .returning(),
        'the turn',
      );
      return writeOk(toTurn(row));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return duplicate(turn.id);
    }
  }

  setPhase(
    _uow: TxToken,
    groupId: GroupId,
    id: TurnId,
    phase: TurnPhase,
    step: number,
  ): WriteResult<Turn> {
    const row = maybeOne(
      this.#db
        .update(turns)
        .set({ phase, phaseStep: step })
        // Only a running turn has a phase. A phase set on a completed turn would make Q-TRN-1's
        // answer depend on write order rather than on state.
        .where(and(eq(turns.groupId, groupId), eq(turns.id, id), eq(turns.status, 'running')))
        .returning(),
    );
    if (row !== undefined) return writeOk(toTurn(row));
    return this.#turnRow(groupId, id) === undefined ? notFound() : writeConflict();
  }

  journalEffect(uow: TxToken, effect: NewTurnEffect, label: Label): WriteResult<TurnEffect> {
    const turn = maybeOne(
      this.#db
        .select({ groupId: turns.groupId, rootTurnId: turns.rootTurnId, status: turns.status })
        .from(turns)
        .where(eq(turns.id, effect.turnId)),
    );
    if (turn === undefined) return notFound();
    if (label.groupId !== turn.groupId) throw crossGroup('effect');
    // An effect journaled against a finished turn would never be acknowledged by it, so I7 would
    // be violated by a row the engine could not see it had created.
    if (turn.status !== 'running') return writeConflict();
    const labelId = this.#labels.intern(uow, label);
    const key = effectIdempotencyKey(turn.rootTurnId, effect.toolName, effect.input);
    try {
      const row = exactlyOne(
        this.#db
          .insert(turnEffects)
          .values({
            id: effect.id,
            turnId: effect.turnId,
            rootTurnId: turn.rootTurnId,
            groupId: turn.groupId,
            // `02` §3.8's `seq = max+1`.
            //
            // **`max + 1`, not `count`** — and the difference is not about concurrency, which was
            // the reason a first version of this comment gave and which is wrong: writes are
            // serialised, and a `count` read inside the transaction sees the rows inserted before
            // it. What `count` gets wrong is a **gap**: if any row of a turn ever goes, `count`
            // reuses a position that is still taken and `turn_effects_turn_seq_uq` refuses the
            // insert. Proven by the test that deletes a row and journals another.
            seq: sql`coalesce((SELECT max(${turnEffects.seq}) FROM ${turnEffects}
                               WHERE ${turnEffects.turnId} = ${effect.turnId}), -1) + 1`,
            toolName: effect.toolName,
            idempotencyKey: key,
            // A23: `intent` before the tool runs. There is no way to write a `committed` effect
            // here, because committing is what `settleEffect` records *after* it returned.
            status: 'intent',
            summaryKey: effect.summaryKey,
            summaryParams: effect.summaryParams,
            entityRefs: [...(effect.entityRefs ?? [])],
            labelId,
          })
          .returning(),
        'the turn effect',
      );
      return writeOk(toTurnEffect(row));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // I6 arriving as an answer. The caller's response is to **not run the tool** and reuse the
      // effect that is already there — so the existing id is what it needs, not the one it tried.
      const existing = maybeOne(
        this.#db
          .select({ id: turnEffects.id })
          .from(turnEffects)
          .where(eq(turnEffects.idempotencyKey, key)),
      );
      return duplicate(existing?.id ?? effect.id);
    }
  }

  settleEffect(
    _uow: TxToken,
    turnId: TurnId,
    id: TurnEffectId,
    outcome: {
      readonly status: Extract<EffectStatus, 'committed' | 'failed'>;
      readonly resultCiphertext?: Uint8Array | undefined;
      readonly at: Temporal.Instant;
    },
  ): WriteResult<TurnEffect> {
    const row = maybeOne(
      this.#db
        .update(turnEffects)
        .set({
          status: outcome.status,
          // `committed_at` is NULL while the status is `intent`, so it moves with the status and
          // the two cannot disagree about whether the effect happened.
          committedAt: outcome.status === 'committed' ? outcome.at : null,
          resultCiphertext:
            outcome.resultCiphertext === undefined
              ? undefined
              : Buffer.from(outcome.resultCiphertext),
        })
        // Only an `intent` row settles. A second settle would overwrite the first outcome, and the
        // result of a tool that ran twice is exactly what A23 is trying to make visible.
        .where(
          and(
            eq(turnEffects.turnId, turnId),
            eq(turnEffects.id, id),
            eq(turnEffects.status, 'intent'),
          ),
        )
        .returning(),
    );
    if (row !== undefined) return writeOk(toTurnEffect(row));
    const exists = maybeOne(
      this.#db
        .select({ id: turnEffects.id })
        .from(turnEffects)
        .where(and(eq(turnEffects.turnId, turnId), eq(turnEffects.id, id))),
    );
    return exists === undefined ? notFound() : writeConflict();
  }

  complete(
    _uow: TxToken,
    groupId: GroupId,
    id: TurnId,
    completion: { readonly ackOutboxId?: OutboxId | undefined; readonly at: Temporal.Instant },
  ): WriteResult<Turn> {
    const turn = this.#turnRow(groupId, id);
    if (turn === undefined) return notFound();
    if (turn.status !== 'running') return writeConflict();

    if (completion.ackOutboxId === undefined && this.unackedEffects(id).length > 0) {
      // `02` §3.8's "no reply" row: "Effects must be zero; otherwise the engine must send an
      // acknowledgement (I7)". Refused rather than recorded, because a *completed* turn with
      // unacked effects is invisible to the recovery query — `failedWithUnackedEffects` looks at
      // `failed` turns — so accepting it would lose the effects rather than defer them.
      throw new StorageError(
        'STORAGE_CONSTRAINT',
        'completing a turn with unacknowledged effects needs an acknowledging send',
        {
          hint: 'This is a bug and an I7 violation: enqueue the reply first, then pass its id as `ackOutboxId`.',
          category: 'bug',
        },
      );
    }
    if (completion.ackOutboxId !== undefined) this.#ackEffects(id, completion.ackOutboxId);
    const row = exactlyOne(
      this.#db
        .update(turns)
        .set({ status: 'completed', completedAt: completion.at, phase: null, phaseStep: null })
        .where(and(eq(turns.groupId, groupId), eq(turns.id, id), eq(turns.status, 'running')))
        .returning(),
      'the completed turn',
    );
    return writeOk(toTurn(row));
  }

  fail(
    _uow: TxToken,
    groupId: GroupId,
    id: TurnId,
    failure: TurnFailure,
    status: Extract<Turn['status'], 'failed' | 'timed_out' | 'cancelled'> = 'failed',
  ): WriteResult<Turn> {
    const row = maybeOne(
      this.#db
        .update(turns)
        .set({
          status,
          failure,
          // Unacked effects stay unacked (`02` §3.8), which is what lets recovery find them.
          // `TurnFailure.at` is an ISO string (the schema's own shape, so a failure can be
          // serialised into a trace); the column is an instant. Converted here rather than widening
          // the column, because an instant is what Q-TRN-1's deadline comparison needs.
          timedOutAt: status === 'timed_out' ? Temporal.Instant.from(failure.at) : undefined,
          phase: null,
          phaseStep: null,
        })
        .where(
          and(
            eq(turns.groupId, groupId),
            eq(turns.id, id),
            inArray(turns.status, ['queued', 'running']),
          ),
        )
        .returning(),
    );
    if (row !== undefined) return writeOk(toTurn(row));
    return this.#turnRow(groupId, id) === undefined ? notFound() : writeConflict();
  }

  /**
   * `02` §3.8's recovery, in one transaction: the summary, the acks, and `status='recovered'`.
   *
   * The ordering inside it matters. The outbox row is inserted **first**, because the acks need its
   * id — and if the insert turns out to be a duplicate (`idempotency_key`, I6: a recovery pass that
   * already ran), the existing row's id is what the effects get acked with. Acking with an id that
   * is not in the table would satisfy the I7 query while pointing at nothing.
   */
  recover(uow: TxToken, turnId: TurnId, summary: NewOutboxMessage): WriteResult<Turn> {
    const turn = maybeOne(this.#db.select().from(turns).where(eq(turns.id, turnId)));
    if (turn === undefined) return notFound();
    // Recovery is for a turn nobody is running: a live one would be acked by its own completion.
    if (turn.status === 'completed' || turn.status === 'recovered') return writeConflict();
    if (this.unackedEffects(turnId).length === 0) {
      throw new StorageError('STORAGE_CONSTRAINT', 'that turn has nothing to acknowledge', {
        hint: 'This is a bug in the caller: `02` §3.8 says a turn with zero effects is `abandon`ed, and nothing is sent.',
        category: 'bug',
      });
    }
    const enqueued = enqueueOutbox(this.#db, summary, uow.now);
    this.#ackEffects(turnId, ackIdOf(enqueued, summary.id));
    const row = exactlyOne(
      this.#db
        .update(turns)
        .set({
          status: 'recovered',
          recoveryDone: true,
          completedAt: uow.now,
          restarts: sql`${turns.restarts} + 1`,
          phase: null,
          phaseStep: null,
        })
        .where(eq(turns.id, turnId))
        .returning(),
      'the recovered turn',
    );
    return writeOk(toTurn(row));
  }

  abandon(_uow: TxToken, turnId: TurnId, at: Temporal.Instant): WriteResult<Turn> {
    const turn = maybeOne(this.#db.select().from(turns).where(eq(turns.id, turnId)));
    if (turn === undefined) return notFound();
    if (this.effectsOf(turnId).length > 0) {
      // Checked rather than assumed, because the caller's two outcomes are not interchangeable: a
      // turn with effects needs a summary sent, and abandoning it would leave the group never told
      // about something that happened.
      throw new StorageError('STORAGE_CONSTRAINT', 'that turn has effects to acknowledge', {
        hint: 'This is a bug in the caller: `02` §3.8 says a turn with effects is `recover`ed with a summary.',
        category: 'bug',
      });
    }
    const row = maybeOne(
      this.#db
        .update(turns)
        .set({
          status: 'failed',
          recoveryDone: true,
          // `02` §3.8's code, so the case reads as "nothing happened" afterwards rather than as an
          // unexplained failure.
          failure: {
            code: ORPHANED_NO_EFFECTS,
            message: 'The turn did not finish and had no effects, so nothing was sent.',
            phase: turn.phase,
            retryable: false,
            at: at.toString(),
          },
          phase: null,
          phaseStep: null,
        })
        .where(and(eq(turns.id, turnId), ne(turns.status, 'recovered')))
        .returning(),
    );
    return row === undefined ? writeConflict() : writeOk(toTurn(row));
  }

  /* ───────────────────────────── Internals ───────────────────────────── */

  /** I7: every effect of this turn that nobody has been told about now points at the send. */
  #ackEffects(turnId: TurnId, ackOutboxId: OutboxId): void {
    this.#db
      .update(turnEffects)
      .set({ ackOutboxId })
      .where(and(eq(turnEffects.turnId, turnId), isNull(turnEffects.ackOutboxId)))
      .run();
  }

  #turnRow(groupId: GroupId, id: TurnId): typeof turns.$inferSelect | undefined {
    return maybeOne(
      this.#db
        .select()
        .from(turns)
        .where(and(eq(turns.groupId, groupId), eq(turns.id, id))),
    );
  }
}

/**
 * The id the effects should be acked with.
 *
 * `duplicate.existingId` is a plain `string` on `WriteResult`, because the union is generic over
 * the value and not over the id. Narrowed through `isId` rather than cast: a recovery pass that
 * acked with something that was not an outbox id would satisfy the I7 query while pointing at
 * nothing, which is the failure this whole path exists to prevent.
 */
function ackIdOf(result: WriteResult<OutboxMessage>, fallback: OutboxId): OutboxId {
  if (result.kind === 'ok') return result.value.id;
  if (result.kind === 'duplicate' && isId('obx', result.existingId)) return result.existingId;
  return fallback;
}

function crossGroup(what: string): StorageError {
  return new StorageError('STORAGE_CONSTRAINT', `the ${what} names a label of another group`, {
    hint: `This is a bug and an I4 violation: intern the label against the ${what}'s own group.`,
    category: 'bug',
  });
}
