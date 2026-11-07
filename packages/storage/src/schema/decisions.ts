/**
 * The decision log (`02` §3.3.5; `07` §3.6).
 *
 * `00` §6.1 promises decisions *with rationale*, and this table is that promise. Two choices make
 * it work.
 *
 * **Supersession, not editing.** A decision that is revisited gets a new row with `supersedes_id`
 * pointing back, exactly like `memory_items`. "Why did we settle on this?" and "what did we
 * decide before?" are both answerable, and neither is answerable if a decision is a mutable row.
 *
 * **`decisions_memory_uq` is a partial unique index on `memory_item_id`.** `04` §3.4.6 promotes an
 * extracted decision memory into a real decision once its confidence clears 0.85, and that
 * promotion runs from a job that can be retried. Unique-on-not-null means the second run finds the
 * existing row instead of creating a twin — the idempotency of the mirror is a database
 * constraint rather than a check the job has to remember.
 */
import {
  DecidedBySchema,
  DecisionAlternativesSchema,
  DecisionSourceRefsSchema,
} from '@comvivo/core';
import { z } from '@comvivo/shared';
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { createdAt, instantMs, jsonOf, labelRef, tid, tzText, version } from './_columns.js';
import { proposals } from './governance.js';
import { groups } from './groups.js';
import { memoryItems } from './memory.js';

export const decisions = sqliteTable(
  'decisions',
  {
    rid: integer('rid').primaryKey({ autoIncrement: true }),
    id: tid('dec')('id').notNull().unique(),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    summary: text('summary').notNull(),
    rationale: text('rationale'),
    topicTags: jsonOf(
      z.array(z.string().max(40)).max(10),
      'decisions.topic_tags',
    )('topic_tags').notNull(),
    decidedBy: jsonOf(DecidedBySchema, 'decisions.decided_by')('decided_by').notNull(),
    alternativesRejected: jsonOf(
      DecisionAlternativesSchema,
      'decisions.alternatives_rejected',
    )('alternatives_rejected').notNull(),
    /** Citations by reference; excerpts are re-read at render time (`07` §1334). */
    sourceRefs: jsonOf(DecisionSourceRefsSchema, 'decisions.source_refs')('source_refs').notNull(),
    origin: text('origin', { enum: ['explicit', 'poll', 'proposal', 'extracted'] }).notNull(),
    status: text('status', { enum: ['active', 'superseded', 'retracted'] })
      .notNull()
      .default('active'),
    supersedesId: tid('dec')('supersedes_id'),
    supersededById: tid('dec')('superseded_by_id'),
    labelId: labelRef().notNull(),
    /** The `04` mirror. Unique where set, so the promotion job is idempotent. */
    memoryItemId: tid('mem')('memory_item_id').references(() => memoryItems.id, {
      onDelete: 'set null',
    }),
    /** `set null` rather than cascade: a decision outlives the proposal that produced it. */
    proposalId: tid('prp')('proposal_id').references(() => proposals.id, {
      onDelete: 'set null',
    }),
    decidedAt: instantMs('decided_at').notNull(),
    /** The zone it was decided in, so "last Tuesday" renders the way the group experienced it. */
    decidedTz: tzText('decided_tz').notNull(),
    createdAt: createdAt(),
    version: version(),
  },
  (t) => [
    // Q-COO-5: the group's decision log, newest first.
    index('decisions_group_decided_idx').on(t.groupId, t.decidedAt),
    // Idempotent `04` §3.4.6 mirror.
    uniqueIndex('decisions_memory_uq').on(t.memoryItemId).where(sql`${t.memoryItemId} IS NOT NULL`),
  ],
);
