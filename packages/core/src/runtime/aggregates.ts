/**
 * The turn journal, trace, audit and usage aggregates (`02` §3.3.7, §3.8; semantics in `05`).
 *
 * Four aggregates, and each carries one rule that is unusual enough to state at the type:
 *
 *  - **A turn is journaled before it acts, and an effect is journaled before it runs.** `01` §14
 *    A23: an external effect is written as `intent` *first*, so a crash leaves evidence that it
 *    may have happened rather than silence. Invariant **I6** (exactly-once intent) is the unique
 *    `idempotency_key`; invariant **I7** (acknowledged effects) is `ack_outbox_id` being `NULL`
 *    until somebody has been told.
 *  - **A trace holds ids, never content** (`02` §3.3.9). It is retained for days and readable by
 *    whoever its own label admits, so recording the context *text* would be a second, longer-lived
 *    copy of the most sensitive assembly the product performs.
 *  - **An audit event is append-only and hash-chained.** `hash = sha256(prevHash ‖ JCS(event
 *    without hashes))`, so altering or removing any row breaks every hash after it. The chain is
 *    retained through erasure (`02` §3.13.5 step 8) precisely because it holds no content.
 *  - **Usage is rolled up in the same transaction that records it.** `05`'s budget guard runs on
 *    every turn, and a separate rollup job would leave a window in which spend had happened and
 *    the guard could not see it.
 */
import type {
  AuditId,
  ConversationId,
  GroupId,
  JobId,
  LabelId,
  MemberId,
  MessageId,
  OutboxId,
  ReaderSetId,
  TurnEffectId,
  TurnId,
  TurnTraceId,
  UsageId,
  z,
} from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';
import type { AuditActor } from '../domain/audit.js';
import type { EntityRef } from '../domain/entity-ref.js';
import type { AuditDecision, AuditDetails } from './audit.js';
import type {
  ContextManifest,
  GuardResultTraceSchema,
  LatencyTrace,
  ModelCallTraceSchema,
  PolicyDecisionTraceSchema,
  ToolCallTraceSchema,
  TraceReplayMeta,
  TraceTriggerSchema,
} from './traces.js';
import type { EffectSummaryParams, TurnFailure } from './turns.js';

/**
 * The five trace interiors `M5` and `M4` own.
 *
 * `02` §3.3.9 pins these as **storage contracts**: the column's JSON shape is fixed in `traces.ts`
 * and the meaning of what is inside belongs to the milestone that produces it. Taking the inferred
 * type rather than inventing an interface is what keeps this layer from guessing at a shape it
 * does not own.
 */
type TraceTrigger = z.infer<typeof TraceTriggerSchema>;
type ModelCallTrace = z.infer<typeof ModelCallTraceSchema>;
type ToolCallTrace = z.infer<typeof ToolCallTraceSchema>;
type PolicyDecisionTrace = z.infer<typeof PolicyDecisionTraceSchema>;
type GuardResultTrace = z.infer<typeof GuardResultTraceSchema>;

/* ──────────────────────────── Turns ──────────────────────────── */

/** `02` §3.3.7's `turns.kind` (`05` §3.3.1, `07` §3.0.3). */
export const TURN_KINDS = [
  'respond',
  'interject',
  'interaction',
  'command',
  'confirmation_resume',
  'continuation',
  'digest',
  'reminder',
  'system',
  'recovery',
] as const;
export type TurnKind = (typeof TURN_KINDS)[number];

/**
 * `02` §3.3.7's `turns.status` (`05` S1).
 *
 * `recovered` is distinct from `completed` because the two mean different things to a member: a
 * recovered turn is one the product finished *for* itself after a crash and told the group about,
 * and `05` renders it differently. `timed_out` is distinct from `failed` for the same reason —
 * the deadline passing is not an error anybody can fix.
 */
export const TURN_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'timed_out',
  'cancelled',
  'recovered',
] as const;
export type TurnStatus = (typeof TURN_STATUSES)[number];

