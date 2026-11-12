/**
 * Turn traces (`02` §3.7.1, §3.3.7; `05` §3.10, `11` §12-1).
 *
 * ## A trace is truncated, never refused
 *
 * `02` §3.3.9 caps one trace row's JSON columns at **512 KiB combined**, and the per-column caps
 * are 128 KiB each across seven columns — so a row can satisfy every individual cap and still be
 * ~896 KiB. `core`'s `traceBudgetOverage` is the combined check, and this is its only caller.
 *
 * What happens on an overage is a product decision, and it goes the way `05` §3.10 implies: a
 * trace is an **observability artefact**, so the row is shortened and says it was. A turn that
 * failed because its own trace was too big would be the worst available trade — the member loses
 * the answer, and the thing that would have explained why is also gone.
 *
 * ## The rendered prompt is in a different table
 *
 * `05` §3.10.1 puts it in `turn_trace_debug`: only with `COMVIVO_DEBUG_CONTENT=1`, field-encrypted,
 * host-only, never exported, expiring in 24 hours. That separation is the control, not a tidiness
 * choice — `turn_traces` can be shown to a member because the prompt is not in it.
 */
import type {
  EligibleLabelSet,
  Label,
  NewTurnTrace,
  TraceReader,
  TraceRepository,
  TraceTruncation,
  TurnTrace,
  TxToken,
  WriteResult,
} from '@comvivo/core';
import {
  duplicate,
  TRACE_TOTAL_BUDGET_BYTES,
  traceBudgetOverage,
  traceRowBytes,
  writeOk,
} from '@comvivo/core';
import { type GroupId, StorageError, type TurnId, type TurnTraceId } from '@comvivo/shared';
import { and, asc, desc, eq, inArray, lte } from 'drizzle-orm';
import type { Temporal } from 'temporal-polyfill';
import type { Db } from '../db/drizzle.js';
import { exactlyOne, maybeOne } from '../db/drizzle.js';
import { isUniqueViolation } from '../db/errors.js';
import type { LabelStore } from '../ifc/label-store.js';
import { turnTraceDebug, turnTraces } from '../schema/runtime.js';
import { toTurnTrace } from './rows.js';

/** The four list columns truncation may shorten, in the order it prefers to shorten them. */
const TRUNCATABLE = ['tool_calls', 'model_calls', 'policy_decisions', 'guard_results'] as const;

type Truncatable = (typeof TRUNCATABLE)[number];

interface TraceLists {
  readonly model_calls: readonly unknown[];
  readonly tool_calls: readonly unknown[];
  readonly policy_decisions: readonly unknown[];
  readonly guard_results: readonly unknown[];
}

export class SqliteTraceRepository implements TraceReader, TraceRepository {
  readonly #db: Db;
  readonly #labels: LabelStore;

  constructor(db: Db, labels: LabelStore) {
    this.#db = db;
    this.#labels = labels;
  }

  /**
   * One trace, if this audience may read it.
   *
   * `EligibleLabelSet`, not `{ ids: readonly LabelId[] }`. The widened shape was the only one in
   * this package, and it defeated the brand: `eligible.ts` says why the type is branded — "a
   * storage read that takes `readonly LabelId[]` can be called with a hand-built list… That is
   * invariant `I1` deleted in one argument" — and method-parameter bivariance let the class keep
   * satisfying the port while every holder of the concrete repository saw the structural type. A
   * forged `{ ids: [1, 2, 3] }` typechecked here and was refused by `messages.hydrate` two lines
   * away. `turn_traces` holds the context manifest, the policy decisions, the guard results and
   * the replay, and `09`'s `traces.read.own` reads it through this method. Found at the M1 exit
   * gate.
   *
   * The group now comes from the branded set as well, rather than from a separate argument that
   * could disagree with it — the shape `messages.hydrate` already uses.
   */
  trace(groupId: GroupId, turnId: TurnId, eligible: EligibleLabelSet): TurnTrace | undefined {
    if (eligible.ids.length === 0) return undefined;
    const row = maybeOne(
      this.#db
        .select()
        .from(turnTraces)
        .where(
          and(
            eq(turnTraces.groupId, groupId),
            eq(turnTraces.turnId, turnId),
            inArray(turnTraces.labelId, [...eligible.ids]),
          ),
        ),
    );
    return row === undefined ? undefined : toTurnTrace(row);
  }

