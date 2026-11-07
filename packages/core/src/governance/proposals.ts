/**
 * Proposals: the amendment and contested-action workflow (`03` §3.3.6–§3.3.8).
 */
import { capped, idSchema, z } from '@comvivo/shared';
import { jsonObjectShape, storageContract } from '../domain/storage-contract.js';

/** `02` §3.3.9: the `03`-owned proposal columns are capped at 64 KiB. */
const PROPOSAL_JSON_MAX_BYTES = 64 * 1024;

/**
 * `proposals.rule` (`03` §1365): the voting rule, resolved and **frozen** when the proposal opens.
 *
 * Resolved from the constitution's `VoteRule`/`ConsensusRule`/`AmendmentRule` rather than read
 * live, because a proposal to *change the rules* must be decided under the rules in force when it
 * opened — otherwise an amendment could lower its own threshold.
 *
 * `minOpenUntil` alongside `deadline` is the anti-ambush field: a proposal cannot pass the moment
 * enough votes arrive if the group has not had its minimum window to notice it exists.
 */
export const ProposalRuleSchema = z.object({
  method: z.enum(['vote', 'consensus', 'admin_decides']),
  quorum: z.number().min(0),
  threshold: z.object({ ratio: z.number().min(0).max(1), cmp: z.enum(['gt', 'gte']) }),
  consensusMode: z.enum(['unanimous', 'no_objection']).optional(),
  deadline: z.iso.datetime({ offset: true }),
  /** Earliest possible close, even with enough votes. Stops an ambush. */
  minOpenUntil: z.iso.datetime({ offset: true }),
  tieBreak: z.enum(['status_quo', 'admin']),
  ballot: z.enum(['open', 'secret']),
  objectionEscalation: z.object({ threshold: z.number().min(0) }).optional(),
});

export type ProposalRule = z.infer<typeof ProposalRuleSchema>;

/**
 * `proposals.outcome` (`03` §1382 `TallyResult`).
 *
 * `no_quorum` and `needs_admin_tiebreak` are kept distinct from `rejected` because they ask for
 * different follow-up: one needs more voters, one needs an admin, and neither means the group said
 * no. Storing the counts alongside the verdict is what makes a close result auditable without
 * re-reading every vote.
 */
export const ProposalOutcomeSchema = capped(
  z.object({
    outcome: z.enum(['pending', 'passed', 'rejected', 'no_quorum', 'needs_admin_tiebreak']),
    yes: z.int().min(0),
    no: z.int().min(0),
    abstain: z.int().min(0),
    eligible: z.int().min(0),
    /** True when the result was certain before the deadline and the proposal closed early. */
    decidedEarly: z.boolean(),
  }),
  PROPOSAL_JSON_MAX_BYTES,
  'proposal outcome',
);

export type ProposalOutcome = z.infer<typeof ProposalOutcomeSchema>;

/**
 * `proposals.ballot_refs`: where the ballot was actually conducted.
 *
 * A proposal may be voted on through a native platform poll, a button message, or DMs, and the
 * close has to find every surface it was posted to. These are references, not results.
 */
export const BallotRefSchema = z.object({
  conversationId: idSchema('cnv'),
  pollId: idSchema('pol').optional(),
  outboxId: idSchema('obx').optional(),
});

export type BallotRef = z.infer<typeof BallotRefSchema>;

/** `constitution_versions.adopted_by`: the members who adopted it, or the system. */
export const AdoptedBySchema = z.union([z.array(idSchema('mbr')).max(1000), z.literal('system')]);

export type AdoptedBy = z.infer<typeof AdoptedBySchema>;

/**
 * `proposals.payload` — a **storage contract** (see `domain/storage-contract.ts`).
 *
 * `03` §1375 types this as `AmendmentPayload | ContestedActionPayload`, and both are `M4`'s to
 * define: an amendment payload is a constitution diff in the compiler's own terms, and a
 * contested-action payload is the action request bound by `action_digest`. `02` pins a JSON object
 * capped at 64 KiB, which is what this enforces.
 */
export const ProposalPayloadSchema = storageContract(
  'ProposalPayloadSchema',
  jsonObjectShape,
  'proposal payload',
);
