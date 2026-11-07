/**
 * Proactivity: candidates, feedback and catch-up cursors (`02` §3.3.5; `07` §3.8, §3.10).
 *
 * Speaking unprompted is the feature most able to make the product unwelcome, so `07` §3.10.3
 * replaces judgement with arithmetic and this table stores the arithmetic next to its outcome.
 * `proactive_candidates.decision` is what `proactivity_explain` renders when someone asks *why did
 * you interrupt me* — an answer that only exists because the score's terms were kept rather than
 * just its verdict.
 *
 * Three design points worth stating.
 *
 * **A candidate is proposed, not sent.** `status` carries `deferred_quiet`, `deferred_digest`,
 * `dropped` and `expired` alongside `delivered`, because most candidates should end in one of
 * those — and a system that could not record *deciding to stay quiet* would have no way to learn
 * that it was right to.
 *
 * **`payload` holds entity refs only** (`07` §3.10.1). A candidate outlives the turn that created
 * it and is re-read by the scorer, so content in it would be an unlabelled copy of group text with
 * a long lifetime. Rendering goes back through the labelled row and passes `canRead` again.
 *
 * **There is no attention-ledger table.** `02` §3.3.5 is explicit: `07` counts `outbox_messages`
 * rows with `message_class = 'proactive'` per group, recipient and day (Q-OBX-5). A second counter
 * could disagree with what was actually sent, which is the one thing the budget must not do.
 */
import {
  CandidatePayloadSchema,
  CandidateTargetSchema,
  ScoreBreakdownSchema,
  UrgencyInputsSchema,
} from '@comvivo/core';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import { createdAt, instantMs, jsonOf, labelRef, tid } from './_columns.js';
import { groups, members } from './groups.js';

export const proactiveCandidates = sqliteTable(
  'proactive_candidates',
  {
    id: tid('pcd')('id').primaryKey(),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    /** `07` §3.10.2's enum: `answerable_question`, `conflict_detected`, … */
    type: text('type').notNull(),
    /** `conflict:<evtA>:<evtB>`, `overdue:<taskId>`, … The cooldown key. */
    topicKey: text('topic_key').notNull(),
    target: jsonOf(CandidateTargetSchema, 'proactive_candidates.target')('target').notNull(),
    value: real('value').notNull(),
    confidence: real('confidence').notNull(),
    /** The inputs to the urgency formula, so a bundled candidate can be re-scored. */
    urgencyInputs: jsonOf(
      UrgencyInputsSchema,
      'proactive_candidates.urgency_inputs',
    )('urgency_inputs').notNull(),
    /** Entity refs only (`07` §3.10.1). */
    payload: jsonOf(CandidatePayloadSchema, 'proactive_candidates.payload')('payload').notNull(),
    /** The join of the source labels, so the IFC gate has something to check. */
    labelId: labelRef().notNull(),
    status: text('status', {
      enum: ['pending', 'delivered', 'deferred_quiet', 'deferred_digest', 'dropped', 'expired'],
    }).notNull(),
    /** The score term by term, plus the first failing gate. Feeds traces and the explainer. */
    decision: jsonOf(ScoreBreakdownSchema, 'proactive_candidates.decision')('decision'),
    deliverAfter: instantMs('deliver_after'),
    deliveredOutboxId: tid('obx')('delivered_outbox_id'),
    createdAt: createdAt(),
    /** Mandatory: an unanswered candidate must stop being a candidate. */
    expiresAt: instantMs('expires_at').notNull(),
  },
  (t) => [
    index('proactive_candidates_pending_idx').on(t.groupId, t.status, t.deliverAfter),
    index('proactive_candidates_topic_idx').on(t.groupId, t.topicKey),
    check('proactive_candidates_value_ck', sql`${t.value} BETWEEN 0 AND 1`),
    check('proactive_candidates_confidence_ck', sql`${t.confidence} BETWEEN 0 AND 1`),
  ],
);

/**
 * What the group's reaction to an interjection taught us (`07` §3.10.6).
 *
 * **Weights are recomputed from these rows, never stored.** `07` §3.10.6 is explicit, and the
 * reason is that a learned weight with no derivation is impossible to explain or undo: a group
 * that mutes a type and then unmutes it should get its prior back, and a stored weight would have
 * been overwritten. `signal` therefore includes the `mute`/`unmute`/`reset` markers themselves.
 *
 * `member_id` carries no foreign key: a signal is evidence about how interjections land, and it
 * must survive the member leaving — otherwise a group's learned behaviour would reset whenever
 * somebody departs.
 */
export const proactivityFeedback = sqliteTable(
  'proactivity_feedback',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    /** No foreign key: the signal outlives the membership it came from. */
    memberId: tid('mbr')('member_id'),
    scope: text('scope', { enum: ['group', 'member'] }).notNull(),
    /** Includes the `mute` / `unmute` / `reset` markers and the pause command. */
    signal: text('signal').notNull(),
    weight: real('weight').notNull(),
    outboxId: tid('obx')('outbox_id'),
    at: instantMs('at').notNull(),
  },
  (t) => [index('proactivity_feedback_group_idx').on(t.groupId, t.type, t.at)],
);

/**
 * Where each member has read up to (`07` §3.8.1).
 *
 * Four separate markers rather than one, because "what did I miss" has four different answers
 * depending on what evidence exists. An explicit marker is the member saying so; a read receipt is
 * the platform saying so and is not available everywhere; their own last message is a reliable
 * lower bound when neither exists. Collapsing them would mean guessing, and a catch-up that
 * repeats what someone already read is the fastest way to make the feature annoying.
 *
 * `conversation_id` is plain text because `'all'` is a legal value — a member's catch-up position
 * across the whole group — which a typed id column could not hold. `06`'s `read_marker` events
 * update `read_receipt_rid`; there is no separate `read_markers` table.
 */
export const catchupCursors = sqliteTable(
  'catchup_cursors',
  {
    memberId: tid('mbr')('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    /** `cnv_…` or the literal `'all'`, which is why this is not a typed id column. */
    conversationId: text('conversation_id').notNull(),
    explicitMarkerRid: integer('explicit_marker_rid'),
    readReceiptRid: integer('read_receipt_rid'),
    lastOwnMessageAt: instantMs('last_own_message_at'),
    lastInteractionAt: instantMs('last_interaction_at'),
    lastCatchupAt: instantMs('last_catchup_at'),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.conversationId] })],
);