  /** Q-DASH-2, through `turn_traces_group_created_idx`. Branded `eligible`, as `trace` explains. */
  recentTraces(query: {
    readonly groupId: GroupId;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly TurnTrace[] {
    if (query.eligible.ids.length === 0) return [];
    return this.#db
      .select()
      .from(turnTraces)
      .where(
        and(
          eq(turnTraces.groupId, query.groupId),
          inArray(turnTraces.labelId, [...query.eligible.ids]),
        ),
      )
      .orderBy(desc(turnTraces.createdAt), desc(turnTraces.id))
      .limit(query.limit)
      .all()
      .map(toTurnTrace);
  }

  /** Q-RET-2, through `turn_traces_expires_idx`. */
  expiredTraces(at: Temporal.Instant, limit: number): readonly TurnTraceId[] {
    return this.#db
      .select({ id: turnTraces.id })
      .from(turnTraces)
      .where(lte(turnTraces.expiresAt, at))
      .orderBy(asc(turnTraces.expiresAt))
      .limit(limit)
      .all()
      .map((row) => row.id);
  }

  /**
   * The debug row's ciphertext — **host-only**, and unfiltered because there is no label.
   *
   * There is nothing to filter against: the row exists only while `COMVIVO_DEBUG_CONTENT=1`, is
   * never shown to a member and is never exported. `03` §3.11's banner job is what makes its
   * existence visible to the group, which is the control that replaces a label here.
   */
  debugCiphertext(turnId: TurnId): Uint8Array | undefined {
    const row = maybeOne(
      this.#db.select().from(turnTraceDebug).where(eq(turnTraceDebug.turnId, turnId)),
    );
    return row?.ciphertext;
  }

  writeTrace(
    uow: TxToken,
    trace: NewTurnTrace,
    label: Label,
  ): WriteResult<{ readonly trace: TurnTrace; readonly truncation: TraceTruncation }> {
    if (label.groupId !== trace.groupId) throw crossGroup('trace');
    const labelId = this.#labels.intern(uow, label);
    const { keep, truncation } = fitBudget({
      trigger: trace.trigger,
      context_manifest: trace.contextManifest,
      latency: trace.latency,
      model_calls: trace.modelCalls,
      tool_calls: trace.toolCalls,
      policy_decisions: trace.policyDecisions,
      guard_results: trace.guardResults,
    });
    try {
      const row = exactlyOne(
        this.#db
          .insert(turnTraces)
          .values({
            id: trace.id,
            turnId: trace.turnId,
            groupId: trace.groupId,
            conversationId: trace.conversationId,
            labelId,
            trigger: trace.trigger,
            disposition: trace.disposition,
            contextManifest: trace.contextManifest,
            // Sliced here rather than inside `fitBudget`, so each column keeps its own element
            // type: the four are storage contracts whose interiors `M4` and `M5` own, and a helper
            // that returned `unknown[]` would have to be trusted rather than typechecked.
            modelCalls: trace.modelCalls.slice(0, keep.model_calls),
            toolCalls: trace.toolCalls.slice(0, keep.tool_calls),
            policyDecisions: trace.policyDecisions.slice(0, keep.policy_decisions),
            guardResults: trace.guardResults.slice(0, keep.guard_results),
            costMicros: trace.costMicros,
            latency: trace.latency,
            replay: trace.replay,
            expiresAt: trace.expiresAt,
            createdAt: uow.now,
          })
          .returning(),
        'the turn trace',
      );
      return writeOk({ trace: toTurnTrace(row), truncation });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // `turn_traces.turn_id` is unique: one trace per turn. A second write is a retry, and the
      // existing row is the one `11`'s replay will read.
      const existing = maybeOne(
        this.#db
          .select({ id: turnTraces.id })
          .from(turnTraces)
          .where(eq(turnTraces.turnId, trace.turnId)),
      );
      return duplicate(existing?.id ?? trace.id);
    }
  }

  writeDebug(
    _uow: TxToken,
    turnId: TurnId,
    ciphertext: Uint8Array,
    expiresAt: Temporal.Instant,
  ): WriteResult<TurnId> {
    const row = exactlyOne(
      this.#db
        .insert(turnTraceDebug)
        .values({ turnId, ciphertext: Buffer.from(ciphertext), expiresAt })
        // Replaced rather than refused: a turn that ran its model twice has one debug row, and the
        // row is a 24-hour debugging aid rather than a record of anything.
        .onConflictDoUpdate({
          target: turnTraceDebug.turnId,
          set: { ciphertext: Buffer.from(ciphertext), expiresAt },
        })
        .returning(),
      'the debug capture',
    );
    return writeOk(row.turnId);
  }

  deleteExpired(_uow: TxToken, at: Temporal.Instant, limit: number): number {
    const doomed = this.expiredTraces(at, limit);
    if (doomed.length === 0) return 0;
    // By id rather than by predicate, so `limit` means what it says: a `DELETE … LIMIT` is not
    // portable SQLite without `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`, and an unbounded delete would
    // make the retention sweep's batch size a suggestion.
    this.#db
      .delete(turnTraces)
      .where(inArray(turnTraces.id, [...doomed]))
      .run();
    return doomed.length;
  }
}

/**
 * How many entries of each list fit `02` §3.3.9's combined budget.
 *
 * Halving rather than dropping: half a tool-call list still shows the shape of what happened, and
 * `11`'s replay reads the *start* of each list, so the tail is what costs least. The loop is
 * bounded by the halving — each pass strictly shrinks the longest list — and the order in
 * `TRUNCATABLE` is "biggest and least load-bearing first".
 *
 * Returns **counts**, not arrays. The four columns are storage contracts whose interiors `M4` and
 * `M5` own, so a helper returning `unknown[]` would hand the caller something it had to trust; a
 * count lets each column keep its own element type through the slice.
 */
function fitBudget(row: TraceLists & Record<string, unknown>): {
  readonly keep: Record<Truncatable, number>;
  readonly truncation: TraceTruncation;
} {
  const keep: Record<Truncatable, number> = {
    tool_calls: row.tool_calls.length,
    model_calls: row.model_calls.length,
    policy_decisions: row.policy_decisions.length,
    guard_results: row.guard_results.length,
  };
  const bytesBefore = traceRowBytes(row);
  const dropped: string[] = [];
  const current = (): Record<string, unknown> => ({
    ...row,
    tool_calls: row.tool_calls.slice(0, keep.tool_calls),
    model_calls: row.model_calls.slice(0, keep.model_calls),
    policy_decisions: row.policy_decisions.slice(0, keep.policy_decisions),
    guard_results: row.guard_results.slice(0, keep.guard_results),
  });

  while (traceBudgetOverage(current()) > 0) {
    const longest = TRUNCATABLE.filter((column) => keep[column] > 1).toSorted(
      (left, right) => keep[right] - keep[left],
    )[0];
    if (longest === undefined) {
      // Every list is down to one entry and the row is still too big, which means the fixed
      // columns alone exceed the budget. Refusing here is right: a caller that produced a 512 KiB
      // context manifest has a bug in the *context builder*, and silently storing a trace that
      // violates a cap the spec states would hide it.
      throw new StorageError(
        'STORAGE_CONSTRAINT',
        'that trace exceeds its budget even when truncated',
        {
          hint: `02 §3.3.9 caps a trace row's JSON at ${String(TRACE_TOTAL_BUDGET_BYTES)} bytes combined; the non-list columns alone are over it.`,
          category: 'bug',
        },
      );
    }
    keep[longest] = Math.max(1, Math.floor(keep[longest] / 2));
    if (!dropped.includes(longest)) dropped.push(longest);
  }

  return {
    keep,
    truncation: {
      truncated: dropped.length > 0,
      dropped,
      bytesBefore,
      bytesAfter: traceRowBytes(current()),
    },
  };
}

function crossGroup(what: string): StorageError {
  return new StorageError('STORAGE_CONSTRAINT', `the ${what} names a label of another group`, {
    hint: `This is a bug and an I4 violation: intern the label against the ${what}'s own group.`,
    category: 'bug',
  });
}
