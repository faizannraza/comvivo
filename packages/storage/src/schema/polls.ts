/**
 * Polls and votes (`02` §3.3.5; `07` §3.5, `06` §4.1).
 *
 * ## Why `eligible_member_ids` is a snapshot
 *
 * The electorate is frozen into the row when the poll opens. Computing it live from membership
 * would mean a member joining mid-poll changes the quorum denominator, so a poll that had passed
 * can un-pass itself — and someone leaving could tip a result after the fact. A vote is a record
 * of a moment, and the rules of that moment have to be stored with it.
 *
 * ## Why anonymous polls use a different table
 *
 * `poll_votes` has a `member_id` in its primary key, so it cannot hold an anonymous vote without
 * recording who cast it. `poll_counts` exists for that case: counts only, no voters. The
 * alternative — a nullable `member_id` — would make anonymity a *convention* that any query
 * forgetting a `WHERE` could break, and `07` §1058 notes that on Discord voters are visible to
 * members anyway, so the product must be able to promise the stronger thing where it can.
 *
 * An anonymous poll's `poll_votes` rows, where they exist for non-native modes, carry a label whose
 * readers are `{voter}` — the voter can see their own vote and nobody else can.
 */
import {
  PlatformPollRefSchema,
  PollOptionsSchema,
  PollOutcomeSchema,
  PollQuorumSchema,
} from '@comvivo/core';
import { idSchema, z } from '@comvivo/shared';
import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import {
  bool,
  boolCheckSql,
  createdAt,
  instantMs,
  jsonOf,
  labelRef,
  tid,
  version,
} from './_columns.js';
import { conversations, groups, members } from './groups.js';

export const polls = sqliteTable(
  'polls',
  {
    rid: integer('rid').primaryKey({ autoIncrement: true }),
    id: tid('pol')('id').notNull().unique(),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    conversationId: tid('cnv')('conversation_id')
      .notNull()
      .references(() => conversations.id),
    /** `proposal` makes this a governance ballot, bound to `03`'s proposal. */
    purpose: text('purpose', { enum: ['opinion', 'decision', 'proposal'] }).notNull(),
    proposalId: tid('prp')('proposal_id'),
    question: text('question').notNull(),
    options: jsonOf(PollOptionsSchema, 'polls.options')('options').notNull(),
    allowMultiple: bool('allow_multiple').notNull().default(false),
    rule: text('rule', {
      enum: ['plurality', 'majority', 'supermajority_2_3', 'approval', 'consensus', 'none'],
    }).notNull(),
    quorum: jsonOf(PollQuorumSchema, 'polls.quorum')('quorum').notNull(),
    /** Frozen when the poll opens, so the denominator cannot move under the result. */
    eligibleMemberIds: jsonOf(
      z.array(idSchema('mbr')).max(1000),
      'polls.eligible_member_ids',
    )('eligible_member_ids').notNull(),
    anonymous: bool('anonymous').notNull().default(false),
    resultsVisibility: text('results_visibility', { enum: ['live', 'after_close'] })
      .notNull()
      .default('live'),
    /** `native` when the platform can express the poll; otherwise buttons, numbers or a DM ballot. */
    mode: text('mode', { enum: ['native', 'buttons', 'numbered', 'dm_ballot'] }).notNull(),
    deadlineAt: instantMs('deadline_at'),
    status: text('status', { enum: ['open', 'closed', 'cancelled'] })
      .notNull()
      .default('open'),
    outcome: jsonOf(PollOutcomeSchema, 'polls.outcome')('outcome'),
    platformPollRef: jsonOf(PlatformPollRefSchema, 'polls.platform_poll_ref')('platform_poll_ref'),
    decisionId: tid('dec')('decision_id'),
    planStepId: tid('plns')('plan_step_id'),
    labelId: labelRef().notNull(),
    createdByMemberId: tid('mbr')('created_by_member_id').references(() => members.id),
    createdAt: createdAt(),
    closedAt: instantMs('closed_at'),
    version: version(),
  },
  (t) => [
    // Q-COO-4: polls to close. Partial, so closed polls leave the index.
    index('polls_open_deadline_idx').on(t.groupId, t.deadlineAt).where(sql`${t.status} = 'open'`),
    check('polls_allow_multiple_bool_ck', boolCheckSql(t.allowMultiple)),
    check('polls_anonymous_bool_ck', boolCheckSql(t.anonymous)),
  ],
);

export const pollVotes = sqliteTable(
  'poll_votes',
  {
    pollId: tid('pol')('poll_id')
      .notNull()
      .references(() => polls.id, { onDelete: 'cascade' }),
    /** In the key, so one member has one vote. Anonymous native polls use `poll_counts` instead. */
    memberId: tid('mbr')('member_id')
      .notNull()
      .references(() => members.id),
    optionIds: jsonOf(
      z.array(z.string().max(40)).min(1).max(10),
      'poll_votes.option_ids',
    )('option_ids').notNull(),
    source: text('source', {
      enum: ['native', 'button', 'text', 'ballot', 'dashboard'],
    }).notNull(),
    /** For an anonymous poll, readers are `{voter}`. */
    labelId: labelRef().notNull(),
    castAt: instantMs('cast_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.pollId, t.memberId] }),
    // Q-PRV: a member's votes, which erasure deletes while the aggregate stays in `polls.outcome`.
    index('poll_votes_member_idx').on(t.memberId),
  ],
);

/**
 * Counts for an anonymous native poll (`07`).
 *
 * No `member_id` anywhere, by construction. `observed_at` records when the platform was last
 * asked, because these counts are *polled* from the platform rather than accumulated here — so a
 * stale read has to be distinguishable from a poll nobody voted in.
 */
export const pollCounts = sqliteTable('poll_counts', {
  pollId: tid('pol')('poll_id')
    .primaryKey()
    .references(() => polls.id, { onDelete: 'cascade' }),
  counts: jsonOf(
    z.record(z.string().max(40), z.int().min(0)),
    'poll_counts.counts',
  )('counts').notNull(),
  voterCount: integer('voter_count').notNull(),
  /** When the platform was last asked, so a stale read is not read as "no votes". */
  observedAt: instantMs('observed_at').notNull(),
});
