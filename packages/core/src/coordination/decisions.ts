/**
 * Decision JSON columns (`02` §3.3.5; `07` §3.6, `03` §3.9).
 */
import type {
  DecisionId,
  GroupId,
  LabelId,
  MemoryId,
  ProposalId,
  TimeZoneId,
} from '@comvivo/shared';
import { idSchema, z } from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';

/**
 * `decisions.decided_by` (`02` §3.3.9): the rule that settled it, and who took part.
 *
 * `rule` is `03`'s `ConflictStrategy` plus `informal`, and the extra value is the point: most group
 * decisions are not votes. "We agreed in chat" is `informal`, and recording it as `consensus`
 * would claim a process that did not happen — which matters because `03`'s amendment workflow
 * treats a recorded strategy as precedent.
 */
export const DecidedBySchema = z.object({
  rule: z.enum([
    'last_writer_with_notice',
    'ask_owner',
    'vote',
    'role_precedence',
    'consensus',
    'informal',
  ]),
  memberIds: z.array(idSchema('mbr')).max(64),
  /** Set when the decision came from a poll close (`07` §3.5.3). */
  pollId: idSchema('pol').optional(),
});

export type DecidedBy = z.infer<typeof DecidedBySchema>;

/** `decisions.alternatives_rejected`: what was considered and why it lost. */
export const DecisionAlternativesSchema = z
  .array(
    z.object({
      option: z.string().min(1).max(120),
      reason: z.string().max(200).nullable(),
    }),
  )
  .max(8);

export type DecisionAlternatives = z.infer<typeof DecisionAlternativesSchema>;

/**
 * `decisions.source_refs` (`07` §1334): the messages a decision was read from.
 *
 * `excerptHash` rather than the excerpt. `07` §1334 is explicit that excerpts are **re-read from
 * the message at render time**, so an expired message shows "source expired" instead of the
 * product keeping a private copy of text the platform was asked to forget. The hash is what
 * confirms the message still says what the citation claims.
 */
export const DecisionSourceRefsSchema = z
  .array(
    z.object({
      messageId: idSchema('msg'),
      /** The platform's own reference, for a permalink. */
      platformMessageRef: z.string().max(200).nullable(),
      authorMemberId: idSchema('mbr').nullable(),
      sentAt: z.iso.datetime({ offset: true }),
      /** Confirms the re-read excerpt is the one cited; never the excerpt itself. */
      excerptHash: z.string().max(64),
    }),
  )
  .max(20);

export type DecisionSourceRefs = z.infer<typeof DecisionSourceRefsSchema>;

/* ────────────────────────── The decision aggregate (`02` §3.3.5) ────────────────────────── */

/** `02` §3.3.5's `decisions.origin`: how the group arrived at it. */
export const DECISION_ORIGINS = ['explicit', 'poll', 'proposal', 'extracted'] as const;
export type DecisionOrigin = (typeof DECISION_ORIGINS)[number];

export const DECISION_STATUSES = ['active', 'superseded', 'retracted'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/**
 * A recorded decision (`02` §3.3.5; semantics in `07`, governance in `03`).
 *
 * Like a memory item, a decision is **superseded rather than edited** — the chain is the record of
 * what the group decided and when, and rewriting a decision would erase the fact that it changed.
 * `decidedAt` and `decidedTz` are stored together because "we decided on Tuesday" is a claim about
 * a day in a place, and `07`'s decision log renders it in the zone it was made in.
 */
export interface Decision {
  readonly rid: number;
  readonly id: DecisionId;
  readonly groupId: GroupId;
  readonly summary: string;
  readonly rationale: string | undefined;
  readonly topicTags: readonly string[];
  readonly decidedBy: DecidedBy;
  readonly alternativesRejected: DecisionAlternatives;
  readonly sourceRefs: DecisionSourceRefs;
  readonly origin: DecisionOrigin;
  readonly status: DecisionStatus;
  readonly supersedesId: DecisionId | undefined;
  readonly supersededById: DecisionId | undefined;
  readonly labelId: LabelId;
  /** The memory item this decision is mirrored as, if `04` made one (`decisions_memory_uq`). */
  readonly memoryItemId: MemoryId | undefined;
  readonly proposalId: ProposalId | undefined;
  readonly decidedAt: Temporal.Instant;
  readonly decidedTz: TimeZoneId;
  readonly createdAt: Temporal.Instant;
  readonly version: number;
}

export interface NewDecision {
  readonly id: DecisionId;
  readonly groupId: GroupId;
  readonly summary: string;
  readonly rationale?: string | undefined;
  readonly topicTags?: readonly string[] | undefined;
  readonly decidedBy: DecidedBy;
  readonly alternativesRejected?: DecisionAlternatives | undefined;
  readonly sourceRefs?: DecisionSourceRefs | undefined;
  readonly origin: DecisionOrigin;
  readonly supersedesId?: DecisionId | undefined;
  readonly memoryItemId?: MemoryId | undefined;
  readonly proposalId?: ProposalId | undefined;
  readonly decidedAt: Temporal.Instant;
  readonly decidedTz: TimeZoneId;
}
