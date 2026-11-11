/**
 * The turn journal and trace ports (`02` §3.7.1, §3.3.7, §3.8; semantics in `05`).
 *
 * Three shapes here are required by `02` §3.8 rather than chosen:
 *
 *  - **`journalEffect` takes the tool input, not an idempotency key.** `05` S2 derives the key as
 *    `sha256(rootTurnId ‖ toolName ‖ canonicalJson(input))`, and invariant **I6** is the unique
 *    index on it. A key is only a guarantee if exactly one place derives it, so the repository
 *    does — the same reasoning as a message's dedupe key and a constitution's yaml digest.
 *  - **`recover` writes the summary, the acks and the status in one transaction.** `02` §3.8 spells
 *    it out, and the atomicity is the point: acking effects in one transaction and enqueuing the
 *    message that tells somebody about them in another leaves a window where the journal says the
 *    group was informed and nothing was sent. That is exactly the I7 violation recovery exists to
 *    repair.
 *  - **`writeTrace` returns what it dropped.** `02` §3.3.9 caps a trace row's JSON at 512 KiB
 *    combined, and `05` §3.10 makes the trace an observability artefact — so a row that is too big
 *    is truncated and says so, rather than failing the turn. A turn that failed because its own
 *    trace was too big would be the worst available trade.
 */
import type {
  ConversationId,
  GroupId,
  OutboxId,
  TurnEffectId,
  TurnId,
  TurnTraceId,
} from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';
import type { EligibleLabelSet, Label } from '../../../ifc/eligible.js';
import type {
  EffectStatus,
  NewTurn,
  NewTurnEffect,
  NewTurnTrace,
  Turn,
  TurnEffect,
  TurnPhase,
  TurnTrace,
} from '../../../runtime/aggregates.js';
import type { NewOutboxMessage } from '../../../runtime/outbox.js';
import type { TurnFailure } from '../../../runtime/turns.js';
import type { TxToken, WriteResult } from '../uow.js';

export interface TurnJournalReader {
  turn(groupId: GroupId, id: TurnId): Turn | undefined;
  /** Q-TRN-3: a conversation's recent turns, newest first. */
  recentTurns(query: {
    readonly groupId: GroupId;
    readonly conversationId: ConversationId;
    readonly limit: number;
  }): readonly Turn[];
  /**
   * Q-TRN-1: turns a crash left behind — `running`, from another boot or past their deadline.
   *
   * **Instance-wide and unscoped by group**, unlike every other read in this layer, because
   * `turns_running_idx` is a partial index on `started_at` alone and boot recovery runs before any
   * group list exists. A group-scoped version could not use the index and would turn one query at
   * boot into one per group.
   */
  orphanedTurns(query: {
    readonly bootId: string;
    readonly now: Temporal.Instant;
    readonly limit: number;
  }): readonly Turn[];
  /** `02` §3.8: failed turns whose effects nobody has been told about (I7). */
  failedWithUnackedEffects(limit: number): readonly Turn[];
  /** Q-TRN-2b: the effects of one turn that still need acknowledging, in `seq` order. */
  unackedEffects(turnId: TurnId): readonly TurnEffect[];
  /** Q-TRN-2: every effect of a turn, in `seq` order. */
  effectsOf(turnId: TurnId): readonly TurnEffect[];
  /** An effect by its idempotency key — `05` S2's "has this already run?". */
  effectByKey(rootTurnId: TurnId, toolName: string, input: unknown): TurnEffect | undefined;
  /**
   * `02` §3.8's I7 audit: effects covered **only** by a dead outbox row.
   *
   * Read by the chaos tests and `village doctor`. An effect acked by a row that then died is worse
   * than an unacked one, because the journal says the group was told and the message never arrived.
   */
  effectsAckedByDeadSends(limit: number): readonly TurnEffect[];
}