/** Where a turn is, which decides what a crash recovery has to check. `undefined` when idle. */
export const TURN_PHASES = [
  'building_context',
  'model_step',
  'tools',
  'guarding',
  'committing',
] as const;
export type TurnPhase = (typeof TURN_PHASES)[number];

export const TURN_EFFORTS = ['low', 'medium', 'high'] as const;
export type TurnEffort = (typeof TURN_EFFORTS)[number];

/**
 * One turn of the agent (`02` §3.3.7; `05` §3.3).
 *
 * ## Why `bootId` is a column
 *
 * A `running` row means nothing on its own after a restart: the process that was running it is
 * gone, and nothing updated the row on the way out. `boot_id` is the process incarnation that
 * started it, so Q-TRN-1 can ask the only question that distinguishes a live turn from a corpse —
 * *is this mine?* A timestamp heuristic would either abandon slow turns or adopt dead ones.
 *
 * ## Why `rootTurnId` is not `id`
 *
 * `05` S2 scopes idempotency to the **root** turn, so a retry of any child collides with the
 * original child's effect rather than running it again. A turn that is its own root has
 * `rootTurnId === id`; a continuation or a confirmation resume keeps its ancestor's.
 */
export interface Turn {
  readonly id: TurnId;
  readonly groupId: GroupId;
  readonly conversationId: ConversationId;
  readonly kind: TurnKind;
  readonly triggerMessageIds: readonly MessageId[];
  /** `undefined` means `SystemAuthority` — nobody asked, so nobody's authority is borrowed. */
  readonly requesterMemberId: MemberId | undefined;
  /** `05`'s `audienceSnapshotId`: the audience frozen at turn start, seats included. */
  readonly audienceReaderSetId: ReaderSetId;
  readonly status: TurnStatus;
  readonly phase: TurnPhase | undefined;
  readonly phaseStep: number | undefined;
  readonly effort: TurnEffort | undefined;
  readonly bootId: string;
  /** Equals `id` for a root turn. Idempotency keys derive from this, not from `id`. */
  readonly rootTurnId: TurnId;
  readonly parentTurnId: TurnId | undefined;
  readonly retryOfTurnId: TurnId | undefined;
  readonly restarts: number;
  readonly recoveryDone: boolean;
  readonly startedAt: Temporal.Instant;
  readonly deadlineAt: Temporal.Instant;
  readonly timedOutAt: Temporal.Instant | undefined;
  readonly completedAt: Temporal.Instant | undefined;
  readonly failure: TurnFailure | undefined;
}

/**
 * What a caller supplies to start a turn.
 *
 * `status` is absent: `02` §3.8's first row is `INSERT turns(status='running', …)`, and a caller
 * that could start a turn already `completed` would make the journal a record of intentions rather
 * than of what ran. `rootTurnId` is optional and defaults to `id`, so the common case cannot get
 * the self-reference wrong.
 */
export interface NewTurn {
  readonly id: TurnId;
  readonly groupId: GroupId;
  readonly conversationId: ConversationId;
  readonly kind: TurnKind;
  readonly triggerMessageIds: readonly MessageId[];
  readonly requesterMemberId?: MemberId | undefined;
  readonly audienceReaderSetId: ReaderSetId;
  readonly effort?: TurnEffort | undefined;
  readonly bootId: string;
  readonly rootTurnId?: TurnId | undefined;
  readonly parentTurnId?: TurnId | undefined;
  readonly retryOfTurnId?: TurnId | undefined;
  readonly startedAt: Temporal.Instant;
  readonly deadlineAt: Temporal.Instant;
}

/* ──────────────────────── Turn effects ──────────────────────── */

/**
 * `02` §3.3.7's `turn_effects.status` (`01` §14 A23).
 *
 * `intent` is written **before** the tool runs. That ordering is the whole point: a crash between
 * the journal write and the tool call leaves a row saying "this may have happened", which recovery
 * can act on; the reverse ordering leaves nothing, and an external effect that happened silently
 * is the failure A23 exists to prevent.
 */
