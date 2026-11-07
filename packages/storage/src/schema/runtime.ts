/**
 * The turn journal, traces, audit chain, outbox and usage (`02` §3.3.7; `05`, `06`, `11`).
 *
 * Four of the eight sacred invariants live in this file, and each one is a column or an index
 * rather than a convention.
 *
 * **I6, exactly-once intent** — `turn_effects.idempotency_key` is `UNIQUE` and is
 * `sha256(rootTurnId ‖ toolName ‖ canonicalJson(input))`. A retried turn computes the same key and
 * collides instead of acting twice. `outbox_messages.idempotency_key` does the same for sends.
 *
 * **A23, intent before execution** — `turn_effects.status` starts at `intent` and the row is
 * written *before* an external effect runs. A crash therefore leaves evidence that something may
 * have happened, which `turn_effects_intent_idx` finds; without the pre-write, recovery could not
 * distinguish "never started" from "started and we don't know".
 *
 * **I7, acknowledged effects** — `ack_outbox_id` is `NULL` until a reply covering the effect is
 * enqueued, and `turn_effects_unacked_idx` is partial on exactly that. An action the group was
 * never told about is a bug the schema can enumerate.
 *
 * **I5, guarded egress** — `outbox_messages.guard_ref` is `NOT NULL` with a `length > 0` check. A
 * message cannot be enqueued without naming the disclosure-guard record that cleared it.
 *
 * The audit chain is the fifth: `prev_hash`/`hash` make `audit_events` tamper-evident, and
 * `audit_chain_seq_uq` on `(chain_key, seq)` makes a gap or a fork impossible to insert quietly.
 */
import {
  AuditActorSchema,
  AuditDecisionSchema,
  AuditDetailsSchema,
  ContextManifestSchema,
  EffectSummaryParamsSchema,
  EntityRefSchema,
  ErrorInfoSchema,
  GuardResultTraceSchema,
  LatencyTraceSchema,
  ModelCallTraceSchema,
  OutboundPayloadSchema,
  OutboxPartsSchema,
  PolicyDecisionTraceSchema,
  ToolCallTraceSchema,
  TraceReplayMetaSchema,
  TraceTriggerSchema,
  TriggerMessageIdsSchema,
  TurnFailureSchema,
} from '@comvivo/core';
import { z } from '@comvivo/shared';
import { sql } from 'drizzle-orm';
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { bool, boolCheckSql, createdAt, instantMs, jsonOf, labelRef, tid } from './_columns.js';
import { conversations, groups, members } from './groups.js';
import { readerSets } from './ifc.js';

export const turns = sqliteTable(
  'turns',
  {
    id: tid('trn')('id').primaryKey(),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    conversationId: tid('cnv')('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    kind: text('kind', {
      enum: [
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
      ],
    }).notNull(),
    triggerMessageIds: jsonOf(
      TriggerMessageIdsSchema,
      'turns.trigger_message_ids',
    )('trigger_message_ids').notNull(),
    /** `NULL` means `SystemAuthority` — nobody asked, so nobody's authority is borrowed. */
    requesterMemberId: tid('mbr')('requester_member_id').references(() => members.id),
    /** `05`'s `audienceSnapshotId`: the audience frozen at turn start, seats included. */
    audienceReaderSetId: integer('audience_reader_set_id')
      .notNull()
      .references(() => readerSets.id),
    status: text('status', {
      enum: ['queued', 'running', 'completed', 'failed', 'timed_out', 'cancelled', 'recovered'],
    }).notNull(),
    /** `NULL` when not running. Decides what a crash recovery has to check. */
    phase: text('phase', {
      enum: ['building_context', 'model_step', 'tools', 'guarding', 'committing'],
    }),
    phaseStep: integer('phase_step'),
    effort: text('effort', { enum: ['low', 'medium', 'high'] }),
    /** Which process incarnation started it, so another boot can tell a stale `running` row. */
    bootId: text('boot_id').notNull(),
    /** Equals `id` for root turns (`05` S1). Idempotency keys are derived from this, not `id`. */
    rootTurnId: tid('trn')('root_turn_id').notNull(),
    parentTurnId: tid('trn')('parent_turn_id'),
    retryOfTurnId: tid('trn')('retry_of_turn_id'),
    restarts: integer('restarts').notNull().default(0),
    recoveryDone: bool('recovery_done').notNull().default(false),
    startedAt: instantMs('started_at').notNull(),
    deadlineAt: instantMs('deadline_at').notNull(),
    timedOutAt: instantMs('timed_out_at'),
    completedAt: instantMs('completed_at'),
    failure: jsonOf(TurnFailureSchema, 'turns.failure')('failure'),
  },
  (t) => [
    // Q-TRN-1: turns still running — which after a restart means turns to recover.
    index('turns_running_idx').on(t.startedAt).where(sql`${t.status} = 'running'`),
    index('turns_timeout_idx').on(t.deadlineAt).where(sql`${t.status} IN ('queued','running')`),
    index('turns_root_idx').on(t.rootTurnId),
    // Q-TRN-3: a conversation's recent turns.
    index('turns_conv_started_idx').on(t.conversationId, t.startedAt),
    check('turns_recovery_done_bool_ck', boolCheckSql(t.recoveryDone)),
    check('turns_restarts_ck', sql`${t.restarts} >= 0`),
  ],
);

