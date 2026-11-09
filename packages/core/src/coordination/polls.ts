/**
 * Poll JSON columns (`02` §3.3.5; `07` §3.5, `06` §4.1).
 */
import type {
  ConversationId,
  DecisionId,
  GroupId,
  LabelId,
  MemberId,
  PlanStepId,
  PollId,
  ProposalId,
} from '@comvivo/shared';
import { z } from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';

/**
 * `polls.options` (`07` §1045): two to ten options, each with a stable id.
 *
 * The id is what makes a vote survive an edit. `06` §4.1 sends the adapter a bare `string[]` and
 * gets back an **index**, so `position` is how a platform index maps home — and if options were
 * stored as plain strings, reordering them would silently reassign every vote already cast.
 *
 * Ten is not arbitrary: `07` §1058 records Discord's limit of 10 answers, and a poll that cannot
 * be rendered natively falls back to buttons.
 */
export const PollOptionsSchema = z
  .array(
    z.object({
      id: z.string().min(1).max(40),
      text: z.string().min(1).max(300),
      position: z.int().min(0).max(9),
    }),
  )
  .min(2)
  .max(10);

export type PollOptions = z.infer<typeof PollOptionsSchema>;

/** `polls.quorum` (`07` §1109). */
export const PollQuorumSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('count'), n: z.int().min(1) }),
  z.object({ kind: z.literal('fraction'), f: z.number().gt(0).max(1) }),
]);

export type PollQuorum = z.infer<typeof PollQuorumSchema>;

/**
 * `polls.outcome` (`07` §1045): how a poll ended.
 *
 * Five arms, and four of them are *not* a result. `no_quorum`, `tie`, `blocked` and `no_rule` each
 * need a different thing from the group — `07` §1093 offers [Extend 24h] and [Runoff] for the
 * first two — so collapsing them into "no decision" would leave the product unable to say what to
 * do next. `tie` carries the tied options for exactly that reason.
 */
export const PollOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('decided'), optionIds: z.array(z.string().max(40)).min(1).max(10) }),
  z.object({ kind: z.literal('no_quorum') }),
  z.object({ kind: z.literal('tie'), optionIds: z.array(z.string().max(40)).min(2).max(10) }),
  /** A consensus poll someone blocked. */
  z.object({ kind: z.literal('blocked') }),
  /** `rule = 'none'`: an opinion poll, which records counts and decides nothing. */
  z.object({ kind: z.literal('no_rule') }),
]);

export type PollOutcome = z.infer<typeof PollOutcomeSchema>;

/**
 * `polls.platform_poll_ref` (`06` §4.1): the native poll this mirrors, when there is one.
 *
 * Opaque per platform for the same reason as `AttachmentRefSchema`: the adapter that created the
 * poll is the one that can close it, and `core` has no business knowing whether Discord wants a
 * message id or Telegram a poll id.
 */
export const PlatformPollRefSchema = z.object({
  channel: z.string().min(1).max(32),
  data: z.record(z.string(), z.unknown()),
});

export type PlatformPollRef = z.infer<typeof PlatformPollRefSchema>;

/* ──────────────────────────── The poll aggregate (`02` §3.3.5) ──────────────────────────── */

/** `02` §3.3.5's `polls.purpose`: what the answer is for (`07`, `03`). */
export const POLL_PURPOSES = ['opinion', 'decision', 'proposal'] as const;
export type PollPurpose = (typeof POLL_PURPOSES)[number];

/** `02` §3.3.5's `polls.mode`: how `06` renders it on the channel. */
export const POLL_MODES = ['native', 'buttons', 'numbered', 'dm_ballot'] as const;
export type PollMode = (typeof POLL_MODES)[number];

export const POLL_STATUSES = ['open', 'closed', 'cancelled'] as const;
export type PollStatus = (typeof POLL_STATUSES)[number];

/** `02` §3.3.5's `polls.results_visibility`. `after_close` is what makes a secret ballot secret. */
export const RESULTS_VISIBILITIES = ['live', 'after_close'] as const;
export type ResultsVisibility = (typeof RESULTS_VISIBILITIES)[number];

/** A poll (`02` §3.3.5; semantics in `07`, decision rules in `03`). */
export interface Poll {
  readonly rid: number;
  readonly id: PollId;
  readonly groupId: GroupId;
  readonly conversationId: ConversationId;
  readonly purpose: PollPurpose;
  readonly proposalId: ProposalId | undefined;
  readonly question: string;
  readonly options: PollOptions;
  readonly allowMultiple: boolean;
  readonly rule: string;
  readonly quorum: PollQuorum;
  /** Who may vote. Empty means every active member (`07`). */
  readonly eligibleMemberIds: readonly MemberId[];
  readonly anonymous: boolean;
  readonly resultsVisibility: ResultsVisibility;
  readonly mode: PollMode;
  readonly deadlineAt: Temporal.Instant | undefined;
  readonly status: PollStatus;
  readonly outcome: PollOutcome | undefined;
  readonly platformPollRef: PlatformPollRef | undefined;
  readonly decisionId: DecisionId | undefined;
  readonly planStepId: PlanStepId | undefined;
  readonly labelId: LabelId;
  readonly createdByMemberId: MemberId | undefined;
  readonly createdAt: Temporal.Instant;
  readonly closedAt: Temporal.Instant | undefined;
  readonly version: number;
}

export interface NewPoll {
  readonly id: PollId;
  readonly groupId: GroupId;
  readonly conversationId: ConversationId;
  readonly purpose: PollPurpose;
  readonly proposalId?: ProposalId | undefined;
  readonly question: string;
  readonly options: PollOptions;
  readonly allowMultiple?: boolean | undefined;
  readonly rule: string;
  readonly quorum: PollQuorum;
  readonly eligibleMemberIds?: readonly MemberId[] | undefined;
  readonly anonymous?: boolean | undefined;
  readonly resultsVisibility?: ResultsVisibility | undefined;
  readonly mode: PollMode;
  readonly deadlineAt?: Temporal.Instant | undefined;
  readonly planStepId?: PlanStepId | undefined;
  readonly createdByMemberId?: MemberId | undefined;
}

/**
 * Whether a poll's results may be shown to the group yet.
 *
 * `02` §3.3.5 gives `results_visibility` two values and this is the one place the rule lives: a
 * `live` poll shows as it goes, and an `after_close` one shows nothing until it closes. Getting it
 * wrong in the permissive direction turns a secret ballot into an open one *while people are still
 * voting*, which is the case that changes the outcome rather than merely leaking it.
 */
export function resultsVisibleNow(poll: Pick<Poll, 'resultsVisibility' | 'status'>): boolean {
  return poll.resultsVisibility === 'live' || poll.status !== 'open';
}