export const EFFECT_STATUSES = ['intent', 'committed', 'failed'] as const;
export type EffectStatus = (typeof EFFECT_STATUSES)[number];

/**
 * One journaled effect of a turn (`02` §3.3.7; `05` S2).
 *
 * `idempotencyKey` is `sha256(rootTurnId ‖ toolName ‖ canonicalJson(input))` and is **computed by
 * the repository**, never supplied — the same reasoning as a constitution's yaml digest and a
 * message's dedupe key: a key is only a guarantee if exactly one place derives it, and I6 is that
 * guarantee. Absent from `NewTurnEffect` for that reason.
 *
 * `ackOutboxId` is invariant **I7**: it stays `undefined` until a reply or recovery summary
 * covering this effect is enqueued. An effect nobody has been told about is the thing `02` §3.8's
 * recovery exists to find.
 */
export interface TurnEffect {
  readonly id: TurnEffectId;
  readonly turnId: TurnId;
  readonly rootTurnId: TurnId;
  readonly groupId: GroupId;
  readonly seq: number;
  readonly toolName: string;
  readonly idempotencyKey: string;
  readonly status: EffectStatus;
  /** `05`'s `resultJson`, field-encrypted: a tool result can contain anything. */
  readonly resultCiphertext: Uint8Array | undefined;
  /** A template key in a versioned copy file (`05`), never model prose. */
  readonly summaryKey: string;
  readonly summaryParams: EffectSummaryParams;
  readonly entityRefs: readonly EntityRef[];
  readonly labelId: LabelId;
  readonly committedAt: Temporal.Instant | undefined;
  readonly ackOutboxId: OutboxId | undefined;
}

/**
 * What a caller supplies to journal an effect.
 *
 * `seq` is absent — `02` §3.8 says `seq = max+1`, computed inside the write transaction, so two
 * effects journaled in the same turn cannot collide. `input` is here and `idempotencyKey` is not:
 * the repository derives the key from `rootTurnId`, `toolName` and the canonical form of this
 * input, which is what makes I6 a property of the storage layer rather than of every caller.
 */
export interface NewTurnEffect {
  readonly id: TurnEffectId;
  readonly turnId: TurnId;
  readonly toolName: string;
  /** The tool's arguments, canonicalised into the idempotency key. Never stored as-is. */
  readonly input: unknown;
  readonly summaryKey: string;
  readonly summaryParams: EffectSummaryParams;
  readonly entityRefs?: readonly EntityRef[] | undefined;
}

/* ──────────────────────────── Traces ──────────────────────────── */

/**
 * One turn's trace (`02` §3.3.7; `05` §3.10, `11` §12-1).
 *
 * Every field is a reference, a count or a version. The rendered prompt and response are not here
 * at all — `05` §3.10.1 puts them in `turn_trace_debug`, behind `COMVIVO_DEBUG_CONTENT=1`,
 * field-encrypted, host-only and expiring in 24 hours — so a trace can be shown to a member
 * without any possibility of leaking a prompt, because the prompt is not in it.
 */
export interface TurnTrace {
  readonly id: TurnTraceId;
  readonly turnId: TurnId;
  readonly groupId: GroupId;
  readonly conversationId: ConversationId;
  readonly labelId: LabelId;
  readonly trigger: TraceTrigger;
  readonly disposition: string;
  readonly contextManifest: ContextManifest;
  readonly modelCalls: readonly ModelCallTrace[];
  readonly toolCalls: readonly ToolCallTrace[];
  readonly policyDecisions: readonly PolicyDecisionTrace[];
  readonly guardResults: readonly GuardResultTrace[];
  readonly costMicros: number;
  readonly latency: LatencyTrace;
  readonly replay: TraceReplayMeta;
  readonly createdAt: Temporal.Instant;
  readonly expiresAt: Temporal.Instant;
}