export const turnEffects = sqliteTable(
  'turn_effects',
  {
    id: tid('tfx')('id').primaryKey(),
    turnId: tid('trn')('turn_id')
      .notNull()
      .references(() => turns.id, { onDelete: 'cascade' }),
    /** Idempotency is scoped to the root turn, so a retry of any child collides correctly. */
    rootTurnId: tid('trn')('root_turn_id').notNull(),
    groupId: tid('grp')('group_id').notNull(),
    seq: integer('seq').notNull(),
    toolName: text('tool_name').notNull(),
    /** I6: `sha256(rootTurnId ‖ toolName ‖ canonicalJson(input))`. */
    idempotencyKey: text('idempotency_key').notNull().unique(),
    /** A23: an external effect is journaled as `intent` **before** it runs. */
    status: text('status', { enum: ['intent', 'committed', 'failed'] }).notNull(),
    /** `05`'s `resultJson`, field-encrypted: a tool result can contain anything. */
    resultCiphertext: blob('result_ciphertext', { mode: 'buffer' }),
    /** A template key in a versioned copy file (`05`), never model prose. */
    summaryKey: text('summary_key').notNull(),
    summaryParams: jsonOf(
      EffectSummaryParamsSchema,
      'turn_effects.summary_params',
    )('summary_params').notNull(),
    entityRefs: jsonOf(
      z.array(EntityRefSchema).max(50),
      'turn_effects.entity_refs',
    )('entity_refs').notNull(),
    labelId: labelRef().notNull(),
    /** `NULL` while `status = 'intent'`. */
    committedAt: instantMs('committed_at'),
    /** I7: set when a reply or recovery summary covering this effect is enqueued. */
    ackOutboxId: tid('obx')('ack_outbox_id'),
  },
  (t) => [
    // Q-TRN-2: a turn's effects in order.
    uniqueIndex('turn_effects_turn_seq_uq').on(t.turnId, t.seq),
    index('turn_effects_root_idx').on(t.rootTurnId),
    // A23 recovery: effects that may have run. Empty on a healthy instance.
    index('turn_effects_intent_idx').on(t.turnId).where(sql`${t.status} = 'intent'`),
    // Q-TRN-2b / I7: effects nobody has been told about.
    index('turn_effects_unacked_idx').on(t.turnId).where(sql`${t.ackOutboxId} IS NULL`),
    check('turn_effects_seq_ck', sql`${t.seq} >= 0`),
  ],
);

