/**
 * The usage hook (`05` §3.5.1 stage 4, §3.9.1; `M2-T9`).
 *
 * One `UsageRecord` per provider **iteration**, written immediately in its own transaction.
 *
 * ## Why immediately, and why its own transaction
 *
 * `05` §3.5.1 says "written in their own transaction immediately, so cost is counted even if the
 * process crashes afterwards". That is the whole design. A turn can fail after the model has
 * answered — a tool throws, the guard refuses, the process is killed — and the provider has still
 * billed for it. Folding the usage write into the turn's transaction would mean every failed turn
 * is a free turn on this host's books and an invoiced one on the provider's, and the budget guard
 * would drift further from reality the worse things were going.
 *
 * ## Why per iteration
 *
 * A refused turn rescued by the server-side fallback produced **two** iterations at two different
 * models' prices (`05` §3.5.3.6). One record per call cannot carry that, and attributing the whole
 * turn to the requested model would under-bill a fallback that is more expensive and over-bill one
 * that is cheaper. `UsageIteration` is a list for this reason and the hook preserves it.
 *
 * ## Cost at write time
 *
 * `costMicros` is computed and stored, never derived on read, and the `priceTableVersion` goes with
 * it (`05` §3.9.1, §12 S9). A price change must not rewrite history: last month's bill was what it
 * was, and a dashboard that recomputed it with today's prices would quietly disagree with the
 * invoice.
 */
import type {
  ModelRoute,
  NewUsageRecord,
  ProviderId,
  SyncTxRunner,
  UsageIteration,
  UsageRepository,
  UsageVia,
} from '@comvivo/core';
import type { Clock, IdGenerator, Logger } from '@comvivo/shared';
import { costIteration, type PriceTable } from '../pricing/index.js';

export interface UsageContext {
  readonly route: ModelRoute;
  readonly purpose: string;
  readonly provider: ProviderId;
  /** The model the route asked for, which `05` §3.9.2 prices separately from the served one. */
  readonly requestedModel: string;
  readonly effort?: string;
  readonly via?: UsageVia;
  readonly groupId?: NewUsageRecord['groupId'];
  readonly turnId?: NewUsageRecord['turnId'];
  readonly jobId?: NewUsageRecord['jobId'];
  /**
   * The group's local date, `YYYY-MM-DD`.
   *
   * Supplied rather than derived: a daily budget resets when the **group's** day does, not at UTC
   * midnight, and only the caller knows the group's zone (`02` §3.3.7).
   */
  readonly dayLocal: string;
}

export interface UsageHookDeps {
  readonly tx: SyncTxRunner;
  readonly usage: UsageRepository;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly prices: PriceTable;
}

/** The row one iteration becomes, before it is written. */
export function usageRecordFor(
  deps: Pick<UsageHookDeps, 'ids' | 'clock' | 'prices'>,
  context: UsageContext,
  iteration: UsageIteration,
): NewUsageRecord {
  const cost = costIteration(iteration, deps.prices);
  return {
    id: deps.ids.next('use'),
    ...(context.groupId === undefined ? {} : { groupId: context.groupId }),
    ...(context.turnId === undefined ? {} : { turnId: context.turnId }),
    ...(context.jobId === undefined ? {} : { jobId: context.jobId }),
    route: context.route,
    provider: context.provider,
    model: context.requestedModel,
    // The **served** model, which differs whenever the refusal fallback answered — and that is the
    // model whose rates were charged.
    servedModel: iteration.model,
    purpose: context.purpose,
    ...(context.via === undefined ? {} : { via: context.via }),
    ...(context.effort === undefined ? {} : { effort: context.effort }),
    // `UsageKind` here is the **iteration** kind (`message` / `fallback_message`), which is
    // `02` §3.3.7's column and happens to be exactly what `UsageIteration.kind` carries for the
    // two kinds this column admits. A `compaction` or `advisor_message` iteration has no column
    // yet, so it is left unset rather than mislabelled — and its tokens and cost are still
    // recorded, which is the part that must not be lost.
    ...(iteration.kind === 'message' || iteration.kind === 'fallback_message'
      ? { kind: iteration.kind }
      : {}),
    inputTokens: iteration.input,
    cachedReadTokens: iteration.cacheRead,
    cacheWrite5mTokens: iteration.cacheWrite5m,
    cacheWrite1hTokens: iteration.cacheWrite1h,
    outputTokens: iteration.output,
    costMicros: cost.micros,
    priceTableVersion: deps.prices.version,
    batch: iteration.batch,
    at: deps.clock.now(),
    dayLocal: context.dayLocal,
  };
}

/**
 * Write one record per iteration.
 *
 * **Never throws.** A usage write that failed and propagated would turn a successful turn into a
 * failed one — the member would see an error for a reply the model had already produced and the
 * provider had already billed. So a failure is logged and swallowed, and the log line is the
 * evidence that the ledger is behind. `02` §3.3.7's reconciliation job is the backstop.
 *
 * One transaction per iteration rather than one for all of them: a batch of two where the second
 * row violates a constraint should still record the first, because the first was still billed.
 */
export function recordUsage(
  deps: UsageHookDeps,
  context: UsageContext,
  iterations: readonly UsageIteration[],
): void {
  for (const iteration of iterations) {
    const record = usageRecordFor(deps, context, iteration);
    try {
      deps.tx((token) => deps.usage.record(token, record));
    } catch (error) {
      deps.logger.error('usage.record_failed', {
        provider: context.provider,
        route: context.route,
        model: iteration.model,
        costMicros: record.costMicros,
        // The error's **name** only. A storage error's message can carry a parameter, and
        // `01` §11.7 keeps those out of a log above `debug`.
        detail: { error: error instanceof Error ? error.name : 'unknown' },
      });
    }
  }
}