export interface NewTurnTrace {
  readonly id: TurnTraceId;
  readonly turnId: TurnId;
  readonly groupId: GroupId;
  readonly conversationId: ConversationId;
  readonly trigger: TraceTrigger;
  readonly disposition: string;
  readonly contextManifest: ContextManifest;
  readonly modelCalls: readonly ModelCallTrace[];
  readonly toolCalls: readonly ToolCallTrace[];
  readonly policyDecisions: readonly PolicyDecisionTrace[];
  readonly guardResults: readonly GuardResultTrace[];
  readonly costMicros?: number | undefined;
  readonly latency: LatencyTrace;
  readonly replay: TraceReplayMeta;
  readonly expiresAt: Temporal.Instant;
}

/* ──────────────────────────── Audit ──────────────────────────── */

/**
 * One audit event (`02` §3.3.7).
 *
 * `chainKey` is the group id or `'_instance'`, so each group has its own chain: a group's deletion
 * then removes its chain whole rather than leaving a gap in a shared one, which would be
 * indistinguishable from tampering. `groupId` is separate and nullable because the cascade on it is
 * what removes those rows on purge, while `chainKey` remains the ordering key.
 *
 * `prevHash` and `hash` are **computed by the repository** from the chain head. A caller-supplied
 * hash would be derived from whatever that caller had, so a forged row with a matching forged hash
 * would verify — which is the one thing a tamper-evident chain exists to prevent.
 */
export interface AuditEvent {
  readonly id: AuditId;
  readonly chainKey: string;
  readonly seq: number;
  readonly groupId: GroupId | undefined;
  readonly actor: AuditActor;
  readonly action: string;
  /** An `EntityRef` rendered as a string. */
  readonly target: string | undefined;
  readonly decision: AuditDecision;
  /** Ids, enums and counts. **Never** content (`02` §3.3.9). */
  readonly details: AuditDetails;
  readonly prevHash: Uint8Array;
  readonly hash: Uint8Array;
  readonly at: Temporal.Instant;
}

/**
 * What a caller supplies to append an audit event.
 *
 * Neither `seq` nor the two hashes are here: all three come from the chain head, inside the write
 * transaction. `chainKey` is also absent — it is derived from `groupId`, because a row whose
 * `chain_key` disagreed with its `group_id` would be removed by the purge cascade while remaining
 * part of another chain, which is a gap that looks exactly like tampering.
 */
export interface NewAuditEvent {
  readonly id: AuditId;
  readonly groupId?: GroupId | undefined;
  readonly actor: AuditActor;
  readonly action: string;
  readonly target?: string | undefined;
  readonly decision: AuditDecision;
  readonly details: AuditDetails;
  readonly at: Temporal.Instant;
}

/** `02` §3.3.7: the instance chain's key, for an action that belongs to no group. */
export const INSTANCE_CHAIN_KEY = '_instance';

/** The chain an event belongs to. One per group, plus the instance's. */
export function chainKeyFor(groupId: GroupId | undefined): string {
  return groupId ?? INSTANCE_CHAIN_KEY;
}

/**
 * What `verifyChain` found (`09`'s `/instance/audit/verify`, `11` §1116).
 *
 * `brokenAtSeq` rather than a boolean alone, because the number is the actionable part: `08` §895
 * re-anchors the chain on a retention purge, so a host needs to know *where* verification stopped
 * to tell a legitimate re-anchor from an edited row.
 */
export interface ChainVerification {
  readonly chainKey: string;
  readonly ok: boolean;
  readonly checked: number;
  readonly brokenAtSeq: number | undefined;
}

/* ──────────────────────────── Usage ──────────────────────────── */

export const USAGE_VIA = ['chat', 'dashboard', 'mcp', 'job'] as const;
export type UsageVia = (typeof USAGE_VIA)[number];

/** `02` §3.3.7: a `fallback_message` is `05` S9's refusal fallback, charged separately. */
export const USAGE_KINDS = ['message', 'fallback_message'] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