export const turnTraces = sqliteTable(
  'turn_traces',
  {
    id: tid('trc')('id').primaryKey(),
    turnId: tid('trn')('turn_id')
      .notNull()
      .unique()
      .references(() => turns.id, { onDelete: 'cascade' }),
    groupId: tid('grp')('group_id').notNull(),
    conversationId: tid('cnv')('conversation_id').notNull(),
    /** Who may read this trace (`03`/`09`). A trace is a datum like any other. */
    labelId: labelRef().notNull(),
    trigger: jsonOf(TraceTriggerSchema, 'turn_traces.trigger')('trigger').notNull(),
    disposition: text('disposition').notNull(),
    /** Ids and label ids only — never the context text (`02` §3.3.9). */
    contextManifest: jsonOf(
      ContextManifestSchema,
      'turn_traces.context_manifest',
    )('context_manifest').notNull(),
    modelCalls: jsonOf(
      z.array(ModelCallTraceSchema).max(50),
      'turn_traces.model_calls',
    )('model_calls').notNull(),
    toolCalls: jsonOf(
      z.array(ToolCallTraceSchema).max(100),
      'turn_traces.tool_calls',
    )('tool_calls').notNull(),
    policyDecisions: jsonOf(
      z.array(PolicyDecisionTraceSchema).max(100),
      'turn_traces.policy_decisions',
    )('policy_decisions').notNull(),
    guardResults: jsonOf(
      z.array(GuardResultTraceSchema).max(50),
      'turn_traces.guard_results',
    )('guard_results').notNull(),
    costMicros: integer('cost_micros').notNull().default(0),
    latency: jsonOf(LatencyTraceSchema, 'turn_traces.latency')('latency').notNull(),
    /** `11` §12-1: everything a replay needs to reproduce the turn. */
    replay: jsonOf(TraceReplayMetaSchema, 'turn_traces.replay')('replay').notNull(),
    createdAt: createdAt(),
    /** Traces expire: they are the most detailed record the product keeps. */
    expiresAt: instantMs('expires_at').notNull(),
  },
  (t) => [
    // Q-DASH-2: the dashboard's trace list.
    index('turn_traces_group_created_idx').on(t.groupId, t.createdAt),
    // Q-RET-2: the retention sweep.
    index('turn_traces_expires_idx').on(t.expiresAt),
    check('turn_traces_cost_ck', sql`${t.costMicros} >= 0`),
  ],
);

/**
 * Rendered model input and output — **off by default** (`05` §3.10.1).
 *
 * A separate table rather than columns on `turn_traces`, and that separation is the control: this
 * row only exists when `COMVIVO_DEBUG_CONTENT=1`, it is field-encrypted, it is host-only, it is
 * never exported, and it expires in 24 hours. `turn_traces` can therefore be shown to a member
 * without any possibility of leaking a prompt, because the prompt is not in it.
 */
export const turnTraceDebug = sqliteTable(
  'turn_trace_debug',
  {
    turnId: tid('trn')('turn_id')
      .primaryKey()
      .references(() => turns.id, { onDelete: 'cascade' }),
    /** Rendered requests and responses, field-encrypted. */
    ciphertext: blob('ciphertext', { mode: 'buffer' }).notNull(),
    /** 24 h by default; `11`'s captured model I/O is configurable 1–30 days. */
    expiresAt: instantMs('expires_at').notNull(),
  },
  (t) => [index('turn_trace_debug_expires_idx').on(t.expiresAt)],
);

/**
 * The audit chain (`02` §3.3.7) — append-only and tamper-evident.
 *
 * `hash = sha256(prevHash ‖ JCS(event without hashes))`, so altering or removing any row breaks
 * every hash after it. `chain_key` is the group id or `'_instance'`, giving each group its own
 * chain — a group's deletion then removes its chain whole rather than leaving a gap in a shared
 * one, which would be indistinguishable from tampering.
 *
 * `group_id` is nullable and separate from `chain_key` because instance-level actions have no
 * group; the cascade on `group_id` is what removes a group's rows on purge, while `chain_key`
 * remains the ordering key.
 */
export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: tid('aud')('id').primaryKey(),
    /** `groupId` or `'_instance'`: one chain per group. */
    chainKey: text('chain_key').notNull(),
    seq: integer('seq').notNull(),
    groupId: tid('grp')('group_id').references(() => groups.id, { onDelete: 'cascade' }),
    actor: jsonOf(AuditActorSchema, 'audit_events.actor')('actor').notNull(),
    action: text('action').notNull(),
    /** An `EntityRef` rendered as a string. */
    target: text('target'),
    decision: jsonOf(AuditDecisionSchema, 'audit_events.decision')('decision').notNull(),
    /** Ids and enums only, **never** content (`02` §3.3.9). */
    details: jsonOf(AuditDetailsSchema, 'audit_events.details')('details').notNull(),
    /** 32 bytes; zeros for `seq` 1. */
    prevHash: blob('prev_hash', { mode: 'buffer' }).notNull(),
    hash: blob('hash', { mode: 'buffer' }).notNull(),
    at: instantMs('at').notNull(),
  },
  (t) => [
    // Q-AUD-1: the chain head, and the constraint that makes a fork unrepresentable.
    uniqueIndex('audit_chain_seq_uq').on(t.chainKey, t.seq),
    // Q-DASH-3.
    index('audit_group_at_idx').on(t.groupId, t.at),
    check('audit_seq_ck', sql`${t.seq} >= 1`),
  ],
);

