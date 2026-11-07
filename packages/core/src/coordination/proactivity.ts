/**
 * Proactivity JSON columns (`02` §3.3.5; `07` §3.10).
 *
 * Proactivity is the feature most able to make the product unpleasant, so `07` §3.10.3 makes the
 * decision to speak an explicit arithmetic rather than a heuristic, and `02` stores the arithmetic
 * alongside its outcome. `proactive_candidates.decision` is what `proactivity_explain` renders
 * when a user asks *why did you interrupt me* — which is only answerable if the numbers were kept.
 */
import { idSchema, z } from '@comvivo/shared';
import { EntityRefSchema } from '../domain/entity-ref.js';

/**
 * `proactive_candidates.target` (`07` §1581): where the interjection would go.
 *
 * The two arms carry different interruption costs — `07` §3.10.3 prices a group message at
 * `a_aud = 0.20` and a DM at `0.10` — and `03`'s IFC gate may retarget a group candidate to a DM
 * rather than drop it. So the target is part of the candidate, not of its delivery.
 */
export const CandidateTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('conversation'), conversationId: idSchema('cnv') }),
  z.object({ kind: z.literal('member_dm'), memberId: idSchema('mbr') }),
]);

export type CandidateTarget = z.infer<typeof CandidateTargetSchema>;

/**
 * `proactive_candidates.urgency_inputs`: the inputs to `07` §3.10.2's urgency formula.
 *
 * Two fields because the table's formulas take one or the other, never both: an
 * `answerable_question` decays by **age** (`2^(−age/5 min)`), while a conflict or an overdue task
 * decays by **τ**, the time until the thing happens (`1/(1+τ/72h)`). Storing the inputs rather
 * than the computed `U` is what lets a candidate be re-scored when it is reconsidered five
 * minutes later during bundling, without re-deriving where it came from.
 */
export const UrgencyInputsSchema = z.object({
  /** Seconds since the triggering message. Used by the age-decay types. */
  ageSeconds: z.number().min(0).nullable(),
  /** Seconds until the event starts or the task is due. Used by the τ-decay types. */
  tauSeconds: z.number().nullable(),
});

export type UrgencyInputs = z.infer<typeof UrgencyInputsSchema>;

/**
 * `proactive_candidates.payload` (`07` §3.10.1).
 *
 * **`07` §3.10.1 says "typed per type; entity refs only", and the second half is the part this
 * schema enforces.** The per-type shapes are `M8`'s to define; what must hold from the first
 * migration is that no candidate carries *content*. A proactivity row is evaluated outside the
 * turn that created it, read by the scorer and by `proactivity_explain`, and kept until it
 * expires — so a payload holding the text of the question it wants to answer would be an
 * unlabelled copy of group content with a long lifetime, which is the shape of an IFC leak.
 *
 * References only, so rendering has to go back through the labelled row and pass `canRead`.
 */
export const CandidatePayloadSchema = z.object({
  refs: z.array(EntityRefSchema).max(20),
});

export type CandidatePayload = z.infer<typeof CandidatePayloadSchema>;

/**
 * `proactive_candidates.decision` (`07` §3.10.3, §3.10.4): the score, term by term, plus the gate.
 *
 * Every field is a named parameter of `S = w_type · V · U · C − a_aud · (1 + β·n24) · (1 + γ·r7)`.
 * Keeping the terms rather than only `s` is what makes the decision explainable *and* auditable: a
 * user asking why they were interrupted gets the actual reason, and a maintainer tuning `θ_now`
 * can see which term dominated.
 *
 * `gate` records the first failing gate of `07` §3.10.4, because gates are ordered and the first
 * failure decides the outcome — so "which gate" is the complete answer, and later gates were never
 * evaluated.
 */
export const ScoreBreakdownSchema = z.object({
  /** Learned per (group, type), or per (group, type, member) for DM targets. */
  wType: z.number().min(0).max(5),
  /** Value. */
  v: z.number().min(0).max(1),
  /** Urgency, derived from `UrgencyInputs`. */
  u: z.number().min(0).max(1),
  /** Confidence. */
  c: z.number().min(0).max(1),
  sRaw: z.number(),
  /** Base interruption cost: 0.20 for a group target, 0.10 for a DM. */
  aAud: z.number().min(0).max(1),
  /** Proactive messages already delivered to this target in the last 24 h. */
  n24: z.int().min(0),
  /** 1 if the same `topicKey` was delivered in the last 7 days. */
  r7: z.int().min(0).max(1),
  a: z.number(),
  s: z.number(),
  /** The thresholds in force when this was scored, so an old decision stays readable. */
  thetaNow: z.number().min(0).max(1),
  thetaDigest: z.number().min(0).max(1),
  /** The first gate that failed (`07` §3.10.4), or `null` when every gate passed. */
  gate: z
    .object({
      name: z.enum(['consent', 'constitution', 'ifc', 'mutes', 'cooldown', 'caps', 'budget']),
      reason: z.string().max(80),
    })
    .nullable(),
});

export type ScoreBreakdown = z.infer<typeof ScoreBreakdownSchema>;