export interface TurnJournal {
  /** `02` §3.8's first row: a turn is journaled as `running` before it does anything. */
  start(uow: TxToken, turn: NewTurn): WriteResult<Turn>;
  /** Move the phase, so a crash recovery knows what to check (`05` S1). */
  setPhase(
    uow: TxToken,
    groupId: GroupId,
    id: TurnId,
    phase: TurnPhase,
    step: number,
  ): WriteResult<Turn>;
  /**
   * Journal an effect as `intent` — **before** the tool runs (`01` §14 A23).
   *
   * Returns `duplicate` when the same `(rootTurnId, toolName, input)` has already been journaled,
   * which is invariant I6 arriving as an answer: the caller's response is to **not run the tool**
   * and reuse the existing effect.
   */
  journalEffect(uow: TxToken, effect: NewTurnEffect, label: Label): WriteResult<TurnEffect>;
  /** Settle an effect once the tool returned, with its field-encrypted result. */
  settleEffect(
    uow: TxToken,
    turnId: TurnId,
    id: TurnEffectId,
    outcome: {
      readonly status: Extract<EffectStatus, 'committed' | 'failed'>;
      readonly resultCiphertext?: Uint8Array | undefined;
      readonly at: Temporal.Instant;
    },
  ): WriteResult<TurnEffect>;
  /**
   * `02` §3.8's turn end: mark the turn complete and ack its effects with the first send.
   *
   * `ackOutboxId` is `undefined` for a turn with no reply — an `observe`, say — and then the
   * effects **must** be zero, because I7 means an effect the group was never told about is a bug
   * rather than a state. The repository refuses the combination instead of recording it.
   */
  complete(
    uow: TxToken,
    groupId: GroupId,
    id: TurnId,
    completion: {
      readonly ackOutboxId?: OutboxId | undefined;
      readonly at: Temporal.Instant;
    },
  ): WriteResult<Turn>;
  /** Record a failure. Unacked effects stay unacked, and recovery covers them (`02` §3.8). */
  fail(
    uow: TxToken,
    groupId: GroupId,
    id: TurnId,
    failure: TurnFailure,
    status?: Extract<Turn['status'], 'failed' | 'timed_out' | 'cancelled'>,
  ): WriteResult<Turn>;
  /**
   * `02` §3.8's recovery: insert the summary, ack every unacked effect, mark the turn `recovered`.
   *
   * One transaction, all three. `05` renders the template summary and runs the guard before
   * calling this, so the `guardRef` on the outbox row is already real — I5 holds.
   */
  recover(uow: TxToken, turnId: TurnId, summary: NewOutboxMessage): WriteResult<Turn>;
  /**
   * `02` §3.8: an orphaned turn with **zero** effects is marked `failed` and nothing is sent.
   *
   * Separate from `recover` because the two outcomes are genuinely different: there is nothing to
   * acknowledge, so sending a recovery summary would tell the group about an event that had no
   * consequences. `failure.code` is `ORPHANED_NO_EFFECTS`, which is what makes that case readable
   * afterwards rather than looking like an unexplained failure.
   */
  abandon(uow: TxToken, turnId: TurnId, at: Temporal.Instant): WriteResult<Turn>;
}

export interface TraceReader {
  trace(groupId: GroupId, turnId: TurnId, eligible: EligibleLabelSet): TurnTrace | undefined;
  /** Q-DASH-2: the dashboard's trace list, newest first. */
  recentTraces(query: {
    readonly groupId: GroupId;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly TurnTrace[];
  /** Q-RET-2: traces past their expiry, for the retention sweep. */
  expiredTraces(at: Temporal.Instant, limit: number): readonly TurnTraceId[];
  /**
   * The debug row's ciphertext — **host-only** (`05` §3.10.1).
   *
   * Unfiltered by label because there is no label: the row exists only while
   * `COMVIVO_DEBUG_CONTENT=1` and is never shown to a member or exported. `03` §3.11's banner job
   * is what makes its existence visible to the group.
   */
  debugCiphertext(turnId: TurnId): Uint8Array | undefined;
}

/** What `writeTrace` had to drop to fit `02` §3.3.9's combined budget. */
export interface TraceTruncation {
  readonly truncated: boolean;
  /** Which lists were shortened, longest first. Empty when nothing was. */
  readonly dropped: readonly string[];
  readonly bytesBefore: number;
  readonly bytesAfter: number;
}

export interface TraceRepository {
  /**
   * Write a turn's trace, truncating rather than failing if it is too big.
   *
   * Returns the truncation alongside the row, because a caller that silently lost half its tool
   * calls would have no way to know its own observability was incomplete — and `11`'s replay reads
   * these rows as evidence.
   */
  writeTrace(
    uow: TxToken,
    trace: NewTurnTrace,
    label: Label,
  ): WriteResult<{ readonly trace: TurnTrace; readonly truncation: TraceTruncation }>;
  /** `05` §3.10.1's debug capture, field-encrypted and short-lived. */
  writeDebug(
    uow: TxToken,
    turnId: TurnId,
    ciphertext: Uint8Array,
    expiresAt: Temporal.Instant,
  ): WriteResult<TurnId>;
  /** Q-RET-2's sweep. Returns how many rows went. */
  deleteExpired(uow: TxToken, at: Temporal.Instant, limit: number): number;
}