export const outboxMessages = sqliteTable(
  'outbox_messages',
  {
    id: tid('obx')('id').primaryKey(),
    groupId: tid('grp')('group_id').references(() => groups.id, { onDelete: 'cascade' }),
    conversationId: tid('cnv')('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    turnId: tid('trn')('turn_id'),
    /** Monotonic per conversation: the FIFO order sends must respect. */
    seq: integer('seq').notNull(),
    /** I6 for sends. `'<turnId>:<index>'` | `'<turnId>:ph'` | `'rem:<id>:<occurrenceKey>'` | … */
    idempotencyKey: text('idempotency_key').notNull().unique(),
    /** A24. `07`'s attention budget counts `proactive` rows rather than keeping a second ledger. */
    messageClass: text('message_class', {
      enum: ['reply', 'requested', 'digest', 'proactive', 'system'],
    }).notNull(),
    priority: text('priority', { enum: ['interactive', 'scheduled', 'background'] })
      .notNull()
      .default('interactive'),
    /** What to do when a send is late: `must_deliver` never expires, `best_effort` is dropped. */
    expiryClass: text('expiry_class', { enum: ['must_deliver', 'timely', 'best_effort'] })
      .notNull()
      .default('timely'),
    payload: jsonOf(OutboundPayloadSchema, 'outbox_messages.payload')('payload').notNull(),
    /**
     * Named `parts_json` because `02` §3.3.7 and §3.3.9 both call the column that. The spec's own
     * declaration tags it `outbox_messages.parts`, which names no column — the same defect as
     * `labels.co_owners`, and the tag is what a `STORAGE_JSON_INVALID` error prints. Corrected
     * here and in the spec (`M1-T12`).
     */
    parts: jsonOf(OutboxPartsSchema, 'outbox_messages.parts_json')('parts_json').notNull(),
    /** sha256 of the normalised rendered text: Q-OBX-3's near-duplicate suppression. */
    contentHash: blob('content_hash', { mode: 'buffer' }).notNull(),
    audienceReaderSetId: integer('audience_reader_set_id')
      .notNull()
      .references(() => readerSets.id),
    labelId: labelRef(),
    /** I5: the `DisclosureGuard` pass record. `NOT NULL` plus a length check — no unguarded send. */
    guardRef: text('guard_ref').notNull(),
    /** `03` §3.4.7's send-time re-check: the labels the rendered text drew on. */
    manifestLabelIds: jsonOf(
      z.array(z.int()).max(500),
      'outbox_messages.manifest_label_ids',
    )('manifest_label_ids').notNull(),
    status: text('status', {
      enum: ['pending', 'sending', 'sent', 'dead', 'cancelled', 'expired'],
    })
      .notNull()
      .default('pending'),
    /** `06`'s `possibleDuplicate`: the send timed out and delivery is unknown. */
    maybeSent: bool('maybe_sent').notNull().default(false),
    inFlightSince: instantMs('in_flight_since'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: instantMs('next_attempt_at').notNull(),
    leaseUntil: instantMs('lease_until'),
    platformMessageId: text('platform_message_id'),
    lastError: jsonOf(ErrorInfoSchema, 'outbox_messages.last_error')('last_error'),
    createdAt: createdAt(),
    sentAt: instantMs('sent_at'),
  },
  (t) => [
    // Q-OBX-1: what to send next.
    index('outbox_dispatch_idx').on(t.nextAttemptAt).where(sql`${t.status} = 'pending'`),
    // Q-OBX-2: FIFO per conversation, over only the rows still in flight.
    index('outbox_conv_seq_idx')
      .on(t.conversationId, t.seq)
      .where(sql`${t.status} IN ('pending','sending')`),
    // Q-OBX-3: did we just say this?
    index('outbox_recent_sent_idx')
      .on(t.conversationId, t.contentHash, t.sentAt)
      .where(sql`${t.status} = 'sent'`),
    // Q-OBX-4: crash recovery — sends whose lease expired.
    index('outbox_sending_idx').on(t.leaseUntil).where(sql`${t.status} = 'sending'`),
    // Q-OBX-5: `07`'s attention budget.
    index('outbox_class_idx')
      .on(t.groupId, t.messageClass, t.sentAt)
      .where(sql`${t.status} = 'sent'`),
    check('outbox_guard_ck', sql`length(${t.guardRef}) > 0`),
    check('outbox_maybe_sent_bool_ck', boolCheckSql(t.maybeSent)),
    check('outbox_seq_ck', sql`${t.seq} >= 0`),
    check('outbox_attempts_ck', sql`${t.attempts} >= 0`),
  ],
);

/**
 * One model call's cost (`02` §3.3.7).
 *
 * `served_model` is separate from `model` because `05` S9's refusal fallback means the model that
 * answered may not be the one asked — and a cost report that conflated them would misattribute
 * spend and hide how often the fallback fires.
 *
 * The four token columns are separate for the same reason: `02`'s price table charges cache writes
 * at different rates by TTL and cache reads at a tenth of input, so a single `input_tokens` would
 * make the cost unreproducible from the record.
 */
export const usageRecords = sqliteTable(
  'usage_records',
  {
    id: tid('use')('id').primaryKey(),
    /** `NULL` means instance-level, e.g. a boot-time health check. */
    groupId: tid('grp')('group_id').references(() => groups.id, { onDelete: 'cascade' }),
    turnId: tid('trn')('turn_id'),
    jobId: tid('job')('job_id'),
    route: text('route').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    /** `05` S9: the model that actually answered, which the refusal fallback can change. */
    servedModel: text('served_model').notNull(),
    /** e.g. `chat`, `memory.extract`, `feature:<name>`. */
    purpose: text('purpose').notNull(),
    via: text('via', { enum: ['chat', 'dashboard', 'mcp', 'job'] })
      .notNull()
      .default('chat'),
    effort: text('effort'),
    kind: text('kind', { enum: ['message', 'fallback_message'] })
      .notNull()
      .default('message'),
    inputTokens: integer('input_tokens').notNull(),
    cachedReadTokens: integer('cached_read_tokens').notNull(),
    cacheWrite5mTokens: integer('cache_write_5m_tokens').notNull(),
    cacheWrite1hTokens: integer('cache_write_1h_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    costMicros: integer('cost_micros').notNull(),
    /** Which price table computed `cost_micros`, so a price change does not rewrite history. */
    priceTableVersion: text('price_table_version').notNull(),
    batch: bool('batch').notNull().default(false),
    at: instantMs('at').notNull(),
  },
  (t) => [
    // Q-USE-2: cost reports.
    index('usage_group_at_idx').on(t.groupId, t.at),
    check('usage_batch_bool_ck', boolCheckSql(t.batch)),
    check('usage_cost_ck', sql`${t.costMicros} >= 0`),
  ],
);

/**
 * The daily usage rollup (`02` §3.3.7).
 *
 * Maintained **in the same transaction** as the `usage_records` insert, which is what makes the
 * budget guard correct: a separate rollup job would leave a window in which spend had happened but
 * the guard could not see it, and `05`'s budget check runs on every turn. `M1-T21` asserts as a
 * property that this table equals the sum of its records.
 *
 * `day_local` is a date in the **group's** timezone, so a daily budget resets when the group's day
 * does rather than at UTC midnight.
 */
export const usageDaily = sqliteTable(
  'usage_daily',
  {
    /** `groupId` or `'_instance'`. */
    groupKey: text('group_key').notNull(),
    /** `YYYY-MM-DD` in the group's timezone. */
    dayLocal: text('day_local').notNull(),
    route: text('route').notNull(),
    calls: integer('calls').notNull(),
    costMicros: integer('cost_micros').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    cachedReadTokens: integer('cached_read_tokens').notNull(),
  },
  // Q-USE-1: the budget guard's lookup.
  (t) => [primaryKey({ columns: [t.groupKey, t.dayLocal, t.route] })],
);