/**
 * One model call's cost (`02` §3.3.7).
 *
 * The four token columns are separate because `02`'s price table charges cache writes at different
 * rates by TTL and cache reads at a tenth of input: a single `inputTokens` would make `costMicros`
 * unreproducible from the record, and a cost report nobody can re-derive is a number to argue
 * about. `priceTableVersion` is stamped for the same reason — a price change must not rewrite
 * history.
 */
export interface UsageRecord {
  readonly id: UsageId;
  /** `undefined` means instance-level, e.g. a boot-time health check. */
  readonly groupId: GroupId | undefined;
  readonly turnId: TurnId | undefined;
  readonly jobId: JobId | undefined;
  readonly route: string;
  readonly provider: string;
  readonly model: string;
  /** `05` S9: the model that actually answered, which the refusal fallback can change. */
  readonly servedModel: string;
  readonly purpose: string;
  readonly via: UsageVia;
  readonly effort: string | undefined;
  readonly kind: UsageKind;
  readonly inputTokens: number;
  readonly cachedReadTokens: number;
  readonly cacheWrite5mTokens: number;
  readonly cacheWrite1hTokens: number;
  readonly outputTokens: number;
  readonly costMicros: number;
  readonly priceTableVersion: string;
  readonly batch: boolean;
  readonly at: Temporal.Instant;
}

export interface NewUsageRecord {
  readonly id: UsageId;
  readonly groupId?: GroupId | undefined;
  readonly turnId?: TurnId | undefined;
  readonly jobId?: JobId | undefined;
  readonly route: string;
  readonly provider: string;
  readonly model: string;
  readonly servedModel: string;
  readonly purpose: string;
  readonly via?: UsageVia | undefined;
  readonly effort?: string | undefined;
  readonly kind?: UsageKind | undefined;
  readonly inputTokens: number;
  readonly cachedReadTokens: number;
  readonly cacheWrite5mTokens: number;
  readonly cacheWrite1hTokens: number;
  readonly outputTokens: number;
  readonly costMicros: number;
  readonly priceTableVersion: string;
  readonly batch?: boolean | undefined;
  readonly at: Temporal.Instant;
  /**
   * The group's local date for the rollup, `YYYY-MM-DD` (`02` §3.3.7).
   *
   * Supplied rather than derived, because deriving it needs the group's timezone and `core` is
   * pure — and the point of a local day is that a daily budget resets when the group's day does
   * rather than at UTC midnight. `05`'s caller has the zone; the repository has `at`.
   */
  readonly dayLocal: string;
}

/**
 * One row of the daily rollup (`02` §3.3.7's `usage_daily`).
 *
 * Maintained in the **same transaction** as the record it summarises, which is what makes Q-USE-1's
 * budget guard correct: a separate rollup job would leave a window in which spend had happened and
 * the guard could not see it, and `05` checks the budget on every turn. `M1-T21` asserts as a
 * property that this table equals the sum of its records.
 */
export interface UsageDailyRow {
  /** `groupId` or `'_instance'`. */
  readonly groupKey: string;
  readonly dayLocal: string;
  readonly route: string;
  readonly calls: number;
  readonly costMicros: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedReadTokens: number;
}

/** The rollup key an action belongs to. One per group, plus the instance's. */
export function usageGroupKey(groupId: GroupId | undefined): string {
  return groupId ?? INSTANCE_CHAIN_KEY;
}

/**
 * Whether a `running` turn belongs to a previous process, or has outlived its deadline.
 *
 * Q-TRN-1's predicate as a function, because the two halves answer different failures and are easy
 * to apply separately: a different `bootId` means the process that was running it is gone, and a
 * passed deadline means this process is still running it but should not be. Either one makes the
 * turn recoverable; neither alone is enough to cover the other's case.
 */
export function isOrphaned(
  turn: Pick<Turn, 'status' | 'bootId' | 'deadlineAt'>,
  bootId: string,
  now: Temporal.Instant,
  compare: (left: Temporal.Instant, right: Temporal.Instant) => number,
): boolean {
  if (turn.status !== 'running') return false;
  return turn.bootId !== bootId || compare(turn.deadlineAt, now) < 0;
}
